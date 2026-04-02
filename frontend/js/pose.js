"use strict";

/* ═══════════════════════════════════════════════════════════
   POSE SKELETON — 2D mannequin overlay for canvas
   ═══════════════════════════════════════════════════════════ */

const POSE_JOINTS = [
  "nose", "neck",
  "right_shoulder", "right_elbow", "right_wrist",
  "left_shoulder", "left_elbow", "left_wrist",
  "right_hip", "right_knee", "right_ankle",
  "left_hip", "left_knee", "left_ankle",
  "right_eye", "left_eye", "right_ear", "left_ear",
];

const SKIN_COLORS = { light: "#ffdbac", dark: "#8d5524" };

// Limb definitions: [jointA, jointB, widthA, widthB] (relative to shoulder width)
// widthA = width at jointA end, widthB = width at jointB end (tapered)
const LIMB_PARTS = [
  // Legs (drawn first = behind)
  ["right_hip",      "right_knee",  0.55, 0.40],  // thigh
  ["right_knee",     "right_ankle", 0.38, 0.22],  // calf
  ["left_hip",       "left_knee",   0.55, 0.40],
  ["left_knee",      "left_ankle",  0.38, 0.22],
  // Arms (drawn after legs = in front)
  ["right_shoulder", "right_elbow", 0.38, 0.30],  // upper arm
  ["right_elbow",    "right_wrist", 0.28, 0.18],  // forearm
  ["left_shoulder",  "left_elbow",  0.38, 0.30],
  ["left_elbow",     "left_wrist",  0.28, 0.18],
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
    right_eye: [0.47, 0.06], left_eye: [0.53, 0.06],
    right_ear: [0.44, 0.07], left_ear: [0.56, 0.07],
  };
}

function _childJoints() {
  const adult = getDefaultJoints("adult");
  const adultBodyH = adult.left_ankle[1] - adult.neck[1];
  const s = 0.60 / adultBodyH;
  const neckY = 0.22, neckX = 0.50, an = adult.neck;
  const headJ = new Set(["nose", "right_eye", "left_eye", "right_ear", "left_ear"]);
  const joints = {};
  for (const name of POSE_JOINTS) {
    const [ax, ay] = adult[name];
    const dx = ax - an[0], dy = ay - an[1];
    const hs = headJ.has(name) ? 1.3 : 1;
    joints[name] = [neckX + dx * s * hs, neckY + dy * s * hs];
  }
  return joints;
}

// ── SVG helpers ──────────────────────────────────────────

const SVGNS = "http://www.w3.org/2000/svg";

function _svgTaperedCapsule(svg, x1, y1, x2, y2, w1, w2, fill) {
  // Tapered capsule: w1 at (x1,y1), w2 at (x2,y2)
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const sin = Math.sin(angle), cos = Math.cos(angle);
  const hw1 = w1 / 2, hw2 = w2 / 2;

  // Perpendicular offsets at each end
  const dx1 = hw1 * sin, dy1 = hw1 * cos;
  const dx2 = hw2 * sin, dy2 = hw2 * cos;

  const r1 = hw1, r2 = hw2;
  const path = document.createElementNS(SVGNS, "path");
  const d = [
    // Start at p1 left side, arc over p1 top
    `M ${x1 - dx1} ${y1 + dy1}`,
    `A ${r1} ${r1} 0 0 1 ${x1 + dx1} ${y1 - dy1}`,
    // Line to p2 right side (tapered)
    `L ${x2 + dx2} ${y2 - dy2}`,
    // Arc over p2 bottom
    `A ${r2} ${r2} 0 0 1 ${x2 - dx2} ${y2 + dy2}`,
    // Line back to start
    "Z",
  ].join(" ");
  path.setAttribute("d", d);
  path.setAttribute("fill", fill);
  path.style.pointerEvents = "none";
  svg.appendChild(path);
}

function _svgPolygon(svg, points, fill) {
  const poly = document.createElementNS(SVGNS, "polygon");
  poly.setAttribute("points", points.map(p => p.join(",")).join(" "));
  poly.setAttribute("fill", fill);
  poly.style.pointerEvents = "none";
  svg.appendChild(poly);
}

function _svgEllipse(svg, cx, cy, rx, ry, fill) {
  const el = document.createElementNS(SVGNS, "ellipse");
  el.setAttribute("cx", cx); el.setAttribute("cy", cy);
  el.setAttribute("rx", rx); el.setAttribute("ry", ry);
  el.setAttribute("fill", fill);
  el.style.pointerEvents = "none";
  svg.appendChild(el);
}

