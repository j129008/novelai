/* ═══════════════════════════════════════════════════════════
   GALLERY
   ═══════════════════════════════════════════════════════════ */

let _galleryData = [];
let _galleryPath = "";
let _galleryTypeFilter = "all";
let _settingsLoadedToast = null;

function setupHistoryTabs() {
  const tabCanvas = $("#tab-canvas");
  const tabHistory = $("#tab-history");
  const tabExplore = $("#tab-explore");
  const panelCanvas = $("#panel-canvas");
  const panelHistory = $("#panel-history");
  const panelExplore = $("#panel-explore");
  const searchWrap = $("#history-search-wrap");
  const searchInput = $("#gallery-search");

  _settingsLoadedToast = document.createElement("div");
  _settingsLoadedToast.className = "settings-loaded-toast";
  _settingsLoadedToast.textContent = "Settings loaded — ready to iterate";
  document.body.appendChild(_settingsLoadedToast);

  function clearAllTabs() {
    tabCanvas.classList.remove("canvas-tab--active");
    tabHistory.classList.remove("canvas-tab--active");
    if (tabExplore) tabExplore.classList.remove("canvas-tab--active");
  }

  function hideAllPanels() {
    panelCanvas.style.display = "none";
    panelHistory.style.display = "none";
    if (panelExplore) panelExplore.style.display = "none";
    searchWrap.style.display = "none";
    const bc = $("#gallery-breadcrumb");
    if (bc) bc.style.display = "none";
  }

  function showCanvas() {
    clearAllTabs();
    hideAllPanels();
    tabCanvas.classList.add("canvas-tab--active");
    panelCanvas.style.display = "flex";
    localStorage.setItem("nai-active-tab", "canvas");
  }

  function showHistory() {
    clearAllTabs();
    hideAllPanels();
    tabHistory.classList.add("canvas-tab--active");
    panelHistory.style.display = "flex";
    const bc = $("#gallery-breadcrumb");
    if (bc) bc.style.display = bc.children.length ? "flex" : "none";
    searchWrap.style.display = "flex";
    searchInput.focus();
    localStorage.setItem("nai-active-tab", "history");
  }

  function showExplore() {
    if (!tabExplore || !panelExplore) return;
    clearAllTabs();
    hideAllPanels();
    tabExplore.classList.add("canvas-tab--active");
    panelExplore.style.display = "flex";
    localStorage.setItem("nai-active-tab", "explore");
  }

  tabCanvas.addEventListener("click", showCanvas);
  tabHistory.addEventListener("click", showHistory);
  if (tabExplore) tabExplore.addEventListener("click", showExplore);

  // Restore last active tab (default: canvas)
  let savedTab = localStorage.getItem("nai-active-tab") || "canvas";
  if (savedTab === "inspire" || savedTab === "craft") savedTab = "canvas";
  if (savedTab === "story") savedTab = "canvas";
  if (savedTab === "history") showHistory();
  else if (savedTab === "explore") showExplore();
  // else canvas is already active by default

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      renderGallery(_galleryData, [], searchInput.value.toLowerCase());
    });
  }

  // Gallery type filters
  document.querySelectorAll(".gallery-filter").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".gallery-filter").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _galleryTypeFilter = btn.dataset.filter;
      const searchVal = (searchInput?.value || "").toLowerCase();
      renderGallery(_galleryData, [], searchVal);
    });
  });
}

async function showMoveDialog(filename) {
  // Fetch existing folders
  let folders = [];
  try {
    const resp = await fetch("/api/gallery" + (_galleryPath ? "?path=" + encodeURIComponent(_galleryPath) : ""));
    if (resp.ok) {
      const data = await resp.json();
      folders = data.directories || [];
    }
  } catch {}

  // Remove any existing dialog
  document.querySelector(".move-dialog-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "move-dialog-overlay";

  const dialog = document.createElement("div");
  dialog.className = "move-dialog";

  dialog.innerHTML = `
    <div class="move-dialog-title">Move "${filename}" to…</div>
    <div class="move-dialog-folders"></div>
    <div class="move-dialog-new">
      <input type="text" class="move-dialog-input" placeholder="New folder name…" spellcheck="false">
      <button type="button" class="btn-action btn-action--primary move-dialog-create">Create & Move</button>
    </div>
    <button type="button" class="btn-action move-dialog-cancel">Cancel</button>
  `;

  const foldersEl = dialog.querySelector(".move-dialog-folders");
  for (const folder of folders) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-action move-dialog-folder-btn";
    btn.textContent = folder;
    btn.addEventListener("click", async () => {
      const dest = _galleryPath ? _galleryPath + "/" + folder : folder;
      await doMove(filename, dest);
      overlay.remove();
    });
    foldersEl.appendChild(btn);
  }

  const input = dialog.querySelector(".move-dialog-input");
  const createBtn = dialog.querySelector(".move-dialog-create");
  createBtn.addEventListener("click", async () => {
    const name = input.value.trim();
    if (!name) return;
    const dest = _galleryPath ? _galleryPath + "/" + name : name;
    await doMove(filename, dest);
    overlay.remove();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      createBtn.click();
    }
  });

  dialog.querySelector(".move-dialog-cancel").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  input.focus();
}

