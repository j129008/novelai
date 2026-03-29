/* ═══════════════════════════════════════════════════════════
   TAG AUTOCOMPLETE — shared singleton dropdown
   Single dropdown element (position: fixed) shared by all
   textareas. getBoundingClientRect() positions it correctly
   under any textarea regardless of scroll context or
   overflow:hidden ancestors.
   ═══════════════════════════════════════════════════════════ */

const _tagAC = (() => {
  const dropdown = $("#tag-dropdown");
  let selectedIdx = -1;
  let activeEl = null;   // the textarea/input currently driving autocomplete
  let debounceTimer = null;

  // ── Positioning ─────────────────────────────────────────
  function repositionDropdown() {
    if (!activeEl) return;
    const rect = activeEl.getBoundingClientRect();
    const viewH = window.innerHeight;
    const ddH = Math.min(220, dropdown.scrollHeight || 220);
    const spaceBelow = viewH - rect.bottom;
    const showAbove = spaceBelow < ddH + 8 && rect.top > ddH + 8;

    dropdown.style.width = rect.width + "px";
    dropdown.style.left  = rect.left + "px";
    if (showAbove) {
      dropdown.style.top    = "";
      dropdown.style.bottom = (viewH - rect.top + 4) + "px";
    } else {
      dropdown.style.bottom = "";
      dropdown.style.top    = (rect.bottom + 2) + "px";
    }
  }

  // ── Helpers ──────────────────────────────────────────────
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function formatCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000)    return (n / 1000).toFixed(0) + "k";
    return String(n);
  }

  function getWordAtCursor(el) {
    const val = el.value;
    const cursor = el.selectionStart;
    let start = val.lastIndexOf(",", cursor - 1) + 1;
    while (start < cursor && val[start] === " ") start++;
    const word = val.slice(start, cursor).trim();
    return { word, start, end: cursor };
  }

  // ── Dropdown render ──────────────────────────────────────
  async function fetchAndShow(query) {
    const isCharTextarea = activeEl && activeEl.classList.contains("char-slot-textarea");
    const minLen = isCharTextarea ? 1 : 2;
    if (query.length < minLen) { hide(); return; }
    try {
      const resp = await fetch(`/api/tags?q=${encodeURIComponent(query)}`);
      if (!resp.ok) return;
      const apiTags = await resp.json();

      // For character textareas, find recent matches and prepend them
      if (isCharTextarea && _recentCharacters.length) {
        const qNorm = query.toLowerCase().replace(/ /g, "_");
        const recentMatches = _recentCharacters
          .filter(rc => rc.tag.toLowerCase().includes(qNorm))
          .slice(0, 3);
        const recentTagNames = new Set(recentMatches.map(r => r.tag));
        const dedupedTags = apiTags.filter(t => !recentTagNames.has(t.name));
        show(dedupedTags, query, recentMatches);
      } else {
        show(apiTags, query, []);
      }
    } catch { /* ignore */ }
  }

  function buildNameSpan(tagName, q) {
    const nameSpan = document.createElement("span");
    nameSpan.className = "tag-item-name";
    const name = tagName.replace(/_/g, " ");
    const qDisplay = q.replace(/_/g, " ");
    const idx = name.toLowerCase().indexOf(qDisplay.toLowerCase());
    if (idx >= 0) {
      nameSpan.innerHTML = escapeHtml(name.slice(0, idx))
        + "<mark>" + escapeHtml(name.slice(idx, idx + qDisplay.length)) + "</mark>"
        + escapeHtml(name.slice(idx + qDisplay.length));
    } else {
      nameSpan.textContent = name;
    }
    return nameSpan;
  }

  function show(tags, query, recentMatches) {
    if (!tags.length && !recentMatches.length) { hide(); return; }
    selectedIdx = -1;
    const q = query.toLowerCase();
    dropdown.innerHTML = "";

    // Prepend recent character matches
    for (const rc of recentMatches) {
      const item = document.createElement("div");
      item.className = "tag-item tag-item--recent";

      const nameSpan = buildNameSpan(rc.tag, q);

      const badgeSpan = document.createElement("span");
      badgeSpan.className = "tag-item-recent-badge";
      badgeSpan.textContent = "RECENT";

      const countSpan = document.createElement("span");
      countSpan.className = "tag-item-count";
      countSpan.textContent = `\u00d7${rc.count}`;

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "tag-item-delete";
      delBtn.textContent = "\u00d7";
      delBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        fetch(`/api/recent-characters/${encodeURIComponent(rc.tag)}`, { method: "DELETE" });
        const idx = _recentCharacters.indexOf(rc);
        if (idx >= 0) _recentCharacters.splice(idx, 1);
        item.remove();
        if (!dropdown.querySelectorAll(".tag-item").length) hide();
      });

      item.appendChild(nameSpan);
      item.appendChild(badgeSpan);
      item.appendChild(countSpan);
      item.appendChild(delBtn);

      item.addEventListener("mousedown", (e) => {
        if (e.target.closest(".tag-item-delete")) return;
        e.preventDefault();
        insert(rc.tag);
      });

      dropdown.appendChild(item);
    }

    // API results
    tags.forEach((tag) => {
      const item = document.createElement("div");
      item.className = "tag-item";

      const nameSpan = buildNameSpan(tag.name, q);

      const catSpan = document.createElement("span");
      catSpan.className = "tag-item-cat";
      catSpan.dataset.cat = tag.category;
      catSpan.textContent = tag.category;

      const countSpan = document.createElement("span");
      countSpan.className = "tag-item-count";
      countSpan.textContent = formatCount(tag.count);

      item.appendChild(nameSpan);
      item.appendChild(catSpan);
      item.appendChild(countSpan);

      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        insert(tag.name);
      });

      dropdown.appendChild(item);
    });
    dropdown.classList.add("visible");
    repositionDropdown();
  }

  function hide() {
    dropdown.classList.remove("visible");
    selectedIdx = -1;
  }

  // ── Tag insertion ────────────────────────────────────────
  function insert(tagName) {
    if (!activeEl) return;
    const { start, end } = getWordAtCursor(activeEl);
    const val = activeEl.value;
    const before = val.slice(0, start);
    const after  = val.slice(end);
    const tag    = tagName.replace(/_/g, " ");
    const needsCommaBefore = before.length > 0 && !before.trimEnd().endsWith(",");
    const needsCommaAfter = after.length === 0 || !after.trimStart().startsWith(",");
    const insertStr = (needsCommaBefore ? ", " : "") + tag + (needsCommaAfter ? ", " : "");
    activeEl.value = before + insertStr + after;
    const newPos = before.length + insertStr.length;
    activeEl.selectionStart = activeEl.selectionEnd = newPos;
    activeEl.focus();
    activeEl.dispatchEvent(new Event("input", { bubbles: true }));
    hide();
  }

  // ── Event handlers for a single element ─────────────────
  function handleInput(e) {
    // Skip hidden elements (e.g. sidebar #prompt synced from focus mode)
    // to avoid repositioning the dropdown off-screen and cancelling timers
    if (!e.target.offsetParent && e.target.id !== "prompt-focus-textarea") return;
    clearTimeout(debounceTimer);
    activeEl = e.target;
    const { word } = getWordAtCursor(e.target);
    debounceTimer = setTimeout(() => fetchAndShow(word), 150);
  }

  function handleKeydown(e) {
    if (!dropdown.classList.contains("visible")) return;
    const items = dropdown.querySelectorAll(".tag-item");
    if (!items.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle("selected", i === selectedIdx));
      if (selectedIdx >= 0) items[selectedIdx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle("selected", i === selectedIdx));
      if (selectedIdx >= 0) items[selectedIdx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Tab") {
      // Tab always autocompletes: select first item if none highlighted
      if (selectedIdx < 0 && items.length > 0) selectedIdx = 0;
      if (selectedIdx >= 0) {
        e.preventDefault();
        const name = items[selectedIdx].querySelector(".tag-item-name").textContent;
        insert(name.replace(/ /g, "_"));
      }
    } else if (e.key === "Escape") {
      e.stopImmediatePropagation();
      hide();
    }
  }

  function handleBlur() {
    setTimeout(hide, 150);
  }

  function handleFocus(e) {
    activeEl = e.target;
  }

  // ── Public: attach autocomplete to any input/textarea ───
  function attach(el) {
    el.addEventListener("focus",   handleFocus);
    el.addEventListener("input",   handleInput);
    el.addEventListener("keydown", handleKeydown);
    el.addEventListener("blur",    handleBlur);
  }

  // Reposition on scroll/resize so dropdown follows the field
  window.addEventListener("scroll",  () => { if (dropdown.classList.contains("visible")) repositionDropdown(); }, { passive: true });
  window.addEventListener("resize",  () => { if (dropdown.classList.contains("visible")) repositionDropdown(); }, { passive: true });

  return { attach, hide };
})();

