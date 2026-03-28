import base64
import csv
import io
import ipaddress
import json
import logging
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

log = logging.getLogger("app")
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field as PydanticField

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
    GrokAnalysis,
    GrokImageRequest,
    GrokImageResponse,
    GrokVideoRequest,
    GrokVideoResponse,
    LayerRedrawRequest,
    LayerRedrawResponse,
    LocalAnalyzeRequest,
    LocalAnalyzeResponse,
    LocalBrowseItem,
    LocalBrowseResponse,
    LocalTagsBatchResponse,
    LocalTagsCacheResponse,
    RecordCharactersRequest,
    SuggestTagsRequest,
    SuggestTagsResponse,
    TagSuggestion,
    FlorenceAnalysis,
    WdTag,
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


_IMAGE_EXTENSIONS = frozenset((".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff"))


def _natural_sort_key(name: str):
    """Sort key that handles numeric segments naturally: 'Ch 2' < 'Ch 10'."""
    return [int(c) if c.isdigit() else c.lower() for c in re.split(r'(\d+)', name)]


def _get_local_browse_root() -> Path:
    settings = _load_settings()
    root = settings.get("local_browse_root", "")
    if not root:
        raise HTTPException(status_code=400, detail="Local browse root not configured")
    p = Path(root)
    if not p.is_dir():
        raise HTTPException(status_code=400, detail="Local browse root does not exist")
    return p


def _get_tags_cache_path(root: Path, image_path: str) -> Path:
    """Get the .tags/ cache file path for an image. Validates path security."""
    image_file = _resolve_gallery_path(root, image_path)
    if not image_file.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    tags_dir = image_file.parent / ".tags"
    return tags_dir / (image_file.name + ".json")


def _read_tags_cache(cache_path: Path) -> dict:
    """Read existing cache file, return empty dict if not found."""
    if cache_path.exists():
        try:
            return json.loads(cache_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _write_tags_cache(cache_path: Path, method: str, data: dict | list):
    """Read-modify-write: merge new method data into existing cache."""
    existing = _read_tags_cache(cache_path)
    existing[method] = data
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")


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
    log.info(f"generate: {req.width}x{req.height} steps={req.steps} has_image={req.image is not None} has_mask={req.mask is not None}")

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
            mask=req.mask,
        )
    except Exception as e:
        log.error(f"NovelAI API error: {e}")
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


