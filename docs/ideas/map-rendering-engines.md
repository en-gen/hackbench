# Map rendering engines: a design under consideration

Status: proposal under review, not a plan. Drafted 2026-09-18 against
`origin/develop` at `a160b10`, plus three unmerged branches read but not
edited: `feature/generic-sprite-renderer`, `docs/sprite-draw-path-census`,
`docs/sprite-properties-panel`.

Evidence scope for the whole document. Every ROM claim is a static read of
`C:\Projects\SMWDisX` with the cited line opened, or a byte count over
`Super Mario World (USA).vanilla.sfc` (headerless, 524288 bytes). Two
measurements ran the repo's own loaders over all 512 slots of that ROM. No
emulator was run. No hack ROM was measured here; where a hack figure is
quoted it is the census's or the divergence report's, and is marked so. Each
claim is tagged: **verified** (opened the line or ran the count),
**inferred** (follows from verified facts), **unverified** (nobody has
checked).

## 1 Verdict, first

The proposal describes, under new names, most of what `src/rom/model/`
already is. The compositor it argues for exists (`SmwMap.render`, one
`RenderTarget`, hardware-ordered passes). The layer engines exist as
factories and layer classes. The two resource engines exist as loaders that
lack a contributor record. Adopting the proposal as written would be a
rename, not a rewrite, and the rename buys nothing by itself.

What the proposal gets right is the list of things that are missing, and it
gets that list from analogy rather than from the code. Checked against the
code and the ROM, the real gaps are, in order of demonstrated cost:

1. A shared game-frame clock. Six independent timers ship today, with a
   refresh-rate-dependent period. **verified**, section 5.
2. OAM priority as a sprite output facet. Vanilla draws some sprites behind
   terrain; the compositor has one sprite pass. **verified**, section 3.1.
3. Per-index CGRAM provenance. The three sprite palette sources are resolved
   in three different places with no record of which won. **verified**,
   section 4.1.
4. Divergence reporting for Layer 1. The object handlers are the largest
   hardcoded derivation in the repo (6363 lines) and already detect a
   repointed handler, but the detection is silent. **verified**, section 4.3.

Refuted or cut: the claim that byte fingerprinting converts hardcoding into
a cache (section 3.3, it is a gate, not a licence); the bounded 65816
interpreter (section 3.4, contradicts `CLAUDE.md` twice); the frequency
argument for CGRAM first (section 6); and the "independent canvases would
break priority" motivation, which argues against code nobody wrote
(section 3.2).

## 2 What exists, mapped to the proposal

| Proposed | Exists as | Missing | Adopting means |
|---|---|---|---|
| Compositor | `SmwMap.render` (`src/rom/model/SmwMap.ts:84-97`): L3 if not priority, L2, L1 non-priority, sprites, L1 priority, L3 if priority; one `CanvasRenderTarget` | sprite priority classes; per-tile L2/L3 priority (section 3.1) | extend the pass list |
| Layer 1 engine | `LevelParser` + `ObjectExpander` + `objectHandlers/` (6363 lines) + `TileFactory` | user-visible provenance (section 4.3) | rename |
| Layer 2 engine | `L2Factory` + `L2Layer` (preset and object-stream, tileset-3 palette OR, frame-accurate scroll) | nothing on vanilla (section 3.1) | rename |
| Layer 3 engine | `L3Factory` + `L3Layer` | per-tile priority is decoded (`L3Layer.ts:86`) and never read | rename |
| Sprite engine | `SpriteFactory` + 40 `appearances/*` on develop; `generic/SpriteDrawEngine` on the engine branch | OAM priority; the census's 43 clean ids | already in flight elsewhere |
| CGRAM engine | `PaletteLoader` (static, eight sources) + `PaletteFactory`/`Palette`/`Color` (animation as `CyclingColorBehavior`) + `PaletteOrBehavior` (L2 tileset 3) + `EngineSpriteAppearance.rowFor` (runtime splice, engine branch) | one place that knows all contributors and records the winner | data-structure change on `Palette`, not a rewrite |
| VRAM engine | `GfxLoader.loadVram` (static slots) + `AnimationLoader`/`ExAnimationLoader` (DMA frames) + `CharFactory.buildChars` (arbitration) + `PSwitchAlternateBehavior` | GFX32 Mario DMA (`GfxLoader.ts`, `loadVram` comment); per-slot provenance | rename |
| Shared contract (result + provenance + facts) | provenance exists for sprites only (`SpriteHandlerProvenance.ts`, engine branch); facts inventory exists for sprites only (`docs/ideas/sprite-properties-panel.md`) | both for L1/L2/L3/CGRAM/VRAM | new, small per engine |

