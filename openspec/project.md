# Project Context

## Purpose
Local web app for generating AI images via the NovelAI API and xAI Grok API. Canvas-centric UI with layer compositing, character positioning, and tag intelligence.

## Tech Stack
- **Backend:** Python FastAPI + Uvicorn
- **Frontend:** Vanilla HTML/CSS/JS (no build tools, no frameworks)
- **Image Processing:** Pillow, NumPy, SciPy
- **HTTP Client:** httpx
- **AI Providers:** NovelAI (anime/illustration), xAI Grok (realistic/video)

## Project Conventions

### Code Style
- Frontend: vanilla JS, no frameworks, no build tools
- Backend: Python with Pydantic models, FastAPI routes
- CSS: design tokens via CSS custom properties (--accent, --bg-*, --text-*, etc.)
- No TypeScript, no JSX, no bundlers

### Architecture Patterns
- Canvas-centric fullscreen layout with floating panels
- Layer system for image compositing
- Character markers on canvas with popover editors
- All floating panels use backdrop-filter blur glass effect
- Source of truth in hidden sidebar elements, canvas bar mirrors sync bidirectionally

### Testing Strategy
- Playwright for E2E testing
- Manual QA via sub-agent team

### Git Workflow
- Feature branches off main
- Sub-agent team review before merge

## Domain Context
- NovelAI uses danbooru-style tags (spaces not underscores)
- Rating tags must use `rating:` prefix
- Multi-character prompts: base section for atmosphere, character sections for appearance
- Emphasis syntax: `{boost}`, `[weaken]`, `1.5::weight::`
- img2img uses base64 PNG images with strength parameter

## Important Constraints
- Never commit .env or API tokens
- All API calls through backend (never expose tokens to frontend)
- Never use `output.innerHTML = ""` — use `clearOutput()` to preserve char-popover and char-marker elements
- Popover elements must live outside #output in #canvas-drop-target
- Flex containers holding images need `height: 0` to prevent stretching

## External Dependencies
- NovelAI API (image generation)
- xAI Grok API (image, video, vision, chat)
- WD Tagger model (image analysis)
