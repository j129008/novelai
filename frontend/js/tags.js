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
  const rail = $("#tag-browser-rail");
  const grid = $("#tag-browser-grid");
  const searchInput = $("#tag-browser-search");
  const canvas = drawer.closest(".canvas");

  let activeCategory = "all";

  function isOpen() { return drawer.style.display !== "none" && !drawer.classList.contains("tag-browser--closing"); }

  function open() {
    drawer.classList.remove("tag-browser--closing");
    drawer.style.display = "flex";
    canvas.classList.add("tag-browser-open");
    btn.classList.add("btn-action--primary");
    btn.setAttribute("aria-expanded", "true");
    const fetchCategories = !_tagCategories.length ? loadTagCategories() : Promise.resolve();
    fetchCategories.then(() => {
      buildRail();
      renderGrid();
    });
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

  // Close on outside click
  canvas.addEventListener("pointerdown", (e) => {
    if (!isOpen()) return;
    if (drawer.contains(e.target) || btn.contains(e.target)) return;
    close();
  });

  function buildRail() {
    rail.innerHTML = "";
    const allBtn = document.createElement("button");
    allBtn.className = "tag-browser-rail-btn active";
    allBtn.textContent = "All";
    allBtn.addEventListener("click", () => selectCategory("all"));
    rail.appendChild(allBtn);

    for (const cat of _tagCategories) {
      const b = document.createElement("button");
      b.className = "tag-browser-rail-btn";
      b.textContent = cat.label;
      b.dataset.id = cat.id;
      b.addEventListener("click", () => selectCategory(cat.id));
      rail.appendChild(b);
    }
  }

  function selectCategory(id) {
    activeCategory = id;
    rail.querySelectorAll(".tag-browser-rail-btn").forEach((b) => {
      b.classList.toggle("active", (b.dataset.id || "all") === id);
    });
    // First pill has no dataset.id, it's "all"
    if (id === "all") rail.firstChild.classList.add("active");
    renderGrid();
  }

  let _searchDebounce = null;
  let _renderGen = 0;

  function renderGrid() {
    ++_renderGen;
    const filter = searchInput.value.trim().toLowerCase().replace(/ /g, "_");
    grid.innerHTML = "";

    const cats = activeCategory === "all"
      ? _tagCategories
      : _tagCategories.filter((c) => c.id === activeCategory);

    let anyTags = false;
    for (const cat of cats) {
      const tags = filter
        ? cat.tags.filter((t) => t.includes(filter))
        : cat.tags;
      if (!tags.length) continue;
      anyTags = true;

      if (activeCategory === "all") {
        const label = document.createElement("div");
        label.className = "tag-browser-section-label";
        label.textContent = cat.label;
        grid.appendChild(label);
      }

      const wrap = document.createElement("div");
      wrap.className = "tag-browser-chips";
      for (const tag of tags) {
        const chip = document.createElement("button");
        chip.className = "tag-chip";
        chip.textContent = tag.replace(/_/g, " ");
        chip.addEventListener("click", () => insertBrowserTag(tag, chip));
        wrap.appendChild(chip);
      }
      grid.appendChild(wrap);
    }

    // When filtering, also search the full 140K tag database
    if (filter && filter.length >= 2) {
      clearTimeout(_searchDebounce);
      const gen = _renderGen;
      _searchDebounce = setTimeout(() => fetchFullSearch(filter, anyTags, gen), 200);
    } else if (!anyTags) {
      const empty = document.createElement("p");
      empty.className = "tag-browser-empty";
      empty.textContent = "No tags found";
      grid.appendChild(empty);
    }
  }

  async function fetchFullSearch(query, hadCuratedResults, gen) {
    try {
      const resp = await fetch(`/api/tags?q=${encodeURIComponent(query)}&limit=30`);
      if (!resp.ok || gen !== _renderGen) return;
      const results = await resp.json();

      // Dedupe against curated tags already shown
      const curatedSet = new Set();
      for (const cat of _tagCategories) for (const t of cat.tags) curatedSet.add(t);
      const extra = results.filter((r) => !curatedSet.has(r.name));
      if (!extra.length && !hadCuratedResults) {
        grid.innerHTML = `<p class="tag-browser-empty">No tags found</p>`;
        return;
      }
      if (!extra.length) return;

      const label = document.createElement("div");
      label.className = "tag-browser-section-label";
      label.textContent = "More Results";
      grid.appendChild(label);

      const wrap = document.createElement("div");
      wrap.className = "tag-browser-chips";
      for (const r of extra) {
        const chip = document.createElement("button");
        chip.className = "tag-chip";
        chip.textContent = r.name.replace(/_/g, " ");
        chip.addEventListener("click", () => insertBrowserTag(r.name, chip));
        wrap.appendChild(chip);
      }
      grid.appendChild(wrap);
    } catch { /* silent */ }
  }

  // ── Insertion target lock (Spec 1A/1B) ─────────────────────
  // Default: whichever prompt tab is active
  let _insertTarget = "prompt"; // "prompt" or "negative"
  let _savedCursor = { el: null, pos: -1 };

  const pillPrompt   = $("#tag-insert-prompt");
  const pillNegative = $("#tag-insert-negative");

  function setInsertTarget(target) {
    _insertTarget = target;
    pillPrompt.classList.toggle("active", target === "prompt");
    pillNegative.classList.toggle("active", target === "negative");
    // Sync saved cursor element
    _savedCursor = {
      el: target === "prompt" ? $("#prompt") : $("#negative-prompt"),
      pos: _savedCursor.pos,
    };
  }

  if (pillPrompt) pillPrompt.addEventListener("click", () => setInsertTarget("prompt"));
  if (pillNegative) pillNegative.addEventListener("click", () => setInsertTarget("negative"));

  // When prompt tabs are switched, sync the insert target pill
  document.querySelectorAll(".prompt-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.dataset.target === "prompt") setInsertTarget("prompt");
      else setInsertTarget("negative");
    });
  });

  // Save cursor position on blur for accurate insertion
  $("#prompt").addEventListener("blur", function() {
    _savedCursor = { el: this, pos: this.selectionStart };
    // Update pill if this was the active textarea
  });
  $("#negative-prompt").addEventListener("blur", function() {
    _savedCursor = { el: this, pos: this.selectionStart };
  });

  function insertBrowserTag(tag, chipEl) {
    // Use locked target, not visibility-based detection
    const promptEl = _insertTarget === "negative" ? $("#negative-prompt") : $("#prompt");
    const display = tag.replace(/_/g, " ");
    const val = promptEl.value;

    // Use saved cursor if it belongs to this textarea, otherwise append
    const pos = (_savedCursor.el === promptEl && _savedCursor.pos >= 0)
      ? _savedCursor.pos
      : val.length;
    const atEnd = pos === val.length;

    let insertedLen;
    if (atEnd) {
      const prefix = val.length > 0 && !val.trimEnd().endsWith(",") ? ", " : val.length > 0 ? " " : "";
      const insert = prefix + display;
      promptEl.value = val + insert;
      insertedLen = val.length + insert.length;
    } else {
      const before = val.slice(0, pos);
      const after = val.slice(pos);
      const prefix = before.length > 0 && !before.trimEnd().endsWith(",") ? ", " : before.length > 0 ? " " : "";
      const suffix = after.length > 0 && !after.trimStart().startsWith(",") ? ", " : "";
      const insert = prefix + display + suffix;
      promptEl.value = before + insert + after;
      insertedLen = before.length + insert.length;
    }

    // Move cursor to just after insertion and save it
    _savedCursor = { el: promptEl, pos: insertedLen };

    promptEl.dispatchEvent(new Event("input"));

    // Visual feedback — chip flash
    chipEl.classList.add("tag-chip--inserted");
    setTimeout(() => chipEl.classList.remove("tag-chip--inserted"), 300);

    // Prompt box border flash
    const box = promptEl.closest(".prompt-box");
    if (box) {
      box.style.borderColor = "var(--accent)";
      box.style.boxShadow = "0 0 0 3px var(--accent-dim)";
      setTimeout(() => { box.style.borderColor = ""; box.style.boxShadow = ""; }, 300);
    }
  }

  // ── Surprise Me button ──────────────────────────────────
  const surpriseBtn = $("#btn-surprise-me");
  if (surpriseBtn) {
    surpriseBtn.addEventListener("click", () => {
      const cats = activeCategory === "all"
        ? _tagCategories
        : _tagCategories.filter((c) => c.id === activeCategory);

      // Flatten all tags from relevant categories
      const allTags = [];
      for (const cat of cats) {
        for (const tag of cat.tags) allTags.push(tag);
      }
      if (!allTags.length) return;

      const pick = allTags[Math.floor(Math.random() * allTags.length)];

      // Find chip in grid if visible, otherwise insert without visual feedback
      const chips = grid.querySelectorAll(".tag-chip");
      let targetChip = null;
      for (const c of chips) {
        if (c.textContent.trim().replace(/ /g, "_") === pick || c.textContent.trim() === pick.replace(/_/g, " ")) {
          targetChip = c;
          break;
        }
      }

      if (targetChip) {
        targetChip.scrollIntoView({ block: "nearest", behavior: "smooth" });
        insertBrowserTag(pick, targetChip);
      } else {
        // Insert directly without chip visual feedback
        const promptEl = _insertTarget === "negative" ? $("#negative-prompt") : $("#prompt");
        const display = pick.replace(/_/g, " ");
        const val = promptEl.value;
        const prefix = val.length > 0 && !val.trimEnd().endsWith(",") ? ", " : val.length > 0 ? " " : "";
        promptEl.value = val + prefix + display;
        promptEl.dispatchEvent(new Event("input"));

        // Flash the button as feedback
        surpriseBtn.classList.add("btn-action--confirm");
        setTimeout(() => surpriseBtn.classList.remove("btn-action--confirm"), 300);
      }
    });
  }

  searchInput.addEventListener("input", renderGrid);
}
