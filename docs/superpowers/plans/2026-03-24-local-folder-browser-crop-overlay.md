# Local Folder Browser + Crop Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local folder browsing to the Explore tab and wire the existing crop overlay to all image import paths.

**Architecture:** Two independent features. Feature 1 adds backend endpoints to list/serve local files and a new "Local" sub-tab in the Explore panel. Feature 2 extracts a shared `applyImportedImage` function, then modifies `loadImageFile` and `useExploreImage` to route through `openCropOverlay`. Paste and drop handlers for NovelAI mode already route through `showPasteActionPopup` -> `loadImageFile`, so the crop overlay is automatically wired via the `loadImageFile` change — no changes needed to the paste/drop handlers themselves.

**Tech Stack:** Python FastAPI (backend), vanilla HTML/CSS/JS (frontend), Pillow (thumbnails)

**Spec:** `docs/superpowers/specs/2026-03-24-local-folder-browser-crop-overlay-design.md`

---

## Task 1: Backend — Pydantic Models for Local Browse

**Files:**
- Modify: `backend/models/schemas.py:168-218` (add after ExploreLink, before ExplorePageResponse)

- [ ] **Step 1: Add Pydantic models**

Add these models to `backend/models/schemas.py` after the `ExploreLink` class (around line 208):

```python
# ---------------------------------------------------------------------------
# Local Folder Browser
# ---------------------------------------------------------------------------

class LocalBrowseItem(BaseModel):
    name: str

class LocalBrowseResponse(BaseModel):
    path: str
    directories: list[LocalBrowseItem]
    files: list[LocalBrowseItem]
```

- [ ] **Step 2: Add import to routes.py**

In `backend/api/routes.py` line 23-40 imports block, add `LocalBrowseItem, LocalBrowseResponse` to the imports from `models.schemas`.

- [ ] **Step 3: Commit**

```bash
git add backend/models/schemas.py backend/api/routes.py
git commit -m "feat: add Pydantic models for local folder browser"
```

---

## Task 2: Backend — Settings for Local Browse Root

**Files:**
- Modify: `backend/api/routes.py:709-727` (SettingsUpdate model + settings endpoints)

- [ ] **Step 1: Add `local_browse_root` to SettingsUpdate**

In `backend/api/routes.py`, the `SettingsUpdate` model (line 709):

```python
class SettingsUpdate(BaseModel):
    output_dir: str | None = None
    local_browse_root: str | None = None
```

- [ ] **Step 2: Update `get_settings` to include `local_browse_root`**

Modify `get_settings` (line 713):

```python
@router.get("/settings")
async def get_settings():
    settings = _load_settings()
    return {
        "output_dir": settings.get("output_dir", str(_default_output)),
        "local_browse_root": settings.get("local_browse_root", ""),
    }
```

- [ ] **Step 3: Update `update_settings` to handle `local_browse_root`**

Add to `update_settings` (line 721), after the `output_dir` block:

```python
    if req.local_browse_root is not None:
        p = Path(req.local_browse_root).expanduser().resolve()
        if not p.is_dir():
            raise HTTPException(status_code=400, detail="Directory does not exist")
        _save_settings({"local_browse_root": str(p)})
```

- [ ] **Step 4: Commit**

```bash
git add backend/api/routes.py
git commit -m "feat: add local_browse_root to settings"
```

---

## Task 3: Backend — Local Browse Listing Endpoint

**Files:**
- Modify: `backend/api/routes.py` (add helper after line 83, add endpoint after `/api/explore/has-person`)

- [ ] **Step 1: Add helpers**

Add after `_get_output_dir` (around line 83):

```python
import re

_IMAGE_EXTENSIONS = frozenset((".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff"))


def _natural_sort_key(name: str):
    """Sort key that handles numeric segments naturally: 'Ch 2' < 'Ch 10'."""
    return [int(c) if c.isdigit() else c.lower() for c in re.split(r'(\d+)', name)]


def _get_local_browse_root() -> Path:
    settings = _load_settings()
    root = settings.get("local_browse_root", "")
    if not root:
        raise HTTPException(status_code=400, detail="Local browse root not configured")
    p = Path(root)
    if not p.is_dir():
        raise HTTPException(status_code=400, detail="Local browse root does not exist")
    return p
```

