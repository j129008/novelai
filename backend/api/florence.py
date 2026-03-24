"""
Florence-2 Base — local image captioning.

Lazy-loads microsoft/Florence-2-base on first use (~500MB download).
Provides short captions and detailed descriptions for reference images.
"""
import io
import logging
import threading

from PIL import Image

log = logging.getLogger("florence")

_model = None
_processor = None
_lock = threading.Lock()
_status = "not_started"  # not_started | downloading | ready | failed
_progress = 0


def get_model_status():
    return _status, _progress


def ensure_model_loaded():
    global _model, _processor, _status, _progress
    if _status == "ready":
        return "ready"
    if _status == "downloading":
        return "downloading"
    if _status == "failed":
        return "failed"

    def _load():
        global _model, _processor, _status, _progress
        try:
            _status = "downloading"
            _progress = 0
            log.info("Loading Florence-2-base model...")

            from transformers import AutoModelForCausalLM, AutoProcessor
            import torch

            model_id = "microsoft/Florence-2-base"
            _progress = 30
            _processor = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
            _progress = 60
            _model = AutoModelForCausalLM.from_pretrained(
                model_id, trust_remote_code=True, torch_dtype=torch.float32
            )
            _model.eval()
            _progress = 100
            _status = "ready"
            log.info("Florence-2-base model loaded successfully")
        except Exception as exc:
            _status = "failed"
            log.error(f"Failed to load Florence-2: {exc}")

    with _lock:
        if _status in ("not_started", "failed"):
            _status = "downloading"
            thread = threading.Thread(target=_load, daemon=True)
            thread.start()
    return _status


def run_inference(image_bytes: bytes) -> dict:
    """Run Florence-2 on image bytes. Returns {"caption": "...", "detail": "..."}."""
    global _model, _processor
    if _model is None or _processor is None:
        raise RuntimeError("Model not ready")

    import torch

    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

    results = {}
    for task, key in [("<CAPTION>", "caption"), ("<MORE_DETAILED_CAPTION>", "detail")]:
        inputs = _processor(text=task, images=image, return_tensors="pt")
        with torch.no_grad():
            generated_ids = _model.generate(
                input_ids=inputs["input_ids"],
                pixel_values=inputs["pixel_values"],
                max_new_tokens=256,
                num_beams=3,
            )
        generated_text = _processor.batch_decode(generated_ids, skip_special_tokens=False)[0]
        parsed = _processor.post_process_generation(generated_text, task=task, image_size=(image.width, image.height))
        results[key] = parsed.get(task, generated_text).strip()

    return results


def run_caption_only(image_bytes: bytes) -> str:
    """Run Florence-2 <CAPTION> only. Fast, for person detection. Returns caption string."""
    global _model, _processor
    if _model is None or _processor is None:
        raise RuntimeError("Model not ready")

    import torch

    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    task = "<CAPTION>"
    inputs = _processor(text=task, images=image, return_tensors="pt")
    with torch.no_grad():
        generated_ids = _model.generate(
            input_ids=inputs["input_ids"],
            pixel_values=inputs["pixel_values"],
            max_new_tokens=64,
            num_beams=1,
        )
    generated_text = _processor.batch_decode(generated_ids, skip_special_tokens=False)[0]
    parsed = _processor.post_process_generation(generated_text, task=task, image_size=(image.width, image.height))
    return parsed.get(task, generated_text).strip()
