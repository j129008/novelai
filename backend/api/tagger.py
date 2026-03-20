"""WD Tagger v3 — image tag inference using ONNX Runtime.

Model: SmilingWolf/wd-vit-tagger-v3 (HuggingFace)
Files used: model.onnx, selected_tags.csv

The model expects 448x448 BGR float32 images normalised to [0, 1].
selected_tags.csv columns: tag_id, name, category
  category 0 = general  (further classified by keyword heuristics below)
  category 4 = character
  category 9 = rating    (skipped in output)
"""

import base64
import io
import threading
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MODEL_REPO = "SmilingWolf/wd-vit-tagger-v3"
MODEL_FILE = "model.onnx"
TAGS_FILE = "selected_tags.csv"
INPUT_SIZE = 448
SCORE_THRESHOLD = 0.35

# WD Tagger category IDs
_WD_GENERAL = 0
_WD_CHARACTER = 4
_WD_RATING = 9

# Keywords for semantic sub-classification of WD general tags
_LIGHTING_KEYWORDS = frozenset([
    "light", "lighting", "shadow", "shadows", "glow", "glowing",
    "sun", "sunlight", "sunbeam", "moon", "moonlight", "backlight",
    "rim", "ambient", "lamp", "lantern", "neon", "spotlight",
    "volumetric", "god_ray", "dappled", "dawn", "dusk", "flare",
    "luminous", "shining", "radiant", "dark", "bright",
])

_STYLE_KEYWORDS = frozenset([
    "style", "painting", "sketch", "watercolor", "oil", "acrylic",
    "anime", "manga", "realistic", "photorealistic", "illustration",
    "digital", "traditional", "cel", "lineart", "monochrome",
    "greyscale", "grayscale", "artistic", "pastel", "vibrant",
    "cinematic", "film", "render", "3d", "pixel", "chibi",
])

_SCENE_KEYWORDS = frozenset([
    "indoor", "indoors", "outdoor", "outdoors", "sky", "cloud", "clouds",
    "city", "street", "forest", "tree", "trees", "grass", "mountain",
    "ocean", "sea", "beach", "river", "lake", "rain", "snow", "fog",
    "room", "bedroom", "classroom", "kitchen", "library", "park",
    "garden", "field", "desert", "castle", "building", "architecture",
    "background", "scenery", "landscape", "horizon",
])


def _classify_general_tag(name: str) -> str:
    """Map a WD-general tag name to one of our semantic categories."""
    parts = set(name.lower().replace("-", "_").split("_"))
    if parts & _LIGHTING_KEYWORDS:
        return "lighting"
    if parts & _STYLE_KEYWORDS:
        return "style"
    if parts & _SCENE_KEYWORDS:
        return "scene"
    return "subject"


# ---------------------------------------------------------------------------
# Download state — shared across requests
# ---------------------------------------------------------------------------

_download_lock = threading.Lock()

# None = not started, "downloading", "ready", "failed"
_model_status: str = "not_started"
_download_progress: int = 0
_onnx_session = None  # onnxruntime.InferenceSession
_tag_names: list[str] = []
_tag_categories: list[int] = []  # parallel list of WD category IDs


def get_model_status() -> tuple[str, int]:
    """Return (status, progress_pct). Thread-safe read."""
    return _model_status, _download_progress


def _load_model_sync() -> None:
    """Download (if needed) and load the ONNX model. Runs in a background thread."""
    global _model_status, _download_progress, _onnx_session, _tag_names, _tag_categories

    try:
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download

        _model_status = "downloading"
        _download_progress = 10

        model_path = hf_hub_download(repo_id=MODEL_REPO, filename=MODEL_FILE)
        _download_progress = 60

        tags_path = hf_hub_download(repo_id=MODEL_REPO, filename=TAGS_FILE)
        _download_progress = 75

        # Parse selected_tags.csv: tag_id, name, category
        names: list[str] = []
        categories: list[int] = []
        import csv
        with open(tags_path, newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            next(reader, None)  # skip header
            for row in reader:
                if len(row) >= 3:
                    names.append(row[1])
                    try:
                        categories.append(int(row[2]))
                    except ValueError:
                        categories.append(_WD_GENERAL)

        _download_progress = 85

        sess_options = ort.SessionOptions()
        sess_options.intra_op_num_threads = 4
        session = ort.InferenceSession(
            model_path,
            sess_options=sess_options,
            providers=["CPUExecutionProvider"],
        )

        _download_progress = 100
        _onnx_session = session
        _tag_names = names
        _tag_categories = categories
        _model_status = "ready"

    except Exception as exc:
        _model_status = "failed"
        _download_progress = 0
        # Re-raise so the caller thread can log it
        raise RuntimeError(f"Tagger model load failed: {exc}") from exc


def ensure_model_loaded() -> str:
    """Trigger background download if not yet started. Returns current status."""
    global _model_status

    with _download_lock:
        if _model_status == "not_started":
            _model_status = "downloading"
            t = threading.Thread(target=_load_model_sync, daemon=True)
            t.start()

    return _model_status


# ---------------------------------------------------------------------------
# Preprocessing
# ---------------------------------------------------------------------------

def _preprocess(image_bytes: bytes) -> np.ndarray:
    """Decode base64 PNG/JPG bytes, resize to 448x448, return NCHW float32 BGR."""
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    img = img.resize((INPUT_SIZE, INPUT_SIZE), Image.BICUBIC)
    arr = np.array(img, dtype=np.float32) / 255.0  # H W C, RGB, [0, 1]
    # Convert RGB → BGR (model was trained with OpenCV convention)
    arr = arr[:, :, ::-1]
    # Add batch dimension: 1 H W C
    return arr[np.newaxis, :]


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------

def run_inference(image_b64: str) -> list[dict]:
    """Run WD Tagger on a base64-encoded image.

    Returns a list of dicts: {name, score, category}.
    Raises RuntimeError if the model is not ready.
    """
    if _onnx_session is None:
        raise RuntimeError("Model not ready")

    try:
        image_bytes = base64.b64decode(image_b64)
        input_arr = _preprocess(image_bytes)
    except Exception as exc:
        raise RuntimeError(f"Image preprocessing failed: {exc}") from exc

    input_name = _onnx_session.get_inputs()[0].name
    outputs = _onnx_session.run(None, {input_name: input_arr})
    scores: np.ndarray = outputs[0][0]  # shape: (num_tags,)

    results: list[dict] = []
    for idx, (score, wd_cat) in enumerate(zip(scores, _tag_categories)):
        if idx >= len(_tag_names):
            break
        if wd_cat == _WD_RATING:
            continue
        if float(score) < SCORE_THRESHOLD:
            continue

        name = _tag_names[idx]
        if wd_cat == _WD_CHARACTER:
            category = "character"
        else:
            category = _classify_general_tag(name)

        results.append({
            "name": name,
            "score": round(float(score), 4),
            "category": category,
        })

    results.sort(key=lambda x: x["score"], reverse=True)
    return results
