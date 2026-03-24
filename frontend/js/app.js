"use strict";

const $ = (sel) => document.querySelector(sel);

const SAMPLER_LABELS = {
  "k_euler":              "Fast",
  "k_euler_ancestral":    "Creative",
  "k_dpmpp_2s_ancestral": "Balanced",
  "k_dpmpp_2m":           "High Quality",
  "k_dpmpp_2m_sde":       "High Quality (Smooth)",
  "k_dpmpp_sde":          "Smooth",
};

const UC_PRESETS = {
  "heavy": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
  "light": "lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page",
  "human-focus": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy",
  "furry-focus": "{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic",
  "none": "",
};

const state = {
  img2img: null,          // base64 PNG at exact output resolution, set by compositeLayersToBase64()
  lastSeed: null,
  lastImageBase64: null,
  lastVideoBase64: null,  // base64 MP4 from Grok video generation
  lastGeneratedImageBase64: null, // the most recent AI-generated image (never overwritten by composite preview)
  // canvas-displayed image (may be a gallery preview, not necessarily last generated)
  canvasImageBase64: null,
  canvasImageWidth: null,
  canvasImageHeight: null,
  grokOutputType: "image", // "image" | "video" — Grok output mode
};

// ── VIBES ─────────────────────────────────────────────────
// Each entry: { base64, infoExtracted, strength }
const vibes = [];

// ── GROK REFERENCE IMAGES ─────────────────────────────────
// Each entry: { base64 }  — ordered list, up to 5
const grokRefs = [];
const MAX_GROK_REFS = 5;

// ── LAYERS ────────────────────────────────────────────────────
// Each entry: { id, name, imageBase64, maskBase64, inpaintMaskBase64, opacity, visible, isOutputTarget, offsetX, offsetY }
// Index 0 = bottom layer, last index = top layer.
const layers = [];
const MAX_LAYERS = 8;
let _movingLayer = null;
let _openLayerRedraw = null;
let _moveCleanup = null;
let _activeLayerIdx = 0;   // index into layers[] of the currently-selected layer
let _canvasView = localStorage.getItem("nai-canvas-view") || "output"; // "input" | "output"

function _enableCanvasMove(layer) {
  _disableCanvasMove();
  const output = document.getElementById("output");
  if (!output) return;
  output.style.cursor = "move";

  let dragging = false;
  let startX = 0, startY = 0, startOX = 0, startOY = 0;

  function onDown(e) {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startOX = layer.offsetX || 0;
    startOY = layer.offsetY || 0;
    e.preventDefault();
  }
  function onMove(e) {
    if (!dragging) return;
    const rect = output.getBoundingClientRect();
    const dx = (e.clientX - startX) / rect.width;
    const dy = (e.clientY - startY) / rect.height;
    layer.offsetX = startOX + dx;
    layer.offsetY = startOY + dy;
    refreshCompositePreview();
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    saveLayersToStorage();
  }
  function onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    layer.scale = Math.max(0.25, Math.min(4.0, (layer.scale !== undefined ? layer.scale : 1.0) + delta));
    updateCanvasPanel();
    refreshCompositePreview();
  }

  output.addEventListener("pointerdown", onDown);
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  output.addEventListener("wheel", onWheel, { passive: false });

  _moveCleanup = () => {
    output.removeEventListener("pointerdown", onDown);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    output.removeEventListener("wheel", onWheel);
    output.style.cursor = "";
  };
}

function _disableCanvasMove() {
  if (_moveCleanup) { _moveCleanup(); _moveCleanup = null; }
}

// ── LAYER UNDO ────────────────────────────────────────────────
// Snapshots metadata only — imageBase64 is intentionally excluded (too large).
// Canonical metadata fields: id, name, opacity, visible, isOutputTarget, offsetX, offsetY, scale, maskBase64, inpaintMaskBase64
const _layerUndoStack = [];
const _layerRedoStack = [];
const MAX_LAYER_UNDO = 20;

function _snapshotLayerMeta() {
  return layers.map((l) => ({
    id: l.id,
    name: l.name,
    opacity: l.opacity,
    visible: l.visible,
    isOutputTarget: l.isOutputTarget,
    offsetX: l.offsetX,
    offsetY: l.offsetY,
    scale: l.scale !== undefined ? l.scale : 1.0,
    maskBase64: l.maskBase64,
    inpaintMaskBase64: l.inpaintMaskBase64,
  }));
}

function pushLayerUndo(label) {
  _layerUndoStack.push({ label, meta: _snapshotLayerMeta() });
  if (_layerUndoStack.length > MAX_LAYER_UNDO) _layerUndoStack.shift();
  _layerRedoStack.length = 0;
}

function _applyLayerMeta(meta) {
  // Apply metadata snapshot onto the existing layers array.
  // Layers that no longer exist in meta are removed; new entries in meta
  // that have no matching layer in the array are skipped (images are lost on remove — by spec).
  const metaById = new Map(meta.map((m) => [m.id, m]));
  // Remove layers not in snapshot
  for (let i = layers.length - 1; i >= 0; i--) {
    if (!metaById.has(layers[i].id)) layers.splice(i, 1);
  }
  // Reorder and update metadata
  const layerById = new Map(layers.map((l) => [l.id, l]));
  layers.length = 0;
  for (const m of meta) {
    const l = layerById.get(m.id);
    if (!l) continue; // layer was removed (image gone) — skip per spec
    l.name           = m.name;
    l.opacity        = m.opacity;
    l.visible        = m.visible;
    l.isOutputTarget = m.isOutputTarget;
    l.offsetX        = m.offsetX;
    l.offsetY        = m.offsetY;
    l.scale          = m.scale !== undefined ? m.scale : 1.0;
    l.maskBase64     = m.maskBase64;
    l.inpaintMaskBase64 = m.inpaintMaskBase64;
    layers.push(l);
  }
}

function undoLayer() {
  if (_layerUndoStack.length === 0) return;
  const entry = _layerUndoStack.pop();
  _layerRedoStack.push({ label: entry.label, meta: _snapshotLayerMeta() });
  _applyLayerMeta(entry.meta);
  renderLayerList();
  saveLayersToStorage();
  refreshCompositePreview();
  showStatus("Undid: " + entry.label);
}

function redoLayer() {
  if (_layerRedoStack.length === 0) return;
  const entry = _layerRedoStack.pop();
  _layerUndoStack.push({ label: entry.label, meta: _snapshotLayerMeta() });
  _applyLayerMeta(entry.meta);
  renderLayerList();
  saveLayersToStorage();
  refreshCompositePreview();
  showStatus("Redid: " + entry.label);
}

// ── CHARACTER SLOTS ──────────────────────────────────────────
const characters = [];  // array of { prompt, x, y, positionAuto, interactions } — managed by setupCharacters()

function saveCharactersToCache() {
  try {
    const data = characters.map((c) => ({
      prompt: c.prompt, x: c.x, y: c.y,
      positionAuto: c.positionAuto,
      interactions: c.interactions || [],
    }));
    localStorage.setItem("nai-characters", JSON.stringify(data));
  } catch (_) { /* quota exceeded — ignore */ }
}

function loadCharactersFromCache() {
  try {
    const raw = localStorage.getItem("nai-characters");
    if (!raw) return [];
    return JSON.parse(raw).map((c) => ({
      prompt: c.prompt || "",
      x: typeof c.x === "number" ? c.x : 0.5,
      y: typeof c.y === "number" ? c.y : 0.5,
      positionAuto: c.positionAuto !== false,
      interactions: Array.isArray(c.interactions) ? c.interactions : [],
    }));
  } catch (_) { return []; }
}

// ── ABORT CONTROLLER ────────────────────────────────────────
let _generateAbortController = null;

// ── CROP STATE ──────────────────────────────────────────────
// Lives here so openCropOverlay and the interaction handlers share it cleanly.
const crop = {
  img: null,          // the source HTMLImageElement
  targetW: 832,       // output resolution width
  targetH: 1216,      // output resolution height
  // Pan / zoom state in "image-space" coordinates.
  // We track the offset of the image's top-left corner
  // relative to the crop frame's top-left corner, in image pixels.
  offsetX: 0,
  offsetY: 0,
  scale: 1,           // image pixels per crop-frame pixel (zoom)
  // Canvas & frame geometry (screen pixels), set on each render
  frameX: 0,
  frameY: 0,
  frameW: 0,
  frameH: 0,
  dragging: false,
  lastPointerX: 0,
  lastPointerY: 0,
};

/* ═══════════════════════════════════════════════════════════
   PROVIDER SWITCHING — NovelAI vs Grok
   ═══════════════════════════════════════════════════════════ */

function applyProvider(provider) {
  const isGrok = provider === "grok";

  // NovelAI-only sidebar elements to hide when Grok is active
  const novelaiOnly = [
    document.querySelector('[data-target="negative-prompt"]'), // Undesired tab button
    document.getElementById("quality-tags-pill"),
    document.getElementById("characters-accordion"),
    document.getElementById("auto-generate")?.closest(".toggle-switch"),
    document.getElementById("gen-settings-btn"),
    document.getElementById("layers-accordion"),
  ];

  // Config bar NovelAI-specific fields (Canvas resolution select)
  const canvasField = document.getElementById("canvas-field");
  // Seed footer row — shown for NovelAI only (Grok has no seed)
  const seedFooterRow = document.getElementById("seed-footer-row");

  novelaiOnly.forEach((el) => {
    if (el) el.style.display = isGrok ? "none" : "";
  });

  if (canvasField)    canvasField.style.display    = isGrok ? "none" : "";
  if (seedFooterRow)  seedFooterRow.style.display  = isGrok ? "none" : "";

  // Show/hide Grok-only elements
  // Note: grok-video-controls visibility is managed by the output-type toggle,
  // not by provider switching — it stays hidden until video mode is selected.
  document.querySelectorAll(".grok-only").forEach((el) => {
    if (el.id === "grok-video-controls") {
      // Only show if we're in Grok video mode
      el.style.display = (isGrok && state.grokOutputType === "video") ? "" : "none";
    } else {
      el.style.display = isGrok ? "" : "none";
    }
  });

  // Grok doesn't support negative prompts — hide the Undesired tab
  const negativeTab = document.querySelector('[data-target="negative-prompt"]');
  if (negativeTab) negativeTab.style.display = isGrok ? "none" : "";

  // When switching to Grok, ensure we're on the Prompt tab (not Undesired)
  if (isGrok) {
    const promptTab = document.querySelector('[data-target="prompt"]');
    if (negativeTab && negativeTab.classList.contains("active")) {
      if (promptTab) promptTab.click();
    }
  }

  // Hide NovelAI-only prompt controls in Grok mode
  const qualityPill = document.getElementById("quality-tags-pill");
  if (qualityPill) qualityPill.style.display = isGrok ? "none" : "";

  // Update Generate button label
  const generateBtn = document.getElementById("generate-btn");
  if (generateBtn) {
    const labelEl = generateBtn.querySelector(".btn-generate-label");
    const hintEl  = generateBtn.querySelector(".btn-generate-hint");
    if (labelEl) {
      labelEl.textContent = (isGrok && state.grokOutputType === "video") ? "Generate Video" : "Generate";
    }
    if (hintEl) {
      hintEl.textContent = "Enter";
    }
  }

  // Save to localStorage
  localStorage.setItem("nai-provider", provider);

  // Sync inpaint button visibility (NovelAI + has image)
  syncInpaintButtonVisibility();

  // Fetch Grok usage when switching to Grok
  if (isGrok) fetchGrokUsage();

  // Update canvas layer panel visibility for new provider
  updateCanvasPanel();
}

async function fetchGrokUsage() {
  const fill = document.getElementById("grok-quota-fill");
  const label = document.getElementById("grok-quota-label");
  if (!fill || !label) return;
  try {
    const resp = await fetch("/api/grok/usage");
    if (!resp.ok) { label.textContent = "—"; return; }
    const data = await resp.json();
    const remaining = data.remaining_cents / 100;
    const total = data.balance_cents / 100;
    const used = data.used_cents / 100;
    const pct = data.balance_cents > 0 ? data.remaining_cents / data.balance_cents : 0;

    fill.style.width = (pct * 100).toFixed(1) + "%";
    label.textContent = `$${remaining.toFixed(2)} / $${total.toFixed(2)}`;

    // Tooltip with breakdown
    const bar = document.getElementById("grok-quota-bar");
    if (bar) {
      bar.title = `Used $${used.toFixed(2)}\n` + data.items
        .filter(i => i.count > 0)
        .map(i => `${i.model} ${i.type}: ${i.count}x ($${(i.cost_cents / 100).toFixed(2)})`)
        .join("\n");
    }

    fill.classList.remove("warning", "danger");
    if (pct < 0.1) fill.classList.add("danger");
    else if (pct < 0.3) fill.classList.add("warning");
  } catch {
    label.textContent = "—";
  }
}

async function init() {
  try {
    const resp = await fetch("/api/options");
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    const data = await resp.json();
    populateSelect("#sampler", data.samplers.map((s) => ({
      value: s,
      label: SAMPLER_LABELS[s] || s,
    })));
    populateSelect("#resolution", data.resolutions.map((r) => ({
      value: `${r.width}x${r.height}`,
      label: r.label,
    })));

    // Restore saved resolution from localStorage
    const savedResolution = localStorage.getItem("nai-resolution");
    if (savedResolution) {
      const resolutionEl = $("#resolution");
      for (const opt of resolutionEl.options) {
        if (opt.value === savedResolution) {
          resolutionEl.value = savedResolution;
          break;
        }
      }
    }
  } catch (e) {
    showError(`Failed to load options: ${e.message}`);
  }

  bindSlider("steps", "steps-val", 0);
  bindSlider("scale", "scale-val", 1);
  bindSlider("cfg-rescale", "cfg-rescale-val", 2);
  bindSlider("strength", "strength-val", 2);
  bindSlider("noise", "noise-val", 2);

  // Persist resolution selection
  const resolutionEl = $("#resolution");
  if (resolutionEl) {
    resolutionEl.addEventListener("change", () => {
      localStorage.setItem("nai-resolution", resolutionEl.value);
    });
  }

  setupVibes();
  setupGrokRefs();
  setupCanvasDropZone();

  setupPromptTabs();
  setupHdEnhancement();
  setupTagAutocomplete();
  setupAutoSavePrompt();
  setupHistoryTabs();
  loadGallery();

  $("#generate-btn").addEventListener("click", generate);
  $("#btn-random-seed").addEventListener("click", () => { $("#seed").value = 0; });
  $("#btn-reuse-seed").addEventListener("click", reuseSeed);
  $("#btn-download").addEventListener("click", downloadImage);

  // Grok: Set as Source — move current output into the source slot in the Images panel
  const setAsSourceBtn = document.getElementById("btn-set-as-source");
  if (setAsSourceBtn) {
    setAsSourceBtn.addEventListener("click", () => {
      if (!state.lastGeneratedImageBase64) return;
      state.img2img = state.lastGeneratedImageBase64;
      renderGrokImagesList();
      syncInpaintButtonVisibility();
      showStatus("Output set as source — describe your next edit");
    });
  }

  // NovelAI → Grok handoff buttons
  function sendToGrok(outputType) {
    if (!state.lastGeneratedImageBase64) return;
    state.img2img = state.lastGeneratedImageBase64;
    grokRefs.length = 0; // clear refs for a clean edit
    state.grokOutputType = outputType;
    // Switch provider
    const providerEl = document.getElementById("provider");
    if (providerEl) providerEl.value = "grok";
    // Set Grok output type toggle
    const outputToggle = document.getElementById("grok-output-type");
    if (outputToggle) outputToggle.value = outputType;
    applyProvider("grok");
    localStorage.setItem("nai-provider", "grok");
    // Reflect new source in the Images panel
    renderGrokImagesList();
    // Clear and focus prompt
    const promptEl = document.getElementById("prompt");
    if (promptEl) { promptEl.value = ""; promptEl.focus(); }
    showStatus(outputType === "video" ? "Image sent to Grok — describe the animation" : "Image sent to Grok — describe your edit");
  }

  const editInGrokBtn = document.getElementById("btn-edit-in-grok");
  if (editInGrokBtn) editInGrokBtn.addEventListener("click", () => sendToGrok("image"));

  const animateInGrokBtn = document.getElementById("btn-animate-in-grok");
  if (animateInGrokBtn) animateInGrokBtn.addEventListener("click", () => sendToGrok("video"));

  setupTagBrowser();
  setupGuide();
  setupSettings();
  setupPromptFocus();
  setupCharacters();
  setupLightbox();
  setupCraftPanel();
  setupExplorePanel();
  setupInpaint();
  setupLayers();
  setupCanvasLayerPanel();
  setupCanvasViewToggle();
  setupLayerMask();
  setupLayerDraw();

  // Load recent characters at startup so autocomplete is populated immediately
  loadRecentCharacters();

  // Sidebar toggle
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const sidebar = document.getElementById("sidebar");
  if (sidebarToggle && sidebar) {
    const workspace = sidebar.closest(".workspace");
    const savedCollapsed = localStorage.getItem("nai-sidebar-collapsed") === "true";
    if (savedCollapsed) { sidebar.classList.add("collapsed"); if (workspace) workspace.classList.add("sidebar-collapsed"); }
    sidebarToggle.addEventListener("click", () => {
      sidebar.classList.toggle("collapsed");
      if (workspace) workspace.classList.toggle("sidebar-collapsed");
      localStorage.setItem("nai-sidebar-collapsed", sidebar.classList.contains("collapsed"));
    });
    // Tab key toggles sidebar
    document.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.target.matches("input, textarea, [contenteditable]")) {
        e.preventDefault();
        sidebarToggle.click();
      }
    });
  }

  // ── Provider switching ────────────────────────────────────
  const providerEl = document.getElementById("provider");
  if (providerEl) {
    const savedProvider = localStorage.getItem("nai-provider") || "novelai";
    providerEl.value = savedProvider;
    applyProvider(savedProvider);

    providerEl.addEventListener("change", (e) => {
      applyProvider(e.target.value);
    });
  }

  // Grok quota bar — click to refresh
  const quotaBar = document.getElementById("grok-quota-bar");
  if (quotaBar) quotaBar.addEventListener("click", fetchGrokUsage);

  // ── Grok: Output type toggle ──────────────────────────────
  document.querySelectorAll(".output-type-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".output-type-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.grokOutputType = btn.dataset.type;

      const videoControls = document.getElementById("grok-video-controls");
      if (videoControls) videoControls.style.display = btn.dataset.type === "video" ? "" : "none";

      const generateBtn = document.getElementById("generate-btn");
      if (generateBtn) {
        const labelEl = generateBtn.querySelector(".btn-generate-label");
        if (labelEl) labelEl.textContent = btn.dataset.type === "video" ? "Generate Video" : "Generate";
      }
    });
  });

  // ── Grok: Duration slider display ────────────────────────
  const durationSlider = document.getElementById("grok-duration");
  const durationVal    = document.getElementById("grok-duration-val");
  if (durationSlider && durationVal) {
    durationSlider.addEventListener("input", () => {
      durationVal.textContent = durationSlider.value + "s";
    });
  }

  // "×" Clear canvas
  const clearCanvasBtn = $("#btn-clear-canvas");
  if (clearCanvasBtn) {
    clearCanvasBtn.addEventListener("click", () => {
      state.img2img = null;
      state.canvasImageBase64 = null;
      state.lastImageBase64 = null;
      state.lastVideoBase64 = null;
      const output = $("#output");
      if (output) output.innerHTML = '<div class="placeholder"><div class="placeholder-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></div><p class="placeholder-title">Your creation awaits</p><p class="placeholder-sub">Press Generate or Enter</p><p class="placeholder-drop-hint">or drop / paste an image as source</p></div>';
      const actions = $("#image-actions");
      if (actions) actions.style.display = "none";
    });
  }

  // Enter in prompt/negative textarea = generate (Shift+Enter = newline)
  const promptEl = $("#prompt");
  const negativeEl = $("#negative-prompt");
  [promptEl, negativeEl].forEach((el) => {
    if (!el) return;
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        // Don't generate if autocomplete dropdown is visible
        const dd = $("#tag-dropdown");
        if (dd && dd.classList.contains("visible")) return;
        e.preventDefault();
        generate();
      }
    });
  });

  // Generation Settings popover toggle
  const gearBtn = $("#gen-settings-btn");
  const genPopover = $("#gen-settings-popover");
  if (gearBtn && genPopover) {
    gearBtn.addEventListener("click", () => {
      const open = genPopover.style.display !== "none";
      genPopover.style.display = open ? "none" : "flex";
      gearBtn.classList.toggle("active", !open);
    });
    // Close on outside click
    document.addEventListener("click", (e) => {
      if (genPopover.style.display === "none") return;
      if (!genPopover.contains(e.target) && !gearBtn.contains(e.target)) {
        genPopover.style.display = "none";
        gearBtn.classList.remove("active");
      }
    });
  }

  // Also keep Cmd/Ctrl+Enter as global shortcut
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      generate();
    }
    // Escape closes the crop overlay and gen-settings popover
    if (e.key === "Escape") {
      const co = $("#crop-overlay");
      if (co && co.style.display !== "none") closeCropOverlay();
      if (genPopover && genPopover.style.display !== "none") {
        genPopover.style.display = "none";
        if (gearBtn) gearBtn.classList.remove("active");
      }
    }
  });

  // Layer undo/redo: Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z
  // Guard: skip if focus is in an editable field
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key !== "z") return;
    const tag = document.activeElement && document.activeElement.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (document.activeElement && document.activeElement.isContentEditable) return;
    e.preventDefault();
    if (e.shiftKey) {
      redoLayer();
    } else {
      undoLayer();
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   CANVAS DROP ZONE SETUP
   ═══════════════════════════════════════════════════════════ */

function setupCanvasDropZone() {
  const dropTarget = $("#canvas-drop-target");
  if (dropTarget) {
    let dragCounter = 0;
    dropTarget.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragCounter++;
      if (dragCounter === 1) dropTarget.classList.add("drag-over");
    });
    dropTarget.addEventListener("dragleave", () => {
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; dropTarget.classList.remove("drag-over"); }
    });
    dropTarget.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    dropTarget.addEventListener("drop", (e) => {
      e.preventDefault();
      dragCounter = 0;
      dropTarget.classList.remove("drag-over");
      // In Grok mode, the Images panel handles drops — don't double-process
      const provider = document.getElementById("provider")?.value || "novelai";
      if (provider === "grok") return;
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith("image/")) {
        loadImageFile(file);
      }
    });
  }
}

// Paste image from clipboard → img2img
document.addEventListener("paste", (e) => {
  // Try to get image file from paste event
  let file = null;

  // Method 1: clipboardData.files
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length > 0 && files[0].type.startsWith("image/") && files[0].size > 0) {
    file = files[0];
  }

  // Method 2: clipboardData.items
  if (!file) {
    const items = e.clipboardData && e.clipboardData.items;
    if (items) {
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f && f.size > 0) { file = f; break; }
        }
      }
    }
  }

  if (file) {
    e.preventDefault();
    const provider = document.getElementById("provider")?.value || "novelai";
    if (provider === "grok") {
      loadImageFile(file);
    } else {
      showPasteActionPopup(file);
    }
    return;
  }

  // Method 3: read from macOS system clipboard via backend
  // Needed for apps like qView that produce 0-byte paste blobs in Chrome
  const items = e.clipboardData && e.clipboardData.items;
  const hasImageType = items && Array.from(items).some(i => i.type.startsWith("image/"));
  if (hasImageType) {
    e.preventDefault();
    fetch("/api/clipboard-image").then(r => {
      if (!r.ok) return;
      return r.json();
    }).then(data => {
      if (!data || !data.image) return;
      const dataUrl = "data:image/png;base64," + data.image;
      const provider = document.getElementById("provider")?.value || "novelai";
      // Create a File from the base64 data
      const byteStr = atob(data.image);
      const bytes = new Uint8Array(byteStr.length);
      for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
      const imageFile = new File([bytes], "clipboard.png", { type: "image/png" });
      if (provider === "grok") {
        loadImageFile(imageFile);
      } else {
        showPasteActionPopup(imageFile);
      }
    }).catch(() => {});
  }
});

// Global drag & drop — accept images dropped anywhere on the page
document.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
document.addEventListener("drop", (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file || !file.type.startsWith("image/")) return;
  e.preventDefault();
  const provider = document.getElementById("provider")?.value || "novelai";
  if (provider === "grok") {
    loadImageFile(file);
  } else {
    showPasteActionPopup(file);
  }
});

function showPasteActionPopup(file) {
  // Remove any existing popup
  const existing = document.querySelector(".paste-action-popup");
  if (existing) existing.remove();

  const popup = document.createElement("div");
  popup.className = "paste-action-popup";

  const title = document.createElement("div");
  title.className = "paste-action-title";
  title.textContent = "Pasted image — what to do?";
  popup.appendChild(title);

  const btnRow = document.createElement("div");
  btnRow.className = "paste-action-btns";

  const btnI2I = document.createElement("button");
  btnI2I.type = "button";
  btnI2I.className = "btn-action btn-action--primary";
  btnI2I.textContent = "Add to Layer";
  btnI2I.addEventListener("click", () => {
    popup.remove();
    loadImageFile(file);
  });

  const btnSettings = document.createElement("button");
  btnSettings.type = "button";
  btnSettings.className = "btn-action";
  btnSettings.textContent = "Load Settings";
  btnSettings.addEventListener("click", async () => {
    popup.remove();
    // Send image to backend to extract PNG metadata
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const base64 = ev.target.result.split(",")[1];
      try {
        const resp = await fetch("/api/read-image-meta", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: base64 }),
        });
        if (!resp.ok) throw new Error("No metadata");
        const meta = await resp.json();
        if (meta && meta.prompt) {
          loadSettingsFromMeta(meta);
          showStatus("Settings loaded from image");
        } else {
          showError("No generation metadata found in this image");
        }
      } catch {
        showError("Could not read metadata from this image");
      }
    };
    reader.readAsDataURL(file);
  });

  const btnCancel = document.createElement("button");
  btnCancel.type = "button";
  btnCancel.className = "btn-action";
  btnCancel.textContent = "Cancel";
  btnCancel.addEventListener("click", () => popup.remove());

  btnRow.appendChild(btnI2I);
  btnRow.appendChild(btnSettings);
  btnRow.appendChild(btnCancel);
  popup.appendChild(btnRow);
  document.body.appendChild(popup);

  // Auto-dismiss after 8 seconds
  setTimeout(() => { if (popup.parentNode) popup.remove(); }, 8000);
}

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

/* ═══════════════════════════════════════════════════════════
   CROP OVERLAY
   ═══════════════════════════════════════════════════════════ */

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

function openCropOverlay(imgEl) {
  const overlay = $("#crop-overlay");
  if (!overlay) return;
  // Prevent double-open when multiple images are imported rapidly
  if (overlay.style.display !== "none") return;

  // Read target resolution based on current provider
  const provider = document.getElementById("provider")?.value || "novelai";
  if (provider === "grok") {
    // Grok uses aspect ratios — convert to pixel dimensions for crop frame
    const ar = document.getElementById("grok-aspect-ratio")?.value || "1:1";
    const res = document.getElementById("grok-resolution")?.value || "1k";
    const baseSize = res === "2k" ? 2048 : 1024;
    if (ar === "auto") {
      // Auto: use the source image's native aspect ratio (no forced crop ratio)
      crop.targetW = imgEl.naturalWidth || baseSize;
      crop.targetH = imgEl.naturalHeight || baseSize;
    } else {
      const [aw, ah] = ar.split(":").map(Number);
      if (aw >= ah) {
        crop.targetW = baseSize;
        crop.targetH = Math.round(baseSize * ah / aw);
      } else {
        crop.targetH = baseSize;
        crop.targetW = Math.round(baseSize * aw / ah);
      }
    }
  } else {
    const resVal = $("#resolution").value || "832x1216";
    const [tw, th] = resVal.split("x").map(Number);
    crop.targetW = tw || 832;
    crop.targetH = th || 1216;
  }

  crop.img = imgEl;

  // Update resolution label in footer
  const resLabel = $("#crop-resolution-label");
  if (resLabel) resLabel.textContent = `${crop.targetW} \u00d7 ${crop.targetH}`;

  overlay.style.display = "flex";

  // Wait one frame for the overlay to be visible and sized, then init canvas
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      initCropCanvas();
      setupCropInteraction();
    });
  });
}

function closeCropOverlay() {
  const overlay = $("#crop-overlay");
  if (overlay) overlay.style.display = "none";
  // Tear down interaction listeners (they are re-added on next open)
  teardownCropInteraction();
}

// ── Canvas render ──────────────────────────────────────────

