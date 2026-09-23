# Tile Collision — surface model

Per-tile surface semantics are exposed as a `TileCollision` object on every
`Tile`, STRICTLY derived from SMW's disassembly at `C:\Projects\SMWDisX`.

No folklore. No approximation. Every field cites an ASM line.

## Model

`TileCollision` exposes BOTH sprite-perspective and Mario-perspective
fields so consumers can pick the view that matches their query:

- **Sprite-perspective consumers** read `floor` / `ceiling` / `wall`:
  they need to match `CODE_01928E` / `CODE_0192C9` runtime behavior.
  Today those are the `sprites/behaviors/` simulators (through
  `solidityFromL1`) and the `getL1` closure `SmwMap.renderSpriteOverlays`
  hands to sprite annotations. The sprite overlays that used to be the
  visible consumer (KoopaWalk patrol, HopFlame bounce, CheepCheep arc)
  were removed; see `docs/sprites/sprite-overlay-removal.md`. The sprite fields
  are not dead with them: the simulators still read them.
- **Editor overlays** ("Show surfaces", "Show walls") read
  `marioFloor` / `marioCeiling` / `marioWall` — the designer wants
  to see what the player experiences.

Each face is a boolean named for what the face IS:

```
                    ┌────────────┐  ← ceiling (sprite bonks head)
                    │            │    marioCeiling (Mario bonks)
        wall →      │    tile    │  ← wall (sprite blocked sideways)
        (L/R face)  │            │    marioWall (Mario blocked)
                    └────────────┘  ← floor (sprite lands)
                                      marioFloor (Mario lands, incl. slopes)
```

In vanilla SMW the left and right faces always behave the same, so
`wall` / `marioWall` are single booleans rather than left/right pairs.
A future LM hack that needs directional one-way walls would split
these without touching other consumers.

## Field reference

### `floor` — top face landable
- `CODE_01933B` (bank_01.asm:2705-2742) — landing path reached from
  `CODE_0192C9` Y=2 via `CODE_019310`.
- Ranges (acts-like low byte):
  - `<$11` — semi-solid via `CODE_0193B0` sub-pixel gate (mushroom
    platforms, vines, ropes; sprite lands when pixel-Y is near tile top)
  - `$11-$6D` — full solid
  - `$6E-$D7` — slope tiles; landing routes through slope-angle table
    at `CODE_00FA19` (bank_00.asm:14053-14079). Sprite-side slope
    membership is surfaced via the `slopeTable` field;
    Mario-perspective slopes carry the per-pixel height profile in
    `slope?: SlopeInfo` (Phase 3).
  - `>=$D8` — upper solid range (`CODE_019386`)
- Additionally gated by the block-behavior filter (see below).

### `ceiling` — bottom face bonkable
- `CODE_0192C9` Y=3 (bank_01.asm:2659-2668) — bonking path.
- Ranges:
  - `$11-$6D` — full solid
  - `$C4-$C9` — tileset-gated window (disabled for tilesets 0/7 per
    bank_05.asm:323)
  - Everything else — not solid from below
- Additionally gated by the block-behavior filter.

### `wall` — horizontal face (sprite perspective)
- `CODE_01928E` (bank_01.asm:2613-2635). Horizontal wall check.
- Range: acts-like low byte `$11-$6D`.
- Gated by the block-behavior filter.

### `marioFloor` / `marioCeiling` / `marioWall` — Mario perspective

Mario's tile collision is gated by the **`CODE_00F545` solidity
predicate** (bank_00.asm:13410), NOT by the sprite-range $11-$6D rule.
`CODE_00F44D` at bank_00.asm:13342-13353 reads the Map16 tile's low byte
from bank $7E and high byte from bank $7F, calls `CODE_00F545`, and
returns Z=1 when F545 set A=0 (non-solid). The caller at
`CODE_00EB77` bank_00.asm:12073-12074 does `BEQ CODE_00EBDD`, skipping
the `TSB PlayerBlockedDir` wall-flag set at bank_00.asm:12189 for
non-solid tiles. Block actions still fire via the `CODE_00F28C` /
`CODE_00F2C9` / `CODE_00F127` chains — F545 only gates the physical
wall flag.