Note: `re` is already imported at line 8 of routes.py, so no new import needed.

- [ ] **Step 2: Add `/api/explore/local` endpoint**

Add after the existing explore endpoints (after `/api/explore/has-person`):

```python
@router.get("/explore/local", response_model=LocalBrowseResponse)
async def list_local_folder(path: str = Query(default="")):
    root = _get_local_browse_root()
    current = _resolve_gallery_path(root, path)
    if not current.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")

    directories = sorted(
        (LocalBrowseItem(name=d.name) for d in current.iterdir()
         if d.is_dir() and not d.name.startswith(".")),
        key=lambda x: _natural_sort_key(x.name),
    )
    files = sorted(
        (LocalBrowseItem(name=f.name) for f in current.iterdir()
         if f.is_file() and f.suffix.lower() in _IMAGE_EXTENSIONS
         and not f.name.startswith(".")),
        key=lambda x: _natural_sort_key(x.name),
    )
    return LocalBrowseResponse(path=path, directories=directories, files=files)
```

- [ ] **Step 3: Commit**

```bash
git add backend/api/routes.py
git commit -m "feat: add /api/explore/local listing endpoint with natural sort"
```

---

## Task 4: Backend — Local Image Serving Endpoint

**Files:**
- Modify: `backend/api/routes.py` (add after the listing endpoint)

- [ ] **Step 1: Add `/api/explore/local/image` endpoint**

Use a sync `def` handler so FastAPI runs Pillow thumbnail generation in a threadpool automatically:

```python
@router.get("/explore/local/image")
def serve_local_image(path: str = Query(min_length=1), thumbnail: bool = False):
    root = _get_local_browse_root()
    filepath = root / path
    filepath = filepath.resolve()
    if not filepath.is_file() or not filepath.is_relative_to(root.resolve()):
        raise HTTPException(status_code=404, detail="Image not found")
    if filepath.suffix.lower() not in _IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Not a recognized image file")

    if thumbnail:
        from PIL import Image as PILImage
        try:
            img = PILImage.open(filepath)
            img.thumbnail((300, 300))
            buf = io.BytesIO()
            fmt = "JPEG" if filepath.suffix.lower() in (".jpg", ".jpeg") else "PNG"
            img.save(buf, format=fmt)
            buf.seek(0)
            media = "image/jpeg" if fmt == "JPEG" else "image/png"
            return StreamingResponse(buf, media_type=media)
        except Exception:
            raise HTTPException(status_code=500, detail="Failed to create thumbnail")

    ext = filepath.suffix.lower()
    media_map = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".tiff": "image/tiff",
    }
    return FileResponse(filepath, media_type=media_map.get(ext, "application/octet-stream"))
```

Note: Uses sync `def` (not `async def`) so Pillow I/O runs in FastAPI's threadpool instead of blocking the event loop.

- [ ] **Step 2: Commit**

```bash
git add backend/api/routes.py
git commit -m "feat: add /api/explore/local/image endpoint with thumbnail support"
```

---

## Task 5: Frontend — Explore Sub-Tab HTML & CSS

**Files:**
- Modify: `frontend/index.html:993-1005` (Explore panel)
- Modify: `frontend/css/style.css` (after explore panel styles, around line 3195)

- [ ] **Step 1: Update Explore panel HTML**

Replace the contents of `#panel-explore` (lines 993-1005) with:

