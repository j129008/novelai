# NovelAI Image Generator — Local Web App

## Project Overview
A local web application for generating AI images using the NovelAI API.
Backend: Python FastAPI. Frontend: Vanilla HTML/CSS/JS (single page app).

## Architecture
```
novelai/
├── backend/
│   ├── main.py          # FastAPI app entry point
│   ├── api/
│   │   ├── routes.py    # API endpoints
│   │   └── novelai.py   # NovelAI API client
│   ├── models/
│   │   └── schemas.py   # Pydantic models
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── css/
│   │   └── style.css
│   └── js/
│       └── app.js
├── .env                 # API credentials (DO NOT COMMIT)
├── .gitignore
└── CLAUDE.md
```

## Key Features
- Text-to-image generation with prompt & undesired content (negative prompt)
- Image-to-image generation
- Character reference / Vibe Transfer
- Real-time preview
- Parameter controls: model, sampler, steps, CFG scale, seed, resolution

## NovelAI API
- Endpoint: `POST https://image.novelai.net/ai/generate-image`
- Auth: `Authorization: Bearer {token}` (token from .env)
- Response: zip file containing the generated image

## Development
```bash
# Backend
cd backend && pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# Frontend is served by FastAPI static files
```

## Review Process
This project uses two sub-agent reviewers:
1. **Steve Jobs** (UIUX agent) — Reviews all UI/UX decisions
2. **Linus Torvalds** (Engineering agent) — Reviews all code quality and architecture

Both must approve before the project is considered complete.

## Rules
- Never commit .env or any file containing API tokens
- Use python-dotenv for environment variable management
- All API calls go through the backend (never expose token to frontend)
- Keep frontend simple — no build tools, no frameworks
