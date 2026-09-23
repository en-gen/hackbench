# Map16 tile editor design

Replaces the Map16 view's inspector, where a subtile's character is typed
in as a number. The owner's requirement: pick a GFX sheet like a painter's
palette and drag 8x8 characters onto the four quadrants of a large tile
editor.

Mockup: `docs/mockups/map16-tile-editor.html`. Interactive - drag from the
tray onto a quadrant. Its art is generated placeholder, not cartridge data,
and none of its JavaScript is a foundation.

Inherits `docs/ui-conventions.md`. Vocabulary is `docs/glossary.md`.

## Vocabulary

The community calls a 16x16 Map16 entry a **tile**, and the glossary agrees
(`glossary.md:137`, "Map16 tile `$5A`"). The current view calls it a
"block", which was invented here. Rename throughout.

A tile is four 8x8 **characters**, one per quadrant: TL, TR, BL, BR. Each
quadrant is one 16-bit word: bits 0-9 character, 10-12 color row, 13
priority, 14 flip X, 15 flip Y.

**Color row**, not "palette row". It is a CGRAM row of 16 colors. The 8x8
character stores pixel INDICES; the row decides what those indices mean.
"Palette" is already taken by the toolbar's palette-variant controls.

## The constraint that shapes everything

A quadrant can only say "character N". It cannot say "file X, tile Y".

The character space is VRAM, which the TILESET assembles from several GFX
files. Measured on vanilla, `readGfxAssignment` yields 13 distinct
assignments across the 15 tilesets:

| characters  | slot | source                          |
| ----------- | ---- | ------------------------------- |
| `$000-$07F` | fg1  | one GFX file, per tileset       |
| `$080-$0FF` | fg2  | one GFX file, per tileset       |
| `$100-$17F` | fg3  | one GFX file, VARIES by tileset |
| `$180-$1FF` | an1  | one GFX file, VARIES, animated  |
| `$200-$3FF` | -    | tilemap space, not characters   |

So a tray offering all 50 GFX files would let the user drag a character
that is not loaded for this tileset. The drop would look right and render
as whatever actually sits at that VRAM address. That is the
confidently-wrong failure this project's rules exist to prevent.

**The tray therefore shows the four sheets this tileset has loaded**,
labelled by slot AND file (`fg3 - GFX25`). Switching tileset swaps the tray,
which is exactly what it does in the game. Wanting a character from an
unloaded file is a request to change the tileset's GFX assignment: a
different and larger operation, out of scope here.

## Pages

Lunar Magic presents Map16 as pages, each a 16x16 grid of tiles, with a
page-number field that spans `00-FF`. That field's RANGE is not what is
allocated: LM v1.70's expansion provides 2048 tiles, eight pages, which at
8 bytes each is 16,384 bytes. The data is small. What is expensive is
everything around it.

Vanilla holds 512 tiles: two pages. Measured extents on the vanilla cart,
one machine:

- FG tables span `$68000..$6E88F`, 9,856 distinct bytes touched across all
  15 tilesets, from 5 distinct per-tileset bases (`$D8B70`, `$DBC00`,
  `$DC800`, `$DD400`, `$DE300`) interleaved with the shared `Map16Common`
  run at `$0D8000` by the bitmap at `$0581BB`. The FG table is not
  contiguous.
- The BG table is a flat 4,096 bytes at `$69100..$6A100`.

**Adding pages is not a data operation.** The runtime `Map16Pointers` array
is 512 entries (`bank_05.asm:225-238`, X iterating `0..0x3FF` by 2), so 512
is the size of the structure the ENGINE indexes. Exceeding it means
patching the routine that reads it, which is what LM's expansion patch
does, plus ROM expansion for the data to live in.

**Out of scope for this editor.** Tracked as en-gen/hackbench#102, which
depends on en-gen/hackbench#446. When the user asks for a page, say what it
needs rather than offering a control that cannot work.

