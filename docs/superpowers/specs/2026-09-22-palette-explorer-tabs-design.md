# Palette explorer and per-group tabs

Date: 2026-09-22. Status: design, awaiting review.

## Goal

Make the palette UI work the way the rest of the Theia shell does. Today it is
one right-sidebar widget with its own nav column and an inspector pinned on
top, so none of it can be docked, split or tabbed. After this change:

- Palettes has an entry in the left activity bar, beside Maps and
  Graphics.
- Each item in its tree opens an ordinary main-area tab that the user can drag,
  split and dock like any other.
- Detected palette animation is shown and its frame colors are editable.

Out of scope: editing animation timing or frame count (a code patch, see
"Animation timing" below), the overworld palette context, Lunar Magic custom
palettes, and the GFX view's palette-row picker.

Builds on PR #454 (merged: group order, "Level Sprite Colors" rename, column 0 fix,
labels without the row suffix).

## Decisions

| Question | Decision |
|---|---|
| What a tree item opens | Group row opens a tab of all its variants; variant row opens a tab of that one variant. Single-variant groups are leaves. |
| Preview vs pinned tabs | Same as Graphics: single click opens the italic preview tab via `PreviewTabs.preview`, double click pins via `PreviewTabs.pin`. |
| Where the inspector lives | Inside each tab, as a right-hand column beside the grid; wraps below the grid when the tab is docked narrow. |
| Reuse | One view widget class for group and variant tabs, plus three shared React components (swatch row, inspector, frame strip). |
| Look | Today's swatch and hatch styling carries over unchanged. |
| Animation in the grid | Static. An animated swatch carries a corner marker; the inspector preview plays it. |
| Animation timing | Read-only facts in the inspector, never editable here. |
| Project switch | Palette tabs close; the explorer reloads. |

## Components

All under `theia/extension/src/browser/` unless noted.

### `PaletteExplorerWidget` (left area, rank 300, after Graphics)

A tree:

```
Player Palettes            ▸ Mario, Luigi, Fire Mario, Fire Luigi
Shared Sprite Colors         (leaf)
Level Sprite Colors        ▸ Variant 0-7
Layer 1 Foreground         ▸ Variant 0-7
Layer 2 Background         ▸ Variant 0-7
Back Area Colors             (leaf)
```

Group order and labels come from `RomPalettesDto.groups` as served; the widget
does not reorder. Above the tree: the ROM name, the custom-palette-levels
warning, and, when the level animation context is unavailable, the detector's
reason. Below it: the overworld not-yet-shown note, moved from today's nav.

Emits `onOpen({ manifestPath, groupId, variant?: number, pinned: boolean })`.
Built on Theia's `TreeWidget` so keyboard navigation, expansion state and
selection styling are the shell's own.

### `PaletteExplorerContribution`

`AbstractViewContribution` with `area: 'left'` and toggle command
`hackbench.palettes.focus` (the existing id, so keybindings and the View menu
entry survive). Wires `onOpen` to `PreviewTabs` exactly as
`GfxExplorerContribution` does, including wiring explorers restored from a
saved layout before `onStart`.

### `PaletteGroupViewWidget` (main area)

One class for both tab kinds, created by a `WidgetFactory` keyed
`{ manifestPath, groupId, variant? }`. Title is the group label, or
`<group label> · <variant label>`. Layout: header (label, variant/row count,
description), grid of `PaletteSwatchRow`s, and a `PaletteInspector` column.

Owns: its fetch, a `requestToken` stale-response guard, the current selection,
and the call to `PaletteService.setColor`. Re-fetches on
`PaletteServiceClient.onWorkingCopyChanged` for its manifest. Closes itself
when `ProjectContext` switches to another project.

### `PaletteSwatchRow` (shared React component)

Props: `cells: PaletteCellDto[]`, `gutter?: string`, `selectedIndex?: number`,
`highlighted?: Set<number>`, `previewOverride?: { index, cssColor }`,
`marker?: Set<number>`, `onSelect?: (index) => void`.

Draws `cells.length` swatches, never a fixed 16: Back Area Colors is 8 with no
gutter. Written cells are filled; unwritten cells are hatched with no color
and no BGR555 in the tooltip. Indices are positions in the row, not CGRAM
indices. Knows nothing about palettes beyond the DTO.

### `PaletteInspector` (shared React component)

Props: the selected cell (or none), its animation (or none), `onCommit(romAddr,
oldHex, newHex)`, and an error string. Owns only pick, hex-draft and
local-error state. Layout, top to bottom:

1. Title: where the cell sits (`CGRAM $64 · Shared Sprite Colors`, or
   `Back Area Colors · 3`).
2. Preview: a large swatch. For an animated cell it plays the frames.
3. Frame strip (animated cells only): `PaletteFrameStrip`, directly under the
   preview.
