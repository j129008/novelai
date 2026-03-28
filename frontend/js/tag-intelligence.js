/* ═══════════════════════════════════════════════════════════
   TAG INTELLIGENCE — prompt coaching from optimize/refine history
   ═══════════════════════════════════════════════════════════ */

const TagIntelligence = (() => {
  const STORAGE_KEY = "nai-tag-intelligence";
  const MAX_HISTORY = 50;
  const MAX_DISCOVERIES = 200;

  let _data = null;

  function _load() {
    if (_data) return _data;
    try {
      _data = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch { _data = {}; }
    if (!Array.isArray(_data.history)) _data.history = [];
    if (!Array.isArray(_data.knownTags)) _data.knownTags = [];
    if (!Array.isArray(_data.discoveries)) _data.discoveries = [];
    return _data;
  }

  function _save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_data)); } catch { /* quota */ }
  }

  // Normalize a single raw tag string: strip emphasis markers and weight syntax
  function _normalizeTag(raw) {
    return raw
      .trim()
      .toLowerCase()
      .replace(/ /g, "_")
      .replace(/^\{+/, "").replace(/\}+$/, "")
      .replace(/^\[+/, "").replace(/\]+$/, "")
      .replace(/^-?[\d.]+::/, "")
      .replace(/::$/, "");
  }

  // Parse a prompt string into normalized flat tag array (for suggestions / known-tag tracking)
  function parseTags(prompt) {
    if (!prompt) return [];
    return prompt
      .split("|").join(",")
      .split(",")
      .map(_normalizeTag)
      .filter(t => t.length > 0);
  }

  // Parse a prompt into per-section tag arrays.
  // Returns an array where index 0 = base section, 1+ = character sections.
  // Each entry is an array of normalized tags prefixed with "s{n}:" so cross-section
  // moves are visible as distinct additions/removals in the diff.
  function parseTagSections(prompt) {
    if (!prompt) return [];
    const sections = prompt.split("|").map(s => s.trim());
    const labeled = [];
    sections.forEach((section, si) => {
      const tags = section
        .split(",")
        .map(_normalizeTag)
        .filter(t => t.length > 0)
        .map(t => `s${si}:${t}`);
      labeled.push(...tags);
    });
    return labeled;
  }

  // Compute diff between two tag arrays
  function diffTags(beforeTags, afterTags) {
    const beforeSet = new Set(beforeTags);
    const afterSet = new Set(afterTags);
    const added = afterTags.filter(t => !beforeSet.has(t));
    const removed = beforeTags.filter(t => !afterSet.has(t));
    const reordered = added.length === 0 && removed.length === 0 &&
      beforeTags.some((t, i) => afterTags[i] !== t);
    return { added, removed, reordered };
  }

  // Record an optimize/refine event.
  // explanation is an optional string (from data.changes in the API response).
  function recordChange(source, beforePrompt, afterPrompt, explanation) {
    const data = _load();
    const beforeTags = parseTags(beforePrompt);
    const afterTags = parseTags(afterPrompt);

    // Bootstrap knownTags on first ever call
    if (data.history.length === 0) {
      const knownSet = new Set(data.knownTags);
      for (const t of beforeTags) knownSet.add(t);
      data.knownTags = [...knownSet];
    }

    // Push history entry (use section-labeled tags for diff, store explanation)
    data.history.push({
      ts: Date.now(),
      source,
      before: beforePrompt,
      after: afterPrompt,
      explanation: explanation || null,
    });
    // Cap ring buffer
    if (data.history.length > MAX_HISTORY) {
      data.history = data.history.slice(-MAX_HISTORY);
    }

    // Detect new discoveries (use flat tags — structural labels not relevant here)
    const knownSet = new Set(data.knownTags);
    for (const tag of afterTags) {
      if (!knownSet.has(tag)) {
        data.discoveries.push({ tag, ts: Date.now(), source });
        knownSet.add(tag);
      }
    }
    // Also add all afterTags to known
    data.knownTags = [...knownSet];

    // Cap discoveries
    if (data.discoveries.length > MAX_DISCOVERIES) {
      data.discoveries = data.discoveries.slice(-MAX_DISCOVERIES);
    }

    _save();
    document.dispatchEvent(new CustomEvent("tag-intelligence-updated"));
  }

  function getHistory() {
    const data = _load();
    return data.history;
  }

  function getLastChange() {
    const data = _load();
    if (!data.history.length) return null;
    const entry = data.history[data.history.length - 1];

    // Use section-labeled diff when pipes are present for structural accuracy
    const hasMultiSection = entry.before.includes("|") || entry.after.includes("|");
    let diff;
    if (hasMultiSection) {
      const beforeTags = parseTagSections(entry.before);
      const afterTags = parseTagSections(entry.after);
      diff = diffTags(beforeTags, afterTags);
    } else {
      const beforeTags = parseTags(entry.before);
      const afterTags = parseTags(entry.after);
      diff = diffTags(beforeTags, afterTags);
    }

    return { ...entry, ...diff, hasMultiSection };
  }

  function getDiscoveries() {
    const data = _load();
    // Return sorted by most recent first
    return [...data.discoveries].reverse();
  }

  async function fetchSuggestions(promptText) {
    const tags = parseTags(promptText);
    if (tags.length < 2) return null;
    try {
      const resp = await fetch("/api/suggest-tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch { return null; }
  }

  // Relative time helper
  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  return { parseTags, parseTagSections, diffTags, recordChange, getHistory, getLastChange, getDiscoveries, fetchSuggestions, timeAgo };
})();
