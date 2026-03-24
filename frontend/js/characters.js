/* ═══════════════════════════════════════════════════════════
   CHARACTERS
   ═══════════════════════════════════════════════════════════ */

const MAX_CHARACTERS = 6;

function setupCharacters() {
  const addBtnEmpty  = $("#btn-add-character");
  const addBtnInline = $("#btn-add-character-inline");
  const slotsEl      = $("#character-slots");
  const accordion    = $("#characters-accordion");
  const badge        = $("#char-count-badge");
  const emptyState   = $("#char-empty-state");

  if (!slotsEl) return;

  // Show/hide markers when accordion opens/closes
  if (accordion) {
    accordion.addEventListener("toggle", () => renderCharacterMarkers());
  }

  function handleAddClick() {
    if (characters.length >= MAX_CHARACTERS) return;
    if (accordion && !accordion.open) accordion.open = true;
    addCharacterSlot(slotsEl, updateCharacterUI);
  }

  if (addBtnEmpty)  addBtnEmpty.addEventListener("click", handleAddClick);
  if (addBtnInline) addBtnInline.addEventListener("click", handleAddClick);

  function updateCharacterUI() {
    const count = characters.length;
    const isEmpty = count === 0;

    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? "inline-flex" : "none";
    }

    if (emptyState) emptyState.style.display = isEmpty ? "flex" : "none";

    if (addBtnInline) {
      addBtnInline.style.display = isEmpty ? "none" : "";
      addBtnInline.disabled = count >= MAX_CHARACTERS;
    }

    const sceneLabel = $("#scene-label");
    if (sceneLabel) sceneLabel.style.display = count > 0 ? "" : "none";

    updateCountSuggestionChip(count);
  }

  // Restore cached characters on page load
  const cached = loadCharactersFromCache();
  if (cached.length > 0) {
    // Pre-populate characters array from cache, then create UI slots
    cached.forEach((c) => {
      characters.push(c);
      // Build the DOM card for this character
      const card = document.createElement("div");
      card.className = "char-slot-card";
      card.dataset.idx = String(characters.length - 1);

      const cardHeader = document.createElement("div");
      cardHeader.className = "char-slot-header";
      const cardLabel = document.createElement("span");
      cardLabel.className = "char-slot-label";
      cardLabel.textContent = `Character ${characters.length}`;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "char-slot-remove";
      removeBtn.title = "Remove character";
      removeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
      removeBtn.addEventListener("click", () => {
        const cardIdx = parseInt(card.dataset.idx);
        characters.splice(cardIdx, 1);
        card.remove();
        slotsEl.querySelectorAll(".char-slot-card").forEach((cc, ii) => {
          cc.dataset.idx = ii;
          const lbl = cc.querySelector(".char-slot-label");
          if (lbl) lbl.textContent = `Character ${ii + 1}`;
        });
        if (_activeMarkerIdx >= characters.length) _activeMarkerIdx = -1;
        updateCharacterUI();
        renderCharacterMarkers();
        saveCharactersToCache();
      });
      const moveUpBtn = document.createElement("button");
      moveUpBtn.type = "button";
      moveUpBtn.className = "char-slot-move";
      moveUpBtn.title = "Move up";
      moveUpBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
      moveUpBtn.addEventListener("click", () => swapCharacterSlots(slotsEl, parseInt(card.dataset.idx), parseInt(card.dataset.idx) - 1));

      const moveDownBtn = document.createElement("button");
      moveDownBtn.type = "button";
      moveDownBtn.className = "char-slot-move";
      moveDownBtn.title = "Move down";
      moveDownBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
      moveDownBtn.addEventListener("click", () => swapCharacterSlots(slotsEl, parseInt(card.dataset.idx), parseInt(card.dataset.idx) + 1));

      cardHeader.appendChild(cardLabel);
      cardHeader.appendChild(moveUpBtn);
      cardHeader.appendChild(moveDownBtn);
      cardHeader.appendChild(removeBtn);

      const ta = document.createElement("textarea");
      ta.className = "char-slot-textarea field-textarea";
      ta.rows = 3;
      ta.placeholder = "girl, blonde hair, blue eyes, waving";
      ta.spellcheck = false;
      ta.value = c.prompt;
      ta.addEventListener("input", () => {
        c.prompt = ta.value;
        ta.style.height = "auto";
        ta.style.height = ta.scrollHeight + "px";
        saveCharactersToCache();
      });
      _tagAC.attach(ta);

      card.appendChild(cardHeader);
      card.appendChild(ta);
      card.appendChild(buildInteractionsSection(c));
      slotsEl.appendChild(card);
    });
    if (accordion) accordion.open = true;
    updateCharacterUI();
    renderCharacterMarkers();
  }
}

