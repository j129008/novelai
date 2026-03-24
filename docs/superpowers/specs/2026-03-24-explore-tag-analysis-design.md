# Explore Image Tag Analysis

**Date:** 2026-03-24
**Status:** Approved by PM

## Overview

On-demand image tag analysis in the Explore Local tab. Users click an image to expand an analysis panel, choose WD Tagger (free/local) or Grok Vision (paid API), and get reusable tags + descriptions cached in `.tags/` sidecar files. Tags are clickable to insert directly into the prompt.

## Scope

- **Local mode only** (first iteration). URL mode images are transient with no stable path for sidecar files.
- **On-demand only.** No automatic or batch analysis. User explicitly clicks to analyze.

## UI: Analysis Panel

### Interaction Flow

1. Click image thumbnail in Local grid → panel expands **below the clicked image row** (drawer style, not modal — grid context stays visible)
2. Panel shows: large image preview + analysis buttons + tag results area + action buttons
3. User clicks "WD Tagger" or "Grok Vision" → loading spinner → results appear
4. If cached results exist, they display immediately — no API call
5. Click any tag → inserts at cursor position in prompt textarea (reuse existing `insertTagIntoPrompt()`)
6. "Send to Canvas" button (primary/dominant visual weight) → opens crop overlay
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
│                   │  [Re-analyze ↻]              │
├──────────────────────────────────────────────────┤
│                        [Send to Canvas]          │
└──────────────────────────────────────────────────┘
```

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
- Cache persists forever; "Re-analyze" button allows manual refresh

## Backend API

### `POST /api/explore/local/analyze`

Request:
```json
{
  "path": "Chapter-01/page01.jpg",
  "method": "wd" | "grok"
}
```

Response: the analysis result (same format as cache file, but only the requested method's section).

**WD Tagger path:** Reuse existing `tagger.py` `run_inference()`. Read image from local browse root, run inference, save to `.tags/`, return result.

**Grok Vision path:** Call xAI chat completions API with `grok-2-vision`. System prompt instructs structured JSON output:

```
System: You are an image analysis assistant. Analyze the provided image and return a JSON object with exactly two fields:
- "tags": an array of danbooru-style tags (lowercase, underscored, e.g. "1girl", "long_hair", "black_dress"). Include tags for: characters, hair, clothing, pose, expression, setting, lighting, art style. Order by relevance. Maximum 30 tags.
- "description": a single paragraph natural language description of the image, suitable as an image generation prompt. 2-3 sentences, descriptive and specific.

Return ONLY the JSON object, no markdown formatting.
```

Parse the JSON response on the backend. Save to `.tags/`. Return result.

### `GET /api/explore/local/tags`

Query: `?path=Chapter-01/page01.jpg`

Returns cached tags if they exist, or `null`/empty if not yet analyzed. Used by frontend to check cache status (for the grid dot indicator) and to display cached results instantly.

### `GET /api/explore/local/tags/batch`

Query: `?path=Chapter-01` (directory path)

Returns a list of filenames that have cached tags in the `.tags/` directory. Used by the grid to render dot indicators without N+1 requests.

## Tag Insertion

Reuse existing `insertTagIntoPrompt()` function (app.js). Clicking a tag pill calls this function to insert the tag at the current cursor position in the prompt textarea, with proper comma separation.

For natural language descriptions, a "Copy" button copies to clipboard, and a "Use as Prompt" button replaces the entire prompt text.

## Error Handling

- WD Tagger first-use download: reuse the existing Autopsy panel's download progress pattern (shows progress bar during ~350MB model download)
- Grok Vision API error: show error message in the analysis panel
- `XAI_API_KEY` not configured: disable "Grok Vision" button with tooltip "API key not configured"
- Image read failure: show error in panel

## Files to Modify

**Backend:**
- `backend/api/routes.py` — Add analyze, tags, and tags/batch endpoints
- `backend/api/grok.py` — Add `analyze_image_vision()` function for chat completions

**Frontend:**
- `frontend/index.html` — Analysis panel markup inside `#explore-mode-local`
- `frontend/js/app.js` — Analysis panel logic, tag display, click-to-insert, grid dot indicators
- `frontend/css/style.css` — Analysis panel styles, tag pills, dot indicator

## Dependencies

- Existing: `tagger.py` (WD Tagger), `grok.py` (xAI client), `insertTagIntoPrompt()` (tag insertion)
- New: xAI chat completions API (`https://api.x.ai/v1/chat/completions`) with `grok-2-vision` model
