"use strict";

/* ═══════════════════════════════════════════════════════════
   POSE SKELETON — 2D mannequin overlay for canvas
   ═══════════════════════════════════════════════════════════ */

// Draggable joints (eyes/ears removed — they add clutter with no visual)
const POSE_JOINTS = [
  "nose", "neck",
  "right_shoulder", "right_elbow", "right_wrist",
  "left_shoulder", "left_elbow", "left_wrist",
  "right_hip", "right_knee", "right_ankle",
  "left_hip", "left_knee", "left_ankle",
];

// All body connections: [jointA, jointB, widthA, widthB]
// Width factors relative to reference size (shoulder-to-hip distance)
const BODY_CONNECTIONS = [
  // Torso (drawn as wide capsules)
  ["left_shoulder",  "left_hip",    0.30, 0.25],   // left torso side
  ["right_shoulder", "right_hip",   0.30, 0.25],   // right torso side
  ["left_shoulder",  "right_shoulder", 0.20, 0.20], // chest
  ["left_hip",       "right_hip",   0.20, 0.20],   // pelvis
  // Legs
  ["right_hip",      "right_knee",  0.25, 0.18],
  ["right_knee",     "right_ankle", 0.17, 0.10],
  ["left_hip",       "left_knee",   0.25, 0.18],
  ["left_knee",      "left_ankle",  0.17, 0.10],
  // Arms
  ["right_shoulder", "right_elbow", 0.18, 0.14],
  ["right_elbow",    "right_wrist", 0.13, 0.08],
  ["left_shoulder",  "left_elbow",  0.18, 0.14],
  ["left_elbow",     "left_wrist",  0.13, 0.08],
  // Neck
  ["neck",           "nose",        0.12, 0.10],
];

// ── Default joint positions (0.0–1.0 normalised) ──────────

function getDefaultJoints(bodyType) {
  if (bodyType === "child") return _childJoints();
  return {
    nose: [0.50, 0.08], neck: [0.50, 0.15],
    right_shoulder: [0.42, 0.20], left_shoulder: [0.58, 0.20],
    right_elbow: [0.38, 0.32], left_elbow: [0.62, 0.32],
    right_wrist: [0.36, 0.44], left_wrist: [0.64, 0.44],
    right_hip: [0.44, 0.50], left_hip: [0.56, 0.50],
    right_knee: [0.43, 0.67], left_knee: [0.57, 0.67],
    right_ankle: [0.43, 0.84], left_ankle: [0.57, 0.84],
    // Keep in data for backward compat but don't render
    right_eye: [0.47, 0.06], left_eye: [0.53, 0.06],
    right_ear: [0.44, 0.07], left_ear: [0.56, 0.07],
  };
}

function _childJoints() {
  const adult = getDefaultJoints("adult");
  const adultBodyH = adult.left_ankle[1] - adult.neck[1];
  const s = 0.60 / adultBodyH;
  const neckY = 0.22, neckX = 0.50, an = adult.neck;
  const headJ = new Set(["nose"]);
  const joints = {};
  for (const name of Object.keys(adult)) {
    const [ax, ay] = adult[name];
    const dx = ax - an[0], dy = ay - an[1];
    const hs = headJ.has(name) ? 1.3 : 1;
    joints[name] = [neckX + dx * s * hs, neckY + dy * s * hs];
  }
  return joints;
}

// ── SVG helpers ──────────────────────────────────────────

const SVGNS = "http://www.w3.org/2000/svg";

function _svgCapsule(parent, x1, y1, x2, y2, w1, w2, fill) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const sin = Math.sin(angle), cos = Math.cos(angle);
  const hw1 = w1 / 2, hw2 = w2 / 2;
  const dx1 = hw1 * sin, dy1 = hw1 * cos;
  const dx2 = hw2 * sin, dy2 = hw2 * cos;
  const path = document.createElementNS(SVGNS, "path");
  const d = [
    `M ${x1 - dx1} ${y1 + dy1}`,
    `A ${hw1} ${hw1} 0 0 1 ${x1 + dx1} ${y1 - dy1}`,
    `L ${x2 + dx2} ${y2 - dy2}`,
    `A ${hw2} ${hw2} 0 0 1 ${x2 - dx2} ${y2 + dy2}`,
    "Z",
  ].join(" ");
  path.setAttribute("d", d);
  path.setAttribute("fill", fill);
  path.style.pointerEvents = "none";
  parent.appendChild(path);
}

function _svgEllipse(parent, cx, cy, rx, ry, fill) {
  const el = document.createElementNS(SVGNS, "ellipse");
  el.setAttribute("cx", cx); el.setAttribute("cy", cy);
  el.setAttribute("rx", rx); el.setAttribute("ry", ry);
  el.setAttribute("fill", fill);
  el.style.pointerEvents = "none";
  parent.appendChild(el);
}

function _dist(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
function _mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }

// ── Module-level state ───────────────────────────────────
let _dragState = null;