```html
        <div id="panel-explore" class="tab-panel explore-panel" style="display:none">
          <div class="explore-sub-tabs">
            <button class="explore-sub-tab active" data-explore-mode="url">URL</button>
            <button class="explore-sub-tab" data-explore-mode="local">Local</button>
          </div>

          <!-- URL mode (existing) -->
          <div id="explore-mode-url" class="explore-mode">
            <div class="explore-url-bar">
              <input type="text" id="explore-url" class="explore-url-input" placeholder="Enter a URL to browse images from any page…" spellcheck="false">
              <button id="explore-go" class="btn-action btn-action--primary" type="button">Go</button>
              <button id="explore-filter-people" class="btn-action explore-filter-btn" type="button" title="Show only images with people (local AI analysis)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></button>
            </div>
            <div id="explore-status" class="explore-status" style="display:none"></div>
            <div id="explore-grid" class="explore-grid"></div>
            <div id="explore-links" class="explore-links" style="display:none">
              <div class="explore-links-header">Related Links</div>
              <div id="explore-links-list" class="explore-links-list"></div>
            </div>
          </div>

          <!-- Local mode (new) -->
          <div id="explore-mode-local" class="explore-mode" style="display:none">
            <div class="explore-url-bar">
              <input type="text" id="local-browse-path" class="explore-url-input" placeholder="Enter folder path or click Browse…" spellcheck="false">
              <button id="local-browse-btn" class="btn-action btn-action--primary" type="button">Browse</button>
            </div>
            <div id="local-breadcrumb" class="local-breadcrumb"></div>
            <div id="local-status" class="explore-status" style="display:none"></div>
            <div id="local-grid" class="explore-grid"></div>
          </div>
        </div>
```

- [ ] **Step 2: Add CSS for sub-tabs, breadcrumb, and folder cards**

Add to `frontend/css/style.css` after the existing explore styles (after `.explore-card img` block):

```css
/* ── Explore sub-tabs ─────────────────────────────────────── */
.explore-sub-tabs {
  display: flex;
  gap: 2px;
  padding: 8px 12px 0;
  flex-shrink: 0;
}
.explore-sub-tab {
  padding: 4px 14px;
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  border: 1px solid var(--border-muted);
  border-bottom: none;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background: var(--bg-deep);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.explore-sub-tab:hover { color: var(--text-primary); }
.explore-sub-tab.active {
  background: var(--bg-surface);
  color: var(--text-primary);
  border-color: var(--accent);
}
.explore-mode { display: flex; flex-direction: column; flex: 1; overflow: hidden; }

/* ── Local breadcrumb ─────────────────────────────────────── */
.local-breadcrumb {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  font-size: 0.75rem;
  color: var(--text-secondary);
  flex-shrink: 0;
  overflow: hidden;
  white-space: nowrap;
}
.local-breadcrumb-seg {
  cursor: pointer;
  color: var(--accent);
  text-decoration: none;
}
.local-breadcrumb-seg:hover { text-decoration: underline; }
.local-breadcrumb-sep { color: var(--text-tertiary); }
.local-breadcrumb-current { color: var(--text-primary); font-weight: 600; }

/* ── Folder cards ─────────────────────────────────────────── */
.local-folder-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-muted);
  background: var(--bg-deep);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.local-folder-card:hover {
  border-color: var(--accent);
  background: var(--bg-surface);
}
.local-folder-card svg { flex-shrink: 0; color: var(--text-secondary); }
.local-folder-card span { font-size: 0.82rem; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 3: Commit**

```bash
git add frontend/index.html frontend/css/style.css
git commit -m "feat: add Explore sub-tab UI and local browse styles"
```

---

## Task 6: Frontend — Sub-Tab Switching & Local Browse Logic

**Files:**
- Modify: `frontend/js/app.js` (inside `setupExplorePanel` function, around line 7092)

- [ ] **Step 1: Add sub-tab switching inside `setupExplorePanel`**

At the top of `setupExplorePanel()` (after the existing element lookups, around line 7098), add:

```javascript
  // ── Sub-tab switching ──
  const subTabs = document.querySelectorAll(".explore-sub-tab");
  const modeUrl = $("#explore-mode-url");
  const modeLocal = $("#explore-mode-local");

  subTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      subTabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const mode = tab.dataset.exploreMode;
      if (modeUrl) modeUrl.style.display = mode === "url" ? "" : "none";
      if (modeLocal) modeLocal.style.display = mode === "local" ? "" : "none";
    });
  });