function initCropCanvas() {
  const canvasEl = $("#crop-canvas");
  const frameEl  = $("#crop-frame-overlay");
  if (!canvasEl || !frameEl || !crop.img) return;

  const stageWrap = canvasEl.parentElement;
  const stageRect = stageWrap.getBoundingClientRect();

  // Set canvas to physical pixel size of the stage
  const dpr = window.devicePixelRatio || 1;
  canvasEl.width  = stageRect.width  * dpr;
  canvasEl.height = stageRect.height * dpr;
  canvasEl.style.width  = stageRect.width  + "px";
  canvasEl.style.height = stageRect.height + "px";

  // Compute the crop frame dimensions, centered in stage,
  // preserving the target aspect ratio, with some padding.
  const padding  = 48; // px each side
  const stageW   = stageRect.width;
  const stageH   = stageRect.height;
  const targetAR = crop.targetW / crop.targetH;
  const stageAR  = (stageW - padding * 2) / (stageH - padding * 2);

  let frameW, frameH;
  if (targetAR > stageAR) {
    frameW = stageW - padding * 2;
    frameH = frameW / targetAR;
  } else {
    frameH = stageH - padding * 2;
    frameW = frameH * targetAR;
  }

  crop.frameW = frameW;
  crop.frameH = frameH;
  crop.frameX = (stageW - frameW) / 2;
  crop.frameY = (stageH - frameH) / 2;

  // Position the CSS frame overlay element
  frameEl.style.left   = crop.frameX + "px";
  frameEl.style.top    = crop.frameY + "px";
  frameEl.style.width  = frameW + "px";
  frameEl.style.height = frameH + "px";

  // Default view: "fill" — scale image so it fully covers the crop frame
  applyCropFill();
}

function applyCropFit() {
  // Scale image so it fits entirely within the crop frame
  const scaleX = crop.frameW / crop.img.naturalWidth;
  const scaleY = crop.frameH / crop.img.naturalHeight;
  crop.scale = Math.min(scaleX, scaleY);
  // Center
  crop.offsetX = (crop.img.naturalWidth  * crop.scale - crop.frameW) / 2;
  crop.offsetY = (crop.img.naturalHeight * crop.scale - crop.frameH) / 2;
  renderCropCanvas();
}

function applyCropFill() {
  // Scale image so it fully covers the crop frame (default)
  const scaleX = crop.frameW / crop.img.naturalWidth;
  const scaleY = crop.frameH / crop.img.naturalHeight;
  crop.scale = Math.max(scaleX, scaleY);
  // Center
  crop.offsetX = (crop.img.naturalWidth  * crop.scale - crop.frameW) / 2;
  crop.offsetY = (crop.img.naturalHeight * crop.scale - crop.frameH) / 2;
  renderCropCanvas();
}

function renderCropCanvas() {
  const canvasEl = $("#crop-canvas");
  if (!canvasEl || !crop.img) return;

  const dpr = window.devicePixelRatio || 1;
  const ctx  = canvasEl.getContext("2d");
  const W    = canvasEl.width;
  const H    = canvasEl.height;

  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.scale(dpr, dpr);

  // Draw the image.
  // The image's top-left corner in screen coords:
  //   imageX = frameX - offsetX
  //   imageY = frameY - offsetY
  // The image's screen dimensions:
  //   imgScreenW = naturalWidth  * scale
  //   imgScreenH = naturalHeight * scale
  const imgScreenW = crop.img.naturalWidth  * crop.scale;
  const imgScreenH = crop.img.naturalHeight * crop.scale;
  const imgX = crop.frameX - crop.offsetX;
  const imgY = crop.frameY - crop.offsetY;

  ctx.drawImage(crop.img, imgX, imgY, imgScreenW, imgScreenH);

  ctx.restore();
}

// ── Interaction ────────────────────────────────────────────

let _cropWheelHandler    = null;
let _cropPointerDownHandler = null;
let _cropPointerMoveHandler = null;
let _cropPointerUpHandler   = null;

function setupCropInteraction() {
  teardownCropInteraction(); // always clean before re-adding

  const canvasEl = $("#crop-canvas");
  const fitBtn   = $("#crop-fit");
  const fillBtn  = $("#crop-fill");
  const confirmBtn = $("#crop-confirm");
  const cancelBtn  = $("#crop-cancel");
  if (!canvasEl) return;

  // Scroll / pinch to zoom
  _cropWheelHandler = (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1.08 : 0.925;
    zoomCropAtPoint(delta, e.clientX, e.clientY);
  };
  canvasEl.addEventListener("wheel", _cropWheelHandler, { passive: false });

  // Pointer drag to pan
  _cropPointerDownHandler = (e) => {
    e.preventDefault();
    crop.dragging = true;
    crop.lastPointerX = e.clientX;
    crop.lastPointerY = e.clientY;
    canvasEl.setPointerCapture(e.pointerId);
  };

  _cropPointerMoveHandler = (e) => {
    if (!crop.dragging) return;
    const dx = e.clientX - crop.lastPointerX;
    const dy = e.clientY - crop.lastPointerY;
    crop.lastPointerX = e.clientX;
    crop.lastPointerY = e.clientY;
    // Moving the pointer right means we want to reveal more of the left side
    // of the image — i.e. decrease offsetX.
    crop.offsetX -= dx;
    crop.offsetY -= dy;
    clampCropOffset();
    renderCropCanvas();
  };

  _cropPointerUpHandler = () => {
    crop.dragging = false;
  };

  canvasEl.addEventListener("pointerdown",  _cropPointerDownHandler);
  canvasEl.addEventListener("pointermove",  _cropPointerMoveHandler);
  canvasEl.addEventListener("pointerup",    _cropPointerUpHandler);
  canvasEl.addEventListener("pointercancel", _cropPointerUpHandler);

  // Fit / Fill buttons
  if (fitBtn)  fitBtn.addEventListener("click",  applyCropFit);
  if (fillBtn) fillBtn.addEventListener("click", applyCropFill);

  // Confirm
  if (confirmBtn) confirmBtn.addEventListener("click", confirmCrop);

  // Cancel
  if (cancelBtn)  cancelBtn.addEventListener("click", closeCropOverlay);

  const skipBtn = $("#crop-skip");
  if (skipBtn) skipBtn.addEventListener("click", skipCrop);
}

function teardownCropInteraction() {
  const canvasEl = $("#crop-canvas");
  if (!canvasEl) return;
  if (_cropWheelHandler)       canvasEl.removeEventListener("wheel",        _cropWheelHandler);
  if (_cropPointerDownHandler) canvasEl.removeEventListener("pointerdown",  _cropPointerDownHandler);
  if (_cropPointerMoveHandler) canvasEl.removeEventListener("pointermove",  _cropPointerMoveHandler);
  if (_cropPointerUpHandler) {
    canvasEl.removeEventListener("pointerup",    _cropPointerUpHandler);
    canvasEl.removeEventListener("pointercancel", _cropPointerUpHandler);
  }
}

function zoomCropAtPoint(factor, clientX, clientY) {
  // Get the canvas position in screen coords
  const canvasEl  = $("#crop-canvas");
  const rect      = canvasEl.getBoundingClientRect();
  // Point in stage coords
  const stageX    = clientX - rect.left;
  const stageY    = clientY - rect.top;
  // Point in image coords (before zoom)
  const imageX    = (stageX - crop.frameX + crop.offsetX) / crop.scale;
  const imageY    = (stageY - crop.frameY + crop.offsetY) / crop.scale;

  const newScale  = Math.max(
    Math.max(crop.frameW / crop.img.naturalWidth, crop.frameH / crop.img.naturalHeight) * 0.5,
    Math.min(crop.scale * factor, 20)
  );

  // Adjust offset so the point under the pointer stays fixed
  crop.offsetX = imageX * newScale - (stageX - crop.frameX);
  crop.offsetY = imageY * newScale - (stageY - crop.frameY);
  crop.scale   = newScale;

  clampCropOffset();
  renderCropCanvas();
}

function clampCropOffset() {
  // Prevent the image from leaving the crop frame with empty space.
  // offsetX/Y represent how many image-screen-pixels are hidden on the left/top.
  const imgScreenW = crop.img.naturalWidth  * crop.scale;
  const imgScreenH = crop.img.naturalHeight * crop.scale;

  // If the image is smaller than the frame in a dimension, center it — allow
  // it to float (no clamping). If it's larger, clamp so no gap appears.
  if (imgScreenW >= crop.frameW) {
    crop.offsetX = Math.max(0, Math.min(crop.offsetX, imgScreenW - crop.frameW));
  } else {
    crop.offsetX = (imgScreenW - crop.frameW) / 2; // center (negative offset)
  }

  if (imgScreenH >= crop.frameH) {
    crop.offsetY = Math.max(0, Math.min(crop.offsetY, imgScreenH - crop.frameH));
  } else {
    crop.offsetY = (imgScreenH - crop.frameH) / 2;
  }
}

// ── Confirm: export at exact target resolution ────────────

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

function showGrokSourceOnCanvas(dataUrl) {
  const output = $("#output");
  if (!output) return;
  output.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "grok-source-wrap";

  const img = document.createElement("img");
  img.src = dataUrl;
  img.alt = "Source image";

  const badge = document.createElement("div");
  badge.className = "grok-source-banner";
  badge.textContent = "Source Image";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "grok-source-remove";
  removeBtn.title = "Remove source image";
  removeBtn.innerHTML = "✕";
  removeBtn.addEventListener("click", () => {
    state.img2img = null;
    output.innerHTML = "";
    state.canvasImageBase64 = null;
    state.canvasImageWidth = null;
    state.canvasImageHeight = null;
  });

  wrap.appendChild(img);
  wrap.appendChild(badge);
  wrap.appendChild(removeBtn);
  output.appendChild(wrap);
}

/* ═══════════════════════════════════════════════════════════
   SETTINGS
   ═══════════════════════════════════════════════════════════ */

function setupSettings() {
  const overlay = $("#settings-overlay");
  const openBtn = $("#settings-btn");
  const closeBtn = $("#settings-close");
  const pathInput = $("#settings-output-dir");
  const browseBtn = $("#settings-browse");
  const openFolderBtn = $("#settings-open-folder");
  if (!overlay || !openBtn) return;

  async function loadSettings() {
    const resp = await fetch("/api/settings");
    if (resp.ok) {
      const data = await resp.json();
      pathInput.value = data.output_dir;
    }
  }

  openBtn.addEventListener("click", () => {
    overlay.style.display = "flex";
    loadSettings();
  });
  closeBtn.addEventListener("click", () => { overlay.style.display = "none"; });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.style.display = "none";
  });

  browseBtn.addEventListener("click", async () => {
    browseBtn.textContent = "Choosing...";
    browseBtn.disabled = true;
    try {
      const resp = await fetch("/api/settings/browse", { method: "POST" });
      if (resp.ok) {
        const data = await resp.json();
        if (data.path) {
          pathInput.value = data.path;
          await fetch("/api/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ output_dir: data.path }),
          });
          loadGallery();
        }
      }
    } finally {
      browseBtn.textContent = "Browse";
      browseBtn.disabled = false;
    }
  });

  openFolderBtn.addEventListener("click", () => {
    fetch("/api/settings/open-folder", { method: "POST" });
  });
}

/* ═══════════════════════════════════════════════════════════
   GUIDE
   ═══════════════════════════════════════════════════════════ */

function setupGuide() {
  const overlay = $("#guide-overlay");
  const openBtn = $("#guide-btn");
  const closeBtn = $("#guide-close");
  if (!overlay || !openBtn) return;

  openBtn.addEventListener("click", () => { overlay.style.display = "flex"; });
  closeBtn.addEventListener("click", () => { overlay.style.display = "none"; });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.style.display = "none";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (overlay.style.display !== "none") overlay.style.display = "none";
      const settingsOverlay = $("#settings-overlay");
      if (settingsOverlay && settingsOverlay.style.display !== "none") settingsOverlay.style.display = "none";
      // crop-overlay Escape is handled in init() to avoid double-handling
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   PROMPT FOCUS MODE
   ═══════════════════════════════════════════════════════════ */

function setupPromptFocus() {
  const overlay     = $("#prompt-focus-overlay");
  const expandBtn   = $("#prompt-expand-btn");
  const closeBtn    = $("#prompt-focus-close");
  const doneBtn     = $("#prompt-focus-done");
  const focusTa     = $("#prompt-focus-textarea");
  const tokenCount  = $("#prompt-focus-token-count");
  const focusTabs   = overlay ? overlay.querySelectorAll(".prompt-focus-tab") : [];

  if (!overlay || !expandBtn || !focusTa) return;

  const sidebarPrompt   = $("#prompt");
  const sidebarNegative = $("#negative-prompt");

  // The sidebar textarea currently synced with the modal
  let _activeSidebarTa = sidebarPrompt;
  let _syncing = false;

  // ── Cleanup ref for the input listener we add on open ───
  let _modalInputHandler = null;

  function updateTokenCount() {
    const len = focusTa.value.length;
    tokenCount.textContent = "~" + Math.ceil(len / 4) + " tokens";
  }

  function openPromptFocus() {
    // Determine which sidebar tab is active
    const activeTab = document.querySelector(".prompt-tab.active");
    const isNegative = activeTab && activeTab.dataset.target === "negative-prompt";
    _activeSidebarTa = isNegative ? sidebarNegative : sidebarPrompt;

    // Mirror modal tabs
    focusTabs.forEach((t) => {
      t.classList.toggle("active", t.dataset.focusTarget === (isNegative ? "negative-prompt" : "prompt"));
    });

    // Copy sidebar value into modal
    focusTa.value = _activeSidebarTa ? _activeSidebarTa.value : "";
    updateTokenCount();

    // Reset animation and show overlay
    const shell = overlay.querySelector(".prompt-focus-shell");
    if (shell) { shell.style.animation = "none"; void shell.offsetWidth; shell.style.animation = ""; }
    overlay.style.display = "flex";

    // Attach bidirectional sync
    _modalInputHandler = () => {
      if (_syncing) return;
      _syncing = true;
      if (_activeSidebarTa) {
        _activeSidebarTa.value = focusTa.value;
        _activeSidebarTa.dispatchEvent(new Event("input", { bubbles: true }));
      }
      updateTokenCount();
      _syncing = false;
    };
    focusTa.addEventListener("input", _modalInputHandler);

    // Focus textarea at end
    focusTa.focus();
    focusTa.setSelectionRange(focusTa.value.length, focusTa.value.length);
  }

  function closePromptFocus() {
    overlay.style.display = "none";
    _tagAC.hide();

    // Remove input listener
    if (_modalInputHandler) {
      focusTa.removeEventListener("input", _modalInputHandler);
      _modalInputHandler = null;
    }

    // Return focus to whichever sidebar textarea was active
    if (_activeSidebarTa) _activeSidebarTa.focus();
  }

  // ── Tab switching inside modal ───────────────────────────
  focusTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      focusTabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      const isNeg = tab.dataset.focusTarget === "negative-prompt";
      const nextTa = isNeg ? sidebarNegative : sidebarPrompt;

      // Flush current modal value to old sidebar ta before switching
      if (_activeSidebarTa && !_syncing) {
        _activeSidebarTa.value = focusTa.value;
        _activeSidebarTa.dispatchEvent(new Event("input", { bubbles: true }));
      }

      _activeSidebarTa = nextTa;

      // Copy new sidebar ta value into modal
      focusTa.value = _activeSidebarTa ? _activeSidebarTa.value : "";
      updateTokenCount();
      focusTa.focus();

      // Also switch the sidebar tab so they stay in sync
      const sidebarTab = document.querySelector(`.prompt-tab[data-target="${tab.dataset.focusTarget}"]`);
      if (sidebarTab) sidebarTab.click();
    });
  });

  // ── Event bindings ───────────────────────────────────────
  expandBtn.addEventListener("click", openPromptFocus);
  closeBtn.addEventListener("click", closePromptFocus);
  doneBtn.addEventListener("click", closePromptFocus);

  // Backdrop click (but not shell click)
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePromptFocus();
  });

  // Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.style.display !== "none") {
      closePromptFocus();
    }
  });

  // Cmd+E / Ctrl+E — open from either sidebar textarea
  [sidebarPrompt, sidebarNegative].forEach((ta) => {
    if (!ta) return;
    ta.addEventListener("keydown", (e) => {
      const trigger = e.metaKey || e.ctrlKey;
      if (trigger && e.key === "e") {
        e.preventDefault();
        openPromptFocus();
      }
    });
  });

  // Attach tag autocomplete to focus textarea once (not on every open)
  _tagAC.attach(focusTa);
}

/* ═══════════════════════════════════════════════════════════
   PROMPT TABS
   ═══════════════════════════════════════════════════════════ */

function setupPromptTabs() {
  const tabs = document.querySelectorAll(".prompt-tab");
  const prompt = $("#prompt");
  const negative = $("#negative-prompt");
  const ucPreset = $("#uc-preset");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      if (tab.dataset.target === "prompt") {
        prompt.style.display = "";
        negative.style.display = "none";
        if (ucPreset) ucPreset.style.display = "none";
      } else {
        prompt.style.display = "none";
        negative.style.display = "";
        if (ucPreset) ucPreset.style.display = "";
      }
    });
  });

  if (ucPreset) {
    ucPreset.addEventListener("change", () => {
      const text = UC_PRESETS[ucPreset.value];
      if (text !== undefined) {
        negative.value = text;
      }
    });
  }
}

/* ═══════════════════════════════════════════════════════════
   HD ENHANCEMENT
   ═══════════════════════════════════════════════════════════ */

function setupHdEnhancement() {
  const toggle = $("#hd-enhancement");
  const smea = $("#smea");
  const smeaDyn = $("#smea-dyn");
  if (!toggle || !smea || !smeaDyn) return;

  toggle.addEventListener("change", () => {
    smea.checked = toggle.checked;
    smeaDyn.checked = toggle.checked;
  });
}

/* ═══════════════════════════════════════════════════════════
   AUTO-SAVE PROMPT
   ═══════════════════════════════════════════════════════════ */

function setupAutoSavePrompt() {
  const prompt = $("#prompt");
  const negative = $("#negative-prompt");

  const savedPrompt = localStorage.getItem("nai-prompt");
  const savedNegative = localStorage.getItem("nai-negative");
  if (savedPrompt !== null) prompt.value = savedPrompt;
  if (savedNegative !== null) negative.value = savedNegative;

  prompt.addEventListener("input", () => {
    localStorage.setItem("nai-prompt", prompt.value);
    _checkImageMention(prompt);
  });

  // ── @ Image Mention ───────────────────────────────────────
  let _mentionDropdown = null;
  let _mentionTarget = null;

  function _checkImageMention(textarea) {
    const provider = document.getElementById("provider")?.value || "novelai";
    if (provider !== "grok") { _closeMention(); return; }

    const val = textarea.value;
    const pos = textarea.selectionStart;
    // Check if the character just before cursor is @
    if (pos > 0 && val[pos - 1] === "@") {
      _showMentionDropdown(textarea, pos);
    } else {
      _closeMention();
    }
  }

  function _showMentionDropdown(textarea, atPos) {
    _closeMention();
    const images = [];
    if (state.img2img) images.push({ label: "Source · Image 1", b64: state.img2img, ref: "the source image" });
    grokRefs.forEach((r, i) => {
      images.push({ label: `Ref ${i + 1} · Image ${i + 2}`, b64: r.base64, ref: `image ${i + 2}` });
    });
    if (images.length === 0) return;

    const dd = document.createElement("div");
    dd.className = "image-mention-dropdown";
    _mentionDropdown = dd;
    _mentionTarget = textarea;

    images.forEach((img, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "image-mention-item";
      if (idx === 0) btn.classList.add("image-mention-item--selected");

      const thumb = document.createElement("img");
      thumb.className = "image-mention-thumb";
      thumb.src = "data:image/png;base64," + img.b64;

      const label = document.createElement("span");
      label.className = "image-mention-label";
      label.textContent = img.label;

      btn.appendChild(thumb);
      btn.appendChild(label);

      btn.addEventListener("mousedown", (e) => {
        e.preventDefault(); // prevent blur
        // Replace the @ with the reference text
        const before = textarea.value.substring(0, atPos - 1);
        const after = textarea.value.substring(atPos);
        textarea.value = before + img.ref + " " + after;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        const newPos = (before + img.ref + " ").length;
        textarea.setSelectionRange(newPos, newPos);
        textarea.focus();
        _closeMention();
      });

      dd.appendChild(btn);
    });

    // Position near the textarea cursor
    const rect = textarea.getBoundingClientRect();
    dd.style.position = "fixed";
    dd.style.left = rect.left + "px";
    dd.style.top = (rect.bottom + 4) + "px";
    document.body.appendChild(dd);

    // Close on next input that isn't @, or on blur/escape
    function onBlur() { setTimeout(_closeMention, 150); }
    function onKeydown(e) {
      if (e.key === "Escape") { e.stopImmediatePropagation(); _closeMention(); }
    }
    textarea.addEventListener("blur", onBlur, { once: true });
    textarea.addEventListener("keydown", onKeydown, { once: true });
  }

  function _closeMention() {
    if (_mentionDropdown && _mentionDropdown.parentNode) {
      _mentionDropdown.parentNode.removeChild(_mentionDropdown);
    }
    _mentionDropdown = null;
    _mentionTarget = null;
  }
  negative.addEventListener("input", () => {
    localStorage.setItem("nai-negative", negative.value);
  });

  // ── Prompt History — Spotlight style (separated by provider) ──
  const MAX_PROMPT_HISTORY = 50;
  const histBtn = document.getElementById("prompt-history-btn");
  const histOverlay = document.getElementById("prompt-history-overlay");
  const histSearch = document.getElementById("prompt-history-search");
  const histList = document.getElementById("prompt-history-list");
  let _histSelectedIdx = -1;

  function _getHistoryKey() {
    const provider = document.getElementById("provider")?.value || "novelai";
    return "nai-prompt-history-" + provider;
  }

  function _loadHistory() {
    try { return JSON.parse(localStorage.getItem(_getHistoryKey()) || "[]"); }
    catch { return []; }
  }

  function _saveHistory(list) {
    try { localStorage.setItem(_getHistoryKey(), JSON.stringify(list)); }
    catch { /* quota */ }
  }

  window._savePromptToHistory = function() {
    const text = prompt.value.trim();
    console.log("[prompt-history] saving:", text ? text.substring(0, 30) + "..." : "(empty)");
    if (!text) return;
    const list = _loadHistory().filter((p) => p !== text);
    list.unshift(text);
    if (list.length > MAX_PROMPT_HISTORY) list.length = MAX_PROMPT_HISTORY;
    _saveHistory(list);
  };

  function _highlightMatch(text, query) {
    if (!query) return document.createTextNode(text);
    const span = document.createElement("span");
    const lower = text.toLowerCase();
    const qLower = query.toLowerCase();
    let pos = 0;
    while (pos < text.length) {
      const idx = lower.indexOf(qLower, pos);
      if (idx === -1) { span.appendChild(document.createTextNode(text.slice(pos))); break; }
      if (idx > pos) span.appendChild(document.createTextNode(text.slice(pos, idx)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(idx, idx + query.length);
      span.appendChild(mark);
      pos = idx + query.length;
    }
    return span;
  }

  function _renderHistoryList(query) {
    if (!histList) return;
    const list = _loadHistory();
    const q = (query || "").trim().toLowerCase();
    const filtered = q ? list.filter((p) => p.toLowerCase().includes(q)) : list;

    histList.innerHTML = "";
    _histSelectedIdx = -1;

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "prompt-history-empty";
      empty.textContent = q ? "No matches" : "No prompt history yet";
      histList.appendChild(empty);
      return;
    }

    filtered.forEach((text, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "prompt-history-item";
      btn.appendChild(_highlightMatch(text, query));
      btn.addEventListener("click", () => {
        prompt.value = text;
        prompt.dispatchEvent(new Event("input", { bubbles: true }));
        _closeHistory();
      });
      btn.addEventListener("mouseenter", () => {
        _histSelectedIdx = idx;
        _updateSelection();
      });
      histList.appendChild(btn);
    });
  }

  function _updateSelection() {
    const items = histList.querySelectorAll(".prompt-history-item");
    items.forEach((el, i) => el.classList.toggle("prompt-history-item--selected", i === _histSelectedIdx));
    if (_histSelectedIdx >= 0 && items[_histSelectedIdx]) {
      items[_histSelectedIdx].scrollIntoView({ block: "nearest" });
    }
  }

  function _openHistory() {
    if (!histOverlay) return;
    histOverlay.style.display = "";
    if (histSearch) { histSearch.value = ""; histSearch.focus(); }
    _renderHistoryList("");
  }

  function _closeHistory() {
    if (histOverlay) histOverlay.style.display = "none";
  }

  if (histBtn) histBtn.addEventListener("click", _openHistory);

  if (histOverlay) {
    histOverlay.addEventListener("click", (e) => { if (e.target === histOverlay) _closeHistory(); });

    if (histSearch) {
      histSearch.addEventListener("input", () => _renderHistoryList(histSearch.value));

      histSearch.addEventListener("keydown", (e) => {
        const items = histList.querySelectorAll(".prompt-history-item");
        if (e.key === "Escape") { e.stopImmediatePropagation(); _closeHistory(); return; }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          _histSelectedIdx = Math.min(_histSelectedIdx + 1, items.length - 1);
          _updateSelection();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          _histSelectedIdx = Math.max(_histSelectedIdx - 1, 0);
          _updateSelection();
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (_histSelectedIdx >= 0 && items[_histSelectedIdx]) items[_histSelectedIdx].click();
          else if (items.length > 0) items[0].click();
        }
      });
    }
  }

  // Ctrl+H / Cmd+H shortcut to open prompt history
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "h") {
      if (e.target.matches("input, textarea, [contenteditable]") && histOverlay?.style.display !== "none") return;
      e.preventDefault();
      if (histOverlay?.style.display === "none") _openHistory(); else _closeHistory();
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   TAG AUTOCOMPLETE — shared singleton dropdown
   Single dropdown element (position: fixed) shared by all
   textareas. getBoundingClientRect() positions it correctly
   under any textarea regardless of scroll context or
   overflow:hidden ancestors.
   ═══════════════════════════════════════════════════════════ */

const _tagAC = (() => {
  const dropdown = $("#tag-dropdown");
  let selectedIdx = -1;
  let activeEl = null;   // the textarea/input currently driving autocomplete
  let debounceTimer = null;

  // ── Positioning ─────────────────────────────────────────
  function repositionDropdown() {
    if (!activeEl) return;
    const rect = activeEl.getBoundingClientRect();
    const viewH = window.innerHeight;
    const ddH = Math.min(220, dropdown.scrollHeight || 220);
    const spaceBelow = viewH - rect.bottom;
    const showAbove = spaceBelow < ddH + 8 && rect.top > ddH + 8;

    dropdown.style.width = rect.width + "px";
    dropdown.style.left  = rect.left + "px";
    if (showAbove) {
      dropdown.style.top    = "";
      dropdown.style.bottom = (viewH - rect.top + 4) + "px";
    } else {
      dropdown.style.bottom = "";
      dropdown.style.top    = (rect.bottom + 2) + "px";
    }
  }

  // ── Helpers ──────────────────────────────────────────────
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function formatCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000)    return (n / 1000).toFixed(0) + "k";
    return String(n);
  }

  function getWordAtCursor(el) {
    const val = el.value;
    const cursor = el.selectionStart;
    let start = val.lastIndexOf(",", cursor - 1) + 1;
    while (start < cursor && val[start] === " ") start++;
    const word = val.slice(start, cursor).trim();
    return { word, start, end: cursor };
  }

  // ── Dropdown render ──────────────────────────────────────
  async function fetchAndShow(query) {
    const isCharTextarea = activeEl && activeEl.classList.contains("char-slot-textarea");
    const minLen = isCharTextarea ? 1 : 2;
    if (query.length < minLen) { hide(); return; }
    try {
      const resp = await fetch(`/api/tags?q=${encodeURIComponent(query)}`);
      if (!resp.ok) return;
      const apiTags = await resp.json();

      // For character textareas, find recent matches and prepend them
      if (isCharTextarea && _recentCharacters.length) {
        const qNorm = query.toLowerCase().replace(/ /g, "_");
        const recentMatches = _recentCharacters
          .filter(rc => rc.tag.toLowerCase().includes(qNorm))
          .slice(0, 3);
        const recentTagNames = new Set(recentMatches.map(r => r.tag));
        const dedupedTags = apiTags.filter(t => !recentTagNames.has(t.name));
        show(dedupedTags, query, recentMatches);
      } else {
        show(apiTags, query, []);
      }
    } catch { /* ignore */ }
  }

  function buildNameSpan(tagName, q) {
    const nameSpan = document.createElement("span");
    nameSpan.className = "tag-item-name";
    const name = tagName.replace(/_/g, " ");
    const qDisplay = q.replace(/_/g, " ");
    const idx = name.toLowerCase().indexOf(qDisplay.toLowerCase());
    if (idx >= 0) {
      nameSpan.innerHTML = escapeHtml(name.slice(0, idx))
        + "<mark>" + escapeHtml(name.slice(idx, idx + qDisplay.length)) + "</mark>"
        + escapeHtml(name.slice(idx + qDisplay.length));
    } else {
      nameSpan.textContent = name;
    }
    return nameSpan;
  }

  function show(tags, query, recentMatches) {
    if (!tags.length && !recentMatches.length) { hide(); return; }
    selectedIdx = -1;
    const q = query.toLowerCase();
    dropdown.innerHTML = "";

    // Prepend recent character matches
    for (const rc of recentMatches) {
      const item = document.createElement("div");
      item.className = "tag-item tag-item--recent";

      const nameSpan = buildNameSpan(rc.tag, q);

      const badgeSpan = document.createElement("span");
      badgeSpan.className = "tag-item-recent-badge";
      badgeSpan.textContent = "RECENT";

      const countSpan = document.createElement("span");
      countSpan.className = "tag-item-count";
      countSpan.textContent = `\u00d7${rc.count}`;

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "tag-item-delete";
      delBtn.textContent = "\u00d7";
      delBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        fetch(`/api/recent-characters/${encodeURIComponent(rc.tag)}`, { method: "DELETE" });
        const idx = _recentCharacters.indexOf(rc);
        if (idx >= 0) _recentCharacters.splice(idx, 1);
        item.remove();
        if (!dropdown.querySelectorAll(".tag-item").length) hide();
      });

      item.appendChild(nameSpan);
      item.appendChild(badgeSpan);
      item.appendChild(countSpan);
      item.appendChild(delBtn);

      item.addEventListener("mousedown", (e) => {
        if (e.target.closest(".tag-item-delete")) return;
        e.preventDefault();
        insert(rc.tag);
      });

      dropdown.appendChild(item);
    }

    // API results
    tags.forEach((tag) => {
      const item = document.createElement("div");
      item.className = "tag-item";

      const nameSpan = buildNameSpan(tag.name, q);

      const catSpan = document.createElement("span");
      catSpan.className = "tag-item-cat";
      catSpan.dataset.cat = tag.category;
      catSpan.textContent = tag.category;

      const countSpan = document.createElement("span");
      countSpan.className = "tag-item-count";
      countSpan.textContent = formatCount(tag.count);

      item.appendChild(nameSpan);
      item.appendChild(catSpan);
      item.appendChild(countSpan);

      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        insert(tag.name);
      });

      dropdown.appendChild(item);
    });
    dropdown.classList.add("visible");
    repositionDropdown();
  }

  function hide() {
    dropdown.classList.remove("visible");
    selectedIdx = -1;
  }

  // ── Tag insertion ────────────────────────────────────────
  function insert(tagName) {
    if (!activeEl) return;
    const { start, end } = getWordAtCursor(activeEl);
    const val = activeEl.value;
    const before = val.slice(0, start);
    const after  = val.slice(end);
    const tag    = tagName.replace(/_/g, " ");
    const needsCommaBefore = before.length > 0 && !before.trimEnd().endsWith(",");
    const needsCommaAfter = after.length === 0 || !after.trimStart().startsWith(",");
    const insertStr = (needsCommaBefore ? ", " : "") + tag + (needsCommaAfter ? ", " : "");
    activeEl.value = before + insertStr + after;
    const newPos = before.length + insertStr.length;
    activeEl.selectionStart = activeEl.selectionEnd = newPos;
    activeEl.focus();
    activeEl.dispatchEvent(new Event("input", { bubbles: true }));
    hide();
  }

  // ── Event handlers for a single element ─────────────────
  function handleInput(e) {
    clearTimeout(debounceTimer);
    activeEl = e.target;
    const { word } = getWordAtCursor(e.target);
    debounceTimer = setTimeout(() => fetchAndShow(word), 150);
  }

  function handleKeydown(e) {
    if (!dropdown.classList.contains("visible")) return;
    const items = dropdown.querySelectorAll(".tag-item");
    if (!items.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle("selected", i === selectedIdx));
      if (selectedIdx >= 0) items[selectedIdx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle("selected", i === selectedIdx));
      if (selectedIdx >= 0) items[selectedIdx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Tab") {
      // Tab always autocompletes: select first item if none highlighted
      if (selectedIdx < 0 && items.length > 0) selectedIdx = 0;
      if (selectedIdx >= 0) {
        e.preventDefault();
        const name = items[selectedIdx].querySelector(".tag-item-name").textContent;
        insert(name.replace(/ /g, "_"));
      }
    } else if (e.key === "Escape") {
      e.stopImmediatePropagation();
      hide();
    }
  }

  function handleBlur() {
    setTimeout(hide, 150);
  }

  function handleFocus(e) {
    activeEl = e.target;
  }

  // ── Public: attach autocomplete to any input/textarea ───
  function attach(el) {
    el.addEventListener("focus",   handleFocus);
    el.addEventListener("input",   handleInput);
    el.addEventListener("keydown", handleKeydown);
    el.addEventListener("blur",    handleBlur);
  }

  // Reposition on scroll/resize so dropdown follows the field
  window.addEventListener("scroll",  () => { if (dropdown.classList.contains("visible")) repositionDropdown(); }, { passive: true });
  window.addEventListener("resize",  () => { if (dropdown.classList.contains("visible")) repositionDropdown(); }, { passive: true });

  return { attach, hide };
})();

