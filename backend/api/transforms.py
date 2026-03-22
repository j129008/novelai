"""
Reversible color transformations for disguising images before sending to an
external API, then restoring the original color space on the returned video.

Forward transform: applied to the source image (base64 PNG) before upload.
Inverse transform: applied frame-by-frame to the generated MP4 via ffmpeg.

Each transform is self-contained and deterministic; no state is required
between the two calls.
"""
import base64
import io
import os
import shutil
import subprocess
import tempfile

import numpy as np
from PIL import Image

# ---------------------------------------------------------------------------
# ffmpeg availability check
# ---------------------------------------------------------------------------

_FFMPEG = shutil.which("ffmpeg")


def _require_ffmpeg() -> str:
    if _FFMPEG is None:
        raise RuntimeError(
            "ffmpeg is not installed or not on PATH. "
            "Install it (e.g. `brew install ffmpeg` on macOS) before using "
            "color_disguise transforms."
        )
    return _FFMPEG


# ---------------------------------------------------------------------------
# Transform table
# ---------------------------------------------------------------------------
#
# Each entry maps a transform ID to:
#   - "forward": a numpy index expression applied to an (H, W, 3) uint8 array
#   - "inverse_filter": the ffmpeg `lutrgb` filter string for the inverse
#
# R channel = index 0, G = 1, B = 2 in numpy (PIL loads RGB).
#
# channel_swap: R↔B — self-inverse
# invert:       255-x on every channel — self-inverse
# channel_rotate: R→G→B→R forward, so inverse is R→B→G→R (reverse rotation)

_TRANSFORMS: dict[str, dict] = {
    "channel_swap": {
        "forward": [2, 1, 0],          # swap R and B
        "inverse_filter": "colorchannelmixer=rr=0:rb=1:gg=1:br=1:bb=0",
    },
    "invert": {
        "forward": "invert",           # special-cased: 255 - arr
        "inverse_filter": "lutrgb=r=255-val:g=255-val:b=255-val",
    },
    "channel_rotate": {
        "forward": [2, 0, 1],          # R→G, G→B, B→R
        # Inverse: new_R=old_G, new_G=old_B, new_B=old_R
        "inverse_filter": "colorchannelmixer=rr=0:rg=1:rb=0:gr=0:gg=0:gb=1:br=1:bg=0:bb=0",
    },
    "negate_rg": {
        "forward": "negate_rg",        # invert R and G, keep B — makes skin tones alien
        "inverse_filter": "lutrgb=r=255-val:g=255-val",  # self-inverse
    },
    "scramble": {
        "forward": "scramble",         # channel rotate + invert all — very unrecognizable
        # Inverse: invert then reverse-rotate (R=G, G=B, B=R)
        "inverse_filter": "lutrgb=r=255-val:g=255-val:b=255-val,colorchannelmixer=rr=0:rg=1:rb=0:gr=0:gg=0:gb=1:br=1:bg=0:bb=0",
    },
}


def _validate_transform(transform: str) -> dict:
    if transform not in _TRANSFORMS:
        valid = ", ".join(f'"{k}"' for k in _TRANSFORMS)
        raise ValueError(f"Unknown transform {transform!r}. Valid values: {valid}")
    return _TRANSFORMS[transform]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def apply_image_transform(image_b64: str, transform: str) -> str:
    """Apply a forward color transform to a base64-encoded PNG image.

    Returns a base64-encoded PNG with the transform applied.
    """
    spec = _validate_transform(transform)

    image_bytes = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    arr = np.array(img, dtype=np.uint8)

    fwd = spec["forward"]
    if fwd == "invert":
        transformed = (255 - arr).astype(np.uint8)
    elif fwd == "negate_rg":
        # Invert R and G channels, keep B
        transformed = arr.copy()
        transformed[:, :, 0] = 255 - arr[:, :, 0]
        transformed[:, :, 1] = 255 - arr[:, :, 1]
    elif fwd == "scramble":
        # Channel rotate (R→G, G→B, B→R) then invert all
        transformed = (255 - arr[:, :, [2, 0, 1]]).astype(np.uint8)
    else:
        transformed = arr[:, :, fwd].astype(np.uint8)

    out_img = Image.fromarray(transformed, mode="RGB")
    buf = io.BytesIO()
    out_img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def apply_video_transform(video_bytes: bytes, transform: str) -> bytes:
    """Apply the inverse color transform to every frame of an MP4.

    Uses ffmpeg with a lutrgb filter. Audio is copied without re-encoding.
    Returns the transformed video as MP4 bytes.
    """
    spec = _validate_transform(transform)
    ffmpeg = _require_ffmpeg()

    inv = spec["inverse_filter"]
    filter_expr = inv

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp_in:
        tmp_in.write(video_bytes)
        input_path = tmp_in.name

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp_out:
        output_path = tmp_out.name

    try:
        result = subprocess.run(
            [
                ffmpeg,
                "-i", input_path,
                "-vf", filter_expr,
                "-c:a", "copy",
                output_path,
                "-y",
            ],
            capture_output=True,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode(errors="replace")
            raise RuntimeError(
                f"ffmpeg failed (exit {result.returncode}): {stderr[-500:]}"
            )
        with open(output_path, "rb") as f:
            return f.read()
    finally:
        for path in (input_path, output_path):
            try:
                os.unlink(path)
            except OSError:
                pass
