/* ═══════════════════════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════════════════════ */

function populateSelect(selector, options) {
  const el = $(selector);
  if (!el) return;
  el.innerHTML = "";
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    el.appendChild(opt);
  }
}

function bindSlider(id, valId, decimals) {
  const slider = $(`#${id}`);
  const display = $(`#${valId}`);
  if (!slider || !display) return;
  display.textContent = parseFloat(slider.value).toFixed(decimals);
  slider.addEventListener("input", () => {
    display.textContent = parseFloat(slider.value).toFixed(decimals);
  });
}

function setupFileUpload(inputId, previewId, placeholderId, clearId, stateKey) {
  const input = $(`#${inputId}`);
  const preview = $(`#${previewId}`);
  const placeholder = $(`#${placeholderId}`);
  const clearBtn = $(`#${clearId}`);
  if (!input || !preview || !clearBtn) return;

  input.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      state[stateKey] = dataUrl.split(",")[1];
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = "preview";
      preview.innerHTML = "";
      preview.appendChild(img);
      if (placeholder) placeholder.style.display = "none";
      clearBtn.style.display = "inline-block";
    };
    reader.readAsDataURL(file);
  });

  clearBtn.addEventListener("click", () => {
    state[stateKey] = null;
    preview.innerHTML = "";
    input.value = "";
    clearBtn.style.display = "none";
    if (placeholder) placeholder.style.display = "flex";
  });
}

/* ═══════════════════════════════════════════════════════════
   SETTINGS
   ═══════════════════════════════════════════════════════════ */

function setupSettings() {
  const overlay = $("#settings-overlay");
  const openBtn = $("#settings-btn");
  const closeBtn = $("#settings-close");
  const pathInput = $("#settings-output-dir");
  const browseBtn = $("#settings-browse");
  const openFolderBtn = $("#settings-open-folder");
  if (!overlay || !openBtn) return;

  async function loadSettings() {
    const resp = await fetch("/api/settings");
    if (resp.ok) {
      const data = await resp.json();
      pathInput.value = data.output_dir;
    }
  }

  openBtn.addEventListener("click", () => {
    overlay.style.display = "flex";
    loadSettings();
  });
  closeBtn.addEventListener("click", () => { overlay.style.display = "none"; });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.style.display = "none";
  });

  browseBtn.addEventListener("click", async () => {
    browseBtn.textContent = "Choosing...";
    browseBtn.disabled = true;
    try {
      const resp = await fetch("/api/settings/browse", { method: "POST" });
      if (resp.ok) {
        const data = await resp.json();
        if (data.path) {
          pathInput.value = data.path;
          await fetch("/api/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ output_dir: data.path }),
          });
          loadGallery();
        }
      }
    } finally {
      browseBtn.textContent = "Browse";
      browseBtn.disabled = false;
    }
  });

  openFolderBtn.addEventListener("click", () => {
    fetch("/api/settings/open-folder", { method: "POST" });
  });
}

/* ═══════════════════════════════════════════════════════════
   GUIDE
   ═══════════════════════════════════════════════════════════ */

function setupGuide() {
  const overlay = $("#guide-overlay");
  const openBtn = $("#guide-btn");
  const closeBtn = $("#guide-close");
  if (!overlay || !openBtn) return;

  openBtn.addEventListener("click", () => { overlay.style.display = "flex"; });
  closeBtn.addEventListener("click", () => { overlay.style.display = "none"; });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.style.display = "none";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (overlay.style.display !== "none") overlay.style.display = "none";
      const settingsOverlay = $("#settings-overlay");
      if (settingsOverlay && settingsOverlay.style.display !== "none") settingsOverlay.style.display = "none";
      // crop-overlay Escape is handled in init() to avoid double-handling
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   PROMPT FOCUS MODE
   ═══════════════════════════════════════════════════════════ */

function setupPromptFocus() {
  const overlay     = $("#prompt-focus-overlay");
  const expandBtn   = $("#prompt-expand-btn");
  const closeBtn    = $("#prompt-focus-close");
  const doneBtn     = $("#prompt-focus-done");
  const focusTa     = $("#prompt-focus-textarea");
  const tokenCount  = $("#prompt-focus-token-count");
  const focusTabs   = overlay ? overlay.querySelectorAll(".prompt-focus-tab") : [];

  if (!overlay || !expandBtn || !focusTa) return;

  const sidebarPrompt   = $("#prompt");
  const sidebarNegative = $("#negative-prompt");

  // The sidebar textarea currently synced with the modal
  let _activeSidebarTa = sidebarPrompt;
  let _syncing = false;

  // ── Cleanup ref for the input listener we add on open ───
  let _modalInputHandler = null;

  function updateTokenCount() {
    const len = focusTa.value.length;
    tokenCount.textContent = "~" + Math.ceil(len / 4) + " tokens";
  }

  function openPromptFocus() {
    // Determine which sidebar tab is active
    const activeTab = document.querySelector(".prompt-tab.active");
    const isNegative = activeTab && activeTab.dataset.target === "negative-prompt";
    _activeSidebarTa = isNegative ? sidebarNegative : sidebarPrompt;

    // Mirror modal tabs
    focusTabs.forEach((t) => {
      t.classList.toggle("active", t.dataset.focusTarget === (isNegative ? "negative-prompt" : "prompt"));
    });

    // Copy sidebar value into modal
    focusTa.value = _activeSidebarTa ? _activeSidebarTa.value : "";
    updateTokenCount();

    // Reset animation and show overlay
    const shell = overlay.querySelector(".prompt-focus-shell");
    if (shell) { shell.style.animation = "none"; void shell.offsetWidth; shell.style.animation = ""; }
    overlay.style.display = "flex";

    // Attach bidirectional sync
    _modalInputHandler = () => {
      if (_syncing) return;
      _syncing = true;
      if (_activeSidebarTa) {
        _activeSidebarTa.value = focusTa.value;
        _activeSidebarTa.dispatchEvent(new Event("input", { bubbles: true }));
      }
      updateTokenCount();
      _syncing = false;
    };
    focusTa.addEventListener("input", _modalInputHandler);

    // Focus textarea at end
    focusTa.focus();
    focusTa.setSelectionRange(focusTa.value.length, focusTa.value.length);
  }

  function closePromptFocus() {
    overlay.style.display = "none";
    _tagAC.hide();

    // Remove input listener
    if (_modalInputHandler) {
      focusTa.removeEventListener("input", _modalInputHandler);
      _modalInputHandler = null;
    }

    // Return focus to whichever sidebar textarea was active
    if (_activeSidebarTa) _activeSidebarTa.focus();
  }

  // ── Tab switching inside modal ───────────────────────────
  focusTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      focusTabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      const isNeg = tab.dataset.focusTarget === "negative-prompt";
      const nextTa = isNeg ? sidebarNegative : sidebarPrompt;

      // Flush current modal value to old sidebar ta before switching
      if (_activeSidebarTa && !_syncing) {
        _activeSidebarTa.value = focusTa.value;
        _activeSidebarTa.dispatchEvent(new Event("input", { bubbles: true }));
      }

      _activeSidebarTa = nextTa;

      // Copy new sidebar ta value into modal
      focusTa.value = _activeSidebarTa ? _activeSidebarTa.value : "";
      updateTokenCount();
      focusTa.focus();

      // Also switch the sidebar tab so they stay in sync
      const sidebarTab = document.querySelector(`.prompt-tab[data-target="${tab.dataset.focusTarget}"]`);
      if (sidebarTab) sidebarTab.click();
    });
  });

  // ── Event bindings ───────────────────────────────────────
  expandBtn.addEventListener("click", openPromptFocus);
  closeBtn.addEventListener("click", closePromptFocus);
  doneBtn.addEventListener("click", closePromptFocus);

  // Backdrop click (but not shell click)
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePromptFocus();
  });

  // Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.style.display !== "none") {
      closePromptFocus();
    }
  });

  // Cmd+E / Ctrl+E — open from either sidebar textarea
  [sidebarPrompt, sidebarNegative].forEach((ta) => {
    if (!ta) return;
    ta.addEventListener("keydown", (e) => {
      const trigger = e.metaKey || e.ctrlKey;
      if (trigger && e.key === "e") {
        e.preventDefault();
        openPromptFocus();
      }
    });
  });

  // Attach tag autocomplete to focus textarea once (not on every open)
  _tagAC.attach(focusTa);
}

/* ═══════════════════════════════════════════════════════════
   PROMPT TABS
   ═══════════════════════════════════════════════════════════ */

function setupPromptTabs() {
  const tabs = document.querySelectorAll(".prompt-tab");
  const prompt = $("#prompt");
  const negative = $("#negative-prompt");
  const ucPreset = $("#uc-preset");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      if (tab.dataset.target === "prompt") {
        prompt.style.display = "";
        negative.style.display = "none";
        if (ucPreset) ucPreset.style.display = "none";
      } else {
        prompt.style.display = "none";
        negative.style.display = "";
        if (ucPreset) ucPreset.style.display = "";
      }
    });
  });

  if (ucPreset) {
    ucPreset.addEventListener("change", () => {
      const text = UC_PRESETS[ucPreset.value];
      if (text !== undefined) {
        negative.value = text;
      }
    });
  }
}

