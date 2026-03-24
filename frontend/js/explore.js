/* ═══════════════════════════════════════════════════════════
   EXPLORE PANEL — browse any page's images and load as img2img
   ═══════════════════════════════════════════════════════════ */

function setupExplorePanel() {
  const urlInput = $("#explore-url");
  const goBtn = $("#explore-go");
  const grid = $("#explore-grid");
  const status = $("#explore-status");
  const linksSection = $("#explore-links");
  const linksList = $("#explore-links-list");

  if (!urlInput || !goBtn) return;

  // ── Sub-tab switching ──
  const subTabs = document.querySelectorAll(".explore-sub-tab");
  const modeUrl = $("#explore-mode-url");
  const modeLocal = $("#explore-mode-local");

  subTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      subTabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const mode = tab.dataset.exploreMode;
      if (modeUrl) modeUrl.style.display = mode === "url" ? "" : "none";
      if (modeLocal) modeLocal.style.display = mode === "local" ? "" : "none";
    });
  });

  // ── Local folder browser with multi-tab ──
  const localPathInput = $("#local-browse-path");
  const localBrowseBtn = $("#local-browse-btn");
  const localBreadcrumb = $("#local-breadcrumb");
  const localStatus = $("#local-status");
  const localGrid = $("#local-grid");
  const folderTabList = $("#local-folder-tab-list");
  const folderTabAdd = $("#local-folder-tab-add");

  // Tab state: array of { root, subpath, name }
  let folderTabs = JSON.parse(localStorage.getItem("local_folder_tabs") || "[]");
  let activeTabIdx = parseInt(localStorage.getItem("local_folder_active_tab") || "0", 10);

  // Migrate old single-root to first tab
  const oldRoot = localStorage.getItem("local_browse_root") || "";
  if (folderTabs.length === 0 && oldRoot) {
    folderTabs.push({ root: oldRoot, subpath: "", name: oldRoot.split("/").pop() || "Local" });
  }

  function saveFolderTabs() {
    localStorage.setItem("local_folder_tabs", JSON.stringify(folderTabs));
    localStorage.setItem("local_folder_active_tab", String(activeTabIdx));
  }

  function renderFolderTabs() {
    if (!folderTabList) return;
    folderTabList.innerHTML = "";
    folderTabs.forEach((tab, i) => {
      const el = document.createElement("div");
      el.className = "local-folder-tab" + (i === activeTabIdx ? " active" : "");
      const label = document.createElement("span");
      label.textContent = tab.name || tab.root.split("/").pop() || "Local";
      label.style.overflow = "hidden";
      label.style.textOverflow = "ellipsis";
      el.appendChild(label);

      if (folderTabs.length > 1) {
        const closeBtn = document.createElement("button");
        closeBtn.className = "local-folder-tab-close";
        closeBtn.textContent = "\u00d7";
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          folderTabs.splice(i, 1);
          if (activeTabIdx >= folderTabs.length) activeTabIdx = Math.max(0, folderTabs.length - 1);
          saveFolderTabs();
          renderFolderTabs();
          switchToTab(activeTabIdx);
        });
        el.appendChild(closeBtn);
      }

      el.addEventListener("click", () => {
        // Save current subpath before switching
        if (folderTabs[activeTabIdx]) folderTabs[activeTabIdx].subpath = localCurrentSubpath;
        activeTabIdx = i;
        saveFolderTabs();
        renderFolderTabs();
        switchToTab(i);
      });
      folderTabList.appendChild(el);
    });
  }

  function switchToTab(idx) {
    const tab = folderTabs[idx];
    if (!tab) return;
    localRootPath = tab.root;
    localCurrentSubpath = tab.subpath || "";
    if (localPathInput) localPathInput.value = tab.root;
    // Set server-side root
    fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ local_browse_root: tab.root }),
    }).then(() => browseLocalFolder(localCurrentSubpath)).catch(() => browseLocalFolder(localCurrentSubpath));
  }

  let localRootPath = "";
  let localCurrentSubpath = "";

  async function setLocalRoot(fullPath) {
    // Save to server settings for security enforcement
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ local_browse_root: fullPath }),
      });
    } catch (err) {
      showError("Failed to save browse root: " + err.message);
      return;
    }
    localRootPath = fullPath;
    localStorage.setItem("local_browse_root", fullPath);
    localCurrentSubpath = "";

    // Update or add tab
    if (folderTabs[activeTabIdx]) {
      folderTabs[activeTabIdx].root = fullPath;
      folderTabs[activeTabIdx].subpath = "";
      folderTabs[activeTabIdx].name = fullPath.split("/").pop() || "Local";
    } else {
      folderTabs.push({ root: fullPath, subpath: "", name: fullPath.split("/").pop() || "Local" });
      activeTabIdx = folderTabs.length - 1;
    }
    saveFolderTabs();
    renderFolderTabs();
    browseLocalFolder("");
  }

  async function browseLocalFolder(subpath) {
    if (!localRootPath) return;
    localCurrentSubpath = subpath;
    // Keep tab state in sync
    if (folderTabs[activeTabIdx]) folderTabs[activeTabIdx].subpath = subpath;
    localGrid.innerHTML = "";
    localStatus.style.display = "block";
    localStatus.textContent = "Loading…";

    try {
      const resp = await fetch("/api/explore/local?path=" + encodeURIComponent(subpath));
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to browse folder");
      }
      const data = await resp.json();

      // Fetch batch tag status for dot indicators
      let analyzedMap = {};
      try {
        const tagsResp = await fetch("/api/explore/local/tags/batch?path=" + encodeURIComponent(subpath));
        if (tagsResp.ok) {
          const tagsData = await tagsResp.json();
          analyzedMap = tagsData.analyzed || {};
        }
      } catch (_) {}

      localStatus.style.display = "none";
      renderLocalBreadcrumb(subpath);

      // Render folders
      for (const dir of data.directories) {
        const card = document.createElement("div");
        card.className = "local-folder-card";
        card.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><span></span>';
        card.querySelector("span").textContent = dir.name;
        const childPath = subpath ? subpath + "/" + dir.name : dir.name;
        card.addEventListener("click", () => browseLocalFolder(childPath));
        localGrid.appendChild(card);
      }

      // Render images
      for (const file of data.files) {
        const card = document.createElement("div");
        card.className = "explore-card";
        const imgEl = document.createElement("img");
        const imgPath = subpath ? subpath + "/" + file.name : file.name;
        imgEl.src = "/api/explore/local/image?path=" + encodeURIComponent(imgPath) + "&thumbnail=true";
        imgEl.alt = file.name;
        imgEl.loading = "lazy";
        imgEl.addEventListener("click", () => useLocalImage(imgPath));
        card.appendChild(imgEl);
        if (analyzedMap[file.name]) {
          const dot = document.createElement("div");
          dot.className = "explore-card-analyzed-dot";
          card.appendChild(dot);
        }
        localGrid.appendChild(card);
      }

      if (data.directories.length === 0 && data.files.length === 0) {
        localStatus.style.display = "block";
        localStatus.textContent = "Empty folder";
      }
    } catch (err) {
      localStatus.style.display = "block";
      localStatus.textContent = "Error: " + err.message;
    }
  }

  function renderLocalBreadcrumb(subpath) {
    if (!localBreadcrumb) return;
    localBreadcrumb.innerHTML = "";

    // Root segment
    const rootSeg = document.createElement("a");
    rootSeg.className = "local-breadcrumb-seg";
    rootSeg.textContent = "\uD83D\uDCC1";
    rootSeg.addEventListener("click", () => browseLocalFolder(""));
    localBreadcrumb.appendChild(rootSeg);

    if (!subpath) return;

    const parts = subpath.split("/");
    for (let i = 0; i < parts.length; i++) {
      const sep = document.createElement("span");
      sep.className = "local-breadcrumb-sep";
      sep.textContent = " / ";
      localBreadcrumb.appendChild(sep);

      if (i === parts.length - 1) {
        const cur = document.createElement("span");
        cur.className = "local-breadcrumb-current";
        cur.textContent = parts[i];
        localBreadcrumb.appendChild(cur);
      } else {
        const seg = document.createElement("a");
        seg.className = "local-breadcrumb-seg";
        seg.textContent = parts[i];
        const segPath = parts.slice(0, i + 1).join("/");
        seg.addEventListener("click", () => browseLocalFolder(segPath));
        localBreadcrumb.appendChild(seg);
      }
    }
  }

  // ── Analysis overlay state ──
  const analysisPanel = $("#local-analysis-overlay");
  const analysisImg = $("#local-analysis-img");
  const analysisResults = $("#local-analysis-results");
  const analysisStatus = $("#local-analysis-status");
  const analyzeWdBtn = $("#local-analyze-wd");
  const analyzeFlorenceBtn = $("#local-analyze-florence");
  const analyzeGrokBtn = $("#local-analyze-grok");
  const analysisSendBtn = $("#local-analysis-send");
  const reanalyzeWdBtn = $("#local-analysis-reanalyze-wd");
  const reanalyzeFlorenceBtn = $("#local-analysis-reanalyze-florence");
  const reanalyzeGrokBtn = $("#local-analysis-reanalyze-grok");
  let currentAnalysisPath = "";
  let selectedTags = [];
  const selectedArea = $("#local-analysis-selected");
  const selectedTagsContainer = $("#local-analysis-selected-tags");
  const clearTagsBtn = $("#local-analysis-clear-tags");
  const addToPromptBtn = $("#local-analysis-add-prompt");

  function addTagToSelection(tag) {
    if (selectedTags.includes(tag)) return;
    selectedTags.push(tag);
    renderSelectedTags();
  }

  function removeTagFromSelection(tag) {
    selectedTags = selectedTags.filter(t => t !== tag);
    renderSelectedTags();
  }

  function renderSelectedTags() {
    if (!selectedTagsContainer || !selectedArea) return;
    selectedTagsContainer.innerHTML = "";
    if (selectedTags.length === 0) {
      selectedArea.style.display = "none";
      return;
    }
    selectedArea.style.display = "";
    for (const tag of selectedTags) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "local-analysis-tag selected";
      pill.textContent = tag + " ×";
      pill.addEventListener("click", () => removeTagFromSelection(tag));
      selectedTagsContainer.appendChild(pill);
    }
  }

  if (clearTagsBtn) clearTagsBtn.addEventListener("click", () => { selectedTags = []; renderSelectedTags(); });
  if (addToPromptBtn) addToPromptBtn.addEventListener("click", () => {
    if (selectedTags.length === 0) return;
    insertTagIntoPrompt(selectedTags.join(", "));
    closeAnalysisPanel();
  });

  // Check if Grok Vision is available
  fetch("/api/settings").then(r => r.json()).then(s => {
    if (!s.xai_api_configured && analyzeGrokBtn) {
      analyzeGrokBtn.disabled = true;
      analyzeGrokBtn.title = "XAI_API_KEY not configured";
    }
  }).catch(() => {});

  function openAnalysisPanel(imgPath) {
    currentAnalysisPath = imgPath;
    analysisResults.innerHTML = "";
    analysisStatus.style.display = "none";
    analysisPanel.style.display = "flex";
    reanalyzeWdBtn.style.display = "none";
    reanalyzeFlorenceBtn.style.display = "none";
    reanalyzeGrokBtn.style.display = "none";
    selectedTags = [];
    renderSelectedTags();

    // Show preview
    analysisImg.src = "/api/explore/local/image?path=" + encodeURIComponent(imgPath);

    // Load cached tags
    fetch("/api/explore/local/tags?path=" + encodeURIComponent(imgPath))
      .then(r => r.json())
      .then(data => {
        if (data.wd) renderWdTags(data.wd);
        if (data.florence) renderFlorenceResults(data.florence);
        if (data.grok) renderGrokAnalysis(data.grok);
      })
      .catch(() => {});
  }

  function closeAnalysisPanel() {
    analysisPanel.style.display = "none";
    currentAnalysisPath = "";
  }

  // Close button + click backdrop to close
  const analysisCloseBtn = $("#local-analysis-close");
  if (analysisCloseBtn) analysisCloseBtn.addEventListener("click", closeAnalysisPanel);
  if (analysisPanel) {
    analysisPanel.addEventListener("click", (e) => {
      if (e.target === analysisPanel) closeAnalysisPanel(); // click backdrop
    });
  }

  function renderWdTags(tags) {
    const existing = analysisResults.querySelector(".wd-section");
    if (existing) existing.remove();

    const section = document.createElement("div");
    section.className = "wd-section";

    const label = document.createElement("div");
    label.className = "local-analysis-section-label";
    label.textContent = "WD Tagger (danbooru tags)";
    section.appendChild(label);

    const container = document.createElement("div");
    container.className = "local-analysis-tags";
    for (const tag of tags) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "local-analysis-tag";
      pill.textContent = tag.name.replace(/_/g, " ");
      pill.title = tag.name + " (" + (tag.score * 100).toFixed(0) + "%)";
      pill.addEventListener("click", () => addTagToSelection(tag.name.replace(/_/g, " ")));
      container.appendChild(pill);
    }
    section.appendChild(container);
    analysisResults.appendChild(section);
    reanalyzeWdBtn.style.display = "";
  }

  function renderFlorenceResults(florence) {
    const existing = analysisResults.querySelector(".florence-section");
    if (existing) existing.remove();

    const section = document.createElement("div");
    section.className = "florence-section";

    // Short caption
    const captionLabel = document.createElement("div");
    captionLabel.className = "local-analysis-section-label";
    captionLabel.textContent = "Florence-2 Caption";
    section.appendChild(captionLabel);

    const caption = document.createElement("div");
    caption.className = "local-analysis-description";
    caption.textContent = florence.caption;
    section.appendChild(caption);

    const captionActions = document.createElement("div");
    captionActions.className = "local-analysis-desc-actions";

    const useCaptionBtn = document.createElement("button");
    useCaptionBtn.type = "button";
    useCaptionBtn.className = "btn-action";
    useCaptionBtn.textContent = "Insert";
    useCaptionBtn.addEventListener("click", () => insertTagIntoPrompt(florence.caption));
    captionActions.appendChild(useCaptionBtn);
    section.appendChild(captionActions);

    // Detailed description
    const detailLabel = document.createElement("div");
    detailLabel.className = "local-analysis-section-label";
    detailLabel.textContent = "Detailed Description";
    detailLabel.style.marginTop = "8px";
    section.appendChild(detailLabel);

    const detail = document.createElement("div");
    detail.className = "local-analysis-description";
    detail.textContent = florence.detail;
    section.appendChild(detail);

    const detailActions = document.createElement("div");
    detailActions.className = "local-analysis-desc-actions";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn-action";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(florence.detail);
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
    });
    detailActions.appendChild(copyBtn);

    const useDetailBtn = document.createElement("button");
    useDetailBtn.type = "button";
    useDetailBtn.className = "btn-action";
    useDetailBtn.textContent = "Use as Prompt";
    useDetailBtn.addEventListener("click", () => {
      const el = $("#prompt");
      if (el) { el.value = florence.detail; el.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    detailActions.appendChild(useDetailBtn);
    section.appendChild(detailActions);

    analysisResults.appendChild(section);
    reanalyzeFlorenceBtn.style.display = "";
  }

  function renderGrokAnalysis(grok) {
    const existing = analysisResults.querySelector(".grok-section");
    if (existing) existing.remove();

    const section = document.createElement("div");
    section.className = "grok-section";

    const tagLabel = document.createElement("div");
    tagLabel.className = "local-analysis-section-label";
    tagLabel.textContent = "Grok Vision Tags";
    section.appendChild(tagLabel);

    const tagContainer = document.createElement("div");
    tagContainer.className = "local-analysis-tags";
    for (const tag of grok.tags) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "local-analysis-tag";
      pill.textContent = tag.replace(/_/g, " ");
      pill.addEventListener("click", () => addTagToSelection(tag.replace(/_/g, " ")));
      tagContainer.appendChild(pill);
    }
    section.appendChild(tagContainer);

    const descLabel = document.createElement("div");
    descLabel.className = "local-analysis-section-label";
    descLabel.textContent = "Description";
    descLabel.style.marginTop = "8px";
    section.appendChild(descLabel);

    const desc = document.createElement("div");
    desc.className = "local-analysis-description";
    desc.textContent = grok.description;
    section.appendChild(desc);

    const descActions = document.createElement("div");
    descActions.className = "local-analysis-desc-actions";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn-action";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(grok.description);
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
    });
    descActions.appendChild(copyBtn);

    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "btn-action";
    useBtn.textContent = "Use as Prompt";
    useBtn.addEventListener("click", () => {
      const el = $("#prompt");
      if (el) { el.value = grok.description; el.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    descActions.appendChild(useBtn);

    section.appendChild(descActions);
    analysisResults.appendChild(section);
    reanalyzeGrokBtn.style.display = "";
  }

  async function runAnalysis(method) {
    if (!currentAnalysisPath) return;
    analysisStatus.style.display = "block";
    const labels = { wd: "Running WD Tagger...", florence: "Running Florence-2...", grok: "Analyzing with Grok Vision..." };
    analysisStatus.textContent = labels[method] || "Analyzing...";

    try {
      const resp = await fetch("/api/explore/local/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: currentAnalysisPath, method }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Analysis failed");
      }
      const data = await resp.json();
      analysisStatus.style.display = "none";

      if (data.wd) renderWdTags(data.wd);
      if (data.florence) renderFlorenceResults(data.florence);
      if (data.grok) {
        renderGrokAnalysis(data.grok);
        if (typeof fetchGrokUsage === "function") fetchGrokUsage();
      }

      // Add dot indicator to the current image card (without refreshing the whole grid)
      const fileName = currentAnalysisPath.split("/").pop();
      const cards = localGrid.querySelectorAll(".explore-card");
      for (const card of cards) {
        const img = card.querySelector("img");
        if (img && img.alt === fileName && !card.querySelector(".explore-card-analyzed-dot")) {
          const dot = document.createElement("div");
          dot.className = "explore-card-analyzed-dot";
          card.appendChild(dot);
        }
      }
    } catch (err) {
      analysisStatus.style.display = "block";
      analysisStatus.textContent = "Error: " + err.message;
    }
  }

  // Wire up buttons
  if (analyzeWdBtn) analyzeWdBtn.addEventListener("click", () => runAnalysis("wd"));
  if (analyzeFlorenceBtn) analyzeFlorenceBtn.addEventListener("click", () => runAnalysis("florence"));
  if (analyzeGrokBtn) analyzeGrokBtn.addEventListener("click", () => runAnalysis("grok"));
  if (reanalyzeWdBtn) reanalyzeWdBtn.addEventListener("click", () => runAnalysis("wd"));
  if (reanalyzeFlorenceBtn) reanalyzeFlorenceBtn.addEventListener("click", () => runAnalysis("florence"));
  if (reanalyzeGrokBtn) reanalyzeGrokBtn.addEventListener("click", () => runAnalysis("grok"));

  // Send to Canvas button
  if (analysisSendBtn) {
    analysisSendBtn.addEventListener("click", async () => {
      if (!currentAnalysisPath) return;
      try {
        const resp = await fetch("/api/explore/local/image?path=" + encodeURIComponent(currentAnalysisPath));
        if (!resp.ok) throw new Error("Failed to load image");
        const blob = await resp.blob();
        const reader = new FileReader();
        reader.onload = (ev) => {
          const img = new Image();
          img.onload = () => { closeAnalysisPanel(); openCropOverlay(img); };
          img.src = ev.target.result;
        };
        reader.readAsDataURL(blob);
      } catch (err) {
        showError("Failed to load image: " + err.message);
      }
    });
  }

  // Image click handler — opens analysis panel instead of crop overlay
  async function useLocalImage(imgPath) {
    openAnalysisPanel(imgPath);
  }

  // Browse button — macOS folder picker
  if (localBrowseBtn) {
    localBrowseBtn.addEventListener("click", async () => {
      try {
        const resp = await fetch("/api/settings/browse", { method: "POST" });
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.path) {
          localPathInput.value = data.path;
          setLocalRoot(data.path);
        }
      } catch (err) {
        showError("Browse failed: " + err.message);
      }
    });
  }

  // Path input — Enter key
  if (localPathInput) {
    localPathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const val = localPathInput.value.trim();
        if (val) setLocalRoot(val);
      }
    });
  }

  // "+" button — add new folder tab
  if (folderTabAdd) {
    folderTabAdd.addEventListener("click", async () => {
      try {
        const resp = await fetch("/api/settings/browse", { method: "POST" });
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.path) {
          // Save current subpath
          if (folderTabs[activeTabIdx]) folderTabs[activeTabIdx].subpath = localCurrentSubpath;
          folderTabs.push({ root: data.path, subpath: "", name: data.path.split("/").pop() || "Local" });
          activeTabIdx = folderTabs.length - 1;
          saveFolderTabs();
          renderFolderTabs();
          switchToTab(activeTabIdx);
        }
      } catch (err) {
        showError("Browse failed: " + err.message);
      }
    });
  }

  // Init: render tabs and load active tab
  renderFolderTabs();
  if (folderTabs.length > 0 && folderTabs[activeTabIdx]) {
    switchToTab(activeTabIdx);
  }

  async function explorePage(url) {
    // Normalize URL
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    urlInput.value = url;

    grid.innerHTML = "";
    if (linksSection) linksSection.style.display = "none";
    status.style.display = "block";
    status.textContent = "Loading…";
    goBtn.disabled = true;

    try {
      const resp = await fetch("/api/explore/page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!resp.ok) throw new Error("Failed to load page");
      const data = await resp.json();

      status.style.display = "none";

      if (data.images.length === 0) {
        status.style.display = "block";
        status.textContent = "No images found";
        return;
      }

      // Render image grid
      for (const img of data.images) {
        // Pre-filter by declared size if available
        if (img.width > 0 && img.height > 0 && (img.width < 150 || img.height < 150)) continue;

        const card = document.createElement("div");
        card.className = "explore-card";
        card.dataset.src = img.src;

        const imgEl = document.createElement("img");
        imgEl.src = "/api/explore/image?url=" + encodeURIComponent(img.src);
        imgEl.alt = img.alt || "";
        imgEl.loading = "lazy";
        // Hide tiny images after they load (catches cases where declared size was missing)
        imgEl.addEventListener("load", () => {
          if (imgEl.naturalWidth < 150 || imgEl.naturalHeight < 150) {
            card.style.display = "none";
          }
        });
        imgEl.addEventListener("click", () => {
          useExploreImage(img.src);
        });

        card.appendChild(imgEl);
        grid.appendChild(card);
      }

      // Render links for navigation
      if (data.links && data.links.length > 0 && linksList) {
        linksList.innerHTML = "";
        for (const link of data.links.slice(0, 20)) {
          const a = document.createElement("a");
          a.href = "#";
          a.className = "explore-link";
          a.textContent = link.text || link.href;
          a.title = link.href;
          a.addEventListener("click", (e) => {
            e.preventDefault();
            explorePage(link.href);
          });
          linksList.appendChild(a);
        }
        linksSection.style.display = "";
      }
    } catch (err) {
      status.style.display = "block";
      status.textContent = "Failed to load: " + err.message;
    } finally {
      goBtn.disabled = false;
    }
  }

  async function useExploreImage(imageUrl) {
    try {
      const resp = await fetch("/api/explore/image?url=" + encodeURIComponent(imageUrl));
      if (!resp.ok) throw new Error("Failed to load image");
      const blob = await resp.blob();
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        const img = new Image();
        img.onload = () => {
          openCropOverlay(img);
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      showError("Failed to load image: " + err.message);
    }
  }

  // People filter — batch mode
  const filterBtn = $("#explore-filter-people");
  let filterActive = false;

  if (filterBtn) {
    filterBtn.addEventListener("click", async () => {
      if (filterActive) {
        filterActive = false;
        filterBtn.classList.remove("active");
        grid.querySelectorAll(".explore-card").forEach(c => { c.style.display = ""; });
        if (status) status.style.display = "none";
        return;
      }

      filterActive = true;
      filterBtn.classList.add("active");

      const cards = Array.from(grid.querySelectorAll(".explore-card"));
      if (cards.length === 0) return;

      // Hide all cards, then show as we find people
      cards.forEach(c => { c.style.display = "none"; });

      if (status) {
        status.style.display = "block";
        status.textContent = "Analyzing 0/" + cards.length + " images…";
      }

      let visible = 0;
      let done = 0;
      const total = cards.length;

      // Process cards sequentially — extract base64 from already-loaded proxy img, send to backend
      for (const card of cards) {
        if (!filterActive) break;
        const imgEl = card.querySelector("img");
        if (!imgEl || !imgEl.complete || !imgEl.naturalWidth) {
          done++;
          continue;
        }

        try {
          // Draw loaded image to canvas to get base64
          const canvas = document.createElement("canvas");
          const size = Math.min(384, Math.max(imgEl.naturalWidth, imgEl.naturalHeight));
          const scale = size / Math.max(imgEl.naturalWidth, imgEl.naturalHeight);
          canvas.width = Math.round(imgEl.naturalWidth * scale);
          canvas.height = Math.round(imgEl.naturalHeight * scale);
          canvas.getContext("2d").drawImage(imgEl, 0, 0, canvas.width, canvas.height);
          const b64 = canvas.toDataURL("image/jpeg", 0.6).split(",")[1];

          const resp = await fetch("/api/explore/has-person", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: b64 }),
          });
          if (resp.ok) {
            const result = await resp.json();
            if (result.has_person) {
              card.style.display = "";
              visible++;
            }
          }
        } catch (_) {}

        done++;
        if (status && filterActive) {
          status.textContent = "Analyzing " + done + "/" + total + " — " + visible + " with people";
        }
      }

      if (status && filterActive) {
        status.textContent = visible > 0
          ? "Filter complete: " + visible + " images with people"
          : "No images with people found";
      }
    });
  }

  goBtn.addEventListener("click", () => {
    const url = urlInput.value.trim();
    if (url) {
      filterActive = false;
      if (filterBtn) filterBtn.classList.remove("active");
      explorePage(url);
    }
  });

  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const url = urlInput.value.trim();
      if (url) {
        filterActive = false;
        if (filterBtn) filterBtn.classList.remove("active");
        explorePage(url);
      }
    }
  });
}
