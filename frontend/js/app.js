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
  "heavy": "nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
  "light": "nsfw, lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page",
  "human-focus": "nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy",
  "furry-focus": "nsfw, {worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic",
  "none": "",
};

const state = {
  img2img: null,          // base64 PNG at exact output resolution, set after crop confirmed
  img2imgThumbDataUrl: null, // small data URL just for the thumbnail preview
  lastSeed: null,
  lastImageBase64: null,
  lastVideoBase64: null,  // base64 MP4 from Grok video generation
  // canvas-displayed image (may be a gallery preview, not necessarily last generated)
  canvasImageBase64: null,
  canvasImageWidth: null,
  canvasImageHeight: null,
  grokOutputType: "image", // "image" | "video" — Grok output mode
};

// ── VIBES ─────────────────────────────────────────────────
// Each entry: { base64, infoExtracted, strength }
const vibes = [];

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
    document.getElementById("auto-iterate")?.closest(".toggle-switch"),
    document.getElementById("auto-generate")?.closest(".toggle-switch"),
    document.querySelector(".auto-toggles-divider"),
    document.getElementById("gen-settings-btn"),
    document.getElementById("img2img-accordion"),
  ];

  // Config bar NovelAI-specific fields (Canvas + its separator, Seed + its separator)
  const canvasField = document.getElementById("canvas-field");
  const canvasSep   = document.getElementById("canvas-sep");
  const seedField   = document.getElementById("seed-field");
  // The separator after seed-field is the first .config-bar-sep that follows it
  const seedSep = seedField ? seedField.nextElementSibling : null;

  novelaiOnly.forEach((el) => {
    if (el) el.style.display = isGrok ? "none" : "";
  });

  if (canvasField) canvasField.style.display = isGrok ? "none" : "";
  if (canvasSep)   canvasSep.style.display   = isGrok ? "none" : "";
  if (seedField)   seedField.style.display   = isGrok ? "none" : "";
  if (seedSep && seedSep.classList.contains("config-bar-sep")) {
    seedSep.style.display = isGrok ? "none" : "";
  }

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

  // When switching to Grok, ensure we're on the Prompt tab (not Undesired)
  if (isGrok) {
    const promptTab = document.querySelector('[data-target="prompt"]');
    const negativeTab = document.querySelector('[data-target="negative-prompt"]');
    if (negativeTab && negativeTab.classList.contains("active")) {
      if (promptTab) promptTab.click();
    }
  }

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

  // Fetch Grok usage when switching to Grok
  if (isGrok) fetchGrokUsage();
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
      bar.title = `已用 $${used.toFixed(2)}\n` + data.items
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

  setupImg2ImgControls();

  setupPromptTabs();
  setupHdEnhancement();
  setupTagAutocomplete();
  setupAutoSavePrompt();
  setupHistoryTabs();
  loadGallery();

  $("#generate-btn").addEventListener("click", generate);
  $("#btn-iterate").addEventListener("click", iterateOnResult);
  $("#btn-random-seed").addEventListener("click", () => { $("#seed").value = 0; });
  $("#btn-reuse-seed").addEventListener("click", reuseSeed);
  $("#btn-download").addEventListener("click", downloadImage);

  setupTagBrowser();
  setupGuide();
  setupSettings();
  setupCharacters();
  setupLightbox();
  setupStoryEditor();
  setupCraftPanel();
  setupExplorePanel();

  // Load recent characters at startup so autocomplete is populated immediately
  loadRecentCharacters();

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

  $("#btn-set-as-source").addEventListener("click", setCanvasImageAsSource);

  // "To Story" — insert canvas image into Story at cursor
  const addToStoryBtn = $("#btn-add-to-story");
  if (addToStoryBtn) {
    addToStoryBtn.addEventListener("click", () => {
      if (!state.canvasImageBase64) return;
      const prompt = ($("#prompt") || {}).value || "";
      insertImageAtCursor(state.canvasImageBase64, prompt, state.lastSeed);
      showStatus("Image added to Story");
    });
  }

  // "×" Clear canvas + img2img source
  const clearCanvasBtn = $("#btn-clear-canvas");
  if (clearCanvasBtn) {
    clearCanvasBtn.addEventListener("click", () => {
      clearImg2Img();
      state.canvasImageBase64 = null;
      state.lastImageBase64 = null;
      state.lastVideoBase64 = null;
      const output = $("#output");
      if (output) output.innerHTML = '<div class="placeholder"><div class="placeholder-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></div><p class="placeholder-title">Your creation awaits</p><p class="placeholder-sub">Press Generate or Enter</p></div>';
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
}

/* ═══════════════════════════════════════════════════════════
   IMG2IMG — DROP ZONE SETUP
   ═══════════════════════════════════════════════════════════ */

function setupImg2ImgControls() {
  const fileInput = $("#img2img-file-input");
  const uploadBtn = $("#btn-upload-img2img");
  const clearBtn  = $("#img2img-badge-clear");
  const changeBtn = $("#img2img-change");

  if (uploadBtn) uploadBtn.addEventListener("click", () => fileInput && fileInput.click());
  if (changeBtn) changeBtn.addEventListener("click", () => fileInput && fileInput.click());
  if (clearBtn)  clearBtn.addEventListener("click", clearImg2Img);

  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) loadImageFile(file);
      fileInput.value = "";
    });
  }

  // Canvas drop zone — shortcut to img2img
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
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith("image/")) {
        loadImageFile(file);
        const accordion = $("#img2img-accordion");
        if (accordion && !accordion.open) accordion.open = true;
      }
    });
  }
}

