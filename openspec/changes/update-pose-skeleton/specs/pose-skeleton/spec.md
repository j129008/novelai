## MODIFIED Requirements

### Requirement: Skeleton Display
The system SHALL render a 2D pose skeleton as an SVG overlay on the canvas when a layer has pose mode enabled. The skeleton MUST consist of 18 OpenPose-standard joints connected by color-coded bone segments. Each layer SHALL have independent pose data. Only the active layer's skeleton SHALL be visible at any time. The SVG overlay element MUST use `pointer-events: none` at the root level so that scroll wheel events and canvas interactions pass through the overlay unobstructed. Only `<circle>` joint elements SHALL use `pointer-events: all`.

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

#### Scenario: Scroll wheel passes through skeleton overlay
- **WHEN** pose mode is active and the user rotates the scroll wheel over an area of the canvas that has no joint circle within 20px
- **THEN** the scroll wheel event is NOT consumed by the SVG overlay
- **AND** the canvas zoom level changes as expected (same behavior as when pose is disabled)
- **AND** no joint drag is initiated

#### Scenario: Scroll wheel blocked only at joint circle
- **WHEN** pose mode is active and the user rotates the scroll wheel directly over a joint circle
- **THEN** the scroll event may be consumed by the circle's pointer-events area
- **AND** this is acceptable because the user is hovering directly on a draggable control

### Requirement: Joint Dragging
The system SHALL allow users to reposition any skeleton joint by clicking and dragging with the mouse. Joint movement MUST be real-time with no perceptible lag. Only the `<circle>` elements SHALL respond to mousedown events; the SVG background area MUST pass all pointer events through to underlying canvas elements.

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
- **WHEN** user clicks on the canvas area where no joint circle is located
- **THEN** no joint drag is initiated
- **AND** existing canvas interactions (character marker drag, canvas pan, zoom) work normally

#### Scenario: Drag joint to canvas edge
- **WHEN** user drags a joint beyond the canvas boundary
- **THEN** the joint coordinate is clamped to [0.0, 1.0] range
- **AND** the joint visually stops at the canvas edge

#### Scenario: Hover over joint
- **WHEN** user moves the mouse over a joint circle
- **THEN** the joint circle enlarges (14px → 18px diameter)
- **AND** cursor changes to `grab`
- **AND** joint color changes to `--accent-bright`

#### Scenario: Ankle joint reachable via scroll
- **WHEN** the canvas is zoomed out such that ankle joints are near the bottom of the visible area
- **AND** user scrolls the canvas to bring ankle joints into comfortable reach
- **THEN** user can then mousedown on the ankle joint circle and drag it successfully
- **AND** this requires scroll to work while pose is active (depends on Scroll wheel passes through skeleton overlay scenario)

### Requirement: Body Type Presets
The system SHALL support Male, Female, and Child body type presets. Male and Female are adult body types with different proportional silhouettes; Child uses a 5:1 head-to-body ratio scaled to 60% of canvas height. The default body type for new layers SHALL be "male". Legacy data with `bodyType: "adult"` MUST be automatically migrated to "male" on load without error or data loss.

#### Scenario: Select Female body type
- **WHEN** user changes the Body Type dropdown to Female
- **THEN** the skeleton resets to the Female default standing pose
- **AND** the layer's poseData.bodyType is updated to "female"
- **AND** when generated, the backend renders a silhouette with narrower shoulders relative to hips

#### Scenario: Select Male body type
- **WHEN** user changes the Body Type dropdown to Male
- **THEN** the skeleton resets to the Male default standing pose
- **AND** the layer's poseData.bodyType is updated to "male"
- **AND** when generated, the backend renders a silhouette with wider shoulders relative to hips

#### Scenario: Select Child body type
- **WHEN** user changes the Body Type dropdown to Child
- **THEN** the skeleton resets to the Child default standing pose
- **AND** the skeleton appears shorter with a proportionally larger head
- **AND** the layer's poseData.bodyType is updated to "child"

#### Scenario: New layer default body type
- **WHEN** user enables pose mode on a layer for the first time
- **THEN** the body type defaults to "male"
- **AND** the skeleton appears in the male adult default standing pose

#### Scenario: Body type dropdown options
- **WHEN** user opens the Body Type dropdown
- **THEN** the available options are Male, Female, Child (in that order)
- **AND** the option previously labeled "Adult" does NOT appear

