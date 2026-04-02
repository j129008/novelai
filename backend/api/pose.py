"""Pose mannequin rendering — filled skin-colored silhouette via Pillow.

Renders a mannequin-style body silhouette suitable for NovelAI img2img.
Unlike OpenPose stick figures, this produces filled shapes that img2img
can interpret as a concrete human body.
"""
import io
import math

from PIL import Image, ImageDraw

BACKGROUND_COLOR = (255, 255, 255)  # white — maximum contrast for img2img

SKIN_TONES = {
    "light": (255, 219, 172),
    "dark": (141, 85, 36),
}

# Dark outline color for body definition (helps img2img recognize the shape)
OUTLINE_COLOR = (80, 60, 40)

# Limbs drawn back-to-front: (joint_a, joint_b, width_factor)
# width_factor is relative to torso_height (neck→hip midpoint distance)
# for a realistic mannequin look
BODY_PARTS_DRAW_ORDER = [
    ("right_hip", "right_knee", 0.14),     # right thigh
    ("right_knee", "right_ankle", 0.11),   # right calf
    ("left_hip", "left_knee", 0.14),       # left thigh
    ("left_knee", "left_ankle", 0.11),     # left calf
    ("right_shoulder", "right_elbow", 0.10),  # right upper arm
    ("right_elbow", "right_wrist", 0.08),     # right forearm
    ("left_shoulder", "left_elbow", 0.10),    # left upper arm
    ("left_elbow", "left_wrist", 0.08),       # left forearm
]


def _clamp(v: float) -> float:
    return max(0.0, min(1.0, v))


def _dist(p1, p2):
    return math.hypot(p2[0] - p1[0], p2[1] - p1[1])


def draw_capsule(draw: ImageDraw.ImageDraw, p1: tuple, p2: tuple, width: float, color: tuple, outline: tuple = None) -> None:
    """Draw a filled capsule (rounded rectangle) between two points."""
    x1, y1 = p1
    x2, y2 = p2
    angle = math.atan2(y2 - y1, x2 - x1)
    half_w = width / 2

    dx = half_w * math.sin(angle)
    dy = half_w * math.cos(angle)

    corners = [
        (x1 - dx, y1 + dy),
        (x1 + dx, y1 - dy),
        (x2 + dx, y2 - dy),
        (x2 - dx, y2 + dy),
    ]
    draw.polygon(corners, fill=color, outline=outline)
    draw.ellipse([x1 - half_w, y1 - half_w, x1 + half_w, y1 + half_w], fill=color, outline=outline)
    draw.ellipse([x2 - half_w, y2 - half_w, x2 + half_w, y2 + half_w], fill=color, outline=outline)


def draw_torso(draw: ImageDraw.ImageDraw, pixel: dict, body_type: str, color: tuple, torso_h: float, outline: tuple = None) -> None:
    """Draw the torso as a filled polygon with realistic proportions.

    Male:   inverted trapezoid — shoulders wider, hips narrower.
    Female: hourglass — waist indented inward at midpoint.
    Child:  same as male.
    """
    ls = pixel.get("left_shoulder")
    rs = pixel.get("right_shoulder")
    lh = pixel.get("left_hip")
    rh = pixel.get("right_hip")
    if not all([ls, rs, lh, rh]):
        return

    # Widen shoulders and hips outward for a more substantial torso
    shoulder_expand = torso_h * 0.12
    hip_expand = torso_h * 0.06

    # Expanded shoulder points
    ls_ex = (ls[0] + shoulder_expand, ls[1])
    rs_ex = (rs[0] - shoulder_expand, rs[1])
    # Expanded hip points
    lh_ex = (lh[0] + hip_expand, lh[1])
    rh_ex = (rh[0] - hip_expand, rh[1])

    if body_type == "female":
        # Hourglass: waist indented 20% inward
        lm = ((ls_ex[0] + lh_ex[0]) / 2, (ls_ex[1] + lh_ex[1]) / 2)
        rm = ((rs_ex[0] + rh_ex[0]) / 2, (rs_ex[1] + rh_ex[1]) / 2)
        waist_dx = rm[0] - lm[0]
        waist_dy = rm[1] - lm[1]
        indent = 0.20
        lw = (lm[0] + waist_dx * indent, lm[1] + waist_dy * indent)
        rw = (rm[0] - waist_dx * indent, rm[1] - waist_dy * indent)
        # Wider hips for female
        lh_f = (lh_ex[0] + hip_expand * 0.8, lh_ex[1])
        rh_f = (rh_ex[0] - hip_expand * 0.8, rh_ex[1])
        polygon = [ls_ex, rs_ex, rw, rh_f, lh_f, lw]
    else:
        # Male / child: inverted trapezoid — shoulders wider than hips
        polygon = [ls_ex, rs_ex, rh_ex, lh_ex]

    draw.polygon(polygon, fill=color, outline=outline)


def draw_head(draw: ImageDraw.ImageDraw, pixel: dict, torso_h: float, color: tuple, outline: tuple = None) -> None:
    """Draw head as an ellipse at nose position, with a neck capsule."""
    nose = pixel.get("nose")
    neck = pixel.get("neck")
    if nose is None:
        return

    radius = torso_h * 0.22
    rx = radius * 0.85
    ry = radius
    draw.ellipse(
        [nose[0] - rx, nose[1] - ry, nose[0] + rx, nose[1] + ry],
        fill=color, outline=outline,
    )

    if neck is not None:
        neck_width = torso_h * 0.08
        draw_capsule(draw, nose, neck, neck_width, color, outline=outline)


def render_pose_image(figures, width: int, height: int) -> bytes:
    """Render a mannequin-style filled silhouette and return PNG bytes.

    Uses RGBA with transparent background so it composites cleanly over
    layer images without washing out their colors.
    """
    img = Image.new("RGBA", (width, height), color=(0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    for figure in figures:
        joints = figure.joints
        joint_map = joints.model_dump()

        skin_tone = getattr(figure, "skin_tone", "light")
        color = SKIN_TONES.get(skin_tone, SKIN_TONES["light"])
        # Add full alpha for RGBA
        fill = color + (255,)
        body_type = getattr(figure, "body_type", "male")

        pixel = {
            name: (int(_clamp(coords[0]) * width), int(_clamp(coords[1]) * height))
            for name, coords in joint_map.items()
        }

        neck = pixel.get("neck")
        lh = pixel.get("left_hip")
        rh = pixel.get("right_hip")
        if neck and lh and rh:
            hip_mid = ((lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2)
            torso_h = _dist(neck, hip_mid)
        else:
            torso_h = height * 0.35

        # Clean body shapes only — no joint circles, no outline (those are for canvas UI)
        # 1. Torso
        draw_torso(draw, pixel, body_type, fill, torso_h)

        # 2. Limbs
        for joint_a, joint_b, width_factor in BODY_PARTS_DRAW_ORDER:
            p1 = pixel.get(joint_a)
            p2 = pixel.get(joint_b)
            if p1 and p2:
                limb_width = torso_h * width_factor
                draw_capsule(draw, p1, p2, limb_width, fill)

        # 3. Head + neck
        draw_head(draw, pixel, torso_h, fill)

    # For pose-only (no layer images), flatten to RGB with white background.
    # For compositing over layers, the frontend will handle the RGBA directly.
    # Always output RGBA so the frontend can choose.
    bg = img  # keep RGBA

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
