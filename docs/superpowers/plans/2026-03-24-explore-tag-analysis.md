# Explore Image Tag Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add on-demand image tag analysis (WD Tagger + Grok Vision) to the Explore Local tab with `.tags/` sidecar caching and click-to-insert tag pills.

**Architecture:** Backend adds 3 endpoints for analyze/tags/batch, a new Grok Vision function in grok.py. Frontend adds an analysis drawer panel below the image grid, tag pills with click-to-insert, and grid dot indicators for cached results.

**Tech Stack:** Python FastAPI, xAI chat completions API (grok-2-vision), WD Tagger (ONNX), vanilla HTML/CSS/JS

**Spec:** `docs/superpowers/specs/2026-03-24-explore-tag-analysis-design.md`

---

## Task 1: Backend — Pydantic Models + Settings

**Files:**
- Modify: `backend/models/schemas.py` (add new models at end)
- Modify: `backend/api/routes.py:735-741` (add `xai_api_configured` to settings)

- [ ] **Step 1: Add Pydantic models for tag analysis**

Add to `backend/models/schemas.py` at the end:

```python
# ---------------------------------------------------------------------------
# Explore Tag Analysis
# ---------------------------------------------------------------------------

class LocalAnalyzeRequest(BaseModel):
    path: str = Field(min_length=1)
    method: Literal["wd", "grok"]


class WdTag(BaseModel):
    name: str
    score: float
    category: str


class GrokAnalysis(BaseModel):
    tags: list[str]
    description: str


class LocalAnalyzeResponse(BaseModel):
    wd: Optional[list[WdTag]] = None
    grok: Optional[GrokAnalysis] = None


class LocalTagsCacheResponse(BaseModel):
    wd: Optional[list[WdTag]] = None
    grok: Optional[GrokAnalysis] = None


class LocalTagsBatchResponse(BaseModel):
    analyzed: dict[str, list[str]]  # filename -> ["wd", "grok"]
```

- [ ] **Step 2: Add imports to routes.py**

Add to the imports block in `backend/api/routes.py` (around line 23-44):

```python
    LocalAnalyzeRequest,
    LocalAnalyzeResponse,
    LocalTagsBatchResponse,
    LocalTagsCacheResponse,
    GrokAnalysis,
    WdTag,
```

- [ ] **Step 3: Add `xai_api_configured` to settings response**

In `backend/api/routes.py`, modify `get_settings` (line 735):

```python
@router.get("/settings")
async def get_settings():
    settings = _load_settings()
    return {
        "output_dir": settings.get("output_dir", str(_default_output)),
        "local_browse_root": settings.get("local_browse_root", ""),
        "xai_api_configured": bool(XAI_API_KEY),
    }
```

- [ ] **Step 4: Commit**

```bash
git add backend/models/schemas.py backend/api/routes.py
git commit -m "feat: add Pydantic models and settings for tag analysis"
```

---

## Task 2: Backend — Tags Cache Read Endpoints

**Files:**
- Modify: `backend/api/routes.py` (add after `/api/explore/local/image` endpoint)

These read-only endpoints are safe and simple — implement them first so the frontend can use them while we build the analyze endpoint.

- [ ] **Step 1: Add helper to read/write tag cache**

Add after `_get_local_browse_root` (around line 103):

```python
def _get_tags_cache_path(root: Path, image_path: str) -> Path:
    """Get the .tags/ cache file path for an image. Validates path security."""
    image_file = _resolve_gallery_path(root, image_path)
    if not image_file.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    tags_dir = image_file.parent / ".tags"
    return tags_dir / (image_file.name + ".json")


def _read_tags_cache(cache_path: Path) -> dict:
    """Read existing cache file, return empty dict if not found."""
    if cache_path.exists():
        try:
            return json.loads(cache_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _write_tags_cache(cache_path: Path, method: str, data: dict | list):
    """Read-modify-write: merge new method data into existing cache."""
    existing = _read_tags_cache(cache_path)
    existing[method] = data
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
```

- [ ] **Step 2: Add `GET /api/explore/local/tags` endpoint**

```python
@router.get("/explore/local/tags", response_model=LocalTagsCacheResponse)
async def get_local_tags(path: str = Query(min_length=1)):
    root = _get_local_browse_root()
    cache_path = _get_tags_cache_path(root, path)
    data = _read_tags_cache(cache_path)
    return LocalTagsCacheResponse(**data)
```

- [ ] **Step 3: Add `GET /api/explore/local/tags/batch` endpoint**

