"""
xAI Grok API client.

Provides two async functions for image and video generation via the Grok API.
Image generation returns raw image bytes synchronously (single request).
Video generation is asynchronous: submit a job, poll until done, download the result.
"""
import asyncio
import base64
import json

import httpx

IMAGE_URL = "https://api.x.ai/v1/images/generations"
IMAGE_EDIT_URL = "https://api.x.ai/v1/images/edits"
VIDEO_SUBMIT_URL = "https://api.x.ai/v1/videos/generations"
VIDEO_STATUS_URL = "https://api.x.ai/v1/videos/{request_id}"

_POLL_INTERVAL = 3   # seconds between status checks
_POLL_MAX = 100      # 100 × 3s = 5 minutes max


async def generate_image(
    api_key: str,
    prompt: str,
    aspect_ratio: str = "1:1",
    resolution: str = "1k",
    model: str = "grok-imagine-image",
    images: list[str] | None = None,
) -> bytes:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    if images:
        # Image editing mode — use /v1/images/edits
        payload: dict = {
            "model": model,
            "prompt": prompt,
            "response_format": "b64_json",
            "n": 1,
        }
        if len(images) == 1:
            # Single image: use singular "image" key for backward compatibility
            payload["image"] = {
                "url": f"data:image/png;base64,{images[0]}",
                "type": "image_url",
            }
        else:
            # Multiple images: use "images" array format
            payload["images"] = [
                {"url": f"data:image/png;base64,{img}", "type": "image_url"}
                for img in images
            ]
        url = IMAGE_EDIT_URL
    else:
        # Text-to-image generation — "auto" is not valid for generation
        payload = {
            "model": model,
            "prompt": prompt,
            "resolution": resolution,
            "response_format": "b64_json",
            "n": 1,
        }
        if aspect_ratio and aspect_ratio != "auto":
            payload["aspect_ratio"] = aspect_ratio
        url = IMAGE_URL

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"{resp.status_code}: {resp.text[:500]}")
        b64 = resp.json()["data"][0]["b64_json"]
    return base64.b64decode(b64)


async def generate_video(
    api_key: str,
    prompt: str,
    aspect_ratio: str = "1:1",
    resolution: str = "720p",
    duration: int = 5,
    image: str | None = None,
    on_progress=None,
) -> bytes:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    submit_payload = {
        "model": "grok-imagine-video",
        "prompt": prompt,
        "resolution": resolution,
        "duration": duration,
    }
    if aspect_ratio and aspect_ratio != "auto":
        submit_payload["aspect_ratio"] = aspect_ratio
    if image:
        submit_payload["image"] = {"url": f"data:image/png;base64,{image}"}
    import logging
    logger = logging.getLogger("grok")
    logger.info(f"[grok video] payload keys: {list(submit_payload.keys())}, has image_url: {'image_url' in submit_payload}")
    async with httpx.AsyncClient(timeout=120.0) as client:
        # Step 1: submit the generation job
        resp = await client.post(VIDEO_SUBMIT_URL, json=submit_payload, headers=headers)
        logger.info(f"[grok video] submit response: {resp.status_code} {resp.text[:300]}")
        if resp.status_code not in (200, 201, 202):
            # Try to extract a readable error message
            try:
                err_data = resp.json()
                err_msg = err_data.get("error", resp.text[:500])
            except Exception:
                err_msg = resp.text[:500]
            raise RuntimeError(err_msg)
        request_id = resp.json()["request_id"]

        # Step 2: poll until done or failed
        status_url = VIDEO_STATUS_URL.format(request_id=request_id)
        for _ in range(_POLL_MAX):
            await asyncio.sleep(_POLL_INTERVAL)
            poll = await client.get(status_url, headers=headers)
            if poll.status_code not in (200, 202):
                raise RuntimeError(f"{poll.status_code}: {poll.text[:500]}")
            data = poll.json()
            status = data.get("status")
            progress = data.get("progress", 0)
            if on_progress:
                await on_progress(status, progress)
            if status == "done":
                video_url = data["video"]["url"]
                break
            if status in ("failed", "expired"):
                raise RuntimeError(f"Video generation {status}: {data}")
            # status == "pending" — keep polling
        else:
            raise RuntimeError("Video generation timed out")

        # Step 3: download the video
        video_resp = await client.get(video_url)
        if video_resp.status_code != 200:
            raise RuntimeError(f"Video download failed {video_resp.status_code}")
        return video_resp.content


