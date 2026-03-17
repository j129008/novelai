# NovelAI Image Generator

Local web app for generating AI images via the NovelAI API.

## Tech Stack

- **Backend:** Python FastAPI + Uvicorn
- **Frontend:** Vanilla HTML/CSS/JS (no build tools)
- **Image Processing:** Pillow, NumPy, SciPy
- **HTTP Client:** httpx

## Project Structure

```
backend/
├── main.py              # FastAPI entry point (serves frontend + API)
├── api/
│   ├── routes.py        # API endpoints (/api/*)
│   └── novelai.py       # NovelAI API client & image processing
├── models/schemas.py    # Pydantic request/response models
├── data/tags.csv        # Tag autocomplete database
└── requirements.txt
frontend/
├── index.html           # Single-page app
├── js/app.js            # Frontend logic
└── css/style.css
```

## Running

```bash
pip install -r backend/requirements.txt
python backend/main.py
# Serves at http://0.0.0.0:8000
```

## Rules

- **Never commit `.env`** or any file containing API tokens
- All API calls go through the backend — never expose tokens to frontend
- Keep frontend simple: no frameworks, no build tools
- Use python-dotenv for environment variable management
- Generated images go to user-configured output directory

## Review Process

This project uses two sub-agent reviewers (`.claude/agents/`):
1. **Steve Jobs** — Reviews UI/UX design decisions
2. **Linus Torvalds** — Reviews code quality and architecture

Both must approve before changes are considered complete.
