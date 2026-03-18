# QA Tester (James Whittaker) — Learnings

Patterns of bugs found, missed edge cases, and testing blind spots.
Read this file before starting any QA session.

## Rules

<!-- Entries are added automatically by retro. Format:
- [YYYY-MM-DD] <rule> (source: <reviewer>) -->
- [2026-03-18] When testing documentation, always cross-check requirements.txt comment text against actual listed packages — comments can claim a package is listed when it isn't. (source: James Whittaker)
- [2026-03-18] When testing documentation prose that counts items ("Two ways"), verify the count matches the actual bullet points that follow. (source: James Whittaker)
- [2026-03-18] When docs use shell examples (base64, curl flags), verify portability across macOS vs Linux — macOS-specific flags like `base64 -i` are not portable. (source: James Whittaker)
- [2026-03-18] Always check every endpoint in the API reference has an "Error Conditions" section if it can 500 on non-primary platforms; compare against sibling endpoints for consistency. (source: James Whittaker)
- [2026-03-18] When testing dynamically-created UI slots (character cards, list items), verify that index variables captured in closures at creation time are still valid after items are removed or reordered. Stale idx bugs cause wrong labels and potentially wrong data targets. (source: James Whittaker)
- [2026-03-18] When testing multi-value input fields, run the exact string transformation chain from the code against the placeholder example text — the placeholder may promise comma-separated input that the code does not actually support. (source: James Whittaker)
