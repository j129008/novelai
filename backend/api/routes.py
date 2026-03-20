import base64
import csv
import io
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from models.schemas import (
    AnalyzeImageRequest,
    AnalyzeImageResponse,
    AnalyzedTag,
    CharacterUsage,
    CharacterUsageList,
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
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Grok API error: {e}")

    timestamp = int(time.time())
    filename = f"{timestamp}-grok.mp4"
    filepath = _get_output_dir() / filename
    filepath.write_bytes(video_data)

    return GrokVideoResponse(video=base64.b64encode(video_data).decode())


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
