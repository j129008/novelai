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
  lastImg2imgInput: null,         // the img2img composite sent to the API (captured at generation time for compare mode)
  // canvas-displayed image (may be a gallery preview, not necessarily last generated)
  canvasImageBase64: null,
  canvasImageWidth: null,
  canvasImageHeight: null,
  grokOutputType: "image", // "image" | "video" — Grok output mode
};

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
  renderLayerStrip();
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
  renderLayerStrip();
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
