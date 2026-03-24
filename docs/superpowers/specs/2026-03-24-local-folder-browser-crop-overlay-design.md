# Local Folder Browser + Crop Overlay Integration

**Date:** 2026-03-24
**Status:** Approved by PM

## Overview

Two independent features that enable a comic-reference workflow: browse locally downloaded comics in the Explore tab, and ensure all image import paths go through the existing crop overlay.

## Feature 1: Explore Tab — Local Folder Browser

### Problem

Users download comics/manga externally (e.g., ComicCrawler CLI) and want to quickly browse those images in-app to send to canvas as reference material for NovelAI or Grok generation. Currently the Explore tab only supports URL-based web scraping.

### Design

**UI Changes (Explore Tab):**

- Add two sub-tabs at the top of the Explore panel: "URL" and "Local"
  - Sub-tabs use a distinct, smaller style than the top-level canvas tabs to avoid visual confusion
- URL sub-tab retains all existing functionality unchanged
- Local sub-tab contains:
  - Text input for folder path + "Browse" button (triggers macOS folder picker via existing `/api/settings/browse` pattern)
  - Folder path persisted in both `localStorage` (for frontend display) and server-side settings (for backend enforcement)
  - Breadcrumb navigation bar showing current path segments (clickable to jump back)
    - Overflow: truncate middle segments with "..." when path is very deep
  - Content area with two item types:
    - **Folder cards:** folder name, click to enter subdirectory
    - **Image thumbnails:** same grid style as existing Explore tab, click to send to canvas (via crop overlay)

**Backend API:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/explore/local` | GET | List subdirectories and image files at `?path=...` |
| `/api/explore/local/image` | GET | Serve image file at `?path=...&thumbnail=true` for thumbnail or full display |

**Security:**
- **Server-side root enforcement:** The browse root path is stored in `.settings.json` (alongside `output_dir`) via the existing settings save mechanism. All `/api/explore/local` requests are validated against this server-side root using the same `_resolve_gallery_path` pattern (`Path.resolve()` + `is_relative_to()`)
- Symlinks handled naturally by `Path.resolve()` — if resolved path escapes root, request is rejected
- Only serve recognized image file extensions (jpg, jpeg, png, gif, webp, bmp, tiff)

**Thumbnail strategy:**
- `/api/explore/local/image?thumbnail=true` returns a downscaled version (max 300px on longest side) for grid display
- Without `?thumbnail=true`, serves the full-resolution image (used when user clicks to send to canvas)

**Response format for `/api/explore/local`:**
```json
{
  "path": "/Users/david/comics/one-piece",
  "directories": [
    { "name": "Chapter 001" },
    { "name": "Chapter 002" }
  ],
  "files": [
    { "name": "cover.jpg" }
  ]
}
```

Notes:
- No `parent` field — frontend computes parent from current path
- No `image_count` or `size` — avoids expensive I/O on every listing request
- Directories and files sorted alphabetically (natural sort for numeric names)

**Breadcrumb behavior:**
- Shows path segments relative to the root input path
- Each segment is clickable to navigate directly
- Root segment shows folder icon

### Pydantic Models

Add to `backend/models/schemas.py`:
- `LocalBrowseItem` — name field for directory or file entries
- `LocalBrowseResponse` — path, directories list, files list

## Feature 2: Crop Overlay — All Import Paths

### Problem

The crop overlay (`openCropOverlay`) already exists and works well, but is only triggered in one narrow code path: Grok provider with a non-"auto" aspect ratio. All other import paths (drop, paste, file picker, Explore tab) bypass it entirely.

### Design

**Wire `openCropOverlay` to all image import entry points:**

1. **File drop** (both NovelAI and Grok modes)
2. **Clipboard paste**
3. **File picker** (Grok refs panel "Add Reference" button)
4. **Explore tab image click** (`useExploreImage` — both URL and new Local mode)

**Implementation note:** Callers that have base64/blob data (like `useExploreImage`) must create a temporary `Image()` element and wait for `onload` before passing to `openCropOverlay`, which expects an `HTMLImageElement` with `naturalWidth`/`naturalHeight`.

**Behavior:**
- When an image enters any import path, open the crop overlay
- Display: source image dimensions, target dimensions (based on current generation settings)
- Actions: Fit / Fill / manual drag-to-crop / **Skip** (use original image as-is)
- After crop confirm or skip, proceed with existing logic (set as source, add as ref, add as layer, etc.)

**Edge cases:**
- If image already matches target dimensions exactly: skip overlay, proceed directly
- Grok "auto" aspect ratio: still show overlay so user can see dimensions and optionally crop
- Multiple rapid imports (e.g., dropping several files): process only the first one through crop overlay; ignore subsequent drops while overlay is open

## Non-Goals

- No ComicCrawler library integration in the app
- No credential/cookie management UI
- No built-in download manager
- No changes to existing URL-based Explore functionality

## Files to Modify

**Frontend:**
- `frontend/index.html` — Add Local sub-tab UI, sub-tab switching markup
- `frontend/js/app.js` — Local browser logic, breadcrumb navigation, wire crop overlay to all import paths
- `frontend/css/style.css` — Folder card styles, sub-tab styles, breadcrumb styles

**Backend:**
- `backend/api/routes.py` — Add `/api/explore/local` and `/api/explore/local/image` endpoints
- `backend/models/schemas.py` — Add `LocalBrowseResponse` and related models

## Dependencies

None. Both features use only existing libraries and patterns. Reuses `_resolve_gallery_path` for path validation.
