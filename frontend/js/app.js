"use strict";

const $ = (sel) => document.querySelector(sel);

const SAMPLER_LABELS = {
  "k_euler":              "Fast",
  "k_euler_ancestral":    "Creative",
  "k_dpmpp_2s_ancestral": "Balanced",
  "k_dpmpp_2m":           "High Quality",
  "k_dpmpp_2m_sde":       "High Quality (Smooth)",
  "k_dpmpp_sde":          "Smooth",
};

const UC_PRESETS = {
  "heavy": "nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
  "light": "nsfw, lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page",
  "human-focus": "nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy",
  "furry-focus": "nsfw, {worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic",
  "none": "",
};

const state = {
  img2img: null,
  vibe: null,
  lastSeed: null,
  lastImageBase64: null,
};

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
  } catch (e) {
    showError(`Failed to load options: ${e.message}`);
  }

  bindSlider("steps", "steps-val", 0);
  bindSlider("scale", "scale-val", 1);
  bindSlider("strength", "strength-val", 2);
  bindSlider("noise", "noise-val", 2);
  bindSlider("ref-strength", "ref-strength-val", 2);
  bindSlider("ref-info", "ref-info-val", 2);

  setupFileUpload("img2img-upload", "img2img-preview", "img2img-placeholder", "img2img-clear", "img2img");
  setupFileUpload("vibe-upload", "vibe-preview", "vibe-placeholder", "vibe-clear", "vibe");

  setupPromptTabs();
  setupHdEnhancement();
  setupTagAutocomplete();
  setupAutoSavePrompt();
  setupHistoryTabs();
  loadGallery();

  $("#generate-btn").addEventListener("click", generate);
  $("#btn-reuse-seed").addEventListener("click", reuseSeed);
  $("#btn-download").addEventListener("click", downloadImage);

  setupGuide();
  setupSettings();

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      generate();
    }
  });
}

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
    }
  });
}

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

/* ── AUTO-SAVE PROMPT ─────────────────────────────────────── */

function setupAutoSavePrompt() {
  const prompt = $("#prompt");
  const negative = $("#negative-prompt");

  // Restore saved values
  const savedPrompt = localStorage.getItem("nai-prompt");
  const savedNegative = localStorage.getItem("nai-negative");
  if (savedPrompt !== null) prompt.value = savedPrompt;
  if (savedNegative !== null) negative.value = savedNegative;

  // Save on input
  prompt.addEventListener("input", () => {
    localStorage.setItem("nai-prompt", prompt.value);
  });
  negative.addEventListener("input", () => {
    localStorage.setItem("nai-negative", negative.value);
  });
}

/* ── TAG AUTOCOMPLETE ────────────────────────────────────── */

