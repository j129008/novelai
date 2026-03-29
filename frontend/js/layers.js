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
  // Don't touch #output when user is viewing the Output tab
  const showInOutput = _canvasView === "input";

  if (!hasVisibleLayer) {
    // If layers exist but none have images, show blank canvas (not old generated image)
    if (layers.length > 0 && layersEnabled && layersEnabled.checked) {
      state.canvasImageBase64 = null;
      if (output && showInOutput) {
        clearOutput(output);
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

  if (output && showInOutput) {
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${compositeBase64}`;
    img.alt = "Layer composite preview";
    clearOutput(output);
    output.appendChild(img);
    renderCharacterMarkers();

    const actions = $("#image-actions");
    if (actions) {
      actions.style.display = "flex";
      syncInpaintButtonVisibility();
    }
  }
  // Mark Input button as changed when composite updates while on Output view
  if (!showInOutput) _markInputChanged();

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

// Extract a reveal mask from a layer image's alpha channel.
// Non-transparent pixels → white (reveal), transparent → black (hide).
// Returns base64 mask, or null if the image is fully opaque (no useful mask).
async function _extractAlphaMask(imageBase64) {
  const img = new Image();
  await new Promise((resolve) => {
    img.onload = resolve;
    img.src = "data:image/png;base64," + imageBase64;
  });

  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h);
  const d = data.data;

  // Check if there are any transparent pixels — if fully opaque, no mask needed
  let hasTransparent = false;
  let hasOpaque = false;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 128) hasTransparent = true;
    else hasOpaque = true;
    if (hasTransparent && hasOpaque) break;
  }
  if (!hasTransparent || !hasOpaque) return null; // fully opaque or fully transparent

  // Build grayscale mask from alpha: opaque → white, transparent → black
  const mask = ctx.createImageData(w, h);
  const md = mask.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i + 3] > 128 ? 255 : 0;
    md[i] = md[i + 1] = md[i + 2] = v;
    md[i + 3] = 255;
  }
  ctx.putImageData(mask, 0, 0);

  // Dilate mask: heavy blur → re-threshold at low value to expand the reveal area.
  // This ensures generated content that extends beyond the exact brush strokes
  // isn't cut off. Uses two passes for a wide, smooth expansion.
  const expand = document.createElement("canvas");
  expand.width = w; expand.height = h;
  const eCtx = expand.getContext("2d");

  // Pass 1: large blur to spread the white area outward
  eCtx.filter = "blur(40px)";
  eCtx.drawImage(c, 0, 0);

  // Re-threshold: anything above ~10% becomes fully white → expands the mask
  const eData = eCtx.getImageData(0, 0, w, h);
  const ed = eData.data;
  for (let i = 0; i < ed.length; i += 4) {
    const v = ed[i];
    ed[i] = ed[i + 1] = ed[i + 2] = v > 25 ? 255 : 0;
    ed[i + 3] = 255;
  }
  eCtx.putImageData(eData, 0, 0);

  // Pass 2: soften the expanded edges for natural blending
  const blurred = document.createElement("canvas");
  blurred.width = w; blurred.height = h;
  const bCtx = blurred.getContext("2d");
  bCtx.filter = "blur(12px)";
  bCtx.drawImage(expand, 0, 0);

  return blurred.toDataURL("image/png").split(",")[1];
}

// Generate a reveal mask by comparing new output against the composite of all
// layers BELOW the target layer. Areas that differ → reveal, similar → hide.
async function _generateDiffMask(newImageBase64, targetLayer) {
  // Build composite of all visible layers except the target
  const resSel = document.getElementById("resolution");
  let w = 832, h = 1216;
  if (resSel && resSel.value) {
    const parts = resSel.value.split("x");
    if (parts.length === 2) {
      const pw = parseInt(parts[0], 10);
      const ph = parseInt(parts[1], 10);
      if (!isNaN(pw) && !isNaN(ph)) { w = pw; h = ph; }
    }
  }

  // Temporarily hide target layer to get background composite
  const origVisible = targetLayer.visible;
  const origImage = targetLayer.imageBase64;
  targetLayer.visible = false;
  const bgComposite = await compositeLayersToBase64(w, h);
  targetLayer.visible = origVisible;
  targetLayer.imageBase64 = origImage;

  if (!bgComposite) return null;

  // Load both images
  const loadImg = (b64) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = "data:image/png;base64," + b64;
  });
  const [bgImg, newImg] = await Promise.all([loadImg(bgComposite), loadImg(newImageBase64)]);

  // Draw both at target resolution
  const c1 = document.createElement("canvas");
  c1.width = w; c1.height = h;
  const ctx1 = c1.getContext("2d");
  ctx1.drawImage(bgImg, 0, 0, w, h);
  const bgData = ctx1.getImageData(0, 0, w, h).data;

  const c2 = document.createElement("canvas");
  c2.width = w; c2.height = h;
  const ctx2 = c2.getContext("2d");
  // Cover-fit the new image (same as compositing)
  const ar = newImg.naturalWidth / newImg.naturalHeight;
  const car = w / h;
  let sx, sy, sw, sh;
  if (ar > car) { sh = newImg.naturalHeight; sw = sh * car; sx = (newImg.naturalWidth - sw) / 2; sy = 0; }
  else { sw = newImg.naturalWidth; sh = sw / car; sx = 0; sy = (newImg.naturalHeight - sh) / 2; }
  ctx2.drawImage(newImg, sx, sy, sw, sh, 0, 0, w, h);
  const newData = ctx2.getImageData(0, 0, w, h).data;

  // Build difference mask
  const maskC = document.createElement("canvas");
  maskC.width = w; maskC.height = h;
  const mCtx = maskC.getContext("2d");
  const maskImg = mCtx.createImageData(w, h);
  const md = maskImg.data;

  const threshold = 30;
  let diffCount = 0;
  for (let i = 0; i < bgData.length; i += 4) {
    const dr = Math.abs(bgData[i] - newData[i]);
    const dg = Math.abs(bgData[i + 1] - newData[i + 1]);
    const db = Math.abs(bgData[i + 2] - newData[i + 2]);
    const diff = Math.max(dr, dg, db);
    const v = diff > threshold ? 255 : 0;
    md[i] = md[i + 1] = md[i + 2] = v;
    md[i + 3] = 255;
    if (v) diffCount++;
  }
  mCtx.putImageData(maskImg, 0, 0);

  const totalPixels = w * h;
  // If almost everything changed (>85%) or almost nothing (<3%), no useful mask
  if (diffCount / totalPixels > 0.85 || diffCount / totalPixels < 0.03) return null;

  // Dilate: blur → re-threshold → soften edges (same as _extractAlphaMask)
  const expand = document.createElement("canvas");
  expand.width = w; expand.height = h;
  const eCtx = expand.getContext("2d");
  eCtx.filter = "blur(40px)";
  eCtx.drawImage(maskC, 0, 0);

  const eData = eCtx.getImageData(0, 0, w, h);
  const ed = eData.data;
  for (let i = 0; i < ed.length; i += 4) {
    ed[i] = ed[i + 1] = ed[i + 2] = ed[i] > 25 ? 255 : 0;
    ed[i + 3] = 255;
  }
  eCtx.putImageData(eData, 0, 0);

  const blurred = document.createElement("canvas");
  blurred.width = w; blurred.height = h;
  const bCtx = blurred.getContext("2d");
  bCtx.filter = "blur(12px)";
  bCtx.drawImage(expand, 0, 0);

  return blurred.toDataURL("image/png").split(",")[1];
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
    renderLayerStrip();
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
  renderLayerStrip();
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

/* ═══════════════════════════════════════════════════════════
   LAYER STRIP — horizontal thumbnail row below canvas
   ═══════════════════════════════════════════════════════════ */

function renderLayerStrip() {
  // Render layer tabs (paper-edge style on right side of canvas)
  const tabsList = document.getElementById("layer-tabs-list");
  const tabsWrap = document.getElementById("layer-tabs");
  const provider = document.getElementById("provider")?.value || "novelai";

  // Also handle legacy strip element
  const legacyStrip = document.getElementById("layer-strip");
  if (legacyStrip) legacyStrip.style.display = "none";

  if (!tabsList || !tabsWrap) return;

  if (provider !== "novelai") {
    tabsWrap.style.display = "none";
    const panel = document.getElementById("layer-tab-panel");
    if (panel) panel.style.display = "none";
    return;
  }

  tabsWrap.style.display = "";
  tabsList.innerHTML = "";

  if (layers.length === 0) {
    const panel = document.getElementById("layer-tab-panel");
    if (panel) panel.style.display = "none";
    return;
  }

  // Clamp active index
  if (layers.length > 0) {
    if (_activeLayerIdx >= layers.length) _activeLayerIdx = layers.length - 1;
    if (_activeLayerIdx < 0) _activeLayerIdx = 0;
  }

  // Build a tab for each layer
  layers.forEach((layer, idx) => {
    const tab = document.createElement("div");
    tab.className = "layer-tab" +
      (idx === _activeLayerIdx ? " layer-tab--active" : "") +
      (!layer.visible ? " layer-tab--hidden" : "") +
      (layer.isOutputTarget ? " layer-tab--target" : "");
    tab.title = layer.name;
    tab.setAttribute("role", "button");
    tab.tabIndex = 0;

    // Dot for output target
    const dot = document.createElement("span");
    dot.className = "layer-tab-dot";
    tab.appendChild(dot);

    // Tab label — short stable identifier from layer name
    const label = document.createElement("span");
    label.className = "layer-tab-label";
    // Extract a short label: "Layer 2" → "L2", "Output" → "O", "BG" → "BG"
    const nameMatch = layer.name.match(/^(\w)\w*\s*(\d*)$/);
    label.textContent = nameMatch
      ? (nameMatch[1] + nameMatch[2]).toUpperCase()
      : layer.name.slice(0, 2).toUpperCase();
    tab.appendChild(label);

    // Colored strip + hover preview for layers with images
    if (layer.imageBase64) {
      tab.classList.add("layer-tab--has-image");
      const preview = document.createElement("div");
      preview.className = "layer-tab-preview";
      preview.innerHTML =
        '<img src="data:image/png;base64,' + layer.imageBase64 + '" alt="' + layer.name + '">' +
        '<div class="layer-tab-preview-name">' + layer.name + '</div>';
      tab.appendChild(preview);
    }

    // Pointer-based drag-to-reorder + click detection
    let _ptrDown = false, _ptrMoved = false, _ptrStartY = 0;
    tab.addEventListener("pointerdown", (e) => {
      _ptrDown = true;
      _ptrMoved = false;
      _ptrStartY = e.clientY;
      tab.setPointerCapture(e.pointerId);
    });
    tab.addEventListener("pointermove", (e) => {
      if (!_ptrDown) return;
      if (Math.abs(e.clientY - _ptrStartY) > 4) _ptrMoved = true;
      if (!_ptrMoved) return;
      // Add dragging class on first move
      if (!tab.classList.contains("layer-tab--dragging")) {
        tab.classList.add("layer-tab--dragging");
      }
      // Find which tab we're over
      const tabs = Array.from(tabsList.querySelectorAll(".layer-tab"));
      tabs.forEach(t => t.classList.remove("layer-tab--drag-over"));
      for (const t of tabs) {
        if (t === tab) continue;
        const r = t.getBoundingClientRect();
        if (e.clientY >= r.top && e.clientY <= r.bottom) {
          t.classList.add("layer-tab--drag-over");
          break;
        }
      }
    });
    const _cleanupDrag = () => {
      _ptrDown = false;
      tab.classList.remove("layer-tab--dragging");
      tabsList.querySelectorAll(".layer-tab--drag-over").forEach(t => t.classList.remove("layer-tab--drag-over"));
    };
    tab.addEventListener("pointerup", (e) => {
      if (!_ptrDown) return;
      tab.releasePointerCapture(e.pointerId);

      if (_ptrMoved) {
        // Find drop target
        const tabs = Array.from(tabsList.querySelectorAll(".layer-tab"));
        for (let ti = 0; ti < tabs.length; ti++) {
          if (tabs[ti] === tab) continue;
          const r = tabs[ti].getBoundingClientRect();
          if (e.clientY >= r.top && e.clientY <= r.bottom) {
            const fromIdx = idx;
            const toIdx = ti;
            _cleanupDrag();
            if (fromIdx !== toIdx) {
              pushLayerUndo("Reorder layers");
              const [moved] = layers.splice(fromIdx, 1);
              layers.splice(toIdx, 0, moved);
              _activeLayerIdx = toIdx;
              renderLayerList();
              saveLayersToStorage();
              refreshCompositePreview();
            }
            return;
          }
        }
        _cleanupDrag();
      } else {
        _cleanupDrag();
        // Click (no drag) — select + toggle panel
        const wasActive = _activeLayerIdx === idx;
        _activeLayerIdx = idx;
        tabsList.querySelectorAll(".layer-tab").forEach((t, i) => {
          t.classList.toggle("layer-tab--active", i === _activeLayerIdx);
        });
        const panel = document.getElementById("layer-tab-panel");
        if (wasActive && panel && panel.style.display !== "none") {
          panel.style.display = "none";
        } else {
          openLayerTabPanel(idx, tab);
        }
      }
    });
    tab.addEventListener("pointercancel", _cleanupDrag);

    tabsList.appendChild(tab);
  });

  // Keep panel in sync if open
  const panel = document.getElementById("layer-tab-panel");
  if (panel && panel.style.display !== "none" && _activeLayerIdx >= 0 && _activeLayerIdx < layers.length) {
    const activeTab = tabsList.children[_activeLayerIdx];
    if (activeTab) openLayerTabPanel(_activeLayerIdx, activeTab);
  }
}

// Open the floating panel next to a tab
function openLayerTabPanel(idx, tabEl) {
  const panel = document.getElementById("layer-tab-panel");
  if (!panel || idx < 0 || idx >= layers.length) return;
  // Reuse setupLayerStripControls to populate (it writes to #layer-strip-controls or #layer-tab-panel)
  panel.style.display = "flex";
  // Position next to the tab
  const panelParent = panel.parentElement;
  if (panelParent && tabEl) {
    const pRect = panelParent.getBoundingClientRect();
    const tRect = tabEl.getBoundingClientRect();
    panel.style.top = Math.max(8, tRect.top - pRect.top - 20) + "px";
  }
  // Populate controls into the panel
  _populateLayerPanel(panel, idx);
}

function _populateLayerPanel(container, idx) {
  container.innerHTML = "";
  if (idx < 0 || idx >= layers.length) return;
  const layer = layers[idx];

  // Header: name + close
  const header = document.createElement("div");
  header.className = "ltp-header";
  const nameInput = document.createElement("input");
  nameInput.className = "ltp-name";
  nameInput.type = "text";
  nameInput.value = layer.name;
  nameInput.addEventListener("change", () => {
    layer.name = nameInput.value.trim() || layer.name;
    saveLayersToStorage();
    renderLayerStrip();
  });
  const closeBtn = document.createElement("button");
  closeBtn.className = "ltp-close";
  closeBtn.type = "button";
  closeBtn.textContent = "\u00d7";
  closeBtn.addEventListener("click", () => { container.style.display = "none"; });
  header.appendChild(nameInput);
  header.appendChild(closeBtn);
  container.appendChild(header);

  // Visibility + Target row
  const toggleRow = document.createElement("div");
  toggleRow.className = "ltp-actions";
  const eyeBtn = document.createElement("button");
  eyeBtn.className = "ltp-btn" + (layer.visible ? " ltp-btn--active" : "");
  eyeBtn.textContent = layer.visible ? "Visible" : "Hidden";
  eyeBtn.addEventListener("click", () => {
    pushLayerUndo("Toggle visibility");
    layer.visible = !layer.visible;
    saveLayersToStorage();
    refreshCompositePreview();
    renderLayerStrip();
  });
  const targetBtn = document.createElement("button");
  targetBtn.className = "ltp-btn" + (layer.isOutputTarget ? " ltp-btn--active" : "");
  targetBtn.textContent = "Target";
  targetBtn.addEventListener("click", () => {
    pushLayerUndo("Toggle output target");
    const was = layer.isOutputTarget;
    layers.forEach(l => { l.isOutputTarget = false; });
    layer.isOutputTarget = !was;
    saveLayersToStorage();
    renderLayerStrip();
  });
  toggleRow.appendChild(eyeBtn);
  toggleRow.appendChild(targetBtn);
  container.appendChild(toggleRow);

  // Opacity
  const opRow = document.createElement("div");
  opRow.className = "ltp-row";
  const opLabel = document.createElement("span");
  opLabel.className = "ltp-label";
  opLabel.textContent = "Opacity";
  const opSlider = document.createElement("input");
  opSlider.type = "range"; opSlider.className = "ltp-slider";
  opSlider.min = "0"; opSlider.max = "1"; opSlider.step = "0.05"; opSlider.value = String(layer.opacity);
  const opVal = document.createElement("span");
  opVal.className = "ltp-val";
  opVal.textContent = Math.round(layer.opacity * 100) + "%";
  opSlider.addEventListener("input", () => {
    layer.opacity = parseFloat(opSlider.value);
    opVal.textContent = Math.round(layer.opacity * 100) + "%";
    saveLayersToStorage();
    clearTimeout(_previewDebounceTimer);
    _previewDebounceTimer = setTimeout(refreshCompositePreview, 50);
  });
  opRow.appendChild(opLabel); opRow.appendChild(opSlider); opRow.appendChild(opVal);
  container.appendChild(opRow);

  // Scale
  const scRow = document.createElement("div");
  scRow.className = "ltp-row";
  const scLabel = document.createElement("span");
  scLabel.className = "ltp-label";
  scLabel.textContent = "Scale";
  const scSlider = document.createElement("input");
  scSlider.type = "range"; scSlider.className = "ltp-slider";
  scSlider.min = "0.25"; scSlider.max = "4"; scSlider.step = "0.05";
  scSlider.value = String(layer.scale !== undefined ? layer.scale : 1.0);
  const scVal = document.createElement("span");
  scVal.className = "ltp-val";
  scVal.textContent = Math.round((layer.scale || 1) * 100) + "%";
  scSlider.addEventListener("input", () => {
    layer.scale = parseFloat(scSlider.value);
    scVal.textContent = Math.round(layer.scale * 100) + "%";
    saveLayersToStorage();
    clearTimeout(_previewDebounceTimer);
    _previewDebounceTimer = setTimeout(refreshCompositePreview, 50);
  });
  scRow.appendChild(scLabel); scRow.appendChild(scSlider); scRow.appendChild(scVal);
  container.appendChild(scRow);

  // Tool actions
  const tools = document.createElement("div");
  tools.className = "ltp-actions";
  function addTool(label, fn, isDanger) {
    const btn = document.createElement("button");
    btn.className = "ltp-btn" + (isDanger ? " ltp-btn--danger" : "");
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", fn);
    tools.appendChild(btn);
  }
  addTool("Move", () => {
    if (_movingLayer === layer) { _movingLayer = null; _disableCanvasMove(); }
    else { _movingLayer = layer; _enableCanvasMove(layer); }
    _populateLayerPanel(container, idx);
  });
  addTool("Draw", () => {
    enterLayerEditMode(layer, "draw", () => {
      refreshCompositePreview(); saveLayersToStorage(); renderLayerStrip();
    });
  });
  addTool("Mask", () => {
    pushLayerUndo("Edit visibility mask");
    enterLayerEditMode(layer, "mask", () => { refreshCompositePreview(); saveLayersToStorage(); });
  });
  if (layer.imageBase64) {
    addTool("Inpaint", () => {
      pushLayerUndo("Edit inpaint mask");
      enterLayerEditMode(layer, "inpaint", () => {
        refreshCompositePreview(); saveLayersToStorage(); renderLayerStrip();
      });
    });
  }
  addTool("Delete", () => {
    pushLayerUndo("Delete layer");
    layers.splice(idx, 1);
    container.style.display = "none";
    renderLayerList(); saveLayersToStorage(); refreshCompositePreview();
  }, true);
  container.appendChild(tools);
}

function setupLayerStripControls() {
  // Populate whichever container is available: tab panel or legacy strip controls
  const panel = document.getElementById("layer-tab-panel");
  const legacyControls = document.getElementById("layer-strip-controls");
  const controls = (panel && panel.style.display !== "none") ? panel : legacyControls;
  if (!controls) return;
  // Don't clear panel if it's being managed by _populateLayerPanel
  if (controls === panel) return;
  if (legacyControls) legacyControls.innerHTML = "";

  if (layers.length === 0) return;
  if (_activeLayerIdx >= layers.length) _activeLayerIdx = layers.length - 1;
  if (_activeLayerIdx < 0) _activeLayerIdx = 0;
  // Legacy strip controls are hidden, so just return
  return;
}

function _populateLayerPanelFull(container, idx) {
  // This is a stub that calls _populateLayerPanel which was inserted above
  _populateLayerPanel(container, idx);
}

function _setupLayerStripControlsLegacy() {
  const controls = document.getElementById("layer-strip-controls");
  if (!controls) return;
  controls.innerHTML = "";

  if (layers.length === 0) return;

  // Clamp index
  if (_activeLayerIdx >= layers.length) _activeLayerIdx = layers.length - 1;
  if (_activeLayerIdx < 0) _activeLayerIdx = 0;

  const layer = layers[_activeLayerIdx];

  // Helper builders
  function makeSep() {
    const sep = document.createElement("div");
    sep.className = "lsc-sep";
    return sep;
  }

  function makeIconBtn(title, svgHtml, isActive) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lsc-icon-btn" + (isActive ? " lsc-icon-btn--active" : "");
    btn.title = title;
    btn.innerHTML = svgHtml;
    return btn;
  }

  function makeActionBtn(label, isActive, isDanger) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lsc-action-btn" +
      (isActive  ? " lsc-action-btn--active"  : "") +
      (isDanger  ? " lsc-action-btn--danger"   : "");
    btn.textContent = label;
    return btn;
  }

  // ── Layer name ──────────────────────────────────────────
  const nameSpan = document.createElement("span");
  nameSpan.className = "lsc-name";
  nameSpan.textContent = layer.name;
  nameSpan.title = "Double-click to rename";
  nameSpan.addEventListener("dblclick", () => {
    nameSpan.contentEditable = "true";
    nameSpan.focus();
    // Select all
    const range = document.createRange();
    range.selectNodeContents(nameSpan);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  nameSpan.addEventListener("blur", () => {
    nameSpan.contentEditable = "false";
    const trimmed = nameSpan.textContent.trim();
    layer.name = trimmed || layer.name;
    if (!trimmed) nameSpan.textContent = layer.name;
    saveLayersToStorage();
    // Sync sidebar row name
    const rowEl = document.querySelectorAll(".layer-row")[_activeLayerIdx];
    if (rowEl) {
      const ns = rowEl.querySelector(".layer-name");
      if (ns) ns.textContent = layer.name;
    }
    // Sync card name
    const cards = document.querySelectorAll(".layer-card");
    if (cards[_activeLayerIdx]) {
      const cn = cards[_activeLayerIdx].querySelector(".layer-card-name");
      if (cn) cn.textContent = layer.name;
    }
  });
  nameSpan.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); nameSpan.blur(); }
    e.stopPropagation();
  });
  controls.appendChild(nameSpan);
  controls.appendChild(makeSep());

  // ── Eye (visibility) button ─────────────────────────────
  const eyeSvgVisible = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const eyeSvgHidden  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  const eyeBtn = makeIconBtn(
    layer.visible ? "Hide layer" : "Show layer",
    layer.visible ? eyeSvgVisible : eyeSvgHidden,
    layer.visible
  );
  eyeBtn.addEventListener("click", () => {
    pushLayerUndo("Toggle visibility");
    layer.visible = !layer.visible;
    saveLayersToStorage();
    updateLayersBadge();
    refreshCompositePreview();
    // Rebuild controls to reflect new state
    setupLayerStripControls();
  });
  controls.appendChild(eyeBtn);

  // ── Target button ────────────────────────────────────────
  const targetSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>';
  const targetBtn = makeIconBtn(
    layer.isOutputTarget ? "Output target (active)" : "Set as output target",
    targetSvg,
    !!layer.isOutputTarget
  );
  targetBtn.addEventListener("click", () => {
    pushLayerUndo("Toggle output target");
    const wasTarget = layer.isOutputTarget;
    layers.forEach((l) => { l.isOutputTarget = false; });
    layer.isOutputTarget = !wasTarget;
    // Update sidebar rows + strip cards in-place
    document.querySelectorAll(".layer-row").forEach((rowEl) => {
      const id = Number(rowEl.dataset.layerId);
      const l  = layers.find((x) => x.id === id);
      if (l) rowEl.classList.toggle("layer-row--output-target", !!l.isOutputTarget);
    });
    document.querySelectorAll(".layer-card").forEach((cardEl) => {
      const id = Number(cardEl.dataset.layerId);
      const l  = layers.find((x) => x.id === id);
      if (l) cardEl.classList.toggle("layer-card--output-target", !!l.isOutputTarget);
    });
    saveLayersToStorage();
    setupLayerStripControls();
  });
  controls.appendChild(targetBtn);
  controls.appendChild(makeSep());

  // ── Opacity slider ───────────────────────────────────────
  const opacityWrap = document.createElement("div");
  opacityWrap.className = "lsc-slider-wrap";
  const opacityLabel = document.createElement("span");
  opacityLabel.className = "lsc-label";
  opacityLabel.textContent = "Opacity";
  const opacitySlider = document.createElement("input");
  opacitySlider.type  = "range";
  opacitySlider.className = "lsc-slider";
  opacitySlider.min   = "0";
  opacitySlider.max   = "1";
  opacitySlider.step  = "0.05";
  opacitySlider.value = String(layer.opacity);
  const opacityVal = document.createElement("span");
  opacityVal.className = "lsc-val";
  opacityVal.textContent = Math.round(layer.opacity * 100) + "%";
  let _lscOpacityUndoPushed = false;
  opacitySlider.addEventListener("pointerdown", () => { _lscOpacityUndoPushed = false; });
  opacitySlider.addEventListener("input", () => {
    if (!_lscOpacityUndoPushed) { pushLayerUndo("Change opacity"); _lscOpacityUndoPushed = true; }
    layer.opacity = parseFloat(opacitySlider.value);
    opacityVal.textContent = Math.round(layer.opacity * 100) + "%";
    // Sync to CLP slider if still present
    const clpOpacity = document.getElementById("clp-opacity");
    const clpOpacityVal = document.getElementById("clp-opacity-val");
    if (clpOpacity) clpOpacity.value = String(layer.opacity);
    if (clpOpacityVal) clpOpacityVal.textContent = opacityVal.textContent;
    saveLayersToStorage();
    _markInputChanged();
    clearTimeout(_previewDebounceTimer);
    _previewDebounceTimer = setTimeout(refreshCompositePreview, 50);
  });
  opacityWrap.appendChild(opacityLabel);
  opacityWrap.appendChild(opacitySlider);
  opacityWrap.appendChild(opacityVal);
  controls.appendChild(opacityWrap);

  // ── Scale slider ─────────────────────────────────────────
  const scaleWrap = document.createElement("div");
  scaleWrap.className = "lsc-slider-wrap";
  const scaleLabel = document.createElement("span");
  scaleLabel.className = "lsc-label";
  scaleLabel.textContent = "Scale";
  const scaleSlider = document.createElement("input");
  scaleSlider.type  = "range";
  scaleSlider.className = "lsc-slider";
  scaleSlider.min   = "0.25";
  scaleSlider.max   = "4";
  scaleSlider.step  = "0.05";
  const currentScale = layer.scale !== undefined ? layer.scale : 1.0;
  scaleSlider.value = String(currentScale);
  const scaleVal = document.createElement("span");
  scaleVal.className = "lsc-val";
  scaleVal.textContent = Math.round(currentScale * 100) + "%";
  scaleVal.title = "Click to reset to 100%";
  scaleVal.style.cursor = "pointer";
  let _lscScaleUndoPushed = false;
  scaleSlider.addEventListener("pointerdown", () => { _lscScaleUndoPushed = false; });
  scaleSlider.addEventListener("input", () => {
    if (!_lscScaleUndoPushed) { pushLayerUndo("Change scale"); _lscScaleUndoPushed = true; }
    layer.scale = parseFloat(scaleSlider.value);
    scaleVal.textContent = Math.round(layer.scale * 100) + "%";
    const clpScale = document.getElementById("clp-scale");
    const clpScaleVal = document.getElementById("clp-scale-val");
    if (clpScale) clpScale.value = String(layer.scale);
    if (clpScaleVal) clpScaleVal.textContent = scaleVal.textContent;
    _markInputChanged();
    clearTimeout(_previewDebounceTimer);
    _previewDebounceTimer = setTimeout(refreshCompositePreview, 50);
  });
  scaleSlider.addEventListener("change", () => {
    saveLayersToStorage();
  });
  scaleVal.addEventListener("click", () => {
    pushLayerUndo("Reset scale");
    layer.scale = 1.0;
    scaleSlider.value = "1";
    scaleVal.textContent = "100%";
    saveLayersToStorage();
    _markInputChanged();
    clearTimeout(_previewDebounceTimer);
    _previewDebounceTimer = setTimeout(refreshCompositePreview, 50);
  });
  scaleWrap.appendChild(scaleLabel);
  scaleWrap.appendChild(scaleSlider);
  scaleWrap.appendChild(scaleVal);
  controls.appendChild(scaleWrap);
  controls.appendChild(makeSep());

  // ── Tool buttons ─────────────────────────────────────────

  // Move
  const moveBtn = makeActionBtn("Move", _movingLayer === layer, false);
  moveBtn.addEventListener("click", () => {
    if (_movingLayer === layer) {
      _movingLayer = null;
      _disableCanvasMove();
    } else {
      _movingLayer = layer;
      _enableCanvasMove(layer);
    }
    setupLayerStripControls();
  });
  controls.appendChild(moveBtn);

  // Draw
  const drawBtn = makeActionBtn("Draw", false, false);
  drawBtn.addEventListener("click", () => {
    enterLayerEditMode(layer, "draw", () => {
      refreshCompositePreview();
      saveLayersToStorage();
      _markInputChanged();
      renderLayerStrip();
    });
  });
  controls.appendChild(drawBtn);

  // Mask
  const maskBtn = makeActionBtn("Mask", false, false);
  maskBtn.addEventListener("click", () => {
    pushLayerUndo("Edit visibility mask");
    enterLayerEditMode(layer, "mask", () => {
      saveLayersToStorage();
      refreshCompositePreview();
      _markInputChanged();
    });
  });
  controls.appendChild(maskBtn);

  // Inpaint
  const inpaintBtn = makeActionBtn("Inpaint", false, false);
  inpaintBtn.addEventListener("click", () => {
    pushLayerUndo("Edit inpaint mask");
    enterLayerEditMode(layer, "inpaint", () => {
      saveLayersToStorage();
      refreshCompositePreview();
      _markInputChanged();
    });
  });
  controls.appendChild(inpaintBtn);

  // AI Redraw (only when layer has image)
  if (layer.imageBase64 && _openLayerRedraw) {
    const redrawBtn = makeActionBtn("AI Redraw", false, false);
    redrawBtn.addEventListener("click", () => {
      if (_openLayerRedraw) _openLayerRedraw(layer);
      else showStatus("AI Redraw not ready");
    });
    controls.appendChild(redrawBtn);
  }

  // Delete
  const deleteBtn = makeActionBtn("Delete", false, true);
  deleteBtn.addEventListener("click", () => {
    pushLayerUndo("Remove layer");
    layers.splice(_activeLayerIdx, 1);
    if (_activeLayerIdx >= layers.length && layers.length > 0) _activeLayerIdx = layers.length - 1;
    renderLayerList(); // renderLayerList calls renderLayerStrip() internally
    saveLayersToStorage();
    refreshCompositePreview();
  });
  controls.appendChild(deleteBtn);
}

function setupLayerStrip() {
  const addBtn = document.getElementById("layer-strip-add");
  const tabsAddBtn = document.getElementById("layer-tabs-add");

  function addNewLayer() {
    if (layers.length >= MAX_LAYERS) {
      showStatus("Maximum of " + MAX_LAYERS + " layers reached.");
      return;
    }
    pushLayerUndo("Add layer");
    const n = layers.length + 1;
    _activeLayerIdx = layers.length;
    layers.push({
      id: Date.now(),
      name: "Layer " + n,
      imageBase64: null,
      maskBase64: null,
      inpaintMaskBase64: null,
      opacity: 1.0,
      visible: true,
      isOutputTarget: false,
      offsetX: 0,
      offsetY: 0,
      scale: 1.0,
    });
    renderLayerList();
    saveLayersToStorage();
  }

  if (addBtn) addBtn.addEventListener("click", addNewLayer);
  if (tabsAddBtn) tabsAddBtn.addEventListener("click", addNewLayer);

  // File drop onto layer strip scroll area
  const scroll = document.getElementById("layer-strip-scroll");
  if (scroll) {
    scroll.addEventListener("dragover", (e) => {
      if (_layerDrag.active) return;
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    });
    scroll.addEventListener("drop", (e) => {
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
        layers.push({
          id: Date.now(),
          name: file.name.replace(/\.[^.]+$/, "") || "Layer " + n,
          imageBase64: b64,
          maskBase64: null,
          inpaintMaskBase64: null,
          opacity: 1.0,
          visible: true,
          isOutputTarget: false,
          offsetX: 0,
          offsetY: 0,
          scale: 1.0,
        });
        _activeLayerIdx = layers.length - 1;
        renderLayerList(); // renderLayerList calls renderLayerStrip() internally
        saveLayersToStorage();
        refreshCompositePreview();
      };
      reader.readAsDataURL(file);
    });
  }

  // Close layer tab panel on outside click
  document.addEventListener("click", (e) => {
    const panel = document.getElementById("layer-tab-panel");
    if (!panel || panel.style.display === "none") return;
    if (panel.contains(e.target)) return;
    if (e.target.closest(".layer-tab") || e.target.closest(".layer-tabs-add")) return;
    panel.style.display = "none";
  }, true);
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
    sendToLayer.addEventListener("click", async () => {
      if (!state.lastGeneratedImageBase64) return;
      if (layers.length >= MAX_LAYERS) return;
      pushLayerUndo("Send to layer");

      // Auto-generate reveal mask from drawn content or inpaint mask.
      // Priority: 1) inpaint mask, 2) alpha from drawn layer content, 3) none
      let maskBase64 = null;
      let maskSource = null;

      const inpaintLayer = layers.find(l => l.inpaintMaskBase64);
      if (inpaintLayer) {
        // Use inpaint mask directly as reveal mask
        maskBase64 = inpaintLayer.inpaintMaskBase64;
        inpaintLayer.inpaintMaskBase64 = null;
        maskSource = "inpaint";
      } else {
        // Scan all layers for one with transparent content (drawn layer)
        for (const layer of layers) {
          if (!layer.imageBase64) continue;
          const extracted = await _extractAlphaMask(layer.imageBase64);
          if (extracted) {
            maskBase64 = extracted;
            maskSource = "draw";
            break;
          }
        }
      }

      const outputLayers = layers.filter((l) => l.name.startsWith("Output"));
      const n = outputLayers.length;
      const name = n === 0 ? "Output" : "Output " + (n + 1);
      layers.unshift({
        id: Date.now(),
        name,
        imageBase64: state.lastGeneratedImageBase64,
        maskBase64,
        inpaintMaskBase64: null,
        opacity: 1.0,
        visible: true,
        isOutputTarget: false,
        offsetX: 0, offsetY: 0, scale: 1.0,
      });
      _activeLayerIdx = 0;
      renderLayerList();
      saveLayersToStorage();

      // Open layers accordion if it's closed
      const accordion = document.getElementById("layers-accordion");
      if (accordion && !accordion.open) accordion.open = true;

      const msg = maskSource === "inpaint"
        ? "Sent to layer \"" + name + "\" — masked to inpaint area"
        : maskSource === "draw"
        ? "Sent to layer \"" + name + "\" — masked to drawn area"
        : "Sent to layer \"" + name + "\"";
      showStatus(msg);
    });
  }

  // Toggle layers on/off — update preview immediately
  const layersToggle = document.getElementById("layers-enabled");
  if (layersToggle) {
    layersToggle.addEventListener("change", () => refreshCompositePreview());
  }

  // Wire up the horizontal layer strip
  setupLayerStrip();
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

  // Prev/Next button state — hide entirely when only 1 layer
  const prevBtn = document.getElementById("clp-prev");
  const nextBtn = document.getElementById("clp-next");
  const singleLayer = layers.length <= 1;
  if (prevBtn) { prevBtn.style.display = singleLayer ? "none" : ""; prevBtn.disabled = (_activeLayerIdx === 0); }
  if (nextBtn) { nextBtn.style.display = singleLayer ? "none" : ""; nextBtn.disabled = (_activeLayerIdx === layers.length - 1); }

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

  // Keep layer strip in sync with CLP updates
  renderLayerStrip();
}

function setupCanvasLayerPanel() {
  // ── Collapse toggle ───────────────────────────────────────
  const collapseBtn = document.getElementById("clp-collapse");
  const clpBody     = document.getElementById("clp-body");
  const savedCollapsed = localStorage.getItem("nai-clp-collapsed") === "true";
  if (savedCollapsed && clpBody) clpBody.style.display = "none";

  if (collapseBtn && clpBody) {
    const chevronDown = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    const chevronRight = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';
    collapseBtn.innerHTML = savedCollapsed ? chevronRight : chevronDown;
    collapseBtn.addEventListener("click", () => {
      const isCollapsed = clpBody.style.display === "none";
      clpBody.style.display = isCollapsed ? "" : "none";
      collapseBtn.innerHTML = isCollapsed ? chevronDown : chevronRight;
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
    enterLayerEditMode(layer, "draw", () => {
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
    enterLayerEditMode(layer, "mask", () => {
      saveLayersToStorage();
      refreshCompositePreview();
      _markInputChanged();
    });
  });

  document.getElementById("clp-inpaint")?.addEventListener("click", () => {
    if (layers.length === 0) return;
    const layer = layers[_activeLayerIdx];
    pushLayerUndo("Edit inpaint mask");
    enterLayerEditMode(layer, "inpaint", () => {
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
          clearOutput(output);
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
          clearOutput(output);
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
   INLINE LAYER EDITOR — single unified editor replacing the three modal overlays
   Modes: "draw" | "mask" | "inpaint"
   enterLayerEditMode(layer, mode, onApply) replaces:
     openLayerDrawEditor, openLayerMaskEditor, openLayerInpaintEditor
   ═══════════════════════════════════════════════════════════ */

function enterLayerEditMode(layer, mode, onApply) {
  // ── DOM refs ──────────────────────────────────────────────
  const bgCanvas      = document.getElementById("inline-edit-bg");
  const editCanvas    = document.getElementById("inline-edit-canvas");
  const cursorEl      = document.getElementById("inline-edit-cursor");
  const toolbar       = document.getElementById("inline-edit-toolbar");
  const modeBadge     = document.getElementById("iet-mode-badge");
  const modeToggle    = document.getElementById("iet-mode-toggle");
  const brushSlider   = document.getElementById("iet-brush-size");
  const brushValEl    = document.getElementById("iet-brush-val");
  const colorWrap     = document.getElementById("iet-color-wrap");
  const colorInput    = document.getElementById("iet-color");
  const fillBtn       = document.getElementById("iet-fill");
  const invertBtn     = document.getElementById("iet-invert");
  const clearBtn      = document.getElementById("iet-clear");
  const undoBtn       = document.getElementById("iet-undo");
  const cancelBtn     = document.getElementById("iet-cancel");
  const applyBtn      = document.getElementById("iet-apply");
  const dropTarget    = document.getElementById("canvas-drop-target");

  if (!editCanvas || !toolbar || !dropTarget) return;

  // Guard: mask/inpaint need an image to work with
  if (mode === "mask" && !layer.imageBase64) {
    showStatus("Load an image into this layer first.");
    return;
  }
  if (mode === "inpaint") {
    const src = state.canvasImageBase64 || layer.imageBase64;
    if (!src) {
      showStatus("No image to inpaint — add images to layers first.");
      return;
    }
  }

  const editCtx = editCanvas.getContext("2d");

  // Offscreen canvas — full resolution
  const offscreen = document.createElement("canvas");
  const offCtx    = offscreen.getContext("2d");

  // AbortController for this editor session
  const editorAC  = new AbortController();
  const editorSig = { signal: editorAC.signal };

  // Editor state
  let brushSize = parseInt(brushSlider.value, 10) || 20;
  let eraseMode = false;
  let isDrawing = false;
  let lastX = 0;
  let lastY = 0;
  let scaleX = 1;
  let scaleY = 1;
  const undoStack = [];
  const MAX_UNDO  = 20;

  // ── Configure toolbar for mode ────────────────────────────
  toolbar.dataset.editMode = mode; // CSS can differentiate via [data-edit-mode]
  if (mode === "draw") {
    modeBadge.textContent = "Draw";
    modeBadge.className = "iet-mode-badge";
    colorWrap.style.display = "";
    fillBtn.style.display   = "";
    invertBtn.style.display = "none";
    modeToggle.querySelector(".iet-mode-label").textContent = "Paint";
    modeToggle.dataset.mode = "paint";
  } else if (mode === "mask") {
    modeBadge.textContent = "Mask";
    modeBadge.className = "iet-mode-badge iet-mode-badge--mask";
    colorWrap.style.display = "none";
    fillBtn.style.display   = "none";
    invertBtn.style.display = "";
    modeToggle.querySelector(".iet-mode-label").textContent = "Reveal";
    modeToggle.dataset.mode = "paint";
  } else { // inpaint
    modeBadge.textContent = "Inpaint";
    modeBadge.className = "iet-mode-badge iet-mode-badge--inpaint";
    colorWrap.style.display = "none";
    fillBtn.style.display   = "none";
    invertBtn.style.display = "none";
    modeToggle.querySelector(".iet-mode-label").textContent = "Paint";
    modeToggle.dataset.mode = "paint";
  }

  // ── Mode toggle ───────────────────────────────────────────
  function setMode(paintOrErase) {
    eraseMode = (paintOrErase === "erase");
    modeToggle.dataset.mode = paintOrErase;
    const iconPaint = modeToggle.querySelector(".iet-icon-paint");
    const iconErase = modeToggle.querySelector(".iet-icon-erase");
    const label     = modeToggle.querySelector(".iet-mode-label");
    if (iconPaint) iconPaint.style.display = eraseMode ? "none" : "";
    if (iconErase) iconErase.style.display = eraseMode ? "" : "none";

    if (mode === "mask") {
      if (label) label.textContent = eraseMode ? "Hide" : "Reveal";
      cursorEl.style.borderColor = eraseMode ? "rgba(220,50,50,0.85)" : "rgba(255,255,255,0.85)";
    } else if (mode === "draw") {
      if (label) label.textContent = eraseMode ? "Erase" : "Paint";
      cursorEl.style.borderColor = eraseMode ? "rgba(255,255,255,0.5)" : (colorInput.value || "rgba(255,255,255,0.85)");
    } else { // inpaint
      if (label) label.textContent = eraseMode ? "Erase" : "Paint";
      cursorEl.style.borderColor = eraseMode ? "rgba(255,255,255,0.5)" : "rgba(240,80,80,0.85)";
    }
  }

  modeToggle.addEventListener("click", () => setMode(eraseMode ? "paint" : "erase"), editorSig);

  // ── Brush size ────────────────────────────────────────────
  function updateBrushSize(val) {
    brushSize = val;
    brushSlider.value = val;
    brushValEl.textContent = val;
    // Cursor size must account for CSS scaling (canvas pixels → display pixels)
    const rect = editCanvas.getBoundingClientRect();
    const displayScale = rect.width / (editCanvas.width || 1);
    const displaySize = Math.max(4, val * displayScale);
    cursorEl.style.width  = displaySize + "px";
    cursorEl.style.height = displaySize + "px";
  }

  brushSlider.addEventListener("input", () => updateBrushSize(parseInt(brushSlider.value, 10)), editorSig);

  if (mode === "draw") {
    colorInput.addEventListener("input", () => {
      if (!eraseMode) cursorEl.style.borderColor = colorInput.value;
    }, editorSig);
  }

  // ── Undo ──────────────────────────────────────────────────
  function saveUndoSnapshot() {
    if (editCanvas.width === 0 || editCanvas.height === 0) return;
    const dispSnap = editCtx.getImageData(0, 0, editCanvas.width, editCanvas.height);
    const offSnap  = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
    if (undoStack.length >= MAX_UNDO) undoStack.shift();
    undoStack.push({ disp: dispSnap, off: offSnap });
  }

  function undo() {
    if (undoStack.length === 0) return;
    const snap = undoStack.pop();
    editCtx.putImageData(snap.disp, 0, 0);
    offCtx.putImageData(snap.off, 0, 0);
  }

  undoBtn.addEventListener("click", undo, editorSig);

  // ── Paint helpers ─────────────────────────────────────────
  function paintCircle(ctx, cx, cy, r) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function interpolatedStroke(ctx, x0, y0, x1, y1, r, isFirst) {
    if (isFirst) {
      paintCircle(ctx, x0, y0, r);
      return;
    }
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(r * 0.4, 1);
    const steps = Math.ceil(dist / step);
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      paintCircle(ctx, x0 + dx * t, y0 + dy * t, r);
    }
  }

  function drawAt(dispX, dispY, isFirst) {
    const r    = brushSize / 2;
    const offX = dispX * scaleX;
    const offY = dispY * scaleY;
    const offR = r * Math.max(scaleX, scaleY);
    const lOffX = lastX * scaleX;
    const lOffY = lastY * scaleY;

    // ── Display canvas paint ───────────────────────────────
    editCtx.save();
    if (mode === "draw") {
      if (eraseMode) {
        editCtx.globalCompositeOperation = "destination-out";
      } else {
        editCtx.globalCompositeOperation = "source-over";
        editCtx.fillStyle = colorInput.value;
      }
    } else if (mode === "mask") {
      if (eraseMode) {
        // Hide: paint red tint
        editCtx.globalCompositeOperation = "source-over";
        editCtx.fillStyle = "rgba(220,50,50,0.45)";
      } else {
        // Reveal: cut out red tint
        editCtx.globalCompositeOperation = "destination-out";
        editCtx.fillStyle = "rgba(0,0,0,1)";
      }
    } else { // inpaint
      if (eraseMode) {
        editCtx.globalCompositeOperation = "destination-out";
      } else {
        editCtx.globalCompositeOperation = "source-over";
        editCtx.fillStyle = "rgba(240,80,80,0.55)";
      }
    }
    interpolatedStroke(editCtx, lastX, lastY, dispX, dispY, r, isFirst);
    editCtx.restore();

    // ── Offscreen paint ────────────────────────────────────
    offCtx.save();
    if (mode === "draw") {
      if (eraseMode) {
        offCtx.globalCompositeOperation = "destination-out";
      } else {
        offCtx.globalCompositeOperation = "source-over";
        offCtx.fillStyle = colorInput.value;
      }
    } else if (mode === "mask") {
      offCtx.globalCompositeOperation = "source-over";
      offCtx.fillStyle = eraseMode ? "#000000" : "#ffffff";
    } else { // inpaint
      offCtx.globalCompositeOperation = "source-over";
      offCtx.fillStyle = eraseMode ? "#000000" : "#ffffff";
    }
    interpolatedStroke(offCtx, lOffX, lOffY, offX, offY, offR, isFirst);
    offCtx.restore();
  }

  // ── Sync visible display canvas from offscreen (mask mode) ──
  function syncMaskDisplay() {
    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width  = offscreen.width;
    tmpCanvas.height = offscreen.height;
    const tmpCtx = tmpCanvas.getContext("2d");
    const maskData = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
    const d = maskData.data;
    for (let i = 0; i < d.length; i += 4) {
      const brightness = d[i];
      d[i]     = 220;
      d[i + 1] = 50;
      d[i + 2] = 50;
      d[i + 3] = Math.round((1 - brightness / 255) * 115);
    }
    tmpCtx.putImageData(maskData, 0, 0);
    editCtx.clearRect(0, 0, editCanvas.width, editCanvas.height);
    editCtx.drawImage(tmpCanvas, 0, 0, editCanvas.width, editCanvas.height);
  }

  // ── Clear button ──────────────────────────────────────────
  clearBtn.addEventListener("click", () => {
    saveUndoSnapshot();
    if (mode === "draw") {
      offCtx.clearRect(0, 0, offscreen.width, offscreen.height);
      editCtx.clearRect(0, 0, editCanvas.width, editCanvas.height);
    } else if (mode === "mask") {
      // Reset to all black (hide everything)
      offCtx.fillStyle = "#000000";
      offCtx.fillRect(0, 0, offscreen.width, offscreen.height);
      syncMaskDisplay();
    } else { // inpaint
      offCtx.fillStyle = "#000000";
      offCtx.fillRect(0, 0, offscreen.width, offscreen.height);
      editCtx.clearRect(0, 0, editCanvas.width, editCanvas.height);
    }
  }, editorSig);

  // ── Fill button (draw mode only) ─────────────────────────
  fillBtn.addEventListener("click", () => {
    saveUndoSnapshot();
    offCtx.fillStyle = colorInput.value;
    offCtx.fillRect(0, 0, offscreen.width, offscreen.height);
    editCtx.fillStyle = colorInput.value;
    editCtx.fillRect(0, 0, editCanvas.width, editCanvas.height);
  }, editorSig);

  // ── Invert button (mask mode only) ───────────────────────
  invertBtn.addEventListener("click", () => {
    saveUndoSnapshot();
    const imgData = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i]     = 255 - d[i];
      d[i + 1] = 255 - d[i + 1];
      d[i + 2] = 255 - d[i + 2];
    }
    offCtx.putImageData(imgData, 0, 0);
    syncMaskDisplay();
  }, editorSig);

  // ── Pointer events ────────────────────────────────────────
  function getEditCanvasPos(e) {
    const rect = editCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (editCanvas.width / rect.width),
      y: (e.clientY - rect.top)  * (editCanvas.height / rect.height),
    };
  }

  editCanvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    editCanvas.setPointerCapture(e.pointerId);
    saveUndoSnapshot();
    isDrawing = true;
    const pos = getEditCanvasPos(e);
    lastX = pos.x;
    lastY = pos.y;
    drawAt(pos.x, pos.y, true);
  }, editorSig);

  editCanvas.addEventListener("pointermove", (e) => {
    const dtRect = dropTarget.getBoundingClientRect();
    cursorEl.style.display = "block";
    cursorEl.style.left = (e.clientX - dtRect.left) + "px";
    cursorEl.style.top  = (e.clientY - dtRect.top)  + "px";

    if (!isDrawing) return;
    e.preventDefault();
    const pos = getEditCanvasPos(e);
    drawAt(pos.x, pos.y, false);
    lastX = pos.x;
    lastY = pos.y;
  }, editorSig);

  editCanvas.addEventListener("pointerup",     () => { isDrawing = false; }, editorSig);
  editCanvas.addEventListener("pointerleave",  () => { isDrawing = false; cursorEl.style.display = "none"; }, editorSig);
  editCanvas.addEventListener("pointercancel", () => { isDrawing = false; cursorEl.style.display = "none"; }, editorSig);

  // ── Keyboard shortcuts ────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    if (toolbar.style.display === "none") return;
    if ((e.metaKey || e.ctrlKey) && e.key === "z") {
      e.preventDefault();
      undo();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      closeEditor(true);
    } else if (e.key === "Escape") {
      e.stopImmediatePropagation();
      closeEditor(false);
    } else if (e.key === "[") {
      updateBrushSize(Math.max(4, brushSize - 2));
    } else if (e.key === "]") {
      updateBrushSize(Math.min(120, brushSize + 2));
    }
  }, editorSig);

  // ── Cancel / Apply ────────────────────────────────────────
  function tearDown() {
    editorAC.abort();
    toolbar.style.display      = "none";
    editCanvas.style.display   = "none";
    bgCanvas.style.display     = "none";
    cursorEl.style.display     = "none";
  }

  function closeEditor(apply) {
    if (apply) {
      if (mode === "draw") {
        const dataUrl = offscreen.toDataURL("image/png");
        layer.imageBase64 = dataUrl.replace("data:image/png;base64,", "");
      } else if (mode === "mask") {
        const dataUrl = offscreen.toDataURL("image/png");
        layer.maskBase64 = dataUrl.replace("data:image/png;base64,", "");
      } else { // inpaint
        // Check if any white pixels exist
        const imgData = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
        const d = imgData.data;
        let hasWhite = false;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 128) { hasWhite = true; break; }
        }
        if (!hasWhite) {
          layer.inpaintMaskBase64 = null;
          tearDown();
          if (onApply) onApply();
          showStatus("Inpaint mask cleared");
          return;
        }
        const dataUrl = offscreen.toDataURL("image/png");
        layer.inpaintMaskBase64 = dataUrl.replace("data:image/png;base64,", "");
      }
      tearDown();
      if (onApply) onApply();
    } else {
      tearDown();
    }
  }

  cancelBtn.addEventListener("click", () => closeEditor(false), editorSig);
  applyBtn.addEventListener("click",  () => closeEditor(true),  editorSig);

  // ── Open: compute position & initialise ───────────────────
  function positionCanvasOverImage() {
    // Use the actual <img> inside #output for precise letterbox coordinates.
    const imgEl = document.querySelector("#output img");
    const dtRect = dropTarget.getBoundingClientRect();

    if (imgEl) {
      const imgRect = imgEl.getBoundingClientRect();
      return {
        left: imgRect.left - dtRect.left,
        top:  imgRect.top  - dtRect.top,
        w:    imgRect.width,
        h:    imgRect.height,
      };
    }

    // No image (empty layer draw mode): compute a centered rect matching
    // the offscreen aspect ratio within the drop target.
    if (mode === "draw") {
      const resSel = document.getElementById("resolution");
      const parts = (resSel ? resSel.value : "832x1216").split("x").map(Number);
      const imgAR = (parts[0] || 832) / (parts[1] || 1216);
      const containerW = dtRect.width;
      const containerH = dtRect.height;
      let w, h;
      if (containerW / containerH > imgAR) {
        h = containerH;
        w = h * imgAR;
      } else {
        w = containerW;
        h = w / imgAR;
      }
      return {
        left: (containerW - w) / 2,
        top:  (containerH - h) / 2,
        w, h,
      };
    }

    return null;
  }

  function applyCanvasPosition(canvas, pos, useOffscreenRes) {
    canvas.style.left   = pos.left + "px";
    canvas.style.top    = pos.top  + "px";
    canvas.style.width  = pos.w + "px";
    canvas.style.height = pos.h + "px";
    // Canvas pixel resolution: use offscreen resolution to preserve aspect ratio,
    // CSS width/height handles the display scaling
    if (useOffscreenRes && offscreen) {
      if (canvas.width !== offscreen.width || canvas.height !== offscreen.height) {
        canvas.width  = offscreen.width;
        canvas.height = offscreen.height;
      }
    } else {
      if (canvas.width !== Math.round(pos.w) || canvas.height !== Math.round(pos.h)) {
        canvas.width  = Math.round(pos.w);
        canvas.height = Math.round(pos.h);
      }
    }
  }

  function openEditor() {
    // Determine offscreen (full-pixel) resolution
    let offW, offH;
    if (mode === "mask") {
      // Mask resolution matches the layer's image natural size
      const tmpImg = new Image();
      tmpImg.onload = () => {
        offW = tmpImg.naturalWidth;
        offH = tmpImg.naturalHeight;
        finishOpen(offW, offH);
      };
      tmpImg.src = "data:image/png;base64," + layer.imageBase64;
    } else {
      // draw / inpaint: use #resolution dropdown
      const resSel = document.getElementById("resolution");
      const resParts = (resSel ? resSel.value : "832x1216").split("x").map(Number);
      offW = resParts[0] || 832;
      offH = resParts[1] || 1216;
      finishOpen(offW, offH);
    }
  }

  function finishOpen(offW, offH) {
    offscreen.width  = offW;
    offscreen.height = offH;

    const pos = positionCanvasOverImage();
    if (!pos) {
      showStatus("No image on canvas to edit.");
      return;
    }

    // Position and size the edit canvas over the displayed image
    // Edit canvas uses offscreen resolution for pixel-perfect drawing
    editCanvas.style.display = "block";
    applyCanvasPosition(editCanvas, pos, true);

    // Scale is now 1:1 since edit canvas matches offscreen resolution
    scaleX = 1;
    scaleY = 1;

    // Background canvas: shows composite of other layers (draw mode)
    if (mode === "draw") {
      bgCanvas.style.display = "block";
      applyCanvasPosition(bgCanvas, pos, true);
      const bgCtx = bgCanvas.getContext("2d");
      bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
      const otherLayers = layers.filter((l) => l.visible && l.imageBase64 && l.id !== layer.id);
      [...otherLayers].reverse().forEach((other) => {
        const img = new Image();
        img.onload = () => {
          bgCtx.globalAlpha = other.opacity;
          bgCtx.drawImage(img, 0, 0, bgCanvas.width, bgCanvas.height);
          bgCtx.globalAlpha = 1.0;
        };
        img.src = "data:image/png;base64," + other.imageBase64;
      });
    } else {
      bgCanvas.style.display = "none";
    }

    // Initialise canvas content
    if (mode === "draw") {
      if (layer.imageBase64) {
        const existImg = new Image();
        existImg.onload = () => {
          offCtx.drawImage(existImg, 0, 0, offW, offH);
          editCtx.drawImage(existImg, 0, 0, editCanvas.width, editCanvas.height);
          undoStack.length = 0;
          setMode("paint");
          updateBrushSize(brushSize);
          cursorEl.style.borderColor = colorInput.value;
        };
        existImg.src = "data:image/png;base64," + layer.imageBase64;
      } else {
        offCtx.clearRect(0, 0, offW, offH);
        editCtx.clearRect(0, 0, editCanvas.width, editCanvas.height);
        undoStack.length = 0;
        setMode("paint");
        updateBrushSize(brushSize);
        cursorEl.style.borderColor = colorInput.value;
      }
    } else if (mode === "mask") {
      if (layer.maskBase64) {
        const existMask = new Image();
        existMask.onload = () => {
          offCtx.drawImage(existMask, 0, 0, offW, offH);
          syncMaskDisplay();
          undoStack.length = 0;
          setMode("paint");
          updateBrushSize(brushSize);
        };
        existMask.src = "data:image/png;base64," + layer.maskBase64;
      } else {
        // Default: all black = hide everything, user paints white to reveal
        offCtx.fillStyle = "#000000";
        offCtx.fillRect(0, 0, offW, offH);
        syncMaskDisplay();
        undoStack.length = 0;
        setMode("paint");
        updateBrushSize(brushSize);
      }
    } else { // inpaint
      // Fill black as base
      offCtx.fillStyle = "#000000";
      offCtx.fillRect(0, 0, offW, offH);
      editCtx.clearRect(0, 0, editCanvas.width, editCanvas.height);

      if (layer.inpaintMaskBase64) {
        const existMask = new Image();
        existMask.onload = () => {
          offCtx.drawImage(existMask, 0, 0, offW, offH);
          // Re-draw tint from offscreen pixel data
          const od = offCtx.getImageData(0, 0, offW, offH).data;
          editCtx.clearRect(0, 0, editCanvas.width, editCanvas.height);
          for (let py = 0; py < editCanvas.height; py++) {
            for (let px = 0; px < editCanvas.width; px++) {
              const ox = Math.min(Math.round(px * scaleX), offW - 1);
              const oy = Math.min(Math.round(py * scaleY), offH - 1);
              if (od[(oy * offW + ox) * 4] > 128) {
                editCtx.fillStyle = "rgba(240,80,80,0.55)";
                editCtx.fillRect(px, py, 1, 1);
              }
            }
          }
          undoStack.length = 0;
          setMode("paint");
          updateBrushSize(brushSize);
        };
        existMask.src = "data:image/png;base64," + layer.inpaintMaskBase64;
      } else {
        undoStack.length = 0;
        setMode("paint");
        updateBrushSize(brushSize);
      }
    }

    // Show toolbar
    toolbar.style.display = "";
  }

  openEditor();
}

function _deadMaskEditor() {
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

  // Update collapsed prompt bar button label for provider
  const collapsedLayerBtn = document.getElementById("cpb-collapsed-send-layer");
  if (collapsedLayerBtn) {
    collapsedLayerBtn.textContent = isNovelAI ? "Layer" : "Iterate";
    collapsedLayerBtn.title = isNovelAI ? "Send to layer" : "Use output as next input";
  }
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