function setupTagAutocomplete() {
  const prompt   = $("#prompt");
  const negative = $("#negative-prompt");
  if (!prompt) return;
  _tagAC.attach(prompt);
  if (negative) _tagAC.attach(negative);
}

/* ═══════════════════════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════════════════════ */

function populateSelect(selector, options) {
  const el = $(selector);
  if (!el) return;
  el.innerHTML = "";
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    el.appendChild(opt);
  }
}

function bindSlider(id, valId, decimals) {
  const slider = $(`#${id}`);
  const display = $(`#${valId}`);
  if (!slider || !display) return;
  display.textContent = parseFloat(slider.value).toFixed(decimals);
  slider.addEventListener("input", () => {
    display.textContent = parseFloat(slider.value).toFixed(decimals);
  });
}

function setupFileUpload(inputId, previewId, placeholderId, clearId, stateKey) {
  const input = $(`#${inputId}`);
  const preview = $(`#${previewId}`);
  const placeholder = $(`#${placeholderId}`);
  const clearBtn = $(`#${clearId}`);
  if (!input || !preview || !clearBtn) return;

  input.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      state[stateKey] = dataUrl.split(",")[1];
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = "preview";
      preview.innerHTML = "";
      preview.appendChild(img);
      if (placeholder) placeholder.style.display = "none";
      clearBtn.style.display = "inline-block";
    };
    reader.readAsDataURL(file);
  });

  clearBtn.addEventListener("click", () => {
    state[stateKey] = null;
    preview.innerHTML = "";
    input.value = "";
    clearBtn.style.display = "none";
    if (placeholder) placeholder.style.display = "flex";
  });
}

/* ═══════════════════════════════════════════════════════════
   VIBES — multiple style reference images (up to 4)
   ═══════════════════════════════════════════════════════════ */

const MAX_VIBES = 4;

function setupVibes() {
  const addBtn = $("#btn-add-vibe");
  const fileInput = $("#vibe-file-input");
  if (!addBtn || !fileInput) return;

  addBtn.addEventListener("click", () => {
    if (vibes.length >= MAX_VIBES) return;
    fileInput.value = "";
    fileInput.click();
  });

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const base64 = ev.target.result.split(",")[1];
      vibes.push({ base64, infoExtracted: 1.0, strength: 0.6 });
      renderVibeList();
    };
    reader.readAsDataURL(file);
    fileInput.value = "";
  });
}

function renderVibeList() {
  const list = $("#vibe-list");
  const addBtn = $("#btn-add-vibe");
  if (!list) return;

  list.innerHTML = "";

  if (vibes.length === 0) {
    const hint = document.createElement("p");
    hint.className = "vibe-empty-hint";
    hint.textContent = 'No vibes added. Click "Add Vibe" to upload a style reference image.';
    list.appendChild(hint);
  } else {
    vibes.forEach((vibe, idx) => {
      list.appendChild(buildVibeEntry(vibe, idx));
    });
  }

  if (addBtn) addBtn.disabled = vibes.length >= MAX_VIBES;
}

function buildVibeEntry(vibe, idx) {
  const entry = document.createElement("div");
  entry.className = "vibe-entry";

  // Thumbnail
  const thumb = document.createElement("img");
  thumb.className = "vibe-thumb";
  thumb.src = `data:image/png;base64,${vibe.base64}`;
  thumb.alt = `Style reference ${idx + 1}`;
  entry.appendChild(thumb);

  // Sliders column
  const sliders = document.createElement("div");
  sliders.className = "vibe-sliders";

  // Info Extracted row
  const infoRow = document.createElement("div");
  infoRow.className = "vibe-slider-row";
  const infoHeader = document.createElement("div");
  infoHeader.className = "vibe-slider-header";
  const infoLabel = document.createElement("span");
  infoLabel.className = "vibe-slider-label";
  infoLabel.textContent = "Info";
  const infoVal = document.createElement("span");
  infoVal.className = "slider-value";
  infoVal.textContent = vibe.infoExtracted.toFixed(2);
  infoHeader.appendChild(infoLabel);
  infoHeader.appendChild(infoVal);
  const infoRange = document.createElement("input");
  infoRange.type = "range";
  infoRange.className = "field-range";
  infoRange.min = "0";
  infoRange.max = "1";
  infoRange.step = "0.05";
  infoRange.value = String(vibe.infoExtracted);
  infoRange.addEventListener("input", () => {
    vibe.infoExtracted = parseFloat(infoRange.value);
    infoVal.textContent = vibe.infoExtracted.toFixed(2);
  });
  infoRow.appendChild(infoHeader);
  infoRow.appendChild(infoRange);
  sliders.appendChild(infoRow);

  // Strength row
  const strRow = document.createElement("div");
  strRow.className = "vibe-slider-row";
  const strHeader = document.createElement("div");
  strHeader.className = "vibe-slider-header";
  const strLabel = document.createElement("span");
  strLabel.className = "vibe-slider-label";
  strLabel.textContent = "Str";
  const strVal = document.createElement("span");
  strVal.className = "slider-value";
  strVal.textContent = vibe.strength.toFixed(2);
  strHeader.appendChild(strLabel);
  strHeader.appendChild(strVal);
  const strRange = document.createElement("input");
  strRange.type = "range";
  strRange.className = "field-range";
  strRange.min = "0";
  strRange.max = "1";
  strRange.step = "0.05";
  strRange.value = String(vibe.strength);
  strRange.addEventListener("input", () => {
    vibe.strength = parseFloat(strRange.value);
    strVal.textContent = vibe.strength.toFixed(2);
  });
  strRow.appendChild(strHeader);
  strRow.appendChild(strRange);
  sliders.appendChild(strRow);

  entry.appendChild(sliders);

  // Remove button
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "vibe-remove-btn";
  removeBtn.setAttribute("aria-label", `Remove style reference ${idx + 1}`);
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", () => {
    vibes.splice(idx, 1);
    renderVibeList();
  });
  entry.appendChild(removeBtn);

  return entry;
}

/* ═══════════════════════════════════════════════════════════
   GROK IMAGES — unified source + references panel
   ═══════════════════════════════════════════════════════════ */

// Pending target for the file picker: "source" | "ref"
let _grokFilePickerTarget = "ref";

function setupGrokRefs() {
  const addBtn = $("#btn-add-grok-ref");
  const fileInput = $("#grok-ref-file-input");
  const imagesList = $("#grok-images-list");
  if (!fileInput || !imagesList) return;

  // ── Add Reference button ────────────────────────────────
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      if (grokRefs.length >= MAX_GROK_REFS) return;
      _grokFilePickerTarget = "ref";
      fileInput.value = "";
      fileInput.click();
    });
  }

  // ── Source slot: click to pick ──────────────────────────
  imagesList.addEventListener("click", (e) => {
    const drop = e.target.closest("#grok-source-drop");
    if (drop) {
      _grokFilePickerTarget = "source";
      fileInput.value = "";
      fileInput.click();
    }
  });

  // ── Source slot: clear button ───────────────────────────
  imagesList.addEventListener("click", (e) => {
    const btn = e.target.closest(".grok-slot-remove[data-role='source']");
    if (btn) {
      state.img2img = null;
      renderGrokImagesList();
      syncInpaintButtonVisibility();
    }
  });

  // ── Ref slot: remove button ─────────────────────────────
  imagesList.addEventListener("click", (e) => {
    const btn = e.target.closest(".grok-slot-remove[data-role='ref']");
    if (btn) {
      const idx = parseInt(btn.dataset.idx, 10);
      grokRefs.splice(idx, 1);
      renderGrokImagesList();
    }
  });

  // ── File picker result ──────────────────────────────────
  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    readImageFile(file, (base64) => {
      if (_grokFilePickerTarget === "source") {
        state.img2img = base64;
        renderGrokImagesList();
        syncInpaintButtonVisibility();
      } else {
        if (grokRefs.length < MAX_GROK_REFS) {
          grokRefs.push({ base64 });
          renderGrokImagesList();
        }
      }
    });
    fileInput.value = "";
  });

  // ── Drag-and-drop on the list panel ────────────────────
  imagesList.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    imagesList.classList.add("drag-over");
  });
  imagesList.addEventListener("dragleave", (e) => {
    if (!imagesList.contains(e.relatedTarget)) {
      imagesList.classList.remove("drag-over");
    }
  });
  imagesList.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    imagesList.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith("image/")) return;
    readImageFile(file, (base64) => {
      if (!state.img2img) {
        state.img2img = base64;
        renderGrokImagesList();
        syncInpaintButtonVisibility();
      } else if (grokRefs.length < MAX_GROK_REFS) {
        grokRefs.push({ base64 });
        renderGrokImagesList();
      }
    });
  });

  renderGrokImagesList();
}

function readImageFile(file, callback) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const base64 = ev.target.result.split(",")[1];
    callback(base64);
  };
  reader.readAsDataURL(file);
}

function renderGrokImagesList() {
  const imagesList = $("#grok-images-list");
  const addBtn = $("#btn-add-grok-ref");
  const badge = $("#grok-images-badge");
  const hint = $("#grok-images-hint");
  if (!imagesList) return;

  // Rebuild everything after the source slot
  // Keep source slot element, remove any previously-rendered ref slots
  const sourceSlot = document.getElementById("grok-source-slot");
  // Clear all children except the source slot
  while (imagesList.lastChild && imagesList.lastChild !== sourceSlot) {
    imagesList.removeChild(imagesList.lastChild);
  }

  // ── Update source slot ──────────────────────────────────
  if (sourceSlot) {
    if (state.img2img) {
      // Filled: show thumb + × button
      sourceSlot.innerHTML = `
        <div class="grok-slot-label">Source · Image 1</div>
        <img class="grok-slot-thumb" src="data:image/png;base64,${state.img2img}" alt="Source image">
        <button type="button" class="grok-slot-remove" data-role="source" aria-label="Remove source image" title="Remove source">×</button>
      `;
    } else {
      // Empty: drop zone
      sourceSlot.innerHTML = `
        <div class="grok-slot-label">Source · Image 1</div>
        <div class="grok-slot-drop" id="grok-source-drop">Drop or click to set source</div>
      `;
    }
  }

  // ── Render ref slots (numbered from 2) ──────────────────
  grokRefs.forEach((ref, idx) => {
    const imageNumber = idx + 2; // source is 1
    const slot = document.createElement("div");
    slot.className = "grok-image-slot";
    slot.innerHTML = `
      <div class="grok-slot-label">Ref ${idx + 1} · Image ${imageNumber}</div>
      <img class="grok-slot-thumb" src="data:image/png;base64,${ref.base64}" alt="Reference image ${imageNumber}">
      <button type="button" class="grok-slot-remove" data-role="ref" data-idx="${idx}" aria-label="Remove reference ${idx + 1}" title="Remove reference">×</button>
    `;
    imagesList.appendChild(slot);
  });

  // ── Add Reference button visibility ─────────────────────
  const totalImages = (state.img2img ? 1 : 0) + grokRefs.length;
  if (addBtn) addBtn.style.display = grokRefs.length >= MAX_GROK_REFS ? "none" : "";

  // ── Badge ───────────────────────────────────────────────
  if (badge) {
    if (totalImages > 0) {
      badge.textContent = String(totalImages);
      badge.style.display = "";
    } else {
      badge.style.display = "none";
    }
  }

  // ── Hint text ───────────────────────────────────────────
  if (hint) {
    const hasSource = !!state.img2img;
    const hasRefs = grokRefs.length > 0;
    if (!hasSource && !hasRefs) {
      hint.textContent = "Add a source or reference image to guide Grok";
    } else if (hasSource && !hasRefs) {
      hint.textContent = "Source is image 1. Describe what to edit in your prompt";
    } else if (hasSource && hasRefs) {
      const refNums = grokRefs.map((_, i) => i + 2).join(", ");
      hint.textContent = `Source is image 1. References are images ${refNums}. Mention by position in prompt`;
    } else {
      const refNums = grokRefs.map((_, i) => i + 1).join(", ");
      hint.textContent = `References are images ${refNums}. Add a source to edit a specific image`;
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   GENERATE
   ═══════════════════════════════════════════════════════════ */

function setGenerateButtonStop() {
  const btn = $("#generate-btn");
  btn.classList.remove("loading");
  btn.classList.add("stopping");
  btn.disabled = false;
  btn.querySelector(".btn-generate-label").textContent = "Stop";
  btn.querySelector(".btn-generate-hint").textContent = "";
}

function resetGenerateButton() {
  const btn = $("#generate-btn");
  btn.classList.remove("loading", "stopping");
  btn.disabled = false;
  const provider = document.getElementById("provider")?.value || "novelai";
  const isVideo = provider === "grok" && state.grokOutputType === "video";
  btn.querySelector(".btn-generate-label").textContent = isVideo ? "Generate Video" : "Generate";
  btn.querySelector(".btn-generate-hint").textContent = "Enter";
  _generateAbortController = null;
}

async function generate() {
  // Route to provider-specific handler
  const provider = document.getElementById("provider")?.value || "novelai";
  if (provider === "grok") {
    if (state.grokOutputType === "video") return generateGrokVideo();
    return generateGrokImage();
  }

  const btn = $("#generate-btn");

  // If we're in stopping state, trigger abort
  if (btn.classList.contains("stopping")) {
    if (_generateAbortController) _generateAbortController.abort();
    return;
  }

  if (btn.disabled) return;
  btn.disabled = true; // Disable immediately to prevent double-trigger during async setup

  const prompt = $("#prompt").value.trim();
  if (!prompt) {
    showError("Please enter a prompt.");
    btn.disabled = false;
    return;
  }

  const resVal = $("#resolution").value;
  const [width, height] = resVal ? resVal.split("x").map(Number) : [832, 1216];

  const qualityTags = ", very aesthetic, masterpiece, no text";
  let finalPrompt = prompt;
  if ($("#quality-tags").checked) {
    // Append quality tags to base prompt content (before first | separator)
    const pipeMatch = prompt.match(/^([\s\S]*?\S)([\s\n]*\|[\s\S]*)$/);
    if (pipeMatch) {
      finalPrompt = pipeMatch[1] + qualityTags + pipeMatch[2];
    } else {
      finalPrompt = prompt.replace(/\s+$/, "") + qualityTags;
    }
  }

  const body = {
    prompt: finalPrompt,
    negative_prompt: $("#negative-prompt").value,
    width: width || 832,
    height: height || 1216,
    steps: parseInt($("#steps").value),
    scale: parseFloat($("#scale").value),
    sampler: $("#sampler").value,
    seed: parseInt($("#seed").value) || 0,
    sm: $("#smea").checked,
    sm_dyn: $("#smea-dyn").checked,
    strength: parseFloat($("#strength").value),
    noise: parseFloat($("#noise").value),
    char_captions: collectCharacterPayload(),
    use_coords: characters.some((c) => !c.positionAuto),
  };

  // Layers composite → img2img source (when enabled)
  const layersEnabled = document.getElementById("layers-enabled");
  if (layersEnabled && layersEnabled.checked && layers.some((l) => l.visible && l.imageBase64)) {
    state.img2img = await compositeLayersToBase64(width, height);
  } else {
    state.img2img = null; // No layers active → pure text-to-image
  }

  const inpaintLayer = layers.find(l => l.inpaintMaskBase64);
  console.log("[generate] inpaintLayer:", inpaintLayer ? inpaintLayer.name : "none", "layers with inpaint mask:", layers.filter(l => l.inpaintMaskBase64).length);
  if (inpaintLayer && (state.img2img || state.canvasImageBase64)) {
    // Inpaint mode: use composite as base + layer's inpaint mask
    // Both image and mask use the output resolution coordinate system
    body.image = state.img2img || state.canvasImageBase64;
    body.mask  = inpaintLayer.inpaintMaskBase64;
    console.log("[generate] sending mask, length:", body.mask?.length, "image:", !!body.image);
  } else if (state.img2img) {
    body.image = state.img2img;
  }

  if (vibes.length > 0) {
    body.reference_images = vibes.map((v) => ({
      image: v.base64,
      information_extracted: v.infoExtracted,
      strength: v.strength,
    }));
  }

  body.cfg_rescale = parseFloat($("#cfg-rescale").value);
  body.noise_schedule = $("#noise-schedule").value;

  btn.classList.add("loading");
  clearError();

  _generateAbortController = new AbortController();

  // After a brief moment switch to Stop button so user can cancel
  const stopTimeout = setTimeout(() => {
    if (_generateAbortController) setGenerateButtonStop();
  }, 400);

  try {
    const resp = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: _generateAbortController.signal,
    });

    clearTimeout(stopTimeout);

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || "Generation failed");
    }

    const data = await resp.json();
    state.lastSeed = data.seed;
    state.lastImageBase64 = data.image;
    state.lastGeneratedImageBase64 = data.image;
    state.canvasImageBase64 = data.image;
    state.canvasImageWidth = width;
    state.canvasImageHeight = height;

    const output = $("#output");
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${data.image}`;
    img.alt = "Generated image";
    output.innerHTML = "";
    output.appendChild(img);
    // Re-render character markers (cleared by innerHTML reset above)
    renderCharacterMarkers();

    const actions = $("#image-actions");
    actions.style.display = "flex";
    syncInpaintButtonVisibility();
    $("#info-seed").textContent = `Seed: ${data.seed}`;

    // Output target layer: write result back into the designated layer
    const outputLayer = layers.find(l => l.isOutputTarget);
    if (outputLayer) {
      outputLayer.imageBase64 = data.image;
      saveLayersToStorage();
      refreshCompositePreview();
    }

    // Auto-switch canvas to Output view on generation complete
    _canvasView = "output";
    localStorage.setItem("nai-canvas-view", "output");
    const cvtInput  = document.getElementById("cvt-input");
    const cvtOutput = document.getElementById("cvt-output");
    if (cvtInput)  { cvtInput.classList.remove("cvt-btn--active"); cvtInput.classList.remove("cvt-btn--changed"); }
    if (cvtOutput) cvtOutput.classList.add("cvt-btn--active");
    updateCanvasPanel();

    loadGallery();
    if (window._savePromptToHistory) window._savePromptToHistory();

    // Fire-and-forget: record character tags from prompt + all character slots
    const allPromptText = [prompt, ...characters.map((c) => c.prompt)].join(", ");
    recordRecentCharacters(allPromptText);

    // Auto Generate: start next generation after a short delay
    if ($("#auto-generate") && $("#auto-generate").checked) {
      setTimeout(() => generate(), 500);
    }
  } catch (e) {
    clearTimeout(stopTimeout);
    if (e.name === "AbortError") {
      // User cancelled — show neutral status, not an error
      showStatus("Cancelled");
    } else {
      console.error("Generate error:", e);
      showError(e.message);
    }
  } finally {
    resetGenerateButton();
  }
}

/* ═══════════════════════════════════════════════════════════
   LAYERS — client-side image compositing
   ═══════════════════════════════════════════════════════════ */

function saveLayersToStorage() {
  try {
    const data = layers.map((l) => ({
      id: l.id,
      name: l.name,
      imageBase64: l.imageBase64,
      maskBase64: l.maskBase64 || null,
      inpaintMaskBase64: l.inpaintMaskBase64 || null,
      opacity: l.opacity,
      visible: l.visible,
      isOutputTarget: l.isOutputTarget || false,
      offsetX: l.offsetX || 0,
      offsetY: l.offsetY || 0,
      scale: l.scale !== undefined ? l.scale : 1.0,
    }));
    localStorage.setItem("nai-layers", JSON.stringify(data));
  } catch (e) {
    console.warn("[layers] localStorage quota exceeded — skipping persistence:", e.message);
  }
}

function loadLayersFromStorage() {
  try {
    const raw = localStorage.getItem("nai-layers");
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return;
    layers.length = 0;
    data.forEach((l) => {
      layers.push({
        id: typeof l.id === "number" ? l.id : Date.now() + Math.random(),
        name: l.name || "Layer",
        imageBase64: l.imageBase64 || null,
        maskBase64: l.maskBase64 || null,
        inpaintMaskBase64: l.inpaintMaskBase64 || null,
        opacity: typeof l.opacity === "number" ? l.opacity : 1.0,
        visible: l.visible !== false,
        isOutputTarget: l.isOutputTarget || false,
        offsetX: l.offsetX || 0,
        offsetY: l.offsetY || 0,
        scale: typeof l.scale === "number" ? l.scale : 1.0,
      });
    });
  } catch (_) { /* corrupt storage — ignore */ }
}

// Debounce timer for refreshCompositePreview opacity slider calls
let _previewDebounceTimer = null;

async function refreshCompositePreview() {
  const layersEnabled = document.getElementById("layers-enabled");
  const hasVisibleLayer = (layersEnabled && layersEnabled.checked) && layers.some((l) => l.visible && l.imageBase64);
  const output = $("#output");

  if (!hasVisibleLayer) {
    // If layers exist but none have images, show blank canvas (not old generated image)
    if (layers.length > 0 && layersEnabled && layersEnabled.checked) {
      state.canvasImageBase64 = null;
      if (output) {
        output.innerHTML = "";
        const placeholder = document.createElement("div");
        placeholder.className = "placeholder";
        placeholder.innerHTML = '<p class="placeholder-sub">Add images to layers to preview</p>';
        output.appendChild(placeholder);
      }
      _clearInpaintMaskOverlay();
      return;
    }
    // No layers at all — fall back to last generated image
    if (state.lastGeneratedImageBase64) {
      state.canvasImageBase64 = state.lastGeneratedImageBase64;
      const existingImg = output ? output.querySelector("img") : null;
      if (output && (!existingImg || existingImg.src !== `data:image/png;base64,${state.lastGeneratedImageBase64}`)) {
        const img = document.createElement("img");
        img.src = `data:image/png;base64,${state.lastGeneratedImageBase64}`;
        img.alt = "Generated image";
        output.innerHTML = "";
        output.appendChild(img);
        renderCharacterMarkers();
      }
    }
    _clearInpaintMaskOverlay();
    return;
  }

  // Read resolution from the dropdown
  const resSel = document.getElementById("resolution");
  let targetW = 832, targetH = 1216; // default
  if (resSel && resSel.value) {
    const parts = resSel.value.split("x");
    if (parts.length === 2) {
      const pw = parseInt(parts[0], 10);
      const ph = parseInt(parts[1], 10);
      if (!isNaN(pw) && !isNaN(ph) && pw > 0 && ph > 0) {
        targetW = pw;
        targetH = ph;
      }
    }
  }

  const compositeBase64 = await compositeLayersToBase64(targetW, targetH);
  if (!compositeBase64) {
    _clearInpaintMaskOverlay();
    return;
  }

  state.canvasImageBase64 = compositeBase64;

  if (output) {
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${compositeBase64}`;
    img.alt = "Layer composite preview";
    output.innerHTML = "";
    output.appendChild(img);
    renderCharacterMarkers();

    const actions = $("#image-actions");
    if (actions) {
      actions.style.display = "flex";
      syncInpaintButtonVisibility();
    }
  }

  // Draw inpaint mask overlay if any visible layer has one
  const inpaintLayer = layers.find((l) => l.visible && l.inpaintMaskBase64);
  if (inpaintLayer) {
    _drawInpaintMaskOverlay(inpaintLayer.inpaintMaskBase64);
  } else {
    _clearInpaintMaskOverlay();
  }
}

function _clearInpaintMaskOverlay() {
  const canvas = document.getElementById("inpaint-mask-overlay");
  const badge = document.getElementById("inpaint-active-badge");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  if (badge) badge.style.display = "none";
}

async function _drawInpaintMaskOverlay(maskBase64) {
  const canvas = document.getElementById("inpaint-mask-overlay");
  const badge = document.getElementById("inpaint-active-badge");
  if (!canvas) return;

  const img = new Image();
  await new Promise((resolve) => { img.onload = resolve; img.src = "data:image/png;base64," + maskBase64; });

  // Use the canvas's layout dimensions (CSS width/height: 100%)
  const w = canvas.offsetWidth  || img.naturalWidth;
  const h = canvas.offsetHeight || img.naturalHeight;

  // Guard against clearing content (learnings 2026-03-20)
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width  = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  // Draw mask to an offscreen canvas to read pixel data
  const offscreen = document.createElement("canvas");
  offscreen.width  = w;
  offscreen.height = h;
  const octx = offscreen.getContext("2d");
  octx.drawImage(img, 0, 0, w, h);
  const imageData = octx.getImageData(0, 0, w, h);
  const { data } = imageData;

  // Build red overlay: where mask pixel > 128, paint rgba(240,80,80,0.35)
  const overlayData = ctx.createImageData(w, h);
  const od = overlayData.data;
  for (let i = 0; i < data.length; i += 4) {
    const luminance = data[i]; // mask is grayscale, R channel sufficient
    if (luminance > 128) {
      od[i]     = 240; // R
      od[i + 1] = 80;  // G
      od[i + 2] = 80;  // B
      od[i + 3] = 89;  // A (~0.35 * 255)
    }
  }
  ctx.putImageData(overlayData, 0, 0);

  if (badge) badge.style.display = "";
}