```python
@router.get("/explore/local/tags/batch", response_model=LocalTagsBatchResponse)
async def get_local_tags_batch(path: str = Query(default="")):
    root = _get_local_browse_root()
    current = _resolve_gallery_path(root, path)
    if not current.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")

    tags_dir = current / ".tags"
    analyzed: dict[str, list[str]] = {}
    if tags_dir.is_dir():
        for f in tags_dir.iterdir():
            if f.suffix == ".json" and not f.name.startswith("."):
                # Strip the .json suffix to get original filename
                # e.g. "page01.jpg.json" -> "page01.jpg"
                original_name = f.name[:-5]  # remove ".json"
                try:
                    data = json.loads(f.read_text(encoding="utf-8"))
                    methods = [k for k in ("wd", "grok") if k in data]
                    if methods:
                        analyzed[original_name] = methods
                except (json.JSONDecodeError, OSError):
                    pass
    return LocalTagsBatchResponse(analyzed=analyzed)
```

- [ ] **Step 4: Commit**

```bash
git add backend/api/routes.py
git commit -m "feat: add tag cache read endpoints and helpers"
```

---

## Task 3: Backend — Grok Vision Function

**Files:**
- Modify: `backend/api/grok.py` (add `analyze_image_vision` function)

- [ ] **Step 1: Add `analyze_image_vision` to grok.py**

Add at the end of `backend/api/grok.py`:

```python
CHAT_URL = "https://api.x.ai/v1/chat/completions"

_VISION_SYSTEM_PROMPT = """You are an image analysis assistant. Analyze the provided image and return a JSON object with exactly two fields:
- "tags": an array of danbooru-style tags (lowercase, underscored, e.g. "1girl", "long_hair", "black_dress"). Include tags for: characters, hair, clothing, pose, expression, setting, lighting, art style. Order by relevance. Maximum 30 tags.
- "description": a single paragraph natural language description of the image, suitable as an image generation prompt. 2-3 sentences, descriptive and specific.

Return ONLY the JSON object, no markdown formatting."""


async def analyze_image_vision(api_key: str, image_b64: str) -> dict:
    """Analyze an image using Grok Vision. Returns {"tags": [...], "description": "..."}."""
    import re

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "grok-2-vision-latest",
        "messages": [
            {"role": "system", "content": _VISION_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                    },
                    {"type": "text", "text": "Analyze this image."},
                ],
            },
        ],
        "temperature": 0.2,
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(CHAT_URL, json=payload, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"{resp.status_code}: {resp.text[:500]}")

    text = resp.json()["choices"][0]["message"]["content"]

    # Strip markdown code fences defensively
    text = re.sub(r"^```(?:json)?\s*", "", text.strip())
    text = re.sub(r"\s*```$", "", text.strip())

    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        raise RuntimeError(f"Failed to parse Grok Vision response as JSON: {text[:200]}")

    if "tags" not in result or "description" not in result:
        raise RuntimeError(f"Grok Vision response missing required fields: {list(result.keys())}")

    return result
```

Also add `import json` at the top of `grok.py` (after `import base64`).

- [ ] **Step 2: Commit**

```bash
git add backend/api/grok.py
git commit -m "feat: add Grok Vision image analysis function"
```

---

## Task 4: Backend — Analyze Endpoint

**Files:**
- Modify: `backend/api/routes.py` (add `POST /api/explore/local/analyze`)

- [ ] **Step 1: Add the analyze endpoint**

Add after the tags/batch endpoint:

```python
@router.post("/explore/local/analyze", response_model=LocalAnalyzeResponse)
async def analyze_local_image(req: LocalAnalyzeRequest):
    root = _get_local_browse_root()
    image_file = _resolve_gallery_path(root, req.path)
    if not image_file.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    if image_file.suffix.lower() not in _IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Not a recognized image file")

    cache_path = _get_tags_cache_path(root, req.path)

    if req.method == "wd":
        from api.tagger import ensure_model_loaded, get_model_status, run_inference

        status = ensure_model_loaded()
        if status in ("not_started", "downloading"):
            _, progress = get_model_status()
            raise HTTPException(status_code=202, detail=f"Model downloading: {progress}%")
        if status == "failed":
            raise HTTPException(status_code=503, detail="Tagger model failed to load")

        # Read file, base64-encode, run inference
        image_bytes = image_file.read_bytes()
        image_b64 = base64.b64encode(image_bytes).decode()
        raw_tags = run_inference(image_b64)

        wd_data = [{"name": t["name"], "score": t["score"], "category": t["category"]} for t in raw_tags]
        _write_tags_cache(cache_path, "wd", wd_data)
        return LocalAnalyzeResponse(wd=[WdTag(**t) for t in wd_data])

    elif req.method == "grok":
        if not XAI_API_KEY:
            raise HTTPException(status_code=503, detail="XAI_API_KEY not configured")

        from api.grok import analyze_image_vision
        from PIL import Image as PILImage

        # Resize to max 1024px to save API tokens
        img = PILImage.open(image_file)
        if max(img.size) > 1024:
            img.thumbnail((1024, 1024))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        image_b64 = base64.b64encode(buf.getvalue()).decode()

        try:
            result = await analyze_image_vision(XAI_API_KEY, image_b64)
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc))

        grok_data = {"tags": result["tags"], "description": result["description"]}
        _write_tags_cache(cache_path, "grok", grok_data)
        return LocalAnalyzeResponse(grok=GrokAnalysis(**grok_data))

    raise HTTPException(status_code=400, detail="Invalid method")