/* ═══════════════════════════════════════════════════════════
   HD ENHANCEMENT
   ═══════════════════════════════════════════════════════════ */

function setupHdEnhancement() {
  const toggle = $("#hd-enhancement");
  const smea = $("#smea");
  const smeaDyn = $("#smea-dyn");
  if (!toggle || !smea || !smeaDyn) return;

  toggle.addEventListener("change", () => {
    smea.checked = toggle.checked;
    smeaDyn.checked = toggle.checked;
  });
}

/* ═══════════════════════════════════════════════════════════
   AUTO-SAVE PROMPT
   ═══════════════════════════════════════════════════════════ */

function _promptKey() {
  const provider = document.getElementById("provider")?.value || "novelai";
  return "nai-prompt-" + provider;
}
function _negativeKey() {
  return "nai-negative-novelai"; // only NovelAI uses negative prompt
}

/** Called on provider switch to save current + restore other provider's prompt */
function swapPromptForProvider() {
  const prompt = $("#prompt");
  const negative = $("#negative-prompt");
  if (!prompt) return;

  // Restore the new provider's saved prompt
  const saved = localStorage.getItem(_promptKey());
  prompt.value = saved !== null ? saved : "";
  prompt.dispatchEvent(new Event("input", { bubbles: true }));

  if (negative) {
    const savedNeg = localStorage.getItem(_negativeKey());
    negative.value = savedNeg !== null ? savedNeg : "";
  }
}

function setupAutoSavePrompt() {
  const prompt = $("#prompt");
  const negative = $("#negative-prompt");

  // Load initial prompt for current provider
  const savedPrompt = localStorage.getItem(_promptKey());
  const savedNegative = localStorage.getItem(_negativeKey());
  if (savedPrompt !== null) prompt.value = savedPrompt;
  if (savedNegative !== null) negative.value = savedNegative;

  function autoGrowPrompt() {
    prompt.style.height = "auto";
    prompt.style.height = Math.min(prompt.scrollHeight, 200) + "px";
  }
  prompt.addEventListener("input", () => {
    localStorage.setItem(_promptKey(), prompt.value);
    _checkImageMention(prompt);
    autoGrowPrompt();
  });
  // Initial auto-grow on load
  requestAnimationFrame(autoGrowPrompt);

  // ── @ Image Mention ───────────────────────────────────────
  let _mentionDropdown = null;
  let _mentionTarget = null;

  function _checkImageMention(textarea) {
    const provider = document.getElementById("provider")?.value || "novelai";
    if (provider !== "grok") { _closeMention(); return; }

    const val = textarea.value;
    const pos = textarea.selectionStart;
    // Check if the character just before cursor is @
    if (pos > 0 && val[pos - 1] === "@") {
      _showMentionDropdown(textarea, pos);
    } else {
      _closeMention();
    }
  }

  function _showMentionDropdown(textarea, atPos) {
    _closeMention();
    const images = [];
    if (state.img2img) images.push({ label: "Source · Image 1", b64: state.img2img, ref: "the source image" });
    grokRefs.forEach((r, i) => {
      images.push({ label: `Ref ${i + 1} · Image ${i + 2}`, b64: r.base64, ref: `image ${i + 2}` });
    });
    if (images.length === 0) return;

    const dd = document.createElement("div");
    dd.className = "image-mention-dropdown";
    _mentionDropdown = dd;
    _mentionTarget = textarea;

    images.forEach((img, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "image-mention-item";
      if (idx === 0) btn.classList.add("image-mention-item--selected");

      const thumb = document.createElement("img");
      thumb.className = "image-mention-thumb";
      thumb.src = "data:image/png;base64," + img.b64;

      const label = document.createElement("span");
      label.className = "image-mention-label";
      label.textContent = img.label;

      btn.appendChild(thumb);
      btn.appendChild(label);

      btn.addEventListener("mousedown", (e) => {
        e.preventDefault(); // prevent blur
        // Replace the @ with the reference text
        const before = textarea.value.substring(0, atPos - 1);
        const after = textarea.value.substring(atPos);
        textarea.value = before + img.ref + " " + after;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        const newPos = (before + img.ref + " ").length;
        textarea.setSelectionRange(newPos, newPos);
        textarea.focus();
        _closeMention();
      });

      dd.appendChild(btn);
    });

    // Position near the textarea cursor
    const rect = textarea.getBoundingClientRect();
    dd.style.position = "fixed";
    dd.style.left = rect.left + "px";
    dd.style.top = (rect.bottom + 4) + "px";
    document.body.appendChild(dd);

    // Close on next input that isn't @, or on blur/escape
    function onBlur() { setTimeout(_closeMention, 150); }
    function onKeydown(e) {
      if (e.key === "Escape") { e.stopImmediatePropagation(); _closeMention(); }
    }
    textarea.addEventListener("blur", onBlur, { once: true });
    textarea.addEventListener("keydown", onKeydown, { once: true });
  }

  function _closeMention() {
    if (_mentionDropdown && _mentionDropdown.parentNode) {
      _mentionDropdown.parentNode.removeChild(_mentionDropdown);
    }
    _mentionDropdown = null;
    _mentionTarget = null;
  }
  negative.addEventListener("input", () => {
    localStorage.setItem(_negativeKey(), negative.value);
  });

  // ── Prompt History — Spotlight style (separated by provider) ──
  const MAX_PROMPT_HISTORY = 50;
  const histBtn = document.getElementById("prompt-history-btn");
  const histOverlay = document.getElementById("prompt-history-overlay");
  const histSearch = document.getElementById("prompt-history-search");
  const histList = document.getElementById("prompt-history-list");
  let _histSelectedIdx = -1;

  function _getHistoryKey() {
    const provider = document.getElementById("provider")?.value || "novelai";
    return "nai-prompt-history-" + provider;
  }

  function _loadHistory() {
    try { return JSON.parse(localStorage.getItem(_getHistoryKey()) || "[]"); }
    catch { return []; }
  }

  function _saveHistory(list) {
    try { localStorage.setItem(_getHistoryKey(), JSON.stringify(list)); }
    catch { /* quota */ }
  }

  window._savePromptToHistory = function() {
    const text = prompt.value.trim();
    console.log("[prompt-history] saving:", text ? text.substring(0, 30) + "..." : "(empty)");
    if (!text) return;
    const list = _loadHistory().filter((p) => p !== text);
    list.unshift(text);
    if (list.length > MAX_PROMPT_HISTORY) list.length = MAX_PROMPT_HISTORY;
    _saveHistory(list);
  };

  function _highlightMatch(text, query) {
    if (!query) return document.createTextNode(text);
    const span = document.createElement("span");
    const lower = text.toLowerCase();
    const qLower = query.toLowerCase();
    let pos = 0;
    while (pos < text.length) {
      const idx = lower.indexOf(qLower, pos);
      if (idx === -1) { span.appendChild(document.createTextNode(text.slice(pos))); break; }
      if (idx > pos) span.appendChild(document.createTextNode(text.slice(pos, idx)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(idx, idx + query.length);
      span.appendChild(mark);
      pos = idx + query.length;
    }
    return span;
  }

  function _renderHistoryList(query) {
    if (!histList) return;
    const list = _loadHistory();
    const q = (query || "").trim().toLowerCase();
    const filtered = q ? list.filter((p) => p.toLowerCase().includes(q)) : list;

    histList.innerHTML = "";
    _histSelectedIdx = -1;

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "prompt-history-empty";
      empty.textContent = q ? "No matches" : "No prompt history yet";
      histList.appendChild(empty);
      return;
    }

    filtered.forEach((text, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "prompt-history-item";
      btn.appendChild(_highlightMatch(text, query));
      btn.addEventListener("click", () => {
        prompt.value = text;
        prompt.dispatchEvent(new Event("input", { bubbles: true }));
        _closeHistory();
      });
      btn.addEventListener("mouseenter", () => {
        _histSelectedIdx = idx;
        _updateSelection();
      });
      histList.appendChild(btn);
    });
  }

  function _updateSelection() {
    const items = histList.querySelectorAll(".prompt-history-item");
    items.forEach((el, i) => el.classList.toggle("prompt-history-item--selected", i === _histSelectedIdx));
    if (_histSelectedIdx >= 0 && items[_histSelectedIdx]) {
      items[_histSelectedIdx].scrollIntoView({ block: "nearest" });
    }
  }

  function _openHistory() {
    if (!histOverlay) return;
    histOverlay.style.display = "";
    if (histSearch) { histSearch.value = ""; histSearch.focus(); }
    _renderHistoryList("");
  }

  function _closeHistory() {
    if (histOverlay) histOverlay.style.display = "none";
  }

  if (histBtn) histBtn.addEventListener("click", _openHistory);

  if (histOverlay) {
    histOverlay.addEventListener("click", (e) => { if (e.target === histOverlay) _closeHistory(); });

    if (histSearch) {
      histSearch.addEventListener("input", () => _renderHistoryList(histSearch.value));

      histSearch.addEventListener("keydown", (e) => {
        const items = histList.querySelectorAll(".prompt-history-item");
        if (e.key === "Escape") { e.stopImmediatePropagation(); _closeHistory(); return; }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          _histSelectedIdx = Math.min(_histSelectedIdx + 1, items.length - 1);
          _updateSelection();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          _histSelectedIdx = Math.max(_histSelectedIdx - 1, 0);
          _updateSelection();
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (_histSelectedIdx >= 0 && items[_histSelectedIdx]) items[_histSelectedIdx].click();
          else if (items.length > 0) items[0].click();
        }
      });
    }
  }

  // Ctrl+H / Cmd+H shortcut to open prompt history
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "h") {
      if (e.target.matches("input, textarea, [contenteditable]") && histOverlay?.style.display !== "none") return;
      e.preventDefault();
      if (histOverlay?.style.display === "none") _openHistory(); else _closeHistory();
    }
  });
}