function swapCharacterSlots(slotsEl, fromIdx, toIdx) {
  if (toIdx < 0 || toIdx >= characters.length) return;
  // Swap in array
  [characters[fromIdx], characters[toIdx]] = [characters[toIdx], characters[fromIdx]];
  // Swap in DOM
  const cards = [...slotsEl.querySelectorAll(".char-slot-card")];
  const fromCard = cards[fromIdx];
  const toCard = cards[toIdx];
  if (fromIdx < toIdx) {
    slotsEl.insertBefore(toCard, fromCard);
  } else {
    slotsEl.insertBefore(fromCard, toCard);
  }
  // Re-index
  slotsEl.querySelectorAll(".char-slot-card").forEach((c, i) => {
    c.dataset.idx = i;
    const lbl = c.querySelector(".char-slot-label");
    if (lbl) lbl.textContent = `Character ${i + 1}`;
  });
  renderCharacterMarkers();
  saveCharactersToCache();
}

function addCharacterSlot(slotsEl, updateCharacterUI) {
  const idx = characters.length;
  const charData = { prompt: "", x: 0.5, y: 0.5, positionAuto: true, interactions: [] };
  characters.push(charData);

  const card = document.createElement("div");
  card.className = "char-slot-card";
  card.dataset.idx = idx;

  // ── Card header ──────────────────────────────────────────
  const cardHeader = document.createElement("div");
  cardHeader.className = "char-slot-header";

  const cardLabel = document.createElement("span");
  cardLabel.className = "char-slot-label";
  cardLabel.textContent = `Character ${idx + 1}`;

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "char-slot-remove";
  removeBtn.title = "Remove character";
  removeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
  removeBtn.addEventListener("click", () => {
    const cardIdx = parseInt(card.dataset.idx);
    characters.splice(cardIdx, 1);
    card.remove();
    slotsEl.querySelectorAll(".char-slot-card").forEach((c, i) => {
      c.dataset.idx = i;
      const lbl = c.querySelector(".char-slot-label");
      if (lbl) lbl.textContent = `Character ${i + 1}`;
    });
    if (_activeMarkerIdx >= characters.length) _activeMarkerIdx = -1;
    updateCharacterUI();
    renderCharacterMarkers();
    saveCharactersToCache();
  });

  const moveUpBtn = document.createElement("button");
  moveUpBtn.type = "button";
  moveUpBtn.className = "char-slot-move";
  moveUpBtn.title = "Move up";
  moveUpBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
  moveUpBtn.addEventListener("click", () => {
    const i = parseInt(card.dataset.idx);
    swapCharacterSlots(slotsEl, i, i - 1);
  });

  const moveDownBtn = document.createElement("button");
  moveDownBtn.type = "button";
  moveDownBtn.className = "char-slot-move";
  moveDownBtn.title = "Move down";
  moveDownBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  moveDownBtn.addEventListener("click", () => {
    const i = parseInt(card.dataset.idx);
    swapCharacterSlots(slotsEl, i, i + 1);
  });

  cardHeader.appendChild(cardLabel);
  cardHeader.appendChild(moveUpBtn);
  cardHeader.appendChild(moveDownBtn);
  cardHeader.appendChild(removeBtn);

  // ── Textarea with auto-grow ──────────────────────────────
  const ta = document.createElement("textarea");
  ta.className = "char-slot-textarea field-textarea";
  ta.rows = 2;
  ta.placeholder = "girl, blonde hair, blue eyes, waving";
  ta.spellcheck = false;
  ta.addEventListener("input", () => {
    charData.prompt = ta.value;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
    saveCharactersToCache();
  });
  // Attach shared tag autocomplete
  _tagAC.attach(ta);

  // ── Feature 4: Interactions section ─────────────────────
  const interactionsSection = buildInteractionsSection(charData);

  // ── Assemble card ────────────────────────────────────────
  card.appendChild(cardHeader);
  card.appendChild(ta);
  card.appendChild(interactionsSection);

  slotsEl.appendChild(card);
  updateCharacterUI();
  renderCharacterMarkers();
  saveCharactersToCache();
  ta.focus();
}

// ── Canvas character markers ─────────────────────────────────
// Persistent draggable markers overlaid directly on #output.
// renderCharacterMarkers() is called whenever characters change.

let _activeMarkerIdx = -1; // which marker is currently "selected" (highlighted)