F545 dispatch:
- **high byte != 0**: solid (A = high byte) unless `low=$32` with Blue
  P-switch active or `low=$2F` with Silver P-switch active (remap to
  $2B, A=0, non-solid). So effectively ALL page-1 (`$1xx`) tiles are
  solid — ground `$100`, item blocks `$11A`/`$11E`, structural terrain.
- **high byte == 0**:
  - `low=$29`: solid iff Blue P-switch active.
  - `low=$2B`: solid iff Blue P-switch active.
  - `low $EC-$FB`: solid (switch-palace range).
  - Everything else: NON-SOLID. This is why checkpoint-post bodies
    (`$030`/`$032`/`$033`/`$035`), midway tape (`$038`), goal tape
    (`$039`/`$03C`), decorative fill (`$03F`), lava-corner graphics
    (`$0A3`/`$0A6`), and dragon-coin graphics (`$02A-$02E`) all pass
    through Mario — they have no physical wall, yet their block
    actions still fire through separate dispatch chains.

Current classify formula:
```
marioSolid   = marioTileSolidity(low, high, PSWITCH_INACTIVE)  // F545 port
hitOnHead    = marioTileDispatch(low, ts, 0) === 'hit'         // F127 dir 0 = PlayerBlock_Top    → ceiling
hitOnSides   = marioTileDispatch(low, ts, 1) === 'hit' || ...2 // F127 dir 1/2 = Right/Left       → wall
hitOnFeet    = marioTileDispatch(low, ts, 3) === 'hit'         // F127 dir 3 = PlayerBlock_Bottom → floor
marioFloor   = (marioSolid || hitOnFeet)  && (feetLanding === 'land') && isMarioStandable(actsLike)
marioCeiling = (marioSolid || hitOnHead)  && ceiling                  && isMarioStandable(actsLike)
marioWall    = (marioSolid || hitOnSides) && wall                     && isMarioStandable(actsLike)
```

Each Mario field is the UNION of two collision sources: the physical-wall
flag (F545) AND the block-action dispatch (F127), split by which Mario
face touches the tile. F545 covers tiles that physically arrest Mario in
the current frame. F127 covers tiles that trigger an interaction on
contact (hidden blocks, ? blocks, note blocks) even when F545 says the
tile is passable in its current form — e.g. invisible coin block `$021`
has high byte `$00` so F545 returns non-solid, but F0A4[$10] = $08
matches PlayerBlock_Top, so `hitOnHead` fires and `marioCeiling` reports
true. The overlay needs this because Mario's head DOES bonk on the tile
even though the block is invisible pre-reveal.

Direction encoding comes from DATA_00F0EC (bank_00.asm:12772) mapped to
PlayerBlockedDir bits (rammap.asm:632): dir 0 = $08 = Top, dir 1 = $01 =
Right, dir 2 = $02 = Left, dir 3 = $04 = Bottom.

`marioFloor` is **flat floors only** — it excludes slope tiles.
`CODE_00EDF7` returns `'slope'` (not `'land'`) for low bytes in
`$6E-$D7`, so slopes fall out of `marioFloor` naturally. Slope
membership is surfaced via the separate `slopeTable` field for
overlays that want to render angle data. This matters for the
"Show surfaces" overlay, which draws a horizontal yellow line at
the tile's top — correct for flat floors, misleading for slopes
(whose surface is diagonal). `isMarioStandable` (exported from
`src/rom/BlockBehaviorLoader.ts`) excludes the following low-byte
ranges as ASM-confirmed pass-throughs:

| Low byte | ASM | Reason |
|---|---|---|
| `$2A-$2E` | `CODE_00F32B` bank_00.asm:13094 | Coins (collected + pass) |
| `$38` | `CODE_00F2C9` bank_00.asm:13042 | Midway tape (save + pass) |
| `$66-$69` | `CODE_00F14C` bank_00.asm:12811 | Checkpoint decoration — tileset 1 HurtMario, other tilesets pass. Not a reliable surface |
| `$6E` | `CODE_00F311` bank_00.asm:13081 | Moon coin (collected + pass) |

