# Tech Writer (Donald Knuth) — Learnings

Rules and patterns learned from reviews and feedback.
Read this file before starting any documentation task.

## Rules

<!-- Entries are added automatically by reviewers and retro. Format:
- [YYYY-MM-DD] <rule> (source: <reviewer>) -->
- [2026-03-18] When documenting requirements.txt, verify every package you mention is actually listed in the file — do not write comments about packages that are absent. (source: James Whittaker)
- [2026-03-18] Use exact version pins (==) consistent with the existing file style, never floor constraints (>=). (source: Linus Torvalds)
- [2026-03-18] When writing numbered lists in prose ("Two ways"), count the actual items before writing the number. (source: James Whittaker)
- [2026-03-18] Shell examples in docs must be portable or explicitly flagged per-platform (e.g., macOS vs Linux base64 syntax). (source: James Whittaker)
- [2026-03-18] When documenting parallel endpoints (e.g., browse and open-folder), ensure all sections (especially Error Conditions) are consistent across both. (source: James Whittaker)
