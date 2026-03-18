# Backend Dev (Guido van Rossum) — Learnings

Rules and patterns learned from code reviews, QA feedback, and production issues.
Read this file before starting any implementation task.

## Rules

<!-- Entries are added automatically by reviewers and retro. Format:
- [YYYY-MM-DD] <rule> (source: <reviewer>) -->
- [2026-03-18] Always ensure every runtime import used in code (e.g., Pillow/PIL) is explicitly listed in requirements.txt, not just mentioned in a comment. Do not list unused packages (e.g., scipy) with misleading comments. (source: James Whittaker)
- [2026-03-18] When adding a comment to requirements.txt that says "pin it here for reproducibility," verify the package is actually present in the file with a version pin. (source: James Whittaker)
- [2026-03-18] All packages in requirements.txt must use exact version pins (==). Floor constraints (>=) defeat reproducibility and are inconsistent with the rest of the file. (source: Linus Torvalds)
- [2026-03-18] subprocess.Popen calls that are macOS-only (e.g., "open" command) must be wrapped in try/except just like their sibling subprocess.run calls — silent crash-to-500 is not the same as explicit error handling. (source: Linus Torvalds)
- [2026-03-18] Never use mutable default arguments in function signatures (e.g., `def f(items: list = [])`). In async functions that process per-request data, use `None` with an `if x is None: x = []` guard or a `= field(default_factory=list)` Pydantic field. (source: Linus Torvalds)
- [2026-03-18] Pydantic schema fields that represent structured sub-objects must use a typed nested model with validation constraints, not `dict` or `list[dict]`. Accepting `list[dict]` with no field types means garbage passes schema validation and gets forwarded upstream. Define a proper model with `ge`/`le` bounds where applicable. (source: Linus Torvalds)
- [2026-03-18] Do not import symbols from other modules unless they are actually referenced by name in that file. Unused imports signal either dead code or misplaced logic. (source: Linus Torvalds)
