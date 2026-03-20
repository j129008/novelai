import base64
import csv
import io
import ipaddress
import json
import os
import re
import socket
import subprocess
import time
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from models.schemas import (
    AnalyzeImageRequest,
    AnalyzeImageResponse,
    AnalyzedTag,
    CharacterUsage,
    CharacterUsageList,
    ExploreImage,
    ExploreLink,
    ExplorePageRequest,
    ExplorePageResponse,
    GalleryFileItem,
    GalleryListResponse,
    GenerateRequest,
    GenerateResponse,
    GrokImageRequest,
    GrokImageResponse,
    GrokVideoRequest,
    GrokVideoResponse,
    RecordCharactersRequest,
    StoryCreateRequest,
    StoryListItem,
    StoryRecord,
    StoryUpdateRequest,
    SuggestTagsRequest,
    SuggestTagsResponse,
    TagSuggestion,
)
from api.novelai import generate_image

router = APIRouter(prefix="/api")

TOKEN = os.getenv("NOVELAI_TOKEN", "")
XAI_API_KEY = os.getenv("XAI_API_KEY", "")
XAI_MANAGEMENT_KEY = os.getenv("XAI_MANAGEMENT_KEY", "")
XAI_TEAM_ID = os.getenv("XAI_TEAM_ID", "")

# Settings file for persistent config
_settings_file = Path(__file__).resolve().parent.parent.parent / ".app-settings.json"
_default_output = Path(__file__).resolve().parent.parent.parent / "output"

# Character usage tracking file
_characters_file = Path(__file__).resolve().parent.parent.parent / ".recent-characters.json"
_CHARACTERS_MAX = 50


def _load_settings():
    if _settings_file.exists():
        return json.loads(_settings_file.read_text())
    return {}


def _save_settings(data):
    existing = _load_settings()
    existing.update(data)
    _settings_file.write_text(json.dumps(existing, indent=2))


def _get_output_dir() -> Path:
    settings = _load_settings()
    p = Path(settings.get("output_dir", str(_default_output)))
    p.mkdir(parents=True, exist_ok=True)
    return p


def _load_characters() -> list[CharacterUsage]:
    if _characters_file.exists():
        try:
            raw = json.loads(_characters_file.read_text())
            return [CharacterUsage(**item) for item in raw]
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
    return []


def _save_characters(characters: list[CharacterUsage]) -> None:
    _characters_file.write_text(
        json.dumps([c.model_dump() for c in characters], indent=2)
    )


def _sorted_characters(characters: list[CharacterUsage]) -> list[CharacterUsage]:
    return sorted(characters, key=lambda c: c.count, reverse=True)


# Ensure default output dir exists
_default_output.mkdir(exist_ok=True)

# Load tag database once at startup
TAG_CATEGORIES = {"0": "general", "1": "artist", "3": "series", "4": "character", "5": "meta"}
_tags = []
_tag_file = Path(__file__).resolve().parent.parent / "data" / "tags.csv"
if _tag_file.exists():
    with open(_tag_file, "r") as f:
        for row in csv.reader(f):
            if len(row) >= 3:
                try:
                    _tags.append({
                        "name": row[0],
                        "category": TAG_CATEGORIES.get(row[1], "general"),
                        "count": int(row[2]),
                        "aliases": row[3] if len(row) > 3 else "",
                    })
                except ValueError:
                    continue
    _tags.sort(key=lambda t: t["count"], reverse=True)

# Load tag categories once at startup
_tag_categories = {"categories": []}
_tag_cat_file = Path(__file__).resolve().parent.parent / "data" / "tag_categories.json"
if _tag_cat_file.exists():
    try:
        _tag_categories = json.loads(_tag_cat_file.read_text())
    except (json.JSONDecodeError, OSError):
        pass

# Load co-occurrence database once at startup
_cooc_data: dict = {"cooccurrence": {}, "metadata": {}}
_cooc_file = Path(__file__).resolve().parent.parent / "data" / "tag_cooccurrence.json"
if _cooc_file.exists():
    try:
        _cooc_data = json.loads(_cooc_file.read_text())
    except (json.JSONDecodeError, OSError):
        pass

SAMPLERS = [
    "k_euler_ancestral",
    "k_euler",
    "k_dpmpp_2s_ancestral",
    "k_dpmpp_2m",
    "k_dpmpp_2m_sde",
    "k_dpmpp_sde",
]

RESOLUTIONS = [
    {"width": 832, "height": 1216, "label": "Portrait (832x1216)"},
    {"width": 1216, "height": 832, "label": "Landscape (1216x832)"},
    {"width": 1024, "height": 1024, "label": "Square (1024x1024)"},
    {"width": 512, "height": 768, "label": "Small Portrait (512x768)"},
    {"width": 768, "height": 512, "label": "Small Landscape (768x512)"},
    {"width": 1088, "height": 1920, "label": "Wallpaper Portrait (1088x1920)"},
    {"width": 1920, "height": 1088, "label": "Wallpaper Landscape (1920x1088)"},
]


