# Generic sprite draw engine: Phase 1 divergence report

Evidence scope for everything below: static traces against `C:\Projects\SMWDisX`
plus the six ROM files in `test/roms/` (vanilla, magic, Grand Poo World 2 1.1,
GrandPooWorld V1.2, Invictus 1.0, Seven Vanilla Levels, which is six files
because vanilla and magic are the same ROM with and without a copier header).
No emulator was run. Nothing here is verified against live hardware or an
accurate emulator, and no claim should be read as dynamically confirmed.

## How to read this document

It is APPEND-ONLY, written one work session per section in commit order, and
that is not a reference. Several sections are superseded in part by later
ones, and until now nothing said so at the top. This map is the fix. The
superseded prose stays in place, because the reasoning that got there is
worth keeping, but nothing should be quoted from it without checking here
first.

| # | Section | Status |
|---|---|---|
| 1 | Two premises the ROM contradicts | CURRENT |
| 2 | What was built | CURRENT for the mechanism; the descriptor COUNT is stale, see 13 |
| 3 | Descriptor coverage and the divergence result | PARTLY SUPERSEDED. Five descriptors became sixteen in `45e9e1e`, and two verdict rows stated the shipped path's output wrongly. Corrected in place; the live version is `ADJUDICATION` in `SpriteEngineEquivalence.test.ts` |
| 4 | Inventory of the 40 classes | CURRENT |
| 5 | The appearance / annotation seam | CURRENT |
| 6 | Verification | NUMBERS SUPERSEDED. The suite has grown; take counts from a run |
| 7 | What I could not verify | SUPERSEDED by 9.4 and 13.1, the maintained fragility lists |
| 8 | Two format gaps found by looking at $1F | HISTORICAL. The derivation is sound; its "still a literal" lists are superseded by 9, 11 and 13 |
| 9 | Reading the handler instead of deriving from it | CURRENT. 9.4 is the live declared-hardcode list |
| 10 | The walk family, and what Rex would cost | CURRENT. 10.5's stated reason was backwards and is rewritten |
| 11 | Three more values converted from literal to read | CURRENT |
| 12 | Six ROM files, five ROMs | CURRENT |
| 13 | What is read-backed, per descriptor | CURRENT. Start here for "is X read or hardcoded" |

Two questions have a single authoritative answer, and it is not prose:

- **Is this value read from the ROM?** Section 13's table, plus the
  planted-byte tests in `SpriteEngineCartReads.test.ts` and
  `SpriteEngineWalkCycle.test.ts`. A read with no plant against it is not a
  read.
- **Where does the engine diverge from the shipped path, and who is right?**
  `ADJUDICATION` in `SpriteEngineEquivalence.test.ts`, which is executable and
  carries a structural `pin` per sprite. Section 3's table is a snapshot of an
  earlier state of it.

## 1. Two premises in the brief that the ROM contradicts

Both were checked before anything was built on them.

### The handler pointer table is at $01:817D and $01:85CC, not $01:8183

`$01:8183` is the sprite INIT pointer table misaligned by three entries. The
real tables were located empirically rather than from a label, because the
relevant labels are absent from `SMW_U.sym`:

- INIT at **$01:817D**, found by scanning bank $01 for a base where entry $7D
  reads `$85C2`. That is `Return0185C2`, whose label encodes its own address,
  and entries $4F and $50 agree there because both are `InitPiranha`.
- MAIN at **$01:85CC**, found by requiring entry $12 to read `$F87B`
  (`Return01F87B`) and entries $00-$03 and $04-$07 to form the two runs of
  identical pointers that `CallSpriteMain` shows.

Both were then cross-checked entry by entry against the labels in
`CallSpriteMain` (bank_01.asm:893 onward). Reading the misaligned table is what
produced the sprite IDs in the next item.

### The MAIN handler table is byte-identical in all six ROM files

The brief reported the main handler table as repointed at $4F, $50 and $98.
Measured against the correctly located tables:

| Table | Repointed entries across the corpus |
|---|---|
| MAIN `$01:85CC` | **none** |
| INIT `$01:817D` | exactly three: `$52`, `$53`, `$9B` |

The three-entry offset maps the brief's `$4F/$50/$98` onto `$52/$53/$9B`, and
all three are INIT routines, not draw handlers:

| ID | Vanilla init | Becomes | In |
|---|---|---|---|
| `$52` Moving ledge | `InitMovingLedge` `$8890` | `$85B7` | GPW2, Invictus, Seven Vanilla Levels |
| `$53` Throw block | `Return0185C2` `$85C2` (a no-op) | `$8435` | Seven Vanilla Levels |
| `$9B` Hammer Brother | `InitHammerBrother` `$87A7` | `$85C2`, the no-op | GPW2, GPW V1.2, Invictus |

`$9B` is the most interesting case and it strengthens rather than weakens the
design rule. Three hacks NULL Hammer Brother's init to the shared no-op. The
sprite ID is unchanged and the draw code is unchanged, yet the sprite is not
the same sprite any more. Keying on the sprite ID cannot see this; keying on
the resolved handler can.

The practical consequence for Phase 1 is that **the honest degradation path is
currently unexercised by draw-handler repoints in this corpus**, because no
draw handler is repointed in it. It is exercised by the INIT repoints, and the
harness tests it against `$9B` on a real hack ROM rather than a synthetic one.

### What was confirmed

The data tables are byte-identical in all six ROM files, as reported:
`SprTilemap` `$01:9B83`, `SprTilemapOffset` `$01:9C7F`, `GeneralSprDispX/Y`,
`GeneralSprGfxProp` `$01:9CDB`, `Sprite166EVals` `$07:F3FE`, and also
`SPRITEGFXLIST` `$00:A8C3`. The three anchor offsets were confirmed:
`SprTilemapOffset[$4D] = $EA`, `[$2C] = $94`, `[$1F] = $73`.

## 2. What was built

`src/rom/model/sprites/generic/SpriteDrawDescriptor.ts` (339 lines) and
`SpriteDrawEngine.ts` (595 lines), plus 808 lines of tests. That is 934 lines
of mechanism against a 600-900 budget, about 4 percent over, most of it doc
comment rather than code. Nothing was deleted, rewired or modified in the
existing 40 appearance classes.

### The three routine ports

Each ported once, reading every value from the ROM. Re-verified against
`bank_01.asm` rather than taken from the brief.

- **`SubSprGfx0Entry0`** (bank_01.asm:3853). Four independent 8x8 chars.
  `tile = SprTilemap[SprTilemapOffset[id] + Misc1602*4 + corner]`,
  `attr = GeneralSprGfxProp[propGroup*4 + corner] | SpriteOBJAttribute`,
  positions from `GeneralSprDispX/Y`. Confirmed: the loop counter `_4` runs 3
  down to 0 and indexes the tile, the prop and both position tables alike.
- **`SubSprGfx1`** (bank_01.asm:3920). Two stacked 16x16 large OBJs, eight
  subtiles. `idx = SprTilemapOffset[id] + Misc1602*2`. Confirmed: no per-tile
  attribute table, one attribute byte stored to both entries, X-flip applied
  when `SpriteMisc157C` bit 0 is CLEAR, both entries get `OAMTileSize` bit $02.
  One correction to note: an entry whose `SpriteOBJAttribute` has bit 7 set
  diverts to `SubSprGfx1Hlpr1`, a variant the engine does not yet model.
- **`SubSprGfx2Entry1`** (bank_01.asm:4148). One 16x16 large OBJ. Confirmed:
  never reads `GeneralSprGfxProp`, derives X-flip from `SpriteMisc157C`. One
  correction: it uses **`EOR`**, not `ORA` (bank_01.asm:4171), so the latch
  flip TOGGLES any flip bit the handler already set rather than forcing it on.
  The engine models that distinction.

### The descriptor format, derived bottom-up

Every field stores WHERE to look, never WHAT was there. Two fields go one level
further and store the address of the **operand of the consuming instruction**,
so a hack that relocates a table but leaves the handler intact still resolves:

- `YoshiPal` is the operand of `LDA.W YoshiPal,Y` at `$01:8342`, giving
  `$01:8335`.
- `MagiKoopaPals` is the operand of `LDA.L MagiKoopaPals,X` at `$01:C036`
  (bytes `BF 02 B9 03`), giving `$03:B902`.

The vocabulary the real distribution demanded:

| Field | Variants |
|---|---|
| `routine` | `sub0`, `sub1`, `sub2` |
| `tileGroup` (feeds `SpriteMisc1602`) | `const`, `frameIndex`, `table`, `tableViaOperand`, `shiftedTable` |
| `propGroup` (feeds `A` on entry to sub0) | same |
| `anim` | `static`, `effFrame{shift,mask}`, `spriteCounter{shift,mask}`, `stateTimer{seedOperandAddr}` |
| `extraParts` | `ExtraPart[]`, each with `char` / `dx` / `dy` / `gate` |
| `misc157C` | `faceMario`, `const`, `unwritten` |
| `palette` | `spriteTable`, `initTableByX`, `dynamicCgram` |
| `attrOverride` | `const`, `effFrameFlip{shl,andMask,orMask}` |
| `representativeFrame` + `needsHumanReview` | the deliberate human pick |
| `vanillaMainHandler` / `vanillaInitHandler` | identity |
| `evidence` | `SMWDisX file:line` |

`frameIndex` exists because `SetAnimationFrame` (bank_01.asm:2089) writes the
frame index directly into `SpriteMisc1602`, so for that family the walk cycle
and the tile selector are the same number. Conflating that with `const` was a
bug I introduced and the tests caught: `$4E` pins its tile group to `$03` and
animates purely through flip bits, so adding the frame would have walked it off
the end of its tilemap entry.

### Identity and degradation

`resolveIdentity` reads the ROM's own MAIN and INIT pointers and returns one
of three statuses.

- `vanilla`: both match the traced pointers.
- `remapped`: a pointer differs but points at another descriptor's KNOWN
  vanilla handler. This is an alias onto traced code, so the sprite can still
  be rendered using that descriptor. It is a real category, not a theoretical
  one: two of the three observed repoints target handlers that already exist in
  vanilla.
- `custom`: repointed to code nobody has read. The engine refuses and returns
  `{ kind: 'customHandler', expected, found }` so the editor can show "custom
  handler, appearance unverified".

Every failure is a returned value, never a silent fallback. The other three are
`noDescriptor`, `charsNotLoaded` and `romReadFailed`.

### The palette model

All three sources are modelled, and the partial-row case is first class.

- **(a) static.** `Sprite166EVals & $0F`, row `8 + ((attr >> 1) & 7)`,
  `charHigh = attr & 1`.
- **(b) init-routine override.** `$2C` Yoshi Egg indexes `YoshiPal` by
  `(SpriteXPosLow >> 4) & 3` in `InitYoshiEgg`, so its color is a function of
  the 16 px column it spawned in. Init routines never draw, which is exactly
  why this is easy to miss.
- **(c) runtime CGRAM DMA.** `$1F` Magikoopa writes 8 colors to CGRAM color
  index `$F0`, which is row 15 columns 0-7. Only HALF the row is overwritten,
  so the engine returns a `PaletteNote` telling the caller to composite:
  dynamic colors for `[firstCol, firstCol + colors)`, level palette for the
  rest. A whole-row model would be wrong here.

