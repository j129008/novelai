/* ═══════════════════════════════════════════════════════════
   GENERATE
   ═══════════════════════════════════════════════════════════ */

function setGenerateButtonStop() {
  const btn = $("#generate-btn");
  btn.classList.remove("loading");
  btn.classList.add("stopping");
  btn.disabled = false;
  btn.querySelector(".btn-generate-label").textContent = "Stop";
  btn.querySelector(".btn-generate-hint").textContent = "";
}

function resetGenerateButton() {
  const btn = $("#generate-btn");
  btn.classList.remove("loading", "stopping");
  btn.disabled = false;
  const provider = document.getElementById("provider")?.value || "novelai";
  const isVideo = provider === "grok" && state.grokOutputType === "video";
  btn.querySelector(".btn-generate-label").textContent = isVideo ? "Generate Video" : "Generate";
  btn.querySelector(".btn-generate-hint").textContent = "Enter";
  _generateAbortController = null;
}

async function generate() {
  // Route to provider-specific handler
  const provider = document.getElementById("provider")?.value || "novelai";
  if (provider === "grok") {
    if (state.grokOutputType === "video") return generateGrokVideo();
    return generateGrokImage();
  }

  const btn = $("#generate-btn");

  // If we're in stopping state, trigger abort
  if (btn.classList.contains("stopping")) {
    if (_generateAbortController) _generateAbortController.abort();
    return;
  }

  if (btn.disabled) return;
  btn.disabled = true; // Disable immediately to prevent double-trigger during async setup

  const prompt = $("#prompt").value.trim();
  if (!prompt) {
    showError("Please enter a prompt.");
    btn.disabled = false;
    return;
  }

  const resVal = $("#resolution").value;
  const [width, height] = resVal ? resVal.split("x").map(Number) : [832, 1216];

  const qualityTags = ", very aesthetic, masterpiece, no text";
  let finalPrompt = prompt;
  if ($("#quality-tags").checked) {
    // Append quality tags to base prompt content (before first | separator)
    const pipeMatch = prompt.match(/^([\s\S]*?\S)([\s\n]*\|[\s\S]*)$/);
    if (pipeMatch) {
      finalPrompt = pipeMatch[1] + qualityTags + pipeMatch[2];
    } else {
      finalPrompt = prompt.replace(/\s+$/, "") + qualityTags;
    }
  }

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
    char_captions: collectCharacterPayload(),
    use_coords: characters.some((c) => !c.positionAuto),
  };

  // Layers composite → img2img source (when enabled)
  const layersEnabled = document.getElementById("layers-enabled");
  if (layersEnabled && layersEnabled.checked && layers.some((l) => l.visible && l.imageBase64)) {
    state.img2img = await compositeLayersToBase64(width, height);
  } else {
    state.img2img = null; // No layers active → pure text-to-image
  }

  const inpaintLayer = layers.find(l => l.inpaintMaskBase64);
  console.log("[generate] inpaintLayer:", inpaintLayer ? inpaintLayer.name : "none", "layers with inpaint mask:", layers.filter(l => l.inpaintMaskBase64).length);
  if (inpaintLayer && (state.img2img || state.canvasImageBase64)) {
    // Inpaint mode: use composite as base + layer's inpaint mask
    // Both image and mask use the output resolution coordinate system
    body.image = state.img2img || state.canvasImageBase64;
    body.mask  = inpaintLayer.inpaintMaskBase64;
    console.log("[generate] sending mask, length:", body.mask?.length, "image:", !!body.image);
  } else if (state.img2img) {
    body.image = state.img2img;
  }

  if (vibes.length > 0) {
    body.reference_images = vibes.map((v) => ({
      image: v.base64,
      information_extracted: v.infoExtracted,
      strength: v.strength,
    }));
  }

  body.cfg_rescale = parseFloat($("#cfg-rescale").value);
  body.noise_schedule = $("#noise-schedule").value;

  btn.classList.add("loading");
  clearError();

  _generateAbortController = new AbortController();

  // After a brief moment switch to Stop button so user can cancel
  const stopTimeout = setTimeout(() => {
    if (_generateAbortController) setGenerateButtonStop();
  }, 400);

  try {
    const resp = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: _generateAbortController.signal,
    });

    clearTimeout(stopTimeout);

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || "Generation failed");
    }

    const data = await resp.json();
    state.lastSeed = data.seed;
    state.lastImageBase64 = data.image;
    state.lastGeneratedImageBase64 = data.image;
    state.canvasImageBase64 = data.image;
    state.canvasImageWidth = width;
    state.canvasImageHeight = height;

    const output = $("#output");
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${data.image}`;
    img.alt = "Generated image";
    output.innerHTML = "";
    output.appendChild(img);
    // Re-render character markers (cleared by innerHTML reset above)
    renderCharacterMarkers();

    const actions = $("#image-actions");
    actions.style.display = "flex";
    syncInpaintButtonVisibility();
    $("#info-seed").textContent = `Seed: ${data.seed}`;

    // Output target layer: write result back into the designated layer
    const outputLayer = layers.find(l => l.isOutputTarget);
    if (outputLayer) {
      outputLayer.imageBase64 = data.image;
      saveLayersToStorage();
      refreshCompositePreview();
    }

    // Auto-switch canvas to Output view on generation complete
    _canvasView = "output";
    localStorage.setItem("nai-canvas-view", "output");
    const cvtInput  = document.getElementById("cvt-input");
    const cvtOutput = document.getElementById("cvt-output");
    if (cvtInput)  { cvtInput.classList.remove("cvt-btn--active"); cvtInput.classList.remove("cvt-btn--changed"); }
    if (cvtOutput) cvtOutput.classList.add("cvt-btn--active");
    updateCanvasPanel();

    loadGallery();
    if (window._savePromptToHistory) window._savePromptToHistory();

    // Fire-and-forget: record character tags from prompt + all character slots
    const allPromptText = [prompt, ...characters.map((c) => c.prompt)].join(", ");
    recordRecentCharacters(allPromptText);

    // Auto Generate: start next generation after a short delay
    if ($("#auto-generate") && $("#auto-generate").checked) {
      setTimeout(() => generate(), 500);
    }
  } catch (e) {
    clearTimeout(stopTimeout);
    if (e.name === "AbortError") {
      // User cancelled — show neutral status, not an error
      showStatus("Cancelled");
    } else {
      console.error("Generate error:", e);
      showError(e.message);
    }
  } finally {
    resetGenerateButton();
  }
}


function reuseSeed() {
  if (state.lastSeed !== null) {
    $("#seed").value = state.lastSeed;
  }
}

function downloadImage() {
  if (state.lastVideoBase64) {
    const a = document.createElement("a");
    a.href = `data:video/mp4;base64,${state.lastVideoBase64}`;
    a.download = "grok-video.mp4";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }
  if (!state.lastImageBase64) return;
  const a = document.createElement("a");
  a.href = `data:image/png;base64,${state.lastImageBase64}`;
  a.download = `novelai-${state.lastSeed || "image"}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/* ═══════════════════════════════════════════════════════════
   GROK — Image generation
   ═══════════════════════════════════════════════════════════ */