function _dist(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
function _mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
function _lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

// ── Module-level state ───────────────────────────────────
let _dragState = null;

// ── Overlay alignment ────────────────────────────────────
// Match SVG overlay position/size to the output image's actual display rect
// (accounts for object-fit: contain letterboxing)

function _alignOverlayToOutput() {
  const svg = document.getElementById("pose-skeleton-overlay");
  if (!svg) return;

  const output = document.getElementById("output");
  const img = output ? output.querySelector("img") : null;
  const cdt = document.getElementById("canvas-drop-target");
  if (!cdt) return;

  const cdtRect = cdt.getBoundingClientRect();

  if (img && img.naturalWidth && img.naturalHeight) {
    // Image exists — align SVG to the image's actual rendered area
    const imgRect = img.getBoundingClientRect();
    svg.style.left   = (imgRect.left - cdtRect.left) + "px";
    svg.style.top    = (imgRect.top - cdtRect.top) + "px";
    svg.style.width  = imgRect.width + "px";
    svg.style.height = imgRect.height + "px";
  } else {
    // No image — fill entire canvas-drop-target
    svg.style.left   = "0";
    svg.style.top    = "0";
    svg.style.width  = "100%";
    svg.style.height = "100%";
  }
}

// ── Render ────────────────────────────────────────────────

function renderPoseSkeleton(layerIdx) {
  const svg = document.getElementById("pose-skeleton-overlay");
  if (!svg) return;

  setupPoseDrag();
  _setupPoseScale();
  _setupPosePan();

  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // Check if ANY layer has pose enabled
  const anyPose = layers.some(l => l.poseData && l.poseData.enabled);
  if (!anyPose) {
    svg.classList.remove("pose-active");
    hideSilhouettePreview();
    return;
  }

  // Use viewBox matching canvas aspect ratio so shapes don't distort
  const svgRect = svg.getBoundingClientRect();
  const ar = svgRect.width && svgRect.height ? svgRect.width / svgRect.height : 1;
  svg.setAttribute("viewBox", `0 0 ${ar} 1`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("pose-active");

  // Store aspect ratio for drag conversion
  svg._poseAspect = ar;

  // Render ALL pose-enabled layers (inactive first, active on top)
  const activeIdx = layerIdx;
  const poseLayers = [];
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].poseData && layers[i].poseData.enabled) poseLayers.push(i);
  }
  poseLayers.sort((a, b) => (a === activeIdx ? 1 : 0) - (b === activeIdx ? 1 : 0));

  for (const idx of poseLayers) {
    _renderSinglePose(svg, idx, idx === activeIdx, ar);
  }

  // Align overlay to match the output image position (handles object-fit: contain)
  _alignOverlayToOutput();
}

