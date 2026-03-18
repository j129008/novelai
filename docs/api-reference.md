# API Reference

All endpoints are served under the `/api` prefix by the FastAPI backend running at `http://localhost:8000`.

---

## Table of Contents

1. [GET /api/options](#get-apioptions)
2. [GET /api/tags](#get-apitags)
3. [GET /api/tags/categories](#get-apitagscategories)
4. [POST /api/generate](#post-apigenerate)
5. [GET /api/gallery](#get-apigallery)
6. [GET /api/gallery/{filename}](#get-apigalleryfilename)
7. [DELETE /api/gallery/{filename}](#delete-apigalleryfilename)
8. [GET /api/settings](#get-apisettings)
9. [PUT /api/settings](#put-apisettings)
10. [POST /api/settings/browse](#post-apisettingsbrowse)
11. [POST /api/settings/open-folder](#post-apisettingsopen-folder)

---

## GET /api/options

Returns the list of available samplers and canvas size presets.

**Response**

```json
{
  "samplers": [
    "k_euler_ancestral",
    "k_euler",
    "k_dpmpp_2s_ancestral",
    "k_dpmpp_2m",
    "k_dpmpp_2m_sde",
    "k_dpmpp_sde"
  ],
  "resolutions": [
    {"width": 832,  "height": 1216, "label": "Portrait (832x1216)"},
    {"width": 1216, "height": 832,  "label": "Landscape (1216x832)"},
    {"width": 1024, "height": 1024, "label": "Square (1024x1024)"},
    {"width": 512,  "height": 768,  "label": "Small Portrait (512x768)"},
    {"width": 768,  "height": 512,  "label": "Small Landscape (768x512)"},
    {"width": 1088, "height": 1920, "label": "Wallpaper Portrait (1088x1920)"},
    {"width": 1920, "height": 1088, "label": "Wallpaper Landscape (1920x1088)"}
  ]
}
```

**Example**

```bash
curl http://localhost:8000/api/options
```

---

## GET /api/tags

Searches the tag database by prefix then substring. Results are sorted by usage count (most-used first).

**Query Parameters**

| Parameter | Type | Default | Constraints | Description |
|-----------|------|---------|-------------|-------------|
| `q` | string | required | min length 1 | Search query. Spaces are normalized to underscores before matching. |
| `limit` | integer | `15` | max `30` | Maximum number of results to return. |

**Response**

Array of tag objects:

```json
[
  {
    "name": "1girl",
    "category": "general",
    "count": 4000000,
    "aliases": ""
  }
]
```

Category values: `general`, `artist`, `series`, `character`, `meta`.

**Error Conditions**

| Status | Condition |
|--------|-----------|
| 422 | `q` is missing or empty |

**Example**

```bash
curl "http://localhost:8000/api/tags?q=blue+hair&limit=5"
```

---

## GET /api/tags/categories

Returns the curated category list used by the Tag Browser.

**Response**

```json
{
  "categories": [
    {"name": "Hair Color", "tags": ["blonde hair", "brown hair", "..."]},
    "..."
  ]
}
```

The exact structure depends on `backend/data/tag_categories.json`. If the file is absent or unreadable, the response is `{"categories": []}`.

**Example**

```bash
curl http://localhost:8000/api/tags/categories
```

---

## POST /api/generate

Generates an image via the NovelAI API and saves it to the output folder.

**Request Body** (JSON)

| Field | Type | Default | Constraints | Description |
|-------|------|---------|-------------|-------------|
| `prompt` | string | required | min length 1 | The image prompt. |
| `negative_prompt` | string | `""` | — | Things to exclude from the image. |
| `model` | string | `"nai-diffusion-4-5-full"` | see below | Model identifier. |
| `width` | integer | `832` | 64–2048 | Output width in pixels. |
| `height` | integer | `1216` | 64–2048 | Output height in pixels. |
| `steps` | integer | `28` | 1–50 | Number of diffusion steps. More steps increase quality and generation time. |
| `scale` | float | `5.0` | 0–10 | CFG scale (prompt adherence). Higher values follow the prompt more strictly. |
| `sampler` | string | `"k_euler_ancestral"` | see below | Sampling algorithm. |
| `seed` | integer | `0` | >= 0 | RNG seed. **`0` means random**: the server picks a seed and returns it in the response. Any non-zero value reproduces the same image given identical parameters. |
| `sm` | boolean | `false` | — | SMEA sampling. Has no effect on `nai-diffusion-4-5-full` (hidden in UI). |
| `sm_dyn` | boolean | `false` | — | Dynamic SMEA. Has no effect on `nai-diffusion-4-5-full` (hidden in UI). |
| `image` | string or null | `null` | base64 PNG, no `data:` URI prefix | Source image for img2img mode. When present, the server sets `action = "img2img"` automatically. |
| `strength` | float | `0.7` | 0–1 | img2img transformation amount. `0` = no change, `1` = fully redraw. |
| `noise` | float | `0.0` | 0–1 | Additional noise injected during img2img. Increases variation from the source. |
| `reference_image` | string or null | `null` | base64 PNG, no `data:` URI prefix | Style reference image (vibe transfer). |
| `reference_information_extracted` | float | `1.0` | 0–1 | How much style information to extract from the reference image. |
| `reference_strength` | float | `0.6` | 0–1 | How strongly the style reference influences the output. |

**Valid `model` values**

- `"nai-diffusion-4-5-full"` (only accepted value)

**Valid `sampler` values**

- `"k_euler_ancestral"`
- `"k_euler"`
- `"k_dpmpp_2s_ancestral"`
- `"k_dpmpp_2m"`
- `"k_dpmpp_2m_sde"`
- `"k_dpmpp_sde"`

**Action derivation**

The `action` field sent to NovelAI is derived server-side:

- `image` present and non-null → `action = "img2img"`
- `image` absent or null → `action = "generate"`

Do not include `action` in your request body; it has no effect.

**Response**

```json
{
  "image": "<base64-encoded PNG string>",
  "seed": 3141592653
}
```

The `seed` in the response is always the actual seed used, even when you sent `0`. Store it if you want to reproduce the result.

Images are also auto-saved to the configured output folder with the filename pattern `{unix_timestamp}-s{seed}.png`.

**Error Conditions**

| Status | Condition |
|--------|-----------|
| 422 | Request body fails schema validation (e.g., `prompt` is empty, `steps` out of range) |
| 503 | `NOVELAI_TOKEN` environment variable is not set |
| 502 | The NovelAI API returned an error |

**Example — text-to-image**

```bash
curl -X POST http://localhost:8000/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "1girl, long white hair, blue eyes, garden, soft lighting",
    "negative_prompt": "lowres, bad quality",
    "steps": 28,
    "seed": 0
  }'
```

**Example — img2img**

```bash
# Encode source image to base64 first
# macOS:
B64=$(base64 -i source.png | tr -d '\n')
# Linux:
# B64=$(base64 source.png | tr -d '\n')

curl -X POST http://localhost:8000/api/generate \
  -H "Content-Type: application/json" \
  -d "{
    \"prompt\": \"1girl, watercolor style\",
    \"image\": \"$B64\",
    \"strength\": 0.65,
    \"noise\": 0.0,
    \"seed\": 0
  }"
```

---

## GET /api/gallery

Lists all saved images in the output folder, sorted by modification time (newest first).

**Response**

Array of image entries:

```json
[
  {
    "name": "1710000000-s3141592653.png",
    "size": 1048576,
    "meta": {
      "prompt": "1girl, garden",
      "uc": "lowres, bad quality",
      "seed": 3141592653,
      "steps": 28,
      "scale": 5.0,
      "sampler": "k_euler_ancestral",
      "width": 832,
      "height": 1216,
      "sm": false,
      "sm_dyn": false
    }
  }
]
```

The `meta` field is present only when metadata can be read from the PNG's `Comment` chunk. Images without embedded metadata will be listed without `meta`.

**Example**

```bash
curl http://localhost:8000/api/gallery
```

---

## GET /api/gallery/{filename}

Returns a single PNG image from the output folder.

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `filename` | string | Filename as returned by `GET /api/gallery`. |

**Response**

PNG image (`Content-Type: image/png`).

**Error Conditions**

| Status | Condition |
|--------|-----------|
| 404 | File does not exist, or the resolved path escapes the output directory (path traversal protection). |

**Example**

```bash
curl -o saved.png http://localhost:8000/api/gallery/1710000000-s3141592653.png
```

---

## DELETE /api/gallery/{filename}

Permanently deletes a PNG from the output folder.

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `filename` | string | Filename as returned by `GET /api/gallery`. |

**Response**

```json
{"deleted": "1710000000-s3141592653.png"}
```

**Error Conditions**

| Status | Condition |
|--------|-----------|
| 404 | File does not exist or path escapes the output directory. |

**Example**

```bash
curl -X DELETE http://localhost:8000/api/gallery/1710000000-s3141592653.png
```

---

## GET /api/settings

Returns the current application settings.

**Response**

```json
{
  "output_dir": "/Users/you/novelai/output"
}
```

**Example**

```bash
curl http://localhost:8000/api/settings
```

---

## PUT /api/settings

Updates application settings. Settings are persisted to `.app-settings.json` at the project root.

**Request Body** (JSON)

| Field | Type | Description |
|-------|------|-------------|
| `output_dir` | string or null | Absolute or `~`-prefixed path to the output folder. The directory is created if it does not exist. Pass `null` to leave unchanged. |

**Response**

Same shape as `GET /api/settings`, reflecting the updated state.

**Example**

```bash
curl -X PUT http://localhost:8000/api/settings \
  -H "Content-Type: application/json" \
  -d '{"output_dir": "/Users/you/Pictures/novelai"}'
```

---

## POST /api/settings/browse

**macOS only.** Opens a native folder-picker dialog (via AppleScript) and returns the selected path.

**Request Body**

None.

**Response**

```json
{"path": "/Users/you/Pictures/novelai"}
```

Returns `{"path": null}` if the user cancels the dialog.

**Error Conditions**

| Status | Condition |
|--------|-----------|
| 500 | `osascript` is not available (non-macOS systems). |

**Example**

```bash
curl -X POST http://localhost:8000/api/settings/browse
```

---

## POST /api/settings/open-folder

**macOS only.** Opens the current output folder in Finder.

**Request Body**

None.

**Response**

```json
{"opened": "/Users/you/novelai/output"}
```

**Error Conditions**

| Status | Condition |
|--------|-----------|
| 500 | `open` command is not available (non-macOS systems). |

**Example**

```bash
curl -X POST http://localhost:8000/api/settings/open-folder
```