async function compositeLayersToBase64(targetW, targetH) {
  const visible = layers.filter((l) => l.visible && l.imageBase64);
  if (visible.length === 0) return null;

  // Pre-decode all images (and masks) to ensure naturalWidth/Height are available
  const decoded = await Promise.all(visible.map((layer) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const ox = layer.offsetX || 0;
      const oy = layer.offsetY || 0;
      const scale = layer.scale !== undefined ? layer.scale : 1.0;
      if (layer.maskBase64) {
        const maskImg = new Image();
        maskImg.onload = () => resolve({ img, maskImg, opacity: layer.opacity, ox, oy, scale });
        maskImg.src = "data:image/png;base64," + layer.maskBase64;
      } else {
        resolve({ img, maskImg: null, opacity: layer.opacity, ox, oy, scale });
      }
    };
    img.src = "data:image/png;base64," + layer.imageBase64;
  })));

  const offscreen = document.createElement("canvas");
  offscreen.width  = targetW;
  offscreen.height = targetH;
  const ctx = offscreen.getContext("2d");

  // Draw bottom-to-top: last in array = bottom layer, drawn first
  for (const { img, maskImg, opacity, ox, oy, scale } of [...decoded].reverse()) {
    // Offset in pixels (stored as fraction of target dimensions)
    const pixOX = Math.round(ox * targetW);
    const pixOY = Math.round(oy * targetH);

    // object-fit: cover scaling
    const imgAR   = img.naturalWidth / img.naturalHeight;
    const canvasAR = targetW / targetH;
    let sx, sy, sw, sh;
    if (imgAR > canvasAR) {
      sh = img.naturalHeight;
      sw = sh * canvasAR;
      sx = (img.naturalWidth - sw) / 2;
      sy = 0;
    } else {
      sw = img.naturalWidth;
      sh = sw / canvasAR;
      sx = 0;
      sy = (img.naturalHeight - sh) / 2;
    }

    // Destination rect: scale around center, then apply offset
    const s  = scale !== undefined ? scale : 1.0;
    const dw = targetW * s;
    const dh = targetH * s;
    const dx = (targetW - dw) / 2 + pixOX;
    const dy = (targetH - dh) / 2 + pixOY;

    if (maskImg) {
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width  = targetW;
      maskCanvas.height = targetH;
      const maskCtx = maskCanvas.getContext("2d");
      maskCtx.drawImage(maskImg, 0, 0, targetW, targetH);
      const maskData = maskCtx.getImageData(0, 0, targetW, targetH);
      const md = maskData.data;
      for (let i = 0; i < md.length; i += 4) {
        md[i + 3] = md[i];
      }
      maskCtx.putImageData(maskData, 0, 0);

      const tmp = document.createElement("canvas");
      tmp.width  = targetW;
      tmp.height = targetH;
      const tmpCtx = tmp.getContext("2d");
      tmpCtx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);
      tmpCtx.globalCompositeOperation = "destination-in";
      tmpCtx.drawImage(maskCanvas, 0, 0);
      tmpCtx.globalCompositeOperation = "source-over";

      ctx.globalAlpha = opacity;
      ctx.drawImage(tmp, 0, 0, targetW, targetH, dx, dy, dw, dh);
      ctx.globalAlpha = 1.0;
    } else {
      ctx.globalAlpha = opacity;
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
      ctx.globalAlpha = 1.0;
    }
  }

  return offscreen.toDataURL("image/png").split(",")[1];
}

function updateLayersBadge() {
  const badge = document.getElementById("layers-badge");
  if (!badge) return;
  const count = layers.filter((l) => l.imageBase64).length;
  badge.textContent = String(count);
  badge.style.display = count > 0 ? "" : "none";
}

function renderLayerList() {
  const list = document.getElementById("layers-list");
  if (!list) return;
  list.innerHTML = "";

  if (layers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "layers-empty";
    empty.textContent = "No layers yet. Add a layer to start compositing.";
    list.appendChild(empty);
    updateLayersBadge();
    updateCanvasPanel();
    return;
  }

  // Clamp active index to valid range
  if (_activeLayerIdx >= layers.length) _activeLayerIdx = layers.length - 1;
  if (_activeLayerIdx < 0) _activeLayerIdx = 0;

  // Display order matches array order: index 0 = top of list = top layer
  layers.forEach((layer, idx) => {
    const row = buildLayerRow(layer, idx);
    list.appendChild(row);
  });

  const layersHint = document.getElementById("layers-hint");
  if (layersHint) {
    const hasImages = layers.some((l) => !!l.imageBase64);
    layersHint.style.display = hasImages ? "" : "none";
  }

  updateLayersBadge();
  updateCanvasPanel();
}

// Module-level drag state for layer reordering
const _layerDrag = { active: false, fromId: null };

function buildLayerRow(layer, realIdx) {
  const row = document.createElement("div");
  row.className = "layer-row" +
    (layer.isOutputTarget ? " layer-row--output-target" : "") +
    (realIdx === _activeLayerIdx ? " layer-row--selected" : "");
  row.dataset.layerId = String(layer.id);
  row.draggable = true;

  // ── Drag grip ─────────────────────────────────────────────
  const grip = document.createElement("div");
  grip.className = "layer-drag-grip";
  grip.innerHTML = '<svg width="8" height="12" viewBox="0 0 8 12" fill="none" aria-hidden="true"><circle cx="2" cy="2" r="1" fill="currentColor"/><circle cx="6" cy="2" r="1" fill="currentColor"/><circle cx="2" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="2" cy="10" r="1" fill="currentColor"/><circle cx="6" cy="10" r="1" fill="currentColor"/></svg>';

  // ── Thumbnail (compact, 28×28) ─────────────────────────────
  const thumbWrap = document.createElement("div");
  thumbWrap.className = "layer-thumb-wrap";
  thumbWrap.title = "Click to select layer";

  if (layer.imageBase64) {
    const img = document.createElement("img");
    img.className = "layer-thumb";
    img.src = "data:image/png;base64," + layer.imageBase64;
    img.alt = layer.name;
    thumbWrap.appendChild(img);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "layer-thumb layer-thumb-empty";
    placeholder.setAttribute("aria-label", "No image");
    const plusSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    plusSvg.setAttribute("width", "12");
    plusSvg.setAttribute("height", "12");
    plusSvg.setAttribute("viewBox", "0 0 24 24");
    plusSvg.setAttribute("fill", "none");
    plusSvg.setAttribute("stroke", "currentColor");
    plusSvg.setAttribute("stroke-width", "2");
    plusSvg.setAttribute("stroke-linecap", "round");
    plusSvg.setAttribute("stroke-linejoin", "round");
    plusSvg.innerHTML = '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>';
    placeholder.appendChild(plusSvg);
    thumbWrap.appendChild(placeholder);
  }

  // ── Name label ─────────────────────────────────────────────
  const nameSpan = document.createElement("span");
  nameSpan.className = "layer-name";
  nameSpan.contentEditable = "true";
  nameSpan.spellcheck = false;
  nameSpan.textContent = layer.name;
  nameSpan.title = "Click to rename";
  nameSpan.addEventListener("dragstart", (e) => e.stopPropagation());
  nameSpan.addEventListener("blur", () => {
    const trimmed = nameSpan.textContent.trim();
    layer.name = trimmed || layer.name;
    if (!trimmed) nameSpan.textContent = layer.name;
    saveLayersToStorage();
    // Sync name to CLP if this is the active layer
    const clpName = document.getElementById("clp-name");
    if (clpName && _activeLayerIdx === realIdx) clpName.value = layer.name;
  });
  nameSpan.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); nameSpan.blur(); }
  });

  // ── Row click: select this layer ──────────────────────────
  row.addEventListener("click", (e) => {
    // Don't steal clicks intended for contentEditable
    if (e.target === nameSpan) return;
    _activeLayerIdx = realIdx;
    // Update selected class on all rows in-place
    document.querySelectorAll(".layer-row").forEach((rowEl, i) => {
      rowEl.classList.toggle("layer-row--selected", i === _activeLayerIdx);
    });
    updateCanvasPanel();
  });

  row.appendChild(grip);
  row.appendChild(thumbWrap);
  row.appendChild(nameSpan);

  // ── HTML5 Drag-and-drop reorder ───────────────────────────
  row.addEventListener("dragstart", (e) => {
    _layerDrag.active = true;
    _layerDrag.fromId = layer.id;
    e.dataTransfer.effectAllowed = "move";
    row.classList.add("layer-row--dragging");
  });

  row.addEventListener("dragend", () => {
    _layerDrag.active = false;
    _layerDrag.fromId = null;
    // Clean up any lingering drag-over classes without full re-render
    document.querySelectorAll(".layer-row--drag-over").forEach((el) => {
      el.classList.remove("layer-row--drag-over");
    });
    row.classList.remove("layer-row--dragging");
  });

  row.addEventListener("dragover", (e) => {
    if (!_layerDrag.active || _layerDrag.fromId === layer.id) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".layer-row--drag-over").forEach((el) => {
      if (el !== row) el.classList.remove("layer-row--drag-over");
    });
    row.classList.add("layer-row--drag-over");
  });

  row.addEventListener("dragleave", () => {
    row.classList.remove("layer-row--drag-over");
  });

  row.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!_layerDrag.active || _layerDrag.fromId === layer.id) return;
    const fromIdx = layers.findIndex((l) => l.id === _layerDrag.fromId);
    const toIdx   = layers.indexOf(layer);
    console.log("[layer drop]", fromIdx, "->", toIdx, "ids:", _layerDrag.fromId, layer.id);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    pushLayerUndo("Reorder layers");
    const [moved] = layers.splice(fromIdx, 1);
    layers.splice(toIdx, 0, moved);
    _layerDrag.active = false;
    _layerDrag.fromId = null;
    renderLayerList();
    saveLayersToStorage();
    refreshCompositePreview();
  });

  return row;
}

function setupLayers() {
  loadLayersFromStorage();
  renderLayerList();

  const addBtn      = document.getElementById("btn-add-layer");
  const sendToLayer = document.getElementById("btn-send-to-layer");

  if (addBtn) {
    addBtn.addEventListener("click", (e) => {
      // Prevent the button inside <summary> from toggling the accordion
      e.stopPropagation();
      if (layers.length >= MAX_LAYERS) {
        showStatus("Maximum of " + MAX_LAYERS + " layers reached.");
        return;
      }
      pushLayerUndo("Add layer");
      const n = layers.length + 1;
      // Auto-select the new layer
      _activeLayerIdx = layers.length;
      layers.push({ id: Date.now(), name: "Layer " + n, imageBase64: null, maskBase64: null, inpaintMaskBase64: null, opacity: 1.0, visible: true, isOutputTarget: false, offsetX: 0, offsetY: 0, scale: 1.0 });
      renderLayerList();
      saveLayersToStorage();
    });
  }

  // Drag-and-drop image files onto the layers panel to create new layers
  const layersList = document.getElementById("layers-list");
  const accordion = document.getElementById("layers-accordion");
  const dropTargets = [layersList, accordion].filter(Boolean);
  dropTargets.forEach((el) => {
    el.addEventListener("dragover", (e) => {
      if (_layerDrag.active) return; // layer reorder, not file drop
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    });
    el.addEventListener("drop", (e) => {
      if (_layerDrag.active) return;
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files[0];
      if (!file.type.startsWith("image/")) return;
      if (layers.length >= MAX_LAYERS) { showStatus("Maximum of " + MAX_LAYERS + " layers reached."); return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const b64 = ev.target.result.split(",")[1];
        pushLayerUndo("Add layer from file");
        const n = layers.length + 1;
        layers.push({ id: Date.now(), name: file.name.replace(/\.[^.]+$/, "") || "Layer " + n, imageBase64: b64, maskBase64: null, inpaintMaskBase64: null, opacity: 1.0, visible: true, isOutputTarget: false, offsetX: 0, offsetY: 0, scale: 1.0 });
        renderLayerList();
        saveLayersToStorage();
        refreshCompositePreview();
        if (accordion && !accordion.open) accordion.open = true;
      };
      reader.readAsDataURL(file);
    });
  });

  if (sendToLayer) {
    sendToLayer.addEventListener("click", () => {
      if (!state.lastGeneratedImageBase64) return;
      if (layers.length >= MAX_LAYERS) return;
      pushLayerUndo("Send to layer");
      const outputLayers = layers.filter((l) => l.name.startsWith("Output"));
      const n = outputLayers.length;
      const name = n === 0 ? "Output" : "Output " + (n + 1);
      _activeLayerIdx = layers.length;
      layers.push({
        id: Date.now(),
        name,
        imageBase64: state.lastGeneratedImageBase64,
        maskBase64: null,
        inpaintMaskBase64: null,
        opacity: 1.0,
        visible: true,
        isOutputTarget: false,
        offsetX: 0, offsetY: 0, scale: 1.0,
      });
      renderLayerList();
      saveLayersToStorage();

      // Open layers accordion if it's closed
      const accordion = document.getElementById("layers-accordion");
      if (accordion && !accordion.open) accordion.open = true;

      showStatus("Canvas image sent to layer \"" + name + "\"");
    });
  }

  // Toggle layers on/off — update preview immediately
  const layersToggle = document.getElementById("layers-enabled");
  if (layersToggle) {
    layersToggle.addEventListener("change", () => refreshCompositePreview());
  }
}

/* ═══════════════════════════════════════════════════════════
   CANVAS LAYER PANEL — floating panel for active layer controls
   ═══════════════════════════════════════════════════════════ */

function updateCanvasPanel() {
  const panel     = document.getElementById("canvas-layer-panel");
  const toggle    = document.getElementById("canvas-view-toggle");
  const providerEl = document.getElementById("provider");
  const provider  = providerEl ? providerEl.value : "novelai";

  // Layer panel is only for NovelAI mode with at least one layer
  if (!panel) return;
  if (provider !== "novelai" || layers.length === 0) {
    panel.style.display = "none";
  }

  // Input/Output toggle: show for NovelAI (with layers) OR Grok (with source image)
  const showToggle = (provider === "novelai" && layers.length > 0) ||
                     (provider === "grok" && !!state.img2img);
  if (toggle) toggle.style.display = showToggle ? "" : "none";

  if (provider !== "novelai" || layers.length === 0) {
    return;
  }

  // Clamp index
  if (_activeLayerIdx >= layers.length) _activeLayerIdx = layers.length - 1;
  if (_activeLayerIdx < 0) _activeLayerIdx = 0;

  const layer = layers[_activeLayerIdx];

  // Show panel
  panel.style.display = "";
  if (toggle) toggle.style.display = "";

  // Update layer info
  const info = document.getElementById("clp-layer-info");
  if (info) info.textContent = "Layer " + (_activeLayerIdx + 1) + " of " + layers.length;

  // Prev/Next button state
  const prevBtn = document.getElementById("clp-prev");
  const nextBtn = document.getElementById("clp-next");
  if (prevBtn) prevBtn.disabled = (_activeLayerIdx === 0);
  if (nextBtn) nextBtn.disabled = (_activeLayerIdx === layers.length - 1);

  // Thumbnail
  const thumbEl = document.getElementById("clp-thumb");
  if (thumbEl) {
    thumbEl.innerHTML = "";
    if (layer.imageBase64) {
      const img = document.createElement("img");
      img.src = "data:image/png;base64," + layer.imageBase64;
      img.alt = layer.name;
      thumbEl.appendChild(img);
    }
  }

  // Name
  const nameInput = document.getElementById("clp-name");
  if (nameInput) nameInput.value = layer.name;

  // Eye button
  const eyeBtn = document.getElementById("clp-eye");
  if (eyeBtn) {
    eyeBtn.classList.toggle("clp-icon-btn--active", layer.visible);
    eyeBtn.title = layer.visible ? "Hide layer" : "Show layer";
    eyeBtn.innerHTML = layer.visible
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  }

  // Target button
  const targetBtn = document.getElementById("clp-target");
  if (targetBtn) {
    targetBtn.classList.toggle("clp-icon-btn--active", !!layer.isOutputTarget);
    targetBtn.title = layer.isOutputTarget ? "Output target (active)" : "Set as output target";
  }

  // Opacity
  const opacitySlider = document.getElementById("clp-opacity");
  const opacityVal    = document.getElementById("clp-opacity-val");
  if (opacitySlider) opacitySlider.value = String(layer.opacity);
  if (opacityVal)    opacityVal.textContent = Math.round(layer.opacity * 100) + "%";

  // Scale
  const scaleSlider = document.getElementById("clp-scale");
  const scaleVal    = document.getElementById("clp-scale-val");
  const currentScale = layer.scale !== undefined ? layer.scale : 1.0;
  if (scaleSlider) scaleSlider.value = String(currentScale);
  if (scaleVal)    scaleVal.textContent = Math.round(currentScale * 100) + "%";

  // AI Redraw visibility
  const redrawBtn = document.getElementById("clp-redraw");
  if (redrawBtn) redrawBtn.style.display = layer.imageBase64 ? "" : "none";

  // Move button active state
  const moveBtn = document.getElementById("clp-move");
  if (moveBtn) moveBtn.classList.toggle("clp-action-btn--active", _movingLayer === layer);

  // Highlight corresponding sidebar row
  document.querySelectorAll(".layer-row").forEach((rowEl, i) => {
    rowEl.classList.toggle("layer-row--selected", i === _activeLayerIdx);
  });
}

function setupCanvasLayerPanel() {
  // ── Collapse toggle ───────────────────────────────────────
  const collapseBtn = document.getElementById("clp-collapse");
  const clpBody     = document.getElementById("clp-body");
  const savedCollapsed = localStorage.getItem("nai-clp-collapsed") === "true";
  if (savedCollapsed && clpBody) clpBody.style.display = "none";

  if (collapseBtn && clpBody) {
    collapseBtn.textContent = savedCollapsed ? "▸" : "▾";
    collapseBtn.addEventListener("click", () => {
      const isCollapsed = clpBody.style.display === "none";
      clpBody.style.display = isCollapsed ? "" : "none";
      collapseBtn.textContent = isCollapsed ? "▾" : "▸";
      localStorage.setItem("nai-clp-collapsed", isCollapsed ? "false" : "true");
    });
  }

  // ── Prev / Next ───────────────────────────────────────────
  document.getElementById("clp-prev")?.addEventListener("click", () => {
    if (_activeLayerIdx > 0) { _activeLayerIdx--; updateCanvasPanel(); }
  });
  document.getElementById("clp-next")?.addEventListener("click", () => {
    if (_activeLayerIdx < layers.length - 1) { _activeLayerIdx++; updateCanvasPanel(); }
  });

  // ── Name input ────────────────────────────────────────────
  const nameInput = document.getElementById("clp-name");
  if (nameInput) {
    nameInput.addEventListener("change", () => {
      if (layers.length === 0) return;
      const layer = layers[_activeLayerIdx];
      const trimmed = nameInput.value.trim();
      layer.name = trimmed || layer.name;
      if (!trimmed) nameInput.value = layer.name;
      saveLayersToStorage();
      // Sync name in sidebar row without full re-render
      const rowEl = document.querySelectorAll(".layer-row")[_activeLayerIdx];
      if (rowEl) {
        const nameSpan = rowEl.querySelector(".layer-name");
        if (nameSpan) nameSpan.textContent = layer.name;
      }
    });
  }

  // ── Eye button ────────────────────────────────────────────
  document.getElementById("clp-eye")?.addEventListener("click", () => {
    if (layers.length === 0) return;
    const layer = layers[_activeLayerIdx];
    pushLayerUndo("Toggle visibility");
    layer.visible = !layer.visible;
    saveLayersToStorage();
    updateLayersBadge();
    refreshCompositePreview();
    updateCanvasPanel();
  });

  // ── Target button ─────────────────────────────────────────
  document.getElementById("clp-target")?.addEventListener("click", () => {
    if (layers.length === 0) return;
    const layer = layers[_activeLayerIdx];
    pushLayerUndo("Toggle output target");
    const wasTarget = layer.isOutputTarget;
    layers.forEach(l => { l.isOutputTarget = false; });
    layer.isOutputTarget = !wasTarget;
    // Update sidebar rows in-place
    document.querySelectorAll(".layer-row").forEach((rowEl) => {
      const id = Number(rowEl.dataset.layerId);
      const l = layers.find(x => x.id === id);
      if (!l) return;
      rowEl.classList.toggle("layer-row--output-target", !!l.isOutputTarget);
    });
    saveLayersToStorage();
    updateCanvasPanel();
  });

  // ── Opacity slider ────────────────────────────────────────
  let _clpOpacityUndoPushed = false;
  const opacitySlider = document.getElementById("clp-opacity");
  const opacityVal    = document.getElementById("clp-opacity-val");
  if (opacitySlider) {
    opacitySlider.addEventListener("pointerdown", () => { _clpOpacityUndoPushed = false; });
    opacitySlider.addEventListener("input", () => {
      if (layers.length === 0) return;
      if (!_clpOpacityUndoPushed) { pushLayerUndo("Change opacity"); _clpOpacityUndoPushed = true; }
      const layer = layers[_activeLayerIdx];
      layer.opacity = parseFloat(opacitySlider.value);
      if (opacityVal) opacityVal.textContent = Math.round(layer.opacity * 100) + "%";
      saveLayersToStorage();
      // Mark input button as changed if on output view
      _markInputChanged();
      clearTimeout(_previewDebounceTimer);
      _previewDebounceTimer = setTimeout(refreshCompositePreview, 50);
    });
  }

  // ── Scale slider ──────────────────────────────────────────
  let _clpScaleUndoPushed = false;
  const scaleSlider = document.getElementById("clp-scale");
  const scaleVal    = document.getElementById("clp-scale-val");
  if (scaleSlider) {
    scaleSlider.addEventListener("pointerdown", () => { _clpScaleUndoPushed = false; });
    scaleSlider.addEventListener("input", () => {
      if (layers.length === 0) return;
      if (!_clpScaleUndoPushed) { pushLayerUndo("Change scale"); _clpScaleUndoPushed = true; }
      const layer = layers[_activeLayerIdx];
      layer.scale = parseFloat(scaleSlider.value);
      if (scaleVal) scaleVal.textContent = Math.round(layer.scale * 100) + "%";
      _markInputChanged();
      clearTimeout(_previewDebounceTimer);
      _previewDebounceTimer = setTimeout(refreshCompositePreview, 50);
    });
    scaleSlider.addEventListener("change", () => {
      if (layers.length === 0) return;
      saveLayersToStorage();
    });
  }
  if (scaleVal) {
    scaleVal.addEventListener("click", () => {
      if (layers.length === 0) return;
      const layer = layers[_activeLayerIdx];
      pushLayerUndo("Reset scale");
      layer.scale = 1.0;
      if (scaleSlider) scaleSlider.value = "1";
      scaleVal.textContent = "100%";
      saveLayersToStorage();
      _markInputChanged();
      clearTimeout(_previewDebounceTimer);
      _previewDebounceTimer = setTimeout(refreshCompositePreview, 50);
    });
  }

  // ── Action buttons ────────────────────────────────────────
  document.getElementById("clp-move")?.addEventListener("click", () => {
    if (layers.length === 0) return;
    const layer = layers[_activeLayerIdx];
    if (_movingLayer === layer) {
      _movingLayer = null;
      _disableCanvasMove();
    } else {
      _movingLayer = layer;
      _enableCanvasMove(layer);
    }
    updateCanvasPanel();
  });

  document.getElementById("clp-draw")?.addEventListener("click", () => {
    if (layers.length === 0) return;
    const layer = layers[_activeLayerIdx];
    openLayerDrawEditor(layer, (base64) => {
      layer.imageBase64 = base64;
      refreshCompositePreview();
      saveLayersToStorage();
      _markInputChanged();
      updateCanvasPanel();
    });
  });

  document.getElementById("clp-mask")?.addEventListener("click", () => {
    if (layers.length === 0) return;
    const layer = layers[_activeLayerIdx];
    pushLayerUndo("Edit visibility mask");
    openLayerMaskEditor(layer, () => {
      saveLayersToStorage();
      refreshCompositePreview();
      _markInputChanged();
    });
  });

  document.getElementById("clp-inpaint")?.addEventListener("click", () => {
    if (layers.length === 0) return;
    const layer = layers[_activeLayerIdx];
    pushLayerUndo("Edit inpaint mask");
    openLayerInpaintEditor(layer, () => {
      saveLayersToStorage();
      refreshCompositePreview();
      _markInputChanged();
    });
  });

  document.getElementById("clp-redraw")?.addEventListener("click", () => {
    if (layers.length === 0) return;
    const layer = layers[_activeLayerIdx];
    if (!layer || !layer.imageBase64) { showStatus("Draw something on this layer first"); return; }
    if (_openLayerRedraw) {
      _openLayerRedraw(layer);
    } else {
      showStatus("AI Redraw not ready");
    }
  });

  document.getElementById("clp-delete")?.addEventListener("click", () => {
    if (layers.length === 0) return;
    pushLayerUndo("Remove layer");
    layers.splice(_activeLayerIdx, 1);
    if (_activeLayerIdx >= layers.length && layers.length > 0) _activeLayerIdx = layers.length - 1;
    renderLayerList();
    saveLayersToStorage();
    refreshCompositePreview();
  });

  // ── Thumb click — load image onto layer ──────────────────
  document.getElementById("clp-thumb")?.addEventListener("click", () => {
    if (layers.length === 0) return;
    const layer = layers[_activeLayerIdx];
    const fi = document.createElement("input");
    fi.type = "file";
    fi.accept = "image/*";
    fi.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        layer.imageBase64 = ev.target.result.split(",")[1];
        renderLayerList();
        saveLayersToStorage();
        refreshCompositePreview();
        _markInputChanged();
      };
      reader.readAsDataURL(file);
    });
    fi.click();
  });
}

/* ── Input/Output toggle ──────────────────────────────────── */

function _markInputChanged() {
  // If we're on the Output view, mark the Input button with a dot
  if (_canvasView === "output") {
    const inputBtn = document.getElementById("cvt-input");
    if (inputBtn) inputBtn.classList.add("cvt-btn--changed");
  }
}

function setupCanvasViewToggle() {
  const inputBtn  = document.getElementById("cvt-input");
  const outputBtn = document.getElementById("cvt-output");
  if (!inputBtn || !outputBtn) return;

  function applyView(view) {
    _canvasView = view;
    localStorage.setItem("nai-canvas-view", view);
    inputBtn.classList.toggle("cvt-btn--active", view === "input");
    outputBtn.classList.toggle("cvt-btn--active", view === "output");
    if (view === "input") {
      inputBtn.classList.remove("cvt-btn--changed");
      // Show source: composite preview (NovelAI) or source image (Grok)
      const provider = document.getElementById("provider")?.value || "novelai";
      if (provider === "grok" && state.img2img) {
        const output = document.getElementById("output");
        if (output) {
          const img = document.createElement("img");
          img.src = "data:image/png;base64," + state.img2img;
          img.alt = "Source image";
          output.innerHTML = "";
          output.appendChild(img);
        }
      } else {
        refreshCompositePreview();
      }
    } else {
      // Show the last generated image
      if (state.lastGeneratedImageBase64) {
        const output = document.getElementById("output");
        if (output) {
          const img = document.createElement("img");
          img.src = "data:image/png;base64," + state.lastGeneratedImageBase64;
          img.alt = "Generated image";
          output.innerHTML = "";
          output.appendChild(img);
          renderCharacterMarkers();
        }
      }
    }
  }

  inputBtn.addEventListener("click",  () => applyView("input"));
  outputBtn.addEventListener("click", () => applyView("output"));

  // Restore saved view (default to output)
  const saved = localStorage.getItem("nai-canvas-view") || "output";
  inputBtn.classList.toggle("cvt-btn--active", saved === "input");
  outputBtn.classList.toggle("cvt-btn--active", saved === "output");
}

/* ═══════════════════════════════════════════════════════════
   LAYER MASK EDITOR — per-layer white/black mask painting
   ═══════════════════════════════════════════════════════════ */