**In scope:** read and present whatever tiles a cart HAS, rather than
assuming 512. `src/rom/Map16.ts` hardcodes 512 in nine places, so a cart
carrying the expansion would silently show its first two pages as though
that were the whole table. That is the same failure shape as the view
originally showing only the FG table. Read the real count or refuse with a
reason; never truncate quietly.

## Layout

Two widgets, not one widget with a mode switch.

`getOrCreateWidget(MAP16_VIEW_ID, { layer: 'fg' })` and `{ layer: 'bg' }`.
Theia keys widgets by factory id plus options, so this yields two
independent widgets with tabbing, dragging to a split, and per-tab zoom and
selection, all from the shell. The current factory takes no options, which
is why only one has ever existed.

The GFX explorer lists both: **Map16 Foreground** (per-tileset object and
terrain table) and **Map16 Background** (the one global Layer 2 preset
table). One row called "Map16" showing only FG is how the BG table went
unnoticed until the owner compared against Lunar Magic.

The `Table` dropdown leaves the toolbar; the tab IS the table. The tileset
dropdown stays on BOTH tabs: the BG table is global, but 1310 of 2048 of its
subtiles (64.0%, measured) sit in the tileset-varying `fg3`/`an1` slots, so
the tileset still decides how it looks. The label says "Tileset (graphics
only)" there.

Within a tab:

- **Tile editor**, dominant. The 2x2 quadrants at 16x zoom.
- **GFX tray**, right. Slot tabs, then that sheet's characters.
- **Tile browser**, a collapsible strip along the bottom, for choosing
  which tile to edit.

## Interaction

**Select a quadrant** by clicking it. The selected quadrant's character
number, source slot and file, flips, priority and color row are shown
beside the editor.

**Assign a character** by dragging one from the tray onto a quadrant. The
drop sets the character only; it does not change the color row. Taking the
source's row would silently change two fields from one gesture, and the
tray's preview colors come from the currently selected row rather than from
the character itself.

**Change the color row** from a list of rows rendered as real swatch
strips, using the CGRAM the sheet was composited with, not the ROM tables it
came from. Only rows the sheet's subtiles actually cite are offered.

**Flips and priority** are per-quadrant toggles.

The character number stays visible as read-only text beside the picker.
Recognition comes from the picture, verification from the number.

## Decisions taken

**Drop targets are quadrants only.** Dropping onto the browser strip to
replace all four at once is a bulk operation whose undo story is different;
not in v1.

**The `an1` tray slot is frozen at animation frame 0** and marked as
animated. A drag target that changes four times a second is not a drag
target. The tile editor still animates when playback is on.

**Only reachable characters are offered.** A subtile's color row field is 3
bits, so rows 8-15 are unreachable and sprite slots `$400+` cannot be
referenced at all. A 3bpp sheet produces only indices 0-7. Offering
unreachable choices invites edits that render wrong.

## Testing

Assertions are on behaviour. Presence checks pass for a blank editor.

- Dragging a character from the tray onto a quadrant changes that
  quadrant's rendered pixels, and the committed subtile word's character
  field, and nothing else in the word.
- The tray shows exactly four sheets, and their labels name the files
  `readGfxAssignment` reports for the selected tileset. Switching tileset
  changes both the labels and the rendered characters.
- Selecting a different color row changes the rendered colors of the tile
  and leaves every character number unchanged.
- The Foreground and Background tabs are separate widgets: selecting a tile
  in one does not change the other's selection, and both can be open at
  once.
- A cart whose Map16 exceeds 512 tiles is either presented in full or
  refused with a reason. It is never silently truncated to two pages.
- The `an1` tray does not change while playback is running.

Each refusal gets a planted-defect proof. CI has no cartridge, so every
gate needs a synthetic fixture built in the test.

## Open questions

- **Where does an LM-expanded cart keep its extra tiles?** Nothing in the
  corpus exercises this: all 6 carts hold exactly 512 tiles. An LM v1.70+
  cart is needed before the page-count path can be written against
  anything real. See en-gen/hackbench#102.
- **Does the tray need its own zoom?** 32px per character is a comfortable
  drag target and fits 8 per row in a 300px tray. Unmeasured against a real
  8x8 sheet.