```

- [ ] **Step 2: Commit**

```bash
git add backend/api/routes.py
git commit -m "feat: add /api/explore/local/analyze endpoint"
```

---

## Task 5: Frontend — Analysis Panel HTML & CSS

**Files:**
- Modify: `frontend/index.html` (add panel markup inside `#explore-mode-local`, after `#local-grid`)
- Modify: `frontend/css/style.css` (add analysis panel styles)

- [ ] **Step 1: Add analysis panel HTML**

In `frontend/index.html`, find `<div id="local-grid" class="explore-grid"></div>` inside `#explore-mode-local`. Add this AFTER it:

```html
            <div id="local-analysis-panel" class="local-analysis-panel" style="display:none">
              <div class="local-analysis-content">
                <div class="local-analysis-preview">
                  <img id="local-analysis-img" alt="">
                </div>
                <div class="local-analysis-right">
                  <div class="local-analysis-actions">
                    <button id="local-analyze-wd" class="btn-action" type="button">WD Tagger</button>
                    <button id="local-analyze-grok" class="btn-action" type="button">Grok Vision</button>
                  </div>
                  <div id="local-analysis-status" class="explore-status" style="display:none"></div>
                  <div id="local-analysis-results" class="local-analysis-results"></div>
                </div>
              </div>
              <div class="local-analysis-footer">
                <button id="local-analysis-reanalyze-wd" class="btn-action local-analysis-reanalyze" type="button" style="display:none">Re-analyze WD</button>
                <button id="local-analysis-reanalyze-grok" class="btn-action local-analysis-reanalyze" type="button" style="display:none">Re-analyze Grok</button>
                <button id="local-analysis-send" class="btn-action btn-action--confirm" type="button">Send to Canvas</button>
              </div>
            </div>
```

- [ ] **Step 2: Add CSS for analysis panel**

Add to `frontend/css/style.css` after the folder card styles:

```css
/* ── Analysis panel ───────────────────────────────────────── */
.local-analysis-panel {
  border-top: 1px solid var(--border-muted);
  padding: 12px;
  flex-shrink: 0;
}
.local-analysis-content {
  display: flex;
  gap: 12px;
}
.local-analysis-preview {
  width: 200px;
  flex-shrink: 0;
}
.local-analysis-preview img {
  width: 100%;
  border-radius: var(--radius-sm);
  display: block;
}
.local-analysis-right {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.local-analysis-actions {
  display: flex;
  gap: 6px;
}
.local-analysis-results {
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  max-height: 250px;
  scrollbar-width: thin;
  scrollbar-color: var(--border-muted) transparent;
}
.local-analysis-section-label {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.local-analysis-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.local-analysis-tag {
  padding: 2px 8px;
  font-size: 0.75rem;
  border-radius: 999px;
  border: 1px solid var(--border-muted);
  background: var(--bg-deep);
  color: var(--text-primary);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.local-analysis-tag:hover {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}
.local-analysis-description {
  font-size: 0.8rem;
  color: var(--text-secondary);
  line-height: 1.5;
  padding: 8px;
  background: var(--bg-deep);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-muted);
}
.local-analysis-desc-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}
.local-analysis-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border-muted);
}
.local-analysis-reanalyze {
  font-size: 0.72rem;
  padding: 2px 10px;
  opacity: 0.7;
}

/* ── Grid analyzed dot indicator ──────────────────────────── */
.explore-card { position: relative; }
.explore-card-analyzed-dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  pointer-events: none;
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/index.html frontend/css/style.css
git commit -m "feat: add analysis panel HTML and CSS"
```

---

## Task 6: Frontend — Analysis Panel JS Logic

**Files:**
- Modify: `frontend/js/app.js` (inside `setupExplorePanel`, modify `browseLocalFolder` and `useLocalImage`, add analysis panel logic)

