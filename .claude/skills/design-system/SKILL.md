---
name: design-system
description: Design system reference for this project — color tokens, typography, spacing, component patterns, and interaction conventions. Use when building or reviewing UI.
user-invocable: false
---

# Design System Reference

## Color Tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-deep` | `#080810` | Deepest background (inputs, code) |
| `--bg-base` | `#0d0d18` | Page background |
| `--bg-raised` | `#12121f` | Cards, sidebar, header |
| `--bg-float` | `#18182a` | Floating elements, accordions |
| `--bg-overlay` | `#1e1e32` | Hover states, overlays |
| `--accent` | `#7c5cfc` | Primary action (buttons, focus rings) |
| `--accent-bright` | `#9b7cff` | Highlights, active states |
| `--accent-dim` | `rgba(124,92,252,0.18)` | Subtle accent backgrounds |
| `--accent-glow` | `rgba(124,92,252,0.35)` | Box shadows, glows |
| `--danger` | `#f05050` | Destructive actions |
| `--danger-bg` | `rgba(240,80,80,0.10)` | Danger background tint |
| `--danger-border` | `rgba(240,80,80,0.30)` | Danger border |
| `--text-primary` | `#f0f0f8` | Body text |
| `--text-secondary` | `#9090b0` | Labels, descriptions |
| `--text-tertiary` | `#60607a` | Hints, placeholders |
| `--border-subtle` | `rgba(255,255,255,0.06)` | Lightest border |
| `--border-muted` | `rgba(255,255,255,0.10)` | Default border |
| `--border-strong` | `rgba(255,255,255,0.16)` | Emphasized border |

## Radius

- `--radius-sm: 6px` — buttons, inputs, small elements
- `--radius-md: 10px` — cards, accordions, prompt box
- `--radius-lg: 14px` — panels, modals
- `--radius-xl: 18px` — output area, large containers

## Typography

- System font: `-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif`
- Monospace: `"SF Mono", "Fira Code", "Cascadia Code", monospace`
- Base size: `14px`, antialiased
- Labels: `0.78rem`, uppercase, `letter-spacing: 0.07em`, `font-weight: 600`
- Body: `0.85rem`
- Small: `0.72rem`–`0.75rem` (hints, badges, endpoints)

## Layout

- Header: `52px` height, border-bottom
- Sidebar: `340px` fixed left, `overflow-y: auto`, sticky at `calc(100vh - 52px)`
- Canvas: fluid right panel
- Spacing: `6px`, `8px`, `12px`, `14px`, `20px`, `28px`
- Breakpoints: `860px` (tablet), `480px` (mobile)

## Component Patterns

### Buttons
- `.btn-action` — ghost button (bg-overlay, border-muted)
- `.btn-action--primary` — accent-tinted ghost (accent-dim bg, accent border)
- `.btn-action--confirm` — solid accent (used in modals)
- `.btn-action--danger` — danger-tinted ghost
- `.btn-action--iterate` — same as primary, used for iteration actions
- `.btn-generate` — gradient accent (`linear-gradient(135deg, var(--accent), #a060f8)`), glow shadow

### Inputs
- Background: `--bg-deep`
- Border: `1px solid var(--border-muted)`
- Focus: `border-color: var(--accent)` + `box-shadow: 0 0 0 3px var(--accent-dim)`
- Radius: `--radius-sm`

### Sliders
- Header row: label (left) + value badge (right, `--accent-bright`)
- Range input: `4px` track height, `16px` thumb with glow
- Endpoint labels: `0.72rem`, `--text-tertiary`, flex space-between

### Accordions
- `<details class="accordion">` with `<summary class="accordion-header">`
- Chevron SVG rotates 180deg on open
- Body: `padding: 14px`, `gap: 12px`
- Open state: header gets `border-bottom` + `--text-primary` color

### Overlays / Modals
- Full-screen: `position: fixed; inset: 0; z-index: 200`
- Backdrop: `rgba(4,4,10,0.92)` + `backdrop-filter: blur(8px)`
- Shell: `--bg-raised`, `--radius-xl`, max-width `860px`
- Structure: header (border-bottom) / body (flex) / footer (border-top)

### Tabs
- Pill-style inside bordered container (`--bg-raised`, `--radius-md`)
- Active: `--bg-overlay` background, `--text-primary` color
- Badge: small rounded pill (`--accent-dim` bg, `--accent-bright` text)

### Badges / Pills
- Uppercase, `0.68rem`–`0.72rem`, `font-weight: 700`
- Rounded: `border-radius: 10px`
- Accent: `--accent-dim` bg + `rgba(124,92,252,0.4)` border + `--accent-bright` text

## Interaction Conventions

- Hover transitions: `0.15s` default
- Button hover: subtle background/border shift
- Active press: `translateY(0)` (cancels hover lift)
- Generate button hover: `translateY(-2px)` + expanded glow
- Easing: `var(--ease-out)` = `cubic-bezier(0.16,1,0.3,1)` for spring-like motion
- Focus rings: `3px` accent-dim, never outline-based
- Loading: spinner replaces button content, `0.55s linear` rotation
- Entry animations: `opacity 0 → 1` + `scale(0.96) → 1` + `translateY(12px) → 0`