4. Details for the selected word: table, ROM address, BGR555, RGB, hex field,
   color picker, OK, Cancel. Escape cancels.
5. Notes: for an animated cell, its timing facts and the stock value the
   animation overwrites (itself a selectable one-cell `PaletteSwatchRow`).

Stale and io-error results render inline here without hiding the grid.

### `PaletteFrameStrip` (shared React component)

A `PaletteSwatchRow` per 8 frames, wrapping to further rows past 8, so it never
grows wider than the preview column. Labels each cell with its frame number.
While the preview plays, the current frame is highlighted. Clicking a frame
pauses on it and selects that frame's word for editing. Every frame sharing
the selected frame's `romAddr` is highlighted together, since a non-contiguous
phase mask repeats table entries.

### Removed

`PaletteViewWidget`, `PaletteViewContribution` and the nav CSS in
`style/palette.css`.

## Wire change

`RomPalettesDto` gains:

```ts
animation: {
  available: boolean
  notes: string[]              // detector's own notes; the reason when unavailable
  targets: {
    cgramIdx: number
    frameStride: number        // counter ticks per frame
    intervalMs: number
    sharedWithOtherTargets: boolean
    timing: { maskAddr: number; mask: number; shift: number; counter: string }
    frames: { color: PaletteColorDto; romAddr: number }[]
  }[]
}
```

Level context only. Built in the node layer from `detectPaletteAnimation(rom)
.level`. Each frame's `romAddr` is the target's `tableAddr` plus the kernel's
`phaseOffsets[i]` (`decodeFlashKernel(rom, target.kernelAddr)`); the frontend
never computes an address. `sharedWithOtherTargets` is true when any other
target, in either context, reads the same table. When the context is
unavailable, `targets` is empty and `notes` says why. There is never a vanilla
fallback (CLAUDE.md, "Never fall back to the vanilla value").

Frame edits use the existing `setColor(manifestPath, romAddr, oldHex, newHex)`;
no new service method.

## Animation timing (read-only)

Speed and frame count live in code, not data: the vanilla kernel is
`LDA EffFrame / AND #$1C / LSR A` (SMWDisX `bank_00.asm:4668-4670`), giving 8
frames that change every 4 frames. The mask and the `LSR` count set count and
speed together, and the kernel is shared with the overworld flash. The
inspector shows these as facts with their source, for example "8 frames, every
4 frames (~67 ms): `AND #$1C` + 1 `LSR` at `$00A423`". Editing them is a
separate code-patching feature, logged as a follow-up issue.

## Playback

The preview uses the shared frame clock (`src/webview/shared/frameClock.ts`),
advancing one frame per `frameStride` ticks, rather than a `setInterval` on
`intervalMs`, so it keeps the cadence the ROM encodes and stops while the tab
is hidden. The grid never animates.

## Testing

Synthetic fixtures unless marked; CI has no ROM.

Unit (vitest):
- The animation DTO builder against a planted flash kernel: targets, frame
  `romAddr`s, `sharedWithOtherTargets`. With the kernel's opcode broken:
  `available: false`, notes present, no targets. Proven red by removing the
  gate.
- `PaletteSwatchRow`: 8 and 16 cells, with and without a gutter, unwritten
  cells carry no color or BGR555.
- `PaletteFrameStrip`: wraps at 9 and 17 frames; repeated-address highlight.

Playwright (`theia/browser-app/test/`), asserting behaviour, not presence:
- The Palettes icon is in the left activity bar; clicking it reveals the tree.
- Single click on a group opens an italic preview tab; double click pins it;
  a variant row opens a tab with exactly one variant.
- A group tab dragged into a split keeps rendering and accepting edits.
- An edit in a variant tab updates the same cell in an open group tab.
- Animated cell: the preview's rendered color changes over time, with no
  frozen span; the frame strip is directly under the preview; editing a frame
  writes an op file.
- A ROM with an unreadable animation handler (synthetic, as in today's
  too-short-ROM test): explorer shows the reason, no swatch has a marker.
- Switching projects closes palette tabs.
- Carried over from `palette-view.spec.cjs`: column 0 hatched, Back Area 8
  cells at the same swatch size, no clipped labels, stale refusal inline, the
  stale-response guard, empty state with no project, codicon defined.

## Size budget

Roughly 900-1,100 changed lines including tests: explorer ~200, view widget
~250, shared components ~300, DTO and server ~80, tests the rest. Deletes the
669-line `palette-view-widget.tsx`. Stop and ask if it heads past 1,300.

## Follow-ups (not in this change)

- Editing animation timing and frame count (code patch).
- Overworld palette context.
- GFX view palette-row picker using `PaletteSwatchRow`.
- Map16 panel (`feature/map16-view`) adopting the preview / frame strip /
  details pieces.