function setupTagAutocomplete() {
  const prompt = $("#prompt");
  const negative = $("#negative-prompt");
  const dropdown = $("#tag-dropdown");
  if (!prompt || !dropdown) return;

  let selectedIdx = -1;
  let debounceTimer = null;
  let activeTextarea = prompt;

  // Track which textarea is active
  prompt.addEventListener("focus", () => { activeTextarea = prompt; });
  negative.addEventListener("focus", () => { activeTextarea = negative; });

  function getWordAtCursor(textarea) {
    const val = textarea.value;
    const cursor = textarea.selectionStart;
    // Find start of current tag (after last comma or start)
    let start = val.lastIndexOf(",", cursor - 1) + 1;
    while (start < cursor && val[start] === " ") start++;
    const word = val.slice(start, cursor).trim();
    return { word, start, end: cursor };
  }

  async function fetchTags(query) {
    if (query.length < 2) { hideDropdown(); return; }
    try {
      const resp = await fetch(`/api/tags?q=${encodeURIComponent(query)}`);
      if (!resp.ok) return;
      const tags = await resp.json();
      showDropdown(tags, query);
    } catch { /* ignore */ }
  }

  function showDropdown(tags, query) {
    if (!tags.length) { hideDropdown(); return; }
    selectedIdx = -1;
    const q = query.toLowerCase();
    dropdown.innerHTML = "";
    tags.forEach((tag, i) => {
      const item = document.createElement("div");
      item.className = "tag-item";
      item.dataset.index = i;

      const nameSpan = document.createElement("span");
      nameSpan.className = "tag-item-name";
      const name = tag.name.replace(/_/g, " ");
      const idx = name.toLowerCase().indexOf(q.replace(/_/g, " "));
      if (idx >= 0) {
        nameSpan.innerHTML = escapeHtml(name.slice(0, idx))
          + "<mark>" + escapeHtml(name.slice(idx, idx + q.length)) + "</mark>"
          + escapeHtml(name.slice(idx + q.length));
      } else {
        nameSpan.textContent = name;
      }

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
        insertTag(tag.name);
      });

      dropdown.appendChild(item);
    });
    dropdown.classList.add("visible");
  }

  function hideDropdown() {
    dropdown.classList.remove("visible");
    selectedIdx = -1;
  }

  function insertTag(tagName) {
    const textarea = activeTextarea;
    const { start, end } = getWordAtCursor(textarea);
    const val = textarea.value;
    const before = val.slice(0, start);
    const after = val.slice(end);
    const tag = tagName.replace(/_/g, " ");
    const needsComma = before.length > 0 && !before.trimEnd().endsWith(",");
    const insert = (needsComma ? ", " : "") + tag + ", ";
    textarea.value = before + insert + after;
    const newPos = before.length + insert.length;
    textarea.selectionStart = textarea.selectionEnd = newPos;
    textarea.focus();
    hideDropdown();
  }

  function formatCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(0) + "k";
    return String(n);
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function handleInput(e) {
    clearTimeout(debounceTimer);
    const { word } = getWordAtCursor(e.target);
    debounceTimer = setTimeout(() => fetchTags(word), 150);
  }

  function handleKeydown(e) {
    if (!dropdown.classList.contains("visible")) return;
    const items = dropdown.querySelectorAll(".tag-item");
    if (!items.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
      updateSelection(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      updateSelection(items);
    } else if (e.key === "Tab" || e.key === "Enter") {
      if (selectedIdx >= 0) {
        e.preventDefault();
        const name = items[selectedIdx].querySelector(".tag-item-name").textContent;
        insertTag(name.replace(/ /g, "_"));
      }
    } else if (e.key === "Escape") {
      hideDropdown();
    }
  }

  function updateSelection(items) {
    items.forEach((el, i) => el.classList.toggle("selected", i === selectedIdx));
    if (selectedIdx >= 0) items[selectedIdx].scrollIntoView({ block: "nearest" });
  }

  prompt.addEventListener("input", handleInput);
  negative.addEventListener("input", handleInput);
  prompt.addEventListener("keydown", handleKeydown);
  negative.addEventListener("keydown", handleKeydown);
  prompt.addEventListener("blur", () => setTimeout(hideDropdown, 150));
  negative.addEventListener("blur", () => setTimeout(hideDropdown, 150));
}

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

async function generate() {
  const btn = $("#generate-btn");
  if (btn.disabled) return;

  const prompt = $("#prompt").value.trim();
  if (!prompt) {
    showError("Please enter a prompt.");
    return;
  }

  const resVal = $("#resolution").value;
  const [width, height] = resVal ? resVal.split("x").map(Number) : [832, 1216];

  const qualityTags = "location, very aesthetic, masterpiece, no text";
  const finalPrompt = $("#quality-tags").checked ? `${qualityTags}, ${prompt}` : prompt;

  const body = {
    prompt: finalPrompt,
    negative_prompt: $("#negative-prompt").value,
    width: width || 832,
    height: height || 1216,
    steps: parseInt($("#steps").value),
    scale: parseFloat($("#scale").value),
    sampler: $("#sampler").value,
    seed: parseInt($("#seed").value) || 0,
    sm: $("#smea").checked,
    sm_dyn: $("#smea-dyn").checked,
    strength: parseFloat($("#strength").value),
    noise: parseFloat($("#noise").value),
  };

  if (state.img2img) {
    body.image = state.img2img;
  }

  if (state.vibe) {
    body.reference_image = state.vibe;
    body.reference_information_extracted = parseFloat($("#ref-info").value);
    body.reference_strength = parseFloat($("#ref-strength").value);
  }

  btn.disabled = true;
  btn.classList.add("loading");
  clearError();

  try {
    const resp = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || "Generation failed");
    }

    const data = await resp.json();
    state.lastSeed = data.seed;
    state.lastImageBase64 = data.image;

    const output = $("#output");
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${data.image}`;
    img.alt = "Generated image";
    output.innerHTML = "";
    output.appendChild(img);

    const actions = $("#image-actions");
    actions.style.display = "flex";
    $("#info-seed").textContent = `Seed: ${data.seed}`;

    loadGallery();
  } catch (e) {
    console.error("Generate error:", e);
    showError(e.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

function reuseSeed() {
  if (state.lastSeed !== null) {
    $("#seed").value = state.lastSeed;
  }
}

function downloadImage() {
  if (!state.lastImageBase64) return;
  const a = document.createElement("a");
  a.href = `data:image/png;base64,${state.lastImageBase64}`;
  a.download = `novelai-${state.lastSeed || "image"}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/* ── GALLERY ──────────────────────────────────────────────── */