async function doMove(filename, destFolder) {
  try {
    const resp = await fetch("/api/gallery/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, source_path: _galleryPath, dest_folder: destFolder }),
    });
    if (resp.ok) {
      loadGallery();
      showStatus(`Moved to ${destFolder}`);
    } else {
      const err = await resp.json().catch(() => ({}));
      showError(err.detail || "Move failed");
    }
  } catch {
    showError("Move failed");
  }
}

function showSettingsLoadedToast() {
  if (!_settingsLoadedToast) return;
  _settingsLoadedToast.classList.add("visible");
  setTimeout(() => _settingsLoadedToast.classList.remove("visible"), 2400);
}

function galleryFileUrl(name) {
  const encoded = encodeURIComponent(name);
  return _galleryPath
    ? `/api/gallery/${encoded}?path=${encodeURIComponent(_galleryPath)}`
    : `/api/gallery/${encoded}`;
}

function renderBreadcrumb() {
  const breadcrumb = $("#gallery-breadcrumb");
  if (!breadcrumb) return;
  breadcrumb.innerHTML = "";

  // Root segment
  const rootBtn = document.createElement("button");
  rootBtn.type = "button";
  rootBtn.textContent = "/";
  if (!_galleryPath) {
    rootBtn.className = "gallery-breadcrumb-current";
  } else {
    rootBtn.className = "gallery-breadcrumb-item";
    rootBtn.addEventListener("click", () => {
      _galleryPath = "";
      loadGallery();
    });
  }
  breadcrumb.appendChild(rootBtn);

  if (!_galleryPath) return;

  const segments = _galleryPath.split("/");
  segments.forEach((seg, i) => {
    const sep = document.createElement("span");
    sep.className = "gallery-breadcrumb-sep";
    sep.textContent = ">";
    breadcrumb.appendChild(sep);

    const isLast = i === segments.length - 1;
    const segEl = document.createElement(isLast ? "span" : "button");
    if (!isLast) segEl.type = "button";
    segEl.textContent = seg;
    segEl.className = isLast ? "gallery-breadcrumb-current" : "gallery-breadcrumb-item";
    if (!isLast) {
      const targetPath = segments.slice(0, i + 1).join("/");
      segEl.addEventListener("click", () => {
        _galleryPath = targetPath;
        loadGallery();
      });
    }
    breadcrumb.appendChild(segEl);
  });
}

async function loadGallery() {
  const list = $("#gallery-list");
  const empty = $("#gallery-empty");
  const count = $("#gallery-count");
  if (!list) return;

  try {
    const url = "/api/gallery" + (_galleryPath ? "?path=" + encodeURIComponent(_galleryPath) : "");
    const resp = await fetch(url);
    if (!resp.ok) return;
    const data = await resp.json();

    // Support both new format {path, directories, files} and legacy array format
    const files = Array.isArray(data) ? data : (data.files || []);
    const directories = Array.isArray(data) ? [] : (data.directories || []);

    _galleryData = files;
    if (count) {
      count.textContent = files.length || "";
      count.classList.toggle("visible", files.length > 0);
    }
    renderBreadcrumb();
    const searchVal = ($("#gallery-search")?.value || "").toLowerCase();
    renderGallery(files, directories, searchVal);
  } catch { /* ignore */ }
}

