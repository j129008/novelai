import base64 as _b64
import httpx
import io
import random
import zipfile
from PIL import Image, ImageFilter
from typing import Optional

API_URL = "https://image.novelai.net/ai/generate-image"


def _restore_outside_mask(orig_b64: str, result_bytes: bytes, mask_b64: str) -> bytes:
    """Paste original pixels back outside the mask. Inside mask = API result."""
    import numpy as np
    orig_img = Image.open(io.BytesIO(_b64.b64decode(orig_b64))).convert("RGB")
    result_img = Image.open(io.BytesIO(result_bytes)).convert("RGB")
    mask_img = Image.open(io.BytesIO(_b64.b64decode(mask_b64))).convert("L")
    print(f"[inpaint] orig={orig_img.size} mode={orig_img.mode}, result={result_img.size} mode={result_img.mode}, mask={mask_img.size}")
    print(f"[inpaint] mask white={np.sum(np.array(mask_img) > 128)}, black={np.sum(np.array(mask_img) <= 128)}")
    # Debug: save before/after to compare
    orig_arr = np.array(orig_img)
    result_arr = np.array(result_img)
    mask_arr = np.array(mask_img)
    outside = mask_arr <= 128
    diff_outside = np.abs(orig_arr[outside].astype(float) - result_arr[outside].astype(float))
    print(f"[inpaint] API result outside-mask diff: mean={diff_outside.mean():.2f}, max={diff_outside.max():.0f}")
    final = np.where(mask_arr[:, :, np.newaxis] > 128, result_arr, orig_arr)
    diff_final = np.abs(orig_arr[outside].astype(float) - final[outside].astype(float))
    print(f"[inpaint] After restore outside-mask diff: mean={diff_final.mean():.4f}, max={diff_final.max():.0f}")

    orig_arr = np.array(orig_img)
    result_arr = np.array(result_img)
    mask_arr = np.array(mask_img)

    # Hard composite: outside=original, inside=API result
    hard = np.where(mask_arr[:, :, np.newaxis] > 128, result_arr, orig_arr)

    # Tiny feather at boundary only: 3px Gaussian blend at the mask edge
    # to smooth the content transition. Does NOT change interior or exterior.
    mask_float = mask_arr.astype(np.float32) / 255.0
    blurred_mask = np.array(
        Image.fromarray(mask_arr).filter(ImageFilter.GaussianBlur(3))
    ).astype(np.float32) / 255.0
    # Only blend where blurred differs from hard mask (the boundary band)
    blend = orig_arr.astype(np.float32) * (1 - blurred_mask[:, :, np.newaxis]) + \
            result_arr.astype(np.float32) * blurred_mask[:, :, np.newaxis]
    # Use hard composite everywhere EXCEPT the thin boundary band
    is_boundary = (blurred_mask > 0.01) & (blurred_mask < 0.99)
    final = hard.copy()
    final[is_boundary] = np.clip(blend[is_boundary], 0, 255).astype(np.uint8)

    out = Image.fromarray(final.astype(np.uint8), mode="RGB")
    buf = io.BytesIO()
    out.save(buf, "PNG")
    return buf.getvalue()


# V4+ models require v4_prompt/v4_negative_prompt structure
V4_MODELS = {
    "nai-diffusion-4-curated-preview",
    "nai-diffusion-4-full",
    "nai-diffusion-4-5-curated",
    "nai-diffusion-4-5-full",
}

# Model name mapping for inpainting
INPAINTING_MODELS = {
    "nai-diffusion-4-5-full": "nai-diffusion-4-5-full-inpainting",
}


async def generate_image(
    token: str,
    prompt: str,
    negative_prompt: str = "",
    model: str = "nai-diffusion-4-5-full",
    action: str = "generate",
    width: int = 832,
    height: int = 1216,
    steps: int = 28,
    scale: float = 5.0,
    sampler: str = "k_euler_ancestral",
    seed: int = 0,
    sm: bool = False,
    sm_dyn: bool = False,
    image: Optional[str] = None,
    mask: Optional[str] = None,
    strength: float = 0.7,
    noise: float = 0.0,
    reference_image: Optional[str] = None,
    reference_information_extracted: float = 1.0,
    reference_strength: float = 0.6,
) -> tuple[bytes, int]:
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
        "cfg_rescale": 0,
        "noise_schedule": "karras",
        "uncond_scale": 0.0,
        "prefer_brownian": True,
        "uncond_per_vibe": True,
    }

    # V4+ models require v4_prompt and v4_negative_prompt caption structures
    if model in V4_MODELS:
        params["v4_prompt"] = {
            "caption": {
                "base_caption": prompt,
                "char_captions": [],
            },
            "use_coords": False,
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

    _inpaint_orig_b64 = None
    _inpaint_mask_b64 = None
    if action == "infill" and image and mask:
        params["image"] = image
        params["mask"] = mask
        params["strength"] = strength
        params["add_original_image"] = True
        params["inpaintImg2ImgStrength"] = 1
        params["uncond_scale"] = 1
        _inpaint_orig_b64 = image
        _inpaint_mask_b64 = mask
    elif action == "img2img" and image:
        params["image"] = image
        params["strength"] = strength
        params["noise"] = noise

    if reference_image:
        params["reference_image"] = reference_image
        params["reference_information_extracted"] = reference_information_extracted
        params["reference_strength"] = reference_strength

    # Use inpainting-specific model for infill action
    api_model = INPAINTING_MODELS.get(model, model + "-inpainting") if action == "infill" else model

    payload = {
        "input": prompt,
        "model": api_model,
        "action": action,
        "parameters": params,
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            API_URL,
            json=payload,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        if resp.status_code != 200:
            raise RuntimeError(f"{resp.status_code}: {resp.text[:500]}")

        # Response is a zip containing the image
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            name = zf.namelist()[0]
            image_data = zf.read(name)

    # Restore original pixels outside mask — guarantees no background changes
    if _inpaint_orig_b64 and _inpaint_mask_b64:
        image_data = _restore_outside_mask(_inpaint_orig_b64, image_data, _inpaint_mask_b64)

    return image_data, seed
