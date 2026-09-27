# UI conventions

Every rule here exists because someone got it wrong and had to be
corrected. Where a rule has a source, it is cited: the VS Code extension
in `src/webview/` is the reference implementation, and a convention it
already established wins over a fresh invention.

Vocabulary is NOT defined here. `docs/glossary.md` owns domain terms, and
UI copy uses them exactly as that file defines them.

## The rule above all the others

**A user must never have to LEARN ROM internals to do ordinary creative
work.**

Hex values, character numbers, tile ids, addresses and byte values may be
SHOWN. Advanced users benefit from seeing them, and a visible value is what
makes a rendering bug reportable. But nothing may REQUIRE typing or
understanding one to get work done.

The goal this serves, stated by the owner: make romhacking approachable.
The working belief is that the incumbent editor is hard enough to learn
that people push through only because it is the only option, and that we
can do better. Approachable is the product, not a nicety layered on top of
it.

The test to apply when a design exposes a raw value: **must the user
understand this to proceed, or do they merely benefit from seeing it?** The
first is a defect. The second is fine, and often good.

The worked example, because this rule came from a real correction. The
Map16 tile editor first asked the user to type a character number into a
hex field. The owner rejected it: "I don't like that interface, especially
having to just type in a char number." The replacement is picking a
rendered 8x8 character out of a palette. The number is still on screen,
read-only, beside the selection. Recognition comes from the picture;
verification comes from the number.

Note which half of that survived. The fix was not to hide the hex. It was
to stop requiring it.

## The reference implementation

`src/webview/mapEditor/main.ts` and `src/webview/overworldViewer/main.ts`
are the VS Code extension's editors. They are being replaced by the Theia
views, but their UI decisions were made with the owner and are settled.
Before designing a control, check whether the extension already has it.

Two examples of this going wrong: the Map16 toggle buttons were built with
a Theia background token nobody had checked, when `.iconBtn.on { color:
#5b9cf6 }` (`main.ts:1428`) was the established pattern; and the Map16
hover effect was nearly invented from scratch when `main.ts:2372` already
had it.

## Icons

Codicons, the same set the rest of the shell uses. One meaning per glyph.

| Glyph                  | Means                           |
| ---------------------- | ------------------------------- |
| `symbol-color`         | palettes                        |
| `file-media`           | a GFX file                      |
| `symbol-structure`     | a Map16 block table             |
| `table`                | toggle the tile grid            |
| `play` / `debug-stop`  | start / stop animation playback |
| `zoom-in` / `zoom-out` | step zoom                       |
| `debug-pause`          | pause, leaving state intact     |
| `refresh`              | discard and reload from source  |

**The glyph must agree with what the code does, and this has been got
wrong in both directions.** In the Map16 view playback stops and resets,
so `debug-stop` is right there and `primitive-square` or a pause glyph
would be wrong. In the emulator the same button called
`pauseMainLoop()`, kept the core booted and kept its frame count, so it
was a pause wearing a stop glyph: it promised a teardown that never
happened, and the owner noticed because the behaviour did not match the
label. Read what the handler calls before choosing the icon.

The same rule reaches the button's TEXT. "Start" is wrong for a control
that resumes an already-booted core; the emulator now says Start before
boot and Resume after.