let _galleryData = [];
let _settingsLoadedToast = null;

function setupHistoryTabs() {
  const tabCanvas = $("#tab-canvas");
  const tabHistory = $("#tab-history");
  const panelCanvas = $("#panel-canvas");
  const panelHistory = $("#panel-history");
  const searchWrap = $("#history-search-wrap");
  const searchInput = $("#gallery-search");

  _settingsLoadedToast = document.createElement("div");
  _settingsLoadedToast.className = "settings-loaded-toast";
  _settingsLoadedToast.textContent = "Settings loaded — ready to iterate";
  document.body.appendChild(_settingsLoadedToast);

  function showCanvas() {
    tabCanvas.classList.add("canvas-tab--active");
    tabHistory.classList.remove("canvas-tab--active");
    panelCanvas.style.display = "flex";
    panelHistory.style.display = "none";
    searchWrap.style.display = "none";
  }

  function showHistory() {
    tabHistory.classList.add("canvas-tab--active");
    tabCanvas.classList.remove("canvas-tab--active");
    panelHistory.style.display = "flex";
    panelCanvas.style.display = "none";
    searchWrap.style.display = "flex";
    searchInput.focus();
  }

  tabCanvas.addEventListener("click", showCanvas);
  tabHistory.addEventListener("click", showHistory);

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      renderGallery(_galleryData, searchInput.value.toLowerCase());
    });
  }
}

function showSettingsLoadedToast() {
  if (!_settingsLoadedToast) return;
  _settingsLoadedToast.classList.add("visible");
  setTimeout(() => _settingsLoadedToast.classList.remove("visible"), 2400);
}

async function loadGallery() {
  const list = $("#gallery-list");
  const empty = $("#gallery-empty");
  const count = $("#gallery-count");
  if (!list) return;

  try {
    const resp = await fetch("/api/gallery");
    if (!resp.ok) return;
    const files = await resp.json();

    _galleryData = files;
    if (count) {
      count.textContent = files.length || "";
      count.classList.toggle("visible", files.length > 0);
    }
    const searchVal = ($("#gallery-search")?.value || "").toLowerCase();
    renderGallery(files, searchVal);
  } catch { /* ignore */ }
}

