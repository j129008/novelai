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

  $("#generate-btn").addEventListener("click", generate);
  $("#btn-reuse-seed").addEventListener("click", reuseSeed);
  $("#btn-download").addEventListener("click", downloadImage);

  setupGuide();

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      generate();
    }
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
    if (e.key === "Escape" && overlay.style.display !== "none") {
      overlay.style.display = "none";
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