function setupTagAutocomplete() {
  const prompt   = $("#prompt");
  const negative = $("#negative-prompt");
  if (!prompt) return;
  _tagAC.attach(prompt);
  if (negative) _tagAC.attach(negative);
}

const VARIATION_DIMENSIONS = {
  lighting: {
    label: "Lighting",
    hint: "Change light source, time of day, ambient light",
    variants: [
      { label: "Warm",     tags: "soft natural lighting, golden hour" },
      { label: "Dramatic", tags: "dramatic rim lighting, dark atmosphere" },
      { label: "Neon",     tags: "neon light, cyberpunk lighting" },
      { label: "Moonlit",  tags: "moonlight, ethereal glow, night" },
    ],
  },
  artStyle: {
    label: "Art Style",
    hint: "Change art medium and line style",
    variants: [
      { label: "Watercolor", tags: "watercolor, painterly, loose brushstrokes" },
      { label: "Cel",        tags: "detailed lineart, clean lines, cel shaded" },
      { label: "Oil",        tags: "oil painting, impasto texture, rich colors" },
      { label: "Sketch",     tags: "sketch style, pencil, rough lines" },
    ],
  },
  composition: {
    label: "Composition",
    hint: "Change camera distance and angle",
    variants: [
      { label: "Close-up",  tags: "close-up, portrait, face focus" },
      { label: "Full Body", tags: "full body, wide shot, establishing" },
      { label: "Top Down",  tags: "from above, bird's eye view, overhead angle" },
      { label: "Dynamic",   tags: "dynamic angle, dutch angle, cinematic" },
    ],
  },
  mood: {
    label: "Mood",
    hint: "Change mood and color tone",
    variants: [
      { label: "Melancholy", tags: "melancholic, somber, wistful atmosphere" },
      { label: "Vibrant",    tags: "vibrant, energetic, lively" },
      { label: "Mysterious", tags: "mysterious, eerie, tension" },
      { label: "Serene",     tags: "peaceful, serene, calm" },
    ],
  },
};

