"""
test_grok_multi_image.py — Probe the xAI Grok image-editing endpoint for multi-image support.

The production client (backend/api/grok.py) passes a single image as:
    {"image": {"url": "data:image/png;base64,<b64>", "type": "image_url"}}

The API documentation does not yet describe a stable multi-image contract.
This script tries three candidate payload shapes and reports which ones the
server accepts (HTTP 200), saving any successful result to disk.

Usage:
    python scripts/test_grok_multi_image.py img1.png img2.png [img3.png ...]
    python scripts/test_grok_multi_image.py img1.png img2.png --prompt "Merge these styles"

At least two image paths are required.
"""
import argparse
import base64
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv
import os

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EDIT_URL = "https://api.x.ai/v1/images/edits"
DEFAULT_PROMPT = "Combine the style of these images"
TIMEOUT = 120.0
SCRIPTS_DIR = Path(__file__).parent


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_api_key() -> str:
    env_path = SCRIPTS_DIR.parent / ".env"
    load_dotenv(dotenv_path=env_path)
    key = os.getenv("XAI_API_KEY", "")
    if not key:
        sys.exit(
            f"XAI_API_KEY not found in {env_path}. "
            "Add it to your .env file and try again."
        )
    return key


def encode_image(path: Path) -> str:
    """Return a base64-encoded string for the given image file."""
    return base64.b64encode(path.read_bytes()).decode()


def data_uri(b64: str) -> str:
    return f"data:image/png;base64,{b64}"


def build_headers(api_key: str) -> dict:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


def save_result(resp_json: dict, label: str) -> Path | None:
    """Extract b64_json from a successful response and save to disk."""
    try:
        b64 = resp_json["data"][0]["b64_json"]
        out_path = SCRIPTS_DIR / f"test_output_{label}.png"
        out_path.write_bytes(base64.b64decode(b64))
        return out_path
    except (KeyError, IndexError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Payload factories
# ---------------------------------------------------------------------------

def format_a(b64_images: list[str], prompt: str) -> dict:
    """
    Format A: "image_urls" key holding a list of plain base64 data URIs.
    Mirrors how some OpenAI-compatible endpoints accept multiple images.
    """
    return {
        "model": "grok-imagine-image",
        "prompt": prompt,
        "image_urls": [data_uri(b) for b in b64_images],
        "response_format": "b64_json",
        "n": 1,
    }


def format_b(b64_images: list[str], prompt: str) -> dict:
    """
    Format B: "images" key holding a list of {"url": ..., "type": "image_url"}
    objects — the plural-key variant of the existing single-image contract.
    """
    return {
        "model": "grok-imagine-image",
        "prompt": prompt,
        "images": [
            {"url": data_uri(b), "type": "image_url"}
            for b in b64_images
        ],
        "response_format": "b64_json",
        "n": 1,
    }


def format_c(b64_images: list[str], prompt: str) -> dict:
    """
    Format C: "image" key as a list of {"url": ..., "type": "image_url"}
    objects — identical to the single-image contract but the value becomes
    an array rather than a plain object.
    """
    return {
        "model": "grok-imagine-image",
        "prompt": prompt,
        "image": [
            {"url": data_uri(b), "type": "image_url"}
            for b in b64_images
        ],
        "response_format": "b64_json",
        "n": 1,
    }


FORMATS: list[tuple[str, callable]] = [
    ("B", format_b),
]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "images",
        nargs="+",
        metavar="IMAGE",
        help="Paths to two or more PNG/JPG images to include in the edit request.",
    )
    parser.add_argument(
        "--prompt",
        default=DEFAULT_PROMPT,
        help=f'Edit prompt sent to the API (default: "{DEFAULT_PROMPT}").',
    )
    args = parser.parse_args()
    if len(args.images) < 2:
        parser.error("At least two image paths are required.")
    return args


def main() -> None:
    args = parse_args()

    # Validate and load image files.
    image_paths = [Path(p) for p in args.images]
    for p in image_paths:
        if not p.exists():
            sys.exit(f"File not found: {p}")
        if not p.is_file():
            sys.exit(f"Not a file: {p}")

    api_key = load_api_key()
    headers = build_headers(api_key)

    print(f"Prompt : {args.prompt}")
    print(f"Images : {[str(p) for p in image_paths]}")
    print(f"Endpoint: {EDIT_URL}")
    print()

    b64_images = [encode_image(p) for p in image_paths]

    results: dict[str, str] = {}   # label -> outcome description

    with httpx.Client(timeout=TIMEOUT) as client:
        for label, factory in FORMATS:
            payload = factory(b64_images, args.prompt)
            print(f"--- Format {label} (key: {list(payload.keys())}) ---")
            try:
                resp = client.post(EDIT_URL, json=payload, headers=headers)
                snippet = resp.text[:300]
                print(f"Status : {resp.status_code}")
                print(f"Response: {snippet}")

                if resp.status_code == 200:
                    out = save_result(resp.json(), label)
                    if out:
                        print(f"Saved  : {out}")
                        results[label] = f"SUCCESS — image saved to {out}"
                    else:
                        results[label] = "SUCCESS (200) but could not extract b64_json"
                else:
                    results[label] = f"FAILED ({resp.status_code})"

            except httpx.RequestError as exc:
                print(f"Request error: {exc}")
                results[label] = f"REQUEST ERROR: {exc}"

            print()

    # Summary
    print("=" * 50)
    print("Summary")
    print("=" * 50)
    for label, outcome in results.items():
        print(f"  Format {label}: {outcome}")

    any_success = any("SUCCESS" in v for v in results.values())
    if not any_success:
        print()
        print(
            "No format returned HTTP 200. "
            "The API may not yet support multi-image edits, or the payload "
            "contract differs from all three candidates tested here."
        )


if __name__ == "__main__":
    main()