function renderGallery(files, filter) {
  const list = $("#gallery-list");
  const empty = $("#gallery-empty");
  if (!list) return;

  const filtered = filter
    ? files.filter((f) => {
        const meta = f.meta || {};
        return (meta.prompt || "").toLowerCase().includes(filter)
          || (meta.uc || "").toLowerCase().includes(filter)
          || String(meta.seed || "").includes(filter)
          || f.name.toLowerCase().includes(filter);
      })
    : files;

  if (!filtered.length) {
    list.style.display = "none";
    empty.style.display = "block";
    empty.textContent = filter ? "No matching images" : "No saved images yet";
    return;
  }

  list.style.display = "grid";
  empty.style.display = "none";
  list.innerHTML = "";

  for (const file of filtered) {
    const meta = file.meta || {};
    const card = document.createElement("div");
    card.className = "history-card";

    const img = document.createElement("img");
    img.className = "history-card-img";
    img.src = `/api/gallery/${file.name}`;
    img.alt = file.name;
    img.loading = "lazy";

    const overlay = document.createElement("div");
    overlay.className = "history-card-overlay";

    if (meta.prompt) {
      const promptEl = document.createElement("div");
      promptEl.className = "history-card-prompt";
      promptEl.textContent = meta.prompt;
      overlay.appendChild(promptEl);
    }

    const metaEl = document.createElement("div");
    metaEl.className = "history-card-meta";
    if (meta.seed) metaEl.innerHTML += `<span>Seed ${meta.seed}</span>`;
    if (meta.steps) metaEl.innerHTML += `<span>${meta.steps} steps</span>`;
    if (meta.width) metaEl.innerHTML += `<span>${meta.width}\u00d7${meta.height}</span>`;
    overlay.appendChild(metaEl);

    const actionsEl = document.createElement("div");
    actionsEl.className = "history-card-actions";

    const loadBtn = document.createElement("button");
    loadBtn.className = "history-card-btn history-card-btn--load";
    loadBtn.type = "button";
    loadBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.84"/></svg> Load`;
    loadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      loadSettingsFromMeta(meta);
      card.classList.add("settings-loaded");
      setTimeout(() => card.classList.remove("settings-loaded"), 1800);
      showSettingsLoadedToast();
      $("#tab-canvas").click();
    });

    const delBtn = document.createElement("button");
    delBtn.className = "history-card-btn history-card-btn--delete";
    delBtn.type = "button";
    delBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg> Delete`;
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      card.style.opacity = "0.4";
      card.style.pointerEvents = "none";
      const r = await fetch(`/api/gallery/${file.name}`, { method: "DELETE" });
      if (r.ok) loadGallery();
      else { card.style.opacity = ""; card.style.pointerEvents = ""; }
    });

    actionsEl.appendChild(loadBtn);
    actionsEl.appendChild(delBtn);
    overlay.appendChild(actionsEl);

    card.addEventListener("click", () => {
      const output = $("#output");
      const previewImg = document.createElement("img");
      previewImg.src = `/api/gallery/${file.name}`;
      previewImg.alt = "Preview";
      output.innerHTML = "";
      output.appendChild(previewImg);
      $("#tab-canvas").click();
    });

    card.appendChild(img);
    card.appendChild(overlay);
    list.appendChild(card);
  }
}

function loadSettingsFromMeta(meta) {
  if (!meta || !meta.prompt) return;

  // Remove quality tags (prepended or appended) if present
  const qualitySuffix = ", location, very aesthetic, masterpiece, no text";
  const qualityPrefix = "location, very aesthetic, masterpiece, no text, ";
  let prompt = meta.prompt;
  if (prompt.startsWith(qualityPrefix)) {
    prompt = prompt.slice(qualityPrefix.length);
  } else if (prompt.endsWith(qualitySuffix)) {
    prompt = prompt.slice(0, -qualitySuffix.length);
  }

  $("#prompt").value = prompt;
  localStorage.setItem("nai-prompt", prompt);

  if (meta.uc) {
    $("#negative-prompt").value = meta.uc;
    localStorage.setItem("nai-negative", meta.uc);
  }

  if (meta.seed) $("#seed").value = meta.seed;
  if (meta.steps) {
    $("#steps").value = meta.steps;
    $("#steps-val").textContent = meta.steps;
  }
  if (meta.scale !== undefined) {
    $("#scale").value = meta.scale;
    $("#scale-val").textContent = parseFloat(meta.scale).toFixed(1);
  }
  if (meta.sampler) {
    const sampler = $("#sampler");
    for (const opt of sampler.options) {
      if (opt.value === meta.sampler) { sampler.value = meta.sampler; break; }
    }
  }
  if (meta.width && meta.height) {
    const res = `${meta.width}x${meta.height}`;
    const resolution = $("#resolution");
    for (const opt of resolution.options) {
      if (opt.value === res) { resolution.value = res; break; }
    }
  }
  if (meta.sm !== undefined) {
    const hd = $("#hd-enhancement");
    const smea = $("#smea");
    const smeaDyn = $("#smea-dyn");
    hd.checked = meta.sm || meta.sm_dyn;
    smea.checked = !!meta.sm;
    smeaDyn.checked = !!meta.sm_dyn;
  }
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

init();