**Reconciliation needed.** The `dynamicCgram` variant's five fields are
deliberately structurally identical to `DynSpritePalette` on branch
`feature/sprite-1f-render` (`addr`/`colorsPerEntry`/`entryCount`/`cgramStart`/
`restingEntry`). I did not read that branch's implementation into mine and I
did not copy its files. On merge this should collapse to a type alias, not ship
as two implementations. The one difference is that mine stores `operandAddr`
rather than `addr`, and resolves the address from the instruction operand at
render time; that is a strict improvement and the merged type should keep it.

### Animation cadence

`ROM_FRAMES_PER_TICK = 125 / (1000 / 60) = 7.5`, converted once, centrally.
Every animation is expressed in GAME frames. A descriptor states a shift and a
mask; `animPeriodFrames` reports the period. `SpikeTopAppearance`'s
`ANIM_TICKS = 8` counted in editor ticks is about 7.5x too slow and was
deliberately not copied and not fixed here.

One correction found while testing: `effFrameFlip` must wrap to 8 bits, because
the `ASL`s happen in the accumulator. Without the mask `$4E`'s flip bits stop
cycling and the sprite freezes in one pose. `(EffFrame << 2) & $C0` is
algebraically `(EffFrame & $30) << 2`, so `$4E`'s four poses are driven by
EffFrame bits 4-5: one pose every 16 game frames, 64 for the full rotation.

### Facing is a render-time input

`SpriteRenderContext { marioX, romFrame }` is resolved per render. No resolved
flip is baked into a descriptor, so changing Mario's position costs one flip
recomputation per sprite: no appearance rebuild, no ROM re-read, no GFX
re-decode. A test asserts zero `readAt` calls across four Mario positions.

Polarity, verified rather than assumed. `SubHorizPos` (bank_01.asm:6124)
leaves `Y = 0` when `(Mario - Sprite) >= 0`, so `Y = 0` means Mario is at or
RIGHT of the sprite and `Y = 1` means left. `FaceMario` (bank_01.asm:847)
stores that straight into `SpriteMisc157C`. Both draw routines skip the flip on
`BCS`, so **X-flip is applied when the latch is CLEAR**. A sprite whose handler
never writes the latch therefore renders FLIPPED, which is precisely why
hardcoding `flipX: false` is wrong rather than merely incomplete.

**Caveat, stated not solved.** `marioX` normally comes from the level's main
entrance, but a map can be entered from a midway point, a pipe, or a door in
another map. This is the right derivation for a static editor view and an
approximation of gameplay. Making it a runtime input is what lets "which
entrance am I previewing from" become a UI choice later rather than a wrong
assumption baked into the data now. No multi-entrance handling was built.

### The render entry point

`renderSpriteFrame(rom, tables, spriteId, level, { frame? })` is pure, lives in
`src/rom/`, and requires no map, no placement and no sprite instance. It serves
three consumers without being specialised to any: the map render, sprite picker
thumbnails, and annotations such as the translucent emerged-mole ghost, which
needs a specific frame that is neither frame 0 nor the in-place frame. It
defaults to `representativeFrame`. `renderRepresentativeFrame` is a thin alias.

`SpriteLevelContext { spriteSet, loadedChars }` makes the call
level-contextual, and a sprite whose chars are absent from the level's SP1-SP4
assignment is reported as `charsNotLoaded` rather than rendered as garbage.

## 3. Descriptor coverage and the divergence result

> **STALE AS WRITTEN.** This section describes the five bespoke descriptors
> that existed when it was written. `45e9e1e` added the eleven-member
> `Spr0to13Gfx` walk family, bringing the total to sixteen, and two of the
> five verdict rows below stated the shipped path's output wrongly. Both are
> corrected in place. The live version of this table is `ADJUDICATION` in
> `SpriteEngineEquivalence.test.ts`, which runs.

Five descriptors were traced individually first: `$14`, `$1F`, `$2C`, `$4D`,
`$4E`. This was deliberately narrow. Per the brief's priority order I chose a
small, well-evidenced set over a wide shallow pass. The walk family followed
once the mechanism held.

The harness (`test/suite/unit/sprites/SpriteEngineEquivalence.test.ts`) is
committed, runs against all six ROM files, and compares the engine's output against
the shipped `buildSpriteLayout` path field by field (chars, positions, flips,
palette row) **for every frame of the descriptor**, not just frame 0.

**All five diverge, and in all five the engine is right.** So do all eleven
walk descriptors; section 10 covers those.

| ID | Verdict | Reason |
|---|---|---|
| `$14` Spiny egg | ENGINE_WINS | Frame 0 AGREES: the shipped path already classifies `$14` as sub0 with prop group 2. The divergence is the SECOND frame. `SpinyEgg` (bank_01.asm:1814) reaches `SubSprGfx0Entry0` via `SetAnimationFrame`, which writes `(counter >> 3) & 1` into `SpriteMisc1602`; the shipped path pins that to 0, so the walk cycle is unrepresentable. |
| `$1F` Magikoopa | ENGINE_WINS | **Corrected.** Draws through `SubSprGfx1` (bank_01.asm:8529), which is 16x32 and eight subtiles, and `buildSpriteLayout` emits eight as well; the claim that it emitted a single 16x16 quad was wrong. The three real divergences are the ANCHORING, because `$1F` has no pre-`JSR` Y adjust so its body starts at the sprite's own Y where the shipped path puts every 16x32 16 px higher; the wand (bank_01.asm:8545-8578); and the partial-row CGRAM composite the shipped path cannot express. |
| `$2C` Yoshi Egg | ENGINE_WINS | Takes its OBJ attribute from `YoshiPal` indexed by spawn column in `InitYoshiEgg` (bank_01.asm:463-474). The shipped path reads `Sprite166EVals` and hardcodes `flipX: false`, which the `EOR` on the sub2 path contradicts. Its CHAR comes from the `LDA #$00` at bank_01.asm:16060, which overwrites what the routine read, so BOTH paths originally read a tilemap the ROM discards; see 11.2. |
| `$4D` Monty Mole | ENGINE_WINS | `CODE_01E343` (bank_01.asm:13388) selects `SpriteMisc1602` from `DATA_01E35F` and the prop group from `DATA_01E361`, both indexed by `(EffFrame >> 4) & 1`. The shipped path pins `SpriteMisc1602` to 0, which is neither of the two frames the ROM ever draws. |
| `$4E` Monty Mole on ledge | ENGINE_WINS | `CODE_01E343` routes `$4E` to `SubSprGfx2Entry1` with `SpriteMisc1602 = $03` and an attribute override of `((EffFrame << 2) & $C0) | $31`. The shipped path classifies it as sub0 and drops the override. `$4E` is a ONE-TILE sprite whose four poses come from rotating the hardware flip bits. |

Engine output is identical across all six ROM files for these sprites, as it must
be given the data tables are byte-identical.

### The number that decides whether full replacement is viable

**Coverage counted in descriptors is not that number, and I will not dress it
up as one.** What the inventory below measures is a better predictor.

The raw count has moved twice and says little either way: five descriptors
when this was written, sixteen after `45e9e1e`. Counted in PLACEMENTS across
the vanilla ROM's 512 level slots the picture changes again, because the
eleven walk ids account for 297 of them against the bespoke five's 42. That
census is in `docs/sprites/sprite-engine-wiring.md`.

## 4. Inventory of the 40 classes

Measured, not estimated.

### Corrected appearance / annotation split

| Measure | Appearance | Annotation | Annotation share |
|---|---|---|---|
| Prior estimate | 4700 | 570 | 10.9% |
| Strict (overlay methods + overlay-only module helpers) | 4009 | 1236 | 23.6% |
| Full (+ overlay-only imports and doc) | 3652 | 1593 | 30.4% |

The prior figure is low by 2.2x to 2.8x. The gap is almost entirely
overlay-only MODULE-LEVEL code that sits outside `renderOverlay` and reads as
ROM derivation at a glance: `SwimJumpFishAppearance`'s 96-line physics
simulator, `SpikeTopAppearance`'s 61-line wall-follow tracer,
`SumoBrotherAppearance`'s 48-line flame-footprint drawer,
`HammerBroPlatformAppearance`'s 34-line path integrator. 254 lines that
counting `renderOverlay` bodies alone does not find.

Nine classes are majority annotation and carry essentially zero unique ROM
appearance data: `HopFlame`, `MontyMole`, `CarrotTopLift`, `SwimJumpFish`,
`JumpingPiranha`, `Blurp`, `CheepCheep`, `Koopa`, `JumpingFish`. They are
`StaticSpriteAppearance` plus an annotation and collapse to a row of the form
`{ id, overlayKind, overlayParams }`.

### Shape distribution

| Shape | Count |
|---|---|
| STATIC_QUAD | 11 |
| N_FRAME | 3 |
| MULTI_PART, static | 10 |
| N_FRAME and MULTI_PART | 8 |
| TALL 16x32 | 1 |
| WIDE 32x32 | 1 |
| Other (2x 8x8, 64x64, strips) | 4 |
| Infrastructure | 3 |

### The axes that decide the format

| Axis | Count of 40 |
|---|---|
| Hardcodes tile literals in TypeScript | **24** |
| Reads tiles from ROM `SpriteTileTables` | 16 |
| Position-dependent input | 21 |
| Palette override (14 full, 5 partial) | 19 |
| Per-frame or per-part prop group | 11 |
| Implements `renderOverlay` | 20 |

**24 of 40 hardcode tile numbers in TypeScript.** That is the strongest single
argument for this engine, and a better answer to "does full replacement pay"
than the 5-of-40 coverage figure. Those 24 are pinned to vanilla by
construction: a hack that retunes a tile table renders wrong and the editor has
no way to know.

### Deliberate editor choices, which must survive migration as data

| Category | Count | Examples |
|---|---|---|
| 1 Representative frame | 11 | `ClappinChuck` "the most distinctive frame at editor scale"; `PuntinChuck` kick wind-up `$11`; `WhistlinChuck` freezes the cycle at `Misc151C = $05` |
| 2 Staged composition | 9 | `PitchinChuck` baseball at +/-20 px "so the editor conveys the throw"; `Wiggler`'s invented 8 px segment layout; five classes preferring a Mesen capture over the algebraic ASM result |
| 3 Runtime-state default | 16 | `Thwomp` and `RipVanFish` use `editorStore.cursorPx` as a Mario stand-in; `SuperKoopa` freezes airborne from a single L1 probe |

Facing is explicitly NOT in category 3. It is derivable and the engine derives
it, uniformly, from one place. Only 11 of the 40 currently use `marioStartPx`
at all.

Ten **undocumented runtime dependencies** were found, where live state is
consumed with no stated default. The three worth acting on first:

- `SpikeTopAppearance` hardcodes direction 0 for its pixels while its own
  `renderOverlay` computes direction from `mapStore.marioSpawnX`. The sprite
  and its annotation can contradict each other and nothing says so.
- `VolcanoLotusAppearance` ships two of the ROM's three `VolcanoLotusTiles`
  entries. Why `$E2` is dropped is nowhere stated.
- `BallAndChainAppearance` hardcodes `+16/+32/+48/+64` dy with no theta
  parameter, so the orbit angle is structurally unrepresentable.