// SVG overlay always fills canvas-drop-target via CSS inset:0
// Clear any stale inline styles from previous versions
function _alignOverlayToOutput() {
  const svg = document.getElementById("pose-skeleton-overlay");
  if (svg) { svg.style.left = ""; svg.style.top = ""; svg.style.width = ""; svg.style.height = ""; }
}

// ── Render ────────────────────────────────────────────────

function renderPoseSkeleton(layerIdx) {
  const svg = document.getElementById("pose-skeleton-overlay");
  if (!svg) return;
  setupPoseDrag(); _setupPoseScale(); _setupPosePan();
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const anyPose = layers.some(l => l.poseData && l.poseData.enabled);
  if (!anyPose) { svg.classList.remove("pose-active"); hideSilhouettePreview(); return; }

  const svgRect = svg.getBoundingClientRect();
  const ar = svgRect.width && svgRect.height ? svgRect.width / svgRect.height : 1;
  svg.setAttribute("viewBox", `0 0 ${ar} 1`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("pose-active");
  svg._poseAspect = ar;

  const activeIdx = layerIdx;
  const poseLayers = [];
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].poseData && layers[i].poseData.enabled) poseLayers.push(i);
  }
  poseLayers.sort((a, b) => (a === activeIdx ? 1 : 0) - (b === activeIdx ? 1 : 0));
  for (const idx of poseLayers) _renderSinglePose(svg, idx, idx === activeIdx, ar);
  _alignOverlayToOutput();
}

function _renderSinglePose(svg, layerIdx, isActive, ar) {
  const layer = layers[layerIdx];
  if (!layer || !layer.poseData || !layer.poseData.enabled) return;

  const rawJ = layer.poseData.joints;
  const j = {};
  for (const name of POSE_JOINTS) {
    if (rawJ[name]) j[name] = [rawJ[name][0] * ar, rawJ[name][1]];
  }

  // Skin color: use custom hex or fallback
  const skin = layer.poseData.skinColor || "#ffdbac";

  const group = document.createElementNS(SVGNS, "g");
  group.setAttribute("opacity", isActive ? "0.35" : "0.2");
  svg.appendChild(group);

  // Reference size: distance from neck to hip midpoint (rotation-invariant)
  const neck = j.neck, lh = j.left_hip, rh = j.right_hip;
  let refSize = 0.25;
  if (neck && lh && rh) refSize = _dist(neck, _mid(lh, rh));

  // ── Draw all body connections as tapered capsules ──
  // This approach works in ANY pose — no polygons that can twist
  for (const [a, b, wfA, wfB] of BODY_CONNECTIONS) {
    if (!j[a] || !j[b]) continue;
    _svgCapsule(group, j[a][0], j[a][1], j[b][0], j[b][1],
      refSize * wfA, refSize * wfB, skin);
  }

  // Fill torso interior (polygon between shoulders and hips)
  if (j.left_shoulder && j.right_shoulder && j.left_hip && j.right_hip) {
    const poly = document.createElementNS(SVGNS, "polygon");
    poly.setAttribute("points", [j.left_shoulder, j.right_shoulder, j.right_hip, j.left_hip].map(p => p.join(",")).join(" "));
    poly.setAttribute("fill", skin);
    poly.style.pointerEvents = "none";
    group.appendChild(poly);
  }

  // Head
  if (j.nose) {
    const headR = refSize * 0.22;
    _svgEllipse(group, j.nose[0], j.nose[1], headR * 0.85, headR, skin);
  }

  // ── Joint circles (only for active layer) ──
  if (isActive) {
    for (const name of POSE_JOINTS) {
      const pos = j[name];
      if (!pos) continue;
      const circle = document.createElementNS(SVGNS, "circle");
      circle.setAttribute("cx", pos[0]);
      circle.setAttribute("cy", pos[1]);
      circle.setAttribute("r", "0.008");
      circle.setAttribute("fill", "var(--accent)");
      circle.setAttribute("stroke", "rgba(255,255,255,0.7)");
      circle.setAttribute("stroke-width", "0.0015");
      circle.dataset.joint = name;
      circle.dataset.layerIdx = String(layerIdx);
      if (_dragState && _dragState.jointName === name && _dragState.layerIdx === layerIdx) {
        circle.classList.add("dragging");
      }
      svg.appendChild(circle);
    }
  }
}

// ── Drag interaction ─────────────────────────────────────