**verified** by reading each file. The proposal's claim that `PaletteLoader`
"is already most of a CGRAM engine but lacks the runtime layer and per-index
provenance" is correct as far as it goes and understates what else is
already there: animation lives in `PaletteFactory`, the L2 palette OR lives
in `L2Factory`, and the runtime upload lives in the sprite appearance. The
gap is not a missing layer; it is four places with no shared record.

## 3 Claims examined

### 3.1 Draw order: verified, and narrower than stated

The proposal states "Layer 2, then Layer 1 non-priority, then sprites, then
Layer 1 priority" as correct. The project note it comes from
(`project_layer_render_order`) is a rule someone wrote down, as
`docs/ideas/overworld-scene-pipeline.md` open question 2 suspected. Traced
now:

- The level header's byte 2 bit 7 becomes `MainBGMode` = mode 1 with or
  without BG3 priority (`bank_05.asm:591-597`); `!HW_BG_BG3Pri` is bit 3
  (`hardware_registers.asm:76`). **verified**
- The NMI writes mode 1 WITH BG3 priority unconditionally
  (`bank_00.asm:238-242`), and the IRQ, after waiting 31 H-blanks
  (`bank_00.asm:453-454`), writes the header value (`bank_00.asm:463-465`).
  So the status-bar rows always have BG3 on top and the header bit governs
  the rest of the frame. **verified**
- Mode 1 PPU order, front to back, with the bit set: BG3.1, OBJ.3, BG1.1,
  BG2.1, OBJ.2, BG1.0, BG2.0, OBJ.1, OBJ.0, BG3.0; with it clear BG3.1 drops
  to between OBJ.1 and OBJ.0
  (`docs/snes-superfamicom-selected.md:501-518`).
  CORRECTED: an earlier revision of this line said BG3.1 drops to below
  BG2.0 and above OBJ.1, which is one slot too high. The source says only
  that it "moves from position 1 to position 8"; removing it from position
  1 shifts the remaining nine up, so inserting at the new position 8 lands
  it between OBJ.1 and OBJ.0. That reading is what `feature/oam-priority`
  encodes. The wording is genuinely ambiguous about whether position 8 is
  in the old or new numbering, and no second source has been consulted.
  This is hardware documentation, not the disassembly, and is the one link
  in the chain that cannot be cited to `SMWDisX`.
- Sprite OAM priority defaults to 2 at level load (`bank_00.asm:2401-2402`,
  `rammap.asm:521-527`). It is lowered to 1 for "behind scenery" at 13
  handler sites: nine in bank 1 including `ClassicPiranhas`
  (`bank_01.asm:2110-2113`), `CODE_019546` (`:2977-2980`) and the
  `SpriteBehindScene`-gated pair at `:3763-3767` and `:3782-3787`; four in
  bank 2 (`bank_02.asm:7482-7483`, `:12816`, `:12995`, `:13750`). One site
  raises it to 3 in a Mode 7 boss routine (`bank_03.asm:4579-4580`). The
  shared draw routines OR it into the OAM attribute
  (`bank_01.asm:4166-4172`, `:3869-3871`). **verified**
- Vanilla placements, measured with the repo's own loaders over all 512
  slots (510 built, 0 failed): L1 cells with any priority subtile 7892 of
  292241; L2 cells with any priority subtile **0 of 1057902** across both
  preset and object-stream layers; under the 31 headers that set BG3
  priority, non-zero L3 tilemap words with priority 1: 11971, priority 0:
  **0**. The BG Map16 table at `$0D9100` does hold 19 tiles with the bit,
  so a hack can place one; vanilla does not. **measured**

Consequences. The four-pass order is correct on vanilla for every sprite at
OBJ.2, which is nearly all of them, and for L2 and L3 because vanilla never
exercises their split. It is wrong for OBJ.1 sprites: a piranha plant
(`$1A`, `$2A`) belongs below every BG1 and BG2 tile, and the editor draws it
above the non-priority ones. Whether that is visible today depends on the
pipe tiles carrying the priority bit; **unverified** in the running editor.
The proposal's order also omits Layer 3 entirely, which `SmwMap.render`
already handles.