async function generateGrokImage() {
  const btn = $("#generate-btn");
  if (btn.classList.contains("stopping")) {
    if (_generateAbortController) _generateAbortController.abort();
    return;
  }
  if (btn.disabled) return;

  const prompt = $("#prompt").value.trim();
  if (!prompt) { showError("Please enter a prompt."); return; }

  const quality = document.getElementById("grok-quality")?.value || "standard";
  const body = {
    prompt: prompt,
    aspect_ratio: document.getElementById("grok-aspect-ratio")?.value || "1:1",
    resolution: document.getElementById("grok-resolution")?.value || "1k",
    model: quality === "pro" ? "grok-imagine-image-pro" : "grok-imagine-image",
  };

  // Build images array: source image first (if set), then reference images
  const allImages = [];
  if (state.img2img) allImages.push(state.img2img);
  if (grokRefs.length > 0) allImages.push(...grokRefs.map((r) => r.base64));
  if (allImages.length > 0) body.images = allImages;

  btn.disabled = true;
  btn.classList.add("loading");
  clearError();
  state.lastVideoBase64 = null;
  _generateAbortController = new AbortController();

  const stopTimeout = setTimeout(() => {
    if (_generateAbortController) setGenerateButtonStop();
  }, 400);

  try {
    const resp = await fetch("/api/grok/generate-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: _generateAbortController.signal,
    });

    clearTimeout(stopTimeout);

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || "Generation failed");
    }

    const data = await resp.json();
    state.lastSeed = null;
    state.lastImageBase64 = data.image;
    state.lastGeneratedImageBase64 = data.image;
    state.canvasImageBase64 = data.image;
    state.canvasImageWidth = null;
    state.canvasImageHeight = null;

    const output = $("#output");
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${data.image}`;
    img.alt = "Generated image";
    output.innerHTML = "";
    output.appendChild(img);

    const actions = $("#image-actions");
    if (actions) actions.style.display = "flex";
    syncInpaintButtonVisibility();
    updateCanvasPanel(); // Show Input/Output toggle for Grok
    const infoSeed = $("#info-seed");
    if (infoSeed) infoSeed.textContent = state.img2img ? "Grok (edit)" : "Grok";

    // Auto-switch to Output view
    _canvasView = "output";
    const cvtInput = document.getElementById("cvt-input");
    const cvtOutput = document.getElementById("cvt-output");
    if (cvtInput) { cvtInput.classList.remove("cvt-btn--active"); cvtInput.classList.remove("cvt-btn--changed"); }
    if (cvtOutput) cvtOutput.classList.add("cvt-btn--active");

    loadGallery();
    if (window._savePromptToHistory) window._savePromptToHistory();
    fetchGrokUsage();
  } catch (e) {
    clearTimeout(stopTimeout);
    if (e.name === "AbortError") {
      showStatus("Cancelled");
    } else {
      console.error("Grok generate error:", e);
      showError(e.message);
    }
  } finally {
    resetGenerateButton();
  }
}

/* ═══════════════════════════════════════════════════════════
   GROK — Video generation
   ═══════════════════════════════════════════════════════════ */

async function generateGrokVideo() {
  const btn = $("#generate-btn");
  if (btn.classList.contains("stopping")) {
    if (_generateAbortController) _generateAbortController.abort();
    return;
  }
  if (btn.disabled) return;

  const prompt = $("#prompt").value.trim();
  if (!prompt) { showError("Please enter a prompt."); return; }

  const body = {
    prompt: prompt,
    aspect_ratio: document.getElementById("grok-aspect-ratio")?.value || "1:1",
    resolution: document.getElementById("grok-video-resolution")?.value || "720p",
    duration: parseInt(document.getElementById("grok-duration")?.value) || 5,
  };



  // Include source image for image-to-video: prefer explicit img2img source,
  // fall back to whatever is currently on the canvas
  const videoSourceImage = state.img2img || state.canvasImageBase64;
  console.log("[generateGrokVideo] img2img:", !!state.img2img, "canvasImage:", !!state.canvasImageBase64, "sending image:", !!videoSourceImage);
  if (videoSourceImage) {
    body.image = videoSourceImage;
  }

  btn.disabled = true;
  btn.classList.add("loading");
  clearError();
  state.lastVideoBase64 = null;
  _generateAbortController = new AbortController();

  const stopTimeout = setTimeout(() => {
    if (_generateAbortController) setGenerateButtonStop();
  }, 400);

  // Show progress indicator in the canvas output area
  const output = $("#output");
  let progressMsg = null;
  let progressBar = null;
  if (output) {
    const progressEl = document.createElement("div");
    progressEl.className = "video-progress";

    const spinnerEl = document.createElement("div");
    spinnerEl.className = "spinner";

    progressMsg = document.createElement("p");
    progressMsg.textContent = "Generating video…";

    progressBar = document.createElement("div");
    progressBar.className = "video-progress-track";
    const progressFill = document.createElement("div");
    progressFill.className = "video-progress-fill";
    progressFill.id = "video-progress-fill";
    progressBar.appendChild(progressFill);

    progressEl.appendChild(spinnerEl);
    progressEl.appendChild(progressMsg);
    progressEl.appendChild(progressBar);
    output.innerHTML = "";
    output.appendChild(progressEl);
  }

  try {
    const resp = await fetch("/api/grok/generate-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: _generateAbortController.signal,
    });

    clearTimeout(stopTimeout);

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(text || "Video generation failed");
    }

    // Read SSE stream for progress updates
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let videoData = null;
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // keep incomplete line in buffer
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.status === "pending" && msg.progress != null) {
            const pct = Math.round(msg.progress);
            if (progressMsg) progressMsg.textContent = `Generating video… ${pct}%`;
            const fill = document.getElementById("video-progress-fill");
            if (fill) fill.style.width = pct + "%";
          } else if (msg.status === "done" && msg.video) {
            videoData = msg.video;
          } else if (msg.status === "error") {
            throw new Error(msg.detail || "Video generation failed");
          }
        } catch (parseErr) {
          if (parseErr.message && !parseErr.message.includes("JSON")) throw parseErr;
        }
      }
    }

    if (!videoData) throw new Error("No video data received");

    state.lastSeed = null;
    state.lastImageBase64 = null;
    state.lastVideoBase64 = videoData;

    if (output) {
      output.innerHTML = "";
      const video = document.createElement("video");
      video.src = `data:video/mp4;base64,${videoData}`;
      video.autoplay = true;
      video.loop = true;
      video.muted = false;
      video.controls = true;
      output.appendChild(video);
    }

    const actions = $("#image-actions");
    if (actions) actions.style.display = "flex";
    syncInpaintButtonVisibility();
    const infoSeed = $("#info-seed");
    if (infoSeed) infoSeed.textContent = "Grok Video";

    loadGallery();
    fetchGrokUsage();
  } catch (e) {
    clearTimeout(stopTimeout);
    if (e.name === "AbortError") {
      showStatus("Cancelled");
    } else {
      console.error("Grok video error:", e);
      showError(e.message);
    }
  } finally {
    resetGenerateButton();
  }
}