This is the largest frontend task. It changes the image click behavior from "directly open crop overlay" to "open analysis panel", adds tag rendering, click-to-insert, and grid dot indicators.

- [ ] **Step 1: Modify `browseLocalFolder` to fetch batch tags and add dot indicators**

In `browseLocalFolder` (around line 7147), after the `const data = await resp.json();` line, add a batch tags fetch:

```javascript
      // Fetch batch tag status for dot indicators
      let analyzedMap = {};
      try {
        const tagsResp = await fetch("/api/explore/local/tags/batch?path=" + encodeURIComponent(subpath));
        if (tagsResp.ok) {
          const tagsData = await tagsResp.json();
          analyzedMap = tagsData.analyzed || {};
        }
      } catch (_) {}
```

Then in the image rendering loop (around line 7177-7187), after `card.appendChild(imgEl)`, add:

```javascript
        if (analyzedMap[file.name]) {
          const dot = document.createElement("div");
          dot.className = "explore-card-analyzed-dot";
          card.appendChild(dot);
        }
```

- [ ] **Step 2: Change image click to open analysis panel instead of crop overlay**

Replace the `useLocalImage` function (around line 7236) with:

```javascript
  // ── Analysis panel state ──
  const analysisPanel = $("#local-analysis-panel");
  const analysisImg = $("#local-analysis-img");
  const analysisResults = $("#local-analysis-results");
  const analysisStatus = $("#local-analysis-status");
  const analyzeWdBtn = $("#local-analyze-wd");
  const analyzeGrokBtn = $("#local-analyze-grok");
  const analysisSendBtn = $("#local-analysis-send");
  const reanalyzeWdBtn = $("#local-analysis-reanalyze-wd");
  const reanalyzeGrokBtn = $("#local-analysis-reanalyze-grok");
  let currentAnalysisPath = "";
  let currentAnalysisDataUrl = "";

  // Check if Grok Vision is available
  fetch("/api/settings").then(r => r.json()).then(s => {
    if (!s.xai_api_configured && analyzeGrokBtn) {
      analyzeGrokBtn.disabled = true;
      analyzeGrokBtn.title = "XAI_API_KEY not configured";
    }
  }).catch(() => {});

  function openAnalysisPanel(imgPath) {
    currentAnalysisPath = imgPath;
    analysisResults.innerHTML = "";
    analysisStatus.style.display = "none";
    analysisPanel.style.display = "";
    reanalyzeWdBtn.style.display = "none";
    reanalyzeGrokBtn.style.display = "none";

    // Show preview
    analysisImg.src = "/api/explore/local/image?path=" + encodeURIComponent(imgPath);

    // Load cached tags
    fetch("/api/explore/local/tags?path=" + encodeURIComponent(imgPath))
      .then(r => r.json())
      .then(data => {
        if (data.wd) renderWdTags(data.wd);
        if (data.grok) renderGrokAnalysis(data.grok);
      })
      .catch(() => {});
  }

  function closeAnalysisPanel() {
    analysisPanel.style.display = "none";
    currentAnalysisPath = "";
  }

  function renderWdTags(tags) {
    // Remove existing WD section if any
    const existing = analysisResults.querySelector(".wd-section");
    if (existing) existing.remove();

    const section = document.createElement("div");
    section.className = "wd-section";

    const label = document.createElement("div");
    label.className = "local-analysis-section-label";
    label.textContent = "WD Tagger";
    section.appendChild(label);

    const container = document.createElement("div");
    container.className = "local-analysis-tags";
    for (const tag of tags) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "local-analysis-tag";
      pill.textContent = tag.name.replace(/_/g, " ");
      pill.title = `${tag.name} (${(tag.score * 100).toFixed(0)}%)`;
      pill.addEventListener("click", () => insertTagIntoPrompt(tag.name.replace(/_/g, " ")));
      container.appendChild(pill);
    }
    section.appendChild(container);
    analysisResults.appendChild(section);
    reanalyzeWdBtn.style.display = "";
  }

  function renderGrokAnalysis(grok) {
    const existing = analysisResults.querySelector(".grok-section");
    if (existing) existing.remove();

    const section = document.createElement("div");
    section.className = "grok-section";

    // Grok Tags
    const tagLabel = document.createElement("div");
    tagLabel.className = "local-analysis-section-label";
    tagLabel.textContent = "Grok Vision Tags";
    section.appendChild(tagLabel);

    const tagContainer = document.createElement("div");
    tagContainer.className = "local-analysis-tags";
    for (const tag of grok.tags) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "local-analysis-tag";
      pill.textContent = tag.replace(/_/g, " ");
      pill.addEventListener("click", () => insertTagIntoPrompt(tag.replace(/_/g, " ")));
      tagContainer.appendChild(pill);
    }
    section.appendChild(tagContainer);

    // Grok Description
    const descLabel = document.createElement("div");
    descLabel.className = "local-analysis-section-label";
    descLabel.textContent = "Description";
    descLabel.style.marginTop = "8px";
    section.appendChild(descLabel);

    const desc = document.createElement("div");
    desc.className = "local-analysis-description";
    desc.textContent = grok.description;
    section.appendChild(desc);

    const descActions = document.createElement("div");
    descActions.className = "local-analysis-desc-actions";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn-action";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(grok.description);
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
    });
    descActions.appendChild(copyBtn);

    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "btn-action";
    useBtn.textContent = "Use as Prompt";
    useBtn.addEventListener("click", () => {
      const el = $("#prompt");
      if (el) { el.value = grok.description; el.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    descActions.appendChild(useBtn);

    section.appendChild(descActions);
    analysisResults.appendChild(section);
    reanalyzeGrokBtn.style.display = "";
  }

  async function runAnalysis(method) {
    if (!currentAnalysisPath) return;
    analysisStatus.style.display = "block";
    analysisStatus.textContent = method === "wd" ? "Running WD Tagger..." : "Analyzing with Grok Vision...";

    try {
      const resp = await fetch("/api/explore/local/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: currentAnalysisPath, method }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Analysis failed");
      }
      const data = await resp.json();
      analysisStatus.style.display = "none";

      if (data.wd) renderWdTags(data.wd);
      if (data.grok) renderGrokAnalysis(data.grok);

      // Refresh grid to show dot indicator
      browseLocalFolder(localCurrentSubpath);
    } catch (err) {
      analysisStatus.style.display = "block";
      analysisStatus.textContent = "Error: " + err.message;
    }
  }

  // Wire up buttons
  if (analyzeWdBtn) analyzeWdBtn.addEventListener("click", () => runAnalysis("wd"));
  if (analyzeGrokBtn) analyzeGrokBtn.addEventListener("click", () => runAnalysis("grok"));
  if (reanalyzeWdBtn) reanalyzeWdBtn.addEventListener("click", () => runAnalysis("wd"));
  if (reanalyzeGrokBtn) reanalyzeGrokBtn.addEventListener("click", () => runAnalysis("grok"));

  // Send to Canvas button — load full image and open crop overlay
  if (analysisSendBtn) {
    analysisSendBtn.addEventListener("click", async () => {
      if (!currentAnalysisPath) return;
      try {
        const resp = await fetch("/api/explore/local/image?path=" + encodeURIComponent(currentAnalysisPath));
        if (!resp.ok) throw new Error("Failed to load image");
        const blob = await resp.blob();
        const reader = new FileReader();
        reader.onload = (ev) => {
          const img = new Image();
          img.onload = () => { openCropOverlay(img); };
          img.src = ev.target.result;
        };
        reader.readAsDataURL(blob);
      } catch (err) {
        showError("Failed to load image: " + err.message);
      }
    });
  }

  // Image click in local grid — open analysis panel instead of crop overlay
  async function useLocalImage(imgPath) {
    openAnalysisPanel(imgPath);
  }
```

