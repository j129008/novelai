import base64
import csv
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from models.schemas import GenerateRequest, GenerateResponse
from api.novelai import generate_image

router = APIRouter(prefix="/api")

TOKEN = os.getenv("NOVELAI_TOKEN", "")

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

    return GenerateResponse(
        image=base64.b64encode(image_data).decode(),
        seed=seed,
    )