function renderGallery(files, directories, filter) {
  // Support legacy 2-arg call (files, filter) when no directories available
  if (typeof directories === "string" || directories === undefined) {
    filter = directories;
    directories = [];
  }

  const list = $("#gallery-list");
  const empty = $("#gallery-empty");
  if (!list) return;

  const _isGrok = f => f.name.includes("-grok") || f.name.startsWith("grok-") || f.name.startsWith("xai-");
  const _isVideo = f => f.name.toLowerCase().endsWith(".mp4");

  // Update filter button visibility based on content
  const _filterCounts = {
    image: files.filter(f => !_isVideo(f)).length,
    video: files.filter(_isVideo).length,
    novelai: files.filter(f => !_isGrok(f) && !_isVideo(f)).length,
    grok: files.filter(_isGrok).length,
  };
  document.querySelectorAll(".gallery-filter[data-filter]").forEach(btn => {
    const key = btn.dataset.filter;
    if (key === "all") return;
    btn.style.display = (_filterCounts[key] || 0) > 0 ? "" : "none";
  });

  // Apply type/source filter
  let typeFiltered = files;
  if (_galleryTypeFilter === "image") {
    typeFiltered = files.filter(f => !_isVideo(f));
  } else if (_galleryTypeFilter === "video") {
    typeFiltered = files.filter(_isVideo);
  } else if (_galleryTypeFilter === "grok") {
    typeFiltered = files.filter(_isGrok);
  } else if (_galleryTypeFilter === "novelai") {
    typeFiltered = files.filter(f => !_isGrok(f) && !_isVideo(f));
  }

  const filtered = filter
    ? typeFiltered.filter((f) => {
        const meta = f.meta || {};
        return (meta.prompt || "").toLowerCase().includes(filter)
          || (meta.uc || "").toLowerCase().includes(filter)
          || String(meta.seed || "").includes(filter)
          || f.name.toLowerCase().includes(filter);
      })
    : typeFiltered;

  // When searching, directories are hidden (not searchable by design)
  const visibleDirs = filter ? [] : (directories || []);

  if (!filtered.length && !visibleDirs.length) {
    list.style.display = "none";
    empty.style.display = "block";
    empty.textContent = filter ? "No matching images" : "No saved images yet";
    return;
  }

  list.style.display = "grid";
  empty.style.display = "none";
  list.innerHTML = "";

  // Render folder cards first
  for (const dirName of visibleDirs) {
    const card = document.createElement("div");
    card.className = "gallery-folder-card";

    const icon = document.createElement("div");
    icon.className = "gallery-folder-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "\uD83D\uDCC1"; // 📁

    const name = document.createElement("div");
    name.className = "gallery-folder-name";
    name.textContent = dirName;

    card.appendChild(icon);
    card.appendChild(name);

    card.addEventListener("click", () => {
      _galleryPath = _galleryPath ? _galleryPath + "/" + dirName : dirName;
      loadGallery();
    });

    list.appendChild(card);
  }

  for (const file of filtered) {
    const meta = file.meta || {};
    const card = document.createElement("div");
    card.className = "history-card";

    // Thumbnail area — clicking it previews in Canvas
    const imgWrap = document.createElement("div");
    imgWrap.className = "history-card-img-wrap";

    const isVideo = file.name.toLowerCase().endsWith(".mp4");
    let mediaEl;
    if (isVideo) {
      mediaEl = document.createElement("video");
      mediaEl.className = "history-card-img";
      mediaEl.src = galleryFileUrl(file.name);
      mediaEl.muted = true;
      mediaEl.loop = true;
      mediaEl.addEventListener("mouseenter", () => mediaEl.play());
      mediaEl.addEventListener("mouseleave", () => { mediaEl.pause(); mediaEl.currentTime = 0; });
    } else {
      mediaEl = document.createElement("img");
      mediaEl.className = "history-card-img";
      mediaEl.src = galleryFileUrl(file.name);
      mediaEl.alt = file.name;
      mediaEl.loading = "lazy";
    }
    imgWrap.appendChild(mediaEl);

    // Play icon badge for video cards
    if (isVideo) {
      const badge = document.createElement("div");
      badge.className = "history-card-video-badge";
      badge.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="8,5 19,12 8,19" fill="currentColor"/></svg>';
      imgWrap.appendChild(badge);
    }

    // Hover overlay with prompt + meta text (for context, no buttons)
    const overlay = document.createElement("div");
    overlay.className = "history-card-overlay";

    if (meta.prompt) {
      const promptEl = document.createElement("div");
      promptEl.className = "history-card-prompt";
      promptEl.textContent = meta.prompt;
      overlay.appendChild(promptEl);
    }

    const metaEl = document.createElement("div");
    metaEl.className = "history-card-meta";
    if (meta.seed) { const s = document.createElement("span"); s.textContent = `Seed ${meta.seed}`; metaEl.appendChild(s); }
    if (meta.steps) { const s = document.createElement("span"); s.textContent = `${meta.steps}st`; metaEl.appendChild(s); }
    if (meta.width) { const s = document.createElement("span"); s.textContent = `${meta.width}\u00d7${meta.height}`; metaEl.appendChild(s); }
    overlay.appendChild(metaEl);
    imgWrap.appendChild(overlay);

    // Always-visible action bar at the bottom
    const actionBar = document.createElement("div");
    actionBar.className = "history-card-actionbar";

    const iterateBtn = document.createElement("button");
    iterateBtn.className = "history-card-action-btn history-card-action-btn--iterate";
    iterateBtn.type = "button";
    iterateBtn.title = "Add to Layer: load settings + add image as a new layer";
    iterateBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="M9 10l3 3 3-3"/></svg>Add to Layer`;
    iterateBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      loadSettingsFromMeta(meta);
      // Add image to a new layer
      await setHistoryImageAsSource(galleryFileUrl(file.name), meta);
      card.classList.add("settings-loaded");
      setTimeout(() => card.classList.remove("settings-loaded"), 1800);
      showSettingsLoadedToast();
      $("#tab-canvas").click();
    });

    const loadBtn = document.createElement("button");
    loadBtn.className = "history-card-action-btn history-card-action-btn--load";
    loadBtn.type = "button";
    loadBtn.title = "Load settings";
    loadBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.84"/></svg>Load`;
    loadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      loadSettingsFromMeta(meta);
      card.classList.add("settings-loaded");
      setTimeout(() => card.classList.remove("settings-loaded"), 1800);
      showSettingsLoadedToast();
      $("#tab-canvas").click();
    });

    const delBtn = document.createElement("button");
    delBtn.className = "history-card-action-btn history-card-action-btn--delete";
    delBtn.type = "button";
    delBtn.title = "Delete";
    delBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      card.style.opacity = "0.4";
      card.style.pointerEvents = "none";
      const r = await fetch(galleryFileUrl(file.name), { method: "DELETE" });
      if (r.ok) loadGallery();
      else { card.style.opacity = ""; card.style.pointerEvents = ""; }
    });

    const moveBtn = document.createElement("button");
    moveBtn.className = "history-card-action-btn history-card-action-btn--move";
    moveBtn.type = "button";
    moveBtn.title = "Move to folder";
    moveBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
    moveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showMoveDialog(file.name);
    });

    actionBar.appendChild(iterateBtn);
    actionBar.appendChild(loadBtn);
    actionBar.appendChild(moveBtn);
    actionBar.appendChild(delBtn);

    // Clicking the image area opens the lightbox
    imgWrap.addEventListener("click", () => {
      openLightbox(filtered, filtered.indexOf(file));
    });

    card.appendChild(imgWrap);
    card.appendChild(actionBar);
    list.appendChild(card);
  }
}

