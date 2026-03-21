# NovelAI Image Generator

A local-first power tool for AI image generation. Built to solve the pain points I hit daily when using NovelAI's API for creative work.

## The Problem

NovelAI ships a capable diffusion model, but its official web UI is designed for casual use. Once you want to do serious, iterative creative work, you run into friction:

**Prompt engineering is trial and error.** You type tags, generate, tweak, regenerate — with no feedback loop. There's no autocomplete, no way to know which tags actually exist in the model's vocabulary, and no systematic way to explore what a tag *does* to your output.

**Multi-character composition is painful.** The API supports per-character prompts with spatial coordinates, but the official UI barely exposes this. Positioning multiple characters requires manual JSON editing or guesswork.

**There's no image management.** Generated images land in a flat folder. You lose the prompt, seed, and parameters unless you manually track them. Iterating on a previous result means re-typing everything.

**Reference workflows are manual.** Want to use a web image as a style reference or img2img source? You're downloading, converting, uploading. Want to see what tags an existing image *would* produce? No built-in way.

## What This Solves

This app wraps the NovelAI (and Grok) APIs with a workflow-oriented UI that makes the creative loop faster:

### Prompt Intelligence
- **Tag autocomplete** against a 400k+ tag database with categories and aliases — know what the model actually understands
- **Prompt DNA** — analyzes your current prompt and suggests tags you haven't tried, using a curated co-occurrence graph. Three modes: Boosters (commonly paired), Contrasts (different direction), Wildcards (surprise)
- **Prompt Autopsy** — drop any image in, get its tags back via WD Tagger v3 (runs locally via ONNX). Reverse-engineer what makes an image work

### Systematic Exploration
- **Variation Dial** — pick a dimension (lighting, art style, composition, mood), generate 4 variants with one click. Stop guessing, start comparing
- **Tag Browser** — browse tags by curated categories (hair, eyes, clothing, poses...) instead of memorizing vocabulary

### Multi-Character Composition
- Up to 5 characters with individual prompts
- Visual 2D canvas for spatial positioning (click to place)
- Character memory — recently used characters persist across sessions
- Interaction descriptions between characters

### Image Management
- Auto-saves every generation with full metadata embedded in PNG
- Gallery with folder organization, move/delete, metadata preview
- Click any gallery image to reload its exact parameters
- Lightbox with keyboard navigation

### Dual Provider: NovelAI + Grok
- **Unified interface** for both NovelAI and xAI Grok — same prompt field, same gallery, switch with one click
- **Grok image generation** with aspect ratio and resolution control (1k/2k), plus image editing mode
- **Grok video generation** — text-to-video and image-to-video (5–15s), with real-time progress via SSE streaming
- **Usage dashboard** — live cost tracking with per-model/per-type breakdown so you don't blow your budget

### Reference Pipeline
- **Image Explorer** — paste a URL, browse its images, click to use as img2img source. No download/convert/upload cycle
- **Clipboard paste** — Cmd+V an image directly as a source
- **Img2Img** with crop/pan/zoom tools that match your target canvas size
- **Vibe Transfer** — extract style from reference images without img2img artifacts

## Architecture

```
browser ──→ FastAPI backend ──→ NovelAI API
                │                 Grok API
                │
                ├── Tag DB (400k tags, co-occurrence graph)
                ├── WD Tagger v3 (ONNX, downloaded on first use)
                └── Gallery (PNG files with embedded metadata)
```

The backend acts as a secure proxy — API tokens never reach the browser. All image processing (metadata extraction, tag analysis, image proxying) happens server-side.

**No build tools.** The frontend is vanilla HTML/CSS/JS served as static files. One `python backend/main.py` and you're running.

| Layer | Stack |
|-------|-------|
| Server | Python, FastAPI, Uvicorn |
| HTTP | httpx (async) |
| Image analysis | ONNX Runtime, Pillow, NumPy |
| Frontend | Vanilla JS (~5.4k lines), CSS (~3.2k lines) |
| Data | 400k-tag CSV, curated co-occurrence JSON |

## Setup

```bash
# 1. Clone and configure
git clone <repo-url> && cd novelai
cp .env.example .env
# Edit .env — add your NovelAI API token

# 2. Install and run
pip install -r backend/requirements.txt
python backend/main.py
```

Open **http://localhost:8000**. Images save to `output/` by default (configurable in Settings).

### Requirements
- Python 3.11+
- NovelAI subscription with API access
- (Optional) Grok API key for xAI integration

## Project Structure

```
backend/
├── main.py                 # Entry point — serves frontend + API
├── api/
│   ├── routes.py           # 30+ API endpoints
│   ├── novelai.py          # NovelAI API client
│   ├── grok.py             # Grok/xAI API client (image + video)
│   └── tagger.py           # WD Tagger v3 (ONNX inference)
├── models/schemas.py       # Pydantic request/response models
└── data/
    ├── tags.csv            # Tag database (400k entries)
    ├── tag_categories.json # Curated category hierarchy
    └── tag_cooccurrence.json # Tag relationship graph

frontend/
├── index.html              # Single-page app
├── js/app.js               # All frontend logic
└── css/style.css           # Styles + design system
```

## Docs

- [API Reference](docs/api-reference.md) — all endpoints with request/response schemas
- [User Guide](docs/user-guide.md) — feature walkthrough
