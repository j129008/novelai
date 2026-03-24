function setupCraftPanel() {
  // ── Variation Dial ────────────────────────────────────────
  const dimsEl = $("#variation-dims");
  const runBtn = $("#btn-run-variations");
  const variationGrid = $("#variation-grid");
  const promptEl = $("#prompt");

  let selectedDimension = null;

  function updateRunBtn() {
    if (!runBtn) return;
    const hasPrompt = promptEl && promptEl.value.trim().length > 0;
    runBtn.disabled = !selectedDimension || !hasPrompt;
  }

  if (dimsEl) {
    for (const [key, dim] of Object.entries(VARIATION_DIMENSIONS)) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "variation-dim-pill";
      pill.dataset.dim = key;
      const labelEl = document.createElement("span");
      labelEl.className = "variation-dim-label";
      labelEl.textContent = dim.label;
      const hintEl = document.createElement("span");
      hintEl.className = "variation-dim-hint";
      hintEl.textContent = dim.hint;
      pill.appendChild(labelEl);
      pill.appendChild(hintEl);
      pill.addEventListener("click", () => {
        dimsEl.querySelectorAll(".variation-dim-pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        selectedDimension = key;
        updateRunBtn();
      });
      dimsEl.appendChild(pill);
    }
  }

  if (promptEl) {
    promptEl.addEventListener("input", updateRunBtn);
  }

  if (runBtn) {
    runBtn.addEventListener("click", runVariations);
  }

  async function runVariations() {
    if (!selectedDimension) return;
    const prompt = promptEl ? promptEl.value.trim() : "";
    if (!prompt) return;

    const dim = VARIATION_DIMENSIONS[selectedDimension];
    if (!variationGrid) return;

    variationGrid.style.display = "grid";
    variationGrid.innerHTML = "";

    // Disable run button during generation
    runBtn.disabled = true;
    runBtn.classList.add("loading");

    // Build the shared base request body from current settings
    const resVal = ($("#resolution") || {}).value || "832x1216";
    const [width, height] = resVal.split("x").map(Number);
    const qualityTags = ", very aesthetic, masterpiece, no text";
    const useQuality = $("#quality-tags") && $("#quality-tags").checked;

    function buildVariantPrompt(basePrompt, extraTags) {
      let p = basePrompt + ", " + extraTags;
      if (useQuality) {
        const pipeMatch = p.match(/^([\s\S]*?\S)([\s\n]*\|[\s\S]*)$/);
        if (pipeMatch) {
          p = pipeMatch[1] + qualityTags + pipeMatch[2];
        } else {
          p = p.replace(/\s+$/, "") + qualityTags;
        }
      }
      return p;
    }

    // Create placeholder cards
    const cards = dim.variants.map((variant, i) => {
      const card = document.createElement("div");
      card.className = "variation-card";

      const loadingEl = document.createElement("div");
      loadingEl.className = "variation-card-loading";
      loadingEl.textContent = variant.label;

      card.appendChild(loadingEl);
      variationGrid.appendChild(card);
      return { card, variant };
    });

    const currentProvider = document.getElementById("provider")?.value || "novelai";

    // Generate sequentially (one at a time) to avoid rate limits and save quota
    for (const { card, variant } of cards) {
      const variantPrompt = buildVariantPrompt(prompt, variant.tags);

      let fetchUrl, body;
      if (currentProvider === "grok") {
        fetchUrl = "/api/grok/generate-image";
        const vq = document.getElementById("grok-quality")?.value || "standard";
        body = {
          prompt: variantPrompt,
          aspect_ratio: document.getElementById("grok-aspect-ratio")?.value || "1:1",
          resolution: document.getElementById("grok-resolution")?.value || "1k",
          model: vq === "pro" ? "grok-imagine-image-pro" : "grok-imagine-image",
        };
      } else {
        fetchUrl = "/api/generate";
        body = {
          prompt: variantPrompt,
          negative_prompt: ($("#negative-prompt") || {}).value || "",
          width: width || 832,
          height: height || 1216,
          steps: parseInt(($("#steps") || {}).value || "23"),
          scale: parseFloat(($("#scale") || {}).value || "5"),
          sampler: ($("#sampler") || {}).value || "k_euler",
          seed: 0,
          sm: false,
          sm_dyn: false,
          strength: parseFloat(($("#strength") || {}).value || "0.7"),
          noise: parseFloat(($("#noise") || {}).value || "0"),
          cfg_rescale: parseFloat(($("#cfg-rescale") || {}).value || "0"),
          noise_schedule: ($("#noise-schedule") || {}).value || "karras",
          char_captions: collectCharacterPayload(),
          use_coords: characters.some((c) => !c.positionAuto),
        };
      }

      try {
        const resp = await fetch(fetchUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error("Generation failed");
        const data = await resp.json();

        // Build the result card
        card.innerHTML = "";
        card.className = "variation-card";

        const img = document.createElement("img");
        img.src = `data:image/png;base64,${data.image}`;
        img.alt = variant.label;

        const meta = document.createElement("div");
        meta.className = "variation-card-meta";

        const varLabel = document.createElement("span");
        varLabel.className = "variation-card-varlabel";
        varLabel.textContent = variant.label;

        const tagsHint = document.createElement("span");
        tagsHint.className = "variation-card-tags";
        tagsHint.textContent = variant.tags;

        meta.appendChild(varLabel);
        meta.appendChild(tagsHint);

        const overlay = document.createElement("div");
        overlay.className = "variation-card-overlay";

        const useBtn = document.createElement("button");
        useBtn.type = "button";
        useBtn.className = "btn-action btn-action--primary variation-overlay-btn";
        useBtn.textContent = "Use This";
        useBtn.addEventListener("click", () => {
          insertTagIntoPrompt(variant.tags);
          $("#tab-canvas").click();
        });

        const iterateBtn = document.createElement("button");
        iterateBtn.type = "button";
        iterateBtn.className = "btn-action btn-action--iterate variation-overlay-btn";
        iterateBtn.textContent = "Add to Layer";
        iterateBtn.addEventListener("click", () => {
          // Add variation result as a new layer
          if (layers.length < MAX_LAYERS) {
            const n = layers.length + 1;
            layers.push({ id: Date.now(), name: variant.label + " Variation", imageBase64: data.image, maskBase64: null, inpaintMaskBase64: null, opacity: 1.0, visible: true, isOutputTarget: false, offsetX: 0, offsetY: 0, scale: 1.0 });
            renderLayerList();
            saveLayersToStorage();
            refreshCompositePreview();
            const accordion = document.getElementById("layers-accordion");
            if (accordion && !accordion.open) accordion.open = true;
          }
          // Set strength to 0.55 for typical iteration workflow
          const strengthEl = $("#strength");
          if (strengthEl) {
            strengthEl.value = "0.55";
            strengthEl.dispatchEvent(new Event("input"));
          }
          insertTagIntoPrompt(variant.tags);
          $("#tab-canvas").click();
        });

        overlay.appendChild(useBtn);
        overlay.appendChild(iterateBtn);

        card.appendChild(img);
        card.appendChild(meta);
        card.appendChild(overlay);
      } catch (err) {
        card.innerHTML = "";
        const errEl = document.createElement("div");
        errEl.className = "variation-card-error";
        errEl.textContent = "Generation failed";
        card.appendChild(errEl);
      }
    } // end sequential for loop

    runBtn.disabled = false;
    runBtn.classList.remove("loading");
    updateRunBtn();
  }

  // ── Prompt Autopsy ────────────────────────────────────────
  const autopsyDrop = $("#autopsy-drop");
  const autopsyFileInput = $("#autopsy-file-input");
  const autopsyResults = $("#autopsy-results");
  const autopsyThumb = $("#autopsy-thumb");
  const autopsyStatus = $("#autopsy-status");
  const autopsyProgressWrap = $("#autopsy-progress-wrap");
  const autopsyProgressFill = $("#autopsy-progress-fill");
  const autopsyTagsEl = $("#autopsy-tags");
  const insertAllBtn = $("#btn-autopsy-insert-all");

  // Track which tags are currently inserted
  const autopsyInserted = new Set();
  let autopsyGeneration = 0; // Cancel stale polling loops

  function handleAutopsyFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    autopsyGeneration++;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      if (autopsyThumb) autopsyThumb.src = dataUrl;
      if (autopsyResults) autopsyResults.style.display = "block";
      if (autopsyTagsEl) autopsyTagsEl.innerHTML = "";
      if (insertAllBtn) insertAllBtn.style.display = "none";
      if (autopsyStatus) autopsyStatus.textContent = "Analyzing…";
      if (autopsyProgressWrap) autopsyProgressWrap.style.display = "none";
      autopsyInserted.clear();

      // Strip data:image/...;base64, prefix to get raw base64
      const base64 = dataUrl.split(",")[1];
      runAutopsyAnalysis(base64, autopsyGeneration);
    };
    reader.readAsDataURL(file);
  }

  async function runAutopsyAnalysis(base64, generation) {
    try {
      const resp = await fetch("/api/analyze-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: base64 }),
      });
      if (!resp.ok) throw new Error("Analysis failed");
      const data = await resp.json();

      if (data.status === "downloading") {
        if (autopsyStatus) autopsyStatus.textContent = "First use — downloading analysis model (~350MB)…";
        if (autopsyProgressWrap) autopsyProgressWrap.style.display = "block";
        if (autopsyProgressFill) autopsyProgressFill.style.width = (data.progress || 0) + "%";
        // Poll until complete (bail if a newer file was dropped)
        if (generation !== autopsyGeneration) return;
        setTimeout(() => runAutopsyAnalysis(base64, generation), 2000);
        return;
      }

      if (autopsyProgressWrap) autopsyProgressWrap.style.display = "none";

      if (data.status === "complete" && data.tags) {
        if (autopsyStatus) autopsyStatus.textContent = "Analysis complete";
        renderAutopsyTags(data.tags);
      } else {
        if (autopsyStatus) autopsyStatus.textContent = "Analysis failed";
      }
    } catch (err) {
      if (autopsyStatus) autopsyStatus.textContent = "Analysis failed: " + err.message;
    }
  }

  function renderAutopsyTags(flatTags) {
    if (!autopsyTagsEl) return;
    autopsyTagsEl.innerHTML = "";
    const highConfidenceTags = [];

    // Group flat array by category
    const grouped = {};
    for (const t of flatTags) {
      const cat = t.category || "subject";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(t);
    }

    const categoryLabels = { subject: "Subject", scene: "Scene", style: "Style", lighting: "Lighting", character: "Character" };

    for (const [category, tags] of Object.entries(grouped)) {
      if (!tags || tags.length === 0) continue;

      const groupEl = document.createElement("div");
      groupEl.className = "craft-tag-group";

      const header = document.createElement("div");
      header.className = "craft-tag-group-header";
      header.textContent = categoryLabels[category] || category;
      groupEl.appendChild(header);

      const pillsEl = document.createElement("div");
      pillsEl.className = "craft-tag-pills-row";

      for (const { name: tag, score } of tags) {
        if (score < 0.35) continue;

        const displayTag = tag.replace(/_/g, " ");
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "craft-tag-pill";
        if (score >= 0.7) {
          pill.classList.add("high-confidence");
          highConfidenceTags.push(tag);
        } else if (score < 0.5) {
          pill.classList.add("low-confidence");
        }
        pill.dataset.tag = tag;

        const nameSpan = document.createElement("span");
        nameSpan.textContent = displayTag;

        const scoreSpan = document.createElement("span");
        scoreSpan.className = "pill-score";
        scoreSpan.textContent = Math.round(score * 100) + "%";

        pill.appendChild(nameSpan);
        pill.appendChild(scoreSpan);

        pill.addEventListener("click", () => {
          if (autopsyInserted.has(tag)) {
            removeTagFromPrompt(tag);
            autopsyInserted.delete(tag);
            pill.classList.remove("selected");
          } else {
            insertTagIntoPrompt(tag);
            autopsyInserted.add(tag);
            pill.classList.add("selected");
          }
        });

        pillsEl.appendChild(pill);
      }

      groupEl.appendChild(pillsEl);
      autopsyTagsEl.appendChild(groupEl);
    }

    // Show "Insert All High-Confidence" button if there are high-confidence tags
    if (insertAllBtn && highConfidenceTags.length > 0) {
      insertAllBtn.style.display = "flex";
      insertAllBtn.onclick = () => {
        for (const tag of highConfidenceTags) {
          if (!autopsyInserted.has(tag)) {
            insertTagIntoPrompt(tag);
            autopsyInserted.add(tag);
          }
        }
        // Update pill selected states
        if (autopsyTagsEl) {
          autopsyTagsEl.querySelectorAll(".craft-tag-pill[data-tag]").forEach((pill) => {
            if (autopsyInserted.has(pill.dataset.tag)) {
              pill.classList.add("selected");
            }
          });
        }
      };
    }
  }

  if (autopsyDrop) {
    autopsyDrop.addEventListener("click", () => autopsyFileInput && autopsyFileInput.click());
    autopsyDrop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        autopsyFileInput && autopsyFileInput.click();
      }
    });
    autopsyDrop.addEventListener("dragover", (e) => {
      e.preventDefault();
      autopsyDrop.classList.add("drag-over");
    });
    autopsyDrop.addEventListener("dragleave", () => autopsyDrop.classList.remove("drag-over"));
    autopsyDrop.addEventListener("drop", (e) => {
      e.preventDefault();
      autopsyDrop.classList.remove("drag-over");
      const file = e.dataTransfer.files[0];
      if (file) handleAutopsyFile(file);
    });
  }

  if (autopsyFileInput) {
    autopsyFileInput.addEventListener("change", () => {
      if (autopsyFileInput.files[0]) handleAutopsyFile(autopsyFileInput.files[0]);
    });
  }

  // ── Prompt DNA ────────────────────────────────────────────
  const analyzeBtn = $("#btn-analyze-prompt");
  const dnaResults = $("#dna-results");
  const refreshBtn = $("#btn-dna-refresh");

  // Track which DNA tags are inserted
  const dnaInserted = new Set();

  function updateAnalyzeBtn() {
    if (!analyzeBtn) return;
    analyzeBtn.disabled = !promptEl || promptEl.value.trim().length === 0;
  }

  if (promptEl) {
    promptEl.addEventListener("input", updateAnalyzeBtn);
  }
  updateAnalyzeBtn();

  async function runDNAAnalysis() {
    if (!promptEl) return;
    const prompt = promptEl.value.trim();
    if (!prompt) return;

    const tags = prompt.split(/[,|]/).map((t) => t.trim().replace(/ /g, "_")).filter(Boolean);

    if (analyzeBtn) {
      analyzeBtn.disabled = true;
      analyzeBtn.textContent = "Analyzing…";
    }
    if (dnaResults) dnaResults.style.display = "none";
    if (refreshBtn) refreshBtn.style.display = "none";
    dnaInserted.clear();

    try {
      const resp = await fetch("/api/suggest-tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      if (!resp.ok) throw new Error("Analysis failed");
      const data = await resp.json();
      renderDNAResults(data);
      if (refreshBtn) refreshBtn.style.display = "flex";
    } catch (err) {
      if (dnaResults) {
        dnaResults.style.display = "block";
        dnaResults.innerHTML = "";
        const errEl = document.createElement("p");
        errEl.className = "craft-dna-error";
        errEl.textContent = "Analysis failed: " + err.message;
        dnaResults.appendChild(errEl);
      }
    } finally {
      if (analyzeBtn) {
        analyzeBtn.disabled = false;
        analyzeBtn.textContent = "Analyze Prompt";
      }
    }
  }

  const DNA_GROUPS = [
    { key: "boosters",  label: "Boosters",  desc: "Tags commonly paired with your prompt" },
    { key: "contrasts", label: "Contrasts", desc: "Try a different direction" },
    { key: "wildcards", label: "Wildcards", desc: "Unexpected inspiration" },
  ];

  function formatCount(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
    return String(n);
  }

  function renderDNAResults(data) {
    if (!dnaResults) return;
    dnaResults.innerHTML = "";
    dnaResults.style.display = "block";

    for (const group of DNA_GROUPS) {
      const tags = data[group.key];
      if (!tags || tags.length === 0) continue;

      const groupEl = document.createElement("div");
      groupEl.className = "craft-tag-group";

      const header = document.createElement("div");
      header.className = "craft-tag-group-header";
      header.textContent = group.label;

      const desc = document.createElement("div");
      desc.className = "craft-tag-group-desc";
      desc.textContent = group.desc;

      const pillsEl = document.createElement("div");
      pillsEl.className = "craft-tag-pills-row";

      for (const item of tags) {
        const tag = typeof item === "string" ? item : item.name;
        const count = typeof item === "object" ? item.count : null;
        const displayTag = tag.replace(/_/g, " ");

        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "craft-tag-pill";
        pill.dataset.tag = tag;

        const nameSpan = document.createElement("span");
        nameSpan.textContent = displayTag;
        pill.appendChild(nameSpan);

        if (count != null) {
          const countSpan = document.createElement("span");
          countSpan.className = "pill-score";
          countSpan.textContent = formatCount(count);
          pill.appendChild(countSpan);
        }

        pill.addEventListener("click", () => {
          if (dnaInserted.has(tag)) {
            removeTagFromPrompt(tag);
            dnaInserted.delete(tag);
            pill.classList.remove("selected");
          } else {
            insertTagIntoPrompt(tag);
            dnaInserted.add(tag);
            pill.classList.add("selected");
          }
        });

        pillsEl.appendChild(pill);
      }

      groupEl.appendChild(header);
      groupEl.appendChild(desc);
      groupEl.appendChild(pillsEl);
      dnaResults.appendChild(groupEl);
    }
  }

  if (analyzeBtn) analyzeBtn.addEventListener("click", runDNAAnalysis);
  if (refreshBtn) refreshBtn.addEventListener("click", runDNAAnalysis);
}