function _renderSinglePose(svg, layerIdx, isActive, ar) {
  const layer = layers[layerIdx];
  if (!layer || !layer.poseData || !layer.poseData.enabled) return;

  // Convert stored (0-1, 0-1) joints to viewBox coords (0-ar, 0-1)
  const rawJ = layer.poseData.joints;
  const j = {};
  for (const name of POSE_JOINTS) {
    if (rawJ[name]) j[name] = [rawJ[name][0] * ar, rawJ[name][1]];
  }

  const skinTone = layer.poseData.skinTone || "light";
  const bodyType = layer.poseData.bodyType || "male";
  const skin = SKIN_COLORS[skinTone] || SKIN_COLORS.light;

  // Create a group for this figure
  // Active layers: semi-transparent so layer images show through
  // Inactive layers: even more transparent
  const group = document.createElementNS(SVGNS, "g");
  group.setAttribute("opacity", isActive ? "0.35" : "0.2");
  svg.appendChild(group);

  // Reference measurement: shoulder width (horizontal — correct for body proportions)
  const ls = j.left_shoulder, rs = j.right_shoulder;
  let shoulderW = 0.16; // fallback
  if (ls && rs) shoulderW = Math.abs(ls[0] - rs[0]);

  // Torso height for vertical proportions
  const neck = j.neck, lh = j.left_hip, rh = j.right_hip;
  let torsoH = 0.35;
  if (neck && lh && rh) torsoH = _dist(neck, _mid(lh, rh));

  // ── Draw body (back to front) ──

  // 1. Torso
  _drawTorso(group, j, bodyType, skin, shoulderW, torsoH);

  // 2. Limbs as tapered capsules
  for (const [a, b, wfA, wfB] of LIMB_PARTS) {
    if (!j[a] || !j[b]) continue;
    _svgTaperedCapsule(group,
      j[a][0], j[a][1], j[b][0], j[b][1],
      shoulderW * wfA, shoulderW * wfB, skin);
  }

  // 3. Neck
  if (j.nose && j.neck) {
    _svgTaperedCapsule(group,
      j.neck[0], j.neck[1], j.nose[0], j.nose[1],
      shoulderW * 0.25, shoulderW * 0.20, skin);
  }

  // 4. Head
  if (j.nose) {
    const headR = shoulderW * 0.38;
    _svgEllipse(group, j.nose[0], j.nose[1], headR * 0.82, headR, skin);
  }

  // 5. Joint caps (smooth transitions)
  for (const sj of [j.left_shoulder, j.right_shoulder]) {
    if (sj) _svgEllipse(group, sj[0], sj[1], shoulderW * 0.20, shoulderW * 0.17, skin);
  }
  for (const hj of [j.left_hip, j.right_hip]) {
    if (hj) _svgEllipse(group, hj[0], hj[1], shoulderW * 0.22, shoulderW * 0.17, skin);
  }
  for (const kj of [j.left_knee, j.right_knee]) {
    if (kj) _svgEllipse(group, kj[0], kj[1], shoulderW * 0.18, shoulderW * 0.15, skin);
  }
  for (const ej of [j.left_elbow, j.right_elbow]) {
    if (ej) _svgEllipse(group, ej[0], ej[1], shoulderW * 0.14, shoulderW * 0.12, skin);
  }

  // ── Joint circles (only for active layer — these are the drag handles) ──
  if (isActive) {
    for (const name of POSE_JOINTS) {
      const pos = j[name]; // already ar-scaled
      if (!pos) continue;
      const circle = document.createElementNS(SVGNS, "circle");
      circle.setAttribute("cx", pos[0]);
      circle.setAttribute("cy", pos[1]);
      // Use uniform radius: compensate for aspect ratio so circles look round
      const r = 0.008;
      circle.setAttribute("r", r);
      circle.setAttribute("fill", "var(--accent)");
      circle.setAttribute("stroke", "rgba(255,255,255,0.7)");
      circle.setAttribute("stroke-width", "0.0015");
      circle.dataset.joint = name;
      circle.dataset.layerIdx = String(layerIdx);
      if (_dragState && _dragState.jointName === name && _dragState.layerIdx === layerIdx) {
        circle.classList.add("dragging");
      }
      svg.appendChild(circle); // append to root svg, not group, so they're always on top
    }
  }
}

function _drawTorso(svg, j, bodyType, skin, shoulderW, torsoH) {
  const ls = j.left_shoulder, rs = j.right_shoulder;
  const lhip = j.left_hip, rhip = j.right_hip;
  if (!ls || !rs || !lhip || !rhip) return;

  // Expand outward from joints for body volume
  const shoulderExp = shoulderW * 0.20;
  const hipExp = shoulderW * 0.12;

  const lsE = [ls[0] + shoulderExp, ls[1]];
  const rsE = [rs[0] - shoulderExp, rs[1]];
  const lhE = [lhip[0] + hipExp, lhip[1]];
  const rhE = [rhip[0] - hipExp, rhip[1]];

  if (bodyType === "female") {
    // Hourglass: narrow waist, wider hips
    const waistT = 0.42;
    const lWaist = _lerp(lsE, lhE, waistT);
    const rWaist = _lerp(rsE, rhE, waistT);
    const waistIndent = shoulderW * 0.12;
    lWaist[0] -= waistIndent;
    rWaist[0] += waistIndent;
    const hipExtra = shoulderW * 0.15;
    const lhF = [lhE[0] + hipExtra, lhE[1]];
    const rhF = [rhE[0] - hipExtra, rhE[1]];
    // Add chest area (slight outward at 20%)
    const chestT = 0.18;
    const lChest = _lerp(lsE, lhE, chestT);
    const rChest = _lerp(rsE, rhE, chestT);
    lChest[0] += shoulderW * 0.04;
    rChest[0] -= shoulderW * 0.04;

    _svgPolygon(svg, [lsE, rsE, rChest, rWaist, rhF, lhF, lWaist, lChest], skin);
  } else {
    // Male/child: broad chest, tapered to hips
    const chestT = 0.2;
    const lChest = _lerp(lsE, lhE, chestT);
    const rChest = _lerp(rsE, rhE, chestT);
    // Chest slightly wider than shoulders
    lChest[0] += shoulderW * 0.03;
    rChest[0] -= shoulderW * 0.03;
    // Waist slightly narrower
    const waistT = 0.55;
    const lWaist = _lerp(lsE, lhE, waistT);
    const rWaist = _lerp(rsE, rhE, waistT);
    lWaist[0] -= shoulderW * 0.03;
    rWaist[0] += shoulderW * 0.03;

    _svgPolygon(svg, [lsE, rsE, rChest, rWaist, rhE, lhE, lWaist, lChest], skin);
  }
}