/* ═══════════════════════════════════════════════════════════
   GROK IMAGES — unified source + references panel
   ═══════════════════════════════════════════════════════════ */

// Pending target for the file picker: "source" | "ref"
let _grokFilePickerTarget = "ref";

function setupGrokRefs() {
  const addBtn = $("#btn-add-grok-ref");
  const fileInput = $("#grok-ref-file-input");
  const imagesList = $("#grok-images-list");
  if (!fileInput || !imagesList) return;

  // ── Add Reference button ────────────────────────────────
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      if (grokRefs.length >= MAX_GROK_REFS) return;
      _grokFilePickerTarget = "ref";
      fileInput.value = "";
      fileInput.click();
    });
  }

  // ── Source slot: click to pick ──────────────────────────
  imagesList.addEventListener("click", (e) => {
    const drop = e.target.closest("#grok-source-drop");
    if (drop) {
      _grokFilePickerTarget = "source";
      fileInput.value = "";
      fileInput.click();
    }
  });

  // ── Source slot: clear button ───────────────────────────
  imagesList.addEventListener("click", (e) => {
    const btn = e.target.closest(".grok-slot-remove[data-role='source']");
    if (btn) {
      state.img2img = null;
      renderGrokImagesList();
      syncInpaintButtonVisibility();
    }
  });

  // ── Ref slot: remove button ─────────────────────────────
  imagesList.addEventListener("click", (e) => {
    const btn = e.target.closest(".grok-slot-remove[data-role='ref']");
    if (btn) {
      const idx = parseInt(btn.dataset.idx, 10);
      grokRefs.splice(idx, 1);
      renderGrokImagesList();
    }
  });

  // ── File picker result ──────────────────────────────────
  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    readImageFile(file, (base64) => {
      if (_grokFilePickerTarget === "source") {
        state.img2img = base64;
        renderGrokImagesList();
        syncInpaintButtonVisibility();
      } else {
        if (grokRefs.length < MAX_GROK_REFS) {
          grokRefs.push({ base64 });
          renderGrokImagesList();
        }
      }
    });
    fileInput.value = "";
  });

  // ── Drag-and-drop on the list panel ────────────────────
  imagesList.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    imagesList.classList.add("drag-over");
  });
  imagesList.addEventListener("dragleave", (e) => {
    if (!imagesList.contains(e.relatedTarget)) {
      imagesList.classList.remove("drag-over");
    }
  });
  imagesList.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    imagesList.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith("image/")) return;
    readImageFile(file, (base64) => {
      if (!state.img2img) {
        state.img2img = base64;
        renderGrokImagesList();
        syncInpaintButtonVisibility();
      } else if (grokRefs.length < MAX_GROK_REFS) {
        grokRefs.push({ base64 });
        renderGrokImagesList();
      }
    });
  });

  renderGrokImagesList();
}

function readImageFile(file, callback) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const base64 = ev.target.result.split(",")[1];
    callback(base64);
  };
  reader.readAsDataURL(file);
}

function renderGrokImagesList() {
  const imagesList = $("#grok-images-list");
  const addBtn = $("#btn-add-grok-ref");
  const badge = $("#grok-images-badge");
  const hint = $("#grok-images-hint");
  if (!imagesList) return;

  // Rebuild everything after the source slot
  // Keep source slot element, remove any previously-rendered ref slots
  const sourceSlot = document.getElementById("grok-source-slot");
  // Clear all children except the source slot
  while (imagesList.lastChild && imagesList.lastChild !== sourceSlot) {
    imagesList.removeChild(imagesList.lastChild);
  }

  // ── Update source slot ──────────────────────────────────
  if (sourceSlot) {
    if (state.img2img) {
      // Filled: show thumb + × button
      sourceSlot.innerHTML = `
        <div class="grok-slot-label">Source · Image 1</div>
        <img class="grok-slot-thumb" src="data:image/png;base64,${state.img2img}" alt="Source image">
        <button type="button" class="grok-slot-remove" data-role="source" aria-label="Remove source image" title="Remove source">×</button>
      `;
    } else {
      // Empty: drop zone
      sourceSlot.innerHTML = `
        <div class="grok-slot-label">Source · Image 1</div>
        <div class="grok-slot-drop" id="grok-source-drop">Drop or click to set source</div>
      `;
    }
  }

  // ── Render ref slots (numbered from 2) ──────────────────
  grokRefs.forEach((ref, idx) => {
    const imageNumber = idx + 2; // source is 1
    const slot = document.createElement("div");
    slot.className = "grok-image-slot";
    slot.innerHTML = `
      <div class="grok-slot-label">Ref ${idx + 1} · Image ${imageNumber}</div>
      <img class="grok-slot-thumb" src="data:image/png;base64,${ref.base64}" alt="Reference image ${imageNumber}">
      <button type="button" class="grok-slot-remove" data-role="ref" data-idx="${idx}" aria-label="Remove reference ${idx + 1}" title="Remove reference">×</button>
    `;
    imagesList.appendChild(slot);
  });

  // ── Add Reference button visibility ─────────────────────
  const totalImages = (state.img2img ? 1 : 0) + grokRefs.length;
  if (addBtn) addBtn.style.display = grokRefs.length >= MAX_GROK_REFS ? "none" : "";

  // ── Badge ───────────────────────────────────────────────
  if (badge) {
    if (totalImages > 0) {
      badge.textContent = String(totalImages);
      badge.style.display = "";
    } else {
      badge.style.display = "none";
    }
  }

  // ── Hint text ───────────────────────────────────────────
  if (hint) {
    const hasSource = !!state.img2img;
    const hasRefs = grokRefs.length > 0;
    if (!hasSource && !hasRefs) {
      hint.textContent = "Add a source or reference image to guide Grok";
    } else if (hasSource && !hasRefs) {
      hint.textContent = "Source is image 1. Describe what to edit in your prompt";
    } else if (hasSource && hasRefs) {
      const refNums = grokRefs.map((_, i) => i + 2).join(", ");
      hint.textContent = `Source is image 1. References are images ${refNums}. Mention by position in prompt`;
    } else {
      const refNums = grokRefs.map((_, i) => i + 1).join(", ");
      hint.textContent = `References are images ${refNums}. Add a source to edit a specific image`;
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   ERROR
   ═══════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════
   PROMPT ASSIST — AI-powered prompt suggestions
   ═══════════════════════════════════════════════════════════ */

function setupPromptAssist() {
  const btn = $("#prompt-assist-btn");
  const overlay = $("#prompt-assist-overlay");
  const closeBtn = $("#prompt-assist-close");
  const dirInput = $("#prompt-assist-direction");
  const tagsBtn = $("#prompt-assist-tags");
  const descBtn = $("#prompt-assist-desc");
  const statusEl = $("#prompt-assist-status");
  const resultsEl = $("#prompt-assist-results");
  const selectedArea = $("#prompt-assist-selected");
  const selectedContainer = $("#prompt-assist-selected-tags");
  const clearBtn = $("#prompt-assist-clear");
  const addBtn = $("#prompt-assist-add");

  if (!btn || !overlay) return;

  let selected = [];

  function open() {
    overlay.style.display = "flex";
    resultsEl.innerHTML = "";
    statusEl.style.display = "none";
    selected = [];
    renderSelected();

    // Adapt buttons to current provider + mode
    const provider = document.getElementById("provider")?.value || "novelai";
    const hasSource = !!state.img2img;
    if (provider === "grok") {
      tagsBtn.style.display = "none";
      if (hasSource) {
        descBtn.textContent = "Edit Prompt";
        if (dirInput) dirInput.placeholder = "What to change… e.g. change hair to blonde, add sunglasses";
      } else {
        descBtn.textContent = "Grok Description";
        if (dirInput) dirInput.placeholder = "Describe what you want…";
      }
    } else {
      tagsBtn.style.display = "";
      descBtn.textContent = "Grok Description";
      if (dirInput) dirInput.placeholder = "Describe what you want… e.g. girl at the beach, cyberpunk city";
    }

    if (dirInput) dirInput.focus();
  }

  function close() {
    overlay.style.display = "none";
  }

  function addTag(tag) {
    if (!selected.includes(tag)) {
      selected.push(tag);
      renderSelected();
    }
  }

  function renderSelected() {
    if (!selectedContainer || !selectedArea) return;
    selectedContainer.innerHTML = "";
    if (selected.length === 0) { selectedArea.style.display = "none"; return; }
    selectedArea.style.display = "";
    for (const tag of selected) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "local-analysis-tag selected";
      pill.textContent = tag + " \u00d7";
      pill.addEventListener("click", () => {
        selected = selected.filter(t => t !== tag);
        renderSelected();
      });
      selectedContainer.appendChild(pill);
    }
  }

  async function generate(mode) {
    const direction = dirInput?.value.trim();
    if (!direction) { dirInput?.focus(); return; }

    // Auto-detect edit mode for Grok with source image
    const provider = document.getElementById("provider")?.value || "novelai";
    if (mode === "description" && provider === "grok" && state.img2img) {
      mode = "edit";
    }

    statusEl.style.display = "block";
    const labels = { tags: "Generating tags…", description: "Generating description…", edit: "Generating edit prompt…" };
    statusEl.textContent = labels[mode] || "Generating…";

    try {
      const resp = await fetch("/api/prompt-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction, mode, current_prompt: $("#prompt")?.value || "" }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Generation failed");
      }
      const data = await resp.json();
      statusEl.style.display = "none";
      if (typeof fetchGrokUsage === "function") fetchGrokUsage();

      if (mode === "tags" && data.tags) {
        const section = document.createElement("div");
        const label = document.createElement("div");
        label.className = "local-analysis-section-label";
        label.textContent = "NovelAI Tags";
        section.appendChild(label);

        const container = document.createElement("div");
        container.className = "local-analysis-tags";
        for (const tag of data.tags) {
          const pill = document.createElement("button");
          pill.type = "button";
          pill.className = "local-analysis-tag";
          pill.textContent = tag.replace(/_/g, " ");
          pill.addEventListener("click", () => addTag(tag.replace(/_/g, " ")));
          container.appendChild(pill);
        }
        section.appendChild(container);
        resultsEl.innerHTML = "";
        resultsEl.appendChild(section);
      }

      if ((mode === "description" || mode === "edit") && data.description) {
        const section = document.createElement("div");
        const label = document.createElement("div");
        label.className = "local-analysis-section-label";
        label.textContent = "Grok Description";
        section.appendChild(label);

        const desc = document.createElement("div");
        desc.className = "local-analysis-description";
        desc.textContent = data.description;
        section.appendChild(desc);

        const actions = document.createElement("div");
        actions.className = "local-analysis-desc-actions";

        const copyBtn2 = document.createElement("button");
        copyBtn2.type = "button";
        copyBtn2.className = "btn-action";
        copyBtn2.textContent = "Copy";
        copyBtn2.addEventListener("click", () => {
          navigator.clipboard.writeText(data.description);
          copyBtn2.textContent = "Copied!";
          setTimeout(() => { copyBtn2.textContent = "Copy"; }, 1500);
        });
        actions.appendChild(copyBtn2);

        const useBtn = document.createElement("button");
        useBtn.type = "button";
        useBtn.className = "btn-action";
        useBtn.textContent = "Use as Prompt";
        useBtn.addEventListener("click", () => {
          const el = $("#prompt");
          if (el) { el.value = data.description; el.dispatchEvent(new Event("input", { bubbles: true })); }
          close();
        });
        actions.appendChild(useBtn);

        section.appendChild(actions);
        resultsEl.innerHTML = "";
        resultsEl.appendChild(section);
      }
    } catch (err) {
      statusEl.style.display = "block";
      statusEl.textContent = "Error: " + err.message;
    }
  }

  btn.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  tagsBtn?.addEventListener("click", () => generate("tags"));
  descBtn?.addEventListener("click", () => generate("description"));
  clearBtn?.addEventListener("click", () => { selected = []; renderSelected(); });
  addBtn?.addEventListener("click", () => {
    if (selected.length > 0) {
      insertTagIntoPrompt(selected.join(", "));
    }
    close();
  });
  dirInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); generate("tags"); }
  });
}


