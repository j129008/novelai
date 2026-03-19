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
  vibe: null,
  lastSeed: null,
  lastImageBase64: null,
  // canvas-displayed image (may be a gallery preview, not necessarily last generated)
  canvasImageBase64: null,
  canvasImageWidth: null,
  canvasImageHeight: null,
};

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
  bindSlider("strength", "strength-val", 2);
  bindSlider("noise", "noise-val", 2);
  bindSlider("ref-strength", "ref-strength-val", 2);
  bindSlider("ref-info", "ref-info-val", 2);

  // Persist resolution selection
  const resolutionEl = $("#resolution");
  if (resolutionEl) {
    resolutionEl.addEventListener("change", () => {
      localStorage.setItem("nai-resolution", resolutionEl.value);
    });
  }

  // Vibe/style-reference upload (sidebar, unchanged)
  setupFileUpload("vibe-upload", "vibe-preview", "vibe-placeholder", "vibe-clear", "vibe");

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

  // Load recent characters at startup so sidebar section is populated immediately
  loadRecentCharacters().then(renderRecentCharsInSidebar);

  $("#btn-set-as-source").addEventListener("click", setCanvasImageAsSource);

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      generate();
    }
    // Escape closes the crop overlay
    if (e.key === "Escape") {
      const co = $("#crop-overlay");
      if (co && co.style.display !== "none") closeCropOverlay();
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

function loadImageFile(file) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
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

  // Read target resolution from the resolution select
  const resVal = $("#resolution").value || "832x1216";
  const [tw, th] = resVal.split("x").map(Number);
  crop.targetW = tw || 832;
  crop.targetH = th || 1216;

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
    if (query.length < 2) { hide(); return; }
    try {
      const resp = await fetch(`/api/tags?q=${encodeURIComponent(query)}`);
      if (!resp.ok) return;
      const tags = await resp.json();
      show(tags, query);
    } catch { /* ignore */ }
  }

  function show(tags, query) {
    if (!tags.length) { hide(); return; }
    selectedIdx = -1;
    const q = query.toLowerCase();
    dropdown.innerHTML = "";
    tags.forEach((tag) => {
      const item = document.createElement("div");
      item.className = "tag-item";

      const nameSpan = document.createElement("span");
      nameSpan.className = "tag-item-name";
      const name = tag.name.replace(/_/g, " ");
      const idx = name.toLowerCase().indexOf(q.replace(/_/g, " "));
      if (idx >= 0) {
        nameSpan.innerHTML = escapeHtml(name.slice(0, idx))
          + "<mark>" + escapeHtml(name.slice(idx, idx + q.length)) + "</mark>"
          + escapeHtml(name.slice(idx + q.length));
      } else {
        nameSpan.textContent = name;
      }

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
    } else if (e.key === "Tab" || e.key === "Enter") {
      // Tab: only complete if user has actively selected an item with arrow keys
      // Enter: auto-select first item if nothing selected (more intentional action)
      if (e.key === "Enter" && selectedIdx < 0 && items.length > 0) selectedIdx = 0;
      if (selectedIdx >= 0) {
        e.preventDefault();
        const name = items[selectedIdx].querySelector(".tag-item-name").textContent;
        insert(name.replace(/ /g, "_"));
      } else if (e.key === "Tab") {
        // No selection — let Tab pass through naturally (dismiss dropdown)
        hide();
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
  btn.querySelector(".btn-generate-label").textContent = "Generate";
  btn.querySelector(".btn-generate-hint").textContent = "Cmd + Enter";
  _generateAbortController = null;
}

async function generate() {
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

  if (state.vibe) {
    body.reference_image = state.vibe;
    body.reference_information_extracted = parseFloat($("#ref-info").value);
    body.reference_strength = parseFloat($("#ref-strength").value);
  }

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

    const storyInsertBtn = $("#story-insert-img");
    if (storyInsertBtn) storyInsertBtn.disabled = false;

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
  if (!state.lastImageBase64) return;
  const a = document.createElement("a");
  a.href = `data:image/png;base64,${state.lastImageBase64}`;
  a.download = `novelai-${state.lastSeed || "image"}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
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
  const resVal = $("#resolution").value || "832x1216";
  const [tw, th] = resVal.split("x").map(Number);
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

    // 6. Refresh sidebar recent chars section
    await loadRecentCharacters();
    renderRecentCharsInSidebar();
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

function renderRecentCharsInSidebar() {
  const section = $("#recent-chars-section");
  const chipsEl = $("#recent-chars-chips");
  if (!section || !chipsEl) return;

  if (!_recentCharacters.length) {
    section.style.display = "none";
    return;
  }

  section.style.display = "flex";
  chipsEl.innerHTML = "";

  for (const rc of _recentCharacters) {
    const chip = document.createElement("button");
    chip.className = "tag-chip tag-chip--recent";
    chip.type = "button";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = rc.tag.replace(/_/g, " ");

    const countSpan = document.createElement("span");
    countSpan.className = "tag-chip-count";
    countSpan.textContent = `\u00d7${rc.count}`;

    chip.appendChild(nameSpan);
    chip.appendChild(countSpan);

    chip.addEventListener("click", () => {
      // Insert into whichever textarea is active — character slot or prompt
      const activeEl = document.activeElement;
      let targetEl = null;
      if (activeEl && (activeEl.classList.contains("char-slot-textarea") || activeEl === $("#prompt") || activeEl === $("#negative-prompt"))) {
        targetEl = activeEl;
      } else {
        targetEl = $("#prompt");
      }
      const tag = rc.tag.replace(/_/g, " ");
      const val = targetEl.value;
      const prefix = val.length > 0 && !val.trimEnd().endsWith(",") ? ", " : val.length > 0 ? " " : "";
      targetEl.value = val + prefix + tag;
      targetEl.dispatchEvent(new Event("input", { bubbles: true }));
      targetEl.focus();

      chip.classList.add("tag-chip--inserted");
      setTimeout(() => chip.classList.remove("tag-chip--inserted"), 300);
    });

    chipsEl.appendChild(chip);
  }
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
  const panelCanvas = $("#panel-canvas");
  const panelHistory = $("#panel-history");
  const panelStory = $("#panel-story");
  const searchWrap = $("#history-search-wrap");
  const searchInput = $("#gallery-search");

  _settingsLoadedToast = document.createElement("div");
  _settingsLoadedToast.className = "settings-loaded-toast";
  _settingsLoadedToast.textContent = "Settings loaded — ready to iterate";
  document.body.appendChild(_settingsLoadedToast);

  function showCanvas() {
    tabCanvas.classList.add("canvas-tab--active");
    tabHistory.classList.remove("canvas-tab--active");
    if (tabStory) tabStory.classList.remove("canvas-tab--active");
    panelCanvas.style.display = "flex";
    panelHistory.style.display = "none";
    if (panelStory) panelStory.style.display = "none";
    searchWrap.style.display = "none";
  }

  function showHistory() {
    tabHistory.classList.add("canvas-tab--active");
    tabCanvas.classList.remove("canvas-tab--active");
    if (tabStory) tabStory.classList.remove("canvas-tab--active");
    panelHistory.style.display = "flex";
    panelCanvas.style.display = "none";
    if (panelStory) panelStory.style.display = "none";
    searchWrap.style.display = "flex";
    searchInput.focus();
  }

  function showStory() {
    if (!tabStory || !panelStory) return;
    tabStory.classList.add("canvas-tab--active");
    tabCanvas.classList.remove("canvas-tab--active");
    tabHistory.classList.remove("canvas-tab--active");
    panelStory.style.display = "flex";
    panelCanvas.style.display = "none";
    panelHistory.style.display = "none";
    searchWrap.style.display = "none";
  }

  tabCanvas.addEventListener("click", showCanvas);
  tabHistory.addEventListener("click", showHistory);
  if (tabStory) tabStory.addEventListener("click", showStory);

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

    const img = document.createElement("img");
    img.className = "history-card-img";
    img.src = galleryFileUrl(file.name);
    img.alt = file.name;
    img.loading = "lazy";
    imgWrap.appendChild(img);

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

let _storyBlocks = [];
let _storyFocusedBlockId = null;
let _storySaveTimer = null;

function storyUUID() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function storySave() {
  clearTimeout(_storySaveTimer);
  _storySaveTimer = setTimeout(() => {
    try {
      localStorage.setItem("nai-story", JSON.stringify(_storyBlocks));
    } catch (_) { /* quota */ }
  }, 500);
}

function storyWordCount() {
  let words = 0;
  for (const block of _storyBlocks) {
    if (block.type === "text" && block.content) {
      const trimmed = block.content.trim();
      if (trimmed) words += trimmed.split(/\s+/).length;
    }
  }
  return words;
}

function renderStoryWordCount() {
  const el = $("#story-word-count");
  if (!el) return;
  const w = storyWordCount();
  el.textContent = w > 0 ? `${w} word${w === 1 ? "" : "s"}` : "";
}

function renderStoryBlocks() {
  const container = $("#story-blocks");
  if (!container) return;

  // Remember which textarea had focus by block id
  const activeId = _storyFocusedBlockId;

  container.innerHTML = "";

  const makeInsertZone = (insertIndex) => {
    const zone = document.createElement("div");
    zone.className = "story-insert-zone";
    zone.setAttribute("aria-hidden", "true");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "story-insert-btn";
    btn.title = "Insert text block here";
    btn.textContent = "+";
    btn.addEventListener("click", () => {
      const newBlock = { id: storyUUID(), type: "text", content: "" };
      _storyBlocks.splice(insertIndex, 0, newBlock);
      _storyFocusedBlockId = newBlock.id;
      storySave();
      renderStoryBlocks();
    });
    zone.appendChild(btn);
    return zone;
  };

  for (let i = 0; i < _storyBlocks.length; i++) {
    const block = _storyBlocks[i];

    // Insert zone before each block
    container.appendChild(makeInsertZone(i));

    const blockEl = document.createElement("div");

    if (block.type === "text") {
      blockEl.className = "story-block story-block--text";

      const ta = document.createElement("textarea");
      ta.value = block.content || "";
      ta.placeholder = "Write your story…";
      ta.spellcheck = true;
      ta.rows = 1;

      // Auto-resize
      const resize = () => {
        ta.style.height = "auto";
        ta.style.height = ta.scrollHeight + "px";
      };
      // Schedule resize after insertion so DOM is live
      requestAnimationFrame(resize);

      ta.addEventListener("input", () => {
        block.content = ta.value;
        resize();
        renderStoryWordCount();
        storySave();
      });
      ta.addEventListener("focus", () => {
        _storyFocusedBlockId = block.id;
      });

      blockEl.appendChild(ta);

      // AI Write button
      const aiBtn = document.createElement("button");
      aiBtn.type = "button";
      aiBtn.className = "story-ai-write-btn";
      aiBtn.textContent = "AI Write";
      aiBtn.addEventListener("click", async () => {
        // Collect context: all text blocks up to and including this one
        const blockIndex = _storyBlocks.indexOf(block);
        // Build context: Memory + story text + Author's Note
        const memory = ($("#story-memory") || {}).value || "";
        const authorsNote = ($("#story-authors-note") || {}).value || "";
        const storyText = _storyBlocks
          .slice(0, blockIndex + 1)
          .filter((b) => b.type === "text")
          .map((b) => b.content)
          .join("\n\n");

        // Context structure: [Memory]\n\n[Story Text...]\n\n[Author's Note]
        const parts = [];
        if (memory.trim()) parts.push(memory.trim());
        parts.push(storyText);
        if (authorsNote.trim()) parts.push(authorsNote.trim());
        const context = parts.join("\n\n");

        const maxTokens = parseInt(($("#story-max-tokens") || {}).value) || 150;
        const temperature = parseFloat(($("#story-temperature") || {}).value) || 1.0;

        aiBtn.disabled = true;
        aiBtn.classList.add("story-ai-write-btn--loading");
        const originalText = aiBtn.textContent;
        aiBtn.textContent = "Writing";

        try {
          const res = await fetch("/api/generate-text", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ context, model: "glm-4-6", max_length: maxTokens, temperature }),
          });
          if (!res.ok) throw new Error(`Server error ${res.status}`);
          const data = await res.json();
          const generated = data.text || "";
          if (generated) {
            block.content = block.content
              ? block.content + (block.content.endsWith(" ") ? "" : " ") + generated
              : generated;
            ta.value = block.content;
            resize();
            renderStoryWordCount();
            storySave();
          }
        } catch (err) {
          // Show inline error below the textarea, auto-dismiss after 4s
          const errEl = document.createElement("div");
          errEl.className = "story-ai-error";
          errEl.textContent = err.message || "AI Write failed";
          blockEl.appendChild(errEl);
          setTimeout(() => {
            if (errEl.parentNode) errEl.parentNode.removeChild(errEl);
          }, 4000);
        } finally {
          aiBtn.disabled = false;
          aiBtn.classList.remove("story-ai-write-btn--loading");
          aiBtn.textContent = originalText;
        }
      });
      blockEl.appendChild(aiBtn);

      // Restore focus
      if (activeId === block.id) {
        requestAnimationFrame(() => ta.focus());
      }

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

    container.appendChild(blockEl);
  }

  // Terminal insert zone (after all blocks)
  container.appendChild(makeInsertZone(_storyBlocks.length));

  renderStoryWordCount();
}

function setupStoryEditor() {
  // Load persisted story
  try {
    const raw = localStorage.getItem("nai-story");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        _storyBlocks = parsed;
      }
    }
  } catch (_) { /* malformed — start fresh */ }

  // Ensure at least one text block
  if (_storyBlocks.length === 0) {
    _storyBlocks.push({ id: storyUUID(), type: "text", content: "" });
  }

  renderStoryBlocks();

  // "Add Text" button at the bottom
  const addTextBtn = $("#story-add-text");
  if (addTextBtn) {
    addTextBtn.addEventListener("click", () => {
      const newBlock = { id: storyUUID(), type: "text", content: "" };
      _storyBlocks.push(newBlock);
      _storyFocusedBlockId = newBlock.id;
      storySave();
      renderStoryBlocks();
      // Scroll new block into view
      requestAnimationFrame(() => {
        const panel = $("#panel-story");
        if (panel) panel.scrollTop = panel.scrollHeight;
      });
    });
  }

  // "Insert Last Image" button
  const insertImgBtn = $("#story-insert-img");
  if (insertImgBtn) {
    insertImgBtn.addEventListener("click", () => {
      if (!state.lastImageBase64) return;
      const prompt = $("#prompt") ? $("#prompt").value : "";
      const newBlock = {
        id: storyUUID(),
        type: "image",
        base64: state.lastImageBase64,
        prompt,
        seed: state.lastSeed,
      };

      // Insert after the currently focused text block, or at end
      let insertIndex = _storyBlocks.length;
      if (_storyFocusedBlockId) {
        const idx = _storyBlocks.findIndex((b) => b.id === _storyFocusedBlockId);
        if (idx !== -1) insertIndex = idx + 1;
      }

      _storyBlocks.splice(insertIndex, 0, newBlock);
      storySave();
      renderStoryBlocks();

      // Scroll newly inserted image into view
      requestAnimationFrame(() => {
        const blocks = document.querySelectorAll(".story-block--image");
        if (blocks.length) blocks[blocks.length - 1].scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });
  }

  // ── Settings toggle ──────────────────────────────────────
  const settingsBtn = $("#story-toggle-settings");
  const settingsPanel = $("#story-settings");
  if (settingsBtn && settingsPanel) {
    settingsBtn.addEventListener("click", () => {
      const visible = settingsPanel.style.display !== "none";
      settingsPanel.style.display = visible ? "none" : "";
      settingsBtn.classList.toggle("active", !visible);
    });
  }

  // ── Persist Memory & Author's Note ──────────────────────
  const memoryEl = $("#story-memory");
  const authorsNoteEl = $("#story-authors-note");
  const tempEl = $("#story-temperature");
  const tempValEl = $("#story-temperature-val");
  const maxTokEl = $("#story-max-tokens");
  const maxTokValEl = $("#story-max-tokens-val");

  // Load saved settings
  try {
    const savedSettings = JSON.parse(localStorage.getItem("nai-story-settings") || "{}");
    if (savedSettings.memory && memoryEl) memoryEl.value = savedSettings.memory;
    if (savedSettings.authorsNote && authorsNoteEl) authorsNoteEl.value = savedSettings.authorsNote;
    if (savedSettings.temperature && tempEl) { tempEl.value = savedSettings.temperature; if (tempValEl) tempValEl.textContent = parseFloat(savedSettings.temperature).toFixed(2); }
    if (savedSettings.maxTokens && maxTokEl) { maxTokEl.value = savedSettings.maxTokens; if (maxTokValEl) maxTokValEl.textContent = savedSettings.maxTokens; }
  } catch (_) {}

  function saveStorySettings() {
    try {
      localStorage.setItem("nai-story-settings", JSON.stringify({
        memory: memoryEl ? memoryEl.value : "",
        authorsNote: authorsNoteEl ? authorsNoteEl.value : "",
        temperature: tempEl ? tempEl.value : "1.0",
        maxTokens: maxTokEl ? maxTokEl.value : "150",
      }));
    } catch (_) {}
  }

  if (memoryEl) memoryEl.addEventListener("input", saveStorySettings);
  if (authorsNoteEl) authorsNoteEl.addEventListener("input", saveStorySettings);
  if (tempEl) tempEl.addEventListener("input", () => { if (tempValEl) tempValEl.textContent = parseFloat(tempEl.value).toFixed(2); saveStorySettings(); });
  if (maxTokEl) maxTokEl.addEventListener("input", () => { if (maxTokValEl) maxTokValEl.textContent = maxTokEl.value; saveStorySettings(); });
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
    if (e.key === "Enter" && !$("#tag-dropdown").classList.contains("visible")) {
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
