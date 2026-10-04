# Map viewer design

Selecting a map in the explorer opens a tab that renders the level.

Phase 1 is a VIEWER: the Foreground, read only. Editing, the Background,
Effects and Sprites follow, and the design is chosen so each arrives by
adding a source rather than a renderer.

Inherits `docs/ui-conventions.md`. Vocabulary is `docs/glossary.md`, which
defines the four graphics layers by role. This spec uses the role names;
the ROM names (Layer 1/2/3, BG1/2/3) appear only where hardware precision
needs them.

| Role       | ROM name     |
| ---------- | ------------ |
| Foreground | Layer 1, BG1 |
| Background | Layer 2, BG2 |
| Effects    | Layer 3, BG3 |
| Sprites    | OAM          |

Closes the rendering half of en-gen/hackbench#205, "Map tab should render
the level, not a header decode".

## What already exists

More than first appeared. The design below is mostly an assembly of code
that is already in the core.

**The Theia plumbing.** `MAP_VIEW_ID` is wired through the explorer's
preview/pin path and `MapViewWidget` opens on selection. It is 120 lines
and renders a header decode. The rendering is what is missing.

**The core render model, `src/rom/model/`.** It is core, not the reference
extension: it has no shell imports, and the Theia Map16 server already
imports from it (`theia/extension/src/node/map16-decode.ts`).