// openLayerMaskEditor is called from buildLayerRow's mask button.
// onApply(layer) is called when the user confirms.
function openLayerMaskEditor(layer, onApply) {
  if (!layer.imageBase64) {
    showStatus("Load an image into this layer first.");
    return;
  }

  const overlay    = document.getElementById("layer-mask-overlay");
  const btnCancel  = document.getElementById("layer-mask-cancel");
  const btnConfirm = document.getElementById("layer-mask-confirm");
  const btnClear   = document.getElementById("layer-mask-clear");
  const btnInvert  = document.getElementById("layer-mask-invert");
  const btnUndo    = document.getElementById("layer-mask-undo");
  const btnMode    = document.getElementById("layer-mask-mode-toggle");
  const brushSlider = document.getElementById("layer-mask-brush-size");
  const brushVal   = document.getElementById("layer-mask-brush-val");
  const srcCanvas  = document.getElementById("layer-mask-source");
  const drawCanvas = document.getElementById("layer-mask-canvas");
  const cursorEl   = document.getElementById("layer-mask-cursor");
  const stageWrap  = overlay?.querySelector(".layer-mask-stage-wrap");

  if (!overlay || !srcCanvas || !drawCanvas) return;

  const srcCtx  = srcCanvas.getContext("2d");
  const drawCtx = drawCanvas.getContext("2d");

  // Offscreen canvas at full image resolution — pure white/black
  const offscreen = document.createElement("canvas");
  const offCtx    = offscreen.getContext("2d");

  // AbortController for all listeners registered in this editor session
  const editorAC = new AbortController();
  const editorSig = { signal: editorAC.signal };

  // Editor state
  let brushSize = parseInt(brushSlider.value, 10);
  let eraseMode = false;  // false = paint white (show), true = paint black (hide)
  let isDrawing = false;
  let lastX = 0;
  let lastY = 0;
  let scaleX = 1;
  let scaleY = 1;
  const undoStack = [];
  const MAX_UNDO = 20;

  // ── Mode toggle ────────────────────────────────────────────
  function setMode(mode) {
    eraseMode = (mode === "erase");
    btnMode.dataset.mode = mode;
    const iconPaint = btnMode.querySelector(".layer-mask-icon-paint");
    const iconErase = btnMode.querySelector(".layer-mask-icon-erase");
    const label     = btnMode.querySelector(".layer-mask-mode-label");
    if (iconPaint) iconPaint.style.display = eraseMode ? "none" : "";
    if (iconErase) iconErase.style.display = eraseMode ? "" : "none";
    if (label)     label.textContent       = eraseMode ? "Hide" : "Reveal";
    if (eraseMode) {
      btnMode.classList.add("layer-mask-mode--hide");
      btnMode.classList.remove("layer-mask-mode--reveal");
      cursorEl.style.borderColor = "rgba(220, 50, 50, 0.85)";
    } else {
      btnMode.classList.add("layer-mask-mode--reveal");
      btnMode.classList.remove("layer-mask-mode--hide");
      cursorEl.style.borderColor = "rgba(255, 255, 255, 0.85)";
    }
  }

  btnMode.addEventListener("click", () => setMode(eraseMode ? "paint" : "erase"), editorSig);

  // ── Brush size ─────────────────────────────────────────────
  function updateBrushSize(val) {
    brushSize = val;
    brushVal.textContent = val;
    cursorEl.style.width  = val + "px";
    cursorEl.style.height = val + "px";
  }

  brushSlider.addEventListener("input", () => updateBrushSize(parseInt(brushSlider.value, 10)), editorSig);

  // ── Undo ───────────────────────────────────────────────────
  function saveUndoSnapshot() {
    if (drawCanvas.width === 0 || drawCanvas.height === 0) return;
    const drawSnap = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
    const offSnap  = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
    if (undoStack.length >= MAX_UNDO) undoStack.shift();
    undoStack.push({ draw: drawSnap, off: offSnap });
  }

  function undo() {
    if (undoStack.length === 0) return;
    const snap = undoStack.pop();
    drawCtx.putImageData(snap.draw, 0, 0);
    offCtx.putImageData(snap.off, 0, 0);
  }

  btnUndo.addEventListener("click", undo, editorSig);

  // ── Draw helpers ───────────────────────────────────────────
  function drawAt(dispX, dispY, isFirst) {
    const r = brushSize / 2;

    // Visible draw canvas — cut out red tint (Reveal) or paint red tint (Hide)
    drawCtx.save();
    if (eraseMode) {
      // Hide mode: paint red tint over the area
      drawCtx.globalCompositeOperation = "source-over";
      drawCtx.fillStyle = "rgba(220, 50, 50, 0.45)";
    } else {
      // Reveal mode: erase the red tint so the source image shows through
      drawCtx.globalCompositeOperation = "destination-out";
      drawCtx.fillStyle = "rgba(0, 0, 0, 1)";
    }

    if (!isFirst) {
      const dx = dispX - lastX;
      const dy = dispY - lastY;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(r * 0.4, 1);
      const steps = Math.ceil(dist / step);
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        const cx = lastX + dx * t;
        const cy = lastY + dy * t;
        drawCtx.beginPath();
        drawCtx.arc(cx, cy, r, 0, Math.PI * 2);
        drawCtx.fill();
      }
    } else {
      drawCtx.beginPath();
      drawCtx.arc(dispX, dispY, r, 0, Math.PI * 2);
      drawCtx.fill();
    }
    drawCtx.restore();

    // Offscreen at full image resolution
    const offX = dispX * scaleX;
    const offY = dispY * scaleY;
    const offR = r * Math.max(scaleX, scaleY);

    offCtx.save();
    offCtx.globalCompositeOperation = "source-over";
    offCtx.fillStyle = eraseMode ? "#000000" : "#ffffff";

    if (!isFirst) {
      const offLastX = lastX * scaleX;
      const offLastY = lastY * scaleY;
      const dx = offX - offLastX;
      const dy = offY - offLastY;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(offR * 0.4, 1);
      const steps = Math.ceil(dist / step);
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        const cx = offLastX + dx * t;
        const cy = offLastY + dy * t;
        offCtx.beginPath();
        offCtx.arc(cx, cy, offR, 0, Math.PI * 2);
        offCtx.fill();
      }
    } else {
      offCtx.beginPath();
      offCtx.arc(offX, offY, offR, 0, Math.PI * 2);
      offCtx.fill();
    }
    offCtx.restore();
  }

  // ── Clear (reset to all white = fully visible) ─────────────
  btnClear.addEventListener("click", () => {
    saveUndoSnapshot();
    // All white = fully visible mask
    offCtx.fillStyle = "#ffffff";
    offCtx.fillRect(0, 0, offscreen.width, offscreen.height);
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  }, editorSig);

  // ── Invert ─────────────────────────────────────────────────
  btnInvert.addEventListener("click", () => {
    saveUndoSnapshot();
    // Invert offscreen by reading pixel data
    const imageData = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i]     = 255 - d[i];
      d[i + 1] = 255 - d[i + 1];
      d[i + 2] = 255 - d[i + 2];
      // alpha unchanged
    }
    offCtx.putImageData(imageData, 0, 0);
    // Re-sync visible canvas from offscreen
    syncVisibleFromOffscreen();
  }, editorSig);

  // Rebuild the visible overlay canvas from the offscreen data.
  // Hidden areas (black in offscreen) get a red tint overlay.
  // Revealed areas (white in offscreen) are cut out, showing the source image clearly.
  function syncVisibleFromOffscreen() {
    // Build the red overlay from offscreen mask data:
    // Hidden (black) pixels → red tint, Revealed (white) pixels → transparent
    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = offscreen.width;
    tmpCanvas.height = offscreen.height;
    const tmpCtx = tmpCanvas.getContext("2d");
    const maskData = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
    const d = maskData.data;
    for (let i = 0; i < d.length; i += 4) {
      const brightness = d[i]; // R channel = mask value (0=hidden, 255=revealed)
      // Red tint for hidden areas, transparent for revealed
      d[i]     = 220; // R
      d[i + 1] = 50;  // G
      d[i + 2] = 50;  // B
      d[i + 3] = Math.round((1 - brightness / 255) * 115); // alpha: 0 when revealed, ~115 when hidden
    }
    tmpCtx.putImageData(maskData, 0, 0);
    // Scale to display canvas
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    drawCtx.drawImage(tmpCanvas, 0, 0, drawCanvas.width, drawCanvas.height);
  }

  // ── Pointer events ─────────────────────────────────────────
  function getCanvasPos(e) {
    const rect = drawCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (drawCanvas.width / rect.width),
      y: (e.clientY - rect.top)  * (drawCanvas.height / rect.height),
    };
  }

  drawCanvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    drawCanvas.setPointerCapture(e.pointerId);
    saveUndoSnapshot();
    isDrawing = true;
    const pos = getCanvasPos(e);
    lastX = pos.x;
    lastY = pos.y;
    drawAt(pos.x, pos.y, true);
  }, editorSig);

  drawCanvas.addEventListener("pointermove", (e) => {
    const stageRect = stageWrap.getBoundingClientRect();
    cursorEl.style.display = "block";
    cursorEl.style.left = (e.clientX - stageRect.left) + "px";
    cursorEl.style.top  = (e.clientY - stageRect.top)  + "px";

    if (!isDrawing) return;
    e.preventDefault();
    const pos = getCanvasPos(e);
    drawAt(pos.x, pos.y, false);
    lastX = pos.x;
    lastY = pos.y;
  }, editorSig);

  drawCanvas.addEventListener("pointerup",     () => { isDrawing = false; }, editorSig);
  drawCanvas.addEventListener("pointerleave",  () => { isDrawing = false; cursorEl.style.display = "none"; }, editorSig);
  drawCanvas.addEventListener("pointercancel", () => { isDrawing = false; cursorEl.style.display = "none"; }, editorSig);

  // ── Keyboard shortcuts ─────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    if (overlay.style.display === "none") return;
    if ((e.metaKey || e.ctrlKey) && e.key === "z") {
      e.preventDefault();
      undo();
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      closeEditor(false);
    }
  }, editorSig);

  // ── Close / confirm ────────────────────────────────────────
  function closeEditor(apply) {
    editorAC.abort(); // removes all listeners registered with editorSig
    overlay.style.display = "none";
    cursorEl.style.display = "none";
    if (apply) {
      // Save as grayscale PNG (white = show, black = hide)
      const maskDataUrl = offscreen.toDataURL("image/png");
      layer.maskBase64 = maskDataUrl.replace("data:image/png;base64,", "");
      onApply(layer);
    }
  }

  btnCancel.addEventListener("click",  () => closeEditor(false), editorSig);
  btnConfirm.addEventListener("click", () => closeEditor(true),  editorSig);

  // ── Open: load source image and existing mask ──────────────
  const sourceImg = new Image();
  sourceImg.onload = () => {
    const imgW = sourceImg.naturalWidth;
    const imgH = sourceImg.naturalHeight;

    // Force animation replay (per learnings 2026-03-22)
    overlay.style.animation = "none";
    const shell = overlay.querySelector(".layer-mask-shell");
    if (shell) shell.style.animation = "none";
    overlay.style.display = "flex";
    void overlay.offsetWidth;
    overlay.style.animation = "";
    if (shell) shell.style.animation = "";

    // Offscreen at full image resolution
    offscreen.width  = imgW;
    offscreen.height = imgH;

    // Compute display size
    const stageRect = stageWrap.getBoundingClientRect();
    const stageW = stageRect.width  || stageWrap.offsetWidth;
    const stageH = stageRect.height || stageWrap.offsetHeight;
    const fitScale = Math.min(stageW / imgW, stageH / imgH, 1);
    const dispW = Math.round(imgW * fitScale);
    const dispH = Math.round(imgH * fitScale);
    const offsetX = Math.round((stageW - dispW) / 2);
    const offsetY = Math.round((stageH - dispH) / 2);

    scaleX = imgW / dispW;
    scaleY = imgH / dispH;

    // Size both visible canvases identically
    srcCanvas.width  = dispW;
    srcCanvas.height = dispH;
    drawCanvas.width = dispW;
    drawCanvas.height = dispH;

    // Position centred in stage
    [srcCanvas, drawCanvas].forEach((c) => {
      c.style.left   = offsetX + "px";
      c.style.top    = offsetY + "px";
      c.style.width  = dispW + "px";
      c.style.height = dispH + "px";
    });

    // Draw source image
    srcCtx.drawImage(sourceImg, 0, 0, dispW, dispH);

    // Load existing mask if present, else fill white (fully visible)
    if (layer.maskBase64) {
      const existingMask = new Image();
      existingMask.onload = () => {
        offCtx.drawImage(existingMask, 0, 0, imgW, imgH);
        syncVisibleFromOffscreen();
      };
      existingMask.src = "data:image/png;base64," + layer.maskBase64;
    } else {
      // Default mask: all black (hide everything). User paints white
      // to reveal parts of the layer they want to show.
      offCtx.fillStyle = "#000000";
      offCtx.fillRect(0, 0, imgW, imgH);
      syncVisibleFromOffscreen();
    }

    // Clear undo stack
    undoStack.length = 0;

    // Reset mode and brush
    setMode("paint");
    updateBrushSize(parseInt(brushSlider.value, 10));
  };
  sourceImg.src = "data:image/png;base64," + layer.imageBase64;
}

function setupLayerMask() {
  // No global setup needed — the editor is fully self-contained in openLayerMaskEditor.
  // This function exists as the structural counterpart to setupInpaint / setupLayers.
}

/* ═══════════════════════════════════════════════════════════
   LAYER DRAW EDITOR — freehand drawing on a layer
   ═══════════════════════════════════════════════════════════ */

// openLayerDrawEditor is called from buildLayerRow's draw button.
// onApply(base64) is called when the user confirms with the PNG data.
function openLayerDrawEditor(layer, onApply) {
  const overlay     = document.getElementById("layer-draw-overlay");
  const btnCancel   = document.getElementById("layer-draw-cancel");
  const btnConfirm  = document.getElementById("layer-draw-confirm");
  const btnClear    = document.getElementById("layer-draw-clear");
  const btnFill     = document.getElementById("layer-draw-fill");
  const btnUndo     = document.getElementById("layer-draw-undo");
  const btnMode     = document.getElementById("layer-draw-mode-toggle");
  const brushSlider = document.getElementById("layer-draw-brush-size");
  const brushVal    = document.getElementById("layer-draw-brush-val");
  const colorInput  = document.getElementById("layer-draw-color");
  const drawCanvas  = document.getElementById("layer-draw-canvas");
  const cursorEl    = document.getElementById("layer-draw-cursor");
  const stageWrap   = overlay?.querySelector(".layer-draw-stage-wrap");

  if (!overlay || !drawCanvas) return;

  const drawCtx = drawCanvas.getContext("2d");

  // Offscreen canvas at full target resolution
  const offscreen = document.createElement("canvas");
  const offCtx    = offscreen.getContext("2d");

  // AbortController for all listeners registered in this editor session
  const editorAC  = new AbortController();
  const editorSig = { signal: editorAC.signal };

  // Editor state
  let brushSize  = parseInt(brushSlider.value, 10);
  let eraseMode  = false;
  let isDrawing  = false;
  let lastX      = 0;
  let lastY      = 0;
  let scaleX     = 1;
  let scaleY     = 1;
  const undoStack = [];
  const MAX_UNDO  = 20;

  // ── Mode toggle ────────────────────────────────────────────
  function setMode(mode) {
    eraseMode = (mode === "erase");
    btnMode.dataset.mode = mode;
    const iconPaint = btnMode.querySelector(".layer-draw-icon-paint");
    const iconErase = btnMode.querySelector(".layer-draw-icon-erase");
    const label     = btnMode.querySelector(".layer-draw-mode-label");
    if (iconPaint) iconPaint.style.display = eraseMode ? "none" : "";
    if (iconErase) iconErase.style.display = eraseMode ? "" : "none";
    if (label)     label.textContent       = eraseMode ? "Erase" : "Paint";
  }

  btnMode.addEventListener("click", () => setMode(eraseMode ? "paint" : "erase"), editorSig);

  // ── Brush size ─────────────────────────────────────────────
  function updateBrushSize(val) {
    brushSize = val;
    brushVal.textContent = val;
    cursorEl.style.width  = val + "px";
    cursorEl.style.height = val + "px";
  }

  brushSlider.addEventListener("input", () => updateBrushSize(parseInt(brushSlider.value, 10)), editorSig);

  // ── Color picker — update cursor border color to match ─────
  colorInput.addEventListener("input", () => {
    cursorEl.style.borderColor = colorInput.value;
  }, editorSig);

  // ── Undo ───────────────────────────────────────────────────
  function saveUndoSnapshot() {
    if (drawCanvas.width === 0 || drawCanvas.height === 0) return;
    const drawSnap = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
    const offSnap  = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
    if (undoStack.length >= MAX_UNDO) undoStack.shift();
    undoStack.push({ draw: drawSnap, off: offSnap });
  }

  function undo() {
    if (undoStack.length === 0) return;
    const snap = undoStack.pop();
    drawCtx.putImageData(snap.draw, 0, 0);
    offCtx.putImageData(snap.off, 0, 0);
  }

  btnUndo.addEventListener("click", undo, editorSig);

  // ── Draw helpers ───────────────────────────────────────────
  function paintCircle(ctx, cx, cy, r) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawAt(dispX, dispY, isFirst) {
    const r = brushSize / 2;

    // Visible draw canvas
    drawCtx.save();
    if (eraseMode) {
      drawCtx.globalCompositeOperation = "destination-out";
    } else {
      drawCtx.globalCompositeOperation = "source-over";
      drawCtx.fillStyle = colorInput.value;
    }

    if (!isFirst) {
      const dx = dispX - lastX;
      const dy = dispY - lastY;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(r * 0.4, 1);
      const steps = Math.ceil(dist / step);
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        paintCircle(drawCtx, lastX + dx * t, lastY + dy * t, r);
      }
    } else {
      paintCircle(drawCtx, dispX, dispY, r);
    }
    drawCtx.restore();

    // Offscreen at full resolution
    const offX    = dispX * scaleX;
    const offY    = dispY * scaleY;
    const offR    = r * Math.max(scaleX, scaleY);
    const offLastX = lastX * scaleX;
    const offLastY = lastY * scaleY;

    offCtx.save();
    if (eraseMode) {
      offCtx.globalCompositeOperation = "destination-out";
    } else {
      offCtx.globalCompositeOperation = "source-over";
      offCtx.fillStyle = colorInput.value;
    }

    if (!isFirst) {
      const dx = offX - offLastX;
      const dy = offY - offLastY;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(offR * 0.4, 1);
      const steps = Math.ceil(dist / step);
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        paintCircle(offCtx, offLastX + dx * t, offLastY + dy * t, offR);
      }
    } else {
      paintCircle(offCtx, offX, offY, offR);
    }
    offCtx.restore();
  }

  // ── Clear (reset to white — opaque base for img2img) ───────
  btnClear.addEventListener("click", () => {
    saveUndoSnapshot();
    offCtx.clearRect(0, 0, offscreen.width, offscreen.height);
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  }, editorSig);

  // ── Fill (flood canvas with selected color) ─────────────────
  btnFill.addEventListener("click", () => {
    saveUndoSnapshot();
    offCtx.fillStyle = colorInput.value;
    offCtx.fillRect(0, 0, offscreen.width, offscreen.height);
    drawCtx.fillStyle = colorInput.value;
    drawCtx.fillRect(0, 0, drawCanvas.width, drawCanvas.height);
  }, editorSig);

  // ── Pointer events ─────────────────────────────────────────
  function getCanvasPos(e) {
    const rect = drawCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (drawCanvas.width / rect.width),
      y: (e.clientY - rect.top)  * (drawCanvas.height / rect.height),
    };
  }

  drawCanvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    drawCanvas.setPointerCapture(e.pointerId);
    saveUndoSnapshot();
    isDrawing = true;
    const pos = getCanvasPos(e);
    lastX = pos.x;
    lastY = pos.y;
    drawAt(pos.x, pos.y, true);
  }, editorSig);

  drawCanvas.addEventListener("pointermove", (e) => {
    const stageRect = stageWrap.getBoundingClientRect();
    cursorEl.style.display = "block";
    cursorEl.style.left = (e.clientX - stageRect.left) + "px";
    cursorEl.style.top  = (e.clientY - stageRect.top)  + "px";

    if (!isDrawing) return;
    e.preventDefault();
    const pos = getCanvasPos(e);
    drawAt(pos.x, pos.y, false);
    lastX = pos.x;
    lastY = pos.y;
  }, editorSig);

  drawCanvas.addEventListener("pointerup",     () => { isDrawing = false; }, editorSig);
  drawCanvas.addEventListener("pointerleave",  () => { isDrawing = false; cursorEl.style.display = "none"; }, editorSig);
  drawCanvas.addEventListener("pointercancel", () => { isDrawing = false; cursorEl.style.display = "none"; }, editorSig);

  // ── Keyboard shortcuts ─────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    if (overlay.style.display === "none") return;
    if ((e.metaKey || e.ctrlKey) && e.key === "z") {
      e.preventDefault();
      undo();
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      closeEditor(false);
    }
  }, editorSig);

  // ── Close / confirm ────────────────────────────────────────
  function closeEditor(apply) {
    editorAC.abort();
    overlay.style.display = "none";
    cursorEl.style.display = "none";
    if (apply) {
      const dataUrl = offscreen.toDataURL("image/png");
      const base64  = dataUrl.replace("data:image/png;base64,", "");
      onApply(base64);
    }
  }

  btnCancel.addEventListener("click",  () => closeEditor(false), editorSig);
  btnConfirm.addEventListener("click", () => closeEditor(true),  editorSig);

  // ── Open: determine target resolution and initialise ──────
  // Read resolution from #resolution dropdown (e.g. "832x1216")
  const resolutionEl = document.getElementById("resolution");
  const resValue     = resolutionEl ? resolutionEl.value : "832x1216";
  const [targetW, targetH] = resValue.split("x").map(Number);
  const safeW = targetW  || 832;
  const safeH = targetH  || 1216;

  // Force animation replay (per learnings 2026-03-22)
  overlay.style.animation = "none";
  const shell = overlay.querySelector(".layer-draw-shell");
  if (shell) shell.style.animation = "none";
  overlay.style.display = "flex";
  void overlay.offsetWidth;
  overlay.style.animation = "";
  if (shell) shell.style.animation = "";

  // Offscreen at full target resolution
  offscreen.width  = safeW;
  offscreen.height = safeH;

  // Compute display size to fit stage
  const stageRect = stageWrap.getBoundingClientRect();
  const stageW    = stageRect.width  || stageWrap.offsetWidth  || 700;
  const stageH    = stageRect.height || stageWrap.offsetHeight || 500;
  const fitScale  = Math.min(stageW / safeW, stageH / safeH, 1);
  const dispW     = Math.round(safeW * fitScale);
  const dispH     = Math.round(safeH * fitScale);
  const offsetX   = Math.round((stageW - dispW) / 2);
  const offsetY   = Math.round((stageH - dispH) / 2);

  scaleX = safeW / dispW;
  scaleY = safeH / dispH;

  // Guard: setting canvas dimensions clears content (learnings 2026-03-20).
  // We're always reinitialising on open so this is intentional.
  drawCanvas.width  = dispW;
  drawCanvas.height = dispH;

  drawCanvas.style.left   = offsetX + "px";
  drawCanvas.style.top    = offsetY + "px";
  drawCanvas.style.width  = dispW + "px";
  drawCanvas.style.height = dispH + "px";

  // Background preview: composite of all OTHER visible layers
  const bgCanvas = document.getElementById("layer-draw-bg");
  if (bgCanvas) {
    bgCanvas.width  = dispW;
    bgCanvas.height = dispH;
    bgCanvas.style.left   = offsetX + "px";
    bgCanvas.style.top    = offsetY + "px";
    bgCanvas.style.width  = dispW + "px";
    bgCanvas.style.height = dispH + "px";
    const bgCtx = bgCanvas.getContext("2d");
    bgCtx.clearRect(0, 0, dispW, dispH);
    // Draw other layers (excluding current layer) as background
    const otherLayers = layers.filter((l) => l.visible && l.imageBase64 && l.id !== layer.id);
    if (otherLayers.length > 0) {
      // Draw bottom-to-top (reversed array order: last = bottom)
      [...otherLayers].reverse().forEach((other) => {
        const img = new Image();
        img.onload = () => {
          bgCtx.globalAlpha = other.opacity;
          bgCtx.drawImage(img, 0, 0, dispW, dispH);
          bgCtx.globalAlpha = 1.0;
        };
        img.src = "data:image/png;base64," + other.imageBase64;
      });
    }
  }

  function initContents() {
    if (layer.imageBase64) {
      // Load existing image data into both canvases
      const existingImg = new Image();
      existingImg.onload = () => {
        offCtx.drawImage(existingImg, 0, 0, safeW, safeH);
        drawCtx.drawImage(existingImg, 0, 0, dispW, dispH);
        undoStack.length = 0;
        setMode("paint");
        updateBrushSize(parseInt(brushSlider.value, 10));
        cursorEl.style.borderColor = colorInput.value;
      };
      existingImg.src = "data:image/png;base64," + layer.imageBase64;
    } else {
      // Empty layer — start transparent so drawn content doesn't
      // cover layers below with a white background
      offCtx.clearRect(0, 0, safeW, safeH);
      drawCtx.clearRect(0, 0, dispW, dispH);
      undoStack.length = 0;
      setMode("paint");
      updateBrushSize(parseInt(brushSlider.value, 10));
      cursorEl.style.borderColor = colorInput.value;
    }
  }

  initContents();
}

function setupLayerDraw() {
  // No global setup needed — the editor is fully self-contained in openLayerDrawEditor.
  // This function exists as the structural counterpart to setupLayerMask.
}

/* ═══════════════════════════════════════════════════════════
   INPAINT — mask painting overlay
   ═══════════════════════════════════════════════════════════ */

// Call this whenever the canvas image state or provider changes
// to show/hide action buttons in #image-actions.
function syncInpaintButtonVisibility() {
  const sendBtn = document.getElementById("btn-send-to-layer");
  const provider = document.getElementById("provider")?.value || "novelai";
  const hasImage = !!state.canvasImageBase64;
  const hasGenerated = !!state.lastGeneratedImageBase64;
  const isNovelAI = provider === "novelai";
  if (sendBtn) {
    sendBtn.style.display = (hasImage && isNovelAI) ? "" : "none";
    sendBtn.disabled = !hasGenerated;
    sendBtn.title = hasGenerated
      ? "Send this image to a new layer in the Layers panel"
      : "Generate an image first to send it to a layer";
  }
  // Grok: Set as Source button — only shown after generation in Grok mode
  const setBtn = document.getElementById("btn-set-as-source");
  if (setBtn) {
    setBtn.style.display = (hasGenerated && !isNovelAI) ? "" : "none";
  }
  // NovelAI → Grok handoff buttons
  const editGrokBtn = document.getElementById("btn-edit-in-grok");
  const animGrokBtn = document.getElementById("btn-animate-in-grok");
  if (editGrokBtn) editGrokBtn.style.display = (hasGenerated && isNovelAI) ? "" : "none";
  if (animGrokBtn) animGrokBtn.style.display = (hasGenerated && isNovelAI) ? "" : "none";
}