CHAT_URL = "https://api.x.ai/v1/chat/completions"

_VISION_SYSTEM_PROMPT = """You are an image analysis assistant. Analyze the provided image and return a JSON object with exactly two fields:
- "tags": an array of danbooru-style tags (lowercase, underscored, e.g. "1girl", "long_hair", "black_dress"). Include tags for: characters, hair, clothing, pose, expression, setting, lighting, art style. Order by relevance. Maximum 30 tags.
- "description": a single paragraph natural language description of the image, suitable as an image generation prompt. 2-3 sentences, descriptive and specific.

Return ONLY the JSON object, no markdown formatting."""


async def analyze_image_vision(api_key: str, image_b64: str) -> dict:
    """Analyze an image using Grok Vision. Returns {"tags": [...], "description": "..."}."""
    import re

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "grok-4-1-fast-non-reasoning",
        "messages": [
            {"role": "system", "content": _VISION_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                    },
                    {"type": "text", "text": "Analyze this image."},
                ],
            },
        ],
        "temperature": 0.2,
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(CHAT_URL, json=payload, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"{resp.status_code}: {resp.text[:500]}")

    text = resp.json()["choices"][0]["message"]["content"]

    # Strip markdown code fences defensively
    text = re.sub(r"^```(?:json)?\s*", "", text.strip())
    text = re.sub(r"\s*```$", "", text.strip())

    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        raise RuntimeError(f"Failed to parse Grok Vision response as JSON: {text[:200]}")

    if "tags" not in result or "description" not in result:
        raise RuntimeError(f"Grok Vision response missing required fields: {list(result.keys())}")

    return result


_NOVELAI_GUIDE = """NovelAI V4.5 Prompt Guide:
- Tag order: Count → Character/Series → Appearance → Action/Expression → Scene → Style
- Example: 1girl, character name, blonde hair, blue eyes, smile, garden, soft lighting
- Emphasis: {text} = boost x1.05, {{text}} = boost x1.10, [text] = weaken x0.95, 1.5::text:: = exact weight
- Multi-character: separate with | — base prompt | character 1 | character 2
  - Base: count (2girls), scene (park), style (watercolor, year 2024), composition (from above)
  - Character: use girl/boy only (no number), appearance, expression, character name
  - Interactions: source#hug (initiator), target#hug (receiver), mutual#holding hands (both)
- Special: "fur dataset," prefix for furry, "background dataset," for scenery, "year 2024" for style era
- Quality tags (auto-appended): location, very aesthetic, masterpiece, no text
- Tags earlier = stronger influence. Limit ~512 tokens. No unicode/emoji."""

_PROMPT_ASSIST_TAGS = f"""You are a prompt tag assistant for NovelAI (an anime image generator that uses danbooru-style tags).

{_NOVELAI_GUIDE}

The user will describe what they want (and may include their current prompt for context). Generate a JSON object with one field:
- "tags": an array of 15-30 danbooru-style tags following the guide's tag order. Use lowercase, underscored format. Include tags for: characters, hair, clothing, pose, expression, setting, lighting, composition, art style. Order by importance.

If a current prompt is provided, suggest COMPLEMENTARY tags that enhance it — do not repeat tags already in the prompt.

Return ONLY the JSON object, no markdown formatting."""

