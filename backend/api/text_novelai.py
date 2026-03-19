"""
NovelAI text generation API client.

Responsible for constructing the generate-text payload and returning the output
string.  GLM models return plain text directly in the ``output`` field.  Older
models (Kayra, Clio, Erato) return base64-encoded token sequences that must be
decoded before use.

Token encoding
--------------
Kayra / Clio: 16-bit (2-byte) tokens encoded as little-endian UTF-16LE.
Erato:        32-bit (4-byte) tokens encoded as little-endian UTF-32LE.

A heuristic determines which path to take: if the raw output decodes cleanly
from base64 into an even number of bytes *and* the result is not valid UTF-8,
it is treated as a token sequence.  GLM output is plain UTF-8 text and will
never trigger the token-decode path.
"""
import base64

import httpx

TEXT_API_URL_LEGACY = "https://text.novelai.net/ai/generate"
TEXT_API_URL_OPENAI = "https://text.novelai.net/oa/v1/completions"

# Models that use the OpenAI-compatible endpoint
_OPENAI_MODELS = {"glm-4-6"}

# Models that use 4-byte (UTF-32LE) token encoding (legacy endpoint)
_UTF32_MODELS = {"llama-3-erato-v1"}


def _decode_output(raw: str, model: str) -> str:
    """Decode the ``output`` field from a NovelAI text API response.

    GLM models return plain UTF-8 text.  Kayra/Clio return UTF-16LE-encoded
    token bytes (base64); Erato returns UTF-32LE-encoded token bytes (base64).
    """
    if model in _PLAIN_TEXT_MODELS:
        return raw

    try:
        token_bytes = base64.b64decode(raw)
    except Exception:
        # Not base64 — treat as plain text
        return raw

    if model in _UTF32_MODELS:
        try:
            return token_bytes.decode("utf-32-le")
        except UnicodeDecodeError:
            return raw

    # Default: Kayra / Clio use UTF-16LE 2-byte tokens
    try:
        return token_bytes.decode("utf-16-le")
    except UnicodeDecodeError:
        return raw


async def generate_text(
    token: str,
    input_text: str,
    model: str = "glm-4-6",
    max_length: int = 100,
    temperature: float = 1.0,
) -> str:
    """Call the NovelAI text generation API and return the decoded output string.

    Args:
        token:      NovelAI Bearer token.
        input_text: The prompt / context to continue.
        model:      Model identifier (e.g. ``"glm-4-6"``).
        max_length: Maximum number of tokens to generate (1–300).

    Returns:
        The generated text as a plain Python string.

    Raises:
        RuntimeError: If the API returns a non-200 status.
    """
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    if model in _OPENAI_MODELS:
        # OpenAI-compatible endpoint for GLM models
        # The completions endpoint continues directly from the prompt text
        payload = {
            "model": model,
            "prompt": input_text,
            "max_tokens": max_length,
            "temperature": temperature,
            "top_p": 0.975,
            "frequency_penalty": 0.2,
            "presence_penalty": 0.1,
        }
        api_url = TEXT_API_URL_OPENAI
    else:
        # Legacy endpoint for Kayra/Clio/Erato
        payload = {
            "input": input_text,
            "model": model,
            "parameters": {
                "max_length": max_length,
                "min_length": 1,
                "temperature": temperature,
                "top_k": 0,
                "top_p": 0.975,
                "tail_free_sampling": 0.975,
                "repetition_penalty": 2.975,
                "repetition_penalty_range": 2048,
            },
        }
        api_url = TEXT_API_URL_LEGACY

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(api_url, json=payload, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"{resp.status_code}: {resp.text[:500]}")
        data = resp.json()

    if model in _OPENAI_MODELS:
        # OpenAI format: {"choices": [{"text": "..."}]}
        choices = data.get("choices", [])
        return choices[0]["text"] if choices else ""
    else:
        raw_output = data.get("output", "")
        return _decode_output(raw_output, model)
