"""
xAI Grok API client.

Provides two async functions for image and video generation via the Grok API.
Image generation returns raw image bytes synchronously (single request).
Video generation is asynchronous: submit a job, poll until done, download the result.
"""
import asyncio
import base64
import json
import logging

import httpx

logger = logging.getLogger("app")

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


_NOVELAI_GUIDE = """NovelAI V4.5 uses danbooru-style tags with SPACES (not underscores).
Each tag is comma-separated. Count tags like "1boy", "1girl", "2girls" are SEPARATE tags — never merge them (e.g. "1boy, 1girl" NOT "1boy 1girl").
Order: Count → Rating → Character → Appearance → Action → Scene → Style
Example: 1boy, 1girl, rating:sensitive, blonde hair, blue eyes, smile, garden, soft lighting
Rating: rating:general / rating:sensitive / rating:questionable / rating:explicit (ALWAYS use "rating:" prefix, never bare "explicit"/"nsfw")
Emphasis: {boost}, [weaken], 1.5::weight::, -1::remove:: — preserve exactly as written
Multi-char: base | char1 | char2 — base has count+scene+style, chars have "girl"/"boy"+appearance.
Interactions (ONLY in character sections, NEVER in base): ONLY these 3 prefixes exist: source#action, target#action, mutual#action. Do NOT invent new prefixes. The # symbol is ONLY used for these interaction tags.
Quality tags auto-appended by system — do NOT add: location, very aesthetic, masterpiece, no text
Dataset prefixes (prompt start only): "fur dataset," or "background dataset,"
Year tag: "year 2024" for style era. Renamed: v→peace sign, double v→double peace"""

_PROMPT_ASSIST_TAGS = f"""NovelAI tag generator. {_NOVELAI_GUIDE}

Generate 15-30 danbooru tags (spaces not underscores) for the user's request. Order: count→character→appearance→action→scene→style. If current prompt provided, suggest COMPLEMENTARY tags only.

Return JSON: {{"tags": ["tag1", "tag2", ...]}}"""

_PROMPT_ASSIST_DESC = """You are a prompt assistant for Grok Imagine (an AI image generator that uses natural language descriptions).
The user will describe what they want (and may include their current prompt for context). Generate a JSON object with one field:
- "description": a detailed natural language description (2-4 sentences) suitable as an image generation prompt. Be specific about visual details: subject, pose, clothing, setting, lighting, mood, camera angle, art style.

If a current prompt is provided, expand and refine it into a better description.

Return ONLY the JSON object, no markdown formatting."""

_PROMPT_OPTIMIZE = f"""NovelAI prompt optimizer. {_NOVELAI_GUIDE}

Optimize the user's prompt:
- Reorder: Count → Rating → Character → Appearance → Action → Scene → Style
- Fix: underscores→spaces, bare "explicit"→"rating:explicit", duplicates, misspellings
- Preserve ALL emphasis markers exactly (curly braces, brackets, ::weight:: syntax)
- Don't add quality tags the system auto-appends
- Natural language handling: NovelAI is primarily tag-based but understands prose too. Convert clear descriptions to known danbooru tags when possible (e.g. "girl sitting on a bench in a park" → "1girl, sitting, bench, park"). But if a phrase has no obvious tag equivalent, keep it as-is — don't force awkward tag conversions. Vague descriptions like "beautiful scene" should become specific tags like "scenery, sunlight, grass"
- Multi-char pipe format rules (CRITICAL — follow exactly):
  BASE section (before first |): MUST be rich — include count, rating, scene, background, lighting, mood, weather, time of day, camera angle, composition, style, year. Infer and ADD atmospheric tags from context (e.g. if "classroom" → add "indoors, window, sunlight"). Base should have 8+ tags minimum.
  CHAR sections (after |): ONLY "girl"/"boy" + that character's appearance, expression, pose, interaction — NEVER scene/style/background
  Interactions: source# and target# MUST pair across characters. mutual# on ALL participants.
  Example input: "2girls, rating:sensitive, blonde hair, school uniform, black hair, red eyes, classroom"
  Correct output: "2girls, rating:sensitive, classroom, indoors, sunlight, window, desks, warm lighting, year 2024 | girl, blonde hair, school uniform, smile | girl, black hair, red eyes, serious"
  WRONG output: "2girls, rating:sensitive, classroom | girl, blonde hair, school uniform, smile" (base too sparse — missing atmosphere)

Return JSON: {{"prompt": "optimized tags", "changes": "brief summary of what changed"}}

Return ONLY the JSON object, no markdown formatting."""

