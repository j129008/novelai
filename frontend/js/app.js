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
};

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
  } catch (e) {
    showError(`Failed to load options: ${e.message}`);
  }

  bindSlider("steps", "steps-val", 0);
  bindSlider("scale", "scale-val", 1);
  bindSlider("strength", "strength-val", 2);
  bindSlider("noise", "noise-val", 2);
  bindSlider("ref-strength", "ref-strength-val", 2);
  bindSlider("ref-info", "ref-info-val", 2);

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
  $("#btn-inpaint").addEventListener("click", openInpaintMode);
  $("#btn-random-seed").addEventListener("click", () => { $("#seed").value = 0; });
  $("#btn-reuse-seed").addEventListener("click", reuseSeed);
  $("#btn-download").addEventListener("click", downloadImage);

  setupGuide();
  setupSettings();

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
   TAG AUTOCOMPLETE
   ═══════════════════════════════════════════════════════════ */

function setupTagAutocomplete() {
  const prompt = $("#prompt");
  const negative = $("#negative-prompt");
  const dropdown = $("#tag-dropdown");
  if (!prompt || !dropdown) return;

  let selectedIdx = -1;
  let debounceTimer = null;
  let activeTextarea = prompt;

  prompt.addEventListener("focus", () => { activeTextarea = prompt; });
  negative.addEventListener("focus", () => { activeTextarea = negative; });

  function getWordAtCursor(textarea) {
    const val = textarea.value;
    const cursor = textarea.selectionStart;
    let start = val.lastIndexOf(",", cursor - 1) + 1;
    while (start < cursor && val[start] === " ") start++;
    const word = val.slice(start, cursor).trim();
    return { word, start, end: cursor };
  }

  async function fetchTags(query) {
    if (query.length < 2) { hideDropdown(); return; }
    try {
      const resp = await fetch(`/api/tags?q=${encodeURIComponent(query)}`);
      if (!resp.ok) return;
      const tags = await resp.json();
      showDropdown(tags, query);
    } catch { /* ignore */ }
  }

  function showDropdown(tags, query) {
    if (!tags.length) { hideDropdown(); return; }
    selectedIdx = -1;
    const q = query.toLowerCase();
    dropdown.innerHTML = "";
    tags.forEach((tag, i) => {
      const item = document.createElement("div");
      item.className = "tag-item";
      item.dataset.index = i;

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
        insertTag(tag.name);
      });

      dropdown.appendChild(item);
    });
    dropdown.classList.add("visible");
  }

  function hideDropdown() {
    dropdown.classList.remove("visible");
    selectedIdx = -1;
  }

  function insertTag(tagName) {
    const textarea = activeTextarea;
    const { start, end } = getWordAtCursor(textarea);
    const val = textarea.value;
    const before = val.slice(0, start);
    const after = val.slice(end);
    const tag = tagName.replace(/_/g, " ");
    const needsComma = before.length > 0 && !before.trimEnd().endsWith(",");
    const insert = (needsComma ? ", " : "") + tag + ", ";
    textarea.value = before + insert + after;
    const newPos = before.length + insert.length;
    textarea.selectionStart = textarea.selectionEnd = newPos;
    textarea.focus();
    hideDropdown();
  }

  function formatCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(0) + "k";
    return String(n);
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function handleInput(e) {
    clearTimeout(debounceTimer);
    const { word } = getWordAtCursor(e.target);
    debounceTimer = setTimeout(() => fetchTags(word), 150);
  }

  function handleKeydown(e) {
    if (!dropdown.classList.contains("visible")) return;
    const items = dropdown.querySelectorAll(".tag-item");
    if (!items.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
      updateSelection(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      updateSelection(items);
    } else if (e.key === "Tab" || e.key === "Enter") {
      if (selectedIdx >= 0) {
        e.preventDefault();
        const name = items[selectedIdx].querySelector(".tag-item-name").textContent;
        insertTag(name.replace(/ /g, "_"));
      }
    } else if (e.key === "Escape") {
      hideDropdown();
    }
  }

  function updateSelection(items) {
    items.forEach((el, i) => el.classList.toggle("selected", i === selectedIdx));
    if (selectedIdx >= 0) items[selectedIdx].scrollIntoView({ block: "nearest" });
  }

  prompt.addEventListener("input", handleInput);
  negative.addEventListener("input", handleInput);
  prompt.addEventListener("keydown", handleKeydown);
  negative.addEventListener("keydown", handleKeydown);
  prompt.addEventListener("blur", () => setTimeout(hideDropdown, 150));
  negative.addEventListener("blur", () => setTimeout(hideDropdown, 150));
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

async function generate() {
  const btn = $("#generate-btn");
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
    // Use regex to find the last non-whitespace position before | (or end)
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

  try {
    const resp = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || "Generation failed");
    }

    const data = await resp.json();
    state.lastSeed = data.seed;
    state.lastImageBase64 = data.image;

    const output = $("#output");
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${data.image}`;
    img.alt = "Generated image";
    output.innerHTML = "";
    output.appendChild(img);

    const actions = $("#image-actions");
    actions.style.display = "flex";
    $("#info-seed").textContent = `Seed: ${data.seed}`;

    loadGallery();
  } catch (e) {
    console.error("Generate error:", e);
    showError(e.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
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

/* ═══════════════════════════════════════════════════════════
   INPAINT
   ═══════════════════════════════════════════════════════════ */

const inpaint = {
  sourceImg: null,
  maskCanvas: null,
  painting: false,
  lastX: 0,
  lastY: 0,
};

function openInpaintMode() {
  if (!state.lastImageBase64) return;

  const overlay = $("#inpaint-overlay");
  if (!overlay) return;

  // Load source image
  const img = new Image();
  img.onload = () => {
    inpaint.sourceImg = img;
    overlay.style.display = "flex";

    const resLabel = $("#inpaint-resolution-label");
    if (resLabel) resLabel.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => initInpaintCanvas());
    });
  };
  img.src = `data:image/png;base64,${state.lastImageBase64}`;
}

function initInpaintCanvas() {
  const canvasEl = $("#inpaint-canvas");
  if (!canvasEl || !inpaint.sourceImg) return;

  const stageWrap = canvasEl.parentElement;
  const rect = stageWrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  canvasEl.width = rect.width * dpr;
  canvasEl.height = rect.height * dpr;
  canvasEl.style.width = rect.width + "px";
  canvasEl.style.height = rect.height + "px";

  // Create offscreen mask canvas at image resolution
  inpaint.maskCanvas = document.createElement("canvas");
  inpaint.maskCanvas.width = inpaint.sourceImg.naturalWidth;
  inpaint.maskCanvas.height = inpaint.sourceImg.naturalHeight;
  const maskCtx = inpaint.maskCanvas.getContext("2d");
  maskCtx.fillStyle = "black";
  maskCtx.fillRect(0, 0, inpaint.maskCanvas.width, inpaint.maskCanvas.height);

  renderInpaintCanvas();
  setupInpaintInteraction();
}

function renderInpaintCanvas() {
  const canvasEl = $("#inpaint-canvas");
  if (!canvasEl || !inpaint.sourceImg) return;

  const dpr = window.devicePixelRatio || 1;
  const ctx = canvasEl.getContext("2d");
  const W = canvasEl.width;
  const H = canvasEl.height;
  const screenW = W / dpr;
  const screenH = H / dpr;

  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.scale(dpr, dpr);

  // Fit image to stage
  const img = inpaint.sourceImg;
  const scale = Math.min(screenW / img.naturalWidth, screenH / img.naturalHeight);
  const drawW = img.naturalWidth * scale;
  const drawH = img.naturalHeight * scale;
  const drawX = (screenW - drawW) / 2;
  const drawY = (screenH - drawH) / 2;

  // Draw source image
  ctx.drawImage(img, drawX, drawY, drawW, drawH);

  // Draw mask overlay (semi-transparent red)
  if (inpaint.maskCanvas) {
    ctx.globalAlpha = 0.45;
    ctx.globalCompositeOperation = "source-atop";
    // We need to draw only the white parts of the mask as red
    // Create a temp canvas for the colored mask
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = inpaint.maskCanvas.width;
    tempCanvas.height = inpaint.maskCanvas.height;
    const tempCtx = tempCanvas.getContext("2d");
    tempCtx.drawImage(inpaint.maskCanvas, 0, 0);
    tempCtx.globalCompositeOperation = "source-in";
    tempCtx.fillStyle = "#ff4444";
    tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 0.45;
    ctx.drawImage(tempCanvas, drawX, drawY, drawW, drawH);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

function setupInpaintInteraction() {
  const canvasEl = $("#inpaint-canvas");
  const brushSlider = $("#inpaint-brush");
  const brushVal = $("#inpaint-brush-val");
  const clearBtn = $("#inpaint-clear-mask");
  const confirmBtn = $("#inpaint-confirm");
  const cancelBtn = $("#inpaint-cancel");

  if (brushSlider && brushVal) {
    brushVal.textContent = brushSlider.value;
    brushSlider.addEventListener("input", () => {
      brushVal.textContent = brushSlider.value;
    });
  }

  function getImageCoords(e) {
    const rect = canvasEl.getBoundingClientRect();
    const screenW = rect.width;
    const screenH = rect.height;
    const img = inpaint.sourceImg;
    const scale = Math.min(screenW / img.naturalWidth, screenH / img.naturalHeight);
    const drawW = img.naturalWidth * scale;
    const drawH = img.naturalHeight * scale;
    const drawX = (screenW - drawW) / 2;
    const drawY = (screenH - drawH) / 2;

    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    return {
      x: (sx - drawX) / scale,
      y: (sy - drawY) / scale,
      brushR: parseInt(brushSlider.value) / 2,
    };
  }

  function paintMask(x, y, brushR) {
    if (!inpaint.maskCanvas) return;
    const ctx = inpaint.maskCanvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.arc(x, y, brushR, 0, Math.PI * 2);
    ctx.fill();
  }

  function paintLine(x1, y1, x2, y2, brushR) {
    if (!inpaint.maskCanvas) return;
    const ctx = inpaint.maskCanvas.getContext("2d");
    ctx.strokeStyle = "white";
    ctx.lineWidth = brushR * 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  canvasEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    inpaint.painting = true;
    const { x, y, brushR } = getImageCoords(e);
    inpaint.lastX = x;
    inpaint.lastY = y;
    paintMask(x, y, brushR);
    renderInpaintCanvas();
    canvasEl.setPointerCapture(e.pointerId);
  });

  canvasEl.addEventListener("pointermove", (e) => {
    if (!inpaint.painting) return;
    const { x, y, brushR } = getImageCoords(e);
    paintLine(inpaint.lastX, inpaint.lastY, x, y, brushR);
    inpaint.lastX = x;
    inpaint.lastY = y;
    renderInpaintCanvas();
  });

  canvasEl.addEventListener("pointerup", () => { inpaint.painting = false; });
  canvasEl.addEventListener("pointercancel", () => { inpaint.painting = false; });

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (!inpaint.maskCanvas) return;
      const ctx = inpaint.maskCanvas.getContext("2d");
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, inpaint.maskCanvas.width, inpaint.maskCanvas.height);
      renderInpaintCanvas();
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      $("#inpaint-overlay").style.display = "none";
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener("click", confirmInpaint);
  }
}

async function confirmInpaint() {
  if (!inpaint.sourceImg || !inpaint.maskCanvas) return;

  const overlay = $("#inpaint-overlay");
  const confirmBtn = $("#inpaint-confirm");

  // Get mask as base64
  const maskDataUrl = inpaint.maskCanvas.toDataURL("image/png");
  const maskBase64 = maskDataUrl.split(",")[1];

  // Build request
  const prompt = $("#prompt").value.trim();
  if (!prompt) { showError("Please enter a prompt."); return; }

  const qualityTags = ", very aesthetic, masterpiece, no text";
  let finalPrompt = prompt;
  if ($("#quality-tags").checked) {
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
    width: inpaint.sourceImg.naturalWidth,
    height: inpaint.sourceImg.naturalHeight,
    steps: parseInt($("#steps").value),
    scale: parseFloat($("#scale").value),
    sampler: $("#sampler").value,
    seed: parseInt($("#seed").value) || 0,
    sm: false,
    sm_dyn: false,
    image: state.lastImageBase64,
    mask: maskBase64,
    strength: parseFloat($("#strength").value),
  };

  confirmBtn.textContent = "Generating...";
  confirmBtn.disabled = true;

  try {
    const resp = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || "Inpaint failed");
    }

    const data = await resp.json();
    state.lastSeed = data.seed;
    state.lastImageBase64 = data.image;

    const output = $("#output");
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${data.image}`;
    img.alt = "Inpainted image";
    output.innerHTML = "";
    output.appendChild(img);

    $("#image-actions").style.display = "flex";
    $("#info-seed").textContent = `Seed: ${data.seed}`;

    overlay.style.display = "none";
    loadGallery();
  } catch (e) {
    showError(e.message);
  } finally {
    confirmBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Generate Inpaint`;
    confirmBtn.disabled = false;
  }
}

/* ═══════════════════════════════════════════════════════════
   GALLERY
   ═══════════════════════════════════════════════════════════ */

let _galleryData = [];
let _settingsLoadedToast = null;

function setupHistoryTabs() {
  const tabCanvas = $("#tab-canvas");
  const tabHistory = $("#tab-history");
  const panelCanvas = $("#panel-canvas");
  const panelHistory = $("#panel-history");
  const searchWrap = $("#history-search-wrap");
  const searchInput = $("#gallery-search");

  _settingsLoadedToast = document.createElement("div");
  _settingsLoadedToast.className = "settings-loaded-toast";
  _settingsLoadedToast.textContent = "Settings loaded — ready to iterate";
  document.body.appendChild(_settingsLoadedToast);

  function showCanvas() {
    tabCanvas.classList.add("canvas-tab--active");
    tabHistory.classList.remove("canvas-tab--active");
    panelCanvas.style.display = "flex";
    panelHistory.style.display = "none";
    searchWrap.style.display = "none";
  }

  function showHistory() {
    tabHistory.classList.add("canvas-tab--active");
    tabCanvas.classList.remove("canvas-tab--active");
    panelHistory.style.display = "flex";
    panelCanvas.style.display = "none";
    searchWrap.style.display = "flex";
    searchInput.focus();
  }

  tabCanvas.addEventListener("click", showCanvas);
  tabHistory.addEventListener("click", showHistory);

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      renderGallery(_galleryData, searchInput.value.toLowerCase());
    });
  }
}

function showSettingsLoadedToast() {
  if (!_settingsLoadedToast) return;
  _settingsLoadedToast.classList.add("visible");
  setTimeout(() => _settingsLoadedToast.classList.remove("visible"), 2400);
}

async function loadGallery() {
  const list = $("#gallery-list");
  const empty = $("#gallery-empty");
  const count = $("#gallery-count");
  if (!list) return;

  try {
    const resp = await fetch("/api/gallery");
    if (!resp.ok) return;
    const files = await resp.json();

    _galleryData = files;
    if (count) {
      count.textContent = files.length || "";
      count.classList.toggle("visible", files.length > 0);
    }
    const searchVal = ($("#gallery-search")?.value || "").toLowerCase();
    renderGallery(files, searchVal);
  } catch { /* ignore */ }
}

function renderGallery(files, filter) {
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

  if (!filtered.length) {
    list.style.display = "none";
    empty.style.display = "block";
    empty.textContent = filter ? "No matching images" : "No saved images yet";
    return;
  }

  list.style.display = "grid";
  empty.style.display = "none";
  list.innerHTML = "";

  for (const file of filtered) {
    const meta = file.meta || {};
    const card = document.createElement("div");
    card.className = "history-card";

    const img = document.createElement("img");
    img.className = "history-card-img";
    img.src = `/api/gallery/${file.name}`;
    img.alt = file.name;
    img.loading = "lazy";

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
    if (meta.seed) metaEl.innerHTML += `<span>Seed ${meta.seed}</span>`;
    if (meta.steps) metaEl.innerHTML += `<span>${meta.steps} steps</span>`;
    if (meta.width) metaEl.innerHTML += `<span>${meta.width}\u00d7${meta.height}</span>`;
    overlay.appendChild(metaEl);

    const actionsEl = document.createElement("div");
    actionsEl.className = "history-card-actions";

    const loadBtn = document.createElement("button");
    loadBtn.className = "history-card-btn history-card-btn--load";
    loadBtn.type = "button";
    loadBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.84"/></svg> Load`;
    loadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      loadSettingsFromMeta(meta);
      card.classList.add("settings-loaded");
      setTimeout(() => card.classList.remove("settings-loaded"), 1800);
      showSettingsLoadedToast();
      $("#tab-canvas").click();
    });

    const delBtn = document.createElement("button");
    delBtn.className = "history-card-btn history-card-btn--delete";
    delBtn.type = "button";
    delBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg> Delete`;
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      card.style.opacity = "0.4";
      card.style.pointerEvents = "none";
      const r = await fetch(`/api/gallery/${file.name}`, { method: "DELETE" });
      if (r.ok) loadGallery();
      else { card.style.opacity = ""; card.style.pointerEvents = ""; }
    });

    actionsEl.appendChild(loadBtn);
    actionsEl.appendChild(delBtn);
    overlay.appendChild(actionsEl);

    card.addEventListener("click", () => {
      const output = $("#output");
      const previewImg = document.createElement("img");
      previewImg.src = `/api/gallery/${file.name}`;
      previewImg.alt = "Preview";
      output.innerHTML = "";
      output.appendChild(previewImg);
      $("#tab-canvas").click();
    });

    card.appendChild(img);
    card.appendChild(overlay);
    list.appendChild(card);
  }
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
    hd.checked = meta.sm || meta.sm_dyn;
    smea.checked = !!meta.sm;
    smeaDyn.checked = !!meta.sm_dyn;
  }
}

/* ═══════════════════════════════════════════════════════════
   ERROR
   ═══════════════════════════════════════════════════════════ */

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

init();