function renderCharacterMarkers() {
  const outputEl = $("#output");
  if (!outputEl) return;

  // Grok has no character positioning — skip
  const provider = document.getElementById("provider")?.value || "novelai";
  if (provider === "grok") {
    outputEl.querySelectorAll(".char-marker").forEach((m) => m.remove());
    return;
  }

  // Remove existing markers
  outputEl.querySelectorAll(".char-marker").forEach((m) => m.remove());

  if (!characters.length) return;

  // Only show markers when Characters accordion is open
  const accordion = $("#characters-accordion");
  if (accordion && !accordion.open) return;

  characters.forEach((charData, i) => {
    const marker = document.createElement("div");
    marker.className = "char-marker";
    if (charData.positionAuto) marker.classList.add("char-marker--auto");
    if (i === _activeMarkerIdx) marker.classList.add("char-marker--active");
    marker.textContent = String(i + 1);
    marker.style.left = (charData.x * 100) + "%";
    marker.style.top  = (charData.y * 100) + "%";
    marker.setAttribute("role", "button");
    marker.setAttribute("aria-label", `Character ${i + 1} position. Double-click to toggle auto.`);
    marker.title = "Drag to set position. Double-click to reset to Auto.";
    marker.tabIndex = 0;

    // ── Drag state ──────────────────────────────────────────
    let isDragging = false;
    let dragMoved = false;
    let startX = 0;
    let startY = 0;

    function onDragStart(clientX, clientY) {
      isDragging = true;
      dragMoved = false;
      startX = clientX;
      startY = clientY;
      marker.classList.add("char-marker--dragging");
    }

    function onDragMove(clientX, clientY) {
      if (!isDragging) return;
      const dx = Math.abs(clientX - startX);
      const dy = Math.abs(clientY - startY);
      if (dx > 3 || dy > 3) dragMoved = true;

      const rect = outputEl.getBoundingClientRect();
      const nx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, (clientY - rect.top)  / rect.height));
      charData.x = nx;
      charData.y = ny;
      marker.style.left = (nx * 100) + "%";
      marker.style.top  = (ny * 100) + "%";
    }

    function onDragEnd() {
      if (!isDragging) return;
      isDragging = false;
      marker.classList.remove("char-marker--dragging");
      if (dragMoved) {
        charData.positionAuto = false;
        marker.classList.remove("char-marker--auto");
        saveCharactersToCache();
      }
    }

    // Mouse events
    marker.addEventListener("mousedown", (e) => {
      e.preventDefault();
      onDragStart(e.clientX, e.clientY);

      const onMove = (ev) => onDragMove(ev.clientX, ev.clientY);
      const onUp   = () => {
        onDragEnd();
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
        // Select this character on click (no drag) — update classes in place
        // (do NOT call renderCharacterMarkers here — it destroys the element
        //  and breaks dblclick detection on the second click)
        if (!dragMoved) {
          _activeMarkerIdx = i;
          outputEl.querySelectorAll(".char-marker").forEach((m, mi) => {
            m.classList.toggle("char-marker--active", mi === i);
          });
          const slotsEl = $("#character-slots");
          if (slotsEl) {
            slotsEl.querySelectorAll(".char-slot-card").forEach((c, ci) => {
              c.classList.toggle("char-slot-card--active", ci === i);
            });
          }
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
    });

    // Touch events
    marker.addEventListener("touchstart", (e) => {
      e.preventDefault();
      const t = e.touches[0];
      onDragStart(t.clientX, t.clientY);
    }, { passive: false });

    marker.addEventListener("touchmove", (e) => {
      e.preventDefault();
      const t = e.touches[0];
      onDragMove(t.clientX, t.clientY);
    }, { passive: false });

    marker.addEventListener("touchend", (e) => {
      e.preventDefault();
      onDragEnd();
      if (!dragMoved) {
        _activeMarkerIdx = i;
        outputEl.querySelectorAll(".char-marker").forEach((m, mi) => {
          m.classList.toggle("char-marker--active", mi === i);
        });
        const slotsEl = $("#character-slots");
        if (slotsEl) {
          slotsEl.querySelectorAll(".char-slot-card").forEach((c, ci) => {
            c.classList.toggle("char-slot-card--active", ci === i);
          });
        }
      }
    }, { passive: false });

    // Double-click to toggle auto mode
    marker.addEventListener("dblclick", (e) => {
      e.preventDefault();
      charData.positionAuto = !charData.positionAuto;
      if (charData.positionAuto) {
        charData.x = 0.5;
        charData.y = 0.5;
      }
      renderCharacterMarkers();
      saveCharactersToCache();
    });

    // Keyboard: Enter/Space to select, Delete to toggle auto
    marker.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        _activeMarkerIdx = i;
        renderCharacterMarkers();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        charData.positionAuto = !charData.positionAuto;
        if (charData.positionAuto) { charData.x = 0.5; charData.y = 0.5; }
        renderCharacterMarkers();
      }
    });

    outputEl.appendChild(marker);
  });
}

// ── Feature 4: Build interactions section ───────────────────

