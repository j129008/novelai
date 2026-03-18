# NovelAI Image Generator

A local web application that lets you generate images through the NovelAI API. The backend holds your API token securely; the browser never sees it. Generated images are saved automatically to a configurable output folder.

## Prerequisites

- Python 3.11 or later
- pip
- A NovelAI account with active API access (Opus subscription or API credits)

## Setup

```bash
# 1. Clone the repository
git clone <repo-url>
cd novelai

# 2. Configure your API token
cp .env.example .env
# Open .env and replace "your_token_here" with your NovelAI API token

# 3. Install dependencies
pip install -r backend/requirements.txt

# 4. Start the server
python backend/main.py
```

Open http://localhost:8000 in your browser.

## Where Images Are Saved

Images are saved automatically to `output/` at the project root after every successful generation. You can change this path in the Settings panel (gear icon in the top-right corner).

## Project Structure

| Path | Description |
|------|-------------|
| `backend/main.py` | FastAPI entry point; serves frontend and API |
| `backend/api/routes.py` | All API endpoint handlers |
| `backend/api/novelai.py` | NovelAI API client and image processing |
| `backend/models/schemas.py` | Pydantic request and response models |
| `backend/data/tags.csv` | Tag autocomplete database |
| `frontend/index.html` | Single-page application |
| `frontend/js/app.js` | All frontend logic |
| `frontend/css/style.css` | Styles |
| `output/` | Generated images (created on first run) |

## Further Reading

- [API Reference](docs/api-reference.md) — endpoint documentation for developers
- [User Guide](docs/user-guide.md) — how to use every feature
