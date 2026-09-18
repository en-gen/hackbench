# Sprite properties panel

Clicking a sprite in the map editor should make it visually SELECTED and
present its properties in a panel. This document inventories what that panel
has to show: every facet HackBench interprets from the cart in order to draw
the sprite, plus the editor-layer choices that are ours rather than the ROM's.

Each facet needs to be at least VIEWABLE. Most should eventually be EDITABLE.
This is the inventory, not a UI design.

Status column: **read** means the value comes from the cart today,
**hardcoded** means it is a derivation baked into our source and therefore
cannot track a romhack, **absent** means we do not model it yet.

Evidence scope: derived while building the table-driven sprite engine against
Super Mario World (USA) vanilla, headerless, 524288 bytes, plus the four hack
carts in `test/roms/`. Addresses are SNES unless stated. Not verified against
an emulator.

## Selection behaviour

- Clicking a sprite selects it and marks it visually. There is no selection
  affordance today; the map editor has an inspector pane (`props-ctx`) but
  sprites do not populate it, and a click surfaces the sprite's identity in
  the STATUS BAR instead.
- The selection mark must be distinguishable from the engine marker and from
  annotations, which are different things the editor already draws.
- Annotations belong to the sprite for hit-testing purposes. Clicking the
  `$4D` emerged-mole ghost selects the mole, because the ghost is the only
  recognisable artwork on screen and the mound beneath it is anonymous dirt.

## 1. Identity

| Facet | Source | Status |
|---|---|---|
| Sprite id | the MAP sprite stream, 3 bytes per entry | read |
| Position (col, row) | same stream | read |
| Extra bits | same stream | read |
| Main handler pointer | `$01:85CC + id*2` | read |
| Init handler pointer | `$01:817D + id*3` | read |
| Provenance | both pointers compared against vanilla | read |

Provenance is the honest-degradation hook. When a handler diverges the engine
declines to assert rather than rendering vanilla confidently, and the panel
should surface that: "custom handler, appearance unverified" is a fact the
user needs, not an internal detail.

The id is a LABEL, not the identity. The handler is the identity. Three of
four hack carts repoint init entries, and a repointed sprite can share another
sprite's draw code entirely.

## 2. Which draw routine

| Facet | Source | Status |
|---|---|---|
| Routine (`sub0` / `sub1` / `sub2`) | the `JSR` target in the handler, opcode `$20` | hardcoded |

Worth showing, because it explains everything downstream. `sub0` draws four
independent 8x8 chars and reads per-corner flip flags. `sub1` draws two
stacked large OBJs, 16x32, with ONE attribute byte shared by both and no
per-tile flip table. `sub2` draws one 16x16 large OBJ and never reads the flip
table at all.

## 3. Tiles

| Facet | Source | Status |
|---|---|---|
| Tilemap offset | `SprTilemapOffset[id]` at `$01:9C7F` | read |
| Tile bytes | `SprTilemap` at `$01:9B83`, windowed by the offset | read |
| Tile-group selector (`SpriteMisc1602`) | per handler, varies | read where a table, hardcoded where a shift |
| Corner expansion | implied by routine; `sub2` expands one char to N, N+1, N+$10, N+$11 | hardcoded, structural |

Some sprites overwrite the tilemap read entirely. `$2C` Yoshi Egg is the
worked example: `CODE_01F78D` stamps a literal `$00` over `OAMTileNo` AFTER
the routine returns, so the table value never reaches the screen, and
modelling it is actively wrong on a hack that edits the table.

## 4. Attributes, palette, flip

| Facet | Source | Status |
|---|---|---|
| Static attribute | `Sprite166EVals[id]` at `$07:F3FE` | read |
| Palette index | `(attr >> 1) & 7`, CGRAM row `8 + index` | read |
| Char-high bit | `attr & 1`, adds `$100` | read |
| Init override | the INIT routine may overwrite `SpriteOBJAttribute` | read for `$2C` |
| Position-keyed palette | `$2C`: `YoshiPal[(SpriteXPosLow >> 4) & 3]` | read |
| Runtime CGRAM upload | `$1F`: `MagiKoopaPals` at `$03:B902` to CGRAM `$F0` | read |
| Resting entry of a fade | the terminal `CMP` immediate | read on PR #327, hardcoded on the engine branch |
| Partial-row composite | only columns 0-7 of row 15 are overwritten | read |
| Per-corner flip group | `GeneralSprGfxProp` at `$01:9CDB`, `sub0` only | read |
| Direction latch | `SpriteMisc157C`, from `SubHorizPos` against Mario | read |
| Flip polarity | `sub1` ORs `OBJ_XFlip` when bit 0 is CLEAR; `sub2` EORs it | hardcoded, structural |

**The sprite defines its palette.** Three sources in order: the static
attribute, an init-routine override, a runtime CGRAM upload. The level palette
is the fallback, never the authority. All three occur in vanilla, and the
panel should show WHICH SOURCE WON rather than only the resulting row.