function insertTagIntoPrompt(tag) {
  const el = $("#prompt");
  if (!el) return;
  const current = el.value.trim();
  el.value = current ? current + ", " + tag : tag;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function removeTagFromPrompt(tag) {
  const el = $("#prompt");
  if (!el) return;
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let val = el.value;
  val = val.replace(new RegExp(",\\s*" + escaped + "(?=,|$)", "g"), "");
  val = val.replace(new RegExp("^" + escaped + ",\\s*", "g"), "");
  val = val.replace(new RegExp("^" + escaped + "$", "g"), "");
  val = val.trim().replace(/,\s*$/, "");
  el.value = val;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}


/* ═══════════════════════════════════════════════════════════
   RECENT CHARACTERS
   ═══════════════════════════════════════════════════════════ */

let _recentCharacters = []; // [{ tag, count }, ...] sorted by count desc

async function recordRecentCharacters(rawPrompt) {
  // 1. Split on comma and pipe to get tokens
  const raw = rawPrompt.split(/[,|]/).map((t) => t.trim());

  // 2. Strip weight syntax: {, }, [, ], and numeric prefix patterns like 1.5::
  const stripped = raw.map((t) =>
    t
      .replace(/^\d+(\.\d+)?::/, "")   // numeric prefix like 1.5::
      .replace(/^-\d+(\.\d+)?::/, "")  // negative numeric prefix like -1::
      .replace(/::$/, "")               // trailing ::
      .replace(/[{}\[\]]/g, "")         // braces and brackets
      .trim()
  );

  // 3. Normalize: spaces → underscores (tags.csv uses underscores)
  // Then filter: keep tokens longer than 3 chars that contain _ or (
  const candidates = stripped
    .map((t) => t.replace(/ /g, "_"))
    .filter((t) => t.length > 3 && (t.includes("_") || t.includes("(")));
  if (!candidates.length) return;

  // 4. Check which are real character tags
  try {
    const resp = await fetch(`/api/tags/check-characters?tags=${encodeURIComponent(candidates.join(","))}`);
    if (!resp.ok) return;
    const data = await resp.json();
    const confirmed = data.characters || [];
    if (!confirmed.length) return;

    // 5. Record confirmed character tags
    await fetch("/api/recent-characters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: confirmed }),
    });

    // 6. Refresh recent characters list
    await loadRecentCharacters();
  } catch { /* fire-and-forget, silent */ }
}

