# Map16 tile editor design

Replaces the Map16 view's inspector, where a subtile's character is typed
in as a number. The owner's requirement: pick a GFX sheet like a painter's
palette and put 8x8 characters into the four quadrants of a large tile
editor, by selecting a quadrant and clicking a character.

Mockup: `docs/mockups/map16-tile-editor.html`. It predates this rewrite and
still demonstrates the rejected drag gesture; read it for the shape of the
surfaces, not for the interaction. Its art is generated placeholder, not
cartridge data, and none of its JavaScript is a foundation.

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
| `$180-$1FF` | an1  | one GFX file, VARIES by tileset |
| `$200-$3FF` | -    | tilemap space, not characters   |

So a palette offering all 50 GFX files would let the user pick a character
that is not loaded for this tileset. The choice would look right and render
as whatever actually sits at that VRAM address. That is the
confidently-wrong failure this project's rules exist to prevent.

**The accordion therefore shows the four sheets this tileset has loaded**,
labelled by slot AND file (`fg3 - GFX25`). Switching tileset swaps them,
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

**The two layers are counted separately.** `readMap16TileCount` walks the
FOREGROUND fill loop. The background table comes from
`buildL2Map16PointerTable`, which takes no ROM and hardcodes 512, so the FG
loop's answer says nothing about it and gating BG on it would refuse or
truncate an ordinary Layer 2 edit on the wrong evidence. The owner's
ruling: decouple them. BG is presented at its own extent, and the view
states in place that the extent is not derived from the cartridge. Reading
it is post-MVP, en-gen/hackbench#102.

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

- **Tile preview**, dominant. The assembled 16x16 tile, large.
- **Edit pane**, below the preview, and only once the user asks for it.
- **Tile browser**, a collapsible strip along the bottom, for choosing
  which tile to look at.

## The rule this view exists to satisfy

**A user must never have to LEARN ROM internals to do ordinary creative
work.** Hex values, character numbers and addresses may be SHOWN, and
advanced users benefit from seeing them, but nothing may REQUIRE typing or
understanding one. The owner's goal is to make romhacking approachable, on
the belief that the incumbent editor is hard enough to learn that people
push through only because it is the only option.

This view's first design failed that rule: it asked the user to type a
character number into a hex field. Everything below follows from replacing
that with visual selection.

## Preview and edit are separate

The view opens in PREVIEW. Hovering the preview dims it and surfaces an
`edit` codicon, not dimmed. Clicking that opens the edit pane below.

Two reasons to split them. Most of the time the user is looking, not
editing, and a permanently-armed editor makes looking feel risky. And
separating them means the edit pane can be denser than a browsing view
should be, because it is only present when asked for.

Per `docs/ui-conventions.md`, the hover affordance OVERLAYS the preview.
It must not reflow anything: emphasis never moves layout.

## The edit pane

**Frames, across the top.** The tile as the cartridge draws it. One frame
if it is static, four if any of its quadrants cites an animated character.
That count is derived, never assumed from a slot name.

This replaces the earlier plan to mark the `an1` slot as animated and
freeze it. That plan was wrong on the facts: measured across all 15
tilesets on all 6 ROMs, animated characters land in `fg1` and `fg2`
(`$040-$07C`, plus `$080`, `$090`, `$0DA`, `$0EA`) and NEVER in `an1`.
Showing the tile's own frames sidesteps the question: the user never has
to learn which slot animates, because we show what the tile does.

**Quadrant selection.** Click a quadrant of a frame to select it. Its
character number, source slot and file, flips, priority and color row are
shown beside the pane, read-only.

**Character palettes, an accordion below the frames.** One section per
GFX sheet this tileset has loaded, four in total, each headed by slot and
file (`fg3 - GFX19`). Inside, that sheet's characters rendered as pictures.

**Assignment is select-then-click.** Select a quadrant, click a character,
done. No drag and drop.

That is not only simpler, it removes a class of defect by construction.
With no drop target there is nothing to drop the wrong thing onto: the
value can only come from clicking a rendered character in a loaded sheet,
so an out-of-range character is unreachable rather than merely validated
against. The drag version had to be told that `$200-$3FF` is tilemap space;
this one cannot express it. It is also keyboard-reachable for free, and
testable without HTML5 drag-and-drop.

Clicking a character sets the character field ONLY. It does not change the
color row. Taking the source's row would change two fields from one
gesture, and the palette's preview colors come from the selected quadrant's
row rather than from the character itself.

**Change the color row** from a list of rows rendered as real swatch
strips, using the CGRAM the sheet was composited with, not the ROM tables
it came from. Only rows the sheet's subtiles actually cite are offered.

**Flips and priority** are per-quadrant toggles.

The character number stays visible as read-only text. Recognition comes
from the picture, verification from the number: when something renders
wrong, "char `$19A`" is what makes it reportable. Nobody types it.

## Decisions taken

**Editing a quadrant means editing all frames of that character.** An
animated tile's frames are the same Map16 word rendered under different
VRAM contents, so there is one character field, not four.

**Only reachable characters are offered.** A subtile's color row field is 3
bits, so rows 8-15 are unreachable and sprite slots `$400+` cannot be
referenced at all. A 3bpp sheet produces only indices 0-7. Offering
unreachable choices invites edits that render wrong.

## Testing

Assertions are on behaviour. Presence checks pass for a blank editor.

- Selecting a quadrant and clicking a character changes that quadrant's
  rendered pixels, and the committed subtile word's character field, and
  nothing else in the word.
- The edit pane is absent until the user asks for it, and the hover
  affordance does not move any layout.
- A tile whose quadrants cite no animated character shows ONE frame; a
  tile that cites one shows four.
- The accordion shows exactly four sheets, and their headers name the
  files `readGfxAssignment` reports for the selected tileset. Switching
  tileset changes both the headers and the rendered characters.
- No control anywhere accepts a typed character number.
- Selecting a different color row changes the rendered colors of the tile
  and leaves every character number unchanged.
- The Foreground and Background tabs are separate widgets: selecting a tile
  in one does not change the other's selection, and both can be open at
  once.
- A cart whose Map16 exceeds 512 tiles is either presented in full or
  refused with a reason. It is never silently truncated to two pages.
- The character palettes do not animate, so a click target never
  changes under the pointer.

Each refusal gets a planted-defect proof. CI has no cartridge, so every
gate needs a synthetic fixture built in the test.

## Open questions

- **Where does an LM-expanded cart keep its extra tiles?** Nothing in the
  corpus exercises this: all 6 carts hold exactly 512 tiles. An LM v1.70+
  cart is needed before the page-count path can be written against
  anything real. See en-gen/hackbench#102.
- **Do the character palettes need their own zoom?** 32px per character is
  a comfortable click target and fits 8 per row. Unmeasured against a real
  8x8 sheet.