Spike `$2F` is NOT excluded — `HurtMario` triggers universally but
the sprite-range collision still arrests Mario's velocity, so he
stands on the tile while taking damage. Climbables `$06-$1C` are
NOT excluded — `CODE_00F2C9` sets `InteractionPtsClimbable` for
body-overlap grab-on-UP-press logic, but the feet-level `CODE_00F127`
dispatch still marks `$11-$2D` as solid. Turn blocks in that range
stop Mario from above.

### `slopeTable` — sprite-side slope membership
- `DATA_00EAC1` (bank_00.asm:11946-11950) — 26-entry table of slope tile
  IDs.
- Looked up by `CODE_00F04D` (bank_00.asm:12730-12741) linear search.
- Surfaces sprite-collision slope membership. Sprite consumers
  (`KoopaWalk` patrol, `CheepCheep` arc) still read this flag until
  Phase 4 migrates them to the Mario-side `slope` field below.

### `slope?: SlopeInfo` — Mario-side slope surface profile (Phase 3)
- `DATA_00E632` (bank_00.asm:11604-11667) — 510-byte slope-height LUT.
- `DATA_00E55E` (bank_00.asm:11572-11586) — default per-tile
  slope-index map (106 bytes, `map[low-$6E]` → slope index).
- `DATA_00E5C8` (bank_00.asm:11588-11602) — overworld / cave slope-index
  map used when `ObjectTileset == 0 || == 7` per the `CODE_058281`
  branch at bank_05.asm:317-327.
- Resolved by `CODE_00ED86` (bank_00.asm:12334-12381) at runtime via
  `LDA [SlopesPtr],Y` (where Y = `low-$6E`) → `ASL×4` → `ORA pixelX` →
  `DATA_00E632,X`. Ported as `resolveSlope` in
  `src/rom/SlopeResolver.ts`.
- Present when (a) the tile's acts-like low byte is in `$6E..$D7` (the
  `CPY #$6E BCC` / `CPY #$D8 BCS` guards at bank_00.asm:12327-12330)
  AND (b) the tile is F545-solid. `marioFeetLanding` still classifies
  `$D8-$FA` as `'slope'`, but those low bytes fall outside the
  106-entry SlopesPtr map and have no per-pixel height data, so they
  resolve to `null`.