_PROMPT_REFINE = f"""You are a prompt refiner for NovelAI (an anime image generator that uses danbooru-style tags).

{_NOVELAI_GUIDE}

The user will provide:
1. Their CURRENT PROMPT (the tags they used to generate an image)
2. An ANALYSIS of what the generated image actually looks like

Your job is to REFINE the prompt so the next generation is better:
- Keep tags that produced desired results (tags in both the prompt and the analysis)
- Strengthen or add emphasis to tags that didn't come through strongly enough
- Remove or weaken tags that produced unwanted results
- Add new tags from the analysis that describe desirable elements not in the original prompt
- Maintain correct tag order: Count → Character/Series → Appearance → Action/Expression → Scene → Style
- Keep emphasis markers intact
- IMPORTANT: If there are multiple characters in the image, use pipe | format:
  - Base prompt (count, scene, style) | character 1 tags | character 2 tags
  - Each character section: "girl"/"boy" (no number), appearance, expression
  - Interactions go IN the character section: source#action (initiator), target#action (receiver), mutual#action (both)
  - Base contains count tag (e.g. 2girls), scene, style

Return a JSON object with two fields:
- "prompt": the refined prompt string (comma-separated tags, with | separators for multi-character)
- "changes": a brief summary of what was changed and why (1-2 sentences)

Return ONLY the JSON object, no markdown formatting."""


def _parse_grok_json(text: str) -> dict:
    """Robustly parse JSON from Grok response, handling markdown wrappers and malformed output."""
    import re
    logger.info(f"[grok parse] raw response ({len(text)} chars): {text[:500]}")
    text = re.sub(r"^```(?:json)?\s*", "", text.strip())
    text = re.sub(r"\s*```$", "", text.strip())

    # Direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        logger.warning(f"[grok parse] direct parse failed: {e}")
        pass

    # Extract first JSON object
    m = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group())
        except json.JSONDecodeError:
            pass

    # Last resort: extract "prompt" and optional "changes" fields directly
    pm = re.search(r'"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    if pm:
        result = {"prompt": pm.group(1).replace('\\"', '"')}
        cm = re.search(r'"changes"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
        if cm:
            result["changes"] = cm.group(1).replace('\\"', '"')
        return result

    raise RuntimeError(f"Failed to parse response: {text[:300]}")


async def refine_prompt_with_image(api_key: str, current_prompt: str, image_b64: str, instructions: str = "") -> dict:
    """Analyze a generated image and refine the prompt based on the result."""
    import re

    # Step 1: Analyze the image
    analysis = await analyze_image_vision(api_key, image_b64)

    # Step 2: Use the analysis to refine the prompt
    tags_str = ", ".join(analysis.get("tags", []))
    desc_str = analysis.get("description", "")
    user_msg = f"Current prompt:\n{current_prompt.strip()}\n\nImage analysis (what was actually generated):\n- Tags: {tags_str}\n- Description: {desc_str}"
    if instructions.strip():
        user_msg += f"\n\nAdditional instructions: {instructions.strip()}"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "grok-3-mini",
        "messages": [
            {"role": "system", "content": _PROMPT_REFINE},
            {"role": "user", "content": user_msg},
        ],
        "temperature": 0.7,
    }

    async with httpx.AsyncClient(timeout=90.0) as client:
        resp = await client.post(CHAT_URL, json=payload, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"{resp.status_code}: {resp.text[:500]}")

    text = resp.json()["choices"][0]["message"]["content"]
    return _parse_grok_json(text)


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


_CRITIQUE_SYSTEM_PROMPT = """You are an expert anime art director reviewing a NovelAI generated image.

You are given:
1. An analysis of what the image contains (tags and description)
2. The prompt that was used to generate it

Provide exactly 2-3 specific, actionable critique bullets. Each bullet must:
- Point out ONE concrete issue or improvement opportunity
- Suggest specific danbooru-style tags (spaces not underscores) to add or remove
- Be actionable — not subjective praise like "looks good"

Return JSON:
{"bullets": [
  {"text": "observation and suggestion", "add_tags": ["tag1", "tag2"], "remove_tags": ["tag3"]},
  ...
]}

Focus on: composition, lighting, pose, expression, anatomy issues, mood, missing details.
Never suggest tags already in the current prompt. Maximum 3 bullets."""


async def critique_image(api_key: str, image_b64: str, current_prompt: str) -> dict:
    """Analyze an image then produce 2-3 actionable critique bullets via grok-3-mini."""
    # Step 1: Analyze the image with vision
    analysis = await analyze_image_vision(api_key, image_b64)
    tags_str = ", ".join(analysis.get("tags", [])[:20])
    desc_str = analysis.get("description", "")

    # Step 2: Ask grok-3-mini for structured critique
    user_msg = f"Current prompt: {current_prompt}\n\nImage analysis:\n- Tags: {tags_str}\n- Description: {desc_str}"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "grok-3-mini",
        "messages": [
            {"role": "system", "content": _CRITIQUE_SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        "temperature": 0.7,
        "response_format": {"type": "json_object"},
    }

    async with httpx.AsyncClient(timeout=90.0) as client:
        resp = await client.post(CHAT_URL, json=payload, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"{resp.status_code}: {resp.text[:500]}")

    text = resp.json()["choices"][0]["message"]["content"]
    return _parse_grok_json(text)


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
        "response_format": {"type": "json_object"},
    }

    async with httpx.AsyncClient(timeout=90.0) as client:
        resp = await client.post(CHAT_URL, json=payload, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"{resp.status_code}: {resp.text[:500]}")

    text = resp.json()["choices"][0]["message"]["content"]
    return _parse_grok_json(text)