## 5. Animation

| Facet | Source | Status |
|---|---|---|
| Animation source | `static`, `effFrame`, `spriteCounter`, `stateTimer` | hardcoded kind, read parameters |
| Shift and mask | consecutive `$4A` (`LSR A`) bytes at a known address | hardcoded, READABLE, being fixed |
| Frame count | implied by the selector range | hardcoded |
| Timer seed | e.g. the `LDA #$70` operand for `$1F` | read |
| Pose table | e.g. `DATA_01BE69` via the `ORA abs,Y` operand | read |
| Period in GAME FRAMES | derived from the above | computed |
| Editor tick conversion | `SPRITE_ANIM_INTERVAL_MS` 125 ms, 7.5 ROM frames nominal | hardcoded |

The distinction our first method missed: a FREE-RUNNING counter (`EffFrame`, a
sprite counter) versus a ONE-SHOT STATE TIMER counting down from a seed. They
need different modelling, and only the former is phase-reproducible in a still
editor.

Cadence is a known trap. `animTimer` re-bases with `lastTickMs = now` rather
than `+= interval`, so the realised period is `ceil(interval / frameMs) *
frameMs`: 8.0 game frames at 60 Hz, exactly 7.5 at 120 and 144 Hz. A separate
task is making that timer accumulate.

## 6. Handler work outside the shared routine

The category the engine design missed entirely, and where three of the four
`$1F` defects lived.

| Facet | Source | Status |
|---|---|---|
| Extra OAM entries | inline writes AFTER the `JSR`, e.g. the `$1F` wand at slot `+$108` | read |
| Extra part char | an `LDA #imm` operand | read |
| Extra part displacement | a `dw` table or an `ADC #imm` operand | read |
| Extra part gate | a `CMP` immediate | read |
| Per-frame tile displacement | the `$1F` 1 px top-tile nudge: `$FE` (`INC abs,X`) on `$0301` | absent, READABLE, being added |
| Sprite Y pre-shift | some callers `SBC #$0F` before the `JSR`, others do not | hardcoded |

The `$1F` wand is the case to keep in mind for the panel. It is present in
every pose, but in the wind-up poses it is part of the BODY TILEMAP and in the
cast poses it is a SEPARATE OAM ENTRY extending outside the body box. So "does
this sprite have extra parts" is a per-frame answer, not a per-sprite one.

## 7. Graphics source

| Facet | Source | Status |
|---|---|---|
| Sprite set | level header | read |
| SP1-SP4 GFX files | `SPRITEGFXLIST` at `$00:A8C3 + spriteSet*4` | read |
| Char to slot mapping | SP1 `$000`, SP2 `$080`, SP3 `$100`, SP4 `$180` | hardcoded, structural |
| Bit depth | 3bpp in ROM, expanded to 4bpp in VRAM | hardcoded, structural |

A sprite is LEVEL-CONTEXTUAL: the same id looks different in different levels
because the sprite set differs, and in some levels its tiles are not loaded at
all. The panel should be able to say "this sprite's graphics are not present
in this sprite set" rather than showing garbage.

## 8. Geometry

| Facet | Source | Status |
|---|---|---|
| Corner displacements | `GeneralSprDispX/Y` at `$01:9CD3` / `$01:9CD7` | read |
| Base anchor translation | per routine | hardcoded, structural |
| Extents | union across frames, since extra parts leave the body box on some poses | computed |
| Hit rect | currently the shipped appearance rect, not the engine union | hardcoded |

## 9. Editor-layer facets, NOT from the ROM

These are ours. The panel is where a user changes them, and they must not be
presented as ROM facts.

| Facet | Nature | Persistence |
|---|---|---|
| Representative frame | a human choice; the `$4D` resting pose is anonymous rubble, so the front-facing pose is shown instead | our source |
| Ghost annotation on/off | per sprite, per hack | the ROM sidecar, `<romfile>.hackbench.json` |
| Annotations on/off globally | a user preference | a `hackbench.*` setting |
| Staged composition | e.g. the Pitchin Chuck baseball at a captured offset, so the editor conveys the throw | our source |

The per-sprite ghost toggle is the first EDITABLE property this panel would
own. Everything else in the panel is read-only today.

## What a hack could still change without us noticing

The honest list, and the reason the hardcoded rows matter:

- Adding or removing an `LSR` in a pose formula, while the shift count is
  hardcoded rather than counted.
- Changing which `SubSprGfx*` a handler calls, while the routine is hardcoded.
- Relocating a handler, while per-handler values use absolute addresses rather
  than offsets from the resolved handler pointer.
- Rewriting a handler outright. Detectable via provenance but not
  interpretable, and the correct response is to decline to assert.

Per CLAUDE.md Pillar 1a, anything in that list which is READABLE must be read.
Opcodes are bytes. The boundary is simulating execution to discover which code
runs, not reading a byte at a known offset to learn what it does.
