# Layer previews

Inherits `docs/ui-conventions.md`. That file's rules about pixel
rendering, emphasis and copy apply here without restating them.

## What a preview is for

The layer stack is the project's edit history: each layer visits the ROM
and manipulates it, and `bytes()` is the fold of that stack over the base
ROM. A preview answers one question about one layer:

> What did this change, and what did it look like before and after?

It is not a diff viewer and not a byte dump. A user scrolling the layers
panel should be able to recognise their own edit at a glance, 40 edits
later, without reading an address.

## Where before and after come from

Folding the stack produces a snapshot after each layer. Layer N's
before/after pair is snapshot N-1 and snapshot N. No preview recomputes
anything the fold did not already produce.

Because a visitor is a pure function of its incoming bytes and its own
params, any prefix can be recomputed on demand. Retain the most recent
few snapshots and recompute older ones when the user scrolls to them.
Choose that number by measuring the fold, not upfront.

## Immediate and staged kinds

A kind commits either on every change or on an explicit Save, and the
choice belongs to the kind, not to the editor that happens to be open.

**Immediate** (palette, map16). One user gesture is one layer. The gesture
is already the smallest recognisable unit, and applying it is cheap.

**Staged** (gfx). The editor accumulates pixels in a scratch buffer and
commits them as ONE layer at an explicit boundary: Save. The GFX view
keeps strokes (pointer down to up) in the widget, with stroke undo and redo,
and Save flattens them to the final value per pixel per 8x8 character and
sends one layer holding every character touched (`GfxLayer.chars`). Closing
with unsaved strokes prompts (Theia's Saveable dialog); discarding drops them.

The character is still the unit INSIDE a layer, for two reasons:

1. It is what the rest of the system already cites. A Map16 quadrant can
   only say "character N", and this file's `gfx` preview kind already
   shows the 8x8 tile before and after. "GFX16 char $2A" is a history
   entry a user recognises 40 edits later; 300 single-pixel ops are not.
2. Per-pixel layers would make the scope line meaningless, since every one
   of them would report the same whole-arena shift.

**Re-encode cost is the fold's problem, not the layer's.** The LC_LZ2
arena re-encodes per FILE, so if layer granularity dictated re-encode
granularity, character-level layers would be ruinous. It does not:
consecutive gfx layers targeting the same file collapse into one
decompress/re-encode pass during the fold. Keeping "what is a layer"
separate from "when do we re-encode" is what lets the layer follow the
user's mental model instead of the compressor's.

The scratch buffer is NOT a layer and never reaches the stack. Undo inside
the view is editor-local (stroke undo); once Save commits, Ctrl+Z pops
the whole layer, every character of it. A staged editor therefore needs a dirty indicator,
and must commit or prompt when it closes, or the user loses work that
looked saved.

Intermediate pixel states are not history and are not recoverable, by
design: the user edited a character, not three hundred pixels.

## The contract

Every kind implements:

    preview(before: Uint8Array, after: Uint8Array): LayerPreview

Rules, all of them:

1. **Show the smallest unit that changed**, not the whole resource. A
   palette edit shows the swatch, not the palette. A GFX edit shows the
   8x8 tile, not the 128-tile sheet.
2. **Before and after use the identical renderer, size and zoom.** The
   only difference the user sees must be the change itself. Two images at
   different scales are unreadable as a pair.
3. **Reuse the view's own renderer.** `buildTileAtlas` for tiles and
   blocks, the palette swatch for colors. A preview that draws its own
   pixels will drift from the editor it is previewing.
4. **Pair the visual with the exact value.** Every preview carries the
   literal that changed - hex word, char number, pixel index - beside the
   image. The image is for recognition; the value is for verification.
5. **Decline rather than invent.** When a layer's change has no visual
   form, render the text summary and no image. Four identical thumbnails
   standing in for "we cannot show this" is the defect this rule exists to
   prevent.
6. **Say when the visible change is not the whole change.** A layer that
   moves a table alters what LATER layers target. Its own before/after can
   be accurate and still misleading, so those kinds carry a plain-text
   line saying what else it affects.

## Reference kinds

A new kind is designed by diffing against these three. If it cannot be
expressed in their shape, the contract needs extending - extend it here,
in the same change, with the reason.

### palette

- **Visual:** the two swatches, side by side, at swatch size.
- **Value:** `$391F -> $03E0`, plus RGB for each.
- **Scope line:** none normally. A color that a per-level override
  supersedes says so.

### map16

- **Visual:** the 16x16 block, before and after, at inspector zoom.
- **Value:** the subtile field that changed and its two values, e.g.
  `tl.charNum $182 -> $183`.
- **Scope line:** required when the block is shared. 326 of 512 FG block
  ids are byte-identical across all 15 tilesets, so most Map16 edits
  change every tileset and the preview must say so.

### gfx

- **Visual:** the 8x8 tile at edit zoom, before and after.
- **Value:** the pixel coordinate and the palette index, e.g.
  `(3,5) index 2 -> 7`.
- **Scope line:** required. A GFX layer re-encodes the arena, so even a
  one-pixel edit can shift every file behind it. The line reports how many
  bytes the patch actually moved, since that number is the user's budget.

This kind is STAGED: one layer per Save, holding one or more 8x8 characters.
The visual is one tile before and after per character, and the value text
reports how many of its 64 pixels changed. A layer file written by the first
build (`file`, `tile`, `pixels` at the top level) still reads, as a layer of
one character.

### import

An imported patch, or any layer whose params are opaque bytes.

- **Visual:** none.
- **Value:** the byte ranges touched and their total size.
- **Scope line:** required, naming which resources the ranges fall in
  when that can be resolved, and saying plainly when it cannot.

## Adding a kind

1. Read this file and `docs/ui-conventions.md`.
2. Design the kind against the three reference kinds above.
3. If the contract had to stretch, update it HERE in the same change, and
   say what forced the stretch.
4. A preview asserts behaviour, not presence: the test renders a real
   before and after and asserts the two images DIFFER, and that the value
   text names the actual change. An assertion that a preview element
   exists passes for a blank one.
