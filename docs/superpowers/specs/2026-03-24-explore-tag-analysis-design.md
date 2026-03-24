# Explore Image Tag Analysis

**Date:** 2026-03-24
**Status:** Approved by PM

## Overview

On-demand image tag analysis in the Explore Local tab. Users click an image to expand an analysis panel, choose WD Tagger (free/local) or Grok Vision (paid API), and get reusable tags + descriptions cached in `.tags/` sidecar files. Tags are clickable to insert directly into the prompt.

## Scope

- **Local mode only** (first iteration). URL mode images are transient with no stable path for sidecar files.
- **On-demand only.** No automatic or batch analysis. User explicitly clicks to analyze.

## Security

All new endpoints must use `_resolve_gallery_path(root, path)` for path resolution — the same helper used by gallery and local browse endpoints. This applies to both read and write operations. The `.tags/` directory creation and file writes must be verified to reside within the browse root. Writing files is more dangerous than reading, so path validation is critical on the analyze endpoint.

## UI: Analysis Panel

### Interaction Flow

1. Click image thumbnail in Local grid → panel expands **below the clicked image row** (drawer style, not modal — grid context stays visible)
2. Panel shows: large image preview + analysis buttons + tag results area + action buttons
3. User clicks "WD Tagger" or "Grok Vision" → loading spinner → results appear
4. If cached results exist, they display immediately — no API call
5. Click any tag → inserts at cursor position in prompt textarea (reuse existing `insertTagIntoPrompt()`)
6. "Send to Canvas" button (primary/dominant visual weight) → opens crop overlay via existing `openCropOverlay()`
7. Click another image or click outside → panel collapses

### Panel Layout

```
┌──────────────────────────────────────────────────┐
│  [Image Preview]  │  Analysis                    │
│                   │                              │
│                   │  [WD Tagger] [Grok Vision]   │
│                   │                              │
│                   │  WD Tags:                    │
│                   │  [1girl] [long hair] [dress]  │
│                   │                              │
│                   │  Grok Tags:                  │
│                   │  [1girl] [sitting] [window]   │
│                   │                              │
│                   │  Grok Description:           │
│                   │  "A girl with long black..." │
│                   │  [Copy]                      │
│                   │                              │
│                   │  [Re-analyze WD ↻]           │
│                   │  [Re-analyze Grok ↻]         │
├──────────────────────────────────────────────────┤
│                        [Send to Canvas]          │
└──────────────────────────────────────────────────┘
```

Re-analyze buttons appear per-method next to cached results. Each re-runs only that specific method.

### Grid Indicator

Already-analyzed images show a small dot (6-8px) in the corner using `--accent` color. The dot appears when a `.tags/` cache file exists for that image.

## Caching: `.tags/` Directory

### Structure

```
comics/Chapter-01/
├── .tags/
│   ├── page01.jpg.json
│   ├── page02.jpg.json
│   └── page03.jpg.json
├── page01.jpg
├── page02.jpg
└── page03.jpg
```

### Cache File Format

```json
{
  "wd": [
    { "name": "1girl", "score": 0.95, "category": "general" },
    { "name": "long_hair", "score": 0.88, "category": "general" }
  ],
  "grok": {
    "tags": ["1girl", "long_hair", "black_dress", "sitting", "window"],
    "description": "A girl with long black hair wearing a black dress, sitting by a window with soft natural lighting."
  }
}
```