async function loadRecentCharacters() {
  try {
    const resp = await fetch("/api/recent-characters");
    if (!resp.ok) return;
    const data = await resp.json();
    _recentCharacters = data.characters || [];
  } catch { /* silent */ }
}


/* ═══════════════════════════════════════════════════════════
   TAG BROWSER
   ═══════════════════════════════════════════════════════════ */

let _tagCategories = [];

async function loadTagCategories() {
  try {
    const resp = await fetch("/api/tags/categories");
    if (!resp.ok) return;
    const data = await resp.json();
    _tagCategories = data.categories || [];
  } catch { /* silent */ }
}

function setupTagBrowser() {
  const btn = $("#btn-tag-browser");
  const drawer = $("#tag-browser");
  const closeBtn = $("#tag-browser-close");
  const canvas = drawer.closest(".canvas");

  function isOpen() { return drawer.style.display !== "none" && !drawer.classList.contains("tag-browser--closing"); }

  function open() {
    drawer.classList.remove("tag-browser--closing");
    drawer.style.display = "flex";
    canvas.classList.add("tag-browser-open");
    btn.classList.add("btn-action--primary");
    btn.setAttribute("aria-expanded", "true");
    renderTagIntelligence();
  }

  function close() {
    if (!isOpen()) return;
    canvas.classList.remove("tag-browser-open");
    btn.classList.remove("btn-action--primary");
    btn.setAttribute("aria-expanded", "false");
    drawer.classList.add("tag-browser--closing");
    drawer.addEventListener("animationend", function handler() {
      drawer.removeEventListener("animationend", handler);
      drawer.style.display = "none";
      drawer.classList.remove("tag-browser--closing");
    });
  }

  btn.addEventListener("click", () => { isOpen() ? close() : open(); });
  closeBtn.addEventListener("click", close);

  canvas.addEventListener("pointerdown", (e) => {
    if (!isOpen()) return;
    if (drawer.contains(e.target) || btn.contains(e.target)) return;
    close();
  });

  // ── Insertion target lock ─────────────────────────────────
  let _insertTarget = "prompt";
  let _savedCursor = { el: null, pos: -1 };

  const pillPrompt   = $("#tag-insert-prompt");
  const pillNegative = $("#tag-insert-negative");

  function setInsertTarget(target) {
    _insertTarget = target;
    pillPrompt.classList.toggle("active", target === "prompt");
    pillNegative.classList.toggle("active", target === "negative");
    _savedCursor = {
      el: target === "prompt" ? $("#prompt") : $("#negative-prompt"),
      pos: _savedCursor.pos,
    };
  }

  if (pillPrompt) pillPrompt.addEventListener("click", () => setInsertTarget("prompt"));
  if (pillNegative) pillNegative.addEventListener("click", () => setInsertTarget("negative"));

  document.querySelectorAll(".prompt-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.dataset.target === "prompt") setInsertTarget("prompt");
      else setInsertTarget("negative");
    });
  });

  // Track last focused textarea — includes character block textareas
  let _lastFocusedTextarea = null;

  function trackTextareaFocus(el) {
    el.addEventListener("focus", function() { _lastFocusedTextarea = this; });
    el.addEventListener("blur", function() {
      _savedCursor = { el: this, pos: this.selectionStart };
    });
  }

  trackTextareaFocus($("#prompt"));
  trackTextareaFocus($("#negative-prompt"));

  // Also track character block textareas (use MutationObserver for dynamically added ones)
  const charSlotsEl = document.getElementById("character-slots");
  if (charSlotsEl) {
    const observer = new MutationObserver(() => {
      charSlotsEl.querySelectorAll(".char-slot-textarea").forEach(ta => {
        if (!ta._tiTracked) { ta._tiTracked = true; trackTextareaFocus(ta); }
      });
    });
    observer.observe(charSlotsEl, { childList: true, subtree: true });
    // Track any already existing
    charSlotsEl.querySelectorAll(".char-slot-textarea").forEach(ta => {
      if (!ta._tiTracked) { ta._tiTracked = true; trackTextareaFocus(ta); }
    });
  }

  function insertTag(tag, chipEl) {
    // Determine target: use last focused textarea if it's a char-slot, otherwise use pill target
    let promptEl;
    if (_lastFocusedTextarea && _lastFocusedTextarea.classList.contains("char-slot-textarea")) {
      promptEl = _lastFocusedTextarea;
    } else {
      promptEl = _insertTarget === "negative" ? $("#negative-prompt") : $("#prompt");
    }

    const display = tag.replace(/_/g, " ");
    const val = promptEl.value;

    // Always append at end — simpler and avoids breaking tags in the middle
    const prefix = val.length > 0 && !val.trimEnd().endsWith(",") ? ", " : val.length > 0 ? " " : "";
    promptEl.value = val + prefix + display;

    _savedCursor = { el: promptEl, pos: promptEl.value.length };
    _lastFocusedTextarea = promptEl;
    promptEl.dispatchEvent(new Event("input", { bubbles: true }));

    // Auto-grow for char textareas
    if (promptEl.classList.contains("char-slot-textarea")) {
      promptEl.style.height = "auto";
      promptEl.style.height = promptEl.scrollHeight + "px";
    }

    if (chipEl) {
      chipEl.classList.add("tag-chip--inserted");
      setTimeout(() => chipEl.classList.remove("tag-chip--inserted"), 300);
    }

    const box = promptEl.closest(".prompt-box") || promptEl.closest(".char-slot-card");
    if (box) {
      box.style.borderColor = "var(--accent)";
      box.style.boxShadow = "0 0 0 3px var(--accent-dim)";
      setTimeout(() => { box.style.borderColor = ""; box.style.boxShadow = ""; }, 300);
    }
  }

  // ── Tag Intelligence rendering ────────────────────────────

  function renderTagIntelligence() {
    renderWhatChanged();
    renderDiscoveries();
    renderSavedTags();
    renderSuggestions();
  }

  // Re-render when optimize/refine runs
  document.addEventListener("tag-intelligence-updated", () => {
    if (isOpen()) renderTagIntelligence();
  });

  // Section 1: What Changed
  function renderWhatChanged() {
    const container = $("#ti-diff");
    if (!container) return;
    const last = TagIntelligence.getLastChange();
    if (!last) {
      container.innerHTML = '<p class="ti-empty">Run Optimize or Refine to see what the AI changed in your prompt.</p>';
      return;
    }

    container.innerHTML = "";

    // Meta line
    const meta = document.createElement("div");
    meta.className = "ti-diff-meta";
    const sourceLabel = last.source === "optimize" ? "Optimize" : "Refine";
    meta.textContent = `Last: ${sourceLabel}  ${TagIntelligence.timeAgo(last.ts)}`;
    container.appendChild(meta);

    // AI explanation (from data.changes)
    if (last.explanation) {
      const expl = document.createElement("div");
      expl.className = "ti-diff-explanation";
      expl.textContent = last.explanation;
      container.appendChild(expl);
    }

    // Helper: strip section prefix "s{n}:" and return { tag, sectionIndex }
    function parseLabeled(raw) {
      const m = raw.match(/^s(\d+):(.+)$/);
      if (m) return { tag: m[2], sectionIndex: parseInt(m[1], 10) };
      return { tag: raw, sectionIndex: -1 };
    }

    // Section label helper: "base" for s0, "char N" for s1+
    function sectionLabel(idx) {
      if (idx < 0) return null;
      if (idx === 0) return "base";
      return `char ${idx}`;
    }

    // Added tags
    for (const raw of last.added) {
      const { tag, sectionIndex } = parseLabeled(raw);
      const row = document.createElement("div");
      row.className = "ti-diff-row";
      const icon = document.createElement("span");
      icon.className = "ti-diff-icon ti-diff-icon--add";
      icon.textContent = "+";
      const chip = document.createElement("button");
      chip.className = "ti-chip--added";
      chip.type = "button";
      chip.textContent = tag.replace(/_/g, " ");
      chip.addEventListener("click", () => insertTag(tag, chip));
      row.appendChild(icon);
      row.appendChild(chip);
      // Save/unsave button
      const saveBtn = document.createElement("button");
      saveBtn.className = "ti-save-btn" + (TagIntelligence.isTagSaved(tag) ? " ti-save-btn--active" : "");
      saveBtn.type = "button";
      saveBtn.title = TagIntelligence.isTagSaved(tag) ? "Remove from saved" : "Save for future use";
      saveBtn.textContent = TagIntelligence.isTagSaved(tag) ? "★" : "☆";
      saveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (TagIntelligence.isTagSaved(tag)) {
          TagIntelligence.removeSavedTag(tag);
          saveBtn.textContent = "☆";
          saveBtn.classList.remove("ti-save-btn--active");
          saveBtn.title = "Save for future use";
        } else {
          TagIntelligence.saveTag(tag);
          saveBtn.textContent = "★";
          saveBtn.classList.add("ti-save-btn--active");
          saveBtn.title = "Remove from saved";
        }
        renderSavedTags();
      });
      row.appendChild(saveBtn);
      if (last.hasMultiSection && sectionIndex >= 0) {
        const label = document.createElement("span");
        label.className = "ti-diff-section-label";
        label.textContent = sectionLabel(sectionIndex);
        row.appendChild(label);
      }
      container.appendChild(row);
    }

    // Removed tags
    for (const raw of last.removed) {
      const { tag, sectionIndex } = parseLabeled(raw);
      const row = document.createElement("div");
      row.className = "ti-diff-row";
      const icon = document.createElement("span");
      icon.className = "ti-diff-icon ti-diff-icon--remove";
      icon.textContent = "−";
      const chip = document.createElement("span");
      chip.className = "ti-chip--removed";
      chip.textContent = tag.replace(/_/g, " ");
      row.appendChild(icon);
      row.appendChild(chip);
      if (last.hasMultiSection && sectionIndex >= 0) {
        const label = document.createElement("span");
        label.className = "ti-diff-section-label";
        label.textContent = sectionLabel(sectionIndex);
        row.appendChild(label);
      }
      container.appendChild(row);
    }

    // Reorder notice
    if (last.reordered && last.added.length === 0 && last.removed.length === 0) {
      const row = document.createElement("div");
      row.className = "ti-diff-row";
      const icon = document.createElement("span");
      icon.className = "ti-diff-icon ti-diff-icon--reorder";
      icon.textContent = "↕";
      const text = document.createElement("span");
      text.className = "ti-diff-reorder";
      text.textContent = "Tags reordered for better results";
      row.appendChild(icon);
      row.appendChild(text);
      container.appendChild(row);
    } else if (last.reordered) {
      const note = document.createElement("div");
      note.className = "ti-diff-reorder";
      note.textContent = "↕ also reordered tags";
      container.appendChild(note);
    }

    // If nothing changed at all
    if (last.added.length === 0 && last.removed.length === 0 && !last.reordered) {
      const note = document.createElement("p");
      note.className = "ti-empty";
      note.textContent = "No significant changes detected.";
      container.appendChild(note);
    }
  }

  // Section 2: New Discoveries
  function renderDiscoveries() {
    const container = $("#ti-disc-grid");
    const countBadge = $("#ti-disc-count");
    if (!container) return;

    const discoveries = TagIntelligence.getDiscoveries();
    const show = discoveries.slice(0, 20); // max 20

    if (countBadge) {
      if (discoveries.length > 0) {
        countBadge.textContent = discoveries.length;
        countBadge.style.display = "";
      } else {
        countBadge.style.display = "none";
      }
    }

    if (!show.length) {
      container.innerHTML = '<p class="ti-empty">New tags will appear here after your first Optimize or Refine.</p>';
      return;
    }

    container.innerHTML = "";
    for (const disc of show) {
      const chip = document.createElement("button");
      chip.className = "tag-chip";
      chip.type = "button";
      chip.textContent = disc.tag.replace(/_/g, " ");
      chip.title = `Discovered via ${disc.source}  ${TagIntelligence.timeAgo(disc.ts)}`;
      chip.addEventListener("click", () => insertTag(disc.tag, chip));
      container.appendChild(chip);
    }
  }

  // Section: Saved Tags
  function renderSavedTags() {
    const section = $("#ti-saved");
    const container = $("#ti-saved-grid");
    const countBadge = $("#ti-saved-count");
    if (!container || !section) return;

    const saved = TagIntelligence.getSavedTags();
    if (saved.length === 0) {
      section.style.display = "none";
      return;
    }

    section.style.display = "";
    if (countBadge) countBadge.textContent = saved.length;
    container.innerHTML = "";

    for (const tag of saved) {
      const wrap = document.createElement("span");
      wrap.className = "ti-saved-chip";

      const chip = document.createElement("button");
      chip.className = "tag-chip";
      chip.type = "button";
      chip.textContent = tag.replace(/_/g, " ");
      chip.addEventListener("click", () => insertTag(tag, chip));
      wrap.appendChild(chip);

      const removeBtn = document.createElement("button");
      removeBtn.className = "ti-saved-remove";
      removeBtn.type = "button";
      removeBtn.textContent = "\u00d7";
      removeBtn.title = "Remove from saved";
      removeBtn.addEventListener("click", () => {
        TagIntelligence.removeSavedTag(tag);
        renderSavedTags();
        renderWhatChanged(); // refresh star states
      });
      wrap.appendChild(removeBtn);
      container.appendChild(wrap);
    }
  }

  // Section: Add Next (suggestions)
  let _suggestionsLoading = false;

  async function renderSuggestions() {
    const container = $("#ti-suggestions");
    const refreshBtn = $("#ti-refresh");
    if (!container) return;

    const promptText = $("#prompt")?.value?.trim() || "";
    const tags = TagIntelligence.parseTags(promptText);

    if (tags.length < 2) {
      container.innerHTML = '<p class="ti-empty">Type a prompt to get tag suggestions.</p>';
      if (refreshBtn) refreshBtn.style.display = "none";
      return;
    }

    if (_suggestionsLoading) return;
    _suggestionsLoading = true;
    container.innerHTML = '<p class="ti-empty" style="color:var(--accent-bright)">Loading suggestions...</p>';

    const data = await TagIntelligence.fetchSuggestions(promptText);
    _suggestionsLoading = false;

    if (!data) {
      container.innerHTML = '<p class="ti-empty">Could not load suggestions.</p>';
      if (refreshBtn) refreshBtn.style.display = "none";
      return;
    }

    container.innerHTML = "";

    // Boosters
    if (data.boosters && data.boosters.length) {
      const sub = buildSubGroup("Boosters", data.boosters.slice(0, 3));
      container.appendChild(sub);
    }

    // Contrasts
    if (data.contrasts && data.contrasts.length) {
      const sub = buildSubGroup("Contrasts", data.contrasts.slice(0, 2));
      container.appendChild(sub);
    }

    // Wildcards
    if (data.wildcards && data.wildcards.length) {
      const sub = buildSubGroup("Wildcards", data.wildcards.slice(0, 1));
      container.appendChild(sub);
    }

    if (refreshBtn) refreshBtn.style.display = "";
  }

  function buildSubGroup(label, items) {
    const wrap = document.createElement("div");

    const lbl = document.createElement("div");
    lbl.className = "ti-sub-label";
    lbl.textContent = label;
    wrap.appendChild(lbl);

    const chips = document.createElement("div");
    chips.className = "ti-sub-chips";
    for (const item of items) {
      const tag = typeof item === "string" ? item : (item.tag || item.name || item);
      const chip = document.createElement("button");
      chip.className = "tag-chip";
      chip.type = "button";
      chip.textContent = String(tag).replace(/_/g, " ");
      chip.addEventListener("click", () => insertTag(String(tag), chip));
      chips.appendChild(chip);
    }
    wrap.appendChild(chips);
    return wrap;
  }

  // Refresh button
  const refreshBtn = $("#ti-refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      renderSuggestions();
    });
  }
}