@router.get("/options")
async def get_options():
    return {
        "samplers": SAMPLERS,
        "resolutions": RESOLUTIONS,
        "grok": {
            "aspect_ratios": ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2"],
            "image_resolutions": ["1k", "2k"],
            "video_resolutions": ["480p", "720p"],
        },
    }


@router.get("/tags/categories")
async def get_tag_categories():
    return _tag_categories


@router.get("/tags/check-characters")
async def check_characters(tags: str = Query(description="Comma-separated tag names")):
    candidates = {t.strip() for t in tags.split(",") if t.strip()}
    character_names = {
        t["name"] for t in _tags if t["category"] == "character"
    }
    confirmed = [t for t in candidates if t in character_names]
    return {"characters": confirmed}


@router.get("/tags")
async def search_tags(q: str = Query(min_length=1), limit: int = Query(default=15, le=30)):
    query = q.lower().replace(" ", "_")
    results = []

    # 1. Prefix matches (tag name or any alias starts with query)
    for tag in _tags:
        if len(results) >= limit:
            break
        aliases = tag["aliases"].lower().split(",") if tag["aliases"] else []
        if tag["name"].startswith(query) or any(a.startswith(query) for a in aliases if a):
            results.append(tag)

    # 2. Substring matches (if more results needed)
    if len(results) < limit:
        seen = {r["name"] for r in results}
        for tag in _tags:
            if len(results) >= limit:
                break
            if tag["name"] not in seen:
                aliases = tag["aliases"].lower().split(",") if tag["aliases"] else []
                if query in tag["name"] or any(query in a for a in aliases if a):
                    results.append(tag)
                    
    return results


@router.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest):
    if not TOKEN:
        raise HTTPException(status_code=503, detail="NOVELAI_TOKEN not configured")

    try:
        image_data, seed = await generate_image(
            token=TOKEN,
            prompt=req.prompt,
            negative_prompt=req.negative_prompt,
            model=req.model,
            action="img2img" if req.image else "generate",
            width=req.width,
            height=req.height,
            steps=req.steps,
            scale=req.scale,
            sampler=req.sampler,
            seed=req.seed,
            sm=req.sm,
            sm_dyn=req.sm_dyn,
            noise_schedule=req.noise_schedule,
            cfg_rescale=req.cfg_rescale,
            image=req.image,
            strength=req.strength,
            noise=req.noise,
            reference_images=req.reference_images,
            char_captions=req.char_captions,
            use_coords=req.use_coords,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"NovelAI API error: {e}")

    # Auto-save to output/
    timestamp = int(time.time())
    filename = f"{timestamp}-s{seed}.png"
    filepath = _get_output_dir() / filename
    filepath.write_bytes(image_data)

    return GenerateResponse(
        image=base64.b64encode(image_data).decode(),
        seed=seed,
    )