- `wd` and `grok` are independent — either can be present or absent
- `.tags/` directory is hidden (already filtered by Local browser's `.` prefix filter)
- Cache persists forever; per-method "Re-analyze" buttons allow manual refresh
- **Write safety:** Backend uses read-modify-write pattern — read existing cache, merge the new method's data, write back. This prevents a WD write from clobbering a previously cached Grok result.

## Backend API

### `POST /api/explore/local/analyze`

Request:
```json
{
  "path": "Chapter-01/page01.jpg",
  "method": "wd" | "grok"
}
```

Response for `method=wd`:
```json
{
  "wd": [
    { "name": "1girl", "score": 0.95, "category": "general" },
    { "name": "long_hair", "score": 0.88, "category": "general" }
  ]
}
```

Response for `method=grok`:
```json
{
  "grok": {
    "tags": ["1girl", "long_hair", "black_dress", "sitting", "window"],
    "description": "A girl with long black hair wearing a black dress, sitting by a window with soft natural lighting."
  }
}
```

**WD Tagger path:** Read image from disk as raw bytes. The existing `run_inference()` in `tagger.py` accepts base64, so either: (a) read file bytes → base64-encode → pass to `run_inference()`, or (b) add a `run_inference_from_bytes()` variant. Option (a) is simpler for a first iteration. Save result to `.tags/` (read-modify-write), return.

**Grok Vision path:** Call xAI chat completions API with `grok-2-vision`. Resize image to max 1024px before encoding (saves API tokens on large images). System prompt:

```
You are an image analysis assistant. Analyze the provided image and return a JSON object with exactly two fields:
- "tags": an array of danbooru-style tags (lowercase, underscored, e.g. "1girl", "long_hair", "black_dress"). Include tags for: characters, hair, clothing, pose, expression, setting, lighting, art style. Order by relevance. Maximum 30 tags.
- "description": a single paragraph natural language description of the image, suitable as an image generation prompt. 2-3 sentences, descriptive and specific.

Return ONLY the JSON object, no markdown formatting.
```

Parse the JSON response on the backend. Strip markdown code fences (` ```json ... ``` `) defensively before parsing. Save to `.tags/` (read-modify-write). Return result.

### `GET /api/explore/local/tags`

Query: `?path=Chapter-01/page01.jpg`

Returns the full cached tags file if it exists:
```json
{
  "wd": [...],
  "grok": { "tags": [...], "description": "..." }
}
```
Returns `{}` if not yet analyzed.

### `GET /api/explore/local/tags/batch`

Query: `?path=Chapter-01` (directory path)

Returns a dict of filenames to their cached method types:
```json
{
  "page01.jpg": ["wd"],
  "page02.jpg": ["wd", "grok"],
  "page03.jpg": ["grok"]
}
```

Used by the grid to render dot indicators without N+1 requests.

### API Key Availability

The frontend checks whether Grok Vision is available by looking at the existing provider-switching logic. Add a field to the `GET /api/settings` response: `"xai_api_configured": true/false`. Frontend disables "Grok Vision" button with tooltip when false.

## Tag Insertion

Reuse existing `insertTagIntoPrompt()` function (app.js). Clicking a tag pill calls this function to insert the tag at the current cursor position in the prompt textarea, with proper comma separation.

For natural language descriptions:
- "Copy" button → copies to clipboard
- "Use as Prompt" button → replaces entire prompt text

## Error Handling

- WD Tagger first-use download: reuse the existing Autopsy panel's download progress pattern (shows progress bar during ~350MB model download)
- Grok Vision API error: show error message in the analysis panel
- `XAI_API_KEY` not configured: disable "Grok Vision" button with tooltip "API key not configured"
- Image read failure: show error in panel

## Files to Modify

**Backend:**
- `backend/api/routes.py` — Add analyze, tags, tags/batch endpoints; add `xai_api_configured` to settings response
- `backend/api/grok.py` — Add `analyze_image_vision()` function for chat completions

**Frontend:**
- `frontend/index.html` — Analysis panel markup inside `#explore-mode-local`
- `frontend/js/app.js` — Analysis panel logic, tag display, click-to-insert, grid dot indicators
- `frontend/css/style.css` — Analysis panel styles, tag pills, dot indicator

## Dependencies

- Existing: `tagger.py` (WD Tagger), `grok.py` (xAI client), `insertTagIntoPrompt()` (tag insertion)
- New: xAI chat completions API (`https://api.x.ai/v1/chat/completions`) with `grok-2-vision` model