`extensions` was used for GFX files and was wrong (#452). A glyph that
merely looks generic is worse than one that is clearly specific.

## Toolbars

Two rows when a view has both identity and controls:

- **Header** - what the thing IS. Title, dimensions, and any value that
  reports what actually produced the content. Never an in-progress picker
  value.
- **Controls** - labelled `<select>`s for data axes, then a right-aligned
  group of icon buttons for actions.

Rules learned the hard way:

- The icon group gets its own tight gap (2px). Setting that gap on the
  whole row ran the title straight into the summary.
- A row containing icon buttons uses `align-items: center`. The base
  toolbar aligns text baselines, which sits a 24px button too low next to
  the selects it shares a row with.
- Zoom is `[-] [value] [+]`, in that order. It is the near-universal
  convention and reads wrong any other way.

## Toggle buttons

A toggle must show its state without a hover or a tooltip. Following the
extension's convention, the pressed state is an ACCENT FOREGROUND on the
glyph, plus a tinted fill and an inset outline, because a recolored 24px
codicon on its own is easy to miss.

Watch specificity. `.btn:hover:not(:disabled)` outranks a single `.btn-on`
class, so without an explicit `-on:hover` rule the fill vanishes exactly
while the pointer is on the button: it looks UNSET at the one moment the
user is most likely to be looking at it.

Disabled means "provably cannot do anything here". Never disable a control
that still has an effect, and never leave one live that does not. When a
control is disabled, its tooltip says why.

## Emphasis must not move the layout

Never express emphasis with a property that changes an element's box.
Growing a canvas's border from 1px to 2px for a "current" state made the
element 2px wider and taller and shunted a whole strip sideways on every
animation tick. Use `box-shadow` or `outline`, which paint outside the
border box and take no layout space.

## Canvases and pixel art

- `image-rendering: pixelated`. Never smooth interpolation: this is pixel
  art, and a blurred edit cannot be judged.
- Draw at NATURAL resolution and scale with CSS. Zoom changes the CSS
  size, not the bitmap.
- Overlays (grid lines, selection outlines, hover dimming) are drawn on
  top at paint time and never baked into the decoded pixels. Toggling one
  is a repaint, not a reload, and the bytes an export would use stay
  exactly what the ROM says.
- A hidden tile (blank until a switch is on, e.g. vanilla `$027-$02A`) is
  drawn with its switched-on art in a soft screen door, in color, never
  blank: a checkerboard on the tile's own pixel grid, full strength where
  x + y is even and 25% (`HIDDEN_TILE_DIM_ALPHA`) where odd
  (`hiddenPixelStrength`, one rule for both surfaces, #643): in the
  inspector preview while its toggle is off, and in the Map16 sheet always,
  frame 0 held through animation (#574, #621). This is an editor deviation:
  the ROM shows nothing there. It is derived from the tile's `hidden`
  alternate, never a tile-id list, and a toggle in the inspector never
  changes the sheet. Unlike the overlays above, the sheet's copy is baked
  into a cached copy of each decoded phase while painting is prepared
  (`BrowsedSheetCache`), not stroked on top: that keeps it a pure function
  with a unit test, and the decoded phase other surfaces crop is untouched.
  The map tab draws hidden tiles by the same rule (`hiddenPixelStrength` in
  `src/rom/render/HiddenTiles.ts`, where the rule now lives, over the
  level's backdrop, parity from the pixel's place in its own 16x16 cell),
  and there it works both ways: a tile blank in the switch state shown but
  drawn in another (`ghostOf`) shows that other picture in the screen door,
  the switches-off one if drawn, else the first single switch's. So vanilla
  `$027-$02A` (blue) show with blue off, and `$094` (ON/OFF, tilesets 2, 6
  and 8) with ON/OFF on; the inspector preview follows it for its selected
  switches. The map tab draws each cell with the sheet's own renderer
  (`renderCell`), so the two cannot disagree.
- The map tab's switch-palace icons are per-ROM art (`src/rom/SwitchArt.ts`:
  the block most tilesets draw, in the ROM's stock palette and raw GFX), not
  the open map's own rendering: on a ROM with per-level palette overrides the
  icon can differ from the block on the map.

## Hover

The convention, from the extension's Map16 panel (`main.ts:2372`): dim
everything EXCEPT the thing under the pointer, at `rgba(0,0,0,0.55)`.

The hovered item itself must be left exactly as drawn - no tint, no
outline, no scale. The point is to make it legible while judging it, so
anything that alters it defeats the purpose. Prefer painting the dim
AROUND the item over restoring it afterwards, so its pixels are never
drawn over at all.

## Color tokens

Theia variables, with a literal fallback: `var(--theia-focusBorder,
#5b9cf6)`. Tokens in use: `--theia-focusBorder`, `--theia-icon-foreground`,
`--theia-editorWidget-border`, `--theia-descriptionForeground`,
`--theia-toolbar-hoverBackground`, `--theia-inputOption-activeBackground`.

Do not assume a token exists because its name is plausible. Check it
renders before relying on it; an undefined variable silently falls back
and the control looks unstyled.

## Copy

- US spelling. **color**, never "colour".
- No em-dashes. A pre-commit hook blocks them in added lines.
- Say what the app actually does. "Save" is correct; "Save to ROM"
  is not, because saving appends an op layer and the base ROM is
  never written. A wrong verb here is an architecture error before it is
  a copy error.
- State a limit rather than hiding it. When a view cannot show something,
  say so in place instead of rendering a plausible substitute.
