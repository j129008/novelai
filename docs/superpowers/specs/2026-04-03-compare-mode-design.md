# Input/Output Compare Mode

## Purpose
Allow users to compare the pose input (mannequin + layers) against the generated output to verify alignment, iterate on poses, and evaluate composition differences.

## UI Location
Three icon buttons added next to `Input | Output` toggle: `Split | Blend | Flash`. Disabled when no generated image exists.

```
[Input] [Output]  [Split] [Blend] [Flash]
```

## Modes

### Split (Vertical Divider)
- Two `<img>` elements stacked in `#output`: input composite on left, output on right
- Vertical divider line (2px, white with drop shadow) separates them
- CSS `clip-path: inset(0 X% 0 0)` on output, `clip-path: inset(0 0 0 X%)` on input
- Divider draggable left/right via mousedown/mousemove on the divider element
- Default position: 50%

### Blend (Opacity Overlay)
- Output `<img>` overlaid on input `<img>` with adjustable opacity
- Small horizontal slider appears at bottom of canvas area
- Slider range 0-100%: 0% = pure input, 100% = pure output
- Default: 50%

### Flash (Quick Toggle)
- Hold spacebar: shows input. Release: shows output
- Alternative: click Flash button to start auto-flash at 500ms interval, click again to stop
- Simple `display` toggle between two pre-loaded `<img>` elements

## Behavior Rules
- Entering any compare mode hides pose skeleton overlay
- Clicking `Input` or `Output` exits compare mode (returns to normal)
- Clicking the active compare button again toggles it off
- All three buttons disabled when `state.lastGeneratedImageBase64` is null
- Compare mode uses the current layer composite as "input" and `state.lastGeneratedImageBase64` as "output"

## Input Image Source
The input image for comparison is the **img2img composite** that was sent to the API (layers + pose silhouette blend). This is stored at generation time so the comparison shows exactly what the model received.

## Implementation
- All code in `layers.js` inside `setupCanvasViewToggle()`
- Three `<button>` elements added to `#canvas-view-toggle` area in `index.html`
- Two `<img>` elements created dynamically when entering compare mode, removed on exit
- Split divider is a `<div>` positioned absolutely, drag via pointer events
- Blend slider is a `<input type="range">` appended to the compare container
- Flash uses `document.addEventListener("keydown"/"keyup")` for spacebar

## HTML Changes
Add buttons to `index.html` in the canvas view toggle area:
```html
<button id="cvt-split" class="cvt-btn" disabled title="Split compare">Split</button>
<button id="cvt-blend" class="cvt-btn" disabled title="Blend compare">Blend</button>
<button id="cvt-flash" class="cvt-btn" disabled title="Flash compare">Flash</button>
```

## CSS
- `.compare-container`: position absolute, inset 0, z-index above output
- `.compare-divider`: position absolute, width 2px, height 100%, background white, cursor ew-resize, box-shadow
- `.compare-slider`: position absolute, bottom 16px, left/right 20%, z-index above compare images

## State
- `state.lastImg2imgInput`: stored at generation time (the composite sent to API)
- `_compareMode`: null | "split" | "blend" | "flash"
- `_splitPosition`: 0-1, default 0.5
- `_blendOpacity`: 0-1, default 0.5
