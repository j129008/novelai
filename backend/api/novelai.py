import base64 as _b64
import httpx
import io
import numpy as np
import random
import zipfile
from PIL import Image, ImageFilter
from typing import Optional

API_URL = "https://image.novelai.net/ai/generate-image"


def _feather_mask(mask_b64: str, blur_radius: int = 20) -> tuple[str, np.ndarray]:
    """Feather mask edges with Gaussian blur.

    Returns:
        (api_mask_b64, compositing_mask_float32)

    Two distinct masks:
    - api_mask_b64: clamped so the interior stays fully white; gives the model
      a solid region to fill with soft edges to guide context.
    - compositing_mask_float32: normalized Gaussian blur (0.0 outside, 1.0 at
      center) used for post-process alpha compositing. No hard step at the
      boundary -- pure smooth gradient.
    """
    mask_bytes = _b64.b64decode(mask_b64)
    mask_img = Image.open(io.BytesIO(mask_bytes)).convert("L")
    sharp = np.array(mask_img)

    blurred = np.array(mask_img.filter(ImageFilter.GaussianBlur(blur_radius))).astype(np.float32)

    # API mask: dilate the user's mask so the API's seam artifact falls
    # OUTSIDE our composite mask's transition zone. The seam gets covered
    # by original pixels during compositing.
    dilate_size = blur_radius * 2 + 1
    if dilate_size % 2 == 0:
        dilate_size += 1
    dilated = mask_img.filter(ImageFilter.MaxFilter(dilate_size))
    buf = io.BytesIO()
    dilated.save(buf, "PNG")
    api_mask_b64 = _b64.b64encode(buf.getvalue()).decode()

    # Compositing mask based on the DILATED mask (same as what API receives)
    # This way our blend zone aligns with the API's seam location
    from scipy.ndimage import distance_transform_edt
    dilated_arr = np.array(dilated)
    dilated_bool = dilated_arr > 128
    dist_outside = distance_transform_edt(~dilated_bool)
    dist_inside = distance_transform_edt(dilated_bool)
    signed_dist = dist_outside - dist_inside
    steepness = 6.0 / blur_radius
    composite_mask = 1.0 / (1.0 + np.exp(signed_dist * steepness))
    composite_mask = composite_mask.astype(np.float32)

    return api_mask_b64, composite_mask


def _composite_inpaint(
    orig_b64: str,
    api_result_bytes: bytes,
    mask_float: np.ndarray,
) -> bytes:
    """Alpha-blend API result over original using the feathered mask.

    final = orig * (1 - mask) + result * mask

    The mask is a smooth Gaussian gradient so there is no hard discontinuity
    at the boundary. Outside the mask is mathematically exactly the original.
    Inside at the center is mathematically exactly the API result.
    The boundary zone is a smooth blend.
    """
    orig_img = Image.open(io.BytesIO(_b64.b64decode(orig_b64))).convert("RGB")
    result_img = Image.open(io.BytesIO(api_result_bytes)).convert("RGB")

    # Resize result to match original in case of any dimension mismatch.
    if result_img.size != orig_img.size:
        result_img = result_img.resize(orig_img.size, Image.LANCZOS)

    # Resize mask to match image dimensions if needed.
    h, w = orig_img.height, orig_img.width
    if mask_float.shape != (h, w):
        mask_pil = Image.fromarray(
            (mask_float * 255).astype(np.uint8), mode="L"
        ).resize((w, h), Image.LANCZOS)
        mask_float = np.array(mask_pil).astype(np.float32) / 255.0

    orig_arr = np.array(orig_img).astype(np.float32)
    result_arr = np.array(result_img).astype(np.float32)

    # Expand mask from (H, W) to (H, W, 3) for broadcasting.
    m = mask_float[:, :, np.newaxis]

    composited = orig_arr * (1.0 - m) + result_arr * m
    composited = np.clip(composited, 0, 255).astype(np.uint8)

    out_img = Image.fromarray(composited, mode="RGB")
    buf = io.BytesIO()
    out_img.save(buf, "PNG")
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

    # Track data needed for post-process compositing.
    _orig_image_b64: Optional[str] = None
    _composite_mask: Optional[np.ndarray] = None

    if action == "infill" and image and mask:
        api_mask_b64, composite_mask = _feather_mask(mask, blur_radius=20)
        params["image"] = image
        params["mask"] = api_mask_b64
        params["strength"] = strength
        params["add_original_image"] = True
        params["inpaintImg2ImgStrength"] = 1
        params["uncond_scale"] = 1
        _orig_image_b64 = image
        _composite_mask = composite_mask
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

    # Post-process: composite API result over original using smooth feathered mask.
    # final = orig * (1 - mask) + result * mask
    # This mathematically eliminates the seam the API leaves at mask boundaries.
    if _orig_image_b64 is not None and _composite_mask is not None:
        image_data = _composite_inpaint(_orig_image_b64, image_data, _composite_mask)

    return image_data, seed
