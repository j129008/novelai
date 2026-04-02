## ADDED Requirements

### Requirement: Skeleton Display
The system SHALL render a 2D pose skeleton as an SVG overlay on the canvas when a layer has pose mode enabled. The skeleton MUST consist of 18 OpenPose-standard joints connected by color-coded bone segments. Each layer SHALL have independent pose data. Only the active layer's skeleton SHALL be visible at any time.

#### Scenario: Enable pose skeleton on a layer
- **WHEN** user toggles the Pose switch ON in the Layer Tab Panel
- **THEN** the canvas displays a skeleton overlay with 18 joints and connecting bone segments in the default standing pose
- **AND** the skeleton uses OpenPose standard colors for each bone segment
- **AND** joints render as circles with `--accent` color (#7c5cfc)

#### Scenario: Switch active layer with pose enabled
- **WHEN** user clicks a different layer tab
- **AND** the newly active layer has pose enabled
- **THEN** the skeleton updates to show the newly active layer's joint positions
- **AND** the previous layer's skeleton is no longer visible

#### Scenario: Disable pose skeleton
- **WHEN** user toggles the Pose switch OFF
- **THEN** the skeleton overlay disappears from the canvas
- **AND** the layer's poseData.enabled is set to false
- **AND** the joint positions are preserved (not reset)

#### Scenario: Skeleton z-order
- **WHEN** both skeleton overlay and character markers exist on canvas
- **THEN** the skeleton SVG renders below character markers (lower z-index)
- **AND** character marker click/drag is not blocked by the skeleton overlay

### Requirement: Joint Dragging
The system SHALL allow users to reposition any skeleton joint by clicking and dragging with the mouse. Joint movement MUST be real-time with no perceptible lag. Only joints within a 20px hit radius SHALL respond to click events.

#### Scenario: Drag a joint to new position
- **WHEN** user presses mouse down on a joint circle
- **AND** drags the mouse to a new position
- **THEN** the joint follows the mouse cursor in real-time
- **AND** all bone segments connected to this joint update their endpoints in real-time
- **AND** cursor shows `grabbing` during drag

#### Scenario: Release joint after drag
- **WHEN** user releases the mouse button after dragging a joint
- **THEN** the joint stays at the release position (does not snap back)
- **AND** the layer's poseData.joints is updated with the new coordinates
- **AND** the change is persisted to localStorage

#### Scenario: Click empty area between joints
- **WHEN** user clicks on the canvas area where no joint is within 20px
- **THEN** no joint drag is initiated
- **AND** existing canvas interactions (character marker drag, canvas pan) work normally

#### Scenario: Drag joint to canvas edge
- **WHEN** user drags a joint beyond the canvas boundary
- **THEN** the joint coordinate is clamped to [0.0, 1.0] range
- **AND** the joint visually stops at the canvas edge

#### Scenario: Hover over joint
- **WHEN** user moves the mouse over a joint circle
- **THEN** the joint circle enlarges (14px → 18px diameter)
- **AND** cursor changes to `grab`
- **AND** joint color changes to `--accent-bright`

### Requirement: Body Type Presets
The system SHALL support Adult and Child body type presets with different proportional defaults. Adult uses a 7:1 head-to-body ratio; Child uses a 5:1 ratio with the overall skeleton scaled to 60% of canvas height.

#### Scenario: Select Child body type
- **WHEN** user changes the Body Type dropdown from Adult to Child
- **THEN** the skeleton resets to the Child default standing pose
- **AND** the skeleton appears shorter with a proportionally larger head
- **AND** the layer's poseData.bodyType is updated to "child"

#### Scenario: Select Adult body type
- **WHEN** user changes the Body Type dropdown from Child to Adult
- **THEN** the skeleton resets to the Adult default standing pose
- **AND** the layer's poseData.bodyType is updated to "adult"

#### Scenario: New layer default body type
- **WHEN** user enables pose mode on a layer for the first time
- **THEN** the body type defaults to "adult"
- **AND** the skeleton appears in the adult default standing pose

### Requirement: Reset Pose
The system SHALL provide a clearly labeled Reset button that restores the skeleton to the default standing pose for the current body type.

#### Scenario: Reset to default pose
- **WHEN** user clicks the "Reset" button in the Pose control area
- **THEN** all 18 joints return to the default standing pose positions for the current body type
- **AND** the skeleton visually updates immediately
- **AND** the change is persisted to localStorage

#### Scenario: Reset preserves body type
- **WHEN** user has set body type to Child and adjusted some joints
- **AND** user clicks Reset
- **THEN** joints reset to the Child default pose (not Adult)
- **AND** the body type dropdown still shows "Child"

### Requirement: Pose Rendering Backend
The system SHALL provide a `POST /api/render-pose` endpoint that accepts joint coordinates and renders an OpenPose-format skeleton image (black background, colored bone segments, white joint circles) using Pillow. The endpoint MUST support multiple figures in a single image.

#### Scenario: Render single figure pose
- **WHEN** frontend sends a POST request to `/api/render-pose` with one figure's joints, width=832, height=1216
- **THEN** the backend returns a base64 PNG image of size 832x1216
- **AND** the image has a black (#000000) background
- **AND** bone segments are drawn as 3px lines in OpenPose standard colors
- **AND** joints are drawn as white circles with radius 5px
- **AND** response time is under 500ms

#### Scenario: Render multiple figures
- **WHEN** frontend sends a POST request with 2 figures (e.g., adult + child)
- **THEN** the backend renders both skeletons on the same black background image
- **AND** each figure's bone segments and joints are independently positioned
- **AND** the response contains a single base64 PNG with all figures

#### Scenario: Invalid joint coordinates
- **WHEN** frontend sends joint coordinates outside [0.0, 1.0] range
- **THEN** the backend clamps values to [0.0, 1.0] before rendering
- **AND** no error is returned

### Requirement: Generate Integration
The system SHALL use the rendered pose skeleton image as img2img input during generation when any layer has pose mode enabled. When pose-only (no layer images), the skeleton image is the sole img2img source. When layers have both images and pose, the skeleton is composited over the layer composite.

#### Scenario: Generate with pose-only (no layer images)
- **WHEN** one or more layers have poseData.enabled === true
- **AND** no layers have imageBase64
- **AND** user clicks Generate
- **THEN** `/api/render-pose` is called with all enabled pose figures
- **AND** the returned skeleton image is set as `body.image` (img2img input)
- **AND** strength is set to the pose strength value (default 0.85)
- **AND** canvas prompt bar shows "Pose guide active" indicator in `--accent-bright` color

#### Scenario: Generate with pose + layer images
- **WHEN** one or more layers have poseData.enabled === true
- **AND** other layers have imageBase64 (visible layer images)
- **AND** user clicks Generate
- **THEN** layers are composited as usual via `compositeLayersToBase64`
- **AND** the pose skeleton image is composited over the layer composite at alpha 0.7
- **AND** the combined image is set as `body.image`

#### Scenario: Generate with no pose enabled
- **WHEN** no layers have poseData.enabled === true
- **THEN** generation proceeds exactly as before (no change to existing behavior)
- **AND** no call to `/api/render-pose` is made

#### Scenario: Pose strength slider
- **WHEN** user adjusts the pose strength slider next to the Pose toggle
- **THEN** the strength value is used for img2img when pose is active
- **AND** the slider range is 0.0 to 1.0 with default 0.85
- **AND** the value is displayed as percentage next to the slider

### Requirement: Data Persistence
The system SHALL persist all pose data (enabled state, body type, joint positions, pose strength) in localStorage alongside existing layer data. Loading layers from storage MUST restore pose data without breaking layers that have no pose data (backward compatibility).

#### Scenario: Save and restore pose data
- **WHEN** user enables pose on a layer, adjusts joints, and refreshes the page
- **THEN** the layer's poseData.enabled is restored as true
- **AND** all joint positions match what was set before refresh
- **AND** the body type is restored
- **AND** the pose strength is restored

#### Scenario: Load legacy layer data without poseData
- **WHEN** localStorage contains layer data from before the pose feature
- **AND** the layers have no poseData field
- **THEN** layers load normally without errors
- **AND** poseData defaults to { enabled: false }
- **AND** no skeleton is shown

### Requirement: Layer Tab Panel Controls
The system SHALL add a Pose control section to the Layer Tab Panel (below existing Scale slider) containing: a labeled Pose toggle switch, a Body Type dropdown (Adult/Child), a Strength slider (0.0-1.0), and a Reset button.

#### Scenario: Pose controls visible in panel
- **WHEN** user opens the Layer Tab Panel for any layer
- **THEN** the panel displays a "Pose" section below the Scale slider
- **AND** the section contains: toggle switch, Body Type dropdown, Strength slider, Reset button
- **AND** the toggle switch label reads "Pose"
- **AND** the Reset button is labeled "Reset" and uses `.ltp-btn` styling

#### Scenario: Pose controls reflect layer state
- **WHEN** user switches between layers with different pose states
- **THEN** the Pose toggle reflects the selected layer's enabled state
- **AND** the Body Type dropdown shows the selected layer's body type
- **AND** the Strength slider shows the selected layer's pose strength
