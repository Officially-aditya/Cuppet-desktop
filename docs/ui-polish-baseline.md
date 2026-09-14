# Cuppet UI polish baseline

This document is the Phase 0 working baseline for `feat/ui-polish-system`.

The goal of this milestone is visual hierarchy, interaction quality, motion and consistency only. Runtime behavior, panel ownership, TST behavior, terminal behavior, provider architecture and navigation semantics stay unchanged.

## Renderer style stack

The renderer currently loads styling in this order:

1. `styles.css`
2. `theme.css` — canonical semantic token layer introduced by this branch
3. `commands.css`
4. `navigation.css`
5. `settings.css`
6. `execution.css`
7. `react.css`
8. `usage.css`
9. `composer-refinements.css`
10. `message-controls.css`
11. `sidebar-icons.css`
12. `sidebar-row-hover.css`
13. `controls.css`
14. `composer-mode.css`
15. `provider-model-settings.css`
16. `general-settings.css`
17. `permission-inline.css`
18. `workspace-enhancements.css`
19. `tst-memory-sidebar.css`
20. `project-terminal.css`
21. `shell-panel-controls.css`

The main risk is not any single file. It is the accumulation of late overrides. `styles.css` still defines broad component defaults, while later files such as `react.css`, `controls.css`, `navigation.css` and `composer-refinements.css` specialize the same surfaces.

## Current duplication hotspots

### Canvas and surfaces

Repeated surface values cluster around a small set of near-identical dark tones:

- canvas: `#0d0f12`
- sidebar: `#0a0c0f`
- base panel: `#111419`
- popover/control panel: `#11161c`
- raised panel: `#171b21`
- selected rows: `#1a1f26`
- hover rows: `#1b2027` / `#20262e`
- input surface: `#0c1014`
- code surface: `#0b0e12`

These should become semantic tokens before component-by-component polish.

### Text

Common text values are currently repeated as raw colors across renderer files. The first token pass defines primary, secondary, tertiary and disabled roles without changing current values. Individual selectors should migrate to those roles progressively rather than inventing new grays.

### Borders

Borders currently use many nearby values including `#252a32`, `#282e37`, `#2b313a`, `#303741`, `#343b46`, `#3a424e` and stronger active-state borders. This is a major source of the current “collection of boxes” feeling. The token layer starts with subtle/default/strong border roles; shell and component passes should deliberately reduce how many borders remain visible.

### Radii

The renderer currently uses many radii from roughly 5px through 15px plus pill radii. The canonical system for new work is:

- `--radius-xs: 5px`
- `--radius-sm: 8px`
- `--radius-md: 12px`
- `--radius-lg: 16px`
- `--radius-pill: 999px`

Existing selectors are intentionally not rewritten all at once because that would create a visual redesign inside the foundation commit.

### Shadows

Popover/dialog elevation repeats several variants of dark shadows. The foundation exposes three roles: popover, dialog and floating. Later menu/dialog work should converge on those instead of introducing more one-off shadows.

### Spacing

The current renderer mixes many spacing values. New work should use the 4px rhythm in `theme.css`. Existing component geometry remains untouched until its dedicated polish phase.

### Typography

Current UI text ranges from tiny 9–10px metadata through 24px display text. The foundation exposes a deliberately small type scale and shared UI/monospace families. Later typography work should prefer weight, opacity and spacing over adding more font sizes.

### Motion

A useful pattern already exists: many hover/focus transitions are around 120ms. Structural movement is not yet standardized. The foundation therefore defines:

- micro interactions: 120ms
- menus/popovers: 180ms
- structural movement: 280ms
- standard easing
- geometry easing: `cubic-bezier(.32,.72,0,1)`

Existing animations are left untouched in this commit. A later motion pass should remove `transition: all`, converge geometry transitions and verify reduced-motion behavior.

## Specific override risks to address next

- `styles.css` owns the legacy global palette and broad component defaults.
- `react.css` later redefines dense sidebar geometry, markdown surfaces and several interactive controls.
- `controls.css` creates a second control language for inputs, selects, checkboxes and model picker surfaces.
- `execution.css` and `react.css` both style rendered markdown/code/table surfaces.
- `navigation.css`, `controls.css` and `composer-refinements.css` each define menu/dialog-like surfaces with slightly different borders, backgrounds, radii and shadows.

This is why the branch starts with tokens rather than component tweaks.

## Visual baseline checklist

Capture these states before the first component-polish commit and keep them for regression comparison:

- empty project
- populated conversation
- streaming response
- expanded reasoning/tool trace
- sidebar hover and active states
- collapsed sidebar
- composer resting and focused
- composer multiline/attachment state
- model picker
- command palette
- terminal open and closed
- TST open, selected node and hidden
- settings
- permission prompt
- search modal

## Migration rule

For each subsequent UI-polish commit:

1. Replace raw values with existing semantic tokens before adding a new token.
2. Preserve DOM ownership and behavior unless a visual change cannot be achieved otherwise.
3. Prefer tonal surface separation over adding borders.
4. Keep hover controls hidden until relevant.
5. Do not mix feature work into this branch.
6. Run `renderer:verify` after each coherent styling slice, then the wider Cuppet validation path before merge.

## Next concrete slice

Proceed to the application shell: sidebar, main canvas, TST/right region and terminal boundary. Migrate their surface, border, radius and motion values onto `theme.css`, then remove superseded raw values only after the computed appearance is verified.