@router.post("/grok/generate-image", response_model=GrokImageResponse)
async def grok_generate_image(req: GrokImageRequest):
    if not XAI_API_KEY:
        raise HTTPException(status_code=503, detail="XAI_API_KEY not configured")
    try:
        from api.grok import generate_image as grok_gen_image
        image_data = await grok_gen_image(
            api_key=XAI_API_KEY,
            prompt=req.prompt,
            aspect_ratio=req.aspect_ratio,
            resolution=req.resolution,
            image=req.image,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Grok API error: {e}")

    timestamp = int(time.time())
    filename = f"{timestamp}-grok.png"
    filepath = _get_output_dir() / filename
    filepath.write_bytes(image_data)

    return GrokImageResponse(image=base64.b64encode(image_data).decode())


@router.post("/grok/generate-video", response_model=GrokVideoResponse)
async def grok_generate_video(req: GrokVideoRequest):
    if not XAI_API_KEY:
        raise HTTPException(status_code=503, detail="XAI_API_KEY not configured")
    try:
        from api.grok import generate_video as grok_gen_video
        video_data = await grok_gen_video(
            api_key=XAI_API_KEY,
            prompt=req.prompt,
            aspect_ratio=req.aspect_ratio,
            resolution=req.resolution,
            duration=req.duration,
            image=req.image,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Grok API error: {e}")

    timestamp = int(time.time())
    filename = f"{timestamp}-grok.mp4"
    filepath = _get_output_dir() / filename
    filepath.write_bytes(video_data)

    return GrokVideoResponse(video=base64.b64encode(video_data).decode())


@router.get("/grok/usage")
async def grok_usage():
    if not XAI_MANAGEMENT_KEY or not XAI_TEAM_ID:
        raise HTTPException(status_code=503, detail="XAI_MANAGEMENT_KEY or XAI_TEAM_ID not configured")
    import httpx
    url = f"https://management-api.x.ai/v1/billing/teams/{XAI_TEAM_ID}/postpaid/invoice/preview"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers={"Authorization": f"Bearer {XAI_MANAGEMENT_KEY}"})
            if resp.status_code != 200:
                raise RuntimeError(f"{resp.status_code}: {resp.text[:300]}")
            data = resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Grok billing API error: {e}")

    invoice = data.get("coreInvoice", {})
    lines = invoice.get("lines", [])
    prepaid = int(invoice.get("prepaidCredits", {}).get("val", "0"))
    used = int(invoice.get("prepaidCreditsUsed", {}).get("val", "0"))
    total_cost = int(invoice.get("totalWithCorr", {}).get("val", "0"))

    # Parse line items into readable format
    items = []
    for line in lines:
        items.append({
            "model": line.get("description", ""),
            "type": line.get("unitType", ""),
            "count": int(line.get("numUnits", "0")),
            "cost_cents": int(line.get("amount", "0")),
        })

    return {
        "balance_cents": abs(prepaid),
        "used_cents": abs(used),
        "remaining_cents": abs(prepaid) - abs(used),
        "items": items,
    }


@router.get("/clipboard-image")
async def get_clipboard_image():
    """Read image from macOS system clipboard via osascript."""
    try:
        result = subprocess.run(
            ["osascript", "-e", 'the clipboard as «class PNGf»'],
            capture_output=True, timeout=5,
        )
        if result.returncode != 0:
            raise HTTPException(status_code=404, detail="No image in clipboard")

        # osascript returns hex-encoded data like: «data PNGf89504E4...»
        # Extract the hex string between "PNGf" and the closing delimiter
        raw = result.stdout
        # Find "PNGf" marker and extract hex digits after it
        marker = b"PNGf"
        idx = raw.find(marker)
        if idx < 0:
            raise HTTPException(status_code=404, detail="No PNG data in clipboard")
        hex_start = idx + len(marker)
        # Extract all hex chars until a non-hex byte
        hex_str = ""
        for b in raw[hex_start:]:
            c = chr(b)
            if c in "0123456789ABCDEFabcdef":
                hex_str += c
            else:
                break
        if not hex_str:
            raise HTTPException(status_code=404, detail="No PNG data in clipboard")

        png_bytes = bytes.fromhex(hex_str)
        return {"image": base64.b64encode(png_bytes).decode()}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Clipboard read timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Clipboard read failed: {e}")


class ImageMetaRequest(BaseModel):
    image: str  # base64

@router.post("/read-image-meta")
async def read_image_meta(req: ImageMetaRequest):
    """Read PNG metadata from an uploaded base64 image."""
    try:
        from PIL import Image as PILImage
        img_bytes = base64.b64decode(req.image)
        img = PILImage.open(io.BytesIO(img_bytes))
        if "Comment" in img.info:
            meta = json.loads(img.info["Comment"])
            result = {
                "prompt": meta.get("prompt", ""),
                "uc": meta.get("uc", ""),
                "seed": meta.get("seed", 0),
                "steps": meta.get("steps", 23),
                "scale": meta.get("scale", 5.0),
                "sampler": meta.get("sampler", "k_euler_ancestral"),
                "width": meta.get("width", 832),
                "height": meta.get("height", 1216),
                "sm": meta.get("sm", False),
                "sm_dyn": meta.get("sm_dyn", False),
            }
            v4 = meta.get("v4_prompt")
            if v4 and isinstance(v4, dict):
                caption = v4.get("caption", {})
                char_captions = caption.get("char_captions", [])
                if char_captions:
                    result["char_captions"] = char_captions
                    result["use_coords"] = v4.get("use_coords", False)
            return result
        return {}
    except Exception:
        raise HTTPException(status_code=422, detail="Could not read image metadata")


def _resolve_gallery_path(output_dir: Path, subpath: str) -> Path:
    """Resolve subpath inside output_dir, raising 400 on traversal attempts.

    Rejects paths containing '..' components before resolution as an explicit
    guard, then re-checks after Path.resolve() to catch symlink-based escapes.
    """
    if ".." in Path(subpath).parts:
        raise HTTPException(status_code=400, detail="Path traversal not allowed")
    resolved = (output_dir / subpath).resolve()
    if not resolved.is_relative_to(output_dir.resolve()):
        raise HTTPException(status_code=400, detail="Path traversal not allowed")
    return resolved


def _read_png_meta(filepath: Path) -> dict:
    # PNG files saved by this app carry generation parameters in the PNG "Comment" chunk,
    # which Pillow exposes as img.info["Comment"].  The value is a JSON object written by
    # the NovelAI API directly into the generated image — we do not write it ourselves.
    # Fields extracted here match the keys that NovelAI embeds: prompt, uc (negative
    # prompt), seed, steps, scale, sampler, width, height, sm, and sm_dyn.  If the chunk
    # is absent (e.g., images created by other tools), the function returns an empty dict
    # and the gallery entry is listed without metadata.
    try:
        from PIL import Image
        img = Image.open(filepath)
        if "Comment" in img.info:
            import json as _json
            meta = _json.loads(img.info["Comment"])
            result = {
                "prompt": meta.get("prompt", ""),
                "uc": meta.get("uc", ""),
                "seed": meta.get("seed", 0),
                "steps": meta.get("steps", 28),
                "scale": meta.get("scale", 5.0),
                "sampler": meta.get("sampler", "k_euler_ancestral"),
                "width": meta.get("width", 832),
                "height": meta.get("height", 1216),
                "sm": meta.get("sm", False),
                "sm_dyn": meta.get("sm_dyn", False),
            }
            # Extract character data from v4_prompt if present
            v4 = meta.get("v4_prompt")
            if v4 and isinstance(v4, dict):
                caption = v4.get("caption", {})
                char_captions = caption.get("char_captions", [])
                if char_captions:
                    result["char_captions"] = char_captions
                    result["use_coords"] = v4.get("use_coords", False)
            return result
    except Exception:
        pass
    return {}


@router.get("/gallery", response_model=GalleryListResponse)
async def list_gallery(path: str = Query(default="")):
    out = _get_output_dir()
    current_dir = _resolve_gallery_path(out, path)
    if not current_dir.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")

    directories = sorted(
        d.name for d in current_dir.iterdir() if d.is_dir()
    )
    media_files = sorted(
        (f for f in current_dir.iterdir()
         if f.is_file() and f.suffix.lower() in (".png", ".mp4") and not f.name.startswith("._")),
        key=lambda f: f.stat().st_mtime, reverse=True,
    )
    files = [
        GalleryFileItem(
            name=f.name,
            size=f.stat().st_size,
            meta=_read_png_meta(f) if f.suffix.lower() == ".png" else {},
        )
        for f in media_files
    ]
    return GalleryListResponse(path=path, directories=directories, files=files)


@router.get("/gallery/{filename}")
async def get_gallery_image(filename: str, path: str = Query(default="")):
    out = _get_output_dir()
    filepath = _resolve_gallery_path(out, path) / filename
    filepath = filepath.resolve()
    if not filepath.exists() or not filepath.is_relative_to(out.resolve()):
        raise HTTPException(status_code=404, detail="Image not found")
    media_type = "video/mp4" if filepath.suffix.lower() == ".mp4" else "image/png"
    return FileResponse(filepath, media_type=media_type)


@router.delete("/gallery/{filename}")
async def delete_gallery_image(filename: str, path: str = Query(default="")):
    out = _get_output_dir()
    filepath = _resolve_gallery_path(out, path) / filename
    filepath = filepath.resolve()
    if not filepath.exists() or not filepath.is_relative_to(out.resolve()):
        raise HTTPException(status_code=404, detail="Image not found")
    filepath.unlink()
    return {"deleted": filename}


class SettingsUpdate(BaseModel):
    output_dir: str | None = None


@router.get("/settings")
async def get_settings():
    settings = _load_settings()
    return {
        "output_dir": settings.get("output_dir", str(_default_output)),
    }


@router.put("/settings")
async def update_settings(req: SettingsUpdate):
    if req.output_dir is not None:
        p = Path(req.output_dir).expanduser().resolve()
        p.mkdir(parents=True, exist_ok=True)
        _save_settings({"output_dir": str(p)})
    return await get_settings()


@router.post("/settings/browse")
async def browse_folder():
    try:
        result = subprocess.run(
            ["osascript", "-e", 'POSIX path of (choose folder with prompt "Select output folder")'],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode == 0:
            folder = result.stdout.strip().rstrip("/")
            return {"path": folder}
        return {"path": None}
    except Exception:
        raise HTTPException(status_code=500, detail="Folder picker not available")


@router.post("/settings/open-folder")
async def open_output_folder():
    out = _get_output_dir()
    try:
        subprocess.Popen(["open", str(out)])
    except Exception:
        raise HTTPException(status_code=500, detail="Could not open output folder")
    return {"opened": str(out)}


@router.get("/recent-characters", response_model=CharacterUsageList)
async def get_recent_characters():
    return CharacterUsageList(characters=_load_characters())


@router.post("/recent-characters", response_model=CharacterUsageList)
async def record_characters(req: RecordCharactersRequest):
    characters = _load_characters()
    index: dict[str, CharacterUsage] = {c.tag: c for c in characters}

    for tag in req.tags:
        if tag in index:
            index[tag] = CharacterUsage(tag=tag, count=index[tag].count + 1)
        else:
            index[tag] = CharacterUsage(tag=tag, count=1)

    updated = _sorted_characters(list(index.values()))
    if len(updated) > _CHARACTERS_MAX:
        updated = updated[:_CHARACTERS_MAX]

    _save_characters(updated)
    return CharacterUsageList(characters=updated)


@router.delete("/recent-characters/{tag_name}", response_model=CharacterUsageList)
async def delete_recent_character(tag_name: str):
    characters = [c for c in _load_characters() if c.tag != tag_name]
    _save_characters(characters)
    return CharacterUsageList(characters=characters)


# ---------------------------------------------------------------------------
# Prompt DNA — tag suggestions based on co-occurrence
# ---------------------------------------------------------------------------

@router.post("/suggest-tags", response_model=SuggestTagsResponse)
async def suggest_tags(req: SuggestTagsRequest):
    import random

    cooc: dict[str, dict[str, float]] = _cooc_data.get("cooccurrence", {})
    meta: dict[str, dict] = _cooc_data.get("metadata", {})

    input_set = {t.lower().replace(" ", "_") for t in req.tags}

    # Tally co-occurrence scores across all input tags
    score_tally: dict[str, float] = {}
    vote_count: dict[str, int] = {}  # how many input tags co-occur with each candidate
    for input_tag in input_set:
        relations = cooc.get(input_tag, {})
        for candidate, score in relations.items():
            if candidate in input_set:
                continue
            score_tally[candidate] = score_tally.get(candidate, 0.0) + score
            vote_count[candidate] = vote_count.get(candidate, 0) + 1

    # Determine dominant category of input tags
    input_categories = [meta[t]["category"] for t in input_set if t in meta]
    dominant_category: str | None = None
    if input_categories:
        from collections import Counter
        dominant_category = Counter(input_categories).most_common(1)[0][0]

    def _make_suggestion(name: str, score: float) -> TagSuggestion:
        tag_meta = meta.get(name, {})
        return TagSuggestion(
            name=name,
            score=round(min(score, 1.0), 3),
            category=tag_meta.get("category", "subject"),
            count=tag_meta.get("count", 0),
        )

    # Boosters: high co-occurrence (> 0.5) with multiple input tags, high count
    booster_candidates = [
        (name, score_tally[name])
        for name in score_tally
        if vote_count[name] >= max(1, len(input_set) // 2) and score_tally[name] > 0.5
    ]
    booster_candidates.sort(key=lambda x: (vote_count[x[0]], x[1], meta.get(x[0], {}).get("count", 0)), reverse=True)
    boosters = [_make_suggestion(name, score) for name, score in booster_candidates[:6]]

    # Contrasts: different category from dominant, moderate co-occurrence (0.2–0.5)
    already_used = input_set | {b.name for b in boosters}
    contrast_candidates = [
        (name, score_tally[name])
        for name in score_tally
        if name not in already_used
        and 0.2 <= score_tally[name] <= 0.5
        and (dominant_category is None or meta.get(name, {}).get("category") != dominant_category)
    ]
    contrast_candidates.sort(key=lambda x: x[1], reverse=True)
    contrasts = [_make_suggestion(name, score) for name, score in contrast_candidates[:4]]

    # Wildcards: lower co-occurrence (0.05–0.2), moderate count, some randomness
    already_used |= {c.name for c in contrasts}
    wildcard_pool = [
        (name, score_tally[name])
        for name in score_tally
        if name not in already_used
        and 0.05 <= score_tally[name] <= 0.2
        and 10_000 <= meta.get(name, {}).get("count", 0) <= 1_000_000
    ]
    # Pick randomly from top candidates for variety
    wildcard_pool.sort(key=lambda x: x[1], reverse=True)
    top_wildcards = wildcard_pool[:20]
    random.shuffle(top_wildcards)
    wildcards = [_make_suggestion(name, score) for name, score in top_wildcards[:4]]

    return SuggestTagsResponse(boosters=boosters, contrasts=contrasts, wildcards=wildcards)


# ---------------------------------------------------------------------------
# Prompt Autopsy — image tag analysis via WD Tagger
# ---------------------------------------------------------------------------

@router.post("/analyze-image", response_model=AnalyzeImageResponse)
async def analyze_image(req: AnalyzeImageRequest):
    from api.tagger import ensure_model_loaded, get_model_status, run_inference

    status = ensure_model_loaded()

    if status in ("not_started", "downloading"):
        _, progress = get_model_status()
        return AnalyzeImageResponse(status="downloading", progress=progress)

    if status == "failed":
        raise HTTPException(status_code=503, detail="Tagger model failed to load; check server logs")

    # status == "ready"
    try:
        raw_tags = run_inference(req.image)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=f"Inference error: {exc}")

    tags = [
        AnalyzedTag(name=t["name"], score=t["score"], category=t["category"])
        for t in raw_tags
    ]
    return AnalyzeImageResponse(status="complete", tags=tags)


# ---------------------------------------------------------------------------
# Stories
# ---------------------------------------------------------------------------

def _get_stories_dir() -> Path:
    settings = _load_settings()
    output_dir = settings.get("output_dir")
    if output_dir:
        stories_dir = Path(output_dir) / "stories"
    else:
        stories_dir = Path(__file__).resolve().parent.parent.parent / "stories"
    stories_dir.mkdir(parents=True, exist_ok=True)
    return stories_dir


def _validate_story_id(story_id: str) -> None:
    if "/" in story_id or ".." in story_id:
        raise HTTPException(status_code=400, detail="Invalid story id")


def _story_path(story_id: str) -> Path:
    _validate_story_id(story_id)
    return _get_stories_dir() / f"{story_id}.json"


def _word_count(content: str) -> int:
    plain = re.sub(r"<[^>]+>", "", content)
    return len(plain.split()) if plain.strip() else 0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_story(story_id: str) -> StoryRecord:
    path = _story_path(story_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Story not found")
    try:
        data = json.loads(path.read_text())
        return StoryRecord(**data)
    except (json.JSONDecodeError, TypeError, ValueError):
        raise HTTPException(status_code=500, detail="Story data is corrupt")


@router.get("/stories", response_model=list[StoryListItem])
async def list_stories():
    stories_dir = _get_stories_dir()
    items = []
    for p in stories_dir.glob("*.json"):
        try:
            data = json.loads(p.read_text())
            items.append(
                StoryListItem(
                    id=data["id"],
                    title=data["title"],
                    word_count=_word_count(data.get("content", "")),
                    created_at=data["created_at"],
                    updated_at=data["updated_at"],
                )
            )
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            continue
    items.sort(key=lambda s: s.updated_at, reverse=True)
    return items


@router.get("/stories/{story_id}", response_model=StoryRecord)
async def get_story(story_id: str):
    return _load_story(story_id)


@router.post("/stories", response_model=StoryRecord, status_code=201)
async def create_story(req: StoryCreateRequest):
    story_id = str(int(time.time() * 1000))
    now = _now_iso()
    record = StoryRecord(
        id=story_id,
        title=req.title,
        content=req.content,
        created_at=now,
        updated_at=now,
    )
    _story_path(story_id).write_text(json.dumps(record.model_dump(), indent=2))
    return record


@router.put("/stories/{story_id}", response_model=StoryRecord)
async def update_story(story_id: str, req: StoryUpdateRequest):
    record = _load_story(story_id)
    updated = record.model_dump()
    if req.title is not None:
        updated["title"] = req.title
    if req.content is not None:
        updated["content"] = req.content
    updated["updated_at"] = _now_iso()
    new_record = StoryRecord(**updated)
    _story_path(story_id).write_text(json.dumps(new_record.model_dump(), indent=2))
    return new_record


@router.delete("/stories/{story_id}", status_code=204)
async def delete_story(story_id: str):
    path = _story_path(story_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Story not found")
    path.unlink()
    return None


# ---------------------------------------------------------------------------
# Image Explorer — web page proxy and image extraction
# ---------------------------------------------------------------------------

_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/123.0.0.0 Safari/537.36"
)

_EXPLORE_MAX_IMAGES = 100
_EXPLORE_MAX_LINKS = 50
_EXPLORE_MAX_BYTES = 20 * 1024 * 1024  # 20 MB
_EXPLORE_TIMEOUT = 15.0


def _validate_explore_url(url: str) -> str:
    """Validate URL scheme, strip credentials, and block private/loopback hosts.

    Returns the sanitised URL string, or raises HTTPException on rejection.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="URL must use http or https")

    # Strip any embedded credentials
    clean = parsed._replace(netloc=parsed.hostname + (f":{parsed.port}" if parsed.port else ""))
    url = clean.geturl()

    # Resolve hostname to IP and reject private/loopback ranges
    hostname = parsed.hostname or ""
    if not hostname:
        raise HTTPException(status_code=400, detail="URL has no hostname")
    try:
        addr = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
        for item in addr:
            ip = ipaddress.ip_address(item[4][0])
            if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved:
                raise HTTPException(status_code=400, detail="URL resolves to a private or reserved address")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail=f"Could not resolve hostname: {hostname}")

    return url


class _PageParser(HTMLParser):
    """Extract <title>, <img>, <a>, <meta>, and srcset from an HTML document."""

    def __init__(self, base_url: str) -> None:
        super().__init__()
        self.base_url = base_url
        self.title = ""
        self._in_title = False
        self.images: list[dict] = []
        self.links: list[dict] = []
        self._seen_srcs: set[str] = set()

    def _abs(self, href: str) -> str:
        return urljoin(self.base_url, href)

    def handle_starttag(self, tag: str, attrs_list: list) -> None:
        attrs = dict(attrs_list)

        if tag == "title":
            self._in_title = True
            return

        if tag == "meta":
            # og:image / twitter:image carry the canonical page image
            prop = attrs.get("property", "") or attrs.get("name", "")
            content = attrs.get("content", "").strip()
            if prop in ("og:image", "twitter:image") and content:
                self._add_image(content, alt="")
            return

        if tag == "img":
            src = attrs.get("src", "").strip()
            alt = attrs.get("alt", "").strip()
            # Try to parse integer dimensions; ignore non-integer values
            width = _try_int(attrs.get("width", ""))
            height = _try_int(attrs.get("height", ""))
            # Skip tiny images that are clearly tracking pixels / icons
            if width is not None and width < 50:
                return
            if height is not None and height < 50:
                return
            if src:
                self._add_image(src, alt=alt, width=width, height=height)
            # Also harvest srcset — pick the largest listed URL
            srcset = attrs.get("srcset", "").strip()
            if srcset:
                largest = _largest_srcset_url(srcset)
                if largest:
                    self._add_image(largest, alt=alt, width=width, height=height)
            return

        if tag == "a":
            href = attrs.get("href", "").strip()
            text = ""  # text collected in handle_data is too noisy at parse time
            if href and not href.startswith(("javascript:", "#", "mailto:", "tel:")):
                abs_href = self._abs(href)
                self.links.append({"href": abs_href, "text": text})

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data

    def _add_image(
        self,
        src: str,
        alt: str = "",
        width: "int | None" = None,
        height: "int | None" = None,
    ) -> None:
        if src.startswith("data:"):
            return
        abs_src = self._abs(src)
        if abs_src in self._seen_srcs:
            return
        # Skip obvious tracking pixel filenames
        lower = abs_src.lower()
        if "favicon" in lower or "1x1" in lower or lower.endswith(".ico"):
            return
        self._seen_srcs.add(abs_src)
        self.images.append({"src": abs_src, "alt": alt, "width": width, "height": height})


def _try_int(value: str) -> "int | None":
    """Return int if value is a plain positive integer string, else None."""
    try:
        n = int(value)
        return n if n > 0 else None
    except (ValueError, TypeError):
        return None


def _largest_srcset_url(srcset: str) -> "str | None":
    """Pick the URL with the largest declared width descriptor from a srcset string."""
    best_url = None
    best_w = -1
    for part in srcset.split(","):
        part = part.strip()
        if not part:
            continue
        tokens = part.split()
        if not tokens:
            continue
        url = tokens[0]
        if len(tokens) >= 2:
            descriptor = tokens[1]
            if descriptor.endswith("w"):
                w = _try_int(descriptor[:-1])
                if w is not None and w > best_w:
                    best_w = w
                    best_url = url
            # x-descriptors: just keep the first URL we see
            elif best_w == -1:
                best_url = url
        elif best_w == -1:
            best_url = url
    return best_url


_JSON_IMG_RE = re.compile(
    r'"(?:src|display_url|image_url|full_image_url|url)"\s*:\s*"(https?://[^"]+\.(?:jpg|jpeg|png|webp|gif)(?:[^"]*)?)"',
    re.IGNORECASE,
)


def _extract_json_images(html: str, base_url: str) -> list[dict]:
    """Scan raw HTML (e.g., inline <script> JSON blobs) for image URL patterns."""
    results = []
    seen: set[str] = set()
    for m in _JSON_IMG_RE.finditer(html):
        # Un-escape common JSON unicode escapes (\\u0026 → &, \\/ → /)
        raw = m.group(1).replace("\\/", "/").replace("\\u0026", "&")
        abs_src = urljoin(base_url, raw)
        if abs_src not in seen:
            seen.add(abs_src)
            results.append({"src": abs_src, "alt": "", "width": None, "height": None})
    return results


def _filter_links(links: list[dict], base_url: str) -> list[dict]:
    """Keep only content-looking links; deduplicate."""
    base_host = urlparse(base_url).hostname or ""
    seen: set[str] = set()
    out = []
    for link in links:
        href = link["href"]
        if href in seen:
            continue
        parsed = urlparse(href)
        if parsed.scheme not in ("http", "https"):
            continue
        host = parsed.hostname or ""
        # Accept same-domain links or links to common image / social hosts
        if host == base_host or any(
            host.endswith(domain)
            for domain in (
                "instagram.com", "pinterest.com", "twitter.com", "x.com",
                "artstation.com", "deviantart.com", "flickr.com", "tumblr.com",
                "pixiv.net", "danbooru.donmai.us", "gelbooru.com",
            )
        ):
            seen.add(href)
            out.append(link)
    return out[:_EXPLORE_MAX_LINKS]


async def _explore_with_playwright(url: str) -> tuple[list[dict], list[dict], str, str]:
    """Use headless Chrome via Playwright to extract images from JS-rendered pages."""
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome", headless=True)
        try:
            page = await browser.new_page()
            await page.goto(url, wait_until="networkidle", timeout=30000)
            final_url = page.url
            title = await page.title()

            # Extract images and links from the rendered DOM
            result = await page.evaluate("""() => {
                const imgs = Array.from(document.querySelectorAll("img"))
                    .map(img => ({
                        src: img.src,
                        alt: img.alt || "",
                        w: img.naturalWidth || null,
                        h: img.naturalHeight || null
                    }))
                    .filter(i => i.src && !i.src.startsWith("data:") &&
                            (i.w === null || i.w > 50) && (i.h === null || i.h > 50));
                const links = Array.from(document.querySelectorAll("a[href]"))
                    .map(a => ({ href: a.href, text: (a.textContent || "").trim().slice(0, 80) }))
                    .filter(l => l.href.startsWith("http"));
                return { imgs, links };
            }""")
        finally:
            await browser.close()

    seen: set[str] = set()
    images = []
    for img in result["imgs"]:
        if img["src"] not in seen:
            seen.add(img["src"])
            images.append({"src": img["src"], "alt": img["alt"], "width": img["w"], "height": img["h"]})

    return images, result["links"], final_url, title


@router.post("/explore/page", response_model=ExplorePageResponse)
async def explore_page(req: ExplorePageRequest):
    url = _validate_explore_url(req.url)

    import httpx

    headers = {
        "User-Agent": _BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    }
    try:
        async with httpx.AsyncClient(
            timeout=_EXPLORE_TIMEOUT,
            follow_redirects=True,
            headers=headers,
        ) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            final_url = str(resp.url)
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"Remote server returned {exc.response.status_code}")
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch URL: {exc}")

    content_type = resp.headers.get("content-type", "")
    if "html" not in content_type and "xml" not in content_type:
        raise HTTPException(status_code=422, detail="URL does not appear to be an HTML page")

    try:
        html = resp.text
    except Exception:
        html = resp.content.decode("utf-8", errors="replace")

    # --- Parse with stdlib HTMLParser ---
    parser = _PageParser(base_url=final_url)
    try:
        parser.feed(html)
    except Exception:
        pass

    images: list[dict] = list(parser.images)

    # --- Augment with JSON-embedded image URLs from script tags ---
    json_images = _extract_json_images(html, final_url)
    seen_srcs = {img["src"] for img in images}
    for img in json_images:
        if img["src"] not in seen_srcs:
            seen_srcs.add(img["src"])
            images.append(img)

    # --- Fallback: if no images found, try Playwright for JS-rendered pages ---
    title = parser.title.strip()
    if not images:
        try:
            pw_images, pw_links, final_url, pw_title = await _explore_with_playwright(url)
            images = pw_images
            if pw_title:
                title = pw_title
            # Use Playwright links if we got them
            links = _filter_links(pw_links, final_url)
            images = images[:_EXPLORE_MAX_IMAGES]
            return ExplorePageResponse(
                url=final_url,
                title=title,
                images=[ExploreImage(**img) for img in images],
                links=[ExploreLink(**lnk) for lnk in links],
            )
        except Exception:
            pass  # Fall through to return empty result

    images = images[:_EXPLORE_MAX_IMAGES]
    links = _filter_links(parser.links, final_url)

    return ExplorePageResponse(
        url=final_url,
        title=parser.title.strip(),
        images=[ExploreImage(**img) for img in images],
        links=[ExploreLink(**lnk) for lnk in links],
    )


@router.get("/explore/image")
async def proxy_image(url: str = Query(min_length=1)):
    url = _validate_explore_url(url)

    import httpx

    headers = {
        "User-Agent": _BROWSER_UA,
        "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
    }
    try:
        client = httpx.AsyncClient(
            timeout=_EXPLORE_TIMEOUT,
            follow_redirects=True,
            headers=headers,
        )
        resp = await client.get(url)
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"Remote server returned {exc.response.status_code}")
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch image: {exc}")

    content_type = resp.headers.get("content-type", "application/octet-stream").split(";")[0].strip()
    if not content_type.startswith("image/"):
        await client.aclose()
        raise HTTPException(status_code=422, detail="URL does not point to an image")

    content_length = int(resp.headers.get("content-length", 0))
    if content_length > _EXPLORE_MAX_BYTES:
        await client.aclose()
        raise HTTPException(status_code=413, detail="Image exceeds 20 MB size limit")

    async def _stream_and_close():
        total = 0
        try:
            async for chunk in resp.aiter_bytes(chunk_size=65536):
                total += len(chunk)
                if total > _EXPLORE_MAX_BYTES:
                    break
                yield chunk
        finally:
            await client.aclose()

    return StreamingResponse(
        _stream_and_close(),
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=3600"},
    )


_PERSON_TAGS = frozenset([
    "1girl", "2girls", "3girls", "4girls", "5girls", "6+girls", "multiple_girls",
    "1boy", "2boys", "3boys", "4boys", "5boys", "6+boys", "multiple_boys",
    "1other", "person", "solo", "couple", "group",
    "face", "portrait", "upper_body", "cowboy_shot", "full_body",
])


@router.post("/explore/has-person")
async def explore_has_person(req: AnalyzeImageRequest):
    """Quick check if an image contains a person using WD Tagger. Returns {has_person: bool}."""
    from api.tagger import ensure_model_loaded, get_model_status, run_inference

    status = ensure_model_loaded()
    if status in ("not_started", "downloading"):
        _, progress = get_model_status()
        return {"has_person": None, "status": "downloading", "progress": progress}
    if status == "failed":
        return {"has_person": None, "status": "failed"}

    try:
        raw_tags = run_inference(req.image)
    except RuntimeError:
        return {"has_person": None, "status": "error"}

    for t in raw_tags:
        if t["name"] in _PERSON_TAGS and t["score"] >= 0.4:
            return {"has_person": True, "status": "ready"}
    return {"has_person": False, "status": "ready"}