### Two structural findings

1. **The rehydrate path silently loses 10 subclasses.** `SpriteFactory`
   constructs `KeyholeAppearance`, `BanzaiBillAppearance` and all seven
   `*ChuckAppearance` classes, but none appear in
   `AppearanceFactory.buildSpriteAppearance` or in `rehydrate`'s `kind` switch.
   They serialize as `{kind:'static'}` and rehydrate as bare
   `StaticSpriteAppearance`. Harmless today because none has an overlay or
   animation; it bites the first time one gains a `renderOverlay`. This is
   exactly the dual-registration gap issue #293 was meant to close.
2. **Six `AppearanceFactory` entries are host-unreachable.** IDs `$27`, `$30`,
   `$32`, `$9A`, `$9B`, `$9E` are intercepted by earlier `SpriteFactory`
   branches, so they only fire on the webview rehydrate path. The two paths
   build the same classes by different routes (`fromTables` on host, raw
   constructor or `fromParts` on webview), a real divergence risk for any class
   whose constructor derives state.

## 5. The seam between appearance and annotation

Not performed in Phase 1, as instructed. What it should look like:

`renderOverlay` currently lives on the `SpriteAppearance` interface, which is
the only reason these two jobs look like one problem. The clean split is a
separate `SpriteAnnotation` interface holding `renderOverlay` and its
supporting simulations, keyed by sprite ID in its own registry, with the
`Appearance` reduced to "produce parts for frame N". `SmwMap` already calls
`renderSpriteOverlays` as a distinct pre-pass, so the call sites are already
separated; only the interface is not.

The engine is designed to that split: it makes no editorial decision, and
`renderSpriteFrame`'s frame selector is what lets an annotation layer request
the pixels it needs (the emerged-mole ghost reduces to roughly
`{ sprite: $4D, frame: emerged, dy: -16, alpha: 0.5, hitTest: false }`) without
keeping a private tile-reading path.

**Do not duplicate `SpriteAppearance.renderAboveL1?()`.** It exists on the
sibling branch as a second `RenderTarget` pass run after L1 priority tiles and
before L3, because `OverlayContext` is Canvas2D and cannot blit tile pixels. It
is general. My engine does not add an above-L1 pass and should consume that one.

## 6. Verification

> **NUMBERS SUPERSEDED.** The suite has grown considerably since this was
> written. Take test counts from a run, not from here. The METHOD, including
> the mutation table below, still describes how verification is done.


| Step | Result |
|---|---|
| Baseline `npx vitest run` at `870fa29` | 144 files passed, 2 skipped; **2387 tests passed**, 8 skipped; exit 0 |
| `npx tsc --noEmit` | clean |
| `npx eslint src --ext .ts` | 0 errors, 14 pre-existing warnings, **none in the new files** |
| `npx webpack --mode development` | compiled successfully |
| `npx vitest run` after | 146 files passed, 2 skipped; **2434 tests passed**, 8 skipped. +47 tests, no regressions |
| Suite with `test/roms/` moved aside | 133 passed, 15 skipped; **2234 passed**, 122 skipped. No collection-time failure. Restored afterwards |
| Engine exercised against all 6 ROM files | yes, in the committed harness |
| Degradation on a genuinely repointed handler | yes, `$9B` on Grand Poo World 2 |
| `git status` | clean apart from the new files |

All ROM I/O is inside `it()` bodies. Only `existsSync` runs at module scope,
because `describe.skipIf` does not guard a describe body during collection.

### Mutation table

Each mutation applied with `sed`, grep-confirmed, run, then restored by copying
back a file saved outside the repo. No `git checkout` was used.

| # | Mutation | Result |
|---|---|---|
| M1 | `$4D` tile-group table address `0x01E35F` -> `0x01E360` | **1 failed** |
| M1b | `$4D` prop-group table address `0x01E361` -> `0x01E362` | **1 failed** |
| M2 | `SpriteMisc1602` pinned to 0 | **5 failed** |
| M3 | `flipX` forced false on the latch path | **8 failed** |
| M4 | Cadence conversion removed, 7.5 -> 1 | **2 failed** |
| M5 | Handler-identity check disabled, `custom` -> `vanilla` | **1 failed** |
| M6 | sub2 ignores the `misc1602` stride | **1 failed** |

M1 initially turned **nothing** red. The exact-divergence-set assertion is too
coarse to catch a wrong table ADDRESS, because an off-by-one still lands on a
byte that keeps `$4D` in the diverging set. A test was added pinning `$4D`'s
per-frame tile stride and prop groups directly, with expectations stated from
the ASM trace and cross-checked against the INDEPENDENT tilemap table rather
than read from the table under test. That closed M1 and M1b. Recording this
because a mutation that turns nothing red is the finding, not a formality.

## 7. What I could not verify, and what is left

> **SUPERSEDED** by 9.4 and 13.1, which are the maintained lists of declared
> hack-fragility points. Several items here have since been converted to ROM
> reads.


- **No emulator.** Every claim is a static trace over a five-ROM corpus. Nothing
  is confirmed against running hardware.
- **Visual check is partial.** I rendered `$4D`'s quad with
  `render_sprite_frame`. Under GFX02 it composes into a coherent creature and
  under GFX05 it clearly does not, which is consistent with the slot maths, but
  I could not confirm the exact slot and palette for a specific level without
  wiring the level context. Treat the visual confirmation as suggestive, not
  conclusive.
- **`SubSprGfx1Hlpr1` is unmodelled.** A `SubSprGfx1` entry whose
  `SpriteOBJAttribute` has bit 7 set diverts there. No descriptor in the
  current set reaches it.
- **`spriteCounter` phase is unknowable.** `SetAnimationFrame` counts a
  per-sprite counter that starts at spawn. The period is exact; the phase in a
  still editor is not. The engine treats it as free-running from 0.
- **No round-trip branch was added**, because Phase 1 adds no new state to
  `MapPayload`. What the eventual `serialize`/`rehydrate` branch depends on is
  that a descriptor is plain JSON-able data carrying the RULE and its inputs
  rather than a resolved boolean, so the webview can recompute facing locally
  when Mario moves. A test locks that property: a JSON round-trip produces
  byte-identical parts at two Mario positions, and the serialized form contains
  no `flipX` or `faceRight`.
- **`$4D` and `$1F` differ from this branch's base on purpose.** Newer,
  reviewed versions exist on `feature/monty-mole-render` and
  `feature/sprite-1f-render`, which were not read into this work.
- **Representative frames are mostly unreviewed.** Only `$4D` has a reviewed
  pick. The other four are flagged `needsHumanReview: true`. The 11 harvested
  choices in section 4 have been inventoried but NOT yet transcribed into
  descriptors, because those sprites do not have descriptors yet. That
  transcription is the obvious next task and it is cheap.
- **Coverage is 5 of 201 and 5 of the 40 bespoke classes.** Extending it is
  per-sprite ASM tracing at roughly the rate of this report's five.

## 8. Two format gaps found by looking at $1F on screen

> **HISTORICAL.** The derivation is sound and worth reading. Its lists of
> what is "still a literal" are superseded by sections 9, 11 and 13: the
> routine choice, the bob, the resting palette entry and several others have
> since been converted to ROM reads.


Phase 1 shipped with a green suite and `$1F` Magikoopa rendered wrong in three
visible ways. None of the three was a missing descriptor. All three came from
one root cause, stated here because it predicts where the next gap will be:

> **The descriptor modelled what the SHARED DRAW ROUTINE READS. It did not
> model what the HANDLER COMPUTES AROUND THAT ROUTINE.**

`SubSprGfx1` reads `SprTilemapOffset`, `SpriteMisc1602`, `SpriteMisc157C` and
`SpriteOBJAttribute`, and the format had a field for each. Everything the
handler does before or after the `JSR` was invisible to it.

Evidence scope for this section: every ROM address below was read out of the
six ROMs in `test/roms/` with `xxd` and matched against the disassembly
instruction by instruction, not copied from an earlier summary. All six ROMs
agree byte for byte at every address named. No emulator was run.

### The $1F state-2 handler, traced

`Magikoopa` (`bank_01.asm:8413`, `$01:BDD6`, which is what the MAIN pointer
table holds at entry `$1F`) dispatches on `SpriteTableC2 & 3` into a 4-entry
table at `bank_01.asm:8421`. Only state 2, `CODE_01BE6E` (`bank_01.asm:8493`),
is modelled: states 1 and 3 are a teleport fade with no clock the editor can
follow, and state 0 does not draw.

State 2 does three things around its `JSR SubSprGfx1` at `bank_01.asm:8529`:

| Lines | What | Modelled as |
|---|---|---|
| 8513-8528 | tile group from the countdown timer via a ROM table | `anim: stateTimer` + `tileGroup: shiftedTable` |
| 8530-8539 | nudge the TOP OAM entry down 1 px on one pose | **not modelled**, see below |
| 8545-8578 | write a whole extra OAM entry for the wand | `extraParts` |

### Gap 1: OAM the handler writes itself

`bank_01.asm:8545-8578` writes a full OAM entry at slot `+$108`, behind the
body's `+$100` and `+$104`. The descriptor had no way to say "and one more
tile over here", so the engine emitted 8 subtiles and stopped, and the wand
was simply absent.

The wand is not a detail. Its X is `SpriteXPosLow` plus a displacement from
`DATA_01BE6C` indexed by `SpriteMisc157C` (`ADC.W DATA_01BE6C,Y` at
`bank_01.asm:8551`, operand at `$01:BEDC`), and that table is two bytes: one
puts the wand a full 8 px tile clear of the body's LEFT edge, the other a full
16 px clear of its RIGHT edge. A bounding box derived from `SubSprGfx1`'s own
eight subtiles clips it either way.

The new `ExtraPart` carries `char`, `dx`, `dy`, an `oamSlot` and an optional
`gate`, all of them addresses rather than values:

| Field | Source kind | ROM address | Instruction |
|---|---|---|---|
| `char` | `immediateAt` | `$01:BF05` | `LDA #imm`, `bank_01.asm:8570` |
| `dx` | `tableByMisc157C` | operand `$01:BEDC` | `ADC.W DATA_01BE6C,Y`, `bank_01.asm:8551` |
| `dy` | `immediateAt` | `$01:BEEE` | `ADC #imm`, `bank_01.asm:8560` |
| `gate` | `tileGroupAtLeast` | `$01:BED2` | `CMP #imm : BCC`, `bank_01.asm:8546-8547` |

Two decisions worth stating, because both could reasonably have gone the
other way.

**Offsets are in the routine's own `_0`/`_1` frame**, which is where the
handler's `ADC` immediates are expressed. The engine then applies the same
base translation it gives the routine's first OAM entry (`ROUTINE_BASE_DY`:
`-$10` for `sub1`, 0 for `sub0` and `sub2`). So the descriptor holds the
number the ASM holds, and the part lands correctly relative to the body
whatever anchoring convention the routine uses. A test pins the wand to the
bottom large OBJ's top row rather than to a literal `dy`.

**A flipped extra part is NOT mirrored a second time.** `DATA_01BE6C` is
indexed by the same latch that decides the flip, so the table already encodes
both positions. Mirroring `dx` on top of that would put the wand inside the
body. A test asserts the char is identical both ways and only `dx` changes.