function setupInpaint() {
  // The inpaint overlay is now opened via openLayerInpaintEditor(layer, onConfirm).
  // This setup function wires up the static controls (brush, mode, clear, undo, cancel, confirm).
  // The open logic and confirm callback are injected per-call.

  const overlay  = document.getElementById("inpaint-overlay");
  const btnCancel = document.getElementById("inpaint-cancel");
  const btnConfirm = document.getElementById("inpaint-confirm");
  const btnClear = document.getElementById("inpaint-clear");
  const btnUndo  = document.getElementById("inpaint-undo");
  const btnMode  = document.getElementById("inpaint-mode-toggle");
  const brushSlider = document.getElementById("inpaint-brush-size");
  const brushVal = document.getElementById("inpaint-brush-val");
  const srcCanvas  = document.getElementById("inpaint-source");
  const maskCanvas = document.getElementById("inpaint-mask");
  const cursorEl   = document.getElementById("inpaint-cursor");
  const stageWrap  = overlay?.querySelector(".inpaint-stage-wrap");

  if (!overlay || !srcCanvas || !maskCanvas) return;

  const srcCtx  = srcCanvas.getContext("2d");
  const maskCtx = maskCanvas.getContext("2d");

  // Offscreen canvas — same pixel dimensions as source image, pure B&W
  const offscreen = document.createElement("canvas");
  const offCtx    = offscreen.getContext("2d");

  // Editor state
  let brushSize = 32;
  let eraseMode = false;
  let isDrawing = false;
  let lastX = 0;
  let lastY = 0;
  let scaleX = 1;
  let scaleY = 1;
  const undoStack = [];
  const MAX_UNDO  = 20;

  // Per-call confirm callback — set by openLayerInpaintEditor
  let _currentLayer    = null;
  let _onConfirmCb     = null;

  // ── Open (called from openLayerInpaintEditor) ──────────────
  function openInpaint(layer, onConfirm) {
    _currentLayer = layer;
    _onConfirmCb  = onConfirm;

    // Use the composite preview as the inpaint source — this matches
    // what gets sent to the API, so the mask coordinates align correctly.
    // Fall back to layer's own image if no composite is available.
    const sourceb64 = state.canvasImageBase64 || layer.imageBase64;
    if (!sourceb64) {
      showStatus("No image to inpaint — add images to layers first.");
      return;
    }

    const img = new Image();
    img.onload = () => {
      // Use output resolution for the mask — must match the composite
      // that gets sent to the API, not the source image's natural size
      const resSel = document.getElementById("resolution");
      const resParts = (resSel ? resSel.value : "832x1216").split("x").map(Number);
      const imgW = resParts[0] || 832;
      const imgH = resParts[1] || 1216;

      // Show overlay first so stageWrap has layout dimensions.
      overlay.style.animation = "none";
      const shell = overlay.querySelector(".inpaint-shell");
      if (shell) shell.style.animation = "none";
      overlay.style.display = "flex";
      void overlay.offsetWidth;
      overlay.style.animation = "";
      if (shell) shell.style.animation = "";

      // Offscreen canvas at output resolution — start black (no-paint)
      offscreen.width  = imgW;
      offscreen.height = imgH;
      offCtx.fillStyle = "#000000";
      offCtx.fillRect(0, 0, imgW, imgH);

      // Compute display size: fit within stageWrap
      const stageRect = stageWrap.getBoundingClientRect();
      const stageW = stageRect.width  || stageWrap.offsetWidth;
      const stageH = stageRect.height || stageWrap.offsetHeight;
      const fitScale = Math.min(stageW / imgW, stageH / imgH, 1);
      const dispW = Math.round(imgW * fitScale);
      const dispH = Math.round(imgH * fitScale);
      const offsetX = Math.round((stageW - dispW) / 2);
      const offsetY = Math.round((stageH - dispH) / 2);

      scaleX = imgW / dispW;
      scaleY = imgH / dispH;

      // Size both visible canvases identically
      srcCanvas.width  = dispW;
      srcCanvas.height = dispH;
      maskCanvas.width = dispW;
      maskCanvas.height = dispH;

      [srcCanvas, maskCanvas].forEach((c) => {
        c.style.left   = offsetX + "px";
        c.style.top    = offsetY + "px";
        c.style.width  = dispW + "px";
        c.style.height = dispH + "px";
      });

      // Draw source image
      srcCtx.drawImage(img, 0, 0, dispW, dispH);

      // Load existing mask if present
      maskCtx.clearRect(0, 0, dispW, dispH);
      if (layer.inpaintMaskBase64) {
        const maskImg = new Image();
        maskImg.onload = () => {
          // Restore offscreen (B&W) from saved mask
          offCtx.drawImage(maskImg, 0, 0, imgW, imgH);
          // Re-draw visible tint overlay from offscreen
          const od = offCtx.getImageData(0, 0, imgW, imgH).data;
          maskCtx.clearRect(0, 0, dispW, dispH);
          for (let py = 0; py < dispH; py++) {
            for (let px = 0; px < dispW; px++) {
              const ox = Math.round(px * scaleX);
              const oy = Math.round(py * scaleY);
              const i = (oy * imgW + ox) * 4;
              if (od[i] > 128) {
                maskCtx.fillStyle = "rgba(240,80,80,0.55)";
                maskCtx.fillRect(px, py, 1, 1);
              }
            }
          }
        };
        maskImg.src = "data:image/png;base64," + layer.inpaintMaskBase64;
      }

      undoStack.length = 0;
      setMode("paint");
      updateBrushSize(parseInt(brushSlider.value, 10));
    };
    img.src = "data:image/png;base64," + sourceb64;
  }

  // ── Close overlay ─────────────────────────────────────────
  function closeInpaint() {
    overlay.style.display = "none";
    cursorEl.style.display = "none";
    _currentLayer = null;
    _onConfirmCb  = null;
  }

  // ── Mode toggle ───────────────────────────────────────────
  function setMode(mode) {
    eraseMode = (mode === "erase");
    btnMode.dataset.mode = mode;
    const iconPaint = btnMode.querySelector(".inpaint-icon-paint");
    const iconErase = btnMode.querySelector(".inpaint-icon-erase");
    const label     = btnMode.querySelector(".inpaint-mode-label");
    if (iconPaint) iconPaint.style.display = eraseMode ? "none" : "";
    if (iconErase) iconErase.style.display = eraseMode ? "" : "none";
    if (label)     label.textContent       = eraseMode ? "Erase" : "Paint";
  }

  btnMode.addEventListener("click", () => {
    setMode(eraseMode ? "paint" : "erase");
  });

  // ── Brush size ────────────────────────────────────────────
  function updateBrushSize(val) {
    brushSize = val;
    brushVal.textContent = val;
    cursorEl.style.width  = val + "px";
    cursorEl.style.height = val + "px";
  }

  brushSlider.addEventListener("input", () => {
    updateBrushSize(parseInt(brushSlider.value, 10));
  });

  // ── Draw helpers ──────────────────────────────────────────
  function drawAt(dispX, dispY, isFirst) {
    const r = brushSize / 2;

    maskCtx.save();
    if (eraseMode) {
      maskCtx.globalCompositeOperation = "destination-out";
      maskCtx.fillStyle = "rgba(0,0,0,1)";
    } else {
      maskCtx.globalCompositeOperation = "source-over";
      maskCtx.fillStyle = "rgba(240,80,80,0.55)";
    }

    if (!isFirst) {
      const dx = dispX - lastX;
      const dy = dispY - lastY;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(r * 0.4, 1);
      const steps = Math.ceil(dist / step);
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        const cx = lastX + dx * t;
        const cy = lastY + dy * t;
        maskCtx.beginPath();
        maskCtx.arc(cx, cy, r, 0, Math.PI * 2);
        maskCtx.fill();
      }
    } else {
      maskCtx.beginPath();
      maskCtx.arc(dispX, dispY, r, 0, Math.PI * 2);
      maskCtx.fill();
    }
    maskCtx.restore();

    const offX = dispX * scaleX;
    const offY = dispY * scaleY;
    const offR = r * Math.max(scaleX, scaleY);

    offCtx.save();
    offCtx.globalCompositeOperation = "source-over";
    offCtx.fillStyle = eraseMode ? "#000000" : "#ffffff";

    if (!isFirst) {
      const offLastX = lastX * scaleX;
      const offLastY = lastY * scaleY;
      const dx = offX - offLastX;
      const dy = offY - offLastY;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(offR * 0.4, 1);
      const steps = Math.ceil(dist / step);
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        const cx = offLastX + dx * t;
        const cy = offLastY + dy * t;
        offCtx.beginPath();
        offCtx.arc(cx, cy, offR, 0, Math.PI * 2);
        offCtx.fill();
      }
    } else {
      offCtx.beginPath();
      offCtx.arc(offX, offY, offR, 0, Math.PI * 2);
      offCtx.fill();
    }
    offCtx.restore();
  }

  // ── Undo ──────────────────────────────────────────────────
  function saveUndoSnapshot() {
    if (maskCanvas.width === 0 || maskCanvas.height === 0) return;
    const maskSnap = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const offSnap  = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
    if (undoStack.length >= MAX_UNDO) undoStack.shift();
    undoStack.push({ mask: maskSnap, off: offSnap });
  }

  function undo() {
    if (undoStack.length === 0) return;
    const snap = undoStack.pop();
    maskCtx.putImageData(snap.mask, 0, 0);
    offCtx.putImageData(snap.off, 0, 0);
  }

  btnUndo.addEventListener("click", undo);

  // ── Clear mask ────────────────────────────────────────────
  btnClear.addEventListener("click", () => {
    saveUndoSnapshot();
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    offCtx.fillStyle = "#000000";
    offCtx.fillRect(0, 0, offscreen.width, offscreen.height);
  });

  // ── Pointer events ────────────────────────────────────────
  function getCanvasPos(e) {
    const rect = maskCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (maskCanvas.width / rect.width),
      y: (e.clientY - rect.top)  * (maskCanvas.height / rect.height),
    };
  }

  maskCanvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    maskCanvas.setPointerCapture(e.pointerId);
    saveUndoSnapshot();
    isDrawing = true;
    const pos = getCanvasPos(e);
    lastX = pos.x;
    lastY = pos.y;
    drawAt(pos.x, pos.y, true);
  });

  maskCanvas.addEventListener("pointermove", (e) => {
    const stageRect = stageWrap.getBoundingClientRect();
    cursorEl.style.display = "block";
    cursorEl.style.left = (e.clientX - stageRect.left) + "px";
    cursorEl.style.top  = (e.clientY - stageRect.top)  + "px";

    if (!isDrawing) return;
    e.preventDefault();
    const pos = getCanvasPos(e);
    drawAt(pos.x, pos.y, false);
    lastX = pos.x;
    lastY = pos.y;
  });

  maskCanvas.addEventListener("pointerup", () => { isDrawing = false; });
  maskCanvas.addEventListener("pointerleave", () => { isDrawing = false; cursorEl.style.display = "none"; });
  maskCanvas.addEventListener("pointercancel", () => { isDrawing = false; cursorEl.style.display = "none"; });

  // ── Keyboard: Cmd/Ctrl+Z undo, Escape close ───────────────
  document.addEventListener("keydown", (e) => {
    if (overlay.style.display === "none") return;
    if ((e.metaKey || e.ctrlKey) && e.key === "z") {
      e.preventDefault();
      undo();
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      closeInpaint();
    }
  });

  // ── Confirm: save mask to layer ───────────────────────────
  btnConfirm.addEventListener("click", () => {
    if (!_currentLayer) return;

    // Check that the mask has at least some painted pixels
    const imgData = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
    const d = imgData.data;
    let hasWhite = false;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 128) { hasWhite = true; break; }
    }
    if (!hasWhite) {
      // No mask painted — clear the inpaint mask (disable inpainting)
      _currentLayer.inpaintMaskBase64 = null;
      const cb = _onConfirmCb;
      closeInpaint();
      if (cb) cb();
      showStatus("Inpaint mask cleared");
      return;
    }

    // Save mask to layer — does NOT trigger generate()
    const dataUrl = offscreen.toDataURL("image/png");
    _currentLayer.inpaintMaskBase64 = dataUrl.replace("data:image/png;base64,", "");

    const cb = _onConfirmCb;
    closeInpaint();
    if (cb) cb();
  });

  // ── Cancel ────────────────────────────────────────────────
  btnCancel.addEventListener("click", closeInpaint);

  // Expose open function so openLayerInpaintEditor can call it
  setupInpaint._open = openInpaint;
}

// Called from buildLayerRow's inpaint button.
// onConfirm() is called after the mask is saved to layer.inpaintMaskBase64.
function openLayerInpaintEditor(layer, onConfirm) {
  if (!setupInpaint._open) {
    showStatus("Inpaint editor not ready — please wait.");
    return;
  }
  setupInpaint._open(layer, onConfirm);
}

/* ═══════════════════════════════════════════════════════════
   AI REDRAW MODAL — redraw a sketch layer with AI while preserving transparency
   ═══════════════════════════════════════════════════════════ */

(function setupLayerRedraw() {
  const modal      = document.getElementById("layer-redraw-modal");
  const titleEl    = document.getElementById("layer-redraw-title");
  const previewImg = document.getElementById("layer-redraw-preview");
  const promptEl   = document.getElementById("layer-redraw-prompt");
  if (promptEl && typeof _tagAC !== "undefined") _tagAC.attach(promptEl);
  const strengthEl = document.getElementById("layer-redraw-strength");
  const strengthVal = document.getElementById("layer-redraw-strength-val");
  const submitBtn  = document.getElementById("layer-redraw-submit");
  const acceptBtn  = document.getElementById("layer-redraw-accept");
  const cancelBtn  = document.getElementById("layer-redraw-cancel");
  const closeBtn   = document.getElementById("layer-redraw-close");
  let _lastRedrawResult = null;

  if (!modal) return;

  let _activeLayer = null;

  function openLayerRedrawModal(layer) {
    _activeLayer = layer;
    _lastRedrawResult = null;
    titleEl.textContent = "AI Redraw — " + layer.name;
    previewImg.src = "data:image/png;base64," + layer.imageBase64;
    promptEl.value = "";
    strengthEl.value = "0.7";
    strengthVal.textContent = "0.70";
    submitBtn.disabled = false;
    submitBtn.textContent = "Redraw";
    if (acceptBtn) acceptBtn.style.display = "none";
    modal.style.display = "flex";
    // Force animation replay
    modal.style.animation = "none";
    void modal.offsetWidth;
    modal.style.animation = "";
    setTimeout(() => promptEl.focus(), 50);
  }

  function closeModal() {
    modal.style.display = "none";
    _activeLayer = null;
  }

  strengthEl.addEventListener("input", () => {
    strengthVal.textContent = parseFloat(strengthEl.value).toFixed(2);
  });

  async function doRedraw() {
    const layer = _activeLayer;
    if (!layer) return;

    const desc = promptEl.value.trim();
    if (!desc) {
      promptEl.focus();
      return;
    }

    // Only use the user's description — don't mix in global prompt
    // which would add unrelated scene/character content
    const useQualityTags = document.getElementById("quality-tags")?.checked;
    let fullPrompt = desc;
    if (useQualityTags) fullPrompt += ", very aesthetic, masterpiece";

    const resVal   = document.getElementById("resolution")?.value || "832x1216";
    const [width, height] = resVal.split("x").map(Number);

    const body = {
      image:           layer.imageBase64,
      prompt:          fullPrompt,
      negative_prompt: document.getElementById("negative-prompt")?.value || "",
      width:           width  || 832,
      height:          height || 1216,
      steps:           parseInt(document.getElementById("steps")?.value) || 28,
      scale:           parseFloat(document.getElementById("scale")?.value) || 6,
      sampler:         document.getElementById("sampler")?.value || "k_euler",
      seed:            parseInt(document.getElementById("seed")?.value) || 0,
      strength:        parseFloat(strengthEl.value),
    };

    submitBtn.disabled = true;
    submitBtn.textContent = "Redrawing…";

    try {
      const resp = await fetch("/api/layer-redraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail || "Redraw failed");
      }
      const data = await resp.json();
      _lastRedrawResult = data.image;
      // Show result in preview — stay in modal
      previewImg.src = "data:image/png;base64," + data.image;
      submitBtn.disabled = false;
      submitBtn.textContent = "Retry";
      // Show accept button
      acceptBtn.style.display = "";
      showStatus("Preview ready — Accept or adjust and Retry");
    } catch (err) {
      showStatus("Redraw error: " + err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = "Redraw";
    }
  }

  submitBtn.addEventListener("click", doRedraw);
  if (acceptBtn) acceptBtn.addEventListener("click", () => {
    if (!_lastRedrawResult || !_activeLayer) return;
    pushLayerUndo("AI Redraw");
    _activeLayer.imageBase64 = _lastRedrawResult;
    closeModal();
    renderLayerList();
    saveLayersToStorage();
    refreshCompositePreview();
    updateCanvasPanel();
    showStatus("AI Redraw applied to " + _activeLayer.name);
  });
  cancelBtn.addEventListener("click", closeModal);
  closeBtn.addEventListener("click", closeModal);

  promptEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doRedraw();
    }
  });

  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopImmediatePropagation();
      closeModal();
    }
  });

  // Expose open function via module-level variable
  _openLayerRedraw = openLayerRedrawModal;
})();

function reuseSeed() {
  if (state.lastSeed !== null) {
    $("#seed").value = state.lastSeed;
  }
}

function downloadImage() {
  if (state.lastVideoBase64) {
    const a = document.createElement("a");
    a.href = `data:video/mp4;base64,${state.lastVideoBase64}`;
    a.download = "grok-video.mp4";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }
  if (!state.lastImageBase64) return;
  const a = document.createElement("a");
  a.href = `data:image/png;base64,${state.lastImageBase64}`;
  a.download = `novelai-${state.lastSeed || "image"}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/* ═══════════════════════════════════════════════════════════
   GROK — Image generation
   ═══════════════════════════════════════════════════════════ */

async function generateGrokImage() {
  const btn = $("#generate-btn");
  if (btn.classList.contains("stopping")) {
    if (_generateAbortController) _generateAbortController.abort();
    return;
  }
  if (btn.disabled) return;

  const prompt = $("#prompt").value.trim();
  if (!prompt) { showError("Please enter a prompt."); return; }

  const quality = document.getElementById("grok-quality")?.value || "standard";
  const body = {
    prompt: prompt,
    aspect_ratio: document.getElementById("grok-aspect-ratio")?.value || "1:1",
    resolution: document.getElementById("grok-resolution")?.value || "1k",
    model: quality === "pro" ? "grok-imagine-image-pro" : "grok-imagine-image",
  };

  // Build images array: source image first (if set), then reference images
  const allImages = [];
  if (state.img2img) allImages.push(state.img2img);
  if (grokRefs.length > 0) allImages.push(...grokRefs.map((r) => r.base64));
  if (allImages.length > 0) body.images = allImages;

  btn.disabled = true;
  btn.classList.add("loading");
  clearError();
  state.lastVideoBase64 = null;
  _generateAbortController = new AbortController();

  const stopTimeout = setTimeout(() => {
    if (_generateAbortController) setGenerateButtonStop();
  }, 400);

  try {
    const resp = await fetch("/api/grok/generate-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: _generateAbortController.signal,
    });

    clearTimeout(stopTimeout);

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || "Generation failed");
    }

    const data = await resp.json();
    state.lastSeed = null;
    state.lastImageBase64 = data.image;
    state.lastGeneratedImageBase64 = data.image;
    state.canvasImageBase64 = data.image;
    state.canvasImageWidth = null;
    state.canvasImageHeight = null;

    const output = $("#output");
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${data.image}`;
    img.alt = "Generated image";
    output.innerHTML = "";
    output.appendChild(img);

    const actions = $("#image-actions");
    if (actions) actions.style.display = "flex";
    syncInpaintButtonVisibility();
    updateCanvasPanel(); // Show Input/Output toggle for Grok
    const infoSeed = $("#info-seed");
    if (infoSeed) infoSeed.textContent = state.img2img ? "Grok (edit)" : "Grok";

    // Auto-switch to Output view
    _canvasView = "output";
    const cvtInput = document.getElementById("cvt-input");
    const cvtOutput = document.getElementById("cvt-output");
    if (cvtInput) { cvtInput.classList.remove("cvt-btn--active"); cvtInput.classList.remove("cvt-btn--changed"); }
    if (cvtOutput) cvtOutput.classList.add("cvt-btn--active");

    loadGallery();
    if (window._savePromptToHistory) window._savePromptToHistory();
    fetchGrokUsage();
  } catch (e) {
    clearTimeout(stopTimeout);
    if (e.name === "AbortError") {
      showStatus("Cancelled");
    } else {
      console.error("Grok generate error:", e);
      showError(e.message);
    }
  } finally {
    resetGenerateButton();
  }
}

/* ═══════════════════════════════════════════════════════════
   GROK — Video generation
   ═══════════════════════════════════════════════════════════ */

async function generateGrokVideo() {
  const btn = $("#generate-btn");
  if (btn.classList.contains("stopping")) {
    if (_generateAbortController) _generateAbortController.abort();
    return;
  }
  if (btn.disabled) return;

  const prompt = $("#prompt").value.trim();
  if (!prompt) { showError("Please enter a prompt."); return; }

  const body = {
    prompt: prompt,
    aspect_ratio: document.getElementById("grok-aspect-ratio")?.value || "1:1",
    resolution: document.getElementById("grok-video-resolution")?.value || "720p",
    duration: parseInt(document.getElementById("grok-duration")?.value) || 5,
  };



  // Include source image for image-to-video: prefer explicit img2img source,
  // fall back to whatever is currently on the canvas
  const videoSourceImage = state.img2img || state.canvasImageBase64;
  console.log("[generateGrokVideo] img2img:", !!state.img2img, "canvasImage:", !!state.canvasImageBase64, "sending image:", !!videoSourceImage);
  if (videoSourceImage) {
    body.image = videoSourceImage;
  }

  btn.disabled = true;
  btn.classList.add("loading");
  clearError();
  state.lastVideoBase64 = null;
  _generateAbortController = new AbortController();

  const stopTimeout = setTimeout(() => {
    if (_generateAbortController) setGenerateButtonStop();
  }, 400);

  // Show progress indicator in the canvas output area
  const output = $("#output");
  let progressMsg = null;
  let progressBar = null;
  if (output) {
    const progressEl = document.createElement("div");
    progressEl.className = "video-progress";

    const spinnerEl = document.createElement("div");
    spinnerEl.className = "spinner";

    progressMsg = document.createElement("p");
    progressMsg.textContent = "Generating video…";

    progressBar = document.createElement("div");
    progressBar.className = "video-progress-track";
    const progressFill = document.createElement("div");
    progressFill.className = "video-progress-fill";
    progressFill.id = "video-progress-fill";
    progressBar.appendChild(progressFill);

    progressEl.appendChild(spinnerEl);
    progressEl.appendChild(progressMsg);
    progressEl.appendChild(progressBar);
    output.innerHTML = "";
    output.appendChild(progressEl);
  }

  try {
    const resp = await fetch("/api/grok/generate-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: _generateAbortController.signal,
    });

    clearTimeout(stopTimeout);

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(text || "Video generation failed");
    }

    // Read SSE stream for progress updates
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let videoData = null;
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // keep incomplete line in buffer
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.status === "pending" && msg.progress != null) {
            const pct = Math.round(msg.progress);
            if (progressMsg) progressMsg.textContent = `Generating video… ${pct}%`;
            const fill = document.getElementById("video-progress-fill");
            if (fill) fill.style.width = pct + "%";
          } else if (msg.status === "done" && msg.video) {
            videoData = msg.video;
          } else if (msg.status === "error") {
            throw new Error(msg.detail || "Video generation failed");
          }
        } catch (parseErr) {
          if (parseErr.message && !parseErr.message.includes("JSON")) throw parseErr;
        }
      }
    }

    if (!videoData) throw new Error("No video data received");

    state.lastSeed = null;
    state.lastImageBase64 = null;
    state.lastVideoBase64 = videoData;

    if (output) {
      output.innerHTML = "";
      const video = document.createElement("video");
      video.src = `data:video/mp4;base64,${videoData}`;
      video.autoplay = true;
      video.loop = true;
      video.muted = false;
      video.controls = true;
      output.appendChild(video);
    }

    const actions = $("#image-actions");
    if (actions) actions.style.display = "flex";
    syncInpaintButtonVisibility();
    const infoSeed = $("#info-seed");
    if (infoSeed) infoSeed.textContent = "Grok Video";

    loadGallery();
    fetchGrokUsage();
  } catch (e) {
    clearTimeout(stopTimeout);
    if (e.name === "AbortError") {
      showStatus("Cancelled");
    } else {
      console.error("Grok video error:", e);
      showError(e.message);
    }
  } finally {
    resetGenerateButton();
  }
}

/* ═══════════════════════════════════════════════════════════
   CRAFT PANEL — Variation Dial, Prompt Autopsy, Prompt DNA
   ═══════════════════════════════════════════════════════════ */

const VARIATION_DIMENSIONS = {
  lighting: {
    label: "Lighting",
    hint: "Change light source, time of day, ambient light",
    variants: [
      { label: "Warm",     tags: "soft natural lighting, golden hour" },
      { label: "Dramatic", tags: "dramatic rim lighting, dark atmosphere" },
      { label: "Neon",     tags: "neon light, cyberpunk lighting" },
      { label: "Moonlit",  tags: "moonlight, ethereal glow, night" },
    ],
  },
  artStyle: {
    label: "Art Style",
    hint: "Change art medium and line style",
    variants: [
      { label: "Watercolor", tags: "watercolor, painterly, loose brushstrokes" },
      { label: "Cel",        tags: "detailed lineart, clean lines, cel shaded" },
      { label: "Oil",        tags: "oil painting, impasto texture, rich colors" },
      { label: "Sketch",     tags: "sketch style, pencil, rough lines" },
    ],
  },
  composition: {
    label: "Composition",
    hint: "Change camera distance and angle",
    variants: [
      { label: "Close-up",  tags: "close-up, portrait, face focus" },
      { label: "Full Body", tags: "full body, wide shot, establishing" },
      { label: "Top Down",  tags: "from above, bird's eye view, overhead angle" },
      { label: "Dynamic",   tags: "dynamic angle, dutch angle, cinematic" },
    ],
  },
  mood: {
    label: "Mood",
    hint: "Change mood and color tone",
    variants: [
      { label: "Melancholy", tags: "melancholic, somber, wistful atmosphere" },
      { label: "Vibrant",    tags: "vibrant, energetic, lively" },
      { label: "Mysterious", tags: "mysterious, eerie, tension" },
      { label: "Serene",     tags: "peaceful, serene, calm" },
    ],
  },
};

