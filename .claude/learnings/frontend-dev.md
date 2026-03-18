# Frontend Dev (Lea Verou) — Learnings

Rules and patterns learned from code reviews, QA feedback, and PM feedback.
Read this file before starting any implementation task.

## Rules

<!-- Entries are added automatically by reviewers and retro. Format:
- [YYYY-MM-DD] <rule> (source: <reviewer>) -->
- [2026-03-18] Do not expose internal functions via window.* unless there is a concrete external caller. Dead global assignments are code smell. (source: Linus Torvalds)
- [2026-03-18] When adding a sticky footer to a scrollable container, use flex column layout (parent flex-direction:column, scroll area flex:1 overflow-y:auto, footer flex-shrink:0) — not position:sticky which can fail in nested scroll contexts. (source: Linus Torvalds, confirmed by PM)
- [2026-03-18] Accordion empty states must never be visually empty. When content is dynamically added (e.g. character slots), provide a visible empty state card with a clear call-to-action so users know the feature is working and what to do next. A blank accordion body = perceived broken feature. (source: Steve Jobs)
- [2026-03-18] Abstract grid pickers (e.g. position selectors) require axis context. Never render a bare NxN grid without labels, directional cues, or a shaped border that maps to the underlying coordinate space. Without context, users click randomly and blame the output. (source: Steve Jobs)
- [2026-03-18] Do not place dynamic UI chips/hints outside the accordion that triggered them. If a chip (e.g. "Add 2girls to prompt") only appears when the Characters accordion is in use, it must live inside that accordion — not in the main sidebar flow where users won't see it. (source: Steve Jobs)
- [2026-03-18] Hoist loop-invariant constants above the loop. Do not recompute fixed values (e.g. Math.floor(ROWS/2)) inside nested loops where they execute N×M times. (source: Linus Torvalds)
- [2026-03-18] Never put overflow:hidden on a container that has position:absolute children expected to overflow it (e.g. autocomplete dropdowns, tooltips). overflow:hidden clips absolutely-positioned descendants that extend past the box edge. Use max-height on the specific element that needs capping, not the parent. (source: Linus Torvalds)
- [2026-03-18] When dynamically-created list items (character cards, slots) capture their own index at creation time, that index becomes stale after earlier items are removed. Either refresh all captured indices on remove, or derive the current index from DOM position at the time of use. (source: James Whittaker)
- [2026-03-18] Placeholder text for an input field must exactly match what the code accepts. If the transformation chain only supports a single tag per input, the placeholder must not show a comma-separated list — it misleads users into producing malformed data. (source: James Whittaker)
- [2026-03-18] Never interpolate server-sourced metadata (seed, steps, dimensions, filenames) directly into innerHTML. Even in local apps this is wrong. Use createElement+textContent or Number() conversion with type verification. (source: Linus Torvalds)
- [2026-03-18] Do not rely on a default value coincidence to signal "no preference" to the backend. If a user picks grid cell (center, center) which happens to be x=0.5,y=0.5 — the same as the auto default — the backend silently ignores their explicit choice. Use an explicit boolean flag or conditional payload key to distinguish "user chose center" from "auto". (source: Linus Torvalds)
- [2026-03-18] When reading a fetch() response, always use the exact key the server returns. data.tags when the server sends {"characters": [...]} silently returns undefined; use data.characters. Cross-check every data.* access against the backend route's response_model or return dict. (source: James Whittaker)
