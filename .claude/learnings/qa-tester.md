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
- [2026-03-18] When frontend reads a backend JSON response, always verify the exact key name matches — e.g., backend returns {"characters": [...]} but frontend reads data.tags will silently return undefined, not an error. Check every data.* access against the actual response shape. (source: James Whittaker)
- [2026-03-19] When a route handler performs pre-processing before the main try/except block (e.g., image compositing before calling an external API), test it with malformed input — exceptions thrown in the pre-processing step will produce a 500, not the expected 502. The pre-processing must be inside or wrapped by the same try/except. (source: James Whittaker)
- [2026-03-19] When testing "restore/load" UI flows, always test against the full dataset distribution — not just the happy-path case. If 92% of records lack a field, a restore function that unconditionally clears state before checking for that field will silently destroy user data on the majority of invocations. Always verify the clear is conditional on the presence of replacement data. (source: James Whittaker)
- [2026-03-19] When a function parses structured sub-data (e.g. interaction directives stripped from a prompt string) and stores it in a data object, verify the UI-building function that consumes that object also renders the pre-existing sub-data — not just provides a way to add new entries. Parsed data that is stored but never rendered is invisible to the user. (source: James Whittaker)