function setupPoseDrag() {
  const svg = document.getElementById("pose-skeleton-overlay");
  if (!svg || svg._poseDragAttached) return;
  svg._poseDragAttached = true;

  svg.addEventListener("mousedown", (e) => {
    const circle = e.target.closest("circle[data-joint]");
    if (!circle) return;
    const jointName = circle.dataset.joint;
    const layerIdx = parseInt(circle.dataset.layerIdx, 10);
    if (isNaN(layerIdx)) return;
    const layer = layers[layerIdx];
    if (!layer || !layer.poseData || !layer.poseData.enabled) return;
    e.preventDefault(); e.stopPropagation();
    circle.classList.add("dragging");

    function onMove(ev) {
      const rect = svg.getBoundingClientRect();
      const nx = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
      layer.poseData.joints[jointName] = [nx, ny];
      renderPoseSkeleton(layerIdx);
    }
    function onUp() {
      _dragState = null;
      saveLayersToStorage();
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    _dragState = { jointName, layerIdx, onMove, onUp };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ── Pan (Shift+drag) ─────────────────────────────────────

function _setupPosePan() {
  const target = document.getElementById("canvas-drop-target");
  if (!target || target._posePanAttached) return;
  target._posePanAttached = true;
  let panState = null;

  target.addEventListener("mousedown", (e) => {
    if (!(e.button === 0 && e.shiftKey) && e.button !== 1) return;
    if (e.target.closest && e.target.closest("circle[data-joint]")) return;
    const activeIdx = typeof _activeLayerIdx === "number" ? _activeLayerIdx : -1;
    const layer = activeIdx >= 0 && activeIdx < layers.length ? layers[activeIdx] : null;
    if (!layer || !layer.poseData || !layer.poseData.enabled) return;
    e.preventDefault(); e.stopPropagation();
    const svg = document.getElementById("pose-skeleton-overlay");
    const rect = svg ? svg.getBoundingClientRect() : target.getBoundingClientRect();
    const startJoints = {};
    for (const name of POSE_JOINTS) {
      if (layer.poseData.joints[name]) startJoints[name] = [...layer.poseData.joints[name]];
    }
    panState = { layerIdx: activeIdx, startClientX: e.clientX, startClientY: e.clientY, rectW: rect.width, rectH: rect.height, startJoints };

    function onMove(ev) {
      if (!panState) return;
      const dx = (ev.clientX - panState.startClientX) / panState.rectW;
      const dy = (ev.clientY - panState.startClientY) / panState.rectH;
      let valid = true;
      for (const name of POSE_JOINTS) {
        if (!panState.startJoints[name]) continue;
        const nx = panState.startJoints[name][0] + dx, ny = panState.startJoints[name][1] + dy;
        if (nx < 0 || nx > 1 || ny < 0 || ny > 1) { valid = false; break; }
      }
      if (!valid) return;
      for (const name of POSE_JOINTS) {
        if (!panState.startJoints[name]) continue;
        layer.poseData.joints[name][0] = panState.startJoints[name][0] + dx;
        layer.poseData.joints[name][1] = panState.startJoints[name][1] + dy;
      }
      renderPoseSkeleton(panState.layerIdx);
    }
    function onUp() {
      if (panState) saveLayersToStorage();
      panState = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ── Scroll-to-scale ──────────────────────────────────────

function _setupPoseScale() {
  const target = document.getElementById("canvas-drop-target");
  if (!target || target._poseScaleAttached) return;
  target._poseScaleAttached = true;

  target.addEventListener("wheel", (e) => {
    const activeIdx = typeof _activeLayerIdx === "number" ? _activeLayerIdx : -1;
    const layer = activeIdx >= 0 && activeIdx < layers.length ? layers[activeIdx] : null;
    if (!layer || !layer.poseData || !layer.poseData.enabled) return;
    if (e.target.closest && e.target.closest("circle[data-joint]")) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.03 : 0.03;
    const joints = layer.poseData.joints;
    let cx = 0, cy = 0, n = 0;
    for (const name of POSE_JOINTS) { if (joints[name]) { cx += joints[name][0]; cy += joints[name][1]; n++; } }
    if (n === 0) return;
    cx /= n; cy /= n;
    let minY = 1, maxY = 0;
    for (const name of POSE_JOINTS) { if (joints[name]) { if (joints[name][1] < minY) minY = joints[name][1]; if (joints[name][1] > maxY) maxY = joints[name][1]; } }
    const newH = (maxY - minY) * (1 + delta);
    if (newH < 0.15 || newH > 1.0) return;
    const f = 1 + delta;
    for (const name of POSE_JOINTS) { if (!joints[name]) continue; const nx = cx + (joints[name][0] - cx) * f; const ny = cy + (joints[name][1] - cy) * f; if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return; }
    for (const name of POSE_JOINTS) { if (!joints[name]) continue; joints[name][0] = cx + (joints[name][0] - cx) * f; joints[name][1] = cy + (joints[name][1] - cy) * f; }
    saveLayersToStorage();
    renderPoseSkeleton(activeIdx);
  }, { passive: false });
}

// ── Public helpers ────────────────────────────────────────

function hideSilhouettePreview() {
  const p = document.getElementById("pose-silhouette-preview");
  if (p) p.style.display = "none";
}
function updateSilhouettePreview() {}

function resetLayerPose(layerIdx) {
  const layer = (layerIdx >= 0 && layerIdx < layers.length) ? layers[layerIdx] : null;
  if (!layer || !layer.poseData) return;
  layer.poseData.joints = getDefaultJoints(layer.poseData.bodyType || "male");
  saveLayersToStorage();
  renderPoseSkeleton(layerIdx);
}

function collectPosePayload() {
  return layers
    .filter((l) => l.poseData && l.poseData.enabled)
    .map((l) => ({
      joints: l.poseData.joints,
      body_type: l.poseData.bodyType || "male",
      skin_tone: l.poseData.skinTone || "light",
    }));
}
