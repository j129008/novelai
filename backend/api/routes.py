import base64
import csv
import json
import os
import subprocess
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from models.schemas import GenerateRequest, GenerateResponse
from api.novelai import generate_image

router = APIRouter(prefix="/api")

TOKEN = os.getenv("NOVELAI_TOKEN", "")

# Settings file for persistent config
_settings_file = Path(__file__).resolve().parent.parent.parent / ".app-settings.json"
_default_output = Path(__file__).resolve().parent.parent.parent / "output"


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
    }


@router.get("/tags")
async def search_tags(q: str = Query(min_length=1), limit: int = Query(default=15, le=30)):
    query = q.lower().replace(" ", "_")
    results = []
    for tag in _tags:
        if len(results) >= limit:
            break
        if tag["name"].startswith(query) or query in tag["aliases"].lower():
            results.append(tag)
    # If not enough prefix matches, do substring search
    if len(results) < limit:
        seen = {r["name"] for r in results}
        for tag in _tags:
            if len(results) >= limit:
                break
            if tag["name"] not in seen and query in tag["name"]:
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
            image=req.image,
            strength=req.strength,
            noise=req.noise,
            reference_image=req.reference_image,
            reference_information_extracted=req.reference_information_extracted,
            reference_strength=req.reference_strength,
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


def _read_png_meta(filepath: Path) -> dict:
    try:
        from PIL import Image
        img = Image.open(filepath)
        if "Comment" in img.info:
            import json as _json
            meta = _json.loads(img.info["Comment"])
            return {
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
    except Exception:
        pass
    return {}


@router.get("/gallery")
async def list_gallery():
    out = _get_output_dir()
    files = sorted(out.glob("*.png"), key=lambda f: f.stat().st_mtime, reverse=True)
    results = []
    for f in files:
        item = {"name": f.name, "size": f.stat().st_size}
        meta = _read_png_meta(f)
        if meta:
            item["meta"] = meta
        results.append(item)
    return results


@router.get("/gallery/{filename}")
async def get_gallery_image(filename: str):
    out = _get_output_dir()
    filepath = out / filename
    if not filepath.exists() or not filepath.is_relative_to(out):
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(filepath, media_type="image/png")


@router.delete("/gallery/{filename}")
async def delete_gallery_image(filename: str):
    out = _get_output_dir()
    filepath = out / filename
    if not filepath.exists() or not filepath.is_relative_to(out):
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
    subprocess.Popen(["open", str(out)])
    return {"opened": str(out)}
