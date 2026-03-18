# Backend Dev (Guido van Rossum) — Learnings

Rules and patterns learned from code reviews, QA feedback, and production issues.
Read this file before starting any implementation task.

## Rules

<!-- Entries are added automatically by reviewers and retro. Format:
- [YYYY-MM-DD] <rule> (source: <reviewer>) -->
- [2026-03-18] Always ensure every runtime import used in code (e.g., Pillow/PIL) is explicitly listed in requirements.txt, not just mentioned in a comment. Do not list unused packages (e.g., scipy) with misleading comments. (source: James Whittaker)
- [2026-03-18] When adding a comment to requirements.txt that says "pin it here for reproducibility," verify the package is actually present in the file with a version pin. (source: James Whittaker)
