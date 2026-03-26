# UI Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Craft feature, slim down image-actions bar with overflow menu, add text labels to prompt buttons, surface Steps/Scale sliders, and hide empty gallery filters.

**Architecture:** Pure frontend changes — HTML/CSS/JS only, no backend modifications. Each task is independent and can be committed separately.

**Tech Stack:** Vanilla HTML/CSS/JS

---

### Task 1: Remove Craft

**Files:**
- Delete: `frontend/js/craft.js`
- Modify: `frontend/index.html` — remove Craft tab, panel, script tag
- Modify: `frontend/js/gallery.js` — remove Craft tab/panel references
- Modify: `frontend/js/app.js` — remove `setupCraftPanel()` call
- Modify: `frontend/css/style.css` — remove all `.craft-*` styles

- [ ] **Step 1: Remove Craft tab button from index.html**
  - Line ~860: delete `<button class="canvas-tab" id="tab-craft" type="button">Craft</button>`

- [ ] **Step 2: Remove Craft panel from index.html**
  - Lines ~1015-1081: delete entire `<div id="panel-craft" ...>...</div>`

- [ ] **Step 3: Remove craft.js script tag from index.html**
  - Line ~1146: delete `<script src="js/craft.js?v=120"></script>`

- [ ] **Step 4: Remove Craft references from gallery.js**
  - Line 13: remove `const tabCraft = $("#tab-craft");`
  - Line 17: remove `const panelCraft = $("#panel-craft");`
  - Line 30: remove `if (tabCraft) tabCraft.classList.remove("canvas-tab--active");`
  - Line 37: remove `if (panelCraft) panelCraft.style.display = "none";`
  - Lines 64-71: remove entire `function showCraft()`
  - Line 84: remove `if (tabCraft) tabCraft.addEventListener("click", showCraft);`
  - Lines 89,92: remove craft fallback in savedTab logic

- [ ] **Step 5: Remove setupCraftPanel() from app.js**
  - Line ~1391: remove `setupCraftPanel();`

- [ ] **Step 6: Remove all .craft-* CSS from style.css**
  - Lines ~2599-2905: delete entire craft CSS block

- [ ] **Step 7: Delete craft.js file**

- [ ] **Step 8: Commit**
  ```
  git commit -m "remove: Craft tab and all related code"
  ```

---

### Task 2: Image-actions bar overflow menu

**Files:**
- Modify: `frontend/index.html` — restructure image-actions with primary + overflow
- Modify: `frontend/css/style.css` — add overflow menu styles
- Modify: `frontend/js/app.js` — add overflow toggle logic

Primary buttons (always visible): Download, Refine Prompt, Reuse Seed, Clear
Overflow buttons (behind `...`): Set as Source, Send to Layer, Edit in Grok, Animate in Grok

- [ ] **Step 1: Restructure HTML — wrap overflow buttons in a menu container**
  In `#image-actions .action-group`, add a wrapper div around the secondary buttons with a toggle button.

- [ ] **Step 2: Add CSS for overflow menu**
  ```css
  .action-overflow { position: relative; }
  .action-overflow-btn { /* ... toggle button */ }
  .action-overflow-menu { display: none; position: absolute; bottom: 100%; right: 0; /* dropdown going up */ }
  .action-overflow-menu.open { display: flex; flex-direction: column; }
  ```

- [ ] **Step 3: Add JS toggle for overflow menu**
  Click `...` button → toggle `.open` on menu. Click outside → close.

- [ ] **Step 4: Commit**
  ```
  git commit -m "feat: image-actions overflow menu for secondary actions"
  ```

---

### Task 3: Prompt button text labels

**Files:**
- Modify: `frontend/index.html` — add short text labels to the 3 prompt buttons
- Modify: `frontend/css/style.css` — restyle buttons from icon-only to icon+text, reposition

- [ ] **Step 1: Update HTML — add text spans to buttons**
  Change from icon-only to icon + short label: "Optimize", "AI", "History"

- [ ] **Step 2: Update CSS — change from absolute-positioned icons to inline row**
  Move buttons from overlaid on textarea to a small toolbar row below or beside the textarea.

- [ ] **Step 3: Commit**
  ```
  git commit -m "feat: add text labels to prompt toolbar buttons"
  ```

---

### Task 4: Surface Steps + Scale sliders from settings popover

**Files:**
- Modify: `frontend/index.html` — move Steps and Scale sliders out of `#gen-settings-popover` into main sidebar
- Modify: `frontend/css/style.css` — adjust layout for inline sliders

- [ ] **Step 1: Move Steps and Scale HTML from popover to main controls area**
  Place them between the Provider/Canvas row and the Seed row.

- [ ] **Step 2: Adjust CSS for the new slider placement**

- [ ] **Step 3: Commit**
  ```
  git commit -m "feat: surface Steps and Scale sliders in main sidebar"
  ```

---

### Task 5: Hide empty gallery filters

**Files:**
- Modify: `frontend/js/gallery.js` — after rendering, hide filter buttons with zero count

- [ ] **Step 1: After `renderGallery()`, count items per filter type and hide zero-count buttons**

- [ ] **Step 2: Commit**
  ```
  git commit -m "feat: auto-hide gallery filters with no matching items"
  ```