| Piece             | What it already does                                                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RenderPass.ts`   | The PPU's mode-1 priority table as DATA, back to front, with separate orders for the Effects priority bit set and clear, and all four sprite priorities. Evidence in `docs/rom/obj-priority.md` section 1 and `docs/snes-superfamicom-selected.md:501-514`. |
| `RenderTarget.ts` | The drawing interface every layer writes through, plus `Phase = 'nonPriority' \| 'priority'`.                                                                                                                                                               |
| `tiles/Tile.ts`   | A Map16 tile. `render` walks its four subtiles and filters by EACH subtile's priority bit, so priority is already per quadrant.                                                                                                                             |
| `SubTile.render`  | The 8x8 resolver: one subtile word plus palette to pixels.                                                                                                                                                                                                  |
| `L2Layer.ts`      | The two Background sources, `L2Preset` and `L2ObjectStream`, each walking its grid and calling `Tile.render`.                                                                                                                                               |
| `L3Layer.ts`      | The Effects source, `L3TilemapLayer`.                                                                                                                                                                                                                       |

The archived VS Code extension's webview (`src/webview/mapEditor/`, 4,879
lines in one `main.ts`) is REFERENCE, not a source to port. Its UI
decisions were made with the owner and are settled.

## The rendering model: lookup tables all the way down

The SNES renders a tilemap layer by walking tables. We do the same thing, at
a different rate, from the same tables.

    object stream -> Map16 id grid -> Map16 definition -> 4 subtile words
                                                                |
                             char number + color row + priority + flips
                                                                |
                                bitplanes -> palette index -> CGRAM -> RGB

Every arrow is a lookup and none of it is behaviour to model. This is
CLAUDE.md's first rule and the owner's explicit instruction for this
feature.

**A Map16 subtile word IS a SNES tilemap entry**: the same sixteen bits in
the same layout, char 0-9, color row 10-12, priority 13, flip X 14, flip Y 15. The game writes those words into VRAM as the camera scrolls. The PPU
knows nothing of Map16; Map16 is a lookup SMW performs in software to
PRODUCE tilemap words.

## Reuse: four sources, one resolver

The owner's claim to test: rendering a graphics layer should be almost
entirely shared code, differing only in which tables the lookups target.

**True for the Foreground and the Background. False in three places for
the rest:**

1. **Effects skips Map16 entirely.** Its tilemap entries ARE the 8x8
   entries, loaded from fixed stripe images (`L3Loader.ts`). The Foreground
   and Background go object stream to Map16 to four entries per cell;
   Effects starts at the entries.
2. **Effects is 2bpp; the Foreground and Background are 4bpp.** SMW runs
   mode 1, where BG3 is 2bpp (`L3Loader.ts`; `l3_dump.lua:40`). The
   character DECODE differs, not only where it looks.
3. **Sprites are not a tilemap.** OAM entries sit at free x,y with a size
   bit, and they overlap. There is no grid to walk.

So "graphics layer" is the wrong unit of reuse. The right unit is lower,
and it is the hardware's own boundary: **the positioned 8x8 tilemap
entry.** Every source normalizes to it, and everything below it is written
once.

    SOURCE (the only part that differs)
      Foreground  object stream -> Map16 grid -> Tile -> 4 subtile words
      Background  preset (tiled) OR object stream -> Map16 -> 4 subtile words
      Effects     stripe-image tilemap -> subtile words directly, 2bpp
      Sprites     OAM -> words at free x,y, 1 or 4 per sprite
                              |
                  one 8x8 word at a pixel position, with its bpp
                              |
    RESOLVE    shared: word + characters + CGRAM -> 8x8 pixels, flips, color row
    PLANES     shared: route each word by its priority bit
    COMPOSITE  shared: order the planes by RenderPass, apply per-layer scroll

**Most of this exists.** `SubTile.render` is the resolver, `Tile.render` is
the per-quadrant plane split, and `RenderPass` is the composite order. The
Foreground and Background already share all three. The reuse still to
finish is routing Effects and Sprites through the same resolver instead of
their own paths, which the 2bpp decode makes a parameter of the resolver
rather than a second resolver.

## Priority planes

The priority bit lives in each Map16 subtile word, bit 13. It is per
QUADRANT, not per 16x16 tile: one Map16 tile can have two quadrants in
front of sprites and two behind, which is how part of a pipe draws over the
player while the rest does not. So no graphics layer can be split into
front and back at tile granularity. The split happens after Map16 has been
expanded into subtile words, which is exactly what `Tile.render` already
does.

The owner proposed splitting one layer into two virtual layers around
sprites. That shape is right and it generalizes: EVERY tilemap layer (Foreground, Background, Effects)
has a priority bit, so each emits two planes, and sprites emit four, one
per OAM priority. The composite order is `RenderPass`, a table rather than
code.

The reason this matters is Effects. The level header carries an Effects
priority bit (`bank_05.asm:588-598` shifts header byte 2 bit 7 into
`MainBGMode` bit 3; `bank_00.asm:464-465` writes it to `$2105`). When it is
set, Effects' priority plane draws in front of EVERYTHING, sprites
included. A hand-kept order such as "Foreground back, sprites, Foreground
front" gets that wrong. `RenderPass` already carries both orders.

The priority bit must survive the whole pipeline. Nothing downstream should
reassemble a word from parts; it should carry the one Map16 produced.

## View state is an input, never a global

`L3TilemapLayer.render` reads a module-level singleton,
`src/rom/model/stores/editorStore.ts`, for layer toggles, camera position
and drag state. That was sound for a webview holding one map. In Theia two
map tabs can be open at once, and a singleton gives both one set of toggles
and one camera. It is the same class of defect as the Map16 view's
duplicate DOM ids across tabs.

Rule: **render takes its view state as a parameter.** Layer visibility,
camera and per-layer scroll are passed in by the widget that owns them, one
per tab. This also removes a reactive dependency the old code worked around
by hand (`L3Layer.ts` gates HUD rendering partly to avoid re-rendering
Effects while the camera is dragged).

**Scroll is a COMPOSITE input.** Each layer renders in its own coordinate
space and composition applies the offset. This is the seam for Effects'
runtime motion: moving Effects on a timer means compositing again with a
different offset, with no re-render of the layer. Planned, not built. Phase
1 passes a constant.

## Architecture: the backend renders, per screen

The backend composites one screen at a time, 16x27 tiles, and the browser
requests the screens it needs and assembles them.

**Backend renders the whole level: rejected.** A 32 screen level at 16px
tiles is 8192x432, about 14 MB of RGBA.

**Backend sends the grid, browser composites: rejected.** Payload is tiny,
but rendering moves into the browser and the render gate then needs
Playwright and a real window. A path change silently darkened over a
thousand tests this week; a gate that runs cheaply and often is weighted
heavily.

**Per screen wins.** Payload is bounded and cacheable, scroll granularity
matches the ROM's own layout (the Map16 buffer is laid out per screen), and
rendering stays in node, so the render gate is a plain unit test. It
follows the `map16-decode.ts` to DTO to canvas pattern already shipping in
the Map16 view.

**Also rejected: a browser renderer for display plus a node renderer for
verification.** Two renderers drift, and `docs/layer-previews.md` already
warns that "a preview that draws its own pixels will drift from the editor
it previews". The gate would verify something the user never sees.

## Invalidation: two caches, two policies

An edit to a palette, a GFX character or a Map16 definition must reach the
map, because the map is composed of Map16 tiles. That cascade already
works: four push clients fire `onWorkingCopyChanged(manifestPath)` and
every view re-fetches, and a passing Playwright case asserts that "a
palette edit visibly recolors an already-open Map16 view, with no manual
reload".

The event stays coarse. The caches are fine-grained, and they are the table
boundaries rather than an invention.

**The Map16 atlas**, 512 tile bitmaps. A tile's pixels depend on exactly
its four subtile words: four characters and four color rows. Fully
enumerable, read from data.

**The screen composite**, blits from that atlas. Cheap by construction.

| Edit             | Atlas                            | Screens                 |
| ---------------- | -------------------------------- | ----------------------- |
| Palette row N    | only tiles citing row N          | recomposite those cells |
| GFX character    | only tiles citing that character | recomposite those cells |
| Map16 definition | one tile                         | cells using that id     |
| Place an object  | nothing                          | changed cells only      |

`citedColorRows` exists; `animatedTileIds` is already derived by comparing
rendered phases.

**The grid is recomputed coarsely, deliberately.** Which Map16 id lands at a
cell depends on the level header, the tileset, the object stream AND ROM
code paths. `CODE_05801E` (`bank_05.asm:20-67`) writes `ObjectTileset := 0`
(line 51) when a level's Background is a preset, but the header parse that
`LoadLevel` runs next sets it again from the header (line 626), so the zero
never reaches object expansion. On `$93`, `$94`, `$d3`, `$193` and `$194`
object `$3C` painted a full width wall the ROM never draws, about 212 of
432 tiles; the cause is not known. An oracle found that, not reading. A dependency graph missing an
edge like that is silently wrong; a coarse recomputation can only be slow,
and one object-stream expansion is cheap.

Fine-grained where dependencies are read from data. Coarse where they
include ROM behaviour.

## The oracle

Two gates with different contracts, because they fail differently. Ground
truth is Mesen, whose capture route is deterministic: byte-identical across
cold runs, all artifacts, measured.

### Data parity: exact, zero tolerance

Our expansion against the ROM's own expanded buffer, per graphics layer:
the Map16 id at each grid cell, and for later phases the sprite list and
palette rows. Any difference is a bug. No thresholds, no masks.

It has already earned its keep. Swept over 95 levels it found 62
identical, about 27 differing only by switch-palace semantics, and 5 real
defects, root-causing the `CODE_05801E` bug to an ASM line and confirming
it against the running ROM.

### Render parity: per graphics layer, never a threshold

Whole-screen pixel diffing cannot work. Foreground tiles animate (coins and
question blocks are Foreground, not sprites), sprites move, and the editor
deviates from the ROM ON PURPOSE: representative frame, staged composition,
runtime-state defaults.

Isolation and set membership, not masking:

- **Sprites are excluded by capturing graphics layers separately**, not by
  masking a region. If the emulator hands us the Foreground alone and we
  render the Foreground alone, there is nothing to mask.
- **Static cells compare exactly.**
- **An animated cell must match ONE OF the frames we render for that
  tile.** Exact phase alignment would fail on correct behaviour, because
  the editor shows a representative frame rather than tracking the ROM's
  live phase. With several phase-tagged captures the gate compares frame
  SETS, which catches a missing frame while staying indifferent to which
  phase anyone was on.

Which cells are which comes from the data gate. **Every classification is
derived, never tuned.** No tolerance percentage appears anywhere; this repo
has shipped a check that could not fail.

### Measured facts the gate depends on

All on the six-ROM corpus unless stated.

- Animated characters occupy `fg1` and `fg2` (`$040-$07C`, plus `$080`,
  `$090`, `$0DA`, `$0EA`) and NEVER `an1`, across all 15 tilesets. The
  Map16 spec previously claimed the opposite.
- The Map16 buffer at `$7EC800` is COMPLETE at level load and does not
  stream. Measured on `$105`: the player never moved from spawn at column
  1, and screen 19 already held a real floor, row 24 tile `$100` across all
  16 columns and rows 25-26 tile `$03F`. All 20 screens populated, 48 to 133
  non-empty cells each.
- Capture-time isolation uses the TM register (`$212C`); Mesen's Lua API
  exposes no layer-visibility control. It does not self-heal, and a blank
  isolated Background can mean it sits on the SUBSCREEN rather than being
  absent, so the capture must record the ROM's own TM and TS.

## The corpus is part of the product

A gate must be able to say WRONG. An unobserved cell can only say I DO NOT
KNOW.

The existing corpus at `hackbench-fixtures/maps` has 90 level directories:
Foreground grids for 59, Background tilemaps for 43, Effects VRAM for 42,
and no sprite data. Its grids carry `???` for cells no capture observed,
because a human played each level, and those holes sit wherever nobody
walked, which is where object expansion is most likely to be wrong.

**The deeper defect is that it cannot be regenerated.** Ninety playthroughs
cannot be redone when a capture bug is found or a layout changes. A
fixture you cannot regenerate can only be trusted or discarded, never
audited.

A corpus admitted to the gate must have:

- **Zero `???`.** A level with holes is excluded BY NAME, never averaged in.
- **Regenerable on demand**, byte-identical across cold runs.
- **Every level, every graphics layer**, so coverage is a fact rather than
  a patience budget.
- **A version tie to the ROM it came from**, so a fixture is never compared
  against a ROM it did not come from.

Two harness facts make this reachable. The `$7EC800` buffer is complete at
load, so there is no traversal and `???` is zero by construction. And the
level set is 161, derived from the repo's catalog intersected with
reachability.

**One harness bug must be fixed first.** Castles, fortresses and ghost
houses run an entrance animation (`!PAni_CastleEntrance = 10`,
`constants.asm:185`). Measured on `$0DB` and `$111`: at the first
`GameMode == $14` both read the SAME `Layer1DataPtr` of `$07802C` and report
a 1-screen mode-0 level, the entrance room. Their real headers, 5 and 15
screens, appear about 520 frames later. That matches `spike/FINDINGS.md:490`,
where 66 of 161 levels "failed an identity gate, many collapsing to a bogus
1-screen mode-0 level", and is likely the whole 66. The capture must wait
for `PlayerAnimation` at `$7E0071` to read `$00` AND `GameMode` to read
`$14`, then re-check identity, because `PlayerAnimation` clears while
`GameMode` is still `$11`, mid-load.

## Scope

**Phase 1.** The Foreground, read only. Select a map, see the level,
scroll it. Screens render on demand through the shared resolver, in two
priority planes. No editing, no Background, Effects or Sprites displayed.

It also carries the one refactor the rest depends on: **view state becomes
a render parameter.** Phase 1 is where a second tab first exists, so it is
where the `editorStore` singleton would first bite.

**Not in phase 1, and the design must not preclude them:** editing and its
op layers; the Background and Effects, which arrive as new sources; Effects
routed through the shared resolver with a 2bpp decode; Sprites, which need
OAM capture that does not exist yet; Effects' runtime motion, which is a
time-varying composite input; and the CI gate, which needs the corpus
rebuilt.

## Testing

Assertions on behaviour. A presence check passes for a blank canvas, and
this repo has shipped that defect twice.

- Selecting a map in the explorer opens a tab that renders the level's
  tiles, and the pixels differ between two different levels.
- A screen's pixels equal the same screen composited from the Map16 atlas,
  cell by cell, so the per-screen boundary introduces no seam. Screen
  boundaries get their own case; an off-by-one there is this design's
  characteristic defect.
- **Priority is per quadrant.** A synthetic Map16 tile with priority set on
  two quadrants only puts exactly those two quadrants in the priority plane
  and the other two in the non-priority plane.
- **The priority bit survives.** Assert the 16-bit word reaching the
  resolver equals the one Map16 produced, bit 13 included.
- **Two map tabs do not share view state.** Toggling a graphics layer or
  moving the camera in one tab leaves the other unchanged.
- A palette edit repaints the open map with no manual reload, and changes
  only cells citing the edited color row.
- A ROM whose grid cannot be expanded is refused with a reason, never
  rendered as empty.
- Every gate gets a SYNTHETIC fixture. CI has no ROM, so a safeguard proven
  only by corpus tests is unproven where it runs. Gate with
  `describe.skipIf`; `test/suite/gates/testRegistrationGate.test.ts` bans
  generating cases from a directory listing.

Each refusal gets a planted-defect proof.

## Open questions

- **Screen stride at the seam.** Vertical levels use a different per-screen
  stride from horizontal (`$200` against `$1B0`) and are two 16-wide
  half-screens, so orientation is a parameter of the source. Seven of the
  161 levels are vertical: `$0c2`, `$0db`, `$108`, `$109`, `$12a`, `$134`,
  `$1ce`.
- **Where the atlas lives.** The Map16 view already builds one per tileset.
  Sharing that cache would make a Map16 edit repaint the map for free;
  holding a separate one is simpler but duplicates the decode.
- **How much of `src/rom/model/` reads `editorStore`.** `L3Layer.ts` is
  confirmed. The phase 1 refactor must enumerate the rest before claiming
  view state is fully parameterized.
- **`$1d2` renders tiles the ROM leaves empty.** Resolved by #569: the
  cells were drawn by `CODE_0DDF3A`, which was unported and so left empty.
