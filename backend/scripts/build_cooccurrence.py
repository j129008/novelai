"""Build (or verify) the curated tag co-occurrence database.

The co-occurrence data in backend/data/tag_cooccurrence.json is a static,
domain-curated file.  We do not have access to raw Danbooru post data, so
scores are derived from known tag co-occurrence patterns in anime/illustration
prompts rather than computed from a corpus.

Running this script validates the existing JSON and prints a summary.
To extend the database, edit the "cooccurrence" and "metadata" sections in
tag_cooccurrence.json directly, then re-run this script to verify consistency.

Usage:
    python backend/scripts/build_cooccurrence.py
"""

import json
import sys
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
COOC_FILE = DATA_DIR / "tag_cooccurrence.json"


def validate(data: dict) -> list[str]:
    errors: list[str] = []

    cooc = data.get("cooccurrence", {})
    meta = data.get("metadata", {})

    if not cooc:
        errors.append("cooccurrence section is empty")
    if not meta:
        errors.append("metadata section is empty")

    valid_categories = {"subject", "scene", "style", "lighting", "composition", "mood", "character"}

    for tag, relations in cooc.items():
        if not isinstance(relations, dict):
            errors.append(f"cooccurrence[{tag!r}] must be a dict")
            continue
        for related, score in relations.items():
            if not isinstance(score, (int, float)):
                errors.append(f"cooccurrence[{tag!r}][{related!r}] score must be numeric, got {type(score)}")
            elif not (0.0 <= score <= 1.0):
                errors.append(f"cooccurrence[{tag!r}][{related!r}] score {score} out of [0, 1] range")

    for tag, info in meta.items():
        if "category" not in info:
            errors.append(f"metadata[{tag!r}] missing 'category'")
        elif info["category"] not in valid_categories:
            errors.append(
                f"metadata[{tag!r}] unknown category {info['category']!r}; "
                f"valid: {sorted(valid_categories)}"
            )
        if "count" not in info:
            errors.append(f"metadata[{tag!r}] missing 'count'")
        elif not isinstance(info["count"], int) or info["count"] < 0:
            errors.append(f"metadata[{tag!r}] count must be a non-negative int")

    # Warn about cooccurrence entries that lack metadata (not an error, just a gap)
    missing_meta = set(cooc) - set(meta)
    if missing_meta:
        print(f"Warning: {len(missing_meta)} tags in cooccurrence lack metadata entries:")
        for t in sorted(missing_meta)[:10]:
            print(f"  {t}")
        if len(missing_meta) > 10:
            print(f"  ... and {len(missing_meta) - 10} more")

    return errors


def main() -> None:
    if not COOC_FILE.exists():
        print(f"ERROR: {COOC_FILE} not found", file=sys.stderr)
        sys.exit(1)

    data = json.loads(COOC_FILE.read_text())
    errors = validate(data)

    cooc = data.get("cooccurrence", {})
    meta = data.get("metadata", {})

    print(f"Co-occurrence database: {COOC_FILE}")
    print(f"  Tags with co-occurrence data : {len(cooc)}")
    print(f"  Tags with metadata           : {len(meta)}")
    total_relations = sum(len(v) for v in cooc.values())
    print(f"  Total relation entries       : {total_relations}")
    avg = total_relations / len(cooc) if cooc else 0
    print(f"  Avg relations per tag        : {avg:.1f}")

    from collections import Counter
    cat_counts = Counter(info["category"] for info in meta.values())
    print("  Category breakdown:")
    for cat, count in sorted(cat_counts.items()):
        print(f"    {cat:<14} {count}")

    if errors:
        print(f"\n{len(errors)} validation error(s):", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        sys.exit(1)
    else:
        print("\nAll checks passed.")


if __name__ == "__main__":
    main()