// ── Drag interaction (single joint) ──────────────────────

function setupPoseDrag() {
  const svg = document.getElementById("pose-skeleton-overlay");
  if (!svg || svg._poseDragAttached) return;
  svg._poseDragAttached = true;

  // Re-align overlay when window resizes or output image loads
  window.addEventListener("resize", _alignOverlayToOutput);
  const observer = new MutationObserver(_alignOverlayToOutput);
  const output = document.getElementById("output");
  if (output) observer.observe(output, { childList: true, subtree: true });

  svg.addEventListener("mousedown", (e) => {
    const circle = e.target.closest("circle[data-joint]");
    if (!circle) return;

    const jointName = circle.dataset.joint;
    const layerIdx = parseInt(circle.dataset.layerIdx, 10);
    if (isNaN(layerIdx)) return;

    const layer = layers[layerIdx];
    if (!layer || !layer.poseData || !layer.poseData.enabled) return;

    e.preventDefault();
    e.stopPropagation();
    circle.classList.add("dragging");

    function onMove(ev) {
      const rect = svg.getBoundingClientRect();
      // Convert screen coords to 0-1 normalized joint coords
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

// ── Pan (move entire skeleton) ───────────────────────────

function _setupPosePan() {
  const target = document.getElementById("canvas-drop-target");
  if (!target || target._posePanAttached) return;
  target._posePanAttached = true;

  let panState = null;

  target.addEventListener("mousedown", (e) => {
    const isShiftLeft = e.button === 0 && e.shiftKey;
    const isMiddle = e.button === 1;
    if (!isShiftLeft && !isMiddle) return;
    if (e.target.closest && e.target.closest("circle[data-joint]")) return;

    const activeIdx = typeof _activeLayerIdx === "number" ? _activeLayerIdx : -1;
    const layer = activeIdx >= 0 && activeIdx < layers.length ? layers[activeIdx] : null;
    if (!layer || !layer.poseData || !layer.poseData.enabled) return;

    e.preventDefault();
    e.stopPropagation();

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
      const joints = layer.poseData.joints;
      let valid = true;
      for (const name of POSE_JOINTS) {
        if (!panState.startJoints[name]) continue;
        const nx = panState.startJoints[name][0] + dx;
        const ny = panState.startJoints[name][1] + dy;
        if (nx < 0 || nx > 1 || ny < 0 || ny > 1) { valid = false; break; }
      }
      if (!valid) return;
      for (const name of POSE_JOINTS) {
        if (!panState.startJoints[name]) continue;
        joints[name][0] = panState.startJoints[name][0] + dx;
        joints[name][1] = panState.startJoints[name][1] + dy;
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

// ── Silhouette preview (no longer needed — body is rendered in SVG) ──

function hideSilhouettePreview() {
  const preview = document.getElementById("pose-silhouette-preview");
  if (preview) preview.style.display = "none";
}

// ── Scroll-to-scale skeleton ─────────────────────────────

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
    for (const name of POSE_JOINTS) {
      if (joints[name]) { cx += joints[name][0]; cy += joints[name][1]; n++; }
    }
    if (n === 0) return;
    cx /= n; cy /= n;

    let minY = 1, maxY = 0;
    for (const name of POSE_JOINTS) {
      if (joints[name]) {
        if (joints[name][1] < minY) minY = joints[name][1];
        if (joints[name][1] > maxY) maxY = joints[name][1];
      }
    }
    const newHeight = (maxY - minY) * (1 + delta);
    if (newHeight < 0.15 || newHeight > 1.0) return;

    const factor = 1 + delta;
    for (const name of POSE_JOINTS) {
      if (!joints[name]) continue;
      const nx = cx + (joints[name][0] - cx) * factor;
      const ny = cy + (joints[name][1] - cy) * factor;
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
    }

    for (const name of POSE_JOINTS) {
      if (!joints[name]) continue;
      joints[name][0] = cx + (joints[name][0] - cx) * factor;
      joints[name][1] = cy + (joints[name][1] - cy) * factor;
    }

    saveLayersToStorage();
    renderPoseSkeleton(activeIdx);
  }, { passive: false });
}

// ── Public helpers ────────────────────────────────────────

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

function updateSilhouettePreview() {} // no-op, kept for backward compat