function insertTagIntoPrompt(tag) {
  const el = $("#prompt");
  if (!el) return;
  const current = el.value.trim();
  el.value = current ? current + ", " + tag : tag;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function removeTagFromPrompt(tag) {
  const el = $("#prompt");
  if (!el) return;
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let val = el.value;
  val = val.replace(new RegExp(",\\s*" + escaped + "(?=,|$)", "g"), "");
  val = val.replace(new RegExp("^" + escaped + ",\\s*", "g"), "");
  val = val.replace(new RegExp("^" + escaped + "$", "g"), "");
  val = val.trim().replace(/,\s*$/, "");
  el.value = val;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function setupCraftPanel() {
  // ── Variation Dial ────────────────────────────────────────
  const dimsEl = $("#variation-dims");
  const runBtn = $("#btn-run-variations");
  const variationGrid = $("#variation-grid");
  const promptEl = $("#prompt");

  let selectedDimension = null;

  function updateRunBtn() {
    if (!runBtn) return;
    const hasPrompt = promptEl && promptEl.value.trim().length > 0;
    runBtn.disabled = !selectedDimension || !hasPrompt;
  }

  if (dimsEl) {
    for (const [key, dim] of Object.entries(VARIATION_DIMENSIONS)) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "variation-dim-pill";
      pill.dataset.dim = key;
      const labelEl = document.createElement("span");
      labelEl.className = "variation-dim-label";
      labelEl.textContent = dim.label;
      const hintEl = document.createElement("span");
      hintEl.className = "variation-dim-hint";
      hintEl.textContent = dim.hint;
      pill.appendChild(labelEl);
      pill.appendChild(hintEl);
      pill.addEventListener("click", () => {
        dimsEl.querySelectorAll(".variation-dim-pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        selectedDimension = key;
        updateRunBtn();
      });
      dimsEl.appendChild(pill);
    }
  }

  if (promptEl) {
    promptEl.addEventListener("input", updateRunBtn);
  }

  if (runBtn) {
    runBtn.addEventListener("click", runVariations);
  }

  async function runVariations() {
    if (!selectedDimension) return;
    const prompt = promptEl ? promptEl.value.trim() : "";
    if (!prompt) return;

    const dim = VARIATION_DIMENSIONS[selectedDimension];
    if (!variationGrid) return;

    variationGrid.style.display = "grid";
    variationGrid.innerHTML = "";

    // Disable run button during generation
    runBtn.disabled = true;
    runBtn.classList.add("loading");

    // Build the shared base request body from current settings
    const resVal = ($("#resolution") || {}).value || "832x1216";
    const [width, height] = resVal.split("x").map(Number);
    const qualityTags = ", very aesthetic, masterpiece, no text";
    const useQuality = $("#quality-tags") && $("#quality-tags").checked;

    function buildVariantPrompt(basePrompt, extraTags) {
      let p = basePrompt + ", " + extraTags;
      if (useQuality) {
        const pipeMatch = p.match(/^([\s\S]*?\S)([\s\n]*\|[\s\S]*)$/);
        if (pipeMatch) {
          p = pipeMatch[1] + qualityTags + pipeMatch[2];
        } else {
          p = p.replace(/\s+$/, "") + qualityTags;
        }
      }
      return p;
    }

    // Create placeholder cards
    const cards = dim.variants.map((variant, i) => {
      const card = document.createElement("div");
      card.className = "variation-card";

      const loadingEl = document.createElement("div");
      loadingEl.className = "variation-card-loading";
      loadingEl.textContent = variant.label;

      card.appendChild(loadingEl);
      variationGrid.appendChild(card);
      return { card, variant };
    });

    const currentProvider = document.getElementById("provider")?.value || "novelai";

    // Generate sequentially (one at a time) to avoid rate limits and save quota
    for (const { card, variant } of cards) {
      const variantPrompt = buildVariantPrompt(prompt, variant.tags);

      let fetchUrl, body;
      if (currentProvider === "grok") {
        fetchUrl = "/api/grok/generate-image";
        const vq = document.getElementById("grok-quality")?.value || "standard";
        body = {
          prompt: variantPrompt,
          aspect_ratio: document.getElementById("grok-aspect-ratio")?.value || "1:1",
          resolution: document.getElementById("grok-resolution")?.value || "1k",
          model: vq === "pro" ? "grok-imagine-image-pro" : "grok-imagine-image",
        };
      } else {
        fetchUrl = "/api/generate";
        body = {
          prompt: variantPrompt,
          negative_prompt: ($("#negative-prompt") || {}).value || "",
          width: width || 832,
          height: height || 1216,
          steps: parseInt(($("#steps") || {}).value || "23"),
          scale: parseFloat(($("#scale") || {}).value || "5"),
          sampler: ($("#sampler") || {}).value || "k_euler",
          seed: 0,
          sm: false,
          sm_dyn: false,
          strength: parseFloat(($("#strength") || {}).value || "0.7"),
          noise: parseFloat(($("#noise") || {}).value || "0"),
          cfg_rescale: parseFloat(($("#cfg-rescale") || {}).value || "0"),
          noise_schedule: ($("#noise-schedule") || {}).value || "karras",
          char_captions: collectCharacterPayload(),
          use_coords: characters.some((c) => !c.positionAuto),
        };
      }

      try {
        const resp = await fetch(fetchUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error("Generation failed");
        const data = await resp.json();

        // Build the result card
        card.innerHTML = "";
        card.className = "variation-card";

        const img = document.createElement("img");
        img.src = `data:image/png;base64,${data.image}`;
        img.alt = variant.label;

        const meta = document.createElement("div");
        meta.className = "variation-card-meta";

        const varLabel = document.createElement("span");
        varLabel.className = "variation-card-varlabel";
        varLabel.textContent = variant.label;

        const tagsHint = document.createElement("span");
        tagsHint.className = "variation-card-tags";
        tagsHint.textContent = variant.tags;

        meta.appendChild(varLabel);
        meta.appendChild(tagsHint);

        const overlay = document.createElement("div");
        overlay.className = "variation-card-overlay";

        const useBtn = document.createElement("button");
        useBtn.type = "button";
        useBtn.className = "btn-action btn-action--primary variation-overlay-btn";
        useBtn.textContent = "Use This";
        useBtn.addEventListener("click", () => {
          insertTagIntoPrompt(variant.tags);
          $("#tab-canvas").click();
        });

        const iterateBtn = document.createElement("button");
        iterateBtn.type = "button";
        iterateBtn.className = "btn-action btn-action--iterate variation-overlay-btn";
        iterateBtn.textContent = "Add to Layer";
        iterateBtn.addEventListener("click", () => {
          // Add variation result as a new layer
          if (layers.length < MAX_LAYERS) {
            const n = layers.length + 1;
            layers.push({ id: Date.now(), name: variant.label + " Variation", imageBase64: data.image, maskBase64: null, inpaintMaskBase64: null, opacity: 1.0, visible: true, isOutputTarget: false, offsetX: 0, offsetY: 0, scale: 1.0 });
            renderLayerList();
            saveLayersToStorage();
            refreshCompositePreview();
            const accordion = document.getElementById("layers-accordion");
            if (accordion && !accordion.open) accordion.open = true;
          }
          // Set strength to 0.55 for typical iteration workflow
          const strengthEl = $("#strength");
          if (strengthEl) {
            strengthEl.value = "0.55";
            strengthEl.dispatchEvent(new Event("input"));
          }
          insertTagIntoPrompt(variant.tags);
          $("#tab-canvas").click();
        });

        overlay.appendChild(useBtn);
        overlay.appendChild(iterateBtn);

        card.appendChild(img);
        card.appendChild(meta);
        card.appendChild(overlay);
      } catch (err) {
        card.innerHTML = "";
        const errEl = document.createElement("div");
        errEl.className = "variation-card-error";
        errEl.textContent = "Generation failed";
        card.appendChild(errEl);
      }
    } // end sequential for loop

    runBtn.disabled = false;
    runBtn.classList.remove("loading");
    updateRunBtn();
  }

  // ── Prompt Autopsy ────────────────────────────────────────
  const autopsyDrop = $("#autopsy-drop");
  const autopsyFileInput = $("#autopsy-file-input");
  const autopsyResults = $("#autopsy-results");
  const autopsyThumb = $("#autopsy-thumb");
  const autopsyStatus = $("#autopsy-status");
  const autopsyProgressWrap = $("#autopsy-progress-wrap");
  const autopsyProgressFill = $("#autopsy-progress-fill");
  const autopsyTagsEl = $("#autopsy-tags");
  const insertAllBtn = $("#btn-autopsy-insert-all");

  // Track which tags are currently inserted
  const autopsyInserted = new Set();
  let autopsyGeneration = 0; // Cancel stale polling loops

  function handleAutopsyFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    autopsyGeneration++;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      if (autopsyThumb) autopsyThumb.src = dataUrl;
      if (autopsyResults) autopsyResults.style.display = "block";
      if (autopsyTagsEl) autopsyTagsEl.innerHTML = "";
      if (insertAllBtn) insertAllBtn.style.display = "none";
      if (autopsyStatus) autopsyStatus.textContent = "Analyzing…";
      if (autopsyProgressWrap) autopsyProgressWrap.style.display = "none";
      autopsyInserted.clear();

      // Strip data:image/...;base64, prefix to get raw base64
      const base64 = dataUrl.split(",")[1];
      runAutopsyAnalysis(base64, autopsyGeneration);
    };
    reader.readAsDataURL(file);
  }

  async function runAutopsyAnalysis(base64, generation) {
    try {
      const resp = await fetch("/api/analyze-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: base64 }),
      });
      if (!resp.ok) throw new Error("Analysis failed");
      const data = await resp.json();

      if (data.status === "downloading") {
        if (autopsyStatus) autopsyStatus.textContent = "First use — downloading analysis model (~350MB)…";
        if (autopsyProgressWrap) autopsyProgressWrap.style.display = "block";
        if (autopsyProgressFill) autopsyProgressFill.style.width = (data.progress || 0) + "%";
        // Poll until complete (bail if a newer file was dropped)
        if (generation !== autopsyGeneration) return;
        setTimeout(() => runAutopsyAnalysis(base64, generation), 2000);
        return;
      }

      if (autopsyProgressWrap) autopsyProgressWrap.style.display = "none";

      if (data.status === "complete" && data.tags) {
        if (autopsyStatus) autopsyStatus.textContent = "Analysis complete";
        renderAutopsyTags(data.tags);
      } else {
        if (autopsyStatus) autopsyStatus.textContent = "Analysis failed";
      }
    } catch (err) {
      if (autopsyStatus) autopsyStatus.textContent = "Analysis failed: " + err.message;
    }
  }

  function renderAutopsyTags(flatTags) {
    if (!autopsyTagsEl) return;
    autopsyTagsEl.innerHTML = "";
    const highConfidenceTags = [];

    // Group flat array by category
    const grouped = {};
    for (const t of flatTags) {
      const cat = t.category || "subject";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(t);
    }

    const categoryLabels = { subject: "Subject", scene: "Scene", style: "Style", lighting: "Lighting", character: "Character" };

    for (const [category, tags] of Object.entries(grouped)) {
      if (!tags || tags.length === 0) continue;

      const groupEl = document.createElement("div");
      groupEl.className = "craft-tag-group";

      const header = document.createElement("div");
      header.className = "craft-tag-group-header";
      header.textContent = categoryLabels[category] || category;
      groupEl.appendChild(header);

      const pillsEl = document.createElement("div");
      pillsEl.className = "craft-tag-pills-row";

      for (const { name: tag, score } of tags) {
        if (score < 0.35) continue;

        const displayTag = tag.replace(/_/g, " ");
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "craft-tag-pill";
        if (score >= 0.7) {
          pill.classList.add("high-confidence");
          highConfidenceTags.push(tag);
        } else if (score < 0.5) {
          pill.classList.add("low-confidence");
        }
        pill.dataset.tag = tag;

        const nameSpan = document.createElement("span");
        nameSpan.textContent = displayTag;

        const scoreSpan = document.createElement("span");
        scoreSpan.className = "pill-score";
        scoreSpan.textContent = Math.round(score * 100) + "%";

        pill.appendChild(nameSpan);
        pill.appendChild(scoreSpan);

        pill.addEventListener("click", () => {
          if (autopsyInserted.has(tag)) {
            removeTagFromPrompt(tag);
            autopsyInserted.delete(tag);
            pill.classList.remove("selected");
          } else {
            insertTagIntoPrompt(tag);
            autopsyInserted.add(tag);
            pill.classList.add("selected");
          }
        });

        pillsEl.appendChild(pill);
      }

      groupEl.appendChild(pillsEl);
      autopsyTagsEl.appendChild(groupEl);
    }

    // Show "Insert All High-Confidence" button if there are high-confidence tags
    if (insertAllBtn && highConfidenceTags.length > 0) {
      insertAllBtn.style.display = "flex";
      insertAllBtn.onclick = () => {
        for (const tag of highConfidenceTags) {
          if (!autopsyInserted.has(tag)) {
            insertTagIntoPrompt(tag);
            autopsyInserted.add(tag);
          }
        }
        // Update pill selected states
        if (autopsyTagsEl) {
          autopsyTagsEl.querySelectorAll(".craft-tag-pill[data-tag]").forEach((pill) => {
            if (autopsyInserted.has(pill.dataset.tag)) {
              pill.classList.add("selected");
            }
          });
        }
      };
    }
  }

  if (autopsyDrop) {
    autopsyDrop.addEventListener("click", () => autopsyFileInput && autopsyFileInput.click());
    autopsyDrop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        autopsyFileInput && autopsyFileInput.click();
      }
    });
    autopsyDrop.addEventListener("dragover", (e) => {
      e.preventDefault();
      autopsyDrop.classList.add("drag-over");
    });
    autopsyDrop.addEventListener("dragleave", () => autopsyDrop.classList.remove("drag-over"));
    autopsyDrop.addEventListener("drop", (e) => {
      e.preventDefault();
      autopsyDrop.classList.remove("drag-over");
      const file = e.dataTransfer.files[0];
      if (file) handleAutopsyFile(file);
    });
  }

  if (autopsyFileInput) {
    autopsyFileInput.addEventListener("change", () => {
      if (autopsyFileInput.files[0]) handleAutopsyFile(autopsyFileInput.files[0]);
    });
  }

  // ── Prompt DNA ────────────────────────────────────────────
  const analyzeBtn = $("#btn-analyze-prompt");
  const dnaResults = $("#dna-results");
  const refreshBtn = $("#btn-dna-refresh");

  // Track which DNA tags are inserted
  const dnaInserted = new Set();

  function updateAnalyzeBtn() {
    if (!analyzeBtn) return;
    analyzeBtn.disabled = !promptEl || promptEl.value.trim().length === 0;
  }

  if (promptEl) {
    promptEl.addEventListener("input", updateAnalyzeBtn);
  }
  updateAnalyzeBtn();

  async function runDNAAnalysis() {
    if (!promptEl) return;
    const prompt = promptEl.value.trim();
    if (!prompt) return;

    const tags = prompt.split(/[,|]/).map((t) => t.trim().replace(/ /g, "_")).filter(Boolean);

    if (analyzeBtn) {
      analyzeBtn.disabled = true;
      analyzeBtn.textContent = "Analyzing…";
    }
    if (dnaResults) dnaResults.style.display = "none";
    if (refreshBtn) refreshBtn.style.display = "none";
    dnaInserted.clear();

    try {
      const resp = await fetch("/api/suggest-tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      if (!resp.ok) throw new Error("Analysis failed");
      const data = await resp.json();
      renderDNAResults(data);
      if (refreshBtn) refreshBtn.style.display = "flex";
    } catch (err) {
      if (dnaResults) {
        dnaResults.style.display = "block";
        dnaResults.innerHTML = "";
        const errEl = document.createElement("p");
        errEl.className = "craft-dna-error";
        errEl.textContent = "Analysis failed: " + err.message;
        dnaResults.appendChild(errEl);
      }
    } finally {
      if (analyzeBtn) {
        analyzeBtn.disabled = false;
        analyzeBtn.textContent = "Analyze Prompt";
      }
    }
  }

  const DNA_GROUPS = [
    { key: "boosters",  label: "Boosters",  desc: "Tags commonly paired with your prompt" },
    { key: "contrasts", label: "Contrasts", desc: "Try a different direction" },
    { key: "wildcards", label: "Wildcards", desc: "Unexpected inspiration" },
  ];

  function formatCount(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
    return String(n);
  }

  function renderDNAResults(data) {
    if (!dnaResults) return;
    dnaResults.innerHTML = "";
    dnaResults.style.display = "block";

    for (const group of DNA_GROUPS) {
      const tags = data[group.key];
      if (!tags || tags.length === 0) continue;

      const groupEl = document.createElement("div");
      groupEl.className = "craft-tag-group";

      const header = document.createElement("div");
      header.className = "craft-tag-group-header";
      header.textContent = group.label;

      const desc = document.createElement("div");
      desc.className = "craft-tag-group-desc";
      desc.textContent = group.desc;

      const pillsEl = document.createElement("div");
      pillsEl.className = "craft-tag-pills-row";

      for (const item of tags) {
        const tag = typeof item === "string" ? item : item.name;
        const count = typeof item === "object" ? item.count : null;
        const displayTag = tag.replace(/_/g, " ");

        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "craft-tag-pill";
        pill.dataset.tag = tag;

        const nameSpan = document.createElement("span");
        nameSpan.textContent = displayTag;
        pill.appendChild(nameSpan);

        if (count != null) {
          const countSpan = document.createElement("span");
          countSpan.className = "pill-score";
          countSpan.textContent = formatCount(count);
          pill.appendChild(countSpan);
        }

        pill.addEventListener("click", () => {
          if (dnaInserted.has(tag)) {
            removeTagFromPrompt(tag);
            dnaInserted.delete(tag);
            pill.classList.remove("selected");
          } else {
            insertTagIntoPrompt(tag);
            dnaInserted.add(tag);
            pill.classList.add("selected");
          }
        });

        pillsEl.appendChild(pill);
      }

      groupEl.appendChild(header);
      groupEl.appendChild(desc);
      groupEl.appendChild(pillsEl);
      dnaResults.appendChild(groupEl);
    }
  }

  if (analyzeBtn) analyzeBtn.addEventListener("click", runDNAAnalysis);
  if (refreshBtn) refreshBtn.addEventListener("click", runDNAAnalysis);
}

/* ═══════════════════════════════════════════════════════════
   RECENT CHARACTERS
   ═══════════════════════════════════════════════════════════ */

let _recentCharacters = []; // [{ tag, count }, ...] sorted by count desc

async function recordRecentCharacters(rawPrompt) {
  // 1. Split on comma and pipe to get tokens
  const raw = rawPrompt.split(/[,|]/).map((t) => t.trim());

  // 2. Strip weight syntax: {, }, [, ], and numeric prefix patterns like 1.5::
  const stripped = raw.map((t) =>
    t
      .replace(/^\d+(\.\d+)?::/, "")   // numeric prefix like 1.5::
      .replace(/^-\d+(\.\d+)?::/, "")  // negative numeric prefix like -1::
      .replace(/::$/, "")               // trailing ::
      .replace(/[{}\[\]]/g, "")         // braces and brackets
      .trim()
  );

  // 3. Normalize: spaces → underscores (tags.csv uses underscores)
  // Then filter: keep tokens longer than 3 chars that contain _ or (
  const candidates = stripped
    .map((t) => t.replace(/ /g, "_"))
    .filter((t) => t.length > 3 && (t.includes("_") || t.includes("(")));
  if (!candidates.length) return;

  // 4. Check which are real character tags
  try {
    const resp = await fetch(`/api/tags/check-characters?tags=${encodeURIComponent(candidates.join(","))}`);
    if (!resp.ok) return;
    const data = await resp.json();
    const confirmed = data.characters || [];
    if (!confirmed.length) return;

    // 5. Record confirmed character tags
    await fetch("/api/recent-characters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: confirmed }),
    });

    // 6. Refresh recent characters list
    await loadRecentCharacters();
  } catch { /* fire-and-forget, silent */ }
}

async function loadRecentCharacters() {
  try {
    const resp = await fetch("/api/recent-characters");
    if (!resp.ok) return;
    const data = await resp.json();
    _recentCharacters = data.characters || [];
  } catch { /* silent */ }
}


/* ═══════════════════════════════════════════════════════════
   TAG BROWSER
   ═══════════════════════════════════════════════════════════ */

let _tagCategories = [];

async function loadTagCategories() {
  try {
    const resp = await fetch("/api/tags/categories");
    if (!resp.ok) return;
    const data = await resp.json();
    _tagCategories = data.categories || [];
  } catch { /* silent */ }
}

function setupTagBrowser() {
  const btn = $("#btn-tag-browser");
  const drawer = $("#tag-browser");
  const closeBtn = $("#tag-browser-close");
  const rail = $("#tag-browser-rail");
  const grid = $("#tag-browser-grid");
  const searchInput = $("#tag-browser-search");
  const canvas = drawer.closest(".canvas");

  let activeCategory = "all";

  function isOpen() { return drawer.style.display !== "none" && !drawer.classList.contains("tag-browser--closing"); }

  function open() {
    drawer.classList.remove("tag-browser--closing");
    drawer.style.display = "flex";
    canvas.classList.add("tag-browser-open");
    btn.classList.add("btn-action--primary");
    btn.setAttribute("aria-expanded", "true");
    const fetchCategories = !_tagCategories.length ? loadTagCategories() : Promise.resolve();
    fetchCategories.then(() => {
      buildRail();
      renderGrid();
    });
  }

  function close() {
    if (!isOpen()) return;
    canvas.classList.remove("tag-browser-open");
    btn.classList.remove("btn-action--primary");
    btn.setAttribute("aria-expanded", "false");
    drawer.classList.add("tag-browser--closing");
    drawer.addEventListener("animationend", function handler() {
      drawer.removeEventListener("animationend", handler);
      drawer.style.display = "none";
      drawer.classList.remove("tag-browser--closing");
    });
  }

  btn.addEventListener("click", () => { isOpen() ? close() : open(); });
  closeBtn.addEventListener("click", close);

  // Close on outside click
  canvas.addEventListener("pointerdown", (e) => {
    if (!isOpen()) return;
    if (drawer.contains(e.target) || btn.contains(e.target)) return;
    close();
  });

  function buildRail() {
    rail.innerHTML = "";
    const allBtn = document.createElement("button");
    allBtn.className = "tag-browser-rail-btn active";
    allBtn.textContent = "All";
    allBtn.addEventListener("click", () => selectCategory("all"));
    rail.appendChild(allBtn);

    for (const cat of _tagCategories) {
      const b = document.createElement("button");
      b.className = "tag-browser-rail-btn";
      b.textContent = cat.label;
      b.dataset.id = cat.id;
      b.addEventListener("click", () => selectCategory(cat.id));
      rail.appendChild(b);
    }
  }

  function selectCategory(id) {
    activeCategory = id;
    rail.querySelectorAll(".tag-browser-rail-btn").forEach((b) => {
      b.classList.toggle("active", (b.dataset.id || "all") === id);
    });
    // First pill has no dataset.id, it's "all"
    if (id === "all") rail.firstChild.classList.add("active");
    renderGrid();
  }

  let _searchDebounce = null;
  let _renderGen = 0;

  function renderGrid() {
    ++_renderGen;
    const filter = searchInput.value.trim().toLowerCase().replace(/ /g, "_");
    grid.innerHTML = "";

    const cats = activeCategory === "all"
      ? _tagCategories
      : _tagCategories.filter((c) => c.id === activeCategory);

    let anyTags = false;
    for (const cat of cats) {
      const tags = filter
        ? cat.tags.filter((t) => t.includes(filter))
        : cat.tags;
      if (!tags.length) continue;
      anyTags = true;

      if (activeCategory === "all") {
        const label = document.createElement("div");
        label.className = "tag-browser-section-label";
        label.textContent = cat.label;
        grid.appendChild(label);
      }

      const wrap = document.createElement("div");
      wrap.className = "tag-browser-chips";
      for (const tag of tags) {
        const chip = document.createElement("button");
        chip.className = "tag-chip";
        chip.textContent = tag.replace(/_/g, " ");
        chip.addEventListener("click", () => insertBrowserTag(tag, chip));
        wrap.appendChild(chip);
      }
      grid.appendChild(wrap);
    }

    // When filtering, also search the full 140K tag database
    if (filter && filter.length >= 2) {
      clearTimeout(_searchDebounce);
      const gen = _renderGen;
      _searchDebounce = setTimeout(() => fetchFullSearch(filter, anyTags, gen), 200);
    } else if (!anyTags) {
      const empty = document.createElement("p");
      empty.className = "tag-browser-empty";
      empty.textContent = "No tags found";
      grid.appendChild(empty);
    }
  }

  async function fetchFullSearch(query, hadCuratedResults, gen) {
    try {
      const resp = await fetch(`/api/tags?q=${encodeURIComponent(query)}&limit=30`);
      if (!resp.ok || gen !== _renderGen) return;
      const results = await resp.json();

      // Dedupe against curated tags already shown
      const curatedSet = new Set();
      for (const cat of _tagCategories) for (const t of cat.tags) curatedSet.add(t);
      const extra = results.filter((r) => !curatedSet.has(r.name));
      if (!extra.length && !hadCuratedResults) {
        grid.innerHTML = `<p class="tag-browser-empty">No tags found</p>`;
        return;
      }
      if (!extra.length) return;

      const label = document.createElement("div");
      label.className = "tag-browser-section-label";
      label.textContent = "More Results";
      grid.appendChild(label);

      const wrap = document.createElement("div");
      wrap.className = "tag-browser-chips";
      for (const r of extra) {
        const chip = document.createElement("button");
        chip.className = "tag-chip";
        chip.textContent = r.name.replace(/_/g, " ");
        chip.addEventListener("click", () => insertBrowserTag(r.name, chip));
        wrap.appendChild(chip);
      }
      grid.appendChild(wrap);
    } catch { /* silent */ }
  }

  // ── Insertion target lock (Spec 1A/1B) ─────────────────────
  // Default: whichever prompt tab is active
  let _insertTarget = "prompt"; // "prompt" or "negative"
  let _savedCursor = { el: null, pos: -1 };

  const pillPrompt   = $("#tag-insert-prompt");
  const pillNegative = $("#tag-insert-negative");

  function setInsertTarget(target) {
    _insertTarget = target;
    pillPrompt.classList.toggle("active", target === "prompt");
    pillNegative.classList.toggle("active", target === "negative");
    // Sync saved cursor element
    _savedCursor = {
      el: target === "prompt" ? $("#prompt") : $("#negative-prompt"),
      pos: _savedCursor.pos,
    };
  }

  if (pillPrompt) pillPrompt.addEventListener("click", () => setInsertTarget("prompt"));
  if (pillNegative) pillNegative.addEventListener("click", () => setInsertTarget("negative"));

  // When prompt tabs are switched, sync the insert target pill
  document.querySelectorAll(".prompt-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.dataset.target === "prompt") setInsertTarget("prompt");
      else setInsertTarget("negative");
    });
  });

  // Save cursor position on blur for accurate insertion
  $("#prompt").addEventListener("blur", function() {
    _savedCursor = { el: this, pos: this.selectionStart };
    // Update pill if this was the active textarea
  });
  $("#negative-prompt").addEventListener("blur", function() {
    _savedCursor = { el: this, pos: this.selectionStart };
  });

  function insertBrowserTag(tag, chipEl) {
    // Use locked target, not visibility-based detection
    const promptEl = _insertTarget === "negative" ? $("#negative-prompt") : $("#prompt");
    const display = tag.replace(/_/g, " ");
    const val = promptEl.value;

    // Use saved cursor if it belongs to this textarea, otherwise append
    const pos = (_savedCursor.el === promptEl && _savedCursor.pos >= 0)
      ? _savedCursor.pos
      : val.length;
    const atEnd = pos === val.length;

    let insertedLen;
    if (atEnd) {
      const prefix = val.length > 0 && !val.trimEnd().endsWith(",") ? ", " : val.length > 0 ? " " : "";
      const insert = prefix + display;
      promptEl.value = val + insert;
      insertedLen = val.length + insert.length;
    } else {
      const before = val.slice(0, pos);
      const after = val.slice(pos);
      const prefix = before.length > 0 && !before.trimEnd().endsWith(",") ? ", " : before.length > 0 ? " " : "";
      const suffix = after.length > 0 && !after.trimStart().startsWith(",") ? ", " : "";
      const insert = prefix + display + suffix;
      promptEl.value = before + insert + after;
      insertedLen = before.length + insert.length;
    }

    // Move cursor to just after insertion and save it
    _savedCursor = { el: promptEl, pos: insertedLen };

    promptEl.dispatchEvent(new Event("input"));

    // Visual feedback — chip flash
    chipEl.classList.add("tag-chip--inserted");
    setTimeout(() => chipEl.classList.remove("tag-chip--inserted"), 300);

    // Prompt box border flash
    const box = promptEl.closest(".prompt-box");
    if (box) {
      box.style.borderColor = "var(--accent)";
      box.style.boxShadow = "0 0 0 3px var(--accent-dim)";
      setTimeout(() => { box.style.borderColor = ""; box.style.boxShadow = ""; }, 300);
    }
  }

  // ── Surprise Me button ──────────────────────────────────
  const surpriseBtn = $("#btn-surprise-me");
  if (surpriseBtn) {
    surpriseBtn.addEventListener("click", () => {
      const cats = activeCategory === "all"
        ? _tagCategories
        : _tagCategories.filter((c) => c.id === activeCategory);

      // Flatten all tags from relevant categories
      const allTags = [];
      for (const cat of cats) {
        for (const tag of cat.tags) allTags.push(tag);
      }
      if (!allTags.length) return;

      const pick = allTags[Math.floor(Math.random() * allTags.length)];

      // Find chip in grid if visible, otherwise insert without visual feedback
      const chips = grid.querySelectorAll(".tag-chip");
      let targetChip = null;
      for (const c of chips) {
        if (c.textContent.trim().replace(/ /g, "_") === pick || c.textContent.trim() === pick.replace(/_/g, " ")) {
          targetChip = c;
          break;
        }
      }

      if (targetChip) {
        targetChip.scrollIntoView({ block: "nearest", behavior: "smooth" });
        insertBrowserTag(pick, targetChip);
      } else {
        // Insert directly without chip visual feedback
        const promptEl = _insertTarget === "negative" ? $("#negative-prompt") : $("#prompt");
        const display = pick.replace(/_/g, " ");
        const val = promptEl.value;
        const prefix = val.length > 0 && !val.trimEnd().endsWith(",") ? ", " : val.length > 0 ? " " : "";
        promptEl.value = val + prefix + display;
        promptEl.dispatchEvent(new Event("input"));

        // Flash the button as feedback
        surpriseBtn.classList.add("btn-action--confirm");
        setTimeout(() => surpriseBtn.classList.remove("btn-action--confirm"), 300);
      }
    });
  }

  searchInput.addEventListener("input", renderGrid);
}


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
  const tabCraft = $("#tab-craft");
  const tabExplore = $("#tab-explore");
  const panelCanvas = $("#panel-canvas");
  const panelHistory = $("#panel-history");
  const panelCraft = $("#panel-craft");
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
    if (tabCraft) tabCraft.classList.remove("canvas-tab--active");
    if (tabExplore) tabExplore.classList.remove("canvas-tab--active");
  }

  function hideAllPanels() {
    panelCanvas.style.display = "none";
    panelHistory.style.display = "none";
    if (panelCraft) panelCraft.style.display = "none";
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
    if (bc) bc.style.display = "flex";
    searchWrap.style.display = "flex";
    searchInput.focus();
    localStorage.setItem("nai-active-tab", "history");
  }

  function showCraft() {
    if (!tabCraft || !panelCraft) return;
    clearAllTabs();
    hideAllPanels();
    tabCraft.classList.add("canvas-tab--active");
    panelCraft.style.display = "flex";
    localStorage.setItem("nai-active-tab", "craft");
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
  if (tabCraft) tabCraft.addEventListener("click", showCraft);
  if (tabExplore) tabExplore.addEventListener("click", showExplore);

  // Restore last active tab (default: canvas)
  let savedTab = localStorage.getItem("nai-active-tab") || "canvas";
  if (savedTab === "inspire") savedTab = "craft";
  if (savedTab === "story") savedTab = "canvas";
  if (savedTab === "history") showHistory();
  else if (savedTab === "craft") showCraft();
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

  // Apply type/source filter
  let typeFiltered = files;
  if (_galleryTypeFilter === "image") {
    typeFiltered = files.filter(f => !f.name.toLowerCase().endsWith(".mp4"));
  } else if (_galleryTypeFilter === "video") {
    typeFiltered = files.filter(f => f.name.toLowerCase().endsWith(".mp4"));
  } else if (_galleryTypeFilter === "grok") {
    typeFiltered = files.filter(f => f.name.includes("-grok") || f.name.startsWith("grok-"));
  } else if (_galleryTypeFilter === "novelai") {
    typeFiltered = files.filter(f => !f.name.includes("-grok") && !f.name.startsWith("grok-") && !f.name.toLowerCase().endsWith(".mp4"));
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

/* ═══════════════════════════════════════════════════════════
   EXPLORE PANEL — browse any page's images and load as img2img
   ═══════════════════════════════════════════════════════════ */

function setupExplorePanel() {
  const urlInput = $("#explore-url");
  const goBtn = $("#explore-go");
  const grid = $("#explore-grid");
  const status = $("#explore-status");
  const linksSection = $("#explore-links");
  const linksList = $("#explore-links-list");

  if (!urlInput || !goBtn) return;

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

      // Fetch batch tag status for dot indicators
      let analyzedMap = {};
      try {
        const tagsResp = await fetch("/api/explore/local/tags/batch?path=" + encodeURIComponent(subpath));
        if (tagsResp.ok) {
          const tagsData = await tagsResp.json();
          analyzedMap = tagsData.analyzed || {};
        }
      } catch (_) {}

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
        if (analyzedMap[file.name]) {
          const dot = document.createElement("div");
          dot.className = "explore-card-analyzed-dot";
          card.appendChild(dot);
        }
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

  // ── Analysis overlay state ──
  const analysisPanel = $("#local-analysis-overlay");
  const analysisImg = $("#local-analysis-img");
  const analysisResults = $("#local-analysis-results");
  const analysisStatus = $("#local-analysis-status");
  const analyzeWdBtn = $("#local-analyze-wd");
  const analyzeFlorenceBtn = $("#local-analyze-florence");
  const analyzeGrokBtn = $("#local-analyze-grok");
  const analysisSendBtn = $("#local-analysis-send");
  const reanalyzeWdBtn = $("#local-analysis-reanalyze-wd");
  const reanalyzeFlorenceBtn = $("#local-analysis-reanalyze-florence");
  const reanalyzeGrokBtn = $("#local-analysis-reanalyze-grok");
  let currentAnalysisPath = "";
  let selectedTags = [];
  const selectedArea = $("#local-analysis-selected");
  const selectedTagsContainer = $("#local-analysis-selected-tags");
  const clearTagsBtn = $("#local-analysis-clear-tags");
  const addToPromptBtn = $("#local-analysis-add-prompt");

  function addTagToSelection(tag) {
    if (selectedTags.includes(tag)) return;
    selectedTags.push(tag);
    renderSelectedTags();
  }

  function removeTagFromSelection(tag) {
    selectedTags = selectedTags.filter(t => t !== tag);
    renderSelectedTags();
  }

  function renderSelectedTags() {
    if (!selectedTagsContainer || !selectedArea) return;
    selectedTagsContainer.innerHTML = "";
    if (selectedTags.length === 0) {
      selectedArea.style.display = "none";
      return;
    }
    selectedArea.style.display = "";
    for (const tag of selectedTags) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "local-analysis-tag selected";
      pill.textContent = tag + " ×";
      pill.addEventListener("click", () => removeTagFromSelection(tag));
      selectedTagsContainer.appendChild(pill);
    }
  }

  if (clearTagsBtn) clearTagsBtn.addEventListener("click", () => { selectedTags = []; renderSelectedTags(); });
  if (addToPromptBtn) addToPromptBtn.addEventListener("click", () => {
    if (selectedTags.length === 0) return;
    insertTagIntoPrompt(selectedTags.join(", "));
    closeAnalysisPanel();
  });

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
    analysisPanel.style.display = "flex";
    reanalyzeWdBtn.style.display = "none";
    reanalyzeFlorenceBtn.style.display = "none";
    reanalyzeGrokBtn.style.display = "none";
    selectedTags = [];
    renderSelectedTags();

    // Show preview
    analysisImg.src = "/api/explore/local/image?path=" + encodeURIComponent(imgPath);

    // Load cached tags
    fetch("/api/explore/local/tags?path=" + encodeURIComponent(imgPath))
      .then(r => r.json())
      .then(data => {
        if (data.wd) renderWdTags(data.wd);
        if (data.florence) renderFlorenceResults(data.florence);
        if (data.grok) renderGrokAnalysis(data.grok);
      })
      .catch(() => {});
  }

  function closeAnalysisPanel() {
    analysisPanel.style.display = "none";
    currentAnalysisPath = "";
  }

  // Close button + click backdrop to close
  const analysisCloseBtn = $("#local-analysis-close");
  if (analysisCloseBtn) analysisCloseBtn.addEventListener("click", closeAnalysisPanel);
  if (analysisPanel) {
    analysisPanel.addEventListener("click", (e) => {
      if (e.target === analysisPanel) closeAnalysisPanel(); // click backdrop
    });
  }

  function renderWdTags(tags) {
    const existing = analysisResults.querySelector(".wd-section");
    if (existing) existing.remove();

    const section = document.createElement("div");
    section.className = "wd-section";

    const label = document.createElement("div");
    label.className = "local-analysis-section-label";
    label.textContent = "WD Tagger (danbooru tags)";
    section.appendChild(label);

    const container = document.createElement("div");
    container.className = "local-analysis-tags";
    for (const tag of tags) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "local-analysis-tag";
      pill.textContent = tag.name.replace(/_/g, " ");
      pill.title = tag.name + " (" + (tag.score * 100).toFixed(0) + "%)";
      pill.addEventListener("click", () => addTagToSelection(tag.name.replace(/_/g, " ")));
      container.appendChild(pill);
    }
    section.appendChild(container);
    analysisResults.appendChild(section);
    reanalyzeWdBtn.style.display = "";
  }

  function renderFlorenceResults(florence) {
    const existing = analysisResults.querySelector(".florence-section");
    if (existing) existing.remove();

    const section = document.createElement("div");
    section.className = "florence-section";

    // Short caption
    const captionLabel = document.createElement("div");
    captionLabel.className = "local-analysis-section-label";
    captionLabel.textContent = "Florence-2 Caption";
    section.appendChild(captionLabel);

    const caption = document.createElement("div");
    caption.className = "local-analysis-description";
    caption.textContent = florence.caption;
    section.appendChild(caption);

    const captionActions = document.createElement("div");
    captionActions.className = "local-analysis-desc-actions";

    const useCaptionBtn = document.createElement("button");
    useCaptionBtn.type = "button";
    useCaptionBtn.className = "btn-action";
    useCaptionBtn.textContent = "Insert";
    useCaptionBtn.addEventListener("click", () => insertTagIntoPrompt(florence.caption));
    captionActions.appendChild(useCaptionBtn);
    section.appendChild(captionActions);

    // Detailed description
    const detailLabel = document.createElement("div");
    detailLabel.className = "local-analysis-section-label";
    detailLabel.textContent = "Detailed Description";
    detailLabel.style.marginTop = "8px";
    section.appendChild(detailLabel);

    const detail = document.createElement("div");
    detail.className = "local-analysis-description";
    detail.textContent = florence.detail;
    section.appendChild(detail);

    const detailActions = document.createElement("div");
    detailActions.className = "local-analysis-desc-actions";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn-action";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(florence.detail);
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
    });
    detailActions.appendChild(copyBtn);

    const useDetailBtn = document.createElement("button");
    useDetailBtn.type = "button";
    useDetailBtn.className = "btn-action";
    useDetailBtn.textContent = "Use as Prompt";
    useDetailBtn.addEventListener("click", () => {
      const el = $("#prompt");
      if (el) { el.value = florence.detail; el.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    detailActions.appendChild(useDetailBtn);
    section.appendChild(detailActions);

    analysisResults.appendChild(section);
    reanalyzeFlorenceBtn.style.display = "";
  }

  function renderGrokAnalysis(grok) {
    const existing = analysisResults.querySelector(".grok-section");
    if (existing) existing.remove();

    const section = document.createElement("div");
    section.className = "grok-section";

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
      pill.addEventListener("click", () => addTagToSelection(tag.replace(/_/g, " ")));
      tagContainer.appendChild(pill);
    }
    section.appendChild(tagContainer);

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
    const labels = { wd: "Running WD Tagger...", florence: "Running Florence-2...", grok: "Analyzing with Grok Vision..." };
    analysisStatus.textContent = labels[method] || "Analyzing...";

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
      if (data.florence) renderFlorenceResults(data.florence);
      if (data.grok) renderGrokAnalysis(data.grok);

      // Add dot indicator to the current image card (without refreshing the whole grid)
      const fileName = currentAnalysisPath.split("/").pop();
      const cards = localGrid.querySelectorAll(".explore-card");
      for (const card of cards) {
        const img = card.querySelector("img");
        if (img && img.alt === fileName && !card.querySelector(".explore-card-analyzed-dot")) {
          const dot = document.createElement("div");
          dot.className = "explore-card-analyzed-dot";
          card.appendChild(dot);
        }
      }
    } catch (err) {
      analysisStatus.style.display = "block";
      analysisStatus.textContent = "Error: " + err.message;
    }
  }

  // Wire up buttons
  if (analyzeWdBtn) analyzeWdBtn.addEventListener("click", () => runAnalysis("wd"));
  if (analyzeFlorenceBtn) analyzeFlorenceBtn.addEventListener("click", () => runAnalysis("florence"));
  if (analyzeGrokBtn) analyzeGrokBtn.addEventListener("click", () => runAnalysis("grok"));
  if (reanalyzeWdBtn) reanalyzeWdBtn.addEventListener("click", () => runAnalysis("wd"));
  if (reanalyzeFlorenceBtn) reanalyzeFlorenceBtn.addEventListener("click", () => runAnalysis("florence"));
  if (reanalyzeGrokBtn) reanalyzeGrokBtn.addEventListener("click", () => runAnalysis("grok"));

  // Send to Canvas button
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
          img.onload = () => { closeAnalysisPanel(); openCropOverlay(img); };
          img.src = ev.target.result;
        };
        reader.readAsDataURL(blob);
      } catch (err) {
        showError("Failed to load image: " + err.message);
      }
    });
  }

  // Image click handler — opens analysis panel instead of crop overlay
  async function useLocalImage(imgPath) {
    openAnalysisPanel(imgPath);
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

  async function explorePage(url) {
    // Normalize URL
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    urlInput.value = url;

    grid.innerHTML = "";
    if (linksSection) linksSection.style.display = "none";
    status.style.display = "block";
    status.textContent = "Loading…";
    goBtn.disabled = true;

    try {
      const resp = await fetch("/api/explore/page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!resp.ok) throw new Error("Failed to load page");
      const data = await resp.json();

      status.style.display = "none";

      if (data.images.length === 0) {
        status.style.display = "block";
        status.textContent = "No images found";
        return;
      }

      // Render image grid
      for (const img of data.images) {
        const card = document.createElement("div");
        card.className = "explore-card";

        const imgEl = document.createElement("img");
        // Use proxy to avoid CORS
        imgEl.src = "/api/explore/image?url=" + encodeURIComponent(img.src);
        imgEl.alt = img.alt || "";
        imgEl.loading = "lazy";
        imgEl.addEventListener("click", () => {
          useExploreImage(img.src);
        });

        card.appendChild(imgEl);
        grid.appendChild(card);
      }

      // Render links for navigation
      if (data.links && data.links.length > 0 && linksList) {
        linksList.innerHTML = "";
        for (const link of data.links.slice(0, 20)) {
          const a = document.createElement("a");
          a.href = "#";
          a.className = "explore-link";
          a.textContent = link.text || link.href;
          a.title = link.href;
          a.addEventListener("click", (e) => {
            e.preventDefault();
            explorePage(link.href);
          });
          linksList.appendChild(a);
        }
        linksSection.style.display = "";
      }
    } catch (err) {
      status.style.display = "block";
      status.textContent = "Failed to load: " + err.message;
    } finally {
      goBtn.disabled = false;
    }
  }

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

  // People filter
  const filterBtn = $("#explore-filter-people");
  let filterActive = false;

  if (filterBtn) {
    filterBtn.addEventListener("click", async () => {
      if (filterActive) {
        // Toggle off — show all cards again
        filterActive = false;
        filterBtn.classList.remove("active");
        grid.querySelectorAll(".explore-card").forEach(c => { c.style.display = ""; });
        if (status) status.style.display = "none";
        return;
      }

      filterActive = true;
      filterBtn.classList.add("active");

      const cards = Array.from(grid.querySelectorAll(".explore-card"));
      if (cards.length === 0) return;

      if (status) {
        status.style.display = "block";
        status.textContent = "Analyzing for people… (0/" + cards.length + ")";
      }

      let done = 0;
      // Process in parallel batches of 3 for speed
      const batchSize = 3;
      for (let i = 0; i < cards.length; i += batchSize) {
        if (!filterActive) break; // user toggled off mid-scan
        const batch = cards.slice(i, i + batchSize);
        await Promise.all(batch.map(async (card) => {
          const imgEl = card.querySelector("img");
          if (!imgEl) { card.style.display = "none"; return; }
          try {
            // Fetch image as base64
            const imgResp = await fetch(imgEl.src);
            if (!imgResp.ok) { card.style.display = "none"; return; }
            const blob = await imgResp.blob();
            const b64 = await new Promise(resolve => {
              const r = new FileReader();
              r.onload = () => resolve(r.result.split(",")[1]);
              r.readAsDataURL(blob);
            });

            // Check for person
            const checkResp = await fetch("/api/explore/has-person", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ image: b64 }),
            });
            if (!checkResp.ok) { card.style.display = "none"; return; }
            const result = await checkResp.json();

            if (result.status === "downloading") {
              // Model still downloading — show status and retry after delay
              if (status) status.textContent = "Downloading analysis model (first use)… " + (result.progress || 0) + "%";
              await new Promise(r => setTimeout(r, 3000));
              // Don't hide, leave for next pass
              return;
            }

            card.style.display = result.has_person ? "" : "none";
          } catch {
            card.style.display = "none";
          }
          done++;
          if (status && filterActive) {
            status.textContent = "Analyzing for people… (" + done + "/" + cards.length + ")";
          }
        }));
      }

      if (status && filterActive) {
        const visible = grid.querySelectorAll(".explore-card:not([style*='display: none'])").length;
        status.textContent = "Filter complete: " + visible + " images with people";
        if (visible === 0) status.textContent = "No images with people found";
      }
    });
  }

  goBtn.addEventListener("click", () => {
    const url = urlInput.value.trim();
    if (url) {
      filterActive = false;
      if (filterBtn) filterBtn.classList.remove("active");
      explorePage(url);
    }
  });

  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const url = urlInput.value.trim();
      if (url) {
        filterActive = false;
        if (filterBtn) filterBtn.classList.remove("active");
        explorePage(url);
      }
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   ERROR
   ═══════════════════════════════════════════════════════════ */

