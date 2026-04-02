## 1. Backend — Pose Rendering

- [x] 1.1 Add `PoseJoints`, `PoseFigure`, `RenderPoseRequest`, `RenderPoseResponse` schemas to `backend/models/schemas.py`
- [x] 1.2 Create `backend/api/pose.py` with Pillow rendering logic (black background, OpenPose colored segments, white joint circles)
- [x] 1.3 Add `POST /api/render-pose` route to `backend/api/routes.py`
- [x] 1.4 Verify endpoint returns valid base64 PNG at correct dimensions (manual test or script)

## 2. Frontend — Skeleton Data Model

- [x] 2.1 Define `getDefaultJoints(bodyType)` function in `frontend/js/pose.js` for Adult and Child presets
- [x] 2.2 Extend `saveLayersToStorage()` in `layers.js` to serialize `poseData` (enabled, bodyType, joints, poseStrength)
- [x] 2.3 Extend `loadLayersFromStorage()` in `layers.js` to deserialize `poseData` with backward-compatible defaults

## 3. Frontend — SVG Skeleton Overlay

- [x] 3.1 Add `<svg id="pose-skeleton-overlay">` to `index.html` inside `#canvas-drop-target`
- [x] 3.2 Add CSS for `#pose-skeleton-overlay` (position absolute, inset 0, pointer-events none by default, z-index between inpaint overlay and char markers)
- [x] 3.3 Implement `renderPoseSkeleton(layerIdx)` in `pose.js` — draw joints as `<circle>` and bones as `<line>` using OpenPose colors
- [x] 3.4 Wire `renderPoseSkeleton` to active layer changes (layer tab click, pose toggle, etc.)

## 4. Frontend — Joint Drag Interaction

- [x] 4.1 Implement `setupPoseDrag()` in `pose.js` — mousedown/mousemove/mouseup on SVG overlay
- [x] 4.2 Hit-test: only initiate drag when click is within 20px of a joint circle
- [x] 4.3 During drag: update joint position in real-time, clamp to [0, 1], update connected bone segments
- [x] 4.4 On mouseup: persist updated joints to layer.poseData and save to localStorage
- [x] 4.5 Hover effect: enlarge joint (14→18px), change color to --accent-bright, cursor: grab

## 5. Frontend — Layer Tab Panel Controls

- [x] 5.1 Add Pose section to `_populateLayerPanel()` in `layers.js`: toggle switch, body type dropdown, strength slider, reset button
- [x] 5.2 Toggle switch: enable/disable poseData, show/hide skeleton overlay
- [x] 5.3 Body type dropdown: switch between Adult/Child, reset joints to new preset
- [x] 5.4 Strength slider: range 0.0-1.0, default 0.85, display as percentage
- [x] 5.5 Reset button: restore joints to default pose for current body type

## 6. Frontend — Generate Integration

- [x] 6.1 Implement `collectPosePayload()` in `pose.js` — gather all layers with poseData.enabled
- [x] 6.2 In `generate.js`: before generate, check if any layer has pose enabled
- [x] 6.3 If pose enabled: call `/api/render-pose`, get skeleton image
- [x] 6.4 If pose-only (no layer images): use skeleton as sole img2img input
- [x] 6.5 If pose + layer images: composite skeleton over layer composite at alpha 0.7
- [x] 6.6 Set strength from pose strength slider value
- [x] 6.7 Show "Pose guide active" indicator in canvas prompt bar info area

## 7. Playwright E2E Tests

- [x] 7.1 Test: enable pose toggle → skeleton appears on canvas
- [x] 7.2 Test: drag a joint → joint position updates visually
- [x] 7.3 Test: switch body type → skeleton proportions change
- [x] 7.4 Test: click Reset → skeleton returns to default pose
- [x] 7.5 Test: enable pose + click Generate → `/api/render-pose` is called
- [x] 7.6 Test: refresh page → pose data persists (toggle state, joint positions)
- [x] 7.7 Test: multi-layer pose → each layer has independent skeleton
- [x] 7.8 Test: skeleton does not block character marker interaction