### 3.2 "Independent canvases would break priority": true, and a strawman

Nothing in the repo renders layers to separate canvases and stacks them. The
renderer has been a single interleaved target since the model layer landed
(`src/rom/model/CLAUDE.md`, "self-rendering objects, dumb renderer"). So the
stated reason for "declarations, not pixels" does not apply. **verified**

There is a real reason, and it is narrower: pixels cannot carry OAM
priority, and section 3.1 shows vanilla uses three of the four values. The
engine branch already emits declarations, `EnginePart` = char, palette,
flips, dx, dy (`SpriteDrawEngine.ts:156-164`), which is an OAM entry minus
size and priority. Adding priority is a field, not a tier. The proposal's
"the output contract is OAM entries" therefore survives as a one-field
change to code that exists, not as a new contract.

### 3.3 Byte fingerprinting: a gate, not a cache

The claim: a bespoke renderer gated on a hash of the handler's bytes "either
matches and is correct by construction, or it declines", so hardcoding
becomes a cache keyed on a hash. Examined:

1. What exists is weaker than a hash and already useful. The engine branch
   compares the MAIN and INIT pointers (`SpriteHandlerProvenance.ts`),
   checks specific opcodes at named offsets (`unexpectedOpcode`), and reads
   the bank-3 dispatch grammar byte by byte (`DispatchChain.ts`). No byte
   hash exists anywhere in the repo. **verified** by grep.
2. Pointer equality misses in-place patches. The repo's own worked case is
   `$05D8B1`, where four hack ROMs hold a `JSL` opcode at an unchanged
   address (`CLAUDE.md`, "The one case where table-reading is not enough").
   A hash over the handler's extent would catch that class. So a hash is a
   strict improvement on pointer equality **for the bytes it covers**.
   **inferred**
3. "Correct by construction" holds only for what is hashed, and a handler's
   draw work is mostly not in the handler. The census measures indirection
   depth 2 to 7 between the MAIN entry and the shared draw routine, 46 of
   104 shared ids are hybrids that also write OAM themselves, and every
   value the routines read comes from tables in other banks
   (`SprTilemap`, `Sprite166EVals`, `GeneralSprDispX/Y`). A matched handler
   with a retuned table renders wrong with a green fingerprint unless the
   tables are read live, which is what the engine branch does anyway. The
   hash decides WHEN to decline; it does not make anything readable that was
   not. **inferred** from the census's verified numbers.
4. The bespoke classes are not pure functions of the handler bytes. They
   carry deliberate editor deviations, representative frames, staged
   composition (`feedback_editor_deviates_from_rom`), and read level
   context outside any hash. A cache keyed on handler bytes would serve a
   stale entry for a changed sprite set. **verified** against the memory
   note and `SpriteFactory.ts`.
5. Where does a handler end? `RTS` is not the end when the routine falls
   through or is entered mid-body (`SubSprGfx2Entry0` and `Entry1` are two
   entries into one body, `bank_01.asm:4144-4148`). Choosing the extent is
   itself a hand derivation per handler, which is the thing being defended.

Verdict. Fingerprinting survives as **the honest-degradation gate Pillar 1a
already requires** for the residue that is genuinely unreadable, upgraded
from pointer equality to an extent hash where an extent can be named. It is
refuted as a licence to keep bespoke renderers: Pillar 1a's ordering stands
(read what is readable; decline on the rest), and the census's finding that
17 of 26 remaining families are singletons means the residue is large and
the gate will fire often. A gate that fires often is a product decision,
not an architecture.

### 3.4 The fallback ladder

- Tier 1, bytes match, bespoke renderer: see 3.3. Keep the gate; do not keep
  the tier as a destination.
- Tier 2, table-driven descriptor engine: exists on the engine branch, 16
  ids covered, and the census's number that decides its reach is 43 clean
  ids in 26 families displacing 7 of 40 classes. That is the branch's
  problem to solve and this document does not re-plan it.
