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

## Team (Sub-Agents)

This project uses a team of sub-agents (`.claude/agents/`):

| Agent | Role | Responsibilities |
|-------|------|-----------------|
| **Steve Jobs** | PM | Product vision, feature specs, prioritization, UI/UX final call |
| **Guido van Rossum** | Backend Engineer | FastAPI endpoints, API integrations, Pythonic server-side logic |
| **Lea Verou** | Frontend Engineer | UI components, CSS mastery, vanilla HTML/CSS/JS |
| **James Whittaker** | QA Engineer | Google-level testing rigor, endpoint validation, bug catching |
| **Linus Torvalds** | Reviewer & Merger | Code review, quality enforcement, merge gatekeeper |

### Workflow
1. **Steve Jobs** defines what to build (specs & priorities)
2. **Guido van Rossum** / **Lea Verou** implement the changes
3. **James Whittaker** tests functionality and catches bugs
4. **Linus Torvalds** reviews code and merges approved changes
5. **Steve Jobs** does final product review before shipping
