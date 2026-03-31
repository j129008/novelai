/* ═══════════════════════════════════════════════════════════
   PROVIDER SWITCHING — NovelAI vs Grok
   ═══════════════════════════════════════════════════════════ */

function applyProvider(provider) {
  // Save current prompt before switching
  const prompt = document.getElementById("prompt");
  const negative = document.getElementById("negative-prompt");
  const prevProvider = document.getElementById("provider")?.dataset.prevProvider || "novelai";
  if (prompt) localStorage.setItem("nai-prompt-" + prevProvider, prompt.value);
  if (negative) localStorage.setItem("nai-negative-novelai", negative.value);
  const providerEl = document.getElementById("provider");
  if (providerEl) providerEl.dataset.prevProvider = provider;

  const isGrok = provider === "grok";

  // NovelAI-only sidebar elements to hide when Grok is active
  const novelaiOnly = [
    document.querySelector('[data-target="negative-prompt"]'), // Undesired tab button
    document.getElementById("quality-tags-pill"),
    document.getElementById("characters-accordion"),
    document.getElementById("auto-generate")?.closest(".toggle-switch"),
    document.getElementById("gen-settings-btn"),
    document.getElementById("layers-accordion"),
  ];

  // Config bar NovelAI-specific fields (Canvas resolution select)
  const canvasField = document.getElementById("canvas-field");
  // Seed footer row — shown for NovelAI only (Grok has no seed)
  const seedFooterRow = document.getElementById("seed-footer-row");

  novelaiOnly.forEach((el) => {
    if (el) el.style.display = isGrok ? "none" : "";
  });

  if (canvasField)    canvasField.style.display    = isGrok ? "none" : "";
  if (seedFooterRow)  seedFooterRow.style.display  = isGrok ? "none" : "";

  // Show/hide Grok-only elements
  // Note: grok-video-controls visibility is managed by the output-type toggle,
  // not by provider switching — it stays hidden until video mode is selected.
  document.querySelectorAll(".grok-only").forEach((el) => {
    if (el.id === "grok-video-controls") {
      // Only show if we're in Grok video mode
      el.style.display = (isGrok && state.grokOutputType === "video") ? "" : "none";
    } else {
      el.style.display = isGrok ? "" : "none";
    }
  });

  // Grok doesn't support negative prompts — hide the Undesired tab
  const negativeTab = document.querySelector('[data-target="negative-prompt"]');
  if (negativeTab) negativeTab.style.display = isGrok ? "none" : "";

  // When switching to Grok, ensure we're on the Prompt tab (not Undesired)
  if (isGrok) {
    const promptTab = document.querySelector('[data-target="prompt"]');
    if (negativeTab && negativeTab.classList.contains("active")) {
      if (promptTab) promptTab.click();
    }
  }

  // Hide NovelAI-only prompt controls in Grok mode
  const qualityPill = document.getElementById("quality-tags-pill");
  if (qualityPill) qualityPill.style.display = isGrok ? "none" : "";

  // Update Generate button label
  const generateBtn = document.getElementById("generate-btn");
  if (generateBtn) {
    const labelEl = generateBtn.querySelector(".btn-generate-label");
    const hintEl  = generateBtn.querySelector(".btn-generate-hint");
    if (labelEl) {
      labelEl.textContent = (isGrok && state.grokOutputType === "video") ? "Generate Video" : "Generate";
    }
    if (hintEl) {
      hintEl.textContent = "Enter";
    }
  }

  // Save to localStorage
  localStorage.setItem("nai-provider", provider);

  // Sync inpaint button visibility (NovelAI + has image)
  syncInpaintButtonVisibility();

  // Always fetch Grok usage (API is used in both modes now)
  fetchGrokUsage();

  // Update canvas layer panel visibility for new provider
  updateCanvasPanel();

  // Swap prompt content for the new provider
  if (typeof swapPromptForProvider === "function") swapPromptForProvider();
}

async function fetchGrokUsage() {
  const fill = document.getElementById("grok-quota-fill");
  const label = document.getElementById("grok-quota-label");
  if (!fill || !label) return;
  try {
    const resp = await fetch("/api/grok/usage");
    if (!resp.ok) { label.textContent = "—"; return; }
    const data = await resp.json();
    const remaining = data.remaining_cents / 100;
    const total = data.balance_cents / 100;
    const used = data.used_cents / 100;
    const pct = data.balance_cents > 0 ? data.remaining_cents / data.balance_cents : 0;

    fill.style.width = (pct * 100).toFixed(1) + "%";
    label.textContent = `$${remaining.toFixed(2)} / $${total.toFixed(2)}`;

    // Tooltip with breakdown
    const bar = document.getElementById("grok-quota-bar");
    if (bar) {
      bar.title = `Used $${used.toFixed(2)}\n` + data.items
        .filter(i => i.count > 0)
        .map(i => `${i.model} ${i.type}: ${i.count}x ($${(i.cost_cents / 100).toFixed(2)})`)
        .join("\n");
    }

    fill.classList.remove("warning", "danger");
    if (pct < 0.1) fill.classList.add("danger");
    else if (pct < 0.3) fill.classList.add("warning");

    // Show quota section in settings
    const section = document.getElementById("grok-quota-section");
    if (section) section.style.display = "";

    // Schedule next auto-refresh
    if (!fetchGrokUsage._timer) {
      fetchGrokUsage._timer = setInterval(fetchGrokUsage, 60000);
    }
  } catch {
    label.textContent = "—";
  }
}