#### Scenario: Migrate legacy adult body type
- **WHEN** the app loads localStorage data that contains `poseData.bodyType === "adult"`
- **THEN** the bodyType is silently remapped to "male"
- **AND** no error is thrown
- **AND** the Pose controls display "Male" in the Body Type dropdown
- **AND** joint positions from the legacy data are preserved unchanged

### Requirement: Reset Pose
The system SHALL provide a clearly labeled Reset button that restores the skeleton to the default standing pose for the current body type.

#### Scenario: Reset to default pose
- **WHEN** user clicks the "Reset Pose" button in the Pose control area
- **THEN** all 18 joints return to the default standing pose positions for the current body type
- **AND** the skeleton visually updates immediately
- **AND** the change is persisted to localStorage

#### Scenario: Reset preserves body type
- **WHEN** user has set body type to Female and adjusted some joints
- **AND** user clicks Reset Pose
- **THEN** joints reset to the Female default pose (not Male)
- **AND** the body type dropdown still shows "Female"

### Requirement: Pose Rendering Backend
The system SHALL provide a `POST /api/render-pose` endpoint that accepts joint coordinates, body type, and skin tone, then renders a filled human body silhouette (mannequin style) using Pillow. The rendered image MUST have a light gray background (#e8e8e8) and skin-colored filled body parts. The endpoint MUST support multiple figures in a single image. Stick-figure bone lines are NOT rendered in the default output.

#### Scenario: Render male silhouette
- **WHEN** frontend sends POST `/api/render-pose` with one figure, body_type="male", skin_tone="light", width=832, height=1216
- **THEN** the backend returns a base64 PNG image of size 832×1216
- **AND** the background is light gray (#e8e8e8), NOT black
- **AND** the silhouette is filled with skin color RGB(255, 219, 172)
- **AND** the shoulder width is visibly wider than the hip width (inverted trapezoid torso)
- **AND** all limb segments are rendered as filled capsule shapes (rounded rectangles)
- **AND** response time is under 500ms

#### Scenario: Render female silhouette
- **WHEN** frontend sends POST `/api/render-pose` with one figure, body_type="female", skin_tone="light", width=832, height=1216
- **THEN** the torso polygon has hip width approximately equal to or wider than shoulder width
- **AND** the torso uses an 8-vertex polygon to approximate a waist curve
- **AND** overall structure is visually recognizable as a standing human female figure

#### Scenario: Render child silhouette
- **WHEN** frontend sends POST `/api/render-pose` with one figure, body_type="child"
- **THEN** the rendered silhouette is proportionally shorter with a relatively larger head
- **AND** the overall figure height is approximately 60% of the canvas height

#### Scenario: Render dark skin tone
- **WHEN** frontend sends POST `/api/render-pose` with skin_tone="dark"
- **THEN** the silhouette fill color is RGB(141, 85, 36) instead of RGB(255, 219, 172)

#### Scenario: Render multiple figures
- **WHEN** frontend sends POST with 2 figures (e.g., male + child)
- **THEN** the backend renders both silhouettes on the same light gray background image
- **AND** each figure is independently positioned
- **AND** the response contains a single base64 PNG with all figures

#### Scenario: Invalid joint coordinates
- **WHEN** frontend sends joint coordinates outside [0.0, 1.0] range
- **THEN** the backend clamps values to [0.0, 1.0] before rendering
- **AND** no error is returned

#### Scenario: No bone lines in default output
- **WHEN** frontend calls `/api/render-pose` without a debug flag
- **THEN** the response image contains NO colored stick-figure bone lines
- **AND** the image contains ONLY filled body part shapes and background

### Requirement: Generate Integration
The system SHALL use the rendered pose silhouette image as img2img input during generation when any layer has pose mode enabled. When pose-only (no layer images), the silhouette image is the sole img2img source. When layers have both images and pose, the silhouette is composited over the layer composite.

#### Scenario: Generate with pose-only (no layer images)
- **WHEN** one or more layers have poseData.enabled === true
- **AND** no layers have imageBase64
- **AND** user clicks Generate
- **THEN** `/api/render-pose` is called with all enabled pose figures
- **AND** the returned silhouette image is set as `body.image` (img2img input)
- **AND** strength is set to the pose strength value (default 0.85)
- **AND** canvas prompt bar shows "Pose guide active" indicator in `--accent-bright` color

#### Scenario: Generate with pose + layer images
- **WHEN** one or more layers have poseData.enabled === true
- **AND** other layers have imageBase64 (visible layer images)
- **AND** user clicks Generate
- **THEN** layers are composited as usual via `compositeLayersToBase64`
- **AND** the pose silhouette image is composited over the layer composite at alpha 0.7
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
The system SHALL persist all pose data (enabled state, body type, joint positions, pose strength, skin tone) in localStorage alongside existing layer data. Loading layers from storage MUST restore pose data without breaking layers that have no pose data (backward compatibility). Legacy `bodyType: "adult"` values MUST be silently migrated to "male" on load.

#### Scenario: Save and restore pose data
- **WHEN** user enables pose on a layer, adjusts joints, sets body type to Female, and refreshes the page
- **THEN** the layer's poseData.enabled is restored as true
- **AND** all joint positions match what was set before refresh
- **AND** the body type is restored as "female"
- **AND** the pose strength is restored

#### Scenario: Load legacy layer data without poseData
- **WHEN** localStorage contains layer data from before the pose feature
- **AND** the layers have no poseData field
- **THEN** layers load normally without errors
- **AND** poseData defaults to `{ enabled: false }`
- **AND** no skeleton is shown

#### Scenario: Load legacy layer data with adult bodyType
- **WHEN** localStorage contains poseData with `bodyType: "adult"`
- **THEN** bodyType is automatically remapped to "male" on load
- **AND** no error is thrown
- **AND** joint positions are preserved

### Requirement: Layer Tab Panel Controls
The system SHALL add a Pose control section to the Layer Tab Panel (below existing Scale slider) containing: a labeled Pose toggle switch, a Body Type dropdown (Male/Female/Child), a Strength slider (0.0-1.0), and a Reset Pose button.

#### Scenario: Pose controls visible in panel
- **WHEN** user opens the Layer Tab Panel for any layer
- **THEN** the panel displays a "Pose" section below the Scale slider
- **AND** the section contains: toggle switch, Body Type dropdown, Strength slider, Reset Pose button
- **AND** the toggle switch label reads "Pose"
- **AND** the Reset button is labeled "Reset Pose" and uses `.ltp-btn` styling

#### Scenario: Body type dropdown shows male female child
- **WHEN** user opens the Body Type dropdown in the Pose section
- **THEN** the options are "Male", "Female", "Child" in that order
- **AND** there is no "Adult" option

#### Scenario: Pose controls reflect layer state
- **WHEN** user switches between layers with different pose states
- **THEN** the Pose toggle reflects the selected layer's enabled state
- **AND** the Body Type dropdown shows the selected layer's body type
- **AND** the Strength slider shows the selected layer's pose strength

### Requirement: Silhouette Preview
The system SHALL display a live preview of the rendered silhouette (mannequin) on the canvas behind the SVG skeleton overlay. When the user adjusts joints, body type, or skin tone, the preview MUST update to reflect the changes. The preview allows users to see what the img2img input will look like before generating.

#### Scenario: Silhouette preview appears when pose is enabled
- **WHEN** user enables pose mode on a layer
- **THEN** a silhouette preview image appears on the canvas behind the skeleton overlay
- **AND** the silhouette shows a filled body shape matching the current joint positions, body type, and skin tone
- **AND** the silhouette has a light gray background (#e8e8e8)

#### Scenario: Silhouette preview updates on joint drag
- **WHEN** user finishes dragging a joint (mouseup)
- **THEN** the silhouette preview re-renders with the updated joint positions
- **AND** the update happens within 1 second of mouseup

#### Scenario: Silhouette preview updates on body type change
- **WHEN** user changes the Body Type dropdown (e.g., Male → Female)
- **THEN** the silhouette preview re-renders with the new body type silhouette

#### Scenario: Silhouette preview updates on skin tone change
- **WHEN** user changes the Skin Tone dropdown (e.g., Light → Dark)
- **THEN** the silhouette preview re-renders with the new skin tone color

#### Scenario: Silhouette preview hidden when pose is disabled
- **WHEN** user disables pose mode on a layer
- **THEN** the silhouette preview image is removed from the canvas

### Requirement: Skeleton Scale via Scroll Wheel
The system SHALL allow users to scale the entire skeleton figure (all joints proportionally) using the scroll wheel or trackpad pinch gesture while hovering over the canvas area outside of joint circles. Scaling SHALL be centered on the skeleton's center point (average of all joint positions). This allows users to make the posed figure larger or smaller to control how much of the canvas the character occupies.

#### Scenario: Scroll wheel scales skeleton up
- **WHEN** pose mode is active
- **AND** user scrolls up (or pinch-expands on trackpad) over an area with no joint circle
- **THEN** all joint positions scale outward from the skeleton's center point
- **AND** the skeleton appears larger on the canvas
- **AND** the silhouette preview updates to match

#### Scenario: Scroll wheel scales skeleton down
- **WHEN** pose mode is active
- **AND** user scrolls down (or pinch-contracts on trackpad) over an area with no joint circle
- **THEN** all joint positions scale inward toward the skeleton's center point
- **AND** the skeleton appears smaller on the canvas
- **AND** the silhouette preview updates to match

#### Scenario: Scale clamped to reasonable range
- **WHEN** user scrolls to scale the skeleton
- **THEN** the scale factor is limited so joints never go outside [0.0, 1.0] range
- **AND** the skeleton cannot be scaled smaller than 20% of canvas height
- **AND** the skeleton cannot be scaled larger than 100% of canvas height

#### Scenario: Scale persists after page refresh
- **WHEN** user scales the skeleton and refreshes the page
- **THEN** the scaled joint positions are restored from localStorage
- **AND** the skeleton appears at the same size as before refresh

### Requirement: Skeleton Pan (Move Entire Figure)
The system SHALL allow users to move the entire skeleton figure by Shift+drag or middle-click drag on the canvas area. All joints move together by the same offset. This allows positioning the figure at any location on the canvas.

#### Scenario: Shift+drag moves entire skeleton
- **WHEN** pose mode is active
- **AND** user holds Shift and drags on the canvas (not on a joint circle)
- **THEN** all joint positions translate by the same offset
- **AND** the skeleton moves as a unit on the canvas
- **AND** the silhouette preview updates to match

#### Scenario: Pan clamped to canvas bounds
- **WHEN** user shift+drags the skeleton toward the edge
- **AND** any joint would go outside [0.0, 1.0] range
- **THEN** the movement stops at the boundary
- **AND** no joints exceed the valid range

#### Scenario: Pan persists after page refresh
- **WHEN** user moves the skeleton and refreshes the page
- **THEN** the moved joint positions are restored from localStorage

### Requirement: Silhouette-Skeleton Alignment
The silhouette preview image MUST align precisely with the SVG skeleton overlay. The render-pose API call for preview MUST use the same aspect ratio as the canvas display area to prevent distortion. Both the SVG (viewBox 0 0 1 1, preserveAspectRatio none) and the silhouette image (object-fit fill) map 0-1 normalized coordinates to the full display area.

#### Scenario: Silhouette aligns with skeleton joints
- **WHEN** pose mode is active and silhouette preview is visible
- **THEN** the silhouette body parts (head, torso, limbs) are centered on the corresponding skeleton joints
- **AND** the render-pose API is called with width/height matching the canvas aspect ratio

### Requirement: Canvas View Isolation
When the user is viewing Input mode, generated images MUST NOT be inserted into the output area. The generated image SHALL only appear when switching to Output mode. The pose overlay size MUST remain consistent — it SHALL always fill the canvas-drop-target area regardless of whether a generated image exists.

#### Scenario: Generate in Input view does not overwrite
- **WHEN** user is in Input view with pose overlay visible
- **AND** a generation completes
- **THEN** the generated image is NOT placed in #output
- **AND** the pose overlay remains visible at the same size
- **AND** the Output button shows a change indicator dot

#### Scenario: Pose overlay size stays consistent
- **WHEN** user sets up a pose figure in Input view
- **AND** then generates an image
- **AND** switches between Input and Output
- **THEN** the pose overlay always fills the entire canvas-drop-target
- **AND** the mannequin does NOT shrink or reposition

### Requirement: Prevent Browser Zoom
When pose mode is active, the system SHALL prevent browser zoom (Ctrl+scroll / trackpad pinch) on the canvas area. All wheel events on the canvas area while pose is active SHALL be consumed by the skeleton scale handler, preventing the browser from interpreting them as page zoom.

#### Scenario: Trackpad pinch does not zoom browser
- **WHEN** pose mode is active
- **AND** user performs a pinch gesture on the trackpad over the canvas
- **THEN** the browser zoom level does NOT change
- **AND** the skeleton scales instead