- Tier 3, bounded 65816 interpreter capturing OAM writes: **cut**.
  `CLAUDE.md` says "We are not building an ASM interpreter" and Pillar 1a
  says "Simulating execution to discover WHICH code runs is out of scope".
  The proposal cannot overrule the governing rule by restating the idea with
  a bound. The honest precedent is `scrollSim.ts`, a hand port of named
  routines validated row-for-row against Mesen captures, which is a
  different thing from executing unknown bytes. The population an
  interpreter would serve is the 86 BESPOKE ids plus 46 hybrids; that is
  most of the ROM, which is the argument for it and also why it would
  become the renderer.
  **Amended 2026-09-27 (#351):** the owner allowed a bounded interpreter
  for L1 object handlers only, where hand-modelled shapes had produced
  #342 and nine more confirmed mis-ports (#355-#362, #368). The sprite/OAM tier
  above stays cut. Its rules are in `docs/rom/level-rendering.md`.
- Tier 4, human override in `<romfile>.hackbench.json`: the sidecar exists
  only on the unmerged `feature/map-alias-sidecar` branch
  (`src/metadata/MapAliasStore.ts`) **verified**. The memory note
  `project_sprite_engine_architecture` fixes its scope: shareable,
  committed to public hack repos, and therefore never containing ROM-derived
  data. A human-supplied APPEARANCE would be tile numbers and palette rows
  at minimum and pixels at worst. Scope tier 4 to choices (ghost on/off,
  representative frame index, "trust this handler") and never to art.

### 3.5 CGRAM is bidirectional

Correct, and already handled once, privately. `$1F` uploads
`MagiKoopaPals` (`bank_03.asm:7318`, read at `bank_01.asm:8743`) to CGRAM,
and the engine branch splices those colors over the level row for
Magikoopa's own parts (`EngineSpriteAppearance.ts:185-193`). The static
attribute path is `Sprite166EVals & $0F` into `SpriteOBJAttribute`
(`bank_07.asm:972-980`); the init override is `YoshiPal` for `$2C`
(`bank_01.asm:460, 471`). **verified**

The nuance the proposal misses: the upload is a write to CGRAM row 15, so
every other sprite on that map using row 15 shows Magikoopa's colors while
his handler runs, and stops when it does not. Contribution is temporal. In a
still editor "which contributor won index N" has no answer without a chosen
moment, so the resource record needs a policy field (resting entry of the
sequence, which the engine branch already picks) and the panel should say
so. No vanilla map was checked for a second row-15 sprite co-located with
`$1F`; **unverified**, and `$1F` is placed in two maps (`$11C`, `$1FE`, per
the wiring doc's measurement).

### 3.6 The properties-panel inventory

`docs/ideas/sprite-properties-panel.md` gives the INIT table as
`$01:817D + id*3`. The stride is 2: the table is `dw` entries
(`bank_01.asm:231`, entry 0 `InitStandardSprite`), and the MAIN table is
likewise `dw` from `bank_01.asm:898`. **verified**. The rest of the
inventory is the right shape for the "interpreted facts" leg of the contract
and this document does not duplicate it.

## 4 The tiers, tested against the code

### 4.1 Three tiers, not two: services, resources, layers

The owner's addition of a services tier survives, with one rule that makes
the boundary non-arbitrary: **a service has no notion of who won; a resource
engine does.**

| File | Tier | Why |
|---|---|---|
| `addressing.ts`, `LcLz2.ts`, `GraphicsDecoder.ts` | service | pure, no ROM identity, no arbitration |
| `GfxLoader.readGfxFile/loadGfxFile/readGfxAssignment/getLayer3GfxRange` | service | ROM in, sheet out, no state |
| `GfxLoader.loadVram` | resource engine, static-load step | assigns slots; the first contributor |
| `GfxLoader.getGfxBinDir/loadGfxFileBin` | neither | `fs` reads of an external editor's export folder; impure and outside the ROM; should not sit in `src/rom/` |
| `AnimationLoader`, `ExAnimationLoader` | resource contributors | later writers to the same slots |
| `CharFactory.buildChars` | the VRAM resource engine's arbitration | decides per char whether static, animated, or P-switch-alternate |
| `PaletteLoader.loadRomPalettes/buildLevelCgram` | resource engine, static-load step | LoadPalette order, eight sources |
| `PaletteFactory`, `PaletteOrBehavior`, sprite runtime splice | resource contributors | scattered; the record is what is missing |

So `GfxLoader.ts` straddles, which is a fact about the file, not a flaw in
the tiers. **verified** by reading the file. Nothing here needs moving to
satisfy the tiers; a resource engine is "loader plus contributor list plus
per-index record", and both resources have the loader and the contributors
today.

### 4.2 Passes, not one `render()` per engine

The owner wants each engine to own a render routine; the coordinator's
concern is that direct painting reintroduces the canvas problem. Checked:
engines paint today, into one target, in compositor order, and priority is
correct for everything vanilla exercises except OBJ.1 sprites. So "engines
own HOW, the compositor owns WHEN" is a description of the current code.

The contract that follows from section 3.1 is: a pass is a `(layer,
priority)` pair from the PPU table, engines declare which pairs they can
emit, and the compositor walks the table. Vanilla needs: L1 twice (7892
priority cells), sprites up to three times (OBJ.1, OBJ.2, OBJ.3), L2 once
(0 priority cells), L3 once with its position set by the header bit (0
priority-0 words under the bit). A hack that places one of the 19 BG tiles
with the bit set gets a correct L2 split with no new code, because the pass
list is the PPU's, not ours. **inferred** from measured facts.

Two things the pass model cannot express and should say so: the status-bar
rows, where BG3 priority is forced by the NMI regardless of header (a
scanline-region rule, section 3.1); and anything HDMA does (section 5.3).
Both are per-scanline register state, and a still compositor picks one
scanline's worth and must name which.

### 4.3 Layer 1 is the biggest hardcoded derivation, and it already has a gate

`objectHandlers/dispatch.ts` reads the per-tileset dispatch pointer tables
from the ROM and looks each 24-bit pointer up in a TypeScript map keyed by
address; a repointed handler falls to `TILE_UNKNOWN` (file header,
`dispatch.ts`). Table operands are read from the handler's own `LDA.L`
bytes (`romData.ts` header). That is pointer-equality provenance plus
live-table reads, the same shape as the sprite engine, for 6363 lines.
**verified**

What it lacks is the third leg of the contract: nobody is told. An unknown
object renders as `TILE_UNKNOWN` with no provenance surfaced to the panel or
the status bar, and no test in the repo was found that plants a repointed
object handler and asserts the decline (**unverified**: not searched
exhaustively, `grep` for `vanilla|diverg|decline` under `objectHandlers/`
found comments only). The proposal does not mention Layer 1 provenance at
all, and it is the cheapest provenance to add because the detection exists.

## 5 The shared clock

### 5.1 The defect, verified

`createRafTimer` (`src/webview/shared/animTimer.ts:40-43`) fires when
`now - lastTickMs >= interval` and then sets `lastTickMs = now`. Each period
is therefore rounded up to the next `requestAnimationFrame` boundary: with a
125 ms interval at 60 Hz that is 8 frames (133 ms); at 120 or 144 Hz it is
7.5 frames (125 ms). The cadence depends on the monitor. **verified** by
reading the code; not measured on hardware.

Six instances exist, each with a private `lastTickMs`: `mapAnimTimer`,
`spriteAnimTimer`, `palAnimTimer` in `src/webview/mapEditor/main.ts:1885,
1894, 1903`; two in `overworldViewer/main.ts:527, 540`; one in
`tilesetCompare/main.ts:72`. They start at different moments
(`main.ts:1919` for palette on load, `:1963-1964` for sprites and tiles), so
they are phase-offset from the first tick. **verified**

The constants: 133 is `ANIM_INTERVAL_MS = round(8 / 60.098 * 1000)`
(`AnimationLoader.ts:120`), citing `CODE_00A5F9` (`bank_00.asm:4891`); 67 is
`PAL_ANIM_INTERVAL_MS = round(4 / 60.098 * 1000)`
(`PaletteAnimationLoader.ts:38`), and the cycle really is every 4 frames:
`CODE_00A418` indexes `FlashingColors` by `(EffFrame & $1C) >> 1`
(`bank_00.asm:4664-4679`). 125 has no ROM origin: it is
`SPRITE_ANIM_INTERVAL_MS`, commented "preserves legacy sprite cadence",
introduced in `49fb942`; the shared walk cadence is 8 frames
(`SetAnimationFrame`, `bank_01.asm:2089-2096`, three `LSR` then `AND #$01`).
So two of three intervals are game-frame counts expressed in milliseconds
and the third is a legacy number the engine branch then back-derives 7.5
frames from. The owner's reading holds: the code already reasons in game
frames and loses precision converting. **verified**

### 5.2 Phase lock, tested

Drift is real and is not masked by render coalescing. The render effect
reads `mapTick`, `spriteTick` and `palAnimFrame` (`main.ts:100-101`) so any
bump re-renders, but the displayed frame is the tuple of three counters
(`AnimatedPixelsBehavior.frame`, each appearance's private frame,
`store.palAnimFrame`) that advance on independent schedules. Coalescing
changes when the tuple is drawn, not what it contains. **verified** by
reading.

Whether drift is a fidelity loss depends on the source of phase in the game:

- Tile animation and palette cycling both derive from `EffFrame` (bits 3-4
  and bits 2-4 respectively, cited above). In game they are locked; in the
  editor they are not. A shared clock fixes a real divergence here.
  **verified**
- Sprite walk cycles derive from a per-sprite counter seeded by `GetRand`
  at spawn (`bank_01.asm:844-845`). Their phase against `EffFrame` is
  random in game, so editor drift is not a fidelity loss; only their RATE
  matters, and the rate is what 125 gets wrong. **verified**
- One-shot state timers (`$1F`'s countdown from a seed) are per-sprite
  state, not clock state, and the properties-panel doc's free-running versus
  one-shot distinction is the right boundary. The clock should carry game
  frames; each engine converts its own counters from them. **inferred**

A settable held frame exists for scroll (`frameL1`, `frameL2`, settable via
sliders) and for palette (`store.palAnimFrame`), and does not exist for
chars or sprites because their frame is a private counter with no setter.
The scroll playback already has a correct accumulator in game frames
(`main.ts:4210-4229`), though it uses `NES_FPS = 60` where the loaders use
60.098; unify. **verified**

### 5.3 What the clock does not cover

HDMA. `CODE_00A488` (`bank_00.asm:4714`) is a per-level color-gradient
path and Layer 3 motion in some tilesets comes from HDMA tables rather than
the scroll-command dispatch (`main.ts:4022-4026` comment). Neither is
modelled anywhere in `src/rom/` (**verified** by grep: `hdma` appears only in
that comment). HDMA is per-scanline register writes to CGRAM, VRAM offsets
and scroll, so it breaks the "one resolved resource per frame" model the
proposal assumes. The honest scope is: a still compositor renders one
scanline's register state and names which; HDMA is a listed non-goal until
a level needs it.

### 5.4 Sequencing against open work

`src/webview/mapEditor/main.ts` is touched by two open branches. The sprite
properties panel's nearest hunk ends before the timer block (its `@@ -1795`
hunk is 22 lines). The engine-wiring branch's `@@ -1959,6 +1969,31` hunk sits
on `toggleAnim` and the `spriteAnimTimer.start()` site. A clock change should
land after that PR or be rebased over it; the `animTimer.ts` change itself
(accumulate rather than re-base) conflicts with neither. **verified** by
diffing both branches against `origin/develop`.

## 6 What the proposal does not cover

| Area | Fits the model? | Evidence |
|---|---|---|
| Map16 | yes, data; the tileset walk reads the bitmap and tileset pointer per `bank_05` (`Map16.ts:158-215`) | **verified**. Caveat: `TileFactory` attaches behaviours by hardcoded tile-id ranges (`$133-$13A`, `$06A-$06D`), a derivation class Pillar 1a covers and nobody has fingerprinted |
| Overworld | separate pipeline: own loader, own palette path (`loadAreaPalette`), own webview, no priority handling at all, two of the six timers | **verified**. Fits the pass model in principle; shares nothing with it today. `docs/ideas/overworld-scene-pipeline.md` is the plan there |
| Level header, entrances, screen exits | services and facts; not rendering | **verified** (`parseLevelHeader`, `parseLevelScreenExits`, `readMarioStartPos`) |
| Backgrounds vs foregrounds | object-stream L2 shares the L1 Map16 table and gets the tileset-3 palette OR (`L2Layer.ts`, `L2Factory.ts`) | **verified**; fits |
| HDMA | breaks it | section 5.3 |
| Color math and windows | not modelled; `HW_CGADSUB` is written from `ColorSettings` (`bank_00.asm:466-467`) | **verified** the write; whether any vanilla level uses translucency is **unverified** |
| Animated tiles | fits as VRAM contributors; exists | **verified** |
| Mario GFX32 DMA | missing; `loadVram` says so | **verified** |
| Third-party per-level custom palette | `loadCustomLevelPalette` exists and is used only by the GFX viewer, not the map | **verified** by grep |
| Sprite OAM priority | missing facet | section 3.1 |

## 7 Staging recommendation

Tested arguments, then the order.

**"Palette bugs dominate" is false as a frequency claim.** Fix commits
mentioning palette, color or CGRAM: 4 of 57; sprites: 24 of 57. Issue
titles: 5 of 132 palette, 25 sprite. **measured** on `git log` and
`gh issue list`. What is true is narrower: the three palette cases that
shipped wrong in one night were invisible to every automated check and were
caught by eye (`feedback_sprite_defines_palette`). That is an argument that
palette needs a rendered oracle, not that it needs an engine first.

**Clock-first and CGRAM-first are two pieces of work, not one.** Palette
cycling is one of six timer instances, and the CGRAM record (which
contributor won index N) does not touch timing. A CGRAM engine that absorbed
palette animation would inherit the timer defect only if it also absorbed
the timer; it should not, because the same clock drives tiles and sprites.
**inferred**

Order:

1. **Shared game-frame clock.** One `animTimer.ts` change (accumulate, not
   re-base; count in game frames at 60.098 Hz) and six call sites converted
   to derive their intervals from it; drop the uncited 125 for the cited 8.
   Demonstrated defect, no ROM work, about 100 lines. Sequence after the
   engine-wiring PR (section 5.4). Add a held-frame setter for chars and
   sprites at the same time only if the properties panel is ready to show
   it; otherwise not yet.
2. **OAM priority as a sprite facet, and the pass table.** Add `priority`
   to the sprite output (default 2 from `bank_00.asm:2401-2402`; per-handler
   lowering read where it is an immediate, declared unreadable where it is
   `SpriteBehindScene` runtime state) and split the sprite pass into three.
   Make the compositor's pass list the PPU table so L2 and L3 per-tile
   priority come free. About 150 lines plus a test that plants a priority
   BG tile and an OBJ.1 sprite and asserts the order. The oracle must be
   shown to fail on the current single-pass code.
3. **CGRAM per-index record.** Extend `Palette`/`Color` so each cell names
   its contributor (LoadPalette source, level OR, NMI cycle, sprite upload,
   custom palette) and the panel can show it. Move the runtime splice out of
   `EngineSpriteAppearance.rowFor` into that record with a "resting entry"
   policy. This is the smallest change that gives the properties panel "which
   source won" and it does not rewrite `PaletteLoader`, whose static order is
   cited and working.
4. **Layer 1 provenance surfaced.** When dispatch falls to `TILE_UNKNOWN`,
   say so in the map's provenance and add the planted-repoint test. Small.

Not started: a VRAM engine boundary (nothing user-visible is broken except
GFX32), the interpreter (cut), sidecar appearance overrides (scoped to
choices only), any renaming of factories to "engines". Renames are free and
buy nothing; do them when a boundary earns a name by having a test.

## 8 Not verified

- The Mode 1 priority order itself is cited to `docs/`, not to the
  disassembly, because the PPU is not in the disassembly.
- Whether the OBJ.1 case is visible in the shipped editor on any vanilla
  map (depends on pipe tiles' priority bits at those placements).
- Whether any vanilla map co-locates `$1F` with another row-15 sprite.
- Whether any vanilla level uses color math or windows.
- The timer quantisation on real displays; it is read from the code, not
  measured.
- Any hack-ROM figure quoted from the census or the divergence report; those
  documents state their own scope.
- `PaletteLoader`'s `bank_00.asm:5595-5699` citations were not re-opened
  here; the file is trusted on its own evidence.

## 9 Corrections to existing documents, for follow-up

- `docs/ideas/sprite-properties-panel.md`: INIT table stride is 2, not 3.
- `docs/rom/level-rendering.md`: describes the retired atlas pipeline, a render
  order with no Layer 3 and no priority passes, and "sprite markers";
  stale against `src/rom/model/`.
- `project_layer_render_order` memory note: now traced, and incomplete on
  OBJ.1 and Layer 3.
- `docs/ideas/overworld-scene-pipeline.md` open question 2 is answered
  above: the order was a written rule; it is now a traced pipeline with two
  named exceptions.
