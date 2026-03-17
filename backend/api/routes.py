import base64
import os

from fastapi import APIRouter, HTTPException

from models.schemas import GenerateRequest, GenerateResponse
from api.novelai import generate_image

router = APIRouter(prefix="/api")

TOKEN = os.getenv("NOVELAI_TOKEN", "")

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
