"""
NovelAI API client.

Responsible for constructing the generate-image payload and returning raw PNG bytes.

V4+ payload structure
---------------------
V4 and V4.5 models (those in V4_MODELS) require two additional top-level fields inside
the ``parameters`` dict beyond the legacy fields that earlier models used:

``v4_prompt``
    Wraps the positive prompt in a caption structure that supports per-character prompts
    and spatial coordinates.  ``base_caption`` carries the main prompt text.
    ``char_captions`` carries per-character prompts when the Multi-Character Composer UI
    supplies them; it is an empty list for single-character or pipe-syntax requests.
    ``use_coords`` is ``True`` only when any character has non-default coordinates.
    ``use_order`` is ``True`` so tag order affects emphasis.

``v4_negative_prompt``
    Same structure for the negative prompt.  ``use_order`` is ``False`` here, matching
    NovelAI's own web app behavior for undesired content.

The legacy ``uc`` key is also kept alongside ``negative_prompt`` for API compatibility;
older model versions and some server-side paths still read ``uc``.

The NovelAI API response is a ZIP archive containing a single PNG file.  The seed used
for generation is tracked locally and returned alongside the image bytes so callers can
embed it in the saved filename and in the response to the browser.
"""
import base64
import httpx
import io
import random
import zipfile
from typing import Optional

import numpy as np
from PIL import Image, ImageFilter

from models.schemas import CharCaption, CharCenter

API_URL = "https://image.novelai.net/ai/generate-image"

# V4+ models require v4_prompt/v4_negative_prompt structure
V4_MODELS = {
    "nai-diffusion-4-curated-preview",
    "nai-diffusion-4-full",
    "nai-diffusion-4-5-curated",
    "nai-diffusion-4-5-full",
}


async def generate_image(
    token: str,
    prompt: str,
    negative_prompt: str = "",
    model: str = "nai-diffusion-4-5-full",
    action: str = "generate",
    width: int = 832,
    height: int = 1216,
    steps: int = 23,
    scale: float = 5.0,
    sampler: str = "k_euler_ancestral",
    seed: int = 0,
    sm: bool = False,
    sm_dyn: bool = False,
    noise_schedule: str = "karras",
    cfg_rescale: float = 0.0,
    image: Optional[str] = None,
    strength: float = 0.7,
    noise: float = 0.0,
    char_captions: Optional[list[CharCaption]] = None,
    use_coords: Optional[bool] = None,
    mask: Optional[str] = None,
) -> tuple[bytes, int]:
    if char_captions is None:
        char_captions = []
    if seed == 0:
        seed = random.randint(1, 0xFFFFFFFF)

    params = {
        "width": width,
        "height": height,
        "steps": steps,
        "scale": scale,
        "sampler": sampler,
        "seed": seed,
        "n_samples": 1,
        "sm": sm,
        "sm_dyn": sm_dyn,
        # NovelAI API requires both fields: "uc" is the legacy key, "negative_prompt" is v4+
        "negative_prompt": negative_prompt,
        "uc": negative_prompt,
        "qualityToggle": True,
        "dynamic_thresholding": False,
        "cfg_rescale": cfg_rescale,
        "noise_schedule": noise_schedule,
        "uncond_scale": 0.0,
        "prefer_brownian": True,
    }

    # V4+ models require v4_prompt and v4_negative_prompt caption structures
    if model in V4_MODELS:
        if use_coords is not None:
            _use_coords = use_coords
        else:
            _default_center = CharCenter()
            _use_coords = any(
                caption.centers != [_default_center]
                for caption in char_captions
            )
        params["v4_prompt"] = {
            "caption": {
                "base_caption": prompt,
                "char_captions": [
                    {"char_caption": c.char_caption, "centers": [{"x": p.x, "y": p.y} for p in c.centers]}
                    for c in char_captions
                ],
            },
            "use_coords": _use_coords,
            "use_order": True,
            "legacy_uc": False,
        }
        params["v4_negative_prompt"] = {
            "caption": {
                "base_caption": negative_prompt,
                "char_captions": [],
            },
            "use_coords": False,
            "use_order": False,
            "legacy_uc": False,
        }
        params["characterPrompts"] = []

    if mask:
        # img2img with mask + server-side compositing.
        # The model regenerates the full image; we composite the original
        # pixels back in non-masked areas for a seamless result.
        action = "img2img"
        _src_img = Image.open(io.BytesIO(base64.b64decode(image))).convert("RGB")
        _mask_img = Image.open(io.BytesIO(base64.b64decode(mask))).convert("L")
        if _mask_img.size != _src_img.size:
            _mask_img = _mask_img.resize(_src_img.size, Image.NEAREST)
            _mbuf = io.BytesIO()
            _mask_img.save(_mbuf, format="PNG")
            mask = base64.b64encode(_mbuf.getvalue()).decode()
        params["image"] = image
        params["mask"] = mask
        params["strength"] = strength
        params["noise"] = noise
        params["add_original_image"] = False
        params["sm"] = False
        params["sm_dyn"] = False
    elif action == "img2img" and image:
        params["image"] = image
        params["strength"] = strength
        params["noise"] = noise

    payload = {
        "input": prompt,
        "model": model,
        "action": action,
        "parameters": params,
    }

    import asyncio as _asyncio

    async with httpx.AsyncClient(timeout=120.0) as client:
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        for _attempt in range(6):
            resp = await client.post(API_URL, json=payload, headers=headers)
            if resp.status_code == 429 and _attempt < 5:
                await _asyncio.sleep(5)
                continue
            break
        if resp.status_code != 200:
            raise RuntimeError(f"{resp.status_code}: {resp.text[:500]}")

        # Response is a zip containing the image
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            name = zf.namelist()[0]
            image_data = zf.read(name)

    # Inpaint compositing: paste original pixels back in non-masked areas
    if mask and image:
        original = Image.open(io.BytesIO(base64.b64decode(image))).convert("RGB")
        generated = Image.open(io.BytesIO(image_data)).convert("RGB")
        comp_mask = Image.open(io.BytesIO(base64.b64decode(mask))).convert("L")

        if comp_mask.size != original.size:
            comp_mask = comp_mask.resize(original.size, Image.NEAREST)
        if generated.size != original.size:
            generated = generated.resize(original.size, Image.LANCZOS)

        comp_mask = comp_mask.filter(ImageFilter.GaussianBlur(radius=8))
        result = Image.composite(generated, original, comp_mask)
        out_buf = io.BytesIO()
        result.save(out_buf, format="PNG")
        image_data = out_buf.getvalue()

    return image_data, seed