@router.post("/layer-redraw", response_model=LayerRedrawResponse)
async def layer_redraw(req: LayerRedrawRequest):
    if not TOKEN:
        raise HTTPException(status_code=503, detail="NOVELAI_TOKEN not configured")
    log.info(f"layer-redraw: {req.width}x{req.height} strength={req.strength}")

    try:
        from PIL import Image
        import numpy as np

        raw = base64.b64decode(req.image)
        original = Image.open(io.BytesIO(raw)).convert("RGBA")
        orig_w, orig_h = original.size

        # Extract alpha channel
        alpha = original.split()[3]
        alpha_arr = np.array(alpha)

        # Find bounding box of non-transparent pixels (with padding)
        non_zero = np.argwhere(alpha_arr > 10)
        if non_zero.size == 0:
            raise ValueError("Sketch is empty — draw something first")

        y_min, x_min = non_zero.min(axis=0)
        y_max, x_max = non_zero.max(axis=0)

        # Add padding (10% of bbox size, min 20px)
        pad_x = max(int((x_max - x_min) * 0.1), 20)
        pad_y = max(int((y_max - y_min) * 0.1), 20)
        x_min = max(0, x_min - pad_x)
        y_min = max(0, y_min - pad_y)
        x_max = min(orig_w - 1, x_max + pad_x)
        y_max = min(orig_h - 1, y_max + pad_y)

        # Crop to bounding box
        bbox = (x_min, y_min, x_max + 1, y_max + 1)
        cropped = original.crop(bbox)
        cropped_alpha = alpha.crop(bbox)

        # Composite cropped sketch onto white background for NAI
        white_bg = Image.new("RGB", cropped.size, (255, 255, 255))
        white_bg.paste(cropped, mask=cropped_alpha)

        # Resize to a valid NAI resolution (snap to nearest 64px multiple)
        crop_w, crop_h = white_bg.size
        gen_w = max(64, min(2048, ((crop_w + 31) // 64) * 64))
        gen_h = max(64, min(2048, ((crop_h + 31) // 64) * 64))
        if white_bg.size != (gen_w, gen_h):
            white_bg = white_bg.resize((gen_w, gen_h), Image.LANCZOS)

        img_buf = io.BytesIO()
        white_bg.save(img_buf, format="PNG")
        img_b64 = base64.b64encode(img_buf.getvalue()).decode()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.error(f"Image pre-processing error: {e}")
        raise HTTPException(status_code=400, detail=f"Image pre-processing error: {e}")

    try:
        image_data, _seed = await generate_image(
            token=TOKEN,
            prompt=req.prompt,
            negative_prompt=req.negative_prompt,
            action="img2img",
            width=gen_w,
            height=gen_h,
            steps=req.steps,
            scale=req.scale,
            sampler=req.sampler,
            seed=req.seed,
            strength=req.strength,
            image=img_b64,
        )
    except Exception as e:
        log.error(f"NovelAI API error: {e}")
        raise HTTPException(status_code=502, detail=f"NovelAI API error: {e}")

    try:
        result_cropped = Image.open(io.BytesIO(image_data)).convert("RGB")

        # Resize result back to cropped bbox size
        crop_size = (bbox[2] - bbox[0], bbox[3] - bbox[1])
        result_cropped = result_cropped.resize(crop_size, Image.LANCZOS)

        # Remove white background: pixels close to white become transparent.
        # Use a threshold to handle near-white from JPEG compression artifacts.
        result_arr = np.array(result_cropped)
        r, g, b = result_arr[:,:,0], result_arr[:,:,1], result_arr[:,:,2]
        # Pixels where all channels > 240 are considered background
        white_mask = (r > 240) & (g > 240) & (b > 240)
        # Create alpha: 0 for white bg, 255 for content
        alpha_arr = np.where(white_mask, 0, 255).astype(np.uint8)
        # Smooth the alpha edge slightly to avoid hard cutoff
        from PIL import ImageFilter
        alpha_img = Image.fromarray(alpha_arr).filter(ImageFilter.GaussianBlur(radius=1))

        result_rgba = result_cropped.convert("RGBA")
        result_rgba.putalpha(alpha_img)

        # Paste back into a full-size transparent canvas at the original position
        full_result = Image.new("RGBA", (orig_w, orig_h), (0, 0, 0, 0))
        full_result.paste(result_rgba, (bbox[0], bbox[1]))

        out_buf = io.BytesIO()
        full_result.save(out_buf, format="PNG")
        out_b64 = base64.b64encode(out_buf.getvalue()).decode()
    except Exception as e:
        log.error(f"Image post-processing error: {e}")
        raise HTTPException(status_code=500, detail=f"Image post-processing error: {e}")

    return LayerRedrawResponse(image=out_b64)


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
            model=req.model,
            images=req.images,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Grok API error: {e}")

    timestamp = int(time.time())
    filename = f"{timestamp}-grok.png"
    filepath = _get_output_dir() / filename
    filepath.write_bytes(image_data)

    return GrokImageResponse(image=base64.b64encode(image_data).decode())


@router.post("/grok/generate-video")
async def grok_generate_video(req: GrokVideoRequest):
    if not XAI_API_KEY:
        raise HTTPException(status_code=503, detail="XAI_API_KEY not configured")

    import asyncio

    progress_queue: asyncio.Queue = asyncio.Queue()

    async def on_progress(status, progress):
        await progress_queue.put({"status": status, "progress": progress})

    async def event_stream():
        from api.grok import generate_video as grok_gen_video

        # Run generation in a background task so we can stream progress
        gen_task = asyncio.create_task(grok_gen_video(
            api_key=XAI_API_KEY,
            prompt=req.prompt,
            aspect_ratio=req.aspect_ratio,
            resolution=req.resolution,
            duration=req.duration,
            image=req.image,
            on_progress=on_progress,
        ))

        # Stream progress events until generation completes
        while not gen_task.done():
            try:
                msg = await asyncio.wait_for(progress_queue.get(), timeout=5.0)
                yield f"data: {json.dumps(msg)}\n\n"
            except asyncio.TimeoutError:
                yield f"data: {json.dumps({'status': 'pending', 'progress': 0})}\n\n"

        # Get result or error
        try:
            video_data = gen_task.result()
            timestamp = int(time.time())
            filename = f"{timestamp}-grok.mp4"
            filepath = _get_output_dir() / filename
            filepath.write_bytes(video_data)
            b64 = base64.b64encode(video_data).decode()
            yield f"data: {json.dumps({'status': 'done', 'video': b64})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'status': 'error', 'detail': str(e)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


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
        d.name for d in current_dir.iterdir() if d.is_dir() and not d.name.startswith(".")
    )
    media_files = sorted(
        (f for f in current_dir.iterdir()
         if f.is_file() and f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".mp4") and not f.name.startswith("._")),
        key=lambda f: f.stat().st_mtime, reverse=True,
    )
    files = [
        GalleryFileItem(
            name=f.name,
            size=f.stat().st_size,
            meta=_read_png_meta(f) if f.suffix.lower() == ".png" else {},  # only PNG has embedded metadata
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


class MoveFileRequest(BaseModel):
    filename: str
    source_path: str = ""
    dest_folder: str


@router.post("/gallery/move")
async def move_gallery_file(req: MoveFileRequest):
    out = _get_output_dir()
    source = _resolve_gallery_path(out, req.source_path) / req.filename
    source = source.resolve()
    if not source.exists() or not source.is_relative_to(out.resolve()):
        raise HTTPException(status_code=404, detail="File not found")

    # Create destination folder if it doesn't exist
    dest_dir = _resolve_gallery_path(out, req.dest_folder)
    dest_dir.mkdir(parents=True, exist_ok=True)

    dest = dest_dir / req.filename
    if dest.exists():
        raise HTTPException(status_code=409, detail="File already exists in destination")

    source.rename(dest)
    return {"moved": req.filename, "to": req.dest_folder}


@router.post("/gallery/create-folder")
async def create_gallery_folder(req: MoveFileRequest):
    out = _get_output_dir()
    folder = _resolve_gallery_path(out, req.dest_folder)
    folder.mkdir(parents=True, exist_ok=True)
    return {"created": req.dest_folder}


class SettingsUpdate(BaseModel):
    output_dir: str | None = None
    local_browse_root: str | None = None


@router.get("/settings")
async def get_settings():
    settings = _load_settings()
    return {
        "output_dir": settings.get("output_dir", str(_default_output)),
        "local_browse_root": settings.get("local_browse_root", ""),
        "xai_api_configured": bool(XAI_API_KEY),
    }


@router.put("/settings")
async def update_settings(req: SettingsUpdate):
    if req.output_dir is not None:
        p = Path(req.output_dir).expanduser().resolve()
        p.mkdir(parents=True, exist_ok=True)
        _save_settings({"output_dir": str(p)})
    if req.local_browse_root is not None:
        p = Path(req.local_browse_root).expanduser().resolve()
        if not p.is_dir():
            raise HTTPException(status_code=400, detail="Directory does not exist")
        _save_settings({"local_browse_root": str(p)})
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

    # Sort all candidates by score descending
    all_candidates = sorted(score_tally.items(), key=lambda x: -x[1])

    # Boosters: highest scoring tags, voted by multiple input tags
    boosters = []
    already_used = set(input_set)
    for name, score in all_candidates:
        if name in already_used:
            continue
        if vote_count[name] >= max(1, len(input_set) // 3):
            boosters.append(_make_suggestion(name, score))
            already_used.add(name)
        if len(boosters) >= 6:
            break

    # Contrasts: different category from dominant, skip top boosters
    contrasts = []
    for name, score in all_candidates:
        if name in already_used:
            continue
        tag_cat = meta.get(name, {}).get("category")
        if dominant_category and tag_cat == dominant_category:
            continue
        contrasts.append(_make_suggestion(name, score))
        already_used.add(name)
        if len(contrasts) >= 4:
            break

    # Wildcards: random picks from remaining candidates
    remaining = [(n, s) for n, s in all_candidates if n not in already_used]
    random.shuffle(remaining)
    wildcards = [_make_suggestion(name, score) for name, score in remaining[:4]]

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

            # Scroll down to trigger lazy-loading / infinite scroll
            import asyncio
            for _ in range(8):
                prev_height = await page.evaluate("document.body.scrollHeight")
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await asyncio.sleep(1.5)
                new_height = await page.evaluate("document.body.scrollHeight")
                if new_height == prev_height:
                    break  # No more content loading

            # Scroll back to top
            await page.evaluate("window.scrollTo(0, 0)")

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

    # --- Fallback: if few images found, try Playwright for JS-rendered pages (with scroll) ---
    title = parser.title.strip()
    if len(images) < 10:
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
    """Quick check if an image contains a person using Florence-2 caption. Returns {has_person: bool}."""
    from api.florence import ensure_model_loaded, get_model_status, run_caption_only

    status = ensure_model_loaded()
    if status in ("not_started", "downloading"):
        _, progress = get_model_status()
        return {"has_person": None, "status": "downloading", "progress": progress}
    if status == "failed":
        return {"has_person": None, "status": "failed"}

    try:
        image_bytes = base64.b64decode(req.image)
        caption = run_caption_only(image_bytes).lower()
        has_person = any(kw in caption for kw in _PERSON_KEYWORDS)
        return {"has_person": has_person, "status": "ready"}
    except Exception:
        return {"has_person": None, "status": "error"}


_PERSON_KEYWORDS = frozenset([
    "woman", "women", "girl", "lady", "female",
])


class PromptAssistRequest(BaseModel):
    direction: str = ""
    mode: str  # "tags", "description", "edit", or "optimize"
    current_prompt: str = ""


@router.post("/prompt-assist")
async def prompt_assist_endpoint(req: PromptAssistRequest):
    if not XAI_API_KEY:
        raise HTTPException(status_code=503, detail="XAI_API_KEY not configured")
    if req.mode not in ("tags", "description", "edit", "optimize"):
        raise HTTPException(status_code=400, detail="Mode must be 'tags', 'description', 'edit', or 'optimize'")
    if req.mode == "optimize" and not req.current_prompt.strip():
        raise HTTPException(status_code=400, detail="Current prompt is required for optimize mode")
    if req.mode != "optimize" and not req.direction.strip():
        raise HTTPException(status_code=400, detail="Direction is required")

    from api.grok import prompt_assist
    try:
        result = await prompt_assist(XAI_API_KEY, req.direction, req.mode, req.current_prompt)
        return result
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


class PromptRefineRequest(BaseModel):
    current_prompt: str = PydanticField(min_length=1)
    image: str = PydanticField(min_length=1)  # base64
    instructions: str = ""


@router.post("/prompt-refine")
async def prompt_refine_endpoint(req: PromptRefineRequest):
    if not XAI_API_KEY:
        raise HTTPException(status_code=503, detail="XAI_API_KEY not configured")

    from api.grok import refine_prompt_with_image
    try:
        result = await refine_prompt_with_image(XAI_API_KEY, req.current_prompt, req.image, req.instructions)
        return result
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


class HasPersonBatchRequest(BaseModel):
    urls: list[str] = PydanticField(min_length=1, max_length=100)


@router.post("/explore/has-person-batch")
async def explore_has_person_batch(req: HasPersonBatchRequest):
    """Batch person detection using Florence-2 caption. Returns SSE stream with per-image progress."""
    from api.florence import ensure_model_loaded, get_model_status, run_caption_only

    status = ensure_model_loaded()
    if status in ("not_started", "downloading"):
        _, progress = get_model_status()
        raise HTTPException(status_code=202, detail=f"Model downloading: {progress}%")
    if status == "failed":
        raise HTTPException(status_code=503, detail="Florence model failed to load")

    import httpx

    async def generate_events():
        headers = {
            "User-Agent": _BROWSER_UA,
            "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
            "Referer": "",
        }
        total = len(req.urls)
        done = 0

        async with httpx.AsyncClient(timeout=_EXPLORE_TIMEOUT, follow_redirects=True, headers=headers) as client:
            for url in req.urls:
                has_person = False
                try:
                    validated = _validate_explore_url(url)
                    # Set Referer to the image's origin (some CDNs require it)
                    from urllib.parse import urlparse as _up
                    origin = f"{_up(validated).scheme}://{_up(validated).netloc}"
                    resp = await client.get(validated, headers={"Referer": origin})
                    if resp.status_code == 200 and resp.headers.get("content-type", "").startswith("image/"):
                        # Resize for speed
                        from PIL import Image as PILImage
                        img = PILImage.open(io.BytesIO(resp.content))
                        if max(img.size) > 384:
                            img.thumbnail((384, 384))
                        buf = io.BytesIO()
                        img.save(buf, format="JPEG", quality=60)

                        caption = run_caption_only(buf.getvalue()).lower()
                        has_person = any(kw in caption for kw in _PERSON_KEYWORDS)
                except Exception:
                    pass

                done += 1
                yield f"data: {json.dumps({'url': url, 'has_person': has_person, 'done': done, 'total': total})}\n\n"

        yield "data: {\"complete\": true}\n\n"

    return StreamingResponse(generate_events(), media_type="text/event-stream")


@router.get("/explore/local", response_model=LocalBrowseResponse)
async def list_local_folder(path: str = Query(default="")):
    root = _get_local_browse_root()
    current = _resolve_gallery_path(root, path)
    if not current.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")

    directories = sorted(
        (LocalBrowseItem(name=d.name) for d in current.iterdir()
         if d.is_dir() and not d.name.startswith(".")),
        key=lambda x: _natural_sort_key(x.name),
    )
    files = sorted(
        (LocalBrowseItem(name=f.name) for f in current.iterdir()
         if f.is_file() and f.suffix.lower() in _IMAGE_EXTENSIONS
         and not f.name.startswith(".")),
        key=lambda x: _natural_sort_key(x.name),
    )
    return LocalBrowseResponse(path=path, directories=directories, files=files)


@router.get("/explore/local/image")
def serve_local_image(path: str = Query(min_length=1), thumbnail: bool = False):
    root = _get_local_browse_root()
    filepath = root / path
    filepath = filepath.resolve()
    if not filepath.is_file() or not filepath.is_relative_to(root.resolve()):
        raise HTTPException(status_code=404, detail="Image not found")
    if filepath.suffix.lower() not in _IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Not a recognized image file")

    if thumbnail:
        from PIL import Image as PILImage
        try:
            img = PILImage.open(filepath)
            img.thumbnail((300, 300))
            buf = io.BytesIO()
            fmt = "JPEG" if filepath.suffix.lower() in (".jpg", ".jpeg") else "PNG"
            img.save(buf, format=fmt)
            buf.seek(0)
            media = "image/jpeg" if fmt == "JPEG" else "image/png"
            return StreamingResponse(buf, media_type=media)
        except Exception:
            raise HTTPException(status_code=500, detail="Failed to create thumbnail")

    ext = filepath.suffix.lower()
    media_map = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".tiff": "image/tiff",
    }
    return FileResponse(filepath, media_type=media_map.get(ext, "application/octet-stream"))


@router.get("/explore/local/tags", response_model=LocalTagsCacheResponse)
async def get_local_tags(path: str = Query(min_length=1)):
    root = _get_local_browse_root()
    cache_path = _get_tags_cache_path(root, path)
    data = _read_tags_cache(cache_path)
    return LocalTagsCacheResponse(**data)


@router.get("/explore/local/tags/batch", response_model=LocalTagsBatchResponse)
async def get_local_tags_batch(path: str = Query(default="")):
    root = _get_local_browse_root()
    current = _resolve_gallery_path(root, path)
    if not current.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")

    tags_dir = current / ".tags"
    analyzed: dict[str, list[str]] = {}
    if tags_dir.is_dir():
        for f in tags_dir.iterdir():
            if f.suffix == ".json" and not f.name.startswith("."):
                original_name = f.name[:-5]  # remove ".json" -> "page01.jpg"
                try:
                    data = json.loads(f.read_text(encoding="utf-8"))
                    methods = [k for k in ("wd", "florence", "grok") if k in data]
                    if methods:
                        analyzed[original_name] = methods
                except (json.JSONDecodeError, OSError):
                    pass
    return LocalTagsBatchResponse(analyzed=analyzed)


@router.post("/explore/local/analyze", response_model=LocalAnalyzeResponse)
async def analyze_local_image(req: LocalAnalyzeRequest):
    root = _get_local_browse_root()
    image_file = _resolve_gallery_path(root, req.path)
    if not image_file.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    if image_file.suffix.lower() not in _IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Not a recognized image file")

    cache_path = _get_tags_cache_path(root, req.path)

    if req.method == "wd":
        from api.tagger import ensure_model_loaded as wd_ensure, get_model_status as wd_status, run_inference as wd_inference

        status = wd_ensure()
        if status in ("not_started", "downloading"):
            _, progress = wd_status()
            raise HTTPException(status_code=202, detail=f"Model downloading: {progress}%")
        if status == "failed":
            raise HTTPException(status_code=503, detail="Tagger model failed to load")

        image_bytes = image_file.read_bytes()
        image_b64 = base64.b64encode(image_bytes).decode()
        raw_tags = wd_inference(image_b64)

        wd_data = [{"name": t["name"], "score": t["score"], "category": t["category"]} for t in raw_tags]
        _write_tags_cache(cache_path, "wd", wd_data)
        return LocalAnalyzeResponse(wd=[WdTag(**t) for t in wd_data])

    elif req.method == "florence":
        from api.florence import ensure_model_loaded, get_model_status, run_inference

        status = ensure_model_loaded()
        if status in ("not_started", "downloading"):
            _, progress = get_model_status()
            raise HTTPException(status_code=202, detail=f"Model downloading: {progress}%")
        if status == "failed":
            raise HTTPException(status_code=503, detail="Florence model failed to load")

        image_bytes = image_file.read_bytes()
        result = run_inference(image_bytes)

        florence_data = {"caption": result["caption"], "detail": result["detail"]}
        _write_tags_cache(cache_path, "florence", florence_data)
        return LocalAnalyzeResponse(florence=FlorenceAnalysis(**florence_data))

    elif req.method == "grok":
        if not XAI_API_KEY:
            raise HTTPException(status_code=503, detail="XAI_API_KEY not configured")

        from api.grok import analyze_image_vision
        from PIL import Image as PILImage

        # Resize to max 1024px to save API tokens
        img = PILImage.open(image_file)
        if max(img.size) > 1024:
            img.thumbnail((1024, 1024))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        image_b64 = base64.b64encode(buf.getvalue()).decode()

        try:
            result = await analyze_image_vision(XAI_API_KEY, image_b64)
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc))

        grok_data = {"tags": result["tags"], "description": result["description"]}
        _write_tags_cache(cache_path, "grok", grok_data)
        return LocalAnalyzeResponse(grok=GrokAnalysis(**grok_data))

    raise HTTPException(status_code=400, detail="Invalid method")