### Presence versus position: reconciling the ASM with the reference art

The reference art shows three poses and the wand is visible in all three, but
`bank_01.asm:8545-8547` gates the extra OAM entry on the tile group, so on the
face of it the wand should vanish on two of the four state-2 poses. Both
readings are correct, and the tilemap says why.

`SprTilemapOffset[$1F]` is `$73`, and `SubSprGfx1` reads
`SprTilemap[$73 + Misc1602 * 2]`. The reachable state-2 values give only TWO
distinct body tile pairs: tile groups `$02` and `$03` share one pair, groups
`$04` and `$05` share another. Rendering both pairs with `render_sprite_frame`
against GFX03 settles it:

- groups `$04`/`$05`: the cast pose, arm extended, and the wand tip is the
  separate `+$108` tile a full 8 px clear of the body.
- groups `$02`/`$03`: the turned, hunched wind-up pose, with the wand drawn
  IN the body tilemap, held in close and entirely inside the 16x32 box.

So what varies between poses is whether the wand needs its own OAM entry, not
whether the sprite is holding it. The gate is a presence gate on the EXTRA
PART and the art is continuous, which is why the reference shows three poses
all carrying a wand while the ASM only draws two wand tiles. The third pose
described is tile group `$02`/`$03`, not a state this engine fails to model.

The consequence for the format is that `$1F` needs a per-frame GATE and a
per-direction OFFSET, and that is what shipped. A per-frame offset table is
genuinely needed elsewhere, just not here: see the wings, below.

### Extents: union across frames, not per frame

Because the wand is outside the body's box on two poses and inside it on the
other two, any box derived from one frame is wrong on the others. The engine
exports `unionExtents`, and `EngineSpriteAppearance` computes its marker box
once as the union over every frame at that sprite's own X, then caches it.

Per-frame was the other choice, and it is the trap PR #326 hit for `$4D`'s
annotation: a rect that changes size as the animation plays makes selection
and hit-testing flicker, and a rect taken from the resting frame clips the
pose that reaches furthest. The union is stable and never clips. The X matters
and is not incidental: facing decides which side the wand is on, so a union
over BOTH facings would be twice as wide as anything ever drawn.

`EngineSpriteAppearance.hitRect` still delegates to the shipped appearance, on
purpose, so selection behaviour does not change with the toggle. When the
engine becomes the only render path, the union is what `hitRect` should
return.

### Who else needs extraParts

Scanning every `JSR SubSprGfx*` in banks `$01`-`$04` for a full extra OAM
entry written at a slot past the routine's own turns up three handlers besides
`$1F`:

| Site | Shape |
|---|---|
| `DryBonesAndBeetle`, `bank_01.asm:13520` | extra entry at `+$104` after `SubSprGfx2Entry1`: dx from `DATA_01E43C` indexed by `SpriteMisc157C` (`bank_01.asm:13559`), dy copied from the body (`13562-13563`), attr copied from the body (`13564-13565`), gated on `SpriteMisc1534` (`13533-13534`) |
| `CODE_01E3EF`, `bank_01.asm:13495` | same family, second entry point |
| `CODE_01980F`, `bank_01.asm:3318` | extra entry at `+$104`; not traced to a sprite ID |

`DryBonesAndBeetle` is a genuine second user and is structurally the same
sprite-shaped hole: same `tableByMisc157C` offset source, same "attribute
inherited from the body", same per-state gate. It needs one source this branch
did not add, because its extra tile is the body tile minus one rather than an
immediate. That is a `bodyTileRelative` char source and it should be added
when its descriptor is written, not speculatively now.

The much bigger consumer is the WING family, which this scan missed because
those routines bump `SpriteOAMIndex` instead of using a fixed `+$1xx` offset:

- `KoopaWingGfxRt` (`bank_01.asm:4024`), called from `Spr0to13Gfx` at
  `bank_01.asm:1788` for sprite ids at or above `$08` on the 16x32 branch. On
  the vanilla ROM that is `$08`, `$09`, `$0A`, `$0B`, `$0C`: five sprites,
  read from `Spr0to13Prop` at `$01:88F0`, bit 6 set and id at or above `$08`.
- `GoombaWingGfxRt` (`bank_01.asm:2022`), called from `CODE_018DAC`
  (`bank_01.asm:1992`).

The wings index `KoopaWingDispXLo`, `KoopaWingDispY`, `KoopaWingTiles`,
`KoopaWingGfxProp` and `KoopaWingTileSize` by `(SpriteMisc157C << 1) + frame`
(`bank_01.asm:4044-4047`). Covering them needs three things `ExtraPart` does
not have yet: an offset source indexed by BOTH facing and frame, a per-part
attribute source, and a per-part 16x16 size flag. That is a real per-frame
offset requirement, and it is the reason to expect this kind to grow. It would
also delete `WingedSpriteAppearance`.