/* ═══════════════════════════════════════════════════════════
   LIGHTBOX
   ═══════════════════════════════════════════════════════════ */

let _lightboxOverlay = null;
let _lightboxData = [];
let _lightboxIndex = 0;
let _lightboxKeyHandler = null;
let _slideshowTimer = null;
let _slideshowActive = false;
function slideshowNext() {
  if (!_slideshowActive) return;
  navigateLightbox(1);
  // Schedule is called from renderLightboxFrame after content is ready
}
function scheduleSlideshowAdvance() {
  if (_slideshowTimer) { clearTimeout(_slideshowTimer); _slideshowTimer = null; }
  if (!_slideshowActive) return;
  const video = _lightboxOverlay ? _lightboxOverlay.querySelector("video") : null;
  if (video) {
    video.loop = false;
    video.onended = () => slideshowNext();
  } else {
    _slideshowTimer = setTimeout(() => slideshowNext(), 3000);
  }
}

function setupLightbox() {
  const overlay = document.createElement("div");
  overlay.id = "lightbox-overlay";
  overlay.className = "lightbox-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Image viewer");
  overlay.style.display = "none";

  overlay.innerHTML = `
    <div class="lightbox-topbar">
      <span class="lightbox-seed-badge" id="lb-seed"></span>
      <span class="lightbox-counter" id="lb-counter"></span>
      <button class="lightbox-close" id="lb-close" type="button" aria-label="Close lightbox">&times;</button>
    </div>
    <div class="lightbox-stage">
      <button class="lightbox-arrow" id="lb-prev" type="button" aria-label="Previous image">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <div class="lightbox-img-wrap" id="lb-img-wrap"></div>
      <button class="lightbox-arrow" id="lb-next" type="button" aria-label="Next image">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>
    <div class="lightbox-footer">
      <div class="lightbox-prompt-row">
        <p class="lightbox-prompt" id="lb-prompt"></p>
        <button class="btn-action lightbox-copy-prompt" id="lb-copy-prompt" type="button" title="Copy full prompt">Copy All</button>
      </div>
      <div class="lightbox-tags local-analysis-tags" id="lb-tags"></div>
      <div class="lightbox-actions">
        <button class="btn-action" id="lb-load" type="button">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.84"/></svg>
          Load
        </button>
        <button class="btn-action btn-action--iterate" id="lb-iterate" type="button">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="M9 10l3 3 3-3"/></svg>
          Add to Layer
        </button>
        <button class="btn-action" id="lb-slideshow" type="button" title="Auto-play slideshow (3s per image)">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Play
        </button>
        <button class="btn-action" id="lb-fullscreen" type="button" title="Toggle fullscreen">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
          Fullscreen
        </button>
        <button class="btn-action" id="lb-download" type="button" title="Download image">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Save
        </button>
        <button class="btn-action btn-action--danger-subtle" id="lb-delete" type="button" title="Delete image">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          Delete
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  _lightboxOverlay = overlay;

  // Close on backdrop click (outside the inner content)
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeLightbox();
  });

  overlay.querySelector("#lb-close").addEventListener("click", closeLightbox);

  overlay.querySelector("#lb-copy-prompt").addEventListener("click", () => {
    const promptEl = overlay.querySelector("#lb-prompt");
    if (promptEl && promptEl.textContent) {
      navigator.clipboard.writeText(promptEl.textContent);
      const btn = overlay.querySelector("#lb-copy-prompt");
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    }
  });

  overlay.querySelector("#lb-prev").addEventListener("click", () => navigateLightbox(-1));
  overlay.querySelector("#lb-next").addEventListener("click", () => navigateLightbox(1));

  overlay.querySelector("#lb-load").addEventListener("click", () => {
    const file = _lightboxData[_lightboxIndex];
    if (!file) return;
    loadSettingsFromMeta(file.meta || {});
    showSettingsLoadedToast();
    closeLightbox();
    $("#tab-canvas").click();
  });

  overlay.querySelector("#lb-iterate").addEventListener("click", async () => {
    const file = _lightboxData[_lightboxIndex];
    if (!file) return;
    loadSettingsFromMeta(file.meta || {});
    await setHistoryImageAsSource(galleryFileUrl(file.name), file.meta || {});
    showSettingsLoadedToast();
    closeLightbox();
    $("#tab-canvas").click();
  });

  // Slideshow — images show for 3s, videos play to completion
  const slideshowBtn = overlay.querySelector("#lb-slideshow");

  slideshowBtn.addEventListener("click", () => {
    if (_slideshowActive) {
      _slideshowActive = false;
      if (_slideshowTimer) { clearTimeout(_slideshowTimer); _slideshowTimer = null; }
      slideshowBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Play';
      slideshowBtn.classList.remove("btn-action--primary");
    } else {
      _slideshowActive = true;
      slideshowBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause';
      slideshowBtn.classList.add("btn-action--primary");
      if (!document.fullscreenElement) overlay.requestFullscreen().catch(() => {});
      scheduleSlideshowAdvance();
    }
  });

  // Fullscreen
  overlay.querySelector("#lb-fullscreen").addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      overlay.requestFullscreen().catch(() => {});
    }
  });

  // Download
  overlay.querySelector("#lb-download").addEventListener("click", () => {
    const file = _lightboxData[_lightboxIndex];
    if (!file) return;
    const a = document.createElement("a");
    a.href = galleryFileUrl(file.name);
    a.download = file.name;
    a.click();
  });

  // Delete
  overlay.querySelector("#lb-delete").addEventListener("click", async () => {
    const file = _lightboxData[_lightboxIndex];
    if (!file) return;
    const r = await fetch(galleryFileUrl(file.name), { method: "DELETE" });
    if (r.ok) {
      _lightboxData.splice(_lightboxIndex, 1);
      if (_lightboxData.length === 0) {
        closeLightbox();
        loadGallery();
      } else {
        if (_lightboxIndex >= _lightboxData.length) _lightboxIndex = _lightboxData.length - 1;
        renderLightboxFrame();
        loadGallery();
      }
    }
  });
}

function openLightbox(data, index) {
  if (!_lightboxOverlay) return;
  _lightboxData = data;
  _lightboxIndex = index;
  _lightboxOverlay.style.display = "flex";
  renderLightboxFrame();

  // Focus trap — focus the close button
  const closeBtn = _lightboxOverlay.querySelector("#lb-close");
  if (closeBtn) closeBtn.focus();

  // Keyboard navigation
  _lightboxKeyHandler = (e) => {
    if (e.key === "Escape") { closeLightbox(); return; }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); navigateLightbox(1); }
    if (e.key === "ArrowLeft"  || e.key === "ArrowUp")   { e.preventDefault(); navigateLightbox(-1); }
  };
  document.addEventListener("keydown", _lightboxKeyHandler);
}

function closeLightbox() {
  if (!_lightboxOverlay) return;
  // Stop slideshow
  _slideshowActive = false;
  if (_slideshowTimer) { clearTimeout(_slideshowTimer); _slideshowTimer = null; }
  // Stop ALL videos (including any in the DOM)
  _lightboxOverlay.querySelectorAll("video").forEach((v) => {
    v.pause();
    v.removeAttribute("src");
    v.load();
  });
  // Exit fullscreen if active
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  _lightboxOverlay.style.display = "none";
  if (_lightboxKeyHandler) {
    document.removeEventListener("keydown", _lightboxKeyHandler);
    _lightboxKeyHandler = null;
  }
}

function navigateLightbox(delta) {
  const total = _lightboxData.length;
  if (!total) return;
  // Wrap around
  _lightboxIndex = (_lightboxIndex + delta + total) % total;
  renderLightboxFrame();
}


function renderLightboxFrame() {
  const overlay = _lightboxOverlay;
  if (!overlay) return;

  const file = _lightboxData[_lightboxIndex];
  if (!file) return;
  const meta = file.meta || {};
  const total = _lightboxData.length;

  // Counter
  const counterEl = overlay.querySelector("#lb-counter");
  if (counterEl) counterEl.textContent = `${_lightboxIndex + 1} of ${total}`;

  // Seed badge
  const seedEl = overlay.querySelector("#lb-seed");
  if (seedEl) {
    if (meta.seed) {
      seedEl.textContent = `Seed: ${Number(meta.seed)}`;
      seedEl.style.display = "";
    } else {
      seedEl.style.display = "none";
    }
  }

  // Prompt
  const promptEl = overlay.querySelector("#lb-prompt");
  if (promptEl) promptEl.textContent = meta.prompt || "";

  // Tag pills — split prompt by commas
  const tagsWrap = overlay.querySelector("#lb-tags");
  if (tagsWrap) {
    tagsWrap.innerHTML = "";
    const promptText = meta.prompt || "";
    if (promptText) {
      const tags = promptText.split(",").map(t => t.trim()).filter(t => t);
      for (const tag of tags) {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "local-analysis-tag";
        pill.textContent = tag;
        pill.title = "Click to copy";
        pill.addEventListener("click", () => {
          navigator.clipboard.writeText(tag);
          pill.classList.add("selected");
          setTimeout(() => pill.classList.remove("selected"), 800);
        });
        tagsWrap.appendChild(pill);
      }
    }
  }

  // Arrow disabled state
  const prevBtn = overlay.querySelector("#lb-prev");
  const nextBtn = overlay.querySelector("#lb-next");
  // Always enable both (wrap-around)
  if (prevBtn) prevBtn.disabled = total <= 1;
  if (nextBtn) nextBtn.disabled = total <= 1;

  // Image — show loading spinner while loading
  const imgWrap = overlay.querySelector("#lb-img-wrap");
  if (!imgWrap) return;
  imgWrap.innerHTML = "";

  const spinner = document.createElement("div");
  spinner.className = "lightbox-img-loading";
  imgWrap.appendChild(spinner);

  const isVideo = file.name.toLowerCase().endsWith(".mp4");

  if (isVideo) {
    const video = document.createElement("video");
    video.className = "lightbox-img";
    video.src = galleryFileUrl(file.name);
    video.autoplay = true;
    video.loop = !_slideshowActive;
    video.muted = false;
    video.controls = true;
    video.onloadeddata = () => {
      imgWrap.innerHTML = "";
      imgWrap.appendChild(video);
      if (_slideshowActive) scheduleSlideshowAdvance();
    };
    video.onerror = () => {
      imgWrap.innerHTML = "";
      const err = document.createElement("p");
      err.style.cssText = "color:var(--text-tertiary);font-size:0.83rem";
      err.textContent = "Failed to load video";
      imgWrap.appendChild(err);
      if (_slideshowActive) _slideshowTimer = setTimeout(() => slideshowNext(), 3000);
    };
  } else {

  const img = document.createElement("img");
  img.className = "lightbox-img";
  img.alt = meta.prompt || file.name;

  img.onload = () => {
    imgWrap.innerHTML = "";
    imgWrap.appendChild(img);
    if (_slideshowActive) scheduleSlideshowAdvance();
  };
  img.style.cursor = "zoom-in";
  let _dragging = false, _startX = 0, _startY = 0, _scrollX = 0, _scrollY = 0;
  img.addEventListener("click", (e) => {
    if (_dragging) return; // ignore click after drag
    e.stopPropagation();
    const isZoomed = imgWrap.classList.toggle("lightbox-zoomed");
    img.style.cursor = isZoomed ? "grab" : "zoom-in";
    if (!isZoomed) { imgWrap.scrollTop = 0; imgWrap.scrollLeft = 0; }
  });
  imgWrap.addEventListener("mousedown", (e) => {
    if (!imgWrap.classList.contains("lightbox-zoomed")) return;
    _dragging = false;
    _startX = e.clientX; _startY = e.clientY;
    _scrollX = imgWrap.scrollLeft; _scrollY = imgWrap.scrollTop;
    img.style.cursor = "grabbing";
    e.preventDefault();
    const onMove = (ev) => {
      const dx = ev.clientX - _startX, dy = ev.clientY - _startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) _dragging = true;
      imgWrap.scrollLeft = _scrollX - dx;
      imgWrap.scrollTop = _scrollY - dy;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      img.style.cursor = "grab";
      setTimeout(() => { _dragging = false; }, 0);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  img.onerror = () => {
    imgWrap.innerHTML = "";
    const err = document.createElement("p");
    err.style.cssText = "color:var(--text-tertiary);font-size:0.83rem";
    err.textContent = "Failed to load image";
    imgWrap.appendChild(err);
  };
  img.src = galleryFileUrl(file.name);

  } // end else (not video)
}

async function setHistoryImageAsSource(url, meta) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      const b64 = c.toDataURL("image/png").split(",")[1];

      // Add to layers instead of img2img source
      if (layers.length < MAX_LAYERS) {
        const layerName = (meta && meta.prompt) ? meta.prompt.slice(0, 32) + "…" : "History Layer";
        layers.push({ id: Date.now(), name: layerName, imageBase64: b64, maskBase64: null, inpaintMaskBase64: null, opacity: 1.0, visible: true, isOutputTarget: false, offsetX: 0, offsetY: 0, scale: 1.0 });
        renderLayerList();
        saveLayersToStorage();
        refreshCompositePreview();
        const accordion = document.getElementById("layers-accordion");
        if (accordion && !accordion.open) accordion.open = true;
        showStatus("History image added as layer.");
      } else {
        showStatus("Maximum of " + MAX_LAYERS + " layers reached.");
      }
      resolve();
    };
    img.onerror = () => resolve();
    img.src = url;
  });
}

function loadSettingsFromMeta(meta) {
  if (!meta || !meta.prompt) return;

  // Known quality tag patterns (our app, NAI official, V4 format)
  const QUALITY_PATTERNS = [
    ", location, very aesthetic, masterpiece, no text",
    ", very aesthetic, masterpiece, no text",
    ", no text, best quality, very aesthetic, absurdres",
    ", best quality, amazing quality, very aesthetic, absurdres",
  ];
  let prompt = meta.prompt;
  for (const pat of QUALITY_PATTERNS) {
    if (prompt.includes(pat)) {
      prompt = prompt.replace(pat, "");
      break;
    }
  }

  $("#prompt").value = prompt;
  localStorage.setItem("nai-prompt", prompt);

  if (meta.uc) {
    $("#negative-prompt").value = meta.uc;
    localStorage.setItem("nai-negative", meta.uc);
  }

  // Don't load seed — keep current value so user gets fresh results
  if (meta.steps) {
    $("#steps").value = meta.steps;
    $("#steps-val").textContent = meta.steps;
  }
  if (meta.scale !== undefined) {
    $("#scale").value = meta.scale;
    $("#scale-val").textContent = parseFloat(meta.scale).toFixed(1);
  }
  if (meta.sampler) {
    const sampler = $("#sampler");
    for (const opt of sampler.options) {
      if (opt.value === meta.sampler) { sampler.value = meta.sampler; break; }
    }
  }
  if (meta.width && meta.height) {
    const res = `${meta.width}x${meta.height}`;
    const resolution = $("#resolution");
    for (const opt of resolution.options) {
      if (opt.value === res) { resolution.value = res; break; }
    }
  }
  if (meta.sm !== undefined) {
    const hd = $("#hd-enhancement");
    const smea = $("#smea");
    const smeaDyn = $("#smea-dyn");
    if (hd) hd.checked = meta.sm || meta.sm_dyn;
    if (smea) smea.checked = !!meta.sm;
    if (smeaDyn) smeaDyn.checked = !!meta.sm_dyn;
  }

  // Restore characters only when metadata contains char_captions
  {
    const charCaptions = (meta.char_captions && Array.isArray(meta.char_captions)) ? meta.char_captions : [];
    if (charCaptions.length > 0) {
    const slotsEl = $("#character-slots");
    if (slotsEl) {
      characters.length = 0;
      slotsEl.innerHTML = "";
      _activeMarkerIdx = -1;
      charCaptions.forEach((cc) => {
        const charData = {
          prompt: cc.char_caption || "",
          x: (cc.centers && cc.centers[0]) ? cc.centers[0].x : 0.5,
          y: (cc.centers && cc.centers[0]) ? cc.centers[0].y : 0.5,
          positionAuto: !meta.use_coords,
          interactions: [],
        };

        // Parse interaction directives from the prompt (source#, target#, mutual#)
        const parts = charData.prompt.split(",").map((s) => s.trim());
        const cleanParts = [];
        for (const p of parts) {
          const match = p.match(/^(source#|target#|mutual#)(.+)$/);
          if (match) {
            charData.interactions.push({ directive: match[1], action: match[2] });
          } else {
            cleanParts.push(p);
          }
        }
        charData.prompt = cleanParts.join(", ");

        characters.push(charData);
      });

      // Rebuild UI — trigger setupCharacters' addCharacterSlot for each
      // Since setupCharacters already ran, we need to manually build the cards
      // Use the same approach as the cache restore
      characters.forEach((c, i) => {
        const card = document.createElement("div");
        card.className = "char-slot-card";
        card.dataset.idx = String(i);

        const cardHeader = document.createElement("div");
        cardHeader.className = "char-slot-header";
        const cardLabel = document.createElement("span");
        cardLabel.className = "char-slot-label";
        cardLabel.textContent = `Character ${i + 1}`;
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "char-slot-remove";
        removeBtn.title = "Remove character";
        removeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
        removeBtn.addEventListener("click", () => {
          const cardIdx = parseInt(card.dataset.idx);
          characters.splice(cardIdx, 1);
          card.remove();
          slotsEl.querySelectorAll(".char-slot-card").forEach((cc, ii) => {
            cc.dataset.idx = ii;
            const lbl = cc.querySelector(".char-slot-label");
            if (lbl) lbl.textContent = `Character ${ii + 1}`;
          });
          if (_activeMarkerIdx >= characters.length) _activeMarkerIdx = -1;
          renderCharacterMarkers();
          saveCharactersToCache();
        });
        const moveUpBtn2 = document.createElement("button");
        moveUpBtn2.type = "button";
        moveUpBtn2.className = "char-slot-move";
        moveUpBtn2.title = "Move up";
        moveUpBtn2.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
        moveUpBtn2.addEventListener("click", () => swapCharacterSlots(slotsEl, parseInt(card.dataset.idx), parseInt(card.dataset.idx) - 1));

        const moveDownBtn2 = document.createElement("button");
        moveDownBtn2.type = "button";
        moveDownBtn2.className = "char-slot-move";
        moveDownBtn2.title = "Move down";
        moveDownBtn2.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
        moveDownBtn2.addEventListener("click", () => swapCharacterSlots(slotsEl, parseInt(card.dataset.idx), parseInt(card.dataset.idx) + 1));

        cardHeader.appendChild(cardLabel);
        cardHeader.appendChild(moveUpBtn2);
        cardHeader.appendChild(moveDownBtn2);
        cardHeader.appendChild(removeBtn);

        const ta = document.createElement("textarea");
        ta.className = "char-slot-textarea field-textarea";
        ta.rows = 3;
        ta.placeholder = "girl, blonde hair, blue eyes, waving";
        ta.spellcheck = false;
        ta.value = c.prompt;
        ta.addEventListener("input", () => {
          c.prompt = ta.value;
          ta.style.height = "auto";
          ta.style.height = ta.scrollHeight + "px";
          saveCharactersToCache();
        });
        _tagAC.attach(ta);

        card.appendChild(cardHeader);
        card.appendChild(ta);
        card.appendChild(buildInteractionsSection(c));
        slotsEl.appendChild(card);
      });

      const hasChars = characters.length > 0;

      // Open accordion only if characters were restored
      const accordion = $("#characters-accordion");
      if (accordion && hasChars) accordion.open = true;

      // Toggle empty state vs inline add button
      const emptyState = $("#char-empty-state");
      if (emptyState) emptyState.style.display = hasChars ? "none" : "flex";
      const addBtnInline = $("#btn-add-character-inline");
      if (addBtnInline) addBtnInline.style.display = hasChars ? "" : "none";

      // Update scene label
      const sceneLabel = $("#scene-label");
      if (sceneLabel) sceneLabel.style.display = hasChars ? "" : "none";

      // Update badge and markers
      const badge = $("#char-count-badge");
      if (badge) {
        badge.textContent = characters.length;
        badge.style.display = characters.length > 0 ? "inline-flex" : "none";
      }
      renderCharacterMarkers();
      saveCharactersToCache();
    }
    }
  }
}
