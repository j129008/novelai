import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

# Load .env from project root
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from api.routes import router

app = FastAPI(title="NovelAI Image Generator")
app.include_router(router)

# Serve frontend
frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
