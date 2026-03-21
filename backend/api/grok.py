"""
xAI Grok API client.

Provides two async functions for image and video generation via the Grok API.
Image generation returns raw image bytes synchronously (single request).
Video generation is asynchronous: submit a job, poll until done, download the result.
"""
import asyncio
import base64

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