function buildInteractionsSection(charData) {
  const details = document.createElement("details");
  details.className = "char-interactions-details";

  const summary = document.createElement("summary");
  summary.className = "char-interactions-summary";
  summary.innerHTML = `<svg class="char-interactions-chevron" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>Interactions`;
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "char-interactions-body";

  // Add row
  const addRow = document.createElement("div");
  addRow.className = "char-interactions-add-row";

  const directiveSelect = document.createElement("select");
  directiveSelect.className = "char-interactions-directive";
  directiveSelect.setAttribute("aria-label", "Interaction directive type");
  [["source#", "source#"], ["target#", "target#"], ["mutual#", "mutual#"]].forEach(([val, label]) => {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    directiveSelect.appendChild(opt);
  });

  const actionInput = document.createElement("input");
  actionInput.type = "text";
  actionInput.className = "char-interactions-action";
  actionInput.placeholder = "hug";
  actionInput.spellcheck = false;
  actionInput.setAttribute("autocomplete", "off");
  // Attach shared tag autocomplete to the action input
  _tagAC.attach(actionInput);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "char-interactions-add-btn";
  addBtn.setAttribute("aria-label", "Add interaction");
  addBtn.textContent = "+";

  addRow.appendChild(directiveSelect);
  addRow.appendChild(actionInput);
  addRow.appendChild(addBtn);
  body.appendChild(addRow);

  // Chips container
  const chipsEl = document.createElement("div");
  chipsEl.className = "char-interactions-chips";
  body.appendChild(chipsEl);

  function renderChip(interaction) {
    const chip = document.createElement("span");
    chip.className = "char-interaction-chip";
    const label = document.createElement("span");
    label.textContent = interaction.directive + interaction.action.replace(/_/g, " ");
    chip.appendChild(label);
    const removeX = document.createElement("button");
    removeX.type = "button";
    removeX.className = "char-interaction-chip-remove";
    removeX.setAttribute("aria-label", `Remove ${interaction.directive}${interaction.action}`);
    removeX.textContent = "\u00d7";
    removeX.addEventListener("click", () => {
      const iIdx = charData.interactions.indexOf(interaction);
      if (iIdx >= 0) charData.interactions.splice(iIdx, 1);
      chip.remove();
      saveCharactersToCache();
    });
    chip.appendChild(removeX);
    chipsEl.appendChild(chip);
  }

  // Render pre-existing interactions as chips
  for (const interaction of charData.interactions) {
    renderChip(interaction);
  }

  function addInteraction() {
    const action = actionInput.value.trim().replace(/,/g, "").replace(/ /g, "_");
    if (!action) return;
    const directive = directiveSelect.value;
    const interaction = { directive, action };
    charData.interactions.push(interaction);
    saveCharactersToCache();
    renderChip(interaction);
    actionInput.value = "";
    actionInput.focus();
  }

  addBtn.addEventListener("click", addInteraction);
  actionInput.addEventListener("keydown", (e) => {
    // Only add on Enter when autocomplete dropdown is not navigating
    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229 && !$("#tag-dropdown").classList.contains("visible")) {
      e.preventDefault();
      addInteraction();
    }
  });

  details.appendChild(body);
  return details;
}

function updateCountSuggestionChip(count) {
  const wrap = $("#char-count-chip-wrap");
  const chip = $("#char-count-chip");
  if (!wrap || !chip) return;
  if (count === 0) {
    wrap.style.display = "none";
    return;
  }
  const tagMap = { 1: "1girl", 2: "2girls", 3: "3girls", 4: "4girls", 5: "5girls", 6: "6girls" };
  const tag = tagMap[count] || `${count}girls`;
  chip.textContent = `Add to scene: ${tag}`;
  chip.onclick = () => {
    const promptEl = $("#prompt");
    const val = promptEl.value;
    // Insert tag at beginning of prompt, unless it's already there
    if (val.trimStart().startsWith(tag)) return;
    promptEl.value = tag + (val.length > 0 ? ", " : "") + val;
    promptEl.dispatchEvent(new Event("input"));
    // Flash
    chip.classList.add("char-count-chip--inserted");
    setTimeout(() => chip.classList.remove("char-count-chip--inserted"), 400);
  };
  wrap.style.display = "flex";
}

function collectCharacterPayload() {
  return characters.map((c) => {
    let caption = c.prompt;
    if (c.interactions && c.interactions.length > 0) {
      const interactionStr = c.interactions.map((i) => i.directive + i.action).join(", ");
      const needsComma = caption.length > 0 && !caption.trimEnd().endsWith(",");
      caption = caption + (needsComma ? ", " : caption.length > 0 ? " " : "") + interactionStr;
    }
    const entry = { char_caption: caption };
    if (!c.positionAuto) {
      entry.centers = [{ x: c.x, y: c.y }];
    }
    return entry;
  });
}