```

- [ ] **Step 2: Add local browse state and functions**

After the sub-tab switching code, add the full local browse implementation:

```javascript
  // ── Local folder browser ──
  const localPathInput = $("#local-browse-path");
  const localBrowseBtn = $("#local-browse-btn");
  const localBreadcrumb = $("#local-breadcrumb");
  const localStatus = $("#local-status");
  const localGrid = $("#local-grid");

  let localRootPath = localStorage.getItem("local_browse_root") || "";
  let localCurrentSubpath = "";

  if (localPathInput && localRootPath) {
    localPathInput.value = localRootPath;
  }

  async function setLocalRoot(fullPath) {
    // Save to server settings for security enforcement
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ local_browse_root: fullPath }),
      });
    } catch (err) {
      showError("Failed to save browse root: " + err.message);
      return;
    }
    localRootPath = fullPath;
    localStorage.setItem("local_browse_root", fullPath);
    localCurrentSubpath = "";
    browseLocalFolder("");
  }

  async function browseLocalFolder(subpath) {
    if (!localRootPath) return;
    localCurrentSubpath = subpath;
    localGrid.innerHTML = "";
    localStatus.style.display = "block";
    localStatus.textContent = "Loading…";

    try {
      const resp = await fetch("/api/explore/local?path=" + encodeURIComponent(subpath));
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to browse folder");
      }
      const data = await resp.json();

      localStatus.style.display = "none";
      renderLocalBreadcrumb(subpath);

      // Render folders
      for (const dir of data.directories) {
        const card = document.createElement("div");
        card.className = "local-folder-card";
        card.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><span></span>';
        card.querySelector("span").textContent = dir.name;
        const childPath = subpath ? subpath + "/" + dir.name : dir.name;
        card.addEventListener("click", () => browseLocalFolder(childPath));
        localGrid.appendChild(card);
      }

      // Render images
      for (const file of data.files) {
        const card = document.createElement("div");
        card.className = "explore-card";
        const imgEl = document.createElement("img");
        const imgPath = subpath ? subpath + "/" + file.name : file.name;
        imgEl.src = "/api/explore/local/image?path=" + encodeURIComponent(imgPath) + "&thumbnail=true";
        imgEl.alt = file.name;
        imgEl.loading = "lazy";
        imgEl.addEventListener("click", () => useLocalImage(imgPath));
        card.appendChild(imgEl);
        localGrid.appendChild(card);
      }

      if (data.directories.length === 0 && data.files.length === 0) {
        localStatus.style.display = "block";
        localStatus.textContent = "Empty folder";
      }
    } catch (err) {
      localStatus.style.display = "block";
      localStatus.textContent = "Error: " + err.message;
    }
  }

  function renderLocalBreadcrumb(subpath) {
    if (!localBreadcrumb) return;
    localBreadcrumb.innerHTML = "";

    // Root segment
    const rootSeg = document.createElement("a");
    rootSeg.className = "local-breadcrumb-seg";
    rootSeg.textContent = "\uD83D\uDCC1";
    rootSeg.addEventListener("click", () => browseLocalFolder(""));
    localBreadcrumb.appendChild(rootSeg);

    if (!subpath) return;

    const parts = subpath.split("/");
    for (let i = 0; i < parts.length; i++) {
      const sep = document.createElement("span");
      sep.className = "local-breadcrumb-sep";
      sep.textContent = " / ";
      localBreadcrumb.appendChild(sep);

      if (i === parts.length - 1) {
        const cur = document.createElement("span");
        cur.className = "local-breadcrumb-current";
        cur.textContent = parts[i];
        localBreadcrumb.appendChild(cur);
      } else {
        const seg = document.createElement("a");
        seg.className = "local-breadcrumb-seg";
        seg.textContent = parts[i];
        const segPath = parts.slice(0, i + 1).join("/");
        seg.addEventListener("click", () => browseLocalFolder(segPath));
        localBreadcrumb.appendChild(seg);
      }
    }
  }

  async function useLocalImage(imgPath) {
    try {
      const resp = await fetch("/api/explore/local/image?path=" + encodeURIComponent(imgPath));
      if (!resp.ok) throw new Error("Failed to load image");
      const blob = await resp.blob();
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        // Create temp Image element for crop overlay
        const img = new Image();
        img.onload = () => {
          openCropOverlay(img);
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      showError("Failed to load image: " + err.message);
    }
  }

  // Browse button — macOS folder picker
  if (localBrowseBtn) {
    localBrowseBtn.addEventListener("click", async () => {
      try {
        const resp = await fetch("/api/settings/browse", { method: "POST" });
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.path) {
          localPathInput.value = data.path;
          setLocalRoot(data.path);
        }
      } catch (err) {
        showError("Browse failed: " + err.message);
      }
    });
  }

  // Path input — Enter key
  if (localPathInput) {
    localPathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const val = localPathInput.value.trim();
        if (val) setLocalRoot(val);
      }
    });
  }

  // Auto-load saved root on init — just browse, don't re-save to server
  if (localRootPath) {
    browseLocalFolder("");
  }
