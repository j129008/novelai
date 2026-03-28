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
      renderLayerStrip();
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