function setupPromptOptimize() {
  const btn = $("#prompt-optimize-btn");
  const promptEl = $("#prompt");
  if (!btn || !promptEl) return;

  btn.addEventListener("click", async () => {
    const basePrompt = promptEl.value.trim();
    if (!basePrompt) { showStatus("Nothing to optimize — prompt is empty"); return; }

    // Re-compose full prompt including character blocks
    const charPrompts = characters.map(c => c.prompt.trim()).filter(Boolean);
    const fullPrompt = charPrompts.length > 0
      ? [basePrompt, ...charPrompts].join(" | ")
      : basePrompt;

    const enhance = document.getElementById("enhance-toggle")?.checked || false;
    btn.disabled = true;
    btn.classList.add("loading");
    showStatus(enhance ? "Enhancing prompt…" : "Optimizing prompt…");

    try {
      // Build direction with enhance + saved tags
      let direction = "";
      if (enhance) {
        direction += "IMPORTANT: After optimizing tags, you MUST append 2-3 short natural language phrases (NOT tags) at the end of the prompt to enhance atmosphere. These should be descriptive prose fragments like 'the warm golden light casting long shadows', 'petals drifting in the breeze', 'a quiet moment of contemplation'. They must be clearly different from tags — use articles, prepositions, adjectives in sentence fragments. Do NOT remove existing tags to make room.";
      }
      const saved = TagIntelligence.getSavedTags?.() || [];
      if (saved.length > 0) {
        direction += (direction ? " " : "") + "The user has marked these tags as favorites from previous optimizations — prefer including them when relevant: " + saved.join(", ");
      }
      console.log("[optimize] sending:", fullPrompt.substring(0, 100), enhance ? "(enhance)" : "");
      const resp = await fetch("/api/prompt-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction, mode: "optimize", current_prompt: fullPrompt }),
      });
      if (!resp.ok) {
        const errBody = await resp.text();
        console.error("[optimize] API error:", resp.status, errBody);
        let err = "Optimize failed";
        try { err = JSON.parse(errBody).detail || err; } catch { err = errBody.substring(0, 200) || err; }
        throw new Error(err);
      }
      const data = await resp.json();
      console.log("[optimize] response:", data);
      if (data.prompt) {
        window._savePromptToHistory?.();
        const explanation = typeof data.changes === "string" ? data.changes.trim() : null;
        TagIntelligence.recordChange("optimize", fullPrompt, data.prompt, explanation);
        const split = populateCharactersFromPipe(data.prompt);
        console.log("[optimize] split result:", split);
        if (split.applied) {
          promptEl.value = split.base;
          const statusMsg = explanation || `Prompt optimized — ${split.charCount} character(s) moved to blocks`;
          showStatus(statusMsg);
        } else {
          promptEl.value = data.prompt;
          showStatus(explanation || "Tags reordered and cleaned");
        }
        promptEl.dispatchEvent(new Event("input", { bubbles: true }));
        flashPromptTextarea();
      }
      if (typeof fetchGrokUsage === "function") fetchGrokUsage();
    } catch (err) {
      console.error("[optimize] error:", err);
      showStatus("Optimize error: " + err.message);
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  });
}

function flashPromptTextarea() {
  const el = $("#prompt");
  if (!el) return;
  el.classList.remove("prompt-updated-flash");
  void el.offsetWidth; // force reflow to restart animation
  el.classList.add("prompt-updated-flash");
  setTimeout(() => el.classList.remove("prompt-updated-flash"), 700);
}

function showStatus(msg, duration = 3000) {
  clearError();
  const slot = $("#error-slot");
  const div = document.createElement("div");
  div.className = "status-msg";
  div.textContent = msg;
  slot.appendChild(div);
  setTimeout(() => { if (slot.contains(div)) slot.removeChild(div); }, duration);
}

function showError(msg) {
  clearError();
  const slot = $("#error-slot");
  const errDiv = document.createElement("div");
  errDiv.className = "error-msg";
  errDiv.textContent = msg;
  slot.appendChild(errDiv);
}

function clearError() {
  $("#error-slot").innerHTML = "";
}


/* ═══════════════════════════════════════════════════════════
   CANVAS PROMPT BAR (CPB) — Phase 1 canvas-centric UI
   The hidden #prompt / #negative-prompt in the sidebar remain
   the source of truth for all generation logic. This bar
   bidirectionally mirrors them.
   ═══════════════════════════════════════════════════════════ */