```

- [ ] **Step 3: Commit**

```bash
git add frontend/js/app.js
git commit -m "feat: implement local folder browser with breadcrumb navigation"
```

---

## Task 7: Frontend — Extract Shared `applyImportedImage` + Wire Crop Overlay

**Files:**
- Modify: `frontend/js/app.js:807-855` (loadImageFile)
- Modify: `frontend/js/app.js:1146-1202` (confirmCrop)
- Modify: `frontend/js/app.js:7175-7217` (useExploreImage)
- Modify: `frontend/index.html:217-219` (add Skip button inside `.crop-footer-actions`)

**Note on paste/drop handlers:** Paste and drop handlers for NovelAI mode route through `showPasteActionPopup` -> `loadImageFile`. For Grok mode they call `loadImageFile` directly. Since we're modifying `loadImageFile` to go through the crop overlay, all these paths are automatically covered. No changes needed to the paste/drop handlers themselves.

- [ ] **Step 1: Add `applyImportedImage` shared function**

Add before `openCropOverlay` (around line 860):

```javascript
/**
 * Shared post-import logic for all image import paths (crop confirm, skip, etc.)
 * Handles both Grok (source/ref) and NovelAI (layer) modes.
 */
function applyImportedImage(b64, width, height, dataUrl) {
  const provider = document.getElementById("provider")?.value || "novelai";
  if (provider === "grok") {
    if (!state.img2img) {
      // No source yet — set as source
      state.img2img = b64;
      state.canvasImageBase64 = b64;
      state.canvasImageWidth = width;
      state.canvasImageHeight = height;
      showGrokSourceOnCanvas(dataUrl || "data:image/png;base64," + b64);
    } else if (grokRefs.length < MAX_GROK_REFS) {
      // Source exists — add as reference
      grokRefs.push({ base64: b64 });
    }
    renderGrokImagesList();
    const canvasTab = $("#tab-canvas");
    if (canvasTab) canvasTab.click();
  } else {
    // NovelAI: add as layer
    if (layers.length < MAX_LAYERS) {
      const n = layers.length + 1;
      layers.push({ id: Date.now(), name: "Layer " + n, imageBase64: b64, maskBase64: null, inpaintMaskBase64: null, opacity: 1.0, visible: true, isOutputTarget: false, offsetX: 0, offsetY: 0, scale: 1.0 });
      renderLayerList();
      saveLayersToStorage();
      refreshCompositePreview();
      const accordion = document.getElementById("layers-accordion");
      if (accordion && !accordion.open) accordion.open = true;
      showStatus("Image added as layer.");
    } else {
      showStatus("Maximum of " + MAX_LAYERS + " layers reached.");
    }
    const canvasTab = $("#tab-canvas");
    if (canvasTab) canvasTab.click();
  }
}
```

- [ ] **Step 2: Add guard to `openCropOverlay` for double-open prevention**

At the top of `openCropOverlay` (line 861), after `const overlay = ...`, add:

```javascript
  if (!overlay) return;
  // Prevent double-open when multiple images are imported rapidly
  if (overlay.style.display !== "none") return;