function showStatus(msg) {
  clearError();
  const slot = $("#error-slot");
  const div = document.createElement("div");
  div.className = "status-msg";
  div.textContent = msg;
  slot.appendChild(div);
  setTimeout(() => { if (slot.contains(div)) slot.removeChild(div); }, 3000);
}

function showError(msg) {
  clearError();
  const slot = $("#error-slot");
  const errDiv = document.createElement("div");
  errDiv.className = "error-msg";
  errDiv.textContent = msg;
  slot.appendChild(errDiv);
}

function clearError() {
  $("#error-slot").innerHTML = "";
}

/* ═══════════════════════════════════════════════════════════
   CHARACTERS
   ═══════════════════════════════════════════════════════════ */

const MAX_CHARACTERS = 6;

function setupCharacters() {
  const addBtnEmpty  = $("#btn-add-character");
  const addBtnInline = $("#btn-add-character-inline");
  const slotsEl      = $("#character-slots");
  const accordion    = $("#characters-accordion");
  const badge        = $("#char-count-badge");
  const emptyState   = $("#char-empty-state");

  if (!slotsEl) return;

  // Show/hide markers when accordion opens/closes
  if (accordion) {
    accordion.addEventListener("toggle", () => renderCharacterMarkers());
  }

  function handleAddClick() {
    if (characters.length >= MAX_CHARACTERS) return;
    if (accordion && !accordion.open) accordion.open = true;
    addCharacterSlot(slotsEl, updateCharacterUI);
  }

  if (addBtnEmpty)  addBtnEmpty.addEventListener("click", handleAddClick);
  if (addBtnInline) addBtnInline.addEventListener("click", handleAddClick);

  function updateCharacterUI() {
    const count = characters.length;
    const isEmpty = count === 0;

    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? "inline-flex" : "none";
    }

    if (emptyState) emptyState.style.display = isEmpty ? "flex" : "none";

    if (addBtnInline) {
      addBtnInline.style.display = isEmpty ? "none" : "";
      addBtnInline.disabled = count >= MAX_CHARACTERS;
    }

    const sceneLabel = $("#scene-label");
    if (sceneLabel) sceneLabel.style.display = count > 0 ? "" : "none";

    updateCountSuggestionChip(count);
  }

  // Restore cached characters on page load
  const cached = loadCharactersFromCache();
  if (cached.length > 0) {
    // Pre-populate characters array from cache, then create UI slots
    cached.forEach((c) => {
      characters.push(c);
      // Build the DOM card for this character
      const card = document.createElement("div");
      card.className = "char-slot-card";
      card.dataset.idx = String(characters.length - 1);

      const cardHeader = document.createElement("div");
      cardHeader.className = "char-slot-header";
      const cardLabel = document.createElement("span");
      cardLabel.className = "char-slot-label";
      cardLabel.textContent = `Character ${characters.length}`;
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
        updateCharacterUI();
        renderCharacterMarkers();
        saveCharactersToCache();
      });
      const moveUpBtn = document.createElement("button");
      moveUpBtn.type = "button";
      moveUpBtn.className = "char-slot-move";
      moveUpBtn.title = "Move up";
      moveUpBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
      moveUpBtn.addEventListener("click", () => swapCharacterSlots(slotsEl, parseInt(card.dataset.idx), parseInt(card.dataset.idx) - 1));

      const moveDownBtn = document.createElement("button");
      moveDownBtn.type = "button";
      moveDownBtn.className = "char-slot-move";
      moveDownBtn.title = "Move down";
      moveDownBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
      moveDownBtn.addEventListener("click", () => swapCharacterSlots(slotsEl, parseInt(card.dataset.idx), parseInt(card.dataset.idx) + 1));

      cardHeader.appendChild(cardLabel);
      cardHeader.appendChild(moveUpBtn);
      cardHeader.appendChild(moveDownBtn);
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
    if (accordion) accordion.open = true;
    updateCharacterUI();
    renderCharacterMarkers();
  }
}

function swapCharacterSlots(slotsEl, fromIdx, toIdx) {
  if (toIdx < 0 || toIdx >= characters.length) return;
  // Swap in array
  [characters[fromIdx], characters[toIdx]] = [characters[toIdx], characters[fromIdx]];
  // Swap in DOM
  const cards = [...slotsEl.querySelectorAll(".char-slot-card")];
  const fromCard = cards[fromIdx];
  const toCard = cards[toIdx];
  if (fromIdx < toIdx) {
    slotsEl.insertBefore(toCard, fromCard);
  } else {
    slotsEl.insertBefore(fromCard, toCard);
  }
  // Re-index
  slotsEl.querySelectorAll(".char-slot-card").forEach((c, i) => {
    c.dataset.idx = i;
    const lbl = c.querySelector(".char-slot-label");
    if (lbl) lbl.textContent = `Character ${i + 1}`;
  });
  renderCharacterMarkers();
  saveCharactersToCache();
}

function addCharacterSlot(slotsEl, updateCharacterUI) {
  const idx = characters.length;
  const charData = { prompt: "", x: 0.5, y: 0.5, positionAuto: true, interactions: [] };
  characters.push(charData);

  const card = document.createElement("div");
  card.className = "char-slot-card";
  card.dataset.idx = idx;

  // ── Card header ──────────────────────────────────────────
  const cardHeader = document.createElement("div");
  cardHeader.className = "char-slot-header";

  const cardLabel = document.createElement("span");
  cardLabel.className = "char-slot-label";
  cardLabel.textContent = `Character ${idx + 1}`;

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "char-slot-remove";
  removeBtn.title = "Remove character";
  removeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
  removeBtn.addEventListener("click", () => {
    const cardIdx = parseInt(card.dataset.idx);
    characters.splice(cardIdx, 1);
    card.remove();
    slotsEl.querySelectorAll(".char-slot-card").forEach((c, i) => {
      c.dataset.idx = i;
      const lbl = c.querySelector(".char-slot-label");
      if (lbl) lbl.textContent = `Character ${i + 1}`;
    });
    if (_activeMarkerIdx >= characters.length) _activeMarkerIdx = -1;
    updateCharacterUI();
    renderCharacterMarkers();
    saveCharactersToCache();
  });

  const moveUpBtn = document.createElement("button");
  moveUpBtn.type = "button";
  moveUpBtn.className = "char-slot-move";
  moveUpBtn.title = "Move up";
  moveUpBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
  moveUpBtn.addEventListener("click", () => {
    const i = parseInt(card.dataset.idx);
    swapCharacterSlots(slotsEl, i, i - 1);
  });

  const moveDownBtn = document.createElement("button");
  moveDownBtn.type = "button";
  moveDownBtn.className = "char-slot-move";
  moveDownBtn.title = "Move down";
  moveDownBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  moveDownBtn.addEventListener("click", () => {
    const i = parseInt(card.dataset.idx);
    swapCharacterSlots(slotsEl, i, i + 1);
  });

  cardHeader.appendChild(cardLabel);
  cardHeader.appendChild(moveUpBtn);
  cardHeader.appendChild(moveDownBtn);
  cardHeader.appendChild(removeBtn);

  // ── Textarea with auto-grow ──────────────────────────────
  const ta = document.createElement("textarea");
  ta.className = "char-slot-textarea field-textarea";
  ta.rows = 2;
  ta.placeholder = "girl, blonde hair, blue eyes, waving";
  ta.spellcheck = false;
  ta.addEventListener("input", () => {
    charData.prompt = ta.value;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
    saveCharactersToCache();
  });
  // Attach shared tag autocomplete
  _tagAC.attach(ta);

  // ── Feature 4: Interactions section ─────────────────────
  const interactionsSection = buildInteractionsSection(charData);

  // ── Assemble card ────────────────────────────────────────
  card.appendChild(cardHeader);
  card.appendChild(ta);
  card.appendChild(interactionsSection);

  slotsEl.appendChild(card);
  updateCharacterUI();
  renderCharacterMarkers();
  saveCharactersToCache();
  ta.focus();
}

// ── Canvas character markers ─────────────────────────────────
// Persistent draggable markers overlaid directly on #output.
// renderCharacterMarkers() is called whenever characters change.

let _activeMarkerIdx = -1; // which marker is currently "selected" (highlighted)

function renderCharacterMarkers() {
  const outputEl = $("#output");
  if (!outputEl) return;

  // Grok has no character positioning — skip
  const provider = document.getElementById("provider")?.value || "novelai";
  if (provider === "grok") {
    outputEl.querySelectorAll(".char-marker").forEach((m) => m.remove());
    return;
  }

  // Remove existing markers
  outputEl.querySelectorAll(".char-marker").forEach((m) => m.remove());

  if (!characters.length) return;

  // Only show markers when Characters accordion is open
  const accordion = $("#characters-accordion");
  if (accordion && !accordion.open) return;

  characters.forEach((charData, i) => {
    const marker = document.createElement("div");
    marker.className = "char-marker";
    if (charData.positionAuto) marker.classList.add("char-marker--auto");
    if (i === _activeMarkerIdx) marker.classList.add("char-marker--active");
    marker.textContent = String(i + 1);
    marker.style.left = (charData.x * 100) + "%";
    marker.style.top  = (charData.y * 100) + "%";
    marker.setAttribute("role", "button");
    marker.setAttribute("aria-label", `Character ${i + 1} position. Double-click to toggle auto.`);
    marker.title = "Drag to set position. Double-click to reset to Auto.";
    marker.tabIndex = 0;

    // ── Drag state ──────────────────────────────────────────
    let isDragging = false;
    let dragMoved = false;
    let startX = 0;
    let startY = 0;

    function onDragStart(clientX, clientY) {
      isDragging = true;
      dragMoved = false;
      startX = clientX;
      startY = clientY;
      marker.classList.add("char-marker--dragging");
    }

    function onDragMove(clientX, clientY) {
      if (!isDragging) return;
      const dx = Math.abs(clientX - startX);
      const dy = Math.abs(clientY - startY);
      if (dx > 3 || dy > 3) dragMoved = true;

      const rect = outputEl.getBoundingClientRect();
      const nx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, (clientY - rect.top)  / rect.height));
      charData.x = nx;
      charData.y = ny;
      marker.style.left = (nx * 100) + "%";
      marker.style.top  = (ny * 100) + "%";
    }

    function onDragEnd() {
      if (!isDragging) return;
      isDragging = false;
      marker.classList.remove("char-marker--dragging");
      if (dragMoved) {
        charData.positionAuto = false;
        marker.classList.remove("char-marker--auto");
        saveCharactersToCache();
      }
    }

    // Mouse events
    marker.addEventListener("mousedown", (e) => {
      e.preventDefault();
      onDragStart(e.clientX, e.clientY);

      const onMove = (ev) => onDragMove(ev.clientX, ev.clientY);
      const onUp   = () => {
        onDragEnd();
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
        // Select this character on click (no drag) — update classes in place
        // (do NOT call renderCharacterMarkers here — it destroys the element
        //  and breaks dblclick detection on the second click)
        if (!dragMoved) {
          _activeMarkerIdx = i;
          outputEl.querySelectorAll(".char-marker").forEach((m, mi) => {
            m.classList.toggle("char-marker--active", mi === i);
          });
          const slotsEl = $("#character-slots");
          if (slotsEl) {
            slotsEl.querySelectorAll(".char-slot-card").forEach((c, ci) => {
              c.classList.toggle("char-slot-card--active", ci === i);
            });
          }
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
    });

    // Touch events
    marker.addEventListener("touchstart", (e) => {
      e.preventDefault();
      const t = e.touches[0];
      onDragStart(t.clientX, t.clientY);
    }, { passive: false });

    marker.addEventListener("touchmove", (e) => {
      e.preventDefault();
      const t = e.touches[0];
      onDragMove(t.clientX, t.clientY);
    }, { passive: false });

    marker.addEventListener("touchend", (e) => {
      e.preventDefault();
      onDragEnd();
      if (!dragMoved) {
        _activeMarkerIdx = i;
        outputEl.querySelectorAll(".char-marker").forEach((m, mi) => {
          m.classList.toggle("char-marker--active", mi === i);
        });
        const slotsEl = $("#character-slots");
        if (slotsEl) {
          slotsEl.querySelectorAll(".char-slot-card").forEach((c, ci) => {
            c.classList.toggle("char-slot-card--active", ci === i);
          });
        }
      }
    }, { passive: false });

    // Double-click to toggle auto mode
    marker.addEventListener("dblclick", (e) => {
      e.preventDefault();
      charData.positionAuto = !charData.positionAuto;
      if (charData.positionAuto) {
        charData.x = 0.5;
        charData.y = 0.5;
      }
      renderCharacterMarkers();
      saveCharactersToCache();
    });

    // Keyboard: Enter/Space to select, Delete to toggle auto
    marker.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        _activeMarkerIdx = i;
        renderCharacterMarkers();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        charData.positionAuto = !charData.positionAuto;
        if (charData.positionAuto) { charData.x = 0.5; charData.y = 0.5; }
        renderCharacterMarkers();
      }
    });

    outputEl.appendChild(marker);
  });
}

// ── Feature 4: Build interactions section ───────────────────

function buildInteractionsSection(charData) {
  const details = document.createElement("details");
  details.className = "char-interactions-details";

  const summary = document.createElement("summary");
  summary.className = "char-interactions-summary";
  summary.innerHTML = `<svg class="char-interactions-chevron" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>Interactions`;
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "char-interactions-body";

  // Add row
  const addRow = document.createElement("div");
  addRow.className = "char-interactions-add-row";

  const directiveSelect = document.createElement("select");
  directiveSelect.className = "char-interactions-directive";
  directiveSelect.setAttribute("aria-label", "Interaction directive type");
  [["source#", "source#"], ["target#", "target#"], ["mutual#", "mutual#"]].forEach(([val, label]) => {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    directiveSelect.appendChild(opt);
  });

  const actionInput = document.createElement("input");
  actionInput.type = "text";
  actionInput.className = "char-interactions-action";
  actionInput.placeholder = "hug";
  actionInput.spellcheck = false;
  actionInput.setAttribute("autocomplete", "off");
  // Attach shared tag autocomplete to the action input
  _tagAC.attach(actionInput);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "char-interactions-add-btn";
  addBtn.setAttribute("aria-label", "Add interaction");
  addBtn.textContent = "+";

  addRow.appendChild(directiveSelect);
  addRow.appendChild(actionInput);
  addRow.appendChild(addBtn);
  body.appendChild(addRow);

  // Chips container
  const chipsEl = document.createElement("div");
  chipsEl.className = "char-interactions-chips";
  body.appendChild(chipsEl);

  function renderChip(interaction) {
    const chip = document.createElement("span");
    chip.className = "char-interaction-chip";
    const label = document.createElement("span");
    label.textContent = interaction.directive + interaction.action.replace(/_/g, " ");
    chip.appendChild(label);
    const removeX = document.createElement("button");
    removeX.type = "button";
    removeX.className = "char-interaction-chip-remove";
    removeX.setAttribute("aria-label", `Remove ${interaction.directive}${interaction.action}`);
    removeX.textContent = "\u00d7";
    removeX.addEventListener("click", () => {
      const iIdx = charData.interactions.indexOf(interaction);
      if (iIdx >= 0) charData.interactions.splice(iIdx, 1);
      chip.remove();
      saveCharactersToCache();
    });
    chip.appendChild(removeX);
    chipsEl.appendChild(chip);
  }

  // Render pre-existing interactions as chips
  for (const interaction of charData.interactions) {
    renderChip(interaction);
  }

  function addInteraction() {
    const action = actionInput.value.trim().replace(/,/g, "").replace(/ /g, "_");
    if (!action) return;
    const directive = directiveSelect.value;
    const interaction = { directive, action };
    charData.interactions.push(interaction);
    saveCharactersToCache();
    renderChip(interaction);
    actionInput.value = "";
    actionInput.focus();
  }

  addBtn.addEventListener("click", addInteraction);
  actionInput.addEventListener("keydown", (e) => {
    // Only add on Enter when autocomplete dropdown is not navigating
    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229 && !$("#tag-dropdown").classList.contains("visible")) {
      e.preventDefault();
      addInteraction();
    }
  });

  details.appendChild(body);
  return details;
}

function updateCountSuggestionChip(count) {
  const wrap = $("#char-count-chip-wrap");
  const chip = $("#char-count-chip");
  if (!wrap || !chip) return;
  if (count === 0) {
    wrap.style.display = "none";
    return;
  }
  const tagMap = { 1: "1girl", 2: "2girls", 3: "3girls", 4: "4girls", 5: "5girls", 6: "6girls" };
  const tag = tagMap[count] || `${count}girls`;
  chip.textContent = `Add to scene: ${tag}`;
  chip.onclick = () => {
    const promptEl = $("#prompt");
    const val = promptEl.value;
    // Insert tag at beginning of prompt, unless it's already there
    if (val.trimStart().startsWith(tag)) return;
    promptEl.value = tag + (val.length > 0 ? ", " : "") + val;
    promptEl.dispatchEvent(new Event("input"));
    // Flash
    chip.classList.add("char-count-chip--inserted");
    setTimeout(() => chip.classList.remove("char-count-chip--inserted"), 400);
  };
  wrap.style.display = "flex";
}

function collectCharacterPayload() {
  return characters.map((c) => {
    let caption = c.prompt;
    if (c.interactions && c.interactions.length > 0) {
      const interactionStr = c.interactions.map((i) => i.directive + i.action).join(", ");
      const needsComma = caption.length > 0 && !caption.trimEnd().endsWith(",");
      caption = caption + (needsComma ? ", " : caption.length > 0 ? " " : "") + interactionStr;
    }
    const entry = { char_caption: caption };
    if (!c.positionAuto) {
      entry.centers = [{ x: c.x, y: c.y }];
    }
    return entry;
  });
}

init();