function setupCanvasPromptBar() {
  const bar         = document.getElementById("canvas-prompt-bar");
  const cpbTa       = document.getElementById("cpb-prompt-display");
  const pills       = bar ? bar.querySelectorAll(".cpb-pill") : [];
  const sidebarPrompt   = document.getElementById("prompt");
  const sidebarNegative = document.getElementById("negative-prompt");

  if (!bar || !cpbTa || !sidebarPrompt) return;

  // Track which sidebar textarea is currently mirrored
  let activeSidebarTa = sidebarPrompt;

  /* ── Auto-grow helper ─────────────────────────────── */
  function autoGrow(ta) {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }

  /* ── Sync cpb → sidebar ───────────────────────────── */
  function cpbToSidebar() {
    if (!activeSidebarTa) return;
    activeSidebarTa.value = cpbTa.value;
    activeSidebarTa.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /* ── Sync sidebar → cpb ───────────────────────────── */
  function sidebarToCpb(sidebarTa) {
    if (sidebarTa !== activeSidebarTa) return;
    cpbTa.value = sidebarTa.value;
    autoGrow(cpbTa);
    updateCollapsedText();
  }

  /* ── Wire bidirectional sync for one sidebar textarea ── */
  function wireSidebarSync(sidebarTa) {
    sidebarTa.addEventListener("input", () => sidebarToCpb(sidebarTa));
  }

  wireSidebarSync(sidebarPrompt);
  if (sidebarNegative) wireSidebarSync(sidebarNegative);

  cpbTa.addEventListener("input", () => {
    cpbToSidebar();
    autoGrow(cpbTa);
  });

  /* ── Tab pill switching ────────────────────────────── */
  pills.forEach((pill) => {
    pill.addEventListener("click", () => {
      pills.forEach((p) => {
        p.classList.remove("cpb-pill--active");
        p.setAttribute("aria-selected", "false");
      });
      pill.classList.add("cpb-pill--active");
      pill.setAttribute("aria-selected", "true");

      const target = pill.dataset.cpbTarget;
      activeSidebarTa = target === "negative-prompt" ? sidebarNegative : sidebarPrompt;

      // Also click the corresponding hidden sidebar tab so Focus Mode opens the right field
      const sidebarTab = document.querySelector(`.prompt-tab[data-target="${target}"]`);
      if (sidebarTab) sidebarTab.click();

      // Update display + placeholder
      cpbTa.value = activeSidebarTa ? activeSidebarTa.value : "";
      cpbTa.placeholder = target === "negative-prompt"
        ? "What to exclude…"
        : "Describe your vision… e.g. a girl standing in a field of sunflowers at golden hour";
      autoGrow(cpbTa);
      cpbTa.focus();
    });
  });

  /* ── Also keep sidebar prompt-tabs in sync ─────────── */
  // When the sidebar prompt tab changes, mirror it to the cpb pill
  const sidebarTabBtns = document.querySelectorAll(".prompt-tab[data-target]");
  sidebarTabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target;
      pills.forEach((p) => {
        const match = p.dataset.cpbTarget === target;
        p.classList.toggle("cpb-pill--active", match);
        p.setAttribute("aria-selected", match ? "true" : "false");
      });
      activeSidebarTa = target === "negative-prompt" ? sidebarNegative : sidebarPrompt;
      cpbTa.value = activeSidebarTa ? activeSidebarTa.value : "";
      autoGrow(cpbTa);
    });
  });

  /* ── Collapse / Expand prompt bar ────────────────────── */
  const collapsedRow = document.getElementById("cpb-collapsed-row");
  const collapsedText = document.getElementById("cpb-collapsed-text");
  const collapsedGen = document.getElementById("cpb-collapsed-gen");

  function expandBar() {
    bar.classList.remove("canvas-prompt-bar--collapsed");
    cpbTa.focus();
  }

  function collapseBar() {
    cpbTa.blur();
    bar.classList.add("canvas-prompt-bar--collapsed");
    updateCollapsedText();
  }

  function updateCollapsedText() {
    if (!collapsedText) return;
    const val = cpbTa.value.trim();
    collapsedText.textContent = val || "Describe your vision…";
    collapsedText.style.color = val ? "var(--text-primary)" : "var(--text-tertiary)";
  }

  // ── Collapsed inline actions (replaces floating image-actions) ──
  const collapsedActions = document.getElementById("cpb-collapsed-actions");
  const collapsedSeed = document.getElementById("cpb-collapsed-seed");
  const collapsedRefine = document.getElementById("cpb-collapsed-refine");
  const collapsedSendLayer = document.getElementById("cpb-collapsed-send-layer");
  const collapsedMore = document.getElementById("cpb-collapsed-more");

  // Show/update collapsed actions when image is generated
  function updateCollapsedActions() {
    if (!collapsedActions) return;
    const seedEl = document.getElementById("info-seed");
    const hasImage = !!seedEl?.textContent;
    collapsedActions.style.display = hasImage ? "flex" : "none";
    if (hasImage && collapsedSeed) {
      collapsedSeed.textContent = seedEl.textContent;
    }
    // Show/hide and position clear button at image top-right corner
    const cvtClear = document.getElementById("cvt-clear");
    if (cvtClear) {
      cvtClear.style.display = hasImage ? "" : "none";
      if (hasImage) _positionClearButton();
    }
  }

  function _positionClearButton() {
    const cvtClear = document.getElementById("cvt-clear");
    const img = document.querySelector("#output img");
    const dt = document.getElementById("canvas-drop-target");
    if (!cvtClear || !img || !dt) return;
    const imgRect = img.getBoundingClientRect();
    const dtRect = dt.getBoundingClientRect();
    cvtClear.style.top  = (imgRect.top - dtRect.top + 6) + "px";
    cvtClear.style.left = (imgRect.right - dtRect.left - 30) + "px";
  }

  // Observe #info-seed changes to detect generation complete
  const infoSeed = document.getElementById("info-seed");
  if (infoSeed) {
    new MutationObserver(updateCollapsedActions).observe(infoSeed, { childList: true, characterData: true, subtree: true });
  }
  updateCollapsedActions();

  // Seed click → copy
  if (collapsedSeed) collapsedSeed.addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("info-seed")?.click();
  });

  // Delegate action buttons
  if (collapsedRefine) collapsedRefine.addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("btn-refine-prompt")?.click();
  });
  if (collapsedSendLayer) collapsedSendLayer.addEventListener("click", (e) => {
    e.stopPropagation();
    const provider = document.getElementById("provider")?.value || "novelai";
    if (provider === "grok") {
      document.getElementById("btn-set-as-source")?.click();
    } else {
      document.getElementById("btn-send-to-layer")?.click();
    }
  });
  // Reparent overflow menu to body so it works when sidebar is hidden
  const overflowMenu = document.getElementById("overflow-menu");
  if (overflowMenu && overflowMenu.parentElement !== document.body) {
    document.body.appendChild(overflowMenu);
    overflowMenu.style.position = "fixed";
    overflowMenu.style.zIndex = "200";
  }
  if (collapsedMore) collapsedMore.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!overflowMenu) return;
    const isOpen = overflowMenu.classList.contains("open");
    overflowMenu.classList.toggle("open", !isOpen);
    if (!isOpen) {
      const rect = collapsedMore.getBoundingClientRect();
      overflowMenu.style.right = (window.innerWidth - rect.right) + "px";
      overflowMenu.style.bottom = (window.innerHeight - rect.top + 6) + "px";
      overflowMenu.style.left = "auto";
      overflowMenu.style.top = "auto";
    }
  });
  // Close overflow menu on outside click
  document.addEventListener("click", (e) => {
    if (overflowMenu?.classList.contains("open") && !overflowMenu.contains(e.target) && !collapsedMore?.contains(e.target)) {
      overflowMenu.classList.remove("open");
    }
  });

  // Auto-generate toggle mirror
  const sidebarAutoGen = document.getElementById("auto-generate");
  const cpbAutoGen = document.getElementById("cpb-collapsed-auto-gen");
  if (sidebarAutoGen && cpbAutoGen) {
    cpbAutoGen.checked = sidebarAutoGen.checked;
    sidebarAutoGen.addEventListener("change", () => { cpbAutoGen.checked = sidebarAutoGen.checked; });
    cpbAutoGen.addEventListener("change", (e) => {
      e.stopPropagation();
      sidebarAutoGen.checked = cpbAutoGen.checked;
      sidebarAutoGen.dispatchEvent(new Event("change"));
    });
  }

  // Click collapsed row → expand (but not on action buttons, auto-toggle, or generate)
  if (collapsedRow) collapsedRow.addEventListener("click", (e) => {
    if (e.target.closest(".cpb-collapsed-gen") || e.target.closest(".cpb-collapsed-actions") || e.target.closest(".cpb-collapsed-auto-toggle")) return;
    expandBar();
  });

  // Collapsed generate button → fire generation
  if (collapsedGen) collapsedGen.addEventListener("click", () => {
    document.getElementById("generate-btn")?.click();
  });

  // Click outside bar → collapse
  document.addEventListener("mousedown", (e) => {
    if (bar.classList.contains("canvas-prompt-bar--collapsed")) return;
    if (bar.contains(e.target)) return;
    collapseBar();
  });

  // Escape → collapse
  bar.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { collapseBar(); e.stopPropagation(); }
  });

  // Keep collapsed text in sync
  cpbTa.addEventListener("input", updateCollapsedText);
  updateCollapsedText();

  // Prevent blur from collapsing when clicking toolbar buttons
  bar.querySelectorAll(".cpb-tool-btn, .cpb-seed-input, .cpb-seed-rand-btn, .cpb-icon-btn, .cpb-pill-toggle").forEach((el) => {
    el.addEventListener("mousedown", (e) => e.preventDefault());
  });

  /* ── Quality / Enhance checkbox mirrors ────────────── */
  const sidebarQuality  = document.getElementById("quality-tags");
  const sidebarEnhance  = document.getElementById("enhance-toggle");
  const cpbQuality      = document.getElementById("cpb-quality-tags");
  const cpbEnhance      = document.getElementById("cpb-enhance-toggle");

  function wireCheckboxMirror(source, mirror) {
    if (!source || !mirror) return;
    // Init mirror from source
    mirror.checked = source.checked;
    // source → mirror
    source.addEventListener("change", () => { mirror.checked = source.checked; });
    // mirror → source
    mirror.addEventListener("change", () => {
      source.checked = mirror.checked;
      source.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  wireCheckboxMirror(sidebarQuality, cpbQuality);
  wireCheckboxMirror(sidebarEnhance, cpbEnhance);

  /* ── Generate button ───────────────────────────────── */
  const cpbGenerateBtn = document.getElementById("cpb-generate-btn");
  if (cpbGenerateBtn) {
    cpbGenerateBtn.addEventListener("click", () => {
      document.getElementById("generate-btn")?.click();
    });
  }

  // Mirror the loading / stopping state from the real generate button
  const realGenerateBtn = document.getElementById("generate-btn");
  const collapsedGenBtn = document.getElementById("cpb-collapsed-gen");
  if (realGenerateBtn) {
    const observer = new MutationObserver(() => {
      const isLoading = realGenerateBtn.classList.contains("loading");
      const isStopping = realGenerateBtn.classList.contains("stopping");
      const isDisabled = realGenerateBtn.disabled;
      const realLabel = realGenerateBtn.querySelector(".btn-generate-label")?.textContent || "Generate";
      // Mirror state to both buttons (toggle classes, don't overwrite className)
      // Auto-collapse bar when generation finishes
      const wasGenerating = bar.dataset.wasGenerating === "true";
      const isGenerating = isLoading || isStopping;
      bar.dataset.wasGenerating = isGenerating ? "true" : "false";
      if (wasGenerating && !isGenerating) {
        collapseBar();
      }

      [cpbGenerateBtn, collapsedGenBtn].forEach(btn => {
        if (!btn) return;
        btn.classList.toggle("loading", isLoading);
        btn.classList.toggle("stopping", isStopping);
        btn.disabled = isDisabled;
        const lbl = btn.querySelector(".btn-generate-label");
        if (lbl) lbl.textContent = realLabel;
      });
    });
    observer.observe(realGenerateBtn, { attributes: true, subtree: true, characterData: true, childList: true });
  }

  /* ── Gear button — reparent popover to body so it works when sidebar is hidden ── */
  const cpbGearBtn = document.getElementById("cpb-gear-btn");
  const genSettingsPopover = document.getElementById("gen-settings-popover");
  if (genSettingsPopover && genSettingsPopover.parentElement !== document.body) {
    document.body.appendChild(genSettingsPopover);
    genSettingsPopover.style.position = "fixed";
    genSettingsPopover.style.zIndex = "200";
  }
  if (cpbGearBtn) {
    cpbGearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!genSettingsPopover) return;
      const isOpen = genSettingsPopover.style.display !== "none";
      if (isOpen) {
        genSettingsPopover.style.display = "none";
        return;
      }
      // Position above the gear button
      const rect = cpbGearBtn.getBoundingClientRect();
      genSettingsPopover.style.display = "";
      genSettingsPopover.style.right = (window.innerWidth - rect.right) + "px";
      genSettingsPopover.style.bottom = (window.innerHeight - rect.top + 8) + "px";
      genSettingsPopover.style.left = "auto";
      genSettingsPopover.style.top = "auto";
    });
    // Close on outside click
    document.addEventListener("click", (e) => {
      if (genSettingsPopover.style.display === "none") return;
      if (genSettingsPopover.contains(e.target) || cpbGearBtn.contains(e.target)) return;
      genSettingsPopover.style.display = "none";
    });
  }

  /* ── I2I sliders mirror (Transformation + Variation) ── */
  function mirrorSlider(sourceId, mirrorId, valId) {
    const source = document.getElementById(sourceId);
    const mirror = document.getElementById(mirrorId);
    const val = document.getElementById(valId);
    if (!source || !mirror) return;
    mirror.value = source.value;
    if (val) val.textContent = parseFloat(source.value).toFixed(2);
    source.addEventListener("input", () => {
      mirror.value = source.value;
      if (val) val.textContent = parseFloat(source.value).toFixed(2);
    });
    mirror.addEventListener("input", () => {
      source.value = mirror.value;
      source.dispatchEvent(new Event("input", { bubbles: true }));
      if (val) val.textContent = parseFloat(mirror.value).toFixed(2);
    });
  }
  mirrorSlider("strength", "cpb-strength", "cpb-strength-val");
  mirrorSlider("noise", "cpb-noise", "cpb-noise-val");

  // Steps mirror (integer display)
  const stepsSource = document.getElementById("steps");
  const stepsMirror = document.getElementById("cpb-steps");
  const stepsVal = document.getElementById("cpb-steps-val");
  if (stepsSource && stepsMirror) {
    stepsMirror.value = stepsSource.value;
    if (stepsVal) stepsVal.textContent = stepsSource.value;
    stepsSource.addEventListener("input", () => { stepsMirror.value = stepsSource.value; if (stepsVal) stepsVal.textContent = stepsSource.value; });
    stepsMirror.addEventListener("input", () => { stepsSource.value = stepsMirror.value; stepsSource.dispatchEvent(new Event("input", { bubbles: true })); if (stepsVal) stepsVal.textContent = stepsMirror.value; });
  }
  // Scale mirror
  const scaleSource = document.getElementById("scale");
  const scaleMirror = document.getElementById("cpb-scale");
  const scaleVal = document.getElementById("cpb-scale-val");
  if (scaleSource && scaleMirror) {
    scaleMirror.value = scaleSource.value;
    if (scaleVal) scaleVal.textContent = parseFloat(scaleSource.value).toFixed(1);
    scaleSource.addEventListener("input", () => { scaleMirror.value = scaleSource.value; if (scaleVal) scaleVal.textContent = parseFloat(scaleSource.value).toFixed(1); });
    scaleMirror.addEventListener("input", () => { scaleSource.value = scaleMirror.value; scaleSource.dispatchEvent(new Event("input", { bubbles: true })); if (scaleVal) scaleVal.textContent = parseFloat(scaleMirror.value).toFixed(1); });
  }

  /* ── Add Character button ────────────────────────────── */
  document.getElementById("cpb-add-char-btn")?.addEventListener("click", () => {
    if (typeof characters === "undefined" || typeof addCharacterSlot === "undefined") return;
    if (characters.length >= (typeof MAX_CHARACTERS !== "undefined" ? MAX_CHARACTERS : 6)) {
      showStatus("Maximum characters reached");
      return;
    }
    const slotsEl = document.getElementById("character-slots");
    if (slotsEl && typeof _updateCharUI === "function") {
      addCharacterSlot(slotsEl, _updateCharUI);
    } else if (slotsEl) {
      addCharacterSlot(slotsEl, () => {});
    }
    const newIdx = characters.length - 1;
    // Auto distribute position
    const count = characters.length;
    characters[newIdx].x = count === 1 ? 0.5 : (0.2 + (0.6 * newIdx / (count - 1)));
    characters[newIdx].y = 0.5;
    characters[newIdx].positionAuto = true;
    renderCharacterMarkers();
    saveCharactersToCache();
    // Open popover on new character
    const markers = document.querySelectorAll(".char-marker");
    if (markers[newIdx]) openCharacterPopover(newIdx, markers[newIdx]);
  });

  /* ── App settings button ─────────────────────────────── */
  document.getElementById("cpb-app-settings-btn")?.addEventListener("click", () => {
    document.getElementById("settings-btn")?.click();
  });

  /* ── Toolbar button delegates ──────────────────────── */
  document.getElementById("cpb-optimize-btn")?.addEventListener("click", () => {
    document.getElementById("prompt-optimize-btn")?.click();
  });
  document.getElementById("cpb-assist-btn")?.addEventListener("click", () => {
    document.getElementById("prompt-assist-btn")?.click();
  });
  document.getElementById("cpb-history-btn")?.addEventListener("click", () => {
    document.getElementById("prompt-history-btn")?.click();
  });
  document.getElementById("cpb-expand-btn")?.addEventListener("click", () => {
    document.getElementById("prompt-expand-btn")?.click();
  });

  // Mirror loading state on optimize btn
  const realOptimizeBtn = document.getElementById("prompt-optimize-btn");
  const cpbOptimizeBtn  = document.getElementById("cpb-optimize-btn");
  if (realOptimizeBtn && cpbOptimizeBtn) {
    new MutationObserver(() => {
      cpbOptimizeBtn.disabled = realOptimizeBtn.disabled;
      cpbOptimizeBtn.classList.toggle("loading", realOptimizeBtn.classList.contains("loading"));
    }).observe(realOptimizeBtn, { attributes: true });
  }

  /* ── Seed bidirectional mirror ─────────────────────── */
  const sidebarSeed = document.getElementById("seed");
  const cpbSeed     = document.getElementById("cpb-seed");
  const cpbRandBtn  = document.getElementById("cpb-seed-rand-btn");

  if (sidebarSeed && cpbSeed) {
    cpbSeed.value = sidebarSeed.value;
    sidebarSeed.addEventListener("input", () => { cpbSeed.value = sidebarSeed.value; });
    cpbSeed.addEventListener("input", () => {
      sidebarSeed.value = cpbSeed.value;
      sidebarSeed.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  if (cpbRandBtn) {
    cpbRandBtn.addEventListener("click", () => {
      document.getElementById("btn-random-seed")?.click();
      if (cpbSeed) cpbSeed.value = 0;
    });
  }

  /* ── Provider mirror ───────────────────────────────── */
  const sidebarProvider = document.getElementById("provider");
  const cpbProvider     = document.getElementById("cpb-provider");

  if (sidebarProvider && cpbProvider) {
    // Populate options from sidebar select
    function syncProviderOptions() {
      cpbProvider.innerHTML = sidebarProvider.innerHTML;
      cpbProvider.value = sidebarProvider.value;
    }
    syncProviderOptions();

    sidebarProvider.addEventListener("change", () => { cpbProvider.value = sidebarProvider.value; });
    cpbProvider.addEventListener("change", () => {
      sidebarProvider.value = cpbProvider.value;
      sidebarProvider.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  /* ── Resolution mirror ─────────────────────────────── */
  const sidebarRes = document.getElementById("resolution");
  const cpbRes     = document.getElementById("cpb-resolution");
  const cpbMetaSep = document.getElementById("cpb-meta-sep");
  const cpbCanvasField = document.getElementById("cpb-canvas-field");

  if (sidebarRes && cpbRes) {
    // Populate options after the API call has populated the sidebar select.
    // We observe for option additions using MutationObserver.
    function syncResolutionOptions() {
      if (sidebarRes.options.length === 0) return;
      cpbRes.innerHTML = sidebarRes.innerHTML;
      cpbRes.value = sidebarRes.value;
    }

    // Try immediately (options may already be present)
    syncResolutionOptions();

    // Also observe in case options are added asynchronously
    new MutationObserver(syncResolutionOptions).observe(sidebarRes, { childList: true });

    sidebarRes.addEventListener("change", () => { cpbRes.value = sidebarRes.value; });
    cpbRes.addEventListener("change", () => {
      sidebarRes.value = cpbRes.value;
      sidebarRes.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  // Hide canvas field when the sidebar hides it (Grok mode)
  const sidebarCanvasField = document.getElementById("canvas-field");
  if (sidebarCanvasField && cpbCanvasField) {
    function syncCanvasFieldVisibility() {
      const hidden = sidebarCanvasField.style.display === "none";
      cpbCanvasField.style.display = hidden ? "none" : "";
    }
    syncCanvasFieldVisibility();
    new MutationObserver(syncCanvasFieldVisibility).observe(sidebarCanvasField, { attributes: true });
  }

  /* ── Tag autocomplete ──────────────────────────────── */
  if (typeof _tagAC !== "undefined") {
    _tagAC.attach(cpbTa);
  }

  /* ── Enter key: generate (matching sidebar behavior) ── */
  cpbTa.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      const dd = document.getElementById("tag-dropdown");
      if (dd && dd.classList.contains("visible")) return;
      e.preventDefault();
      generate();
    }
    // Cmd/Ctrl+E — open Focus Mode from the CPB textarea
    if ((e.metaKey || e.ctrlKey) && e.key === "e") {
      e.preventDefault();
      document.getElementById("prompt-expand-btn")?.click();
    }
  });

  /* ── Global Cmd/Ctrl+Enter: generate — registered outside this scope ── */

  /* ── Initial population ────────────────────────────── */
  cpbTa.value = sidebarPrompt.value;
  autoGrow(cpbTa);

  /* ── Show/hide bar based on which canvas tab is active ── */
  // The bar is always in the DOM but we track the active tab.
  // We toggle a class on section.canvas instead of display:none
  // so transitions can be applied later.
  const canvasSection = document.querySelector("section.canvas");
  function updateBarVisibility() {
    const panelCanvas = document.getElementById("panel-canvas");
    const isCanvasTab = panelCanvas && panelCanvas.style.display !== "none";
    if (canvasSection) {
      canvasSection.classList.toggle("canvas--non-canvas-tab", !isCanvasTab);
    }
  }

  // Observe panel-canvas display attribute changes
  const panelCanvas = document.getElementById("panel-canvas");
  if (panelCanvas) {
    new MutationObserver(updateBarVisibility).observe(panelCanvas, { attributes: true });
  }
  updateBarVisibility();
}

async function init() {
  try {
    const resp = await fetch("/api/options");
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    const data = await resp.json();
    populateSelect("#sampler", data.samplers.map((s) => ({
      value: s,
      label: SAMPLER_LABELS[s] || s,
    })));
    populateSelect("#resolution", data.resolutions.map((r) => ({
      value: `${r.width}x${r.height}`,
      label: r.label,
    })));

    // Restore saved resolution from localStorage
    const savedResolution = localStorage.getItem("nai-resolution");
    if (savedResolution) {
      const resolutionEl = $("#resolution");
      for (const opt of resolutionEl.options) {
        if (opt.value === savedResolution) {
          resolutionEl.value = savedResolution;
          break;
        }
      }
    }
  } catch (e) {
    showError(`Failed to load options: ${e.message}`);
  }

  bindSlider("steps", "steps-val", 0);
  bindSlider("scale", "scale-val", 1);
  bindSlider("cfg-rescale", "cfg-rescale-val", 2);
  bindSlider("strength", "strength-val", 2);
  bindSlider("noise", "noise-val", 2);

  // Persist resolution selection
  const resolutionEl = $("#resolution");
  if (resolutionEl) {
    resolutionEl.addEventListener("change", () => {
      localStorage.setItem("nai-resolution", resolutionEl.value);
    });
  }

  setupGrokRefs();
  setupCanvasDropZone();

  setupPromptTabs();
  setupHdEnhancement();
  setupTagAutocomplete();
  setupAutoSavePrompt();
  setupHistoryTabs();
  loadGallery();

  $("#generate-btn").addEventListener("click", generate);
  $("#btn-random-seed").addEventListener("click", () => { $("#seed").value = 0; });
  $("#btn-reuse-seed").addEventListener("click", reuseSeed);
  $("#btn-download").addEventListener("click", downloadImage);

  // Seed badge: click to copy
  const seedBadge = $("#info-seed");
  if (seedBadge) {
    seedBadge.style.cursor = "pointer";
    seedBadge.title = "Click to copy seed";
    seedBadge.addEventListener("click", () => {
      const text = seedBadge.textContent.replace(/^Seed:\s*/, "").trim();
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        const orig = seedBadge.textContent;
        seedBadge.textContent = "Copied!";
        seedBadge.style.color = "var(--accent-bright)";
        setTimeout(() => { seedBadge.textContent = orig; seedBadge.style.color = ""; }, 1500);
      });
    });
  }

  // Grok: Set as Source — move current output into the source slot in the Images panel
  const setAsSourceBtn = document.getElementById("btn-set-as-source");
  if (setAsSourceBtn) {
    setAsSourceBtn.addEventListener("click", () => {
      if (!state.lastGeneratedImageBase64) return;
      state.img2img = state.lastGeneratedImageBase64;
      renderGrokImagesList();
      syncInpaintButtonVisibility();
      updateCanvasPanel();
      showStatus("Output set as source — describe your next edit");
    });
  }

  // Refine Prompt — analyze output image and improve prompt
  const refineBtn = document.getElementById("btn-refine-prompt");
  if (refineBtn) {
    refineBtn.addEventListener("click", async () => {
      if (!state.lastGeneratedImageBase64) return;
      const promptEl = $("#prompt");
      const basePrompt = promptEl?.value.trim();
      if (!basePrompt) { showStatus("No prompt to refine"); return; }

      // Re-compose full prompt including character blocks
      const charPrompts = characters.map(c => c.prompt.trim()).filter(Boolean);
      const fullPrompt = charPrompts.length > 0
        ? [basePrompt, ...charPrompts].join(" | ")
        : basePrompt;

      refineBtn.disabled = true;
      refineBtn.classList.add("loading");
      showStatus("Analyzing image & refining prompt…");

      try {
        console.log("[refine] sending prompt:", fullPrompt.substring(0, 100), "image size:", state.lastGeneratedImageBase64.length);
        const resp = await fetch("/api/prompt-refine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            current_prompt: fullPrompt,
            image: state.lastGeneratedImageBase64,
          }),
        });
        if (!resp.ok) {
          const errBody = await resp.text();
          console.error("[refine] API error:", resp.status, errBody);
          let err = "Refine failed";
          try { err = JSON.parse(errBody).detail || err; } catch { err = errBody.substring(0, 200) || err; }
          throw new Error(err);
        }
        const data = await resp.json();
        console.log("[refine] response:", data);
        if (data.prompt) {
          window._savePromptToHistory?.();
          TagIntelligence.recordChange("refine", fullPrompt, data.prompt);
          const split = populateCharactersFromPipe(data.prompt);
          console.log("[refine] split result:", split);
          if (split.applied) {
            promptEl.value = split.base;
            showStatus((data.changes || "Prompt refined") + ` — ${split.charCount} character(s) moved to blocks`, 5000);
          } else {
            promptEl.value = data.prompt;
            showStatus(data.changes || "Prompt refined", 5000);
          }
          promptEl.dispatchEvent(new Event("input", { bubbles: true }));
          flashPromptTextarea();
        }
        if (typeof fetchGrokUsage === "function") fetchGrokUsage();
      } catch (err) {
        console.error("[refine] error:", err);
        showStatus("Refine error: " + err.message);
      } finally {
        refineBtn.disabled = false;
        refineBtn.classList.remove("loading");
      }
    });
  }

  // NovelAI → Grok handoff buttons
  function sendToGrok(outputType) {
    if (!state.lastGeneratedImageBase64) return;
    state.img2img = state.lastGeneratedImageBase64;
    grokRefs.length = 0; // clear refs for a clean edit
    state.grokOutputType = outputType;
    // Switch provider
    const providerEl = document.getElementById("provider");
    if (providerEl) providerEl.value = "grok";
    // Set Grok output type toggle
    const outputToggle = document.getElementById("grok-output-type");
    if (outputToggle) outputToggle.value = outputType;
    applyProvider("grok");
    localStorage.setItem("nai-provider", "grok");
    // Reflect new source in the Images panel
    renderGrokImagesList();
    // Clear and focus prompt
    const promptEl = document.getElementById("prompt");
    if (promptEl) { promptEl.value = ""; promptEl.focus(); }
    showStatus(outputType === "video" ? "Image sent to Grok — describe the animation" : "Image sent to Grok — describe your edit");
  }

  const editInGrokBtn = document.getElementById("btn-edit-in-grok");
  if (editInGrokBtn) editInGrokBtn.addEventListener("click", () => sendToGrok("image"));

  const animateInGrokBtn = document.getElementById("btn-animate-in-grok");
  if (animateInGrokBtn) animateInGrokBtn.addEventListener("click", () => sendToGrok("video"));

  setupTagBrowser();
  setupGuide();
  setupSettings();
  setupPromptFocus();
  setupCharacters();
  setupLightbox();
  setupExplorePanel();
  setupPromptAssist();
  setupPromptOptimize();
  setupLayers();
  setupCanvasLayerPanel();
  setupCanvasViewToggle();
  setupCanvasPromptBar();

  // Load recent characters at startup so autocomplete is populated immediately
  loadRecentCharacters();

  // Sidebar toggle
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const sidebar = document.getElementById("sidebar");
  if (sidebarToggle && sidebar) {
    const workspace = sidebar.closest(".workspace");
    const savedCollapsed = localStorage.getItem("nai-sidebar-collapsed") === "true";
    if (savedCollapsed) { sidebar.classList.add("collapsed"); if (workspace) workspace.classList.add("sidebar-collapsed"); }
    sidebarToggle.addEventListener("click", () => {
      sidebar.classList.toggle("collapsed");
      if (workspace) workspace.classList.toggle("sidebar-collapsed");
      localStorage.setItem("nai-sidebar-collapsed", sidebar.classList.contains("collapsed"));
    });
    // Tab key toggles sidebar
    document.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.target.matches("input, textarea, [contenteditable]")) {
        e.preventDefault();
        sidebarToggle.click();
      }
    });
  }

  // ── Provider switching ────────────────────────────────────
  const providerEl = document.getElementById("provider");
  if (providerEl) {
    const savedProvider = localStorage.getItem("nai-provider") || "novelai";
    providerEl.value = savedProvider;
    applyProvider(savedProvider);

    providerEl.addEventListener("change", (e) => {
      applyProvider(e.target.value);
    });
  }

  // Grok quota bar — click to refresh
  const quotaBar = document.getElementById("grok-quota-bar");
  if (quotaBar) quotaBar.addEventListener("click", fetchGrokUsage);

  // ── Grok: Output type toggle ──────────────────────────────
  document.querySelectorAll(".output-type-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".output-type-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.grokOutputType = btn.dataset.type;

      const videoControls = document.getElementById("grok-video-controls");
      if (videoControls) videoControls.style.display = btn.dataset.type === "video" ? "" : "none";

      const generateBtn = document.getElementById("generate-btn");
      if (generateBtn) {
        const labelEl = generateBtn.querySelector(".btn-generate-label");
        if (labelEl) labelEl.textContent = btn.dataset.type === "video" ? "Generate Video" : "Generate";
      }
    });
  });

  // ── Grok: Duration slider display ────────────────────────
  const durationSlider = document.getElementById("grok-duration");
  const durationVal    = document.getElementById("grok-duration-val");
  if (durationSlider && durationVal) {
    durationSlider.addEventListener("input", () => {
      durationVal.textContent = durationSlider.value + "s";
    });
  }

  // Overflow menu toggle
  const overflowToggle = $("#btn-overflow-toggle");
  const overflowMenu = $("#overflow-menu");
  if (overflowToggle && overflowMenu) {
    overflowToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      overflowMenu.classList.toggle("open");
    });
    document.addEventListener("click", () => overflowMenu.classList.remove("open"));
    overflowMenu.addEventListener("click", () => overflowMenu.classList.remove("open"));
  }

  // "×" Clear canvas — works from both the old hidden button and the new tab bar button
  function clearCanvas() {
    state.img2img = null;
    state.canvasImageBase64 = null;
    state.lastImageBase64 = null;
    state.lastGeneratedImageBase64 = null;
    state.lastVideoBase64 = null;
    const output = $("#output");
    if (output) {
      clearOutput(output);
      output.innerHTML = '<div class="placeholder"><div class="placeholder-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></div><p class="placeholder-title">Your creation awaits</p><p class="placeholder-sub">Press Generate or Enter</p><p class="placeholder-drop-hint">or drop / paste an image as source</p></div>';
    }
    const actions = $("#image-actions");
    if (actions) actions.style.display = "none";
    // Hide collapsed actions and clear button
    const collapsedActions = document.getElementById("cpb-collapsed-actions");
    if (collapsedActions) collapsedActions.style.display = "none";
    const cvtClear = document.getElementById("cvt-clear");
    if (cvtClear) cvtClear.style.display = "none";
    syncInpaintButtonVisibility();
    updateCanvasPanel();
  }
  const clearCanvasBtn = $("#btn-clear-canvas");
  if (clearCanvasBtn) clearCanvasBtn.addEventListener("click", clearCanvas);
  const cvtClearBtn = document.getElementById("cvt-clear");
  if (cvtClearBtn) cvtClearBtn.addEventListener("click", clearCanvas);

  // Enter in prompt/negative textarea = generate (Shift+Enter = newline)
  const promptEl = $("#prompt");
  const negativeEl = $("#negative-prompt");
  [promptEl, negativeEl].forEach((el) => {
    if (!el) return;
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        // Don't generate if autocomplete dropdown is visible
        const dd = $("#tag-dropdown");
        if (dd && dd.classList.contains("visible")) return;
        e.preventDefault();
        generate();
      }
    });
  });

  // Generation Settings popover toggle
  const gearBtn = $("#gen-settings-btn");
  const genPopover = $("#gen-settings-popover");
  if (gearBtn && genPopover) {
    gearBtn.addEventListener("click", () => {
      const open = genPopover.style.display !== "none";
      genPopover.style.display = open ? "none" : "flex";
      gearBtn.classList.toggle("active", !open);
    });
    // Close on outside click
    document.addEventListener("click", (e) => {
      if (genPopover.style.display === "none") return;
      if (!genPopover.contains(e.target) && !gearBtn.contains(e.target)) {
        genPopover.style.display = "none";
        gearBtn.classList.remove("active");
      }
    });
  }

  // Also keep Cmd/Ctrl+Enter as global shortcut
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      generate();
    }
    // Escape closes the crop overlay and gen-settings popover
    if (e.key === "Escape") {
      const co = $("#crop-overlay");
      if (co && co.style.display !== "none") closeCropOverlay();
      if (genPopover && genPopover.style.display !== "none") {
        genPopover.style.display = "none";
        if (gearBtn) gearBtn.classList.remove("active");
      }
    }
  });

  // Layer undo/redo: Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z
  // Guard: skip if focus is in an editable field
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key !== "z") return;
    const tag = document.activeElement && document.activeElement.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (document.activeElement && document.activeElement.isContentEditable) return;
    e.preventDefault();
    if (e.shiftKey) {
      redoLayer();
    } else {
      undoLayer();
    }
  });
}

// Global Cmd/Ctrl+Enter → generate (works even when prompt bar is collapsed)
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    document.getElementById("generate-btn")?.click();
  }
});

// Global Cmd/Ctrl+E → open Prompt Editor
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "e") {
    e.preventDefault();
    document.getElementById("prompt-expand-btn")?.click();
  }
});

init();
