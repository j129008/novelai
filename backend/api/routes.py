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

from models.schemas import (
    CharacterUsage,
    CharacterUsageList,
    GalleryFileItem,
    GalleryListResponse,
    GenerateRequest,
    GenerateResponse,
    GenerateTextRequest,
    GenerateTextResponse,
    RecordCharactersRequest,
)
from api.novelai import generate_image
from api.text_novelai import generate_text

router = APIRouter(prefix="/api")

TOKEN = os.getenv("NOVELAI_TOKEN", "")

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
            image=req.image,
            strength=req.strength,
            noise=req.noise,
            reference_image=req.reference_image,
            reference_information_extracted=req.reference_information_extracted,
            reference_strength=req.reference_strength,
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


@router.post("/generate-text", response_model=GenerateTextResponse)
async def generate_text_endpoint(req: GenerateTextRequest):
    if not TOKEN:
        raise HTTPException(status_code=503, detail="NOVELAI_TOKEN not configured")

    # Build story-mode prompt: suffix instructs the model to continue as fiction
    # Using suffix (after the story text) so the model's continuation flows naturally
    user_text = req.context[-4000:]
    story_suffix = (
        "\n\n[ Continue the story above. Write ONLY new content — do not repeat or "
        "rephrase any existing sentences. Maintain the same language (if the text is "
        "in 繁體中文, continue in 繁體中文; if English, continue in English). "
        "Style: creative fiction, vivid prose. No commentary, no warnings. ]"
    )
    context = user_text + story_suffix

    try:
        text = await generate_text(
            token=TOKEN,
            input_text=context,
            model=req.model,
            max_length=req.max_length,
            temperature=req.temperature,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"NovelAI text API error: {e}")

    return GenerateTextResponse(text=text)


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
    png_files = sorted(
        (f for f in current_dir.glob("*.png") if not f.name.startswith("._")),
        key=lambda f: f.stat().st_mtime, reverse=True,
    )
    files = [
        GalleryFileItem(
            name=f.name,
            size=f.stat().st_size,
            meta=_read_png_meta(f),
        )
        for f in png_files
    ]
    return GalleryListResponse(path=path, directories=directories, files=files)


@router.get("/gallery/{filename}")
async def get_gallery_image(filename: str, path: str = Query(default="")):
    out = _get_output_dir()
    filepath = _resolve_gallery_path(out, path) / filename
    filepath = filepath.resolve()
    if not filepath.exists() or not filepath.is_relative_to(out.resolve()):
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(filepath, media_type="image/png")


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