Note: This replaces the entire old `useLocalImage` function. The old one opened crop overlay directly; the new one opens the analysis panel.

- [ ] **Step 3: Commit**

```bash
git add frontend/js/app.js
git commit -m "feat: implement analysis panel logic with tag pills and click-to-insert"
```

---

## Task 7: Manual QA Testing

- [ ] **Step 1: Start the server**

```bash
cd /Users/david/novelai && python backend/main.py
```

- [ ] **Step 2: Test analysis panel**

1. Open http://0.0.0.0:8000, go to Explore → Local
2. Browse to a folder with images
3. Click an image → analysis panel should expand below grid (not crop overlay)
4. Click "WD Tagger" → loading → tag pills appear
5. Click a tag pill → should insert into prompt textarea
6. Click "Grok Vision" (if API key configured) → loading → tags + description appear
7. Click "Copy" on description → clipboard
8. Click "Use as Prompt" → replaces prompt text
9. Click "Send to Canvas" → crop overlay opens
10. Go back, click another image → panel updates
11. Verify dot indicators on analyzed images in grid
12. Verify "Re-analyze WD" / "Re-analyze Grok" buttons appear for cached results

- [ ] **Step 3: Test cache persistence**

1. Analyze an image
2. Reload page, navigate back to same folder
3. Click same image → cached results should appear instantly (no loading)
4. Check `.tags/` folder exists in the browsed directory

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "fix: QA fixes for tag analysis"
```