_PROMPT_ASSIST_DESC = """You are a prompt assistant for Grok Imagine (an AI image generator that uses natural language descriptions).
The user will describe what they want (and may include their current prompt for context). Generate a JSON object with one field:
- "description": a detailed natural language description (2-4 sentences) suitable as an image generation prompt. Be specific about visual details: subject, pose, clothing, setting, lighting, mood, camera angle, art style.

If a current prompt is provided, expand and refine it into a better description.

Return ONLY the JSON object, no markdown formatting."""

_PROMPT_OPTIMIZE = f"""You are a prompt optimizer for NovelAI (an anime image generator that uses danbooru-style tags).

{_NOVELAI_GUIDE}

The user will provide their current prompt. Your job is to OPTIMIZE it:
1. Reorder tags following the correct tag order: Count → Character/Series → Appearance → Action/Expression → Scene → Style
2. Fix formatting: lowercase, underscored where appropriate, remove duplicates
3. Remove redundant or conflicting tags
4. Add missing quality/style tags if beneficial (but don't drastically change the intent)
5. Fix common misspellings of known danbooru tags
6. Keep emphasis markers (curly braces, [brackets], weight::syntax::) intact and in place

If the user provides additional instructions, follow them while optimizing.

Return a JSON object with one field:
- "prompt": the optimized prompt string (comma-separated tags, ready to paste)

Return ONLY the JSON object, no markdown formatting."""

_PROMPT_ASSIST_EDIT = """You are a prompt assistant for Grok Imagine's IMAGE EDITING mode.
The user has a source image loaded and wants to modify it. Grok edit mode works best with SHORT, DIRECTIVE prompts that describe what to CHANGE, not what the whole image should look like.

Effective edit prompt patterns:
- "change [X] to [Y]" — e.g. "change hair color to blonde", "change background to beach"
- "change [X] into [Y]" — e.g. "change dress into a red evening gown"
- "add [X]" — e.g. "add sunglasses", "add cherry blossoms in background"
- "remove [X]" — e.g. "remove background", "remove hat"
- "make [X] more [Y]" — e.g. "make lighting more dramatic", "make expression more cheerful"

BAD edit prompts (these destroy the original image):
- Full scene descriptions like "a woman standing in a garden with flowers"
- Too many changes at once
- Describing what already exists in the image

The user will describe what they want to change. Generate a JSON object with one field:
- "description": a SHORT directive edit prompt (1 sentence max). Focus on ONE specific change.

If the user asks for multiple changes, pick the most impactful one. They can run edits sequentially.

Return ONLY the JSON object, no markdown formatting."""


async def prompt_assist(api_key: str, direction: str, mode: str, current_prompt: str = "") -> dict:
    """Generate prompt suggestions. mode='tags' returns {"tags":[...]}, mode='description' returns {"description":"..."}."""
    import re

    systems = {"tags": _PROMPT_ASSIST_TAGS, "description": _PROMPT_ASSIST_DESC, "edit": _PROMPT_ASSIST_EDIT, "optimize": _PROMPT_OPTIMIZE}
    system = systems.get(mode, _PROMPT_ASSIST_DESC)

    if mode == "optimize":
        user_msg = f"Prompt to optimize:\n{current_prompt.strip()}"
        if direction.strip():
            user_msg += f"\n\nAdditional instructions: {direction.strip()}"
    else:
        user_msg = direction
        if current_prompt.strip():
            user_msg = f"Current prompt: {current_prompt.strip()}\n\nUser request: {direction}"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "grok-3-mini",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_msg},
        ],
        "temperature": 0.7,
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(CHAT_URL, json=payload, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"{resp.status_code}: {resp.text[:500]}")

    text = resp.json()["choices"][0]["message"]["content"]
    text = re.sub(r"^```(?:json)?\s*", "", text.strip())
    text = re.sub(r"\s*```$", "", text.strip())

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise RuntimeError(f"Failed to parse response: {text[:200]}")
