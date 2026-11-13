Proposed 2026-11-13 (#1296)

# The map's end line and the "Add screen" outline (#1296)

## Question

D194 (owner, option D) chose a thick amber end line with a dark edge plus a dashed "Add screen" outline, and that the line must not shift for a sprite past the end. Which details do we build where the ruling is silent? [PROP]

## Options considered

1. Draw the line at the content's end or the canvas end: moves with a sprite band, refused by D194.
2. Fix it to the map's far edge (screen count x screen size), centered, constant in screen px. [PROP]

## Ruling

Proposed, not ruled:

- The amber line `#ffc23d` is a fixed color, not a theme token, so it differs from the selection and warning colors in every theme; the 5 px dark edge (black, opacity 0.75) carries it on light back colors. [PROP]
- Width is constant in screen pixels at every zoom; position follows the edge exactly. [PROP]
- The "Add screen" outline fills the gutter where the layout puts it, after any off-map content band, not directly after the line. [PROP]
- Its tooltip reads "Add screen is not available yet". [PROP]
- On a 32-screen map (no gutter) the line is drawn inset, its outer side on the map edge, so all 5 px sit inside the strip rather than overflowing it. [PROP]
- The grid canvas, which stands above the whole scroller, still draws its 1 px screen line over the end line. [PROP]

## Why

- The line marks the map's data end, so it follows `farEdge`, never `offMapPad`'s far side. [EST: D194 and the #1325 ruling, `2026-11-07-art-past-map-edge-grows-no-canvas.md`]
- Nothing is clickable yet, so the outline must not look or act like a button. [EST: #1296 acceptance 5]

## Applies to

`farEdge` and `addScreenRect` in `theia/extension/src/browser/off-map-extent.ts`; `renderStrip` in `map-view-widget.tsx`; `.hb-map-end-line` and `.hb-map-add-screen` in `style/index.css`; replaces the 1 px `map-edge` outline of `2026-10-19-map-view-gutter-details.md`.