- F545 gate: the ROM's slope dispatch at `CODE_00EDE9` (bank_00.asm:12392-12394)
  is `JSR CODE_00F44D / BNE CODE_00EDF3` — slope-angle path only fires
  when F545 returns solid. Page-0 placements of slope-range low bytes
  (`$0A6` lava-corner graphics, `$073` / `$074` / `$079` bush graphics)
  hit the non-solid branch and never enter the slope dispatch — Mario
  walks through them as decoration. `TileFactory.classify` mirrors this
  by gating `resolveSlope` on `marioSolid` so the overlay doesn't draw
  misleading diagonals on those tiles. `resolveSlope` itself stays
  low-byte-only (matching the ROM's `LDA [SlopesPtr],Y`).
- The `CPY #$D2 BCS` gate at bank_00.asm:12340-12342 (tileset 3/$E
  skips `$D2+` at runtime) is deliberately NOT replicated in the
  resolver — overlay-only deviation; the slope graphic is still present
  in ROM data and designers benefit from seeing it.
- `heights[x]` is the surface Y (0..15) at pixel column x; "Show
  surfaces" draws a pixel-accurate diagonal polyline from this array.

### Block-behavior filter (applied to `floor`, `ceiling`, `sideSolid`)
`DATA_00F05C` (bank_00.asm:12744-12749) is a 36-byte table indexed by
acts-like low byte `$11..$34`. It classifies each block's hit behavior.
`CODE_00F17F` (bank_00.asm:12846) dispatches on the value; types
`$00` (empty), `$02` (coin), `$03` (vine), `$04` (invis coin) bail out
early — those tiles are NOT walls or floors even when their low byte
falls in `$11-$6D`. The filter is applied via `isBlockBehaviorWall` in
`src/rom/BlockBehaviorLoader.ts`.

### Low-byte-only classification (no page check)
All three solidity fields (`floor`, `ceiling`, `sideSolid`) derive
from the acts-like LOW BYTE only. This matches the SMW ASM, which
reads the tile's low byte into the 8-bit `Map16TileNumber` variable
(rammap.asm:1745) via `CODE_019523` (bank_01.asm:2957-2968) and runs
the range tests on that single byte. The tile's high byte / page is
NOT consulted during collision dispatch — it only feeds the P-switch
tile-swap routine (`CODE_00F545`). Consequently, if a page-0
Map16 tile (decorative clouds, backdrops, etc.) is placed in L1 with
a low byte in the solid range, the game WILL treat it as a wall or
floor, and the overlay reports it as such.

## "Show surfaces" / "Show walls" overlays

Both overlays are implemented — `drawSurfaces.ts` draws yellow lines
along the top/bottom faces of Mario-floors / Mario-ceilings, and
`drawWalls.ts` draws purple lines along the left/right faces of
Mario-walls. The two colors are complementary on the color wheel and
sit in palette regions that vanilla SMW barely uses, so both overlays
remain legible against every tileset. The wall overlay applies the vertical-axis silhouette
rule (suppress the shared face between two horizontally-adjacent wall
cells) — vertically-adjacent wall cells do NOT merge, since walls are
a horizontal-collision concept.

Both overlays read the Mario-perspective fields (`marioFloor` /
`marioCeiling` / `marioWall`) directly from `tile.collision`. Two
filters are layered on the sprite-perspective fields at classify time
(`TileFactory.classify`):

1. **`isMarioStandable` hand-list** (`BlockBehaviorLoader.ts`) —
   vanilla-SMW pass-through tiles that the ROM dispatches to
   collect/save/generate instead of stop (coins `$2A-$2E`, midway
   tape `$038`, goal tape `$039`/`$03C`, checkpoint post `$02F`,
   checkpoint decoration `$066-$069`, decorative fill `$03F`, moon
   coin `$06E`).

2. **`CODE_00F127` port** (`MarioTileDispatch.ts`) — faithful port of
   Mario's tile dispatch tree from `bank_00.asm:12789`. Returns
   `hurt` / `hit` / `passThrough` per the ASM. Classify layers this
   on the hand-list: if the dispatch returns `hurt` from any
   direction (Mario bounces off rather than settling), the tile is
   excluded from `marioFloor`/`marioCeiling`/`marioWall`.

### ASM dispatch overview — three distinct Mario-tile routines

Mario's tile interaction in SMW actually goes through three different
dispatch trees, each answering a different question. Ports of all
three live in `src/rom/MarioTileDispatch.ts`:

1. **`CODE_00F127` — block-action dispatcher.** Fires when Mario's
   contact should trigger a coin spawn, vine growth, note-block
   bounce, P-switch reveal, etc. Uses per-direction bit masks
   `DATA_00F0EC` (indices 0-3: bit 3 above, bit 0/1 sides, bit 2
   below) against per-tile masks `DATA_00F0A4`. Ported as
   `marioTileDispatch(low, tileset, direction, tables)`.

2. **`CODE_00EDF7` — Mario feet-landing dispatcher.** Called when
   Mario is falling and his feet reach a tile. Determines whether
   the tile stops his fall. Ported as
   `marioFeetLanding(low, tileset)`. Dispatch is much simpler than
   F127:
   - `< $6E`: lands on Mario (except `$59-$5B` in tilesets 3/$E,
     which are holes).
   - `$6E-$D7`: slope-angle dispatch via `CODE_00ED86` (per-tile
     slope height from `DATA_00E632`). Ported as `resolveSlope` in
     `src/rom/SlopeResolver.ts`; surfaced on `TileCollision` as the
     `slope?: SlopeInfo` field.
   - `$D8-$FA`: also marked `'slope'` by `marioFeetLanding`, but falls
     outside the 106-entry `SlopesPtr` map so `resolveSlope` returns
     `null` — no per-pixel height data exists for that range.
   - `$FB+`: special path `CODE_00F629`.

3. **`CODE_01928E` / `CODE_0192C9` — sprite-range solidity.** Used
   for sprite-vs-tile collision (and per empirical tracing, approximates
   Mario's wall-blocking dispatch too). Simple `$11-$6D` range check
   with a tileset-gated `$C4-$C9` window for vertical solidity.

The three dispatchers answer different questions and produce
overlapping but not-identical tile classifications. Notably:

- F127 `passThrough` ≠ "not a wall". Turn block `$11` from the side
  returns `passThrough` because no block action fires on side contact,
  yet Mario is definitely blocked by turn blocks from the side.
- F127 `hit` ≠ "Mario stops". Coins at `$2A-$2D` with direction 0
  return `hit` because their action (coin collect) fires — but Mario
  passes through, he doesn't settle.
- `CODE_00EDF7` marks nearly all `$00-$6D` tiles as Mario-feet-solid,
  including tiles like `$02F` spike, `$032` checkpoint decoration,
  `$039`/`$03C` goal tape, `$03F` decorative fill — tiles the user
  has flagged as "no collision in gameplay." The ASM DOES land Mario
  on them if his feet touch; the reason they appear collision-less in
  vanilla is that the level LAYOUT positions them where Mario
  physically never reaches the top face (buried, or out of jump
  range). This is a LEVEL-SPECIFIC property, not an ASM rule.

### How classify combines the three dispatchers

The current `TileCollision` fields are computed as follows:

- **Sprite perspective** (`floor`, `ceiling`, `wall`) — direct port of
  `CODE_01928E` / `CODE_0192C9` range tests.
- **Mario perspective** (`marioFloor`, `marioCeiling`, `marioWall`) —
  sprite field AND `isMarioStandable` hand-list AND NOT F127 `hurt`:
  - Hand-list excludes the specific vanilla tiles Mario physically
    doesn't settle on in typical level layouts (coins `$2A-$2E`,
    midway `$038`, goal tape `$039`/`$03C`, checkpoint post `$02F`,
    checkpoint decoration `$066-$069`, decorative fill `$03F`, moon
    coin `$06E`).
  - F127 `hurt` adds robust tileset-aware exclusion for hazard tiles
    (`$2F` spike unconditional, `$59-$5B` in tilesets 5/$D, `$66-$69`
    in tileset 1 — Mario bounces off these, doesn't settle).

The ASM ports are exported from `MarioTileDispatch.ts` for future
consumers: a block-hit overlay would consume `marioTileDispatch`.
Slope-angle data is ported separately in `src/rom/SlopeResolver.ts`
and surfaced as `TileCollision.slope` (Phase 3).

### Switch palace state in the overlay — editor convention, not ROM

| Tile ID range | state=false (default) | state=true (toggled on) |
|---|---|---|
| `$06A-$06D` | passable (dotted outline) | solid (block appears) |
| `$16A-$16D` | passable (dotted outline) | solid (block appears) |

Both ranges share `SwitchPalaceAlternateBehavior` which swaps the
rendered quad based on `switchPalaceState[color]`. Collision in the
overlay follows the visually-solid quad: same rule for both ranges.

**Important: this is NOT what the ROM does at runtime.** The SMW
sprite / Mario collision routines (`CODE_01928E`, `CODE_0192C9`,
`CODE_00F127`) do not consult any switch-palace RAM variable; they
run the pure low-byte range test, which treats `$6A-$6D` as in-range
solid unconditionally. The game's visual transition from dotted to
solid is driven by Map16 **definition** state (which subtile graphics
the tile's pointers reference), not by dynamic collision dispatch.
The overlay's state-dependent toggle is therefore an **editor preview
convention** — it shows the designer what the level looks / plays
like in each palace state. It is **not** a port of a ROM mechanism.
If a future design calls for ROM-accurate switch-palace collision,
it will need to model the Map16-definition swap at level load; until
then, the toggle provides a useful approximation of intent.

## Consumer guide

| Question | Field(s) to read |
|---|---|
| Can a sprite stand on this tile? | `floor` (and `slopeTable`) |
| Does a sprite bonk its head here? | `ceiling` |
| Is this a wall for a walking sprite? | `wall` |
| Can Mario stand on this tile? | `marioFloor` (slopes included) |
| Does Mario bonk his head here? | `marioCeiling` |
| Is this a wall for Mario? | `marioWall` |
| Is this a ledge? | `marioFloor === true` for this cell, and `marioFloor === false` for the neighbor in the fall direction |
| Is this a slope? | `slope !== undefined` (Mario perspective, with heights); `slopeTable === true` (sprite perspective, legacy boolean) |

Consumers reading these fields should NOT duplicate the range logic in
their own code. The point of `TileCollision` is that the classification
happens once in `TileFactory.classify`; everything else reads the boolean.

## Phase roadmap

| Phase | Fields added | Fields removed | Toolbar toggle | Status |
|---|---|---|---|---|
| Phase 1 | `floor`, `ceiling` | `topSolid`, `bottomSolid` | "Show surfaces" (`layout-panel-dock`) | shipped |
| Phase 2 | `wall` | `sideSolid` | "Show walls" (`layout-sidebar-right-dock`) | shipped |
| Phase 3 | `slope?: SlopeInfo` | — | (extends Phase 1 + Phase 2 overlays) | shipped |
| Phase 4 | — | `slopeTable`, `solidityFromL1` helper | — | pending |

Phase 3 renders slopes as pixel-accurate diagonal polylines in the
"Show surfaces" overlay via `DATA_00E632` per-pixel heights resolved
through the per-tileset `SlopesPtr` map. It also extends the "Show
walls" silhouette: slope cells count as wall-covering for neighbour
suppression, removing the stair-step purple artefacts that appeared on
solid-fill tiles butting up against slope graphics pre-Phase-3.

Phase 4 migrates sprite-overlay consumers (KoopaWalk, CheepCheep,
HopFlame, Thwomp, WingedSprite) to read `cell.collision.*` directly,
deletes `slopeTable` once sprite consumers switch to `slope !==
undefined`, and removes the `solidityFromL1` helper. Snapshot-compare
`gen_diff_images.ts` output against a pre-migration baseline;
byte-identical required.

## Not in scope (future tickets)

### Block-hit dispatch
Beyond plain solidity, `CODE_00F17F` (bank_00.asm:12846) dispatches to
distinct block-hit behaviors: turn block, coin collect, vine growth,
P-switch reveal, note-block bounce, throw-block spawn, directional
coin, spike damage (`CODE_00F154` from `CODE_00F127` at `$2F`). Each
could become a first-class `hitBehavior` field on `TileCollision`. Not
in scope here — track separately.

### Mario-vs-sprite collision asymmetry
`CODE_0192C9` handles sprite-vs-tile only. Mario uses
`CODE_00F127` (bank_00.asm:12789-12823) and its own collision path with
player-specific branches (slopes in certain tilesets hurt Mario, note
blocks bounce him, etc.). Current `TileCollision` lumps both. A future
split would expose separate `spriteFloor` vs `marioFloor` fields.

### Lunar Magic acts-like hijack
LM patches a hijack table so custom tiles can behave as vanilla ones.
`ActsLikeLoader.readActsLikeTable` (src/rom/ActsLikeLoader.ts) is
currently a stub returning an empty map. Until this is ported, custom
tiles in LM-hacked ROMs fall back to identity dispatch (tile ID acts
like itself), which diverges from the actual hack behavior. Hook point
would live in `bank_00.asm` at or before `CODE_00F127`.