**Flying coin and 1-Up wings ($7E, $7F; #636).** Both call `CODE_019E95`
(`bank_01.asm:4083-4142`) from `CODE_01C27C` (`bank_01.asm:9040-9041`); the
other caller is `bank_01.asm:6187`. Position arithmetic, read from the routine:
it saves, then moves the sprite to (X-2, Y+2) (`4084-4101`), zeroes
`SpriteMisc157C` and takes the frame from `SpriteMisc1570` (`4107-4116`), draws
the left wing, moves X by +4, sets `SpriteMisc157C` to 1 (`4117-4129`), draws
the right wing, and restores everything. Frame 0 reads `KoopaWingDispXLo` /
`KoopaWingDispY` / `KoopaWingTiles` / `KoopaWingGfxProp` (`bank_01.asm:4006-4019`)
at index 0 for the left wing (dx $FF, dy $FC, tile $5D, prop $46, X flip) and
index 2 for the right (dx $09, dy $FC, tile $5D, prop $06). So the left wing
lands at X-3 and the right at X+11, both at Y-2 relative to the sprite
position. `test/suite/unit/sprites/FlyingCoinWings.test.ts` asserts those
offsets; evidence scope: the served interpreter on the vanilla ROM, three slots,
frame 0, one machine.

**Estimate.** Of the 201 sprite slots, the handlers that write extra OAM
around a shared routine are: `$1F`, the Dry Bones / Bony Beetle family, the
five winged `Spr0to13` ids, the winged Goomba, and one untraced site. Call it
roughly ten sprites, or about 5%, with the wings dominating. A small minority,
but not a one-off, and every one of them renders visibly incomplete without
it.

### Gap 2: a state timer driving a table lookup

`anim` had `effFrame` and `spriteCounter`, both FREE-RUNNING power-of-two
cycles. `$1F`'s pose comes from `SpriteMisc1540`, a ONE-SHOT COUNTDOWN:
`CODE_01C004` seeds it with `LDA #imm` at `bank_01.asm:8729` (operand
`$01:C023`) when the fade-in ends, and the sprite counter block decrements it
once per game frame and floors it at zero (`bank_01.asm:157-159`). State 2
ends when it reaches 0 (`bank_01.asm:8499-8501`).

`CODE_01BE96` (`bank_01.asm:8513-8528`) then turns it into a tile group: six
`LSR`s give a pose-table index, three more `LSR`s and an `AND #$01` give a
sub-pose bit, and the two are combined with `ORA.W DATA_01BE69,Y` at
`bank_01.asm:8527` (operand `$01:BEA7`).

Unrepresentable, so the descriptor said `anim: static` with `tileGroup:
{const, 0}`. Tile group 0 is what state 1 forces (`STZ SpriteMisc1602` at
`bank_01.asm:8482`), so the engine was rendering the FADE-IN pose, not any of
the poses state 2 actually shows.

Two kinds close it, and they compose with the existing split between "what
produces the frame index" and "what turns the index into a tile group":

- `anim: { kind: 'stateTimer', seedOperandAddr }`. The frame index IS the
  timer value and it runs from the seed down to 0. The seed is read from the
  ROM, so a hack that retimes the state animates at the retimed rate.
- `tileGroup: { kind: 'shiftedTable', operandAddr, operandBank, shift,
  orBitShift? }`, giving `table[index >> shift]` optionally ORed with
  `(index >> orBitShift) & 1`.

`animPeriodFrames` and `frameIndexAt` take the seed as an extra argument
rather than a `RomFile`, so the cadence functions stay pure and the one ROM
read lives in `drawSpriteParts`. A seed that cannot be read is a failure, not
a silent fall back to frame 0.

### Who else needs stateTimer and shiftedTable

Scanning banks `$01`-`$04` for `STA.W SpriteMisc1602` preceded within 18 lines
by a countdown timer, an `LSR` chain and a `DATA_*,Y` read gives eight sites.
One is a false positive and was discarded by opening it: `bank_03.asm:8892`
indexes its pose table by `SpriteMisc1528`, a value `GetRand` produced
(`bank_03.asm:8882-8886`), and SEEDS the timer at `bank_03.asm:8889` rather
than reading it. That leaves six users besides `$1F`:

| Site | Index into the pose table |
|---|---|
| `CODE_01BE96`, `bank_01.asm:8513-8528` | `SpriteMisc1540 >> 6`, ORed with bit 3. This is `$1F` |
| `SpringBoard`, `bank_01.asm:13797-13809` | `SpriteMisc1540 >> 1` |
| `CODE_01FC2A`, `bank_01.asm:16700-16708` | `SpriteMisc1564 >> 3` |
| `CODE_02C3CB`, `bank_02.asm:9041-9049` | `((SpriteMisc1540 - $40) >> 3) & 3` |
| `CODE_02C43A`, `bank_02.asm:9060-9073` | `SpriteMisc1540 >> 2` |
| `CODE_039D41`, `bank_03.asm:3781-3803` | `SpriteMisc1540 >> 3`, plus `$20` in one state |
| `CODE_03CDC7`, `bank_03.asm:8963-8983` | `(SpriteMisc1528 << 4) \| (SpriteMisc1540 >> 2)` |

Only `$1F` uses the `orBitShift` form; the other six are the plain shifted
lookup, which is why that field is optional. Three of them need something
`shiftedTable` does not express yet: a constant added to the index
(`bank_02.asm:9042`, `bank_03.asm:3798`), a mask after the shift
(`bank_02.asm:9046`), and a composite index built from a second per-sprite
value (`bank_03.asm:8975-8980`).

**Estimate.** Seven handlers, so on the order of a dozen sprite ids once the
families behind those labels are counted, or roughly 5%. `stateTimer` is the
narrower of the two: `spriteCounter` and `effFrame` still cover the large
majority of animated sprites. But it is not a one-off either, and where it
applies the current format does not merely approximate the sprite, it renders
a pose from a different state.

### The third defect: the palette was already right, the wiring ignored it

`$1F` rendered magenta because `EngineSpriteAppearance` drew every part with
`mapStore.palette.row(p.palette)` and threw away the `dynamicCgram`
`paletteNote` the engine had already computed. The fix was small and is
included: read the resting entry's BGR555 words from the ROM once, convert,
and splice them over columns `[firstCol, firstCol + colors)` of the level row.

The splice, not a replace, is the point. `CODE_01C028` writes a 2-byte header
of `$10` then `$F0` (`bank_01.asm:8752-8755`): `$10` bytes is 8 colors, and
`$F0` is a CGRAM COLOR index, not a byte address, because `CODE_00A488`
writes it straight to `HW_CGADD` (`bank_00.asm:4735`). So only row 15 columns
0 to 7 are overwritten and columns 8 to 15 still come from the level palette.
A test asserts both halves.

### What is still divergent

- **The 1 px top-tile bob is not modelled.** SUPERSEDED BY SECTION 9, which
  adds the `TileNudge` kind and reads the whole thing out of the ROM. Leaving
  the original entry here because its reasoning was wrong in an instructive
  way: it called the displacement an unreadable constant, when `$FE` is an
  opcode and opcodes are readable bytes. `bank_01.asm:8530-8539` nudges only
  the `+$100` entry down one pixel, and only when the tile group minus 2 is at
  least 2 and odd, which in state 2 means tile group `$05` alone. It is the
  ONLY observable effect of the OR bit on the vanilla ROM: groups `$04` and
  `$05` select the same tile pair, so while the bob was unmodelled, dropping
  the OR bit changed no pixel. Section 9 inverts that test rather than
  deleting it.
- **`sub1` anchoring.** The engine puts a `sub1` sprite's top tile at
  `dy = -$10`, which is the `Spr0to13Gfx` convention: that caller subtracts
  `#$0F` from `SpriteYPosLow` around its `JSR` (`bank_01.asm:1769-1784`).
  `$1F` has no such wrapper, so on hardware its body sits below the spawn row,
  not straddling it. The wand is expressed relative to the routine's own frame
  and so is correct RELATIVE to the body either way, but the whole sprite is
  16 px high on the map. Ten other `sub1` ids may share this and none have
  been traced.
- **States 1 and 3 are not drawn.** The editor shows the state-2 cast cycle
  looping. On hardware state 2 ends at timer 0 and hands over to the fade-out.
- **The CGRAM splice is per sprite, not global.** In game the upload changes
  CGRAM for every OBJ-palette-7 sprite on screen. The editor applies it only
  inside `$1F`'s own render, which is the right thing to show before any
  Magikoopa has teleported in, and a divergence from the post-fade state.
- **The routine choice was a descriptor literal.** Superseded by section 9:
  it is now read from the handler's own `JSR` target.
- **`restingEntry` is still a literal 7.** `feature/sprite-1f-render` resolves
  it from the ROM instead, by reading the immediate of the `CMP #$09` at
  `$01:C01C` and subtracting 2. That is the better design and this branch does
  not adopt it, because changing `dynamicCgram` is outside the two kinds this
  work was scoped to. Note carefully which `CMP #$09` it is: there are two,
  eight bytes apart, and only `$01:C01C` gates the branch to the palette
  upload at `$01:C028` (`bank_01.asm:8726-8727`). The one at `$01:C014` gates
  `ColorSettings` (`bank_01.asm:8722-8725`) and happens to hold the same
  immediate in vanilla, so anchoring there is right for the wrong reason and
  would be invisible until a hack shortened the fade.
- **`BooBossPals` contends for the same CGRAM window.** The Big Boo boss
  uploads with the same header (`bank_03.asm:336-339`), so `$1F` and
  `$C5`/`$C6` cannot both show their runtime palette at once on hardware.
  `PaletteNote` has no field for that.

### Where the next gap will be

The root cause is a predictor, not just an explanation. Anywhere a handler
does work around its `JSR` and that work is not one of `SprTilemapOffset`,
`SpriteMisc1602`, `SpriteMisc157C` or `SpriteOBJAttribute`, the descriptor is
silently modelling a different sprite. The three known categories are: extra
OAM entries (covered), per-entry position adjustments like the bob
(uncovered), and per-entry attribute or size overrides like the wings
(uncovered). A sweep for `STA.W OAMTile*`, `INC.W OAMTile*` and
`SpriteOAMIndex` arithmetic inside handlers that also call a shared routine
would enumerate the rest, and is the cheapest way to size the remaining work.

### Verification of this section

`npx tsc --noEmit`, `npx eslint src`, `npx webpack --mode development`,
`npx vitest run`: 2530 passed / 8 skipped, up from 2450 / 8 at `f1afbd6`. With
`test/roms/` moved aside: 2247 passed / 197 skipped, 0 failed.

Sixteen defects were planted in the engine and appearance sources, one at a
time, each restored by copying back a file saved outside the repo. No
`git checkout` was used.

| # | Planted defect | Result |
|---|---|---|
| M1 | extra parts dropped from the part list | 40 failed |
| M2 | extra-part offset not sign-extended | 19 failed |
| M3 | `sub1` extra-part base dy changed from `-$10` to 0 | 6 failed |
| M4 | gate comparison off by one | 8 failed |
| M5 | state timer counts UP instead of down | 2 failed |
| M6 | extra part drawn in FRONT of the body | 6 failed |
| M7 | `orBitShift` ignored | 1 failed |
| M8 | `shiftedTable` ignores `shift` | 12 failed |
| M9 | unreadable timer seed tolerated | caught by `tsc` |
| M10 | `unionExtents` uses the first frame only | 2 failed |
| M11 | composite window one color short | 1 failed |
| M12 | dynamic palette never loaded | 1 failed |
| M13 | composite overwrites the whole row | 2 failed |
| M14 | dynamic colors read big-endian | 1 failed |
| M15 | extra-part char source ignored | 6 failed |
| M16 | gate always passes | 13 failed |

M15 initially turned nothing red. The oracle was "the wand char is not one of
the body chars", which a planted char of 0 satisfies. It was replaced with one
that re-reads the immediate from the ROM at the address the descriptor points
at, so what is pinned is that the engine read it, and read it from the right
place. Recording this because a mutation that turns nothing red is the
finding, not a formality.

Two further mutants were tried and DISCARDED as unkillable rather than left in
the table: both targeted a per-part palette-row check in `rowFor` that guarded
a case `drawSpriteParts` cannot produce, since every part of one call carries
the same row. The check was deleted instead, and a ROM test now asserts the
invariant that makes deleting it safe.

`render_sprite_frame` was used to look at both tile pairs and both facings
against GFX03 before any of this was called correct.

## 9. Reading the handler instead of deriving from it

Pillar 1a of `CLAUDE.md` draws the line: the ASM is reference for tracing how
graphics are composed, not a source to derive logic from and then hardcode,
because a hack can invalidate any such derivation. If HackBench can interpret
the ROM directly it must, and no further.

The engine was on the wrong side of that line in four places, all of them on
`$1F`. Each one was a number a human read out of the disassembly once and
typed into the descriptor, when the byte it came from is sitting in the ROM
at a fixed offset. **Opcodes are readable bytes.** Reading a byte at a known
offset to learn what an instruction does is interpretation. Simulating
execution to discover which code runs would not be, and nothing here does it:
every read below is a bounded fetch at an offset the descriptor names.

### 9.1 What is now read

| Was | Now | Mechanism |
|---|---|---|
| `shift: 6` | length of the `LSR A` run at handler offset `$C0` | `ShiftCount` |
| `orBitShift: 3` | length of the `LSR A` run at `$CB` | `ShiftCount` |
| implicit `& 1` | the `AND` immediate at `$CF` | `CodeRef` byte |
| not modelled | the 1 px bob: displacement, sign, target entry, both gate thresholds and the odd-only bit test | `TileNudge` |
| `0x01BEA7` and friends | offsets past the MAIN pointer the ROM holds | `CodeRef` `{ mainOff }` |
| `routine: 'sub1'` | the `JSR` target at `$D6`, matched to `SHARED_DRAW_ROUTINES` | `routineJsr` |

Handler offsets, and the vanilla address each resolves to. The base is the
MAIN pointer at `$01:85CC + $1F*2`, which reads `$BDD6` on all six ROMs in
`test/roms/`; the engine re-reads it every draw rather than assuming it.

| Offset | Vanilla | Instruction | Line |
|---|---|---|---|
| `$C0` | `$01:BE96` | first of six `LSR A` | `bank_01.asm:8514-8519` |
| `$CB` | `$01:BEA1` | first of three `LSR A` | `bank_01.asm:8523-8525` |
| `$CF` | `$01:BEA5` | `AND #imm` immediate | `bank_01.asm:8526` |
| `$D1` | `$01:BEA7` | `ORA.W DATA_01BE69,Y` operand | `bank_01.asm:8527` |
| `$D6` | `$01:BEAC` | `JSR SubSprGfx1` opcode | `bank_01.asm:8529` |
| `$DE` | `$01:BEB4` | `SBC #imm` immediate | `bank_01.asm:8532` |
| `$E0` | `$01:BEB6` | `CMP #imm` immediate | `bank_01.asm:8533` |
| `$E3` | `$01:BEB9` | the bob's `LSR A` run | `bank_01.asm:8535` |
| `$EA` | `$01:BEC0` | `INC.W OAMTileYPos+$100,X` opcode | `bank_01.asm:8539` |
| `$FC` | `$01:BED2` | wand gate `CMP #imm` | `bank_01.asm:8546` |
| `$106` | `$01:BEDC` | `ADC.W DATA_01BE6C,Y` operand | `bank_01.asm:8551` |
| `$118` | `$01:BEEE` | wand `ADC #imm` | `bank_01.asm:8560` |
| `$12F` | `$01:BF05` | wand `LDA #imm` | `bank_01.asm:8570` |
| `$24D` | `$01:C023` | state-2 seed `LDA #imm` | `bank_01.asm:8729` |
| `$261` | `$01:C037` | `LDA.L MagiKoopaPals,X` operand | `bank_01.asm:8734` |

Every line number above was checked by opening `bank_01.asm` at that line, and
every offset by dumping the corresponding byte out of the ROM with `xxd`.
Both shift runs, the `JSR` target and the `INC` opcode are additionally
asserted in `SpriteEngineCartReads.test.ts` against all six ROMs, which is
the citation form that does not rot.

### 9.2 The `TileNudge` kind

Third instance of "handler work outside the shared routine", after
`ExtraPart` and `anim: stateTimer`, and it follows their shape: a list on the
descriptor, every field an address, applied by the engine around the routine
port. `SubSprGfx1` writes its two large OBJs and returns; the handler then
increments the Y byte of the first one.

Four things are read, and a test plants a different byte for each:

- **The displacement and its sign** come from the read-modify-write OPCODE.
  `$FE` is `INC abs,X` and means +1 px; `$DE` is `DEC abs,X` and means -1. An
  opcode that is neither is refused as `unexpectedOpcode` rather than assumed.
- **The target entry** comes from that instruction's own 16-bit operand.
  `OAMTileYPos` is `$0201` and all three shared routines write from `+$100`
  (`bank_01.asm:3949`), so the operand minus `$0301` is the slot. Planting
  `$0305` moves the bottom OBJ instead, and a test asserts it does. A slot the
  resolved routine never wrote is `nudgeTargetOutOfRange`, which is a distinct
  failure from `romReadFailed`: the bytes were there and said something
  impossible.
- **The window** is the `SBC` and `CMP` immediates: the nudge applies when
  `tileGroup - base` is at least `size`.
- **The odd-only test** is the `LSR A` run before the second `BCC`, counted
  with the same mechanism as the pose shift. A run of N tests bit N-1 of the
  same difference, so a hack that adds an `LSR A` moves which pose bobs.

What this does NOT model, stated rather than left implicit: the OAM buffer
base `$0301` is a RAM address, not ROM data, and a hack that relocated SMW's
sprite OAM window would break the operand-to-slot arithmetic silently. It is a
single module constant, `SPRITE_OAM_FIRST_Y`.

**Other users of this shape: one.** A grep of every `bank_*.asm` for `INC` or
`DEC` against an `OAMTile*` field finds exactly two sites in the whole game:
`bank_01.asm:8539` and `bank_02.asm:14617`. The second is the Skull Raft
(`CODE_02EDF6`, `bank_02.asm:14562`), which nudges its own entry down a pixel
when Mario lands on it, and its gate is the carry out of `MarioSprInteract`.
That is a live physics result, not a tile-group window, so `TileNudge` as it
stands does not cover it, and a static editor has nothing to show anyway. The
per-entry ATTRIBUTE and SIZE overrides the wing family needs remain a separate
uncovered category, as section 8 predicted.

### 9.3 Reading the routine choice was feasible

It did not need control-flow following. `$1F`'s `JSR` sits at a fixed offset
from the handler pointer, so `readDrawRoutine` fetches three bytes there,
requires a `$20` opcode and matches the 16-bit target against the three shared
entry points. Retargeting it at `SubSprGfx2Entry1` makes the engine draw one
large OBJ instead of two; a target nobody has traced returns
`unknownDrawRoutine` instead of a confident wrong sprite.

The entry points themselves stay hardcoded, deliberately. They are the SHARED
routines, not per-sprite data: a hack that relocates `SubSprGfx1` has replaced
the game's draw engine, and "unknown routine" is the honest answer there.
`SubSprGfx0Entry1` and `SubSprGfx2Entry0` are left out of the table because
they take different arguments and no descriptor kind models them.

This only works for a handler whose `JSR` is at a predictable offset. Where it
is behind a branch, the honest answer is to omit `routineJsr` and fall back to
the declared `routine`, which is what the other four descriptors do. Building
a tracer to find it would be the "simulating execution" side of the line.

### 9.4 What a hack can still change without the engine noticing

- **Which state runs.** `$1F` dispatches on `SpriteTableC2 & 3` and only state
  2 is modelled. A hack that made state 1 the visible one would render the
  wrong state, and nothing in the descriptor would say so.
- **The OAM buffer base.** `SPRITE_OAM_FIRST_Y` is `$0301`, from the RAM map,
  and is the one address in the nudge path that is not ROM data.
- **`ExtraPart.oamSlot`.** Still a literal `$08`. It is readable, from the
  operands of the handler's own `STA.W OAMTile*+$108,Y` run, and converting it
  is the same shape as the nudge's operand read. Left alone because this work
  was scoped to `$1F` as the pattern and the slot only decides draw ORDER.
- **The routine port itself.** `drawSub0/1/2` are a hand port of three
  routines. A hack that rewrites `SubSprGfx1` while leaving its entry point in
  place renders wrongly and confidently.
- **`SprTilemapOffset` semantics, `frames`, `representativeFrame`.** `frames`
  is asserted against the ROM-read seed; the other two are editorial.
- **`colorsPerEntry`, `entryCount`, `cgramStart`** on `dynamicCgram`: still
  literals. Section 8 records why. `restingEntry` is no longer one of them:
  section 11 records the read that replaced it.
- **A handler that is relocated AND partially rewritten.** Offsets follow the
  move; they cannot follow an insertion that shifts the tail.
- **`misc157C: faceMario`.** Whether the handler calls `FaceMario` at all is a
  structural claim, not a read one.
- **The identity of the gate instructions.** `TileNudge` assumes the window is
  an `SBC` then a `CMP`; it reads their immediates but not their opcodes. A
  hack that swapped the `CMP` for something else would be followed wrongly.
- **One instruction LENGTH.** `shellessKoopa`'s `gfxJsr` steps three bytes
  past the `JMP CODE_018B03` target to clear the `JSR SubSprSprInteract` at
  bank_01.asm:1655, because nothing targets the `JSR Spr0to13Gfx` after it
  and there is no named hop that lands on it. Every other hop in the file
  lands on a byte whose opcode is verified. This one is verified only
  indirectly: `gfxJsr` is used solely as the `via` of another ref, and
  `resolveRef` refuses a target that is not a `JSR` or `JMP`, so a changed
  instruction length is caught unless the new byte is also $20 or $4C.
- **Branch polarity.** `TileNudge`'s two `BCC`s and `UnmodelledTailCall`'s
  single `BCC` are assumed, not read. Both kinds read the immediates the
  branches compare against, so a retuned threshold is followed; an INVERTED
  branch is not. Turning `Spr0to13Gfx`'s `BCC` at bank_01.asm:1787 into a `BCS`
  would decline exactly the sprites that should render and render exactly the
  ones that should decline.

### 9.5 Converting the other four descriptors

Scope was `$1F` only. What the rest would cost, from reading their handlers:

- **`$4D` and `$4E` (`MontyMole`, `CODE_01E343`).** Two branches of one
  handler. `tileGroup: { kind: 'table', addr: 0x01E35F }` and the matching
  `propGroup` are RAW table addresses, weaker than `tableViaOperand`: they
  should become operand reads first. `$4E`'s `attrOverride: effFrameFlip`
  holds `shl: 2`, `andMask: 0xC0`, `orMask: 0x31`, which are an `ASL` run and
  two immediates and convert exactly like `$1F`'s. Both `JSR`s look
  fixed-offset, so `routineJsr` applies. `anim: effFrame` holds `shift: 4`,
  another shift run. Roughly a day, and it needs a `ShiftCount` that can count
  `ASL` ($0A) as well as `LSR`.
- **`$14` (`SpinyEgg`).** `propGroup: { kind: 'const', value: 0x02 }` is a
  genuine `LDA #imm` and should be an `immediateAt`. `routineJsr` applies.
  Cheap, perhaps an hour, but the descriptor has a known rendering defect
  already and wants fixing rather than converting in place.
- **`$2C` (`InitYoshiEgg`).** Its one address is inside the INIT handler, not
  the MAIN one, so `CodeRef` needs an `{ initOff }` case and the engine a
  second base. Small, but it is a format change, so it wants its own pass.
- **`spr0to13` ($00-$13).** The most work and the most value. It picks its
  routine from `Spr0to13Prop[id] & $40` at render time, which the engine does
  not implement at all: the `routine: 'sub2'` in that factory is a stated lie.
  That is a ROUTINE-SELECTED-BY-TABLE kind, not a `JSR` read, so `routineJsr`
  does not help and a fifth kind is needed. The `anim` shift is a shift run in
  `SetAnimationFrame` and converts trivially once the routine question is
  settled.

A common prerequisite for all of them: `ShiftCount` counts `LSR A` only today.
`ASL A`, `ROL A` and `ROR A` runs appear in these handlers and want the opcode
to be a field rather than a constant.

### 9.6 Verification of this section

Baseline at `1e3e94e`, confirmed by running it: 2530 passed / 8 skipped.
After: `npx tsc --noEmit` clean, `npx eslint src --ext .ts` 0 errors and 14
pre-existing warnings, `npx webpack --mode development` succeeded,
`npx vitest run` 2588 passed / 8 skipped / 0 failed across 152 files. With
`test/roms/` moved aside: 2249 passed / 261 skipped / 0 failed, then restored.

Fourteen further defects were planted one at a time, each restored by copying
the file back from outside the repo. No `git checkout` was used.

| # | Planted defect | Result |
|---|---|---|
| M17 | shift-count scan starts one byte late | 46 tests failed |
| M18 | shift-count scan stops one byte early | 44 tests failed |
| M19 | nudge displacement is a constant +1, not the opcode | 2 tests failed |
| M20 | `{ mainOff }` resolved against a fixed address | 2 tests failed |
| M21 | `JSR` target read, then ignored for the declared `routine` | 3 tests failed |
| M22 | OR slice dropped from the tile-group lookup | 30 tests failed |
| M23 | nudge target slot forced to the first entry | 2 tests failed |
| M24 | nudge odd-only bit test never fires | 27 tests failed |
| M25 | nudge window size ignored | 11 tests failed |
| M26 | handler base falls back to the descriptor's vanilla pointer | 2 tests failed |
| M27 | OR mask hardcoded to 1 | 2 tests failed |
| M28 | any `JSR` target accepted as the declared routine | 55 tests failed |
| M29 | `tileNudges` never applied | `tsc` plus 29 tests failed |
| M30 | non-`JSR` opcode accepted | `tsc` plus 1 test failed |

Every mutant turned something red, so none had to be rewritten this time. The
six that killed only two or three tests each (M19, M20, M21, M23, M26, M27)
are narrow by construction: each is the only mechanism its planted-byte tests
exercise, and those oracles were written before the code, so a low count is
coverage being precise rather than thin.

`render_sprite_frame` against GFX03 was used to look at the cast pose and the
bobbed pose side by side before any of this was called correct: the bob
separates the head and upper body from the lower body by one pixel, which is
what the ASM says.

Evidence scope: static traces against `C:\Projects\SMWDisX`, byte reads out of
the six ROMs in `test/roms/` with `xxd` and through `RomFile`, and the
planted-byte tests above. No emulator was run, so nothing here is dynamically
verified against hardware or an accurate emulator.

## 10. The walk family, and what Rex in bank 3 would cost

Two sprites were reported as rendering STATIC in the editor when they walk in
game: a shell-less Koopa ($00-$03) and Rex ($AB). Tracing both produced one
descriptor kind that covers eleven sprite IDs, and a clear answer on why the
second one is not reachable from the format as it stands.

### 10.1 Both handlers draw through the same routine

The shell-less Koopas are NOT a separate family from the shelled ones. Their
MAIN pointer is `ShellessKoopas` (bank_01.asm:898-901) rather than
`Spr0to13Start` (bank_01.asm:902-917), but the walking path falls out of the
shell-less handler into the shared blob at `BNE Spr0to13Main`
(bank_01.asm:1659) and both end at the same `Spr0to13Gfx` (bank_01.asm:1748).
So the sprite the user named and the family previously written off as
"needs a fifth kind" are ONE piece of work, not two.

Members covered: $00-$03, $04-$07, $0F, $11, $13. Eleven descriptors, two
handler pointers, one shape.

### 10.2 How the walk frame is selected

`SetAnimationFrame` (bank_01.asm:2089-2097):

| Step | Line | What it is |
|---|---|---|
| `INC SpriteMisc1570,X` | 2090 | one tick per call |
| `LSR A` x3 | 2092-2094 | the shift, COUNTED as a run |
| `AND #$01` | 2095 | the mask, READ as an immediate |
| `STA SpriteMisc1602,X` | 2096 | the tile-group selector IS the frame |

It is called once per game frame on the walk path (bank_01.asm:1691), so the
period is 16 game frames and the walk has two frames. That is the shape
`anim: spriteCounter` was built for, and the trace confirms it rather than
assuming it. The PHASE is not merely unknown in a still editor: `GetRand`
seeds `SpriteMisc1570` at spawn (bank_01.asm:844-845), so it differs per spawn
on hardware too.

The engine previously held `shift: 3, mask: 1` as typed-in numbers. It now
reads both, which needed a way to name a byte inside a SHARED routine. See
10.4.

### 10.3 The routine choice is a table bit, resolved at render time

`Spr0to13Gfx` branches on `Spr0to13Prop[id] & $40` (bank_01.asm:1763-1765):

| Bit | Line | Routine | Shape |
|---|---|---|---|
| clear | 1766 | `SubSprGfx2Entry1` | one 16x16 |
| set | 1780 | `SubSprGfx1` | two stacked 16x16, at Y - $10 |

`routineSelect` reads the table's ADDRESS from the `LDA Spr0to13Prop,Y`
operand, the bit from the `AND` immediate, and each branch's routine from its
own `JSR` target. Nothing about $40, about $01:88F0, or about which branch is
which is written down. `SpriteTileLoader.SPR_0_TO_13_PROP_ADDR` is the
hardcoded table address this supersedes for engine purposes.

On all six ROMs in `test/roms/` the table reads
`00 02 03 0D 40 42 43 45 50 50 50 5C DD 05 00 20 20 00 00 00`, so the shelled
Koopas are 16x32 and the shell-less ones, the Goomba, the Buzzy Beetle and the
Spiny are 16x16.

**The 1 px walk bob.** On the 16x32 branch the handler does
`LDA SpriteMisc1602,X : LSR A : LDA SpriteYPosLow,X : PHA : SBC #$0F`
(bank_01.asm:1770-1774). The disassembly annotates that `LSR A` as
"Nothing?", because its accumulator result is discarded. Its CARRY is not:
`SBC` subtracts `imm + 1 - carry`, so an odd tile group sits one pixel lower.
That is a real bob on the walking Koopa, and it is the second place in this
engine where a dead accumulator still moves a pixel (the first was $1F's
`INC OAMTileYPos`). `PreDrawYAdjust`, named `CarryYAdjust` until this review because the name
advertised its 1 px carry term and hid the 16 px whole-body lift that is the
load-bearing part, models it by reading the `SBC` operand and
counting the `LSR A` run that supplies the carry bit, so a hack that changes
either is followed.

The adjust is expressed relative to what the routine port already emits
(`ROUTINE_BASE_DY`), so the routine's own translation is not counted twice.

### 10.4 The linked `CodeRef`, and why it was needed

`{ mainOff }` cannot name a byte that is not inside the handler, and three of
the things above are not:

* `SetAnimationFrame` is shared code in the middle of bank $01.
* `Spr0to13Gfx` is shared between two handlers.
* $00-$03 reach it through a `JMP` (bank_01.asm:1418) into a `JSR`
  (bank_01.asm:1656), two hops away from `ShellessKoopas`.

`CodeRef` gains `{ via, off }`: a byte offset past the target of the `JSR` or
`JMP` at another ref, nested for a two-hop chain. It refuses any other opcode.
This reads a LINK; it does not search for one, and it does not follow control
flow to decide which link is taken. The distinction matters in 10.6.

The anchors chosen per handler:

| id | `JSR SetAnimationFrame` | `JSR Spr0to13Gfx` |
|---|---|---|
| $00-$03 | `{ mainOff: $0F }`, bank_01.asm:1407 | `{ via: { mainOff: $2A }, off: 3 }`, bank_01.asm:1418 then 1656 |
| $04-$13 | `{ mainOff: $4D }`, bank_01.asm:1691 | `{ mainOff: $0A }`, bank_01.asm:1656 |

The shell-less anchor for `SetAnimationFrame` is the CARRIED-pose call, not
the walking one. That is deliberate and sound: the ref exists only to LOCATE
the routine, and both calls name the same routine, so a hack that repoints
`SetAnimationFrame` is followed through either. A test asserts the two
handlers resolve the same shift and mask.

### 10.5 $0C is absent, and the wing gate is read rather than listed

$0C Yellow Koopa with wings has the `Spr0to13Start` handler and the $40 bit
set, so the engine could render its body. Its draw ends with `JSR
KoopaWingGfxRt` (bank_01.asm:1788) writing OAM entries no descriptor kind
models, and a Koopa drawn without its wings is the wrong-but-confident sprite
this engine exists to refuse. $0C is therefore left untraced, and a test
asserts it stays that way until a wing kind exists.

**An earlier revision of this section stated the reason backwards.** It said
$0C was "the only member whose sprite number clears the `CMP #$08` at
bank_01.asm:1786". That is wrong twice over. `BCC` skips the wing call for
numbers BELOW the immediate, so clearing the gate means being at or ABOVE it,
and four family members do that, not one: $0C, $0F, $11 and $13.

Wings need two conditions, and only one of them is a property of the sprite
number:

| Condition | Where | Per-ROM? |
|---|---|---|
| `Spr0to13Prop[id] & $40` set, taking the 16x32 branch | bank_01.asm:1765 | yes, it is a ROM table byte |
| sprite number at or above the `CMP #$08` | bank_01.asm:1786 | yes, it is an immediate |

The clear branch `BRA`s past the wing call entirely (bank_01.asm:1767), so a
16x16 member never reaches it whatever the threshold says. $0F, $11 and $13 are
spared on a vanilla ROM only because their property bit is clear, and that bit
is exactly what `routineSelect` already reads per ROM.

A static exclusion list keyed on $0C therefore guarded a value the engine reads
from the ROM. Measured: planting `Spr0to13Prop[$0F] = $60` made the engine emit
a clean 8-subtile 16x32 Goomba reporting `status: 'vanilla'`, while the ROM
draws that body PLUS `KoopaWingGfxRt`; and because `$0F >= $0F`, `SubSprGfx1`
skips its `ADC #$04` OAM shift (bank_01.asm:3931-3933), so the wings land on the
body's own top entry. Separately, mutating the `CMP #$08` to `#$00` gave $04-$07
wings and the engine ignored it.

Both gate bytes sit at fixed offsets past the `JSR Spr0to13Gfx` the descriptor
already names: the immediate at `+$4A` and the `JSR` at `+$4D`. So this is a
stop-early, not an unreadable value. `UnmodelledTailCall` reads them, and the
engine returns `unmodelledTailCall` for whichever ids THIS ROM actually wings.
The `BCC` polarity is assumed rather than read and is listed in section 9.4 as a
declared hack-fragility point, the same assumption `TileNudge` makes about its
own two `BCC`s.

### 10.6 Rex ($AB) in bank 3: traced, costed, NOT done

**The MAIN pointer table entry for $AB does not point at Rex.** It points at
`Bank3SprHandler` (bank_01.asm:1069, label at bank_01.asm:1126), which is two
instructions: `JSL Bnk3CallSprMain : RTS`. Every bank-3 sprite shares it. Two
consequences for the format:

1. `{ mainOff }` anchoring is USELESS for $AB. Offsets past $01:878E land in a
   four-byte stub, not in Rex.
2. Identity checking by MAIN pointer cannot tell Rex from Fishbone, Swooper,
   Blurp or any other bank-3 sprite, because all of them read $878E.
   `resolveIdentity`'s "aliased onto another traced handler" branch would fire
   on any two bank-3 descriptors.

**`Bnk3CallSprMain` is not a pointer table.** It is a chain of
`CMP #imm : BNE + : JSR handler : PLB : RTL` links starting at
$03:A118 + 5 (bank_03.asm:4305). Walking it on the vanilla ROM, $AB is link
30 of 36, and the chain is NOT uniform: link 17 is a `CMP / BEQ / CMP / BNE`
pair sharing one handler (bank_03.asm:4412-4417), there is a stray
`LDA SpriteNumber,X` reload partway down (bank_03.asm:4445), and the chain
ends in a `JSL` fallthrough at $03:A259. Reaching Rex therefore needs a walker
that recognises three idioms and terminates safely on a fourth, over 30
iterations of taken-or-not-taken branches. That is following control flow to
discover which code runs, which is the line this project has drawn, and it is
the opposite side of it from reading one link at a named offset.

**Rex does not use any shared draw routine.** `RexGfxRt` (bank_03.asm:2884) is
bespoke: its own OAM loop over two tiles, its own `RexTiles`,
`RexTileDispX`/`Y` and `RexGfxProp` tables (bank_03.asm:2869-2882), its own
per-frame size handling, and a direction-indexed displacement row. Supporting
it means porting a FOURTH routine that exactly one sprite uses, which is the
per-sprite hand-encoding the engine was built to delete.

For the record, Rex's walk frame IS a standard shape and would have been easy
if the rest were reachable: `RexAlive` increments `SpriteMisc1570` inline and
computes `(SpriteMisc1570 >> 4) & 1` for the normal walk, or
`((SpriteMisc1570 >> 2) & 1) + 3` when smushed (bank_03.asm:2729-2743). That
is `anim: spriteCounter` with shift 4, mask 1, and a 32-game-frame period.

Estimate to do Rex properly: a bank-3 dispatch walker with its own planted-
defect suite (roughly 80 lines of mechanism plus tests), a second identity
axis so bank-3 sprites are told apart by their dispatch-chain handler rather
than by $878E (roughly 40 lines, and it touches `SpriteHandlerProvenance`,
which four other test files assert against), and a `RexGfxRt` port (roughly
70 lines). Call it a separate job of about 200 lines of mechanism, and note
that the walker is the part that needs an explicit decision about the
control-flow rule rather than an implementation.

### 10.7 Known divergences this work does NOT fix

* **$1F Magikoopa sits 16 px high relative to the game.** `SubSprGfx1` writes
  its top tile at `_1`, which `GetDrawInfoBnk1` sets to the sprite's own Y
  (bank_01.asm:4807-4810), and `drawSub1` places that top tile at dy -16.
  That convention is CORRECT for the spr0to13 family, whose handler subtracts
  $10 before calling (bank_01.asm:1774), and it is what `ROUTINE_BASE_DY`
  encodes. $1F calls `SubSprGfx1` with no such adjust (bank_01.asm:8529), so
  on that one sprite the engine's body is a whole tile too high. Found while
  tracing this work, pre-existing, and not corrected here because fixing it
  means changing the convention every existing sub1 consumer is written
  against.
* **The turning pose is not rendered.** `Spr0to13Gfx` pins `SpriteMisc1602`
  to 2 and flips the direction while `SpriteMisc15AC` is non-zero
  (bank_01.asm:1749-1760). That timer is only ever set by gameplay, when a
  follow-Mario sprite turns round (bank_01.asm:1710-1711), so a placed sprite
  in a still editor never shows it.
  Stated rather than silently dropped.
* **`SubSprGfx1` shifts the OAM index by 4 for sprite numbers below $0F**
  (bank_01.asm:3930-3933). That changes draw ORDER between overlapping
  sprites, not position, and the engine has no cross-sprite ordering model
  yet.

### 10.8 Verification for section 10

Baseline at `66d502b`: 2588 passed / 8 skipped. After: 2654 passed / 8
skipped across 153 files, `npx tsc --noEmit` clean, `npx eslint src --ext .ts`
0 errors, `npx webpack --mode development` succeeded. With `test/roms/` moved
aside the ROM-gated tests skip and the suite stays green, then restored.

Twelve defects were planted one at a time in `SpriteDrawEngine.ts` and
`SpriteDrawDescriptor.ts`, each restored by copying the file back from outside
the repo. No `git checkout` was used.

| # | Planted defect | Result |
|---|---|---|
| M31 | `spriteCounter` ignores the `LSR` run and uses the stored shift | 1 test failed |
| M32 | `spriteCounter` ignores the `AND` immediate and uses the stored mask | 1 test failed |
| M33 | routine-select bit hardcoded to $40 | 1 test failed |
| M34 | property table address hardcoded to $01:88F0 | 1 test failed |
| M35 | branch routine hardcoded instead of read from its `JSR` | 3 tests failed |
| M36 | bob carry forced clear | 8 tests failed |
| M37 | bob carry bit off by one | 9 tests failed |
| M38 | `SBC` operand hardcoded to $0F | 1 test failed |
| M39 | pre-`JSR` Y adjust never applied | 8 tests failed |
| M40 | `{ via }` hop accepts any opcode | 2 tests failed |
| M41 | `{ mainOff }` resolved against a fixed address | 161 tests failed |
| M42 | shell-less animation anchored at an absolute address | 1 test failed |

Every mutant turned something red, so none had to be rewritten. The
single-test kills (M31-M34, M38, M42) are narrow by construction: each planted
byte is the only thing its oracle exercises.

`render_sprite_frame` against GFX01 at 3bpp was used to LOOK at both walk
frames of $00, $04 and $0F before any of this was called correct. $00's frame
1 moves the foot and shifts the body, $04's frame 1 changes the stride and
sits one pixel lower, and $0F's frame 1 moves the eyebrows and the visible
foot. The tool's own auto-detect reports 4bpp for `GFX01` on the sprite-frame
path and 3bpp on the sheet path; 3bpp is the one that produces a Koopa, so
`bpp: 3` was passed explicitly.

Evidence scope: static traces against `C:\Projects\SMWDisX`, with every line
number checked by opening `bank_01.asm` or `bank_03.asm` at that line; byte
reads out of all six ROMs in `test/roms/`, which agree byte for byte at every
site named above; and the planted-byte tests in
`test/suite/unit/sprites/SpriteEngineWalkCycle.test.ts`. No emulator was run,
so no claim here is dynamically verified against hardware.

## 11. Three more values converted from literal to read

Review found three descriptor fields still holding what vanilla happens to
contain, on a branch whose stated purpose is reading. Each is now read, with a
planted-byte test proving the render follows the ROM and a mutation proving
the test can go red.

### 11.1 The wing gate (`UnmodelledTailCall`)

Covered in 10.5. Summary: `Spr0to13Gfx+$4A` and `+$4D`.

### 11.2 $2C's char (`TileOverride`)

`CODE_01F78D` is four instructions (bank_01.asm:16057-16062):

```
JSR SubSprGfx2Entry1
LDY SpriteOAMIndex,X
LDA #$00
STA OAMTileNo+$100,Y
```

The routine reads `SprTilemap[SprTilemapOffset[$2C] + SpriteMisc1602]` and
writes it to `OAMTileNo+$100,Y` (bank_01.asm:4156-4160); the handler then
writes over it. So the tilemap is a source the ROM discards, and both the
engine and the shipped `buildSpriteLayout` read it.

**Vanilla coincides.** `SprTilemap[$94]` is $00 and so is the immediate, which
is why the whole-ROM equivalence run could not see the difference. Planting
$60 in the tilemap moved the engine to chars $560, $561, $570, $571 while the
ROM still draws base $00.

`TileOverride` names the `LDA #imm` OPCODE rather than its operand, so a
handler whose instruction was replaced reads as `unexpectedOpcode` instead of
having its next byte taken as a tile. Overrides resolve BEFORE the routine
runs, although the ROM writes them after: the replacement char has to pass
through the same large-OBJ corner expansion the routine's own tile does, and
reconstructing that from finished parts would mean undoing the flip
permutation in `largeObj` first.

$2C also gained a `routineJsr`, so its `sub2` now comes from the ROM's own
`JSR` target (bank_01.asm:16058) rather than the declared `routine`.

Offsets, from the MAIN pointer $F764: the `JSR` at `+$29`, which resolves to
$01:F78D and confirms the base, and the `LDA #imm` at `+$2F`.

### 11.3 $1F's resting palette entry (`restingEntryCmpAddr`)

`CODE_01C004` counts `SpriteMisc1570` up, uploading entry `counter - 1` per
step (bank_01.asm:8734-8740). The `CMP #$09` at $01:C01C ends the fade by
advancing the state instead of uploading (bank_01.asm:8726-8730). Entries
written are therefore 0..7, and the one left standing in CGRAM is `imm - 2`.

Offset `+$246` past the MAIN pointer $BDD6. The same handler's state-2 seed
`LDA #$70` sits six bytes later at `+$24D`, which the descriptor already
named, so the base is cross-checked by two independent refs.

This is a FALLBACK, not a failure: the literal 7 stands when the ref is
absent, the read falls off the ROM, the instruction is not a `CMP #imm`, or
the implied entry is outside the table. The colors are a still editor's
approximation of a runtime DMA either way, and declining to draw $1F over an
unrecognised fade terminator would lose a sprite the engine otherwise renders
correctly.

### 11.4 Reconciling `dynamicCgram` with `DynSpritePalette`

The descriptor comment claimed the two types were "structurally identical" and
"should collapse to a type alias". That was wrong in both directions, because
each reads something the other holds:

| Field | `dynamicCgram` (this branch) | `DynSpritePalette` (`feature/sprite-1f-render`) |
|---|---|---|
| palette table address | read, from the `LDA.L` operand at `+$261` | literal $03:B902 |
| `restingEntry` | read, from the `CMP` at `+$246` (was literal) | read, from $01:C01C |
| `colorsPerEntry`, `entryCount`, `cgramStart` | literal | literal |

A merge is a reconciliation keeping the read side of each, not an alias. The
sibling addresses the `CMP` absolutely where this branch uses a handler
offset, so the handler-relative form is the one to keep.

Evidence scope: static traces against `C:\Projects\SMWDisX` with every line
number checked by opening `bank_01.asm` at it; fixed-offset byte assertions on
all six ROMs in `test/roms/`, which agree at every site named above; and
planted-byte tests on `Super Mario World (USA).vanilla.sfc` in
`SpriteEngineCartReads.test.ts` sections 5 and 7 and
`SpriteEngineWalkCycle.test.ts` section 6. No emulator was run.

## 12. Six ROM files, five ROMs

`test/roms/` holds six `.sfc` files, and the reports above repeatedly called
them "five ROMs". Both counts were loose. Measured:

| File | Bytes | Note |
|---|---|---|
| `Super Mario World (USA).vanilla.sfc` | 524288 | the reference ROM |
| `Super Mario World (USA).magic.sfc` | 524800 | the SAME ROM plus a 512-byte copier header |
| `Grand Poo World 2 1.1.sfc` | 4194304 | hack |
| `GrandPooWorld_V1.2.sfc` | 2097152 | hack |
| `Invictus 1.0.sfc` | 4194304 | hack |
| `Seven_Vanilla_Levels.sfc` | 1048576 | hack, despite the name |

`magic.sfc` with its first 512 bytes stripped is byte-identical to
`vanilla.sfc`. So the corpus is FIVE DISTINCT ROMS IN SIX FILES, and the
sixth file exercises the copier-header handling in `RomFile` rather than a
fifth hack. Claims of the form "identical across all five ROMs" are now
written as "all six ROM files", which is what the harness actually iterates.

## 13. What is read-backed, per descriptor

The branch's headline claim is "reads rather than hardcodes". Review found it
held for $1F and the eleven walk descriptors and was largely FALSE for $14,
$2C, $4D and $4E: their `LSR` runs, `AND` masks, table operands, draw `JSR`
targets and immediates were all ignored although readable at fixed offsets,
and `SpriteEngineCartReads.test.ts` covered $1F only.

Most of that is now converted. This table is the honest statement of what
remains, so the claim can be checked rather than believed.

| Descriptor | Read from the ROM | Still a literal |
|---|---|---|
| $00-$07, $0F, $11, $13 (walk) | animation shift and mask, property table address, selecting bit, both branch `JSR`s, the `SBC` bob and its carry bit, the wing threshold and its `JSR` | `frames`, `representativeFrame` |
| $14 Spiny egg | draw `JSR`, prop group `LDA #$02`, animation shift and mask | `frames`, `representativeFrame` |
| $1F Magikoopa | draw `JSR`, both tile-group shifts, the OR mask, the state-timer seed, the nudge displacement and its sign, target entry and gates, the wand's char, dx table and gate, the palette table address, the resting entry | `colorsPerEntry`, `entryCount`, `cgramStart`, `ExtraPart.oamSlot`, `representativeFrame` |
| $2C Yoshi egg | draw `JSR`, the char override `LDA #$00` | `initTableByX` operand address (see below), `entries`, `shift`, `mask` |
| $4D Monty Mole | draw `JSR`, tile-group and prop-group table ADDRESSES from their `LDA abs,Y` operands | `effFrame` shift and mask, `representativeFrame` |
| $4E Ledge Mole | draw `JSR`, tile group `LDA #$03` | `attrOverride` shl, andMask and orMask; `effFrame` shift and mask |

### 13.1 The three that were not converted, and why

**$4D's and $4E's `effFrame` shift and mask.** Both are readable: the `LSR A`
run at bank_01.asm:13393-13396 and the `AND #$01` at 13397 for $4D, and the
`ASL A` run at 13413-13414 with the `AND #$C0` and `ORA #$31` at 13415-13416
for $4E. Not done because `AnimSource.effFrame` and `AttrOverride` have no
`shiftAt`/`maskAt` fields, which `spriteCounter` does, and adding them to two
more kinds plus their read paths is a change of the same size as the
conversions above rather than a finishing touch. `ShiftCount` counts `LSR A`
only, so $4E would also need an `ASL A` variant.

**$2C's `initTableByX.operandAddr`.** It is the absolute $01:8343, not a
handler offset, because the operand lives in the INIT handler
(bank_01.asm:471) and `CodeRef`'s `{ mainOff }` is measured from the MAIN
pointer. Reading it relative to the ROM's own INIT pointer needs an
`{ initOff }` form. That is the right fix and it is not in this pass.

All three are listed in 9.4 as declared hack-fragility points.

### 13.2 Two offsets that cross-check their own base

Worth recording because it is the cheap check that catches a wrong
`vanillaMainHandler` before anything renders:

- $2C's `routineJsr` at `+$29` past $F764 lands on $01:F78D, which is the
  `CODE_01F78D` label.
- $4D's `CODE_01E343` at `+$74` and `DATA_01E35F` at `+$90` past $E2CF land
  on $01:E343 and $01:E35F, both labels.

$4D and $4E share `vanillaMainHandler` $E2CF and take different branches of
the same handler, so a test asserts that a plant in one branch does not move
the other.

Evidence scope: static traces against `C:\Projects\SMWDisX` with every line
number checked by opening `bank_01.asm` at it; fixed-offset assertions on all
six ROM files in `test/roms/`; planted-byte tests on
`Super Mario World (USA).vanilla.sfc` in `SpriteEngineCartReads.test.ts`
section 8. No emulator was run.