// Paste image from clipboard → img2img
document.addEventListener("paste", (e) => {
  // Don't intercept paste in text inputs
  const active = document.activeElement;
  if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.isContentEditable)) return;

  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) break;
      const provider = document.getElementById("provider")?.value || "novelai";
      if (provider === "grok") {
        // Grok: skip popup, directly use as img2img source
        loadImageFile(file);
      } else {
        showPasteActionPopup(file);
      }
      break;
    }
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
  btnI2I.textContent = "Use as img2img";
  btnI2I.addEventListener("click", () => {
    popup.remove();
    loadImageFile(file);
    const provider = document.getElementById("provider")?.value || "novelai";
    if (provider !== "grok") {
      const accordion = $("#img2img-accordion");
      if (accordion && !accordion.open) accordion.open = true;
    }
    showStatus("Image set as img2img source");
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
      const provider = document.getElementById("provider")?.value || "novelai";

      if (provider === "grok") {
        const ar = document.getElementById("grok-aspect-ratio")?.value || "auto";
        if (ar === "auto") {
          // Auto: use image as-is, no crop
          state.img2img = ev.target.result.split(",")[1];
          state.img2imgThumbDataUrl = ev.target.result;
          activateImg2ImgMode();
          showGrokSourceOnCanvas(ev.target.result);
          state.canvasImageBase64 = state.img2img;
          state.canvasImageWidth = img.naturalWidth;
          state.canvasImageHeight = img.naturalHeight;
        } else {
          // Specific aspect ratio: open crop overlay
          openCropOverlay(img);
        }
        const canvasTab = $("#tab-canvas");
        if (canvasTab) canvasTab.click();
        return;
      }

      const resVal = $("#resolution").value || "832x1216";
      const [tw, th] = resVal.split("x").map(Number);
      // Skip crop if image already matches target resolution
      if (img.naturalWidth === tw && img.naturalHeight === th) {
        const canvas = document.createElement("canvas");
        canvas.width = tw;
        canvas.height = th;
        canvas.getContext("2d").drawImage(img, 0, 0);
        state.img2img = canvas.toDataURL("image/png").split(",")[1];
        state.img2imgThumbDataUrl = ev.target.result;
        activateImg2ImgMode();
      } else {
        openCropOverlay(img);
      }
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

function iterateOnResult() {
  if (!state.lastImageBase64) return;
  state.img2img = state.lastImageBase64;
  const outputImg = $("#output img");
  if (outputImg) {
    const thumb = document.createElement("canvas");
    thumb.width = 128; thumb.height = 128;
    thumb.getContext("2d").drawImage(outputImg, 0, 0, 128, 128);
    state.img2imgThumbDataUrl = thumb.toDataURL("image/jpeg", 0.8);
  }
  activateImg2ImgMode();
  const accordion = $("#img2img-accordion");
  if (accordion && !accordion.open) accordion.open = true;
}

function clearImg2Img() {
  state.img2img = null;
  state.img2imgThumbDataUrl = null;

  const sourceEmpty  = $("#img2img-source-empty");
  const sourceActive = $("#img2img-source-active");
  const thumb        = $("#img2img-source-thumb");
  const badge        = $("#img2img-sidebar-badge");

  if (sourceEmpty)  sourceEmpty.style.display  = "flex";
  if (sourceActive) sourceActive.style.display = "none";
  if (thumb)        thumb.src = "";
  if (badge)        badge.style.display        = "none";
}

/* ═══════════════════════════════════════════════════════════
   CROP OVERLAY
   ═══════════════════════════════════════════════════════════ */

function openCropOverlay(imgEl) {
  const overlay = $("#crop-overlay");
  if (!overlay) return;

  // Read target resolution based on current provider
  const provider = document.getElementById("provider")?.value || "novelai";
  if (provider === "grok") {
    // Grok uses aspect ratios — convert to pixel dimensions for crop frame
    const ar = document.getElementById("grok-aspect-ratio")?.value || "1:1";
    if (ar === "auto") {
      // Auto: use the source image's native aspect ratio (no forced crop ratio)
      crop.targetW = imgEl.naturalWidth || 1024;
      crop.targetH = imgEl.naturalHeight || 1024;
    } else {
      const [aw, ah] = ar.split(":").map(Number);
      const base = 1024;
      if (aw >= ah) {
        crop.targetW = base;
        crop.targetH = Math.round(base * ah / aw);
      } else {
        crop.targetH = base;
        crop.targetW = Math.round(base * aw / ah);
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

  // The crop region in image-native pixels:
  //   srcX = offsetX / scale
  //   srcY = offsetY / scale
  //   srcW = frameW  / scale
  //   srcH = frameH  / scale
  const srcX = crop.offsetX / crop.scale;
  const srcY = crop.offsetY / crop.scale;
  const srcW = crop.frameW  / crop.scale;
  const srcH = crop.frameH  / crop.scale;

  ctx.drawImage(
    crop.img,
    srcX, srcY, srcW, srcH,
    0, 0, crop.targetW, crop.targetH
  );

  // Export as PNG base64
  const dataUrl = exportCanvas.toDataURL("image/png");
  state.img2img = dataUrl.split(",")[1]; // strip "data:image/png;base64,"

  // Generate a small thumbnail for the controls bar
  const thumbCanvas = document.createElement("canvas");
  const thumbSize = 128;
  thumbCanvas.width  = thumbSize;
  thumbCanvas.height = thumbSize;
  const thumbCtx = thumbCanvas.getContext("2d");
  thumbCtx.drawImage(exportCanvas, 0, 0, crop.targetW, crop.targetH, 0, 0, thumbSize, thumbSize);
  state.img2imgThumbDataUrl = thumbCanvas.toDataURL("image/jpeg", 0.8);

  closeCropOverlay();
  activateImg2ImgMode();

  // In Grok mode, show the cropped image on canvas with a remove button
  const provider = document.getElementById("provider")?.value || "novelai";
  if (provider === "grok") {
    showGrokSourceOnCanvas(dataUrl);
    state.canvasImageBase64 = state.img2img;
    state.canvasImageWidth = crop.targetW;
    state.canvasImageHeight = crop.targetH;
  }
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
  badge.className = "grok-source-badge";
  badge.textContent = "Source";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "grok-source-remove";
  removeBtn.title = "移除來源圖片";
  removeBtn.innerHTML = "✕";
  removeBtn.addEventListener("click", () => {
    clearImg2Img();
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

function showSourceRefThumb(outputEl, thumbDataUrl) {
  const thumb = document.createElement("img");
  thumb.src = thumbDataUrl;
  thumb.alt = "Reference";
  thumb.className = "grok-ref-thumb";
  thumb.title = "來源圖片（點擊移除）";
  thumb.addEventListener("click", () => {
    clearImg2Img();
    thumb.remove();
  });
  outputEl.appendChild(thumb);
}

function activateImg2ImgMode() {
  const sourceEmpty  = $("#img2img-source-empty");
  const sourceActive = $("#img2img-source-active");
  const thumb        = $("#img2img-source-thumb");
  const badge        = $("#img2img-sidebar-badge");

  if (sourceEmpty)  sourceEmpty.style.display  = "none";
  if (sourceActive) sourceActive.style.display = "block";
  if (badge)        badge.style.display        = "inline-block";

  if (thumb && state.img2imgThumbDataUrl) {
    thumb.src = state.img2imgThumbDataUrl;
  }
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
  });
  negative.addEventListener("input", () => {
    localStorage.setItem("nai-negative", negative.value);
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

  const prompt = $("#prompt").value.trim();
  if (!prompt) {
    showError("Please enter a prompt.");
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

  if (state.img2img) {
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

  btn.disabled = true;
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
    $("#info-seed").textContent = `Seed: ${data.seed}`;

    loadGallery();

    // Fire-and-forget: record character tags from prompt + all character slots
    const allPromptText = [prompt, ...characters.map((c) => c.prompt)].join(", ");
    recordRecentCharacters(allPromptText);

    // If redrawing a story image, replace it in-place
    if (state._storyRedrawFigure && state._storyRedrawFigure.parentNode) {
      const fig = state._storyRedrawFigure;
      const imgEl = fig.querySelector("img");
      if (imgEl) imgEl.src = `data:image/png;base64,${data.image}`;
      fig.dataset.seed = String(data.seed);
      state._storyRedrawFigure = null;
      storySaveContent();
    } else {
      // If Story tab is active, auto-insert image at cursor position
      const storyTab = $("#tab-story");
      if (storyTab && storyTab.classList.contains("canvas-tab--active")) {
        insertImageAtCursor(data.image, prompt, data.seed);
      }
    }

    // Auto Iterate: set output as img2img source for next generation
    if ($("#auto-iterate") && $("#auto-iterate").checked) {
      iterateOnResult();
    }

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

  const body = {
    prompt: prompt,
    aspect_ratio: document.getElementById("grok-aspect-ratio")?.value || "1:1",
    resolution: document.getElementById("grok-resolution")?.value || "1k",
  };

  // Include img2img source if set
  if (state.img2img) {
    body.image = state.img2img;
  }

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
    state.canvasImageBase64 = data.image;
    state.canvasImageWidth = null;
    state.canvasImageHeight = null;

    const output = $("#output");
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${data.image}`;
    img.alt = "Generated image";
    output.innerHTML = "";
    output.appendChild(img);

    // Show source reference thumbnail if img2img was used
    if (state.img2imgThumbDataUrl) {
      showSourceRefThumb(output, state.img2imgThumbDataUrl);
    }

    const actions = $("#image-actions");
    if (actions) actions.style.display = "flex";
    const infoSeed = $("#info-seed");
    if (infoSeed) infoSeed.textContent = "Grok";

    loadGallery();
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

  // Include img2img source for image-to-video
  if (state.img2img) {
    body.image = state.img2img;
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
  if (output) {
    const progressEl = document.createElement("div");
    progressEl.className = "video-progress";

    const spinnerEl = document.createElement("div");
    spinnerEl.className = "spinner";

    const msgEl = document.createElement("p");
    msgEl.textContent = "Generating video… this may take a few minutes";

    progressEl.appendChild(spinnerEl);
    progressEl.appendChild(msgEl);
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
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || "Video generation failed");
    }

    const data = await resp.json();
    state.lastSeed = null;
    state.lastImageBase64 = null;
    state.lastVideoBase64 = data.video;

    if (output) {
      output.innerHTML = "";
      const video = document.createElement("video");
      video.src = `data:video/mp4;base64,${data.video}`;
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.controls = true;
      video.style.width = "100%";
      video.style.borderRadius = "var(--radius-md)";
      output.appendChild(video);
    }

    const actions = $("#image-actions");
    if (actions) actions.style.display = "flex";
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

function setCanvasImageAsSource() {
  if (!state.canvasImageBase64) return;

  // Use the canvas-displayed image as img2img source
  state.img2img = state.canvasImageBase64;

  // Generate thumbnail from the output img element
  const outputImg = $("#output img");
  if (outputImg) {
    const thumb = document.createElement("canvas");
    thumb.width = 128; thumb.height = 128;
    thumb.getContext("2d").drawImage(outputImg, 0, 0, 128, 128);
    state.img2imgThumbDataUrl = thumb.toDataURL("image/jpeg", 0.8);
  }

  // Check if resolution matches — if so, skip crop overlay
  const provider = document.getElementById("provider")?.value || "novelai";
  let tw, th;
  if (provider === "grok") {
    // Grok has no fixed pixel resolution — always go to crop or direct
    tw = null;
    th = null;
  } else {
    const resVal = $("#resolution").value || "832x1216";
    [tw, th] = resVal.split("x").map(Number);
  }
  const iw = state.canvasImageWidth;
  const ih = state.canvasImageHeight;

  if (iw && ih && iw === tw && ih === th) {
    // Resolution matches — activate directly
    activateImg2ImgMode();
    const accordion = $("#img2img-accordion");
    if (accordion && !accordion.open) accordion.open = true;
  } else if (iw && ih) {
    // Resolution differs — show crop overlay
    const img = new Image();
    img.onload = () => {
      activateImg2ImgMode();
      const accordion = $("#img2img-accordion");
      if (accordion && !accordion.open) accordion.open = true;
      openCropOverlay(img);
    };
    img.src = `data:image/png;base64,${state.canvasImageBase64}`;
  } else {
    // No size info — activate directly without crop
    activateImg2ImgMode();
    const accordion = $("#img2img-accordion");
    if (accordion && !accordion.open) accordion.open = true;
  }
}

/* ═══════════════════════════════════════════════════════════
   CRAFT PANEL — Variation Dial, Prompt Autopsy, Prompt DNA
   ═══════════════════════════════════════════════════════════ */

const VARIATION_DIMENSIONS = {
  lighting: {
    label: "Lighting",
    hint: "改變光線來源、時段、氛圍光",
    variants: [
      { label: "暖光",  tags: "soft natural lighting, golden hour" },
      { label: "戲劇光", tags: "dramatic rim lighting, dark atmosphere" },
      { label: "霓虹",  tags: "neon light, cyberpunk lighting" },
      { label: "月光",  tags: "moonlight, ethereal glow, night" },
    ],
  },
  artStyle: {
    label: "Art Style",
    hint: "改變繪畫媒材、線條風格",
    variants: [
      { label: "水彩",  tags: "watercolor, painterly, loose brushstrokes" },
      { label: "賽璐珞", tags: "detailed lineart, clean lines, cel shaded" },
      { label: "油畫",  tags: "oil painting, impasto texture, rich colors" },
      { label: "素描",  tags: "sketch style, pencil, rough lines" },
    ],
  },
  composition: {
    label: "Composition",
    hint: "改變鏡頭距離、角度",
    variants: [
      { label: "特寫",  tags: "close-up, portrait, face focus" },
      { label: "全身",  tags: "full body, wide shot, establishing" },
      { label: "俯角",  tags: "from above, bird's eye view, overhead angle" },
      { label: "動態",  tags: "dynamic angle, dutch angle, cinematic" },
    ],
  },
  mood: {
    label: "Mood",
    hint: "改變情緒基調、色調",
    variants: [
      { label: "憂鬱",  tags: "melancholic, somber, wistful atmosphere" },
      { label: "活躍",  tags: "vibrant, energetic, lively" },
      { label: "神秘",  tags: "mysterious, eerie, tension" },
      { label: "平靜",  tags: "peaceful, serene, calm" },
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

    // Generate all 4 in parallel
    const currentProvider = document.getElementById("provider")?.value || "novelai";

    const promises = cards.map(async ({ card, variant }) => {
      const variantPrompt = buildVariantPrompt(prompt, variant.tags);

      let fetchUrl, body;
      if (currentProvider === "grok") {
        fetchUrl = "/api/grok/generate-image";
        body = {
          prompt: variantPrompt,
          aspect_ratio: document.getElementById("grok-aspect-ratio")?.value || "1:1",
          resolution: document.getElementById("grok-resolution")?.value || "1k",
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
        iterateBtn.textContent = "Iterate";
        iterateBtn.addEventListener("click", () => {
          // Set as img2img source at strength 0.55
          state.img2img = data.image;
          // Build small thumbnail for sidebar preview
          const thumbCanvas = document.createElement("canvas");
          thumbCanvas.width = 128; thumbCanvas.height = 128;
          thumbCanvas.getContext("2d").drawImage(img, 0, 0, 128, 128);
          state.img2imgThumbDataUrl = thumbCanvas.toDataURL("image/jpeg", 0.8);
          const strengthEl = $("#strength");
          if (strengthEl) {
            strengthEl.value = "0.55";
            strengthEl.dispatchEvent(new Event("input"));
          }
          activateImg2ImgMode();
          const accordion = $("#img2img-accordion");
          if (accordion && !accordion.open) accordion.open = true;
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
        errEl.textContent = "生成失敗";
        card.appendChild(errEl);
      }
    });

    await Promise.allSettled(promises);
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
      if (autopsyStatus) autopsyStatus.textContent = "正在分析…";
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
        if (autopsyStatus) autopsyStatus.textContent = "首次使用，正在下載分析模型（約 350MB）…";
        if (autopsyProgressWrap) autopsyProgressWrap.style.display = "block";
        if (autopsyProgressFill) autopsyProgressFill.style.width = (data.progress || 0) + "%";
        // Poll until complete (bail if a newer file was dropped)
        if (generation !== autopsyGeneration) return;
        setTimeout(() => runAutopsyAnalysis(base64, generation), 2000);
        return;
      }

      if (autopsyProgressWrap) autopsyProgressWrap.style.display = "none";

      if (data.status === "complete" && data.tags) {
        if (autopsyStatus) autopsyStatus.textContent = "分析完成";
        renderAutopsyTags(data.tags);
      } else {
        if (autopsyStatus) autopsyStatus.textContent = "分析失敗";
      }
    } catch (err) {
      if (autopsyStatus) autopsyStatus.textContent = "分析失敗：" + err.message;
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

    const categoryLabels = { subject: "主體", scene: "場景", style: "風格", lighting: "光線", character: "角色" };

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
      analyzeBtn.textContent = "分析中…";
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
        errEl.textContent = "分析失敗：" + err.message;
        dnaResults.appendChild(errEl);
      }
    } finally {
      if (analyzeBtn) {
        analyzeBtn.disabled = false;
        analyzeBtn.textContent = "分析 Prompt";
      }
    }
  }

  const DNA_GROUPS = [
    { key: "boosters",  label: "提升者 (Boosters)",  desc: "這些 tag 常與你的 prompt 一起出現" },
    { key: "contrasts", label: "對比者 (Contrasts)",  desc: "換個方向試試" },
    { key: "wildcards", label: "外星人 (Wildcards)",  desc: "意外的靈感" },
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
let _settingsLoadedToast = null;

function setupHistoryTabs() {
  const tabCanvas = $("#tab-canvas");
  const tabHistory = $("#tab-history");
  const tabStory = $("#tab-story");
  const tabCraft = $("#tab-craft");
  const tabExplore = $("#tab-explore");
  const panelCanvas = $("#panel-canvas");
  const panelHistory = $("#panel-history");
  const panelStory = $("#panel-story");
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
    if (tabStory) tabStory.classList.remove("canvas-tab--active");
    if (tabCraft) tabCraft.classList.remove("canvas-tab--active");
    if (tabExplore) tabExplore.classList.remove("canvas-tab--active");
  }

  function hideAllPanels() {
    panelCanvas.style.display = "none";
    panelHistory.style.display = "none";
    if (panelStory) panelStory.style.display = "none";
    if (panelCraft) panelCraft.style.display = "none";
    if (panelExplore) panelExplore.style.display = "none";
    searchWrap.style.display = "none";
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
    searchWrap.style.display = "flex";
    searchInput.focus();
    localStorage.setItem("nai-active-tab", "history");
  }

  function showStory() {
    if (!tabStory || !panelStory) return;
    clearAllTabs();
    hideAllPanels();
    tabStory.classList.add("canvas-tab--active");
    panelStory.style.display = "flex";
    localStorage.setItem("nai-active-tab", "story");
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
  if (tabStory) tabStory.addEventListener("click", showStory);
  if (tabCraft) tabCraft.addEventListener("click", showCraft);
  if (tabExplore) tabExplore.addEventListener("click", showExplore);

  // Restore last active tab (default: story)
  // Migrate old "inspire" value to "craft"
  let savedTab = localStorage.getItem("nai-active-tab") || "story";
  if (savedTab === "inspire") savedTab = "craft";
  if (savedTab === "story") showStory();
  else if (savedTab === "history") showHistory();
  else if (savedTab === "craft") showCraft();
  else if (savedTab === "explore") showExplore();
  // else canvas is already active by default

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      renderGallery(_galleryData, [], searchInput.value.toLowerCase());
    });
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

  const filtered = filter
    ? files.filter((f) => {
        const meta = f.meta || {};
        return (meta.prompt || "").toLowerCase().includes(filter)
          || (meta.uc || "").toLowerCase().includes(filter)
          || String(meta.seed || "").includes(filter)
          || f.name.toLowerCase().includes(filter);
      })
    : files;

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
    iterateBtn.title = "Iterate: load settings + use as source";
    iterateBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>Iterate`;
    iterateBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      loadSettingsFromMeta(meta);
      // Set image as img2img source from URL
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

    actionBar.appendChild(iterateBtn);
    actionBar.appendChild(loadBtn);
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
      <p class="lightbox-prompt" id="lb-prompt"></p>
      <div class="lightbox-actions">
        <button class="btn-action" id="lb-load" type="button">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.84"/></svg>
          Load
        </button>
        <button class="btn-action btn-action--iterate" id="lb-iterate" type="button">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
          Iterate
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

/* ═══════════════════════════════════════════════════════════
   STORY EDITOR
   ═══════════════════════════════════════════════════════════ */

let _storySaveTimer = null;
// Saved selection range so toolbar buttons don't lose cursor position
let _storySavedRange = null;
// ID of the currently open story
let _activeStoryId = null;

/* ── Story API helpers ── */
async function storyApiList() {
  const res = await fetch("/api/stories");
  if (!res.ok) throw new Error("Failed to list stories");
  return res.json();
}

async function storyApiGet(id) {
  const res = await fetch(`/api/stories/${id}`);
  if (!res.ok) throw new Error("Story not found");
  return res.json();
}

async function storyApiCreate(title, content) {
  const res = await fetch("/api/stories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, content }),
  });
  if (!res.ok) throw new Error("Failed to create story");
  return res.json();
}

async function storyApiUpdate(id, data) {
  const res = await fetch(`/api/stories/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update story");
  return res.json();
}

async function storyApiDelete(id) {
  const res = await fetch(`/api/stories/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error("Failed to delete story");
}

function storySaveContent() {
  clearTimeout(_storySaveTimer);
  _storySaveTimer = setTimeout(async () => {
    if (!_activeStoryId) return;
    const editor = $("#story-editor-content");
    const titleInput = $("#story-title");
    if (!editor) return;
    const title = titleInput ? (titleInput.value.trim() || "Untitled Story") : "Untitled Story";
    const content = editor.innerHTML;
    try {
      await storyApiUpdate(_activeStoryId, { title, content });
    } catch (_) { /* ignore transient failures */ }
  }, 500);
}

function storyUpdateWordCount() {
  const editor = $("#story-editor-content");
  const el = $("#story-word-count");
  if (!editor || !el) return;
  const text = editor.textContent.trim();
  const w = text ? text.split(/\s+/).length : 0;
  el.textContent = w > 0 ? `${w} word${w === 1 ? "" : "s"}` : "";
}

function storySaveSelection() {
  const sel = window.getSelection();
  const editor = $("#story-editor-content");
  if (!editor || !sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (editor.contains(range.commonAncestorContainer)) {
    _storySavedRange = range.cloneRange();
  }
}

function storyRestoreSelection() {
  if (!_storySavedRange) return;
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(_storySavedRange);
}

function insertImageAtCursor(base64, prompt, seed) {
  const editor = $("#story-editor-content");
  if (!editor) return;

  const figure = document.createElement("figure");
  figure.className = "story-inline-img";
  figure.contentEditable = "false";
  figure.dataset.prompt = prompt || "";
  figure.dataset.seed = seed != null ? String(seed) : "";

  const img = document.createElement("img");
  img.src = `data:image/png;base64,${base64}`;
  img.alt = "AI generated illustration";

  const caption = document.createElement("figcaption");
  caption.textContent = prompt || "";

  const redrawBtn = document.createElement("button");
  redrawBtn.type = "button";
  redrawBtn.className = "story-inline-img-redraw";
  redrawBtn.setAttribute("aria-label", "Redraw with img2img");
  redrawBtn.textContent = "Redraw";
  // Click handled by event delegation in _attachEditorImageListeners

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "story-inline-img-delete";
  delBtn.setAttribute("aria-label", "Remove image");
  delBtn.textContent = "\u00d7";
  // Click handled by event delegation in _attachEditorImageListeners

  figure.appendChild(img);
  if (prompt) figure.appendChild(caption);
  figure.appendChild(redrawBtn);
  figure.appendChild(delBtn);

  storyRestoreSelection();
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      range.insertNode(figure);
      range.setStartAfter(figure);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      _storySavedRange = range.cloneRange();
    } else {
      editor.appendChild(figure);
    }
  } else {
    editor.appendChild(figure);
  }

  storySaveContent();
  storyUpdateWordCount();
}

/* Old block-based story code removed — replaced by contentEditable approach

    } else if (block.type === "image") {
      blockEl.className = "story-block story-block--image";

      const figure = document.createElement("figure");

      const img = document.createElement("img");
      img.src = `data:image/png;base64,${block.base64}`;
      img.alt = block.prompt || "Story image";
      figure.appendChild(img);

      if (block.prompt) {
        const caption = document.createElement("figcaption");
        caption.textContent = block.prompt;
        figure.appendChild(caption);
      }

      if (block.seed != null) {
        const seedBadge = document.createElement("div");
        seedBadge.className = "story-img-seed-badge";
        seedBadge.textContent = `Seed: ${Number(block.seed)}`;
        figure.appendChild(seedBadge);
      }

      blockEl.appendChild(figure);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "story-img-delete";
      delBtn.textContent = "Remove";
      delBtn.addEventListener("click", () => {
        if (!confirm("Remove this image from the story?")) return;
        _storyBlocks.splice(_storyBlocks.indexOf(block), 1);
        storySave();
        renderStoryBlocks();
      });
      blockEl.appendChild(delBtn);
    }
*/

/* ── Relative time formatting ── */
function relativeTime(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(isoStr).toLocaleDateString();
}

function _attachEditorImageListeners(editor) {
  editor.addEventListener("click", (e) => {
    // Delete button
    const delBtn = e.target.closest(".story-inline-img-delete");
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();
      const figure = delBtn.closest(".story-inline-img");
      if (figure) figure.remove();
      storyUpdateWordCount();
      storySaveContent();
      return;
    }

    // Redraw button — set image as i2i source, load prompt, generate
    const redrawBtn = e.target.closest(".story-inline-img-redraw");
    if (redrawBtn) {
      e.preventDefault();
      e.stopPropagation();
      const figure = redrawBtn.closest(".story-inline-img");
      if (!figure) return;

      // Get the image base64 from the <img> src
      const imgEl = figure.querySelector("img");
      if (!imgEl || !imgEl.src) return;
      const base64 = imgEl.src.replace(/^data:image\/png;base64,/, "");

      // Set as img2img source
      state.img2img = base64;
      state.canvasImageBase64 = base64;
      activateImg2ImgMode();
      const accordion = $("#img2img-accordion");
      if (accordion && !accordion.open) accordion.open = true;

      // Load the stored prompt
      const storedPrompt = figure.dataset.prompt || "";
      if (storedPrompt) {
        const promptEl = $("#prompt");
        if (promptEl) {
          promptEl.value = storedPrompt;
          localStorage.setItem("nai-prompt", storedPrompt);
        }
      }

      // Store reference to the figure so we can replace the image after generation
      state._storyRedrawFigure = figure;

      // Trigger generation
      generate();
    }
  });
}

function setupStoryEditor() {
  const editor = $("#story-editor-content");
  if (!editor) return;

  const writingMode = $("#story-writing-mode");
  const bookshelfMode = $("#story-bookshelf-mode");
  const titleInput = $("#story-title");

  /* ── Mode helpers ── */
  function showWritingMode() {
    writingMode.style.display = "";
    bookshelfMode.style.display = "none";
  }

  async function showBookshelf() {
    writingMode.style.display = "none";
    bookshelfMode.style.display = "flex";
    try {
      const stories = await storyApiList();
      renderBookshelfCards(stories);
    } catch (_) {
      renderBookshelfCards([]);
    }
  }

  /* ── Open a story by ID ── */
  async function openStory(id) {
    try {
      const story = await storyApiGet(id);
      _activeStoryId = story.id;
      editor.innerHTML = story.content || "";
      titleInput.value = story.title || "Untitled Story";
      // Re-enforce contentEditable=false on restored figures
      editor.querySelectorAll(".story-inline-img").forEach((fig) => {
        fig.contentEditable = "false";
      });
      showWritingMode();
      storyUpdateWordCount();
    } catch (_) {
      // If story was deleted externally, fall back to bookshelf
      showBookshelf();
    }
  }

  /* ── Create a new story and open it ── */
  async function createAndOpenStory() {
    try {
      const story = await storyApiCreate("Untitled Story", "");
      await openStory(story.id);
    } catch (_) { /* ignore */ }
  }

  /* ── Bookshelf rendering ── */
  // Confirm-delete state: maps story id → timer handle
  const _deleteConfirm = new Map();

  function renderBookshelfCards(stories) {
    const list = $("#bookshelf-list");
    list.innerHTML = "";

    if (!stories.length) {
      const empty = document.createElement("div");
      empty.className = "bookshelf-empty";
      empty.textContent = "No stories yet. Start writing.";
      list.appendChild(empty);
      return;
    }

    // Sort by updated_at descending
    const sorted = [...stories].sort((a, b) =>
      new Date(b.updated_at) - new Date(a.updated_at)
    );

    for (const s of sorted) {
      const card = document.createElement("div");
      card.className = "bookshelf-card";
      card.dataset.storyId = s.id;

      const titleEl = document.createElement("div");
      titleEl.className = "bookshelf-card-title";
      titleEl.textContent = s.title || "Untitled Story";

      const meta = document.createElement("div");
      meta.className = "bookshelf-card-meta";

      const info = document.createElement("span");
      const wordCount = s.word_count != null ? `${s.word_count} word${s.word_count === 1 ? "" : "s"}` : "";
      const time = relativeTime(s.updated_at);
      info.textContent = wordCount ? `${wordCount} · ${time}` : time;

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn-action bookshelf-card-delete";
      delBtn.dataset.deleteId = s.id;
      delBtn.textContent = "Delete";

      meta.appendChild(info);
      meta.appendChild(delBtn);
      card.appendChild(titleEl);
      card.appendChild(meta);
      list.appendChild(card);
    }
  }

  /* ── Bookshelf event delegation ── */
  const list = $("#bookshelf-list");
  list.addEventListener("click", async (e) => {
    // Delete button — two-click confirm
    const delBtn = e.target.closest("[data-delete-id]");
    if (delBtn) {
      e.stopPropagation();
      const id = delBtn.dataset.deleteId;
      if (_deleteConfirm.has(id)) {
        // Second click — confirmed
        clearTimeout(_deleteConfirm.get(id));
        _deleteConfirm.delete(id);
        try {
          await storyApiDelete(id);
          // If we deleted the active story, clear it
          if (_activeStoryId === id) {
            _activeStoryId = null;
          }
        } catch (_) { /* ignore */ }
        // Re-render bookshelf
        try {
          const stories = await storyApiList();
          renderBookshelfCards(stories);
        } catch (_) {
          renderBookshelfCards([]);
        }
      } else {
        // First click — arm the confirm
        delBtn.textContent = "Confirm?";
        delBtn.classList.add("bookshelf-card-delete--confirm");
        const timer = setTimeout(() => {
          _deleteConfirm.delete(id);
          delBtn.textContent = "Delete";
          delBtn.classList.remove("bookshelf-card-delete--confirm");
        }, 3000);
        _deleteConfirm.set(id, timer);
      }
      return;
    }

    // Card click — open story
    const card = e.target.closest(".bookshelf-card[data-story-id]");
    if (card) {
      await openStory(card.dataset.storyId);
    }
  });

  /* ── Header button wiring ── */
  $("#story-btn-bookshelf").addEventListener("click", showBookshelf);
  $("#story-btn-new").addEventListener("click", createAndOpenStory);
  $("#bookshelf-btn-new").addEventListener("click", createAndOpenStory);

  /* ── Title input saves ── */
  titleInput.addEventListener("input", storySaveContent);

  /* ── Editor event listeners ── */
  _attachEditorImageListeners(editor);

  // Protect images from contentEditable corruption:
  // Re-enforce contentEditable=false on all figures after any mutation
  const observer = new MutationObserver(() => {
    editor.querySelectorAll(".story-inline-img").forEach((fig) => {
      if (fig.contentEditable !== "false") fig.contentEditable = "false";
    });
  });
  observer.observe(editor, { childList: true, subtree: true, attributes: true });

  // Prevent contentEditable from resizing images (disable browser handles)
  editor.addEventListener("mousedown", (e) => {
    if (e.target.tagName === "IMG" && e.target.closest(".story-inline-img")) {
      e.preventDefault();
    }
  });

  // Live save & word count on content changes
  editor.addEventListener("input", () => {
    storyUpdateWordCount();
    storySaveContent();
  });

  // Save selection on every cursor movement so toolbar buttons know where to insert
  editor.addEventListener("keyup", storySaveSelection);
  editor.addEventListener("mouseup", storySaveSelection);
  editor.addEventListener("blur", storySaveSelection);

  /* ── Init: migrate localStorage if present, then load stories ── */
  (async () => {
    // Migration: if there is old localStorage content, create a story from it
    try {
      const legacy = localStorage.getItem("nai-story-v2");
      if (legacy && legacy.trim() && legacy.trim() !== "<br>") {
        await storyApiCreate("Imported Story", legacy);
        localStorage.removeItem("nai-story-v2");
        // Will be opened as the most recent story below
      }
    } catch (_) { /* migration failure is non-fatal */ }

    // Load story list and open most recent, or create a fresh one
    try {
      const stories = await storyApiList();
      if (stories.length) {
        const sorted = [...stories].sort((a, b) =>
          new Date(b.updated_at) - new Date(a.updated_at)
        );
        await openStory(sorted[0].id);
      } else {
        await createAndOpenStory();
      }
    } catch (_) {
      // If API is unavailable, show writing mode with no active story
      showWritingMode();
      storyUpdateWordCount();
    }
  })();
}

// ── end of story editor ──────────────────────────────────

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

  const img = document.createElement("img");
  img.className = "lightbox-img";
  img.alt = meta.prompt || file.name;

  img.onload = () => {
    imgWrap.innerHTML = "";
    imgWrap.appendChild(img);
  };
  img.onerror = () => {
    imgWrap.innerHTML = "";
    const err = document.createElement("p");
    err.style.cssText = "color:var(--text-tertiary);font-size:0.83rem";
    err.textContent = "Failed to load image";
    imgWrap.appendChild(err);
  };
  img.src = galleryFileUrl(file.name);
}

async function setHistoryImageAsSource(url, meta) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      // Draw to canvas to get base64
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);

      const resVal = $("#resolution").value || "832x1216";
      const [tw, th] = resVal.split("x").map(Number);
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;

      if (iw === tw && ih === th) {
        // Exact match — use directly
        state.img2img = c.toDataURL("image/png").split(",")[1];
        // Make thumbnail
        const thumb = document.createElement("canvas");
        thumb.width = 128; thumb.height = 128;
        thumb.getContext("2d").drawImage(img, 0, 0, 128, 128);
        state.img2imgThumbDataUrl = thumb.toDataURL("image/jpeg", 0.8);
        activateImg2ImgMode();
        const accordion = $("#img2img-accordion");
        if (accordion && !accordion.open) accordion.open = true;
        resolve();
      } else {
        // Needs crop — openCropOverlay will call activateImg2ImgMode() on confirm
        const accordion = $("#img2img-accordion");
        if (accordion && !accordion.open) accordion.open = true;
        openCropOverlay(img);
        resolve();
      }
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

  async function explorePage(url) {
    // Normalize URL
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    urlInput.value = url;

    grid.innerHTML = "";
    if (linksSection) linksSection.style.display = "none";
    status.style.display = "block";
    status.textContent = "載入中…";
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
        status.textContent = "找不到圖片";
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
      status.textContent = "載入失敗：" + err.message;
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
        state.img2img = dataUrl.split(",")[1];
        state.img2imgThumbDataUrl = dataUrl;
        activateImg2ImgMode();

        const provider = document.getElementById("provider")?.value || "novelai";
        if (provider === "grok") {
          showGrokSourceOnCanvas(dataUrl);
          state.canvasImageBase64 = state.img2img;
          state.canvasImageWidth = null;
          state.canvasImageHeight = null;
        } else {
          const accordion = $("#img2img-accordion");
          if (accordion && !accordion.open) accordion.open = true;
        }

        // Switch to Canvas tab so the user sees the loaded source
        const canvasTab = $("#tab-canvas");
        if (canvasTab) canvasTab.click();

        showStatus("圖片已載入");
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      showError("圖片載入失敗：" + err.message);
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
        status.textContent = "正在分析人物… (0/" + cards.length + ")";
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
              if (status) status.textContent = "正在下載分析模型（首次使用）… " + (result.progress || 0) + "%";
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
            status.textContent = "正在分析人物… (" + done + "/" + cards.length + ")";
          }
        }));
      }

      if (status && filterActive) {
        const visible = grid.querySelectorAll(".explore-card:not([style*='display: none'])").length;
        status.textContent = "篩選完成：" + visible + " 張人物圖片";
        if (visible === 0) status.textContent = "沒有找到人物圖片";
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
