---
name: ui-review
description: UI/UX review checklist and process for evaluating frontend changes. Use when reviewing new or modified UI components.
user-invocable: false
---

# UI/UX Review Process

## Before Reviewing

1. Read ALL changed frontend files (HTML, CSS, JS)
2. Load the `design-system` skill for token/pattern reference
3. Understand the feature's purpose — what user problem does it solve?

## Review Dimensions

### Visual Consistency
- Does it use existing CSS custom properties (`--bg-*`, `--text-*`, `--accent-*`, `--border-*`, `--radius-*`)?
- No hardcoded colors, font sizes, or border-radius values — always use tokens
- Does it follow established component patterns (`.btn-action`, `.accordion`, `.control-group`, etc.)?
- New components should feel like they belong in the same family

### Information Architecture
- Sidebar controls: is it in the right accordion / section?
- Is progressive disclosure used? (advanced options hidden by default)
- Label hierarchy: primary labels uppercase 0.78rem, hints in tertiary color
- Does the canvas area remain the visual focal point?

### Interaction Quality
- Focus states: accent border + 3px accent-dim ring (never browser default outline)
- Hover transitions: 0.15s, subtle background/border changes
- Loading states: clear feedback, disabled controls during async ops
- Keyboard: can this be operated without a mouse?
- Touch: minimum 32px hit targets on interactive elements

### Spacing & Rhythm
- Consistent with the spacing scale (6/8/12/14/20/28px)
- Accordion body: 14px padding, 12px gap between children
- Control groups: 7px gap (tight: 6px)
- Section dividers: 1px `--border-subtle`, 2px vertical margin

### Typography
- No new font families — use system stack or mono stack
- Label pattern: `.field-label` (0.78rem, uppercase, 600 weight, 0.07em tracking)
- Value displays: `.slider-value` (0.82rem, accent-bright, tabular-nums)
- Hints: 0.72–0.75rem, `--text-tertiary`

### Responsive
- Check 860px breakpoint (sidebar collapses to stack)
- Check 480px breakpoint (further simplification)
- No horizontal overflow at any width
- Touch-friendly spacing on mobile

### Dark Theme Integrity
- Text contrast: primary (#f0f0f8) on base (#0d0d18) = good
- Never use pure white (#fff) for backgrounds or large text areas
- Borders should be subtle — `rgba(255,255,255, 0.06–0.16)` range
- Accent color should pop but not overwhelm

## Common Mistakes to Flag

- Introducing a new color not in the token system
- Using `px` for font sizes instead of `rem`
- Missing focus/hover states on interactive elements
- Hardcoded widths that break responsive layout
- Z-index conflicts (modals: 200, dropdowns: 50, guide overlay: 100)
- Adding `!important` without good reason
- Not using `var(--ease-out)` for animations

## Output Format

End review with:
- **APPROVED** — Ship it
- **NEEDS WORK** — List specific issues with file:line references
- **REJECTED** — Fundamental problems, explain why