```

(Replace the existing `if (!overlay) return;` line.)

- [ ] **Step 3: Update `confirmCrop` to use `applyImportedImage`**

Replace the body of `confirmCrop` (lines 1146-1202) with:

```javascript
function confirmCrop() {
  if (!crop.img) return;

  // Create an offscreen canvas at exact output resolution
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width  = crop.targetW;
  exportCanvas.height = crop.targetH;
  const ctx = exportCanvas.getContext("2d");

  const srcX = crop.offsetX / crop.scale;
  const srcY = crop.offsetY / crop.scale;
  const srcW = crop.frameW  / crop.scale;
  const srcH = crop.frameH  / crop.scale;

  ctx.drawImage(
    crop.img,
    srcX, srcY, srcW, srcH,
    0, 0, crop.targetW, crop.targetH
  );

  const dataUrl = exportCanvas.toDataURL("image/png");
  const b64 = dataUrl.split(",")[1];

  closeCropOverlay();
  applyImportedImage(b64, crop.targetW, crop.targetH, dataUrl);
}
```

- [ ] **Step 4: Add `skipCrop` function**

Add after `confirmCrop`:

```javascript
function skipCrop() {
  if (!crop.img) return;

  // Capture dimensions before closing overlay
  const w = crop.img.naturalWidth;
  const h = crop.img.naturalHeight;

  // Use original image at native dimensions (no cropping)
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = w;
  exportCanvas.height = h;
  const ctx = exportCanvas.getContext("2d");
  ctx.drawImage(crop.img, 0, 0);

  const dataUrl = exportCanvas.toDataURL("image/png");
  const b64 = dataUrl.split(",")[1];

  closeCropOverlay();
  applyImportedImage(b64, w, h, dataUrl);
}
```

- [ ] **Step 5: Modify `loadImageFile` to always open crop overlay**

Replace `loadImageFile` (lines 807-855) with:

```javascript
function loadImageFile(file) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      // Route through crop overlay — confirmCrop/skipCrop handle all post-import logic
      openCropOverlay(img);
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}
```

- [ ] **Step 6: Modify `useExploreImage` to use crop overlay**

Replace the `useExploreImage` function (lines 7175-7217) with:

```javascript
  async function useExploreImage(imageUrl) {
    try {
      const resp = await fetch("/api/explore/image?url=" + encodeURIComponent(imageUrl));
      if (!resp.ok) throw new Error("Failed to load image");
      const blob = await resp.blob();
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        const img = new Image();
        img.onload = () => {
          openCropOverlay(img);
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      showError("Failed to load image: " + err.message);
    }
  }
```

- [ ] **Step 7: Add Skip button to crop overlay HTML**

In `frontend/index.html`, inside the `.crop-footer-actions` div, after the "Confirm Crop" button (line 219) and before the closing `</div>`:

```html
            <button id="crop-skip" class="btn-action" type="button">
              Skip
            </button>
```

- [ ] **Step 8: Wire Skip button in `setupCropInteraction`**

In `frontend/js/app.js`, inside `setupCropInteraction` (around line 1083 where cancelBtn is wired), add:

```javascript
  const skipBtn = $("#crop-skip");
  if (skipBtn) skipBtn.addEventListener("click", skipCrop);
```

- [ ] **Step 9: Commit**

```bash
git add frontend/js/app.js frontend/index.html
git commit -m "feat: wire crop overlay to all import paths with shared applyImportedImage"
```

---

## Task 8: Manual QA Testing

- [ ] **Step 1: Start the server**

```bash
cd /Users/david/novelai && python backend/main.py
```

- [ ] **Step 2: Test local folder browser**

1. Open http://0.0.0.0:8000
2. Click the "Explore" tab at bottom-right
3. Verify "URL" and "Local" sub-tabs appear, URL is active by default
4. Click "Local" — verify the path input and Browse button appear
5. Click "Browse" — macOS folder picker should open
6. Select a folder with images — thumbnails should load in grid
7. If folder has subdirectories, verify folder cards appear and clicking enters them
8. Verify breadcrumb updates and clicking segments navigates correctly
9. Reload the page — verify the saved path auto-loads
10. Verify natural sort: "Chapter 2" appears before "Chapter 10"

- [ ] **Step 3: Test crop overlay on all import paths**

1. **Local browser:** Click an image in the local grid → crop overlay opens
2. **URL Explore:** Navigate to a URL, click an image → crop overlay opens
3. **Paste:** Copy an image, Ctrl+V → crop overlay opens (NovelAI: after choosing "Add to Layer" in popup)
4. **Drag & drop:** Drag an image file onto the page → crop overlay opens
5. In each case test: Fit, Fill, manual pan/zoom, Confirm Crop, **Skip**, Cancel
6. Test in both NovelAI and Grok provider modes
7. **Grok source vs ref:** With a source already set, import another image → should add as reference (not replace source)
8. **Double-open guard:** While crop overlay is open, try pasting another image → should be ignored

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "fix: QA fixes for local browser and crop overlay"
```
