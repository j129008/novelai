# NovelAI Image Generator

Local web app for generating AI images via the NovelAI API and xAI Grok API.

## Tech Stack

- **Backend:** Python FastAPI + Uvicorn
- **Frontend:** Vanilla HTML/CSS/JS (no build tools, no frameworks)
- **Image Processing:** Pillow, NumPy, SciPy
- **HTTP Client:** httpx
- **AI Providers:** NovelAI (anime/illustration), xAI Grok (realistic/video)

## Project Structure

```
backend/
├── main.py              # FastAPI entry point (serves frontend + API)
├── api/
│   ├── routes.py        # API endpoints (/api/*)
│   ├── novelai.py       # NovelAI API client & image processing
│   ├── grok.py          # xAI Grok API client (image, video, vision, chat)
│   ├── tagger.py        # WD Tagger model for image analysis
│   └── florence.py      # Florence model integration
├── models/schemas.py    # Pydantic request/response models
├── data/
│   ├── tags.csv         # Tag autocomplete database (140K danbooru tags)
│   ├── tag_categories.json   # 14 curated tag categories
│   └── tag_cooccurrence.json # Tag co-occurrence data for suggestions
└── requirements.txt
frontend/
├── index.html           # Single-page app (canvas-centric layout)
├── css/style.css        # All styles (neutral gray + blue accent theme)
└── js/
    ├── app.js           # Main logic, prompt bar, settings, init
    ├── generate.js      # Generation logic (NovelAI + Grok routing)
    ├── characters.js    # Character system (markers, popovers, positions)
    ├── layers.js        # Layer system (compositing, tabs, tools)
    ├── gallery.js       # History gallery, lightbox, load settings
    ├── tags.js          # Tag Intelligence panel + autocomplete
    ├── tag-intelligence.js  # Optimize/refine history, discoveries, saved tags
    ├── crop.js          # Image crop/pan for img2img
    ├── explore.js       # Image exploration tools
    ├── provider.js      # Provider switching (NovelAI/Grok)
    └── state.js         # Global state management + undo/redo
```

## Running

```bash
pip install -r backend/requirements.txt
python backend/main.py
# Serves at http://0.0.0.0:8000
```

## UI Architecture (Canvas-Centric)

The app uses a fullscreen canvas layout with no sidebar:

```
┌────────────────────────────────────────────────┐
│ [Canvas][History][Explore][Tags]     [Input|Out]│ ← floating tab bar
│                                            ┌──┐│
│                                            │L1││ ← layer tabs (right edge)
│         [generated image fills canvas]     │L2││    click=select, drag=reorder
│                                            │+ ││
│              ①  ②                         └──┘│ ← character markers
│                                                │    click=popover, drag=position
│ prompt text... Seed:xxx [Refine][Layer][...][G] │ ← collapsed prompt bar
└────────────────────────────────────────────────┘
```

Key patterns:
- **Prompt bar** collapses to one line, expands on click, auto-collapses after generation
- **Character markers** on canvas with popover editors (Alt+click or +Char to add)
- **Layer tabs** on right edge like paper sheets (pointer-event drag to reorder)
- **All floating panels** use `backdrop-filter: blur` glass effect
- **Source of truth** remains in hidden sidebar elements (`#prompt`, `#negative-prompt`, etc.)
- **Canvas bar mirrors** sync bidirectionally with hidden sidebar via `input` events
- **Settings popover** reparented to `document.body` (avoids `display:none` sidebar clipping)

## Key Backend APIs

| Endpoint | Purpose |
|----------|---------|
| `POST /api/generate` | NovelAI image generation |
| `POST /api/grok/generate-image` | Grok image generation |
| `POST /api/grok/generate-video` | Grok video generation |
| `POST /api/prompt-assist` | Prompt optimization/generation (modes: tags, description, edit, optimize) |
| `POST /api/prompt-refine` | Image analysis + prompt refinement |
| `POST /api/suggest-tags` | Co-occurrence-based tag suggestions |
| `POST /api/analyze-image` | WD Tagger image analysis |
| `GET /api/tags` | Tag search (140K database) |
| `GET /api/gallery` | Gallery file listing |
| `GET/POST /api/settings` | App settings (output directory) |

## Optimize Prompt System

The optimize feature uses Grok (`grok-3-mini`) with `_NOVELAI_GUIDE` (based on official docs.novelai.net):
- Tags use **spaces not underscores** (`long hair` not `long_hair`)
- Rating tags must use `rating:` prefix (`rating:explicit` not bare `explicit`)
- Multi-character: base section must be **rich** (8+ atmospheric tags), character sections only appearance
- Emphasis syntax preserved exactly (`{boost}`, `[weaken]`, `1.5::weight::`)
- `response_format: {"type": "json_object"}` enforces valid JSON responses
- Robust `_parse_grok_json()` with 3-tier fallback parsing

## Rules

- **Never commit `.env`** or any file containing API tokens
- All API calls go through the backend — never expose tokens to frontend
- Keep frontend simple: no frameworks, no build tools
- Use python-dotenv for environment variable management
- Generated images go to user-configured output directory
- **Never use `output.innerHTML = ""`** in generate.js or layers.js — use `clearOutput()` to preserve `#char-popover` and `.char-marker` elements
- **Popover elements** must live outside `#output` (in `#canvas-drop-target`) to survive output clearing
- **Flex containers** holding images need `height: 0` to prevent image stretching beyond bounds
- **`preventDefault` on `mousedown`** blocks native `<select>` dropdowns — never apply to select elements
- **Reparent popovers** to `document.body` when their parent container has `display:none`

## Team (Sub-Agents)

This project uses a team of sub-agents (`.claude/agents/`):

| Agent | Role | Responsibilities |
|-------|------|-----------------|
| **Steve Jobs** | PM | Product vision, feature specs, prioritization, UI/UX final call |
| **Guido van Rossum** | Backend Engineer | FastAPI endpoints, API integrations, Pythonic server-side logic |
| **Lea Verou** | Frontend Engineer | UI components, CSS mastery, vanilla HTML/CSS/JS |
| **James Whittaker** | QA Engineer | Google-level testing rigor, endpoint validation, bug catching |
| **Donald Knuth** | Tech Writer | Documentation, API references, user guides, literate programming |
| **Linus Torvalds** | Reviewer & Merger | Code review, quality enforcement, merge gatekeeper |

### Workflow
1. **Steve Jobs** defines what to build (specs & priorities)
2. **Guido van Rossum** / **Lea Verou** implement the changes
3. **James Whittaker** tests functionality and catches bugs — must screenshot and verify
4. **Donald Knuth** writes/updates documentation
5. **Linus Torvalds** reviews code and merges approved changes
6. **Steve Jobs** does final product review before shipping
