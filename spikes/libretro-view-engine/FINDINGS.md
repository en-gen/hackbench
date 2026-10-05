# Libretro core as HackBench view engine: spike findings

Status: spike in progress, throwaway branch `spike/libretro-view-engine`.
Started 2026-09-19. This file is the running record; agents come and go, this stays.

**Evidence scope for the whole document.** Everything below was observed on one
machine, Windows 11, against `snes9x_libretro.wasm` from the EmulatorJS
`snes9x-wasm` package (core build 2.0.2, EJS 4.2.2), driven from the Claude
browser pane. ROM is `Super Mario World (USA).vanilla.sfc`, 524288 bytes,
headerless. No hack ROM was tested. Run counts are stated per claim; where a
claim rests on a single run it says so.

## State of the original acceptance criteria

| # | Goal | Status |
|---|---|---|
| 1 | Load a vanilla SMW ROM | **Done** |
| 2 | Reuse the existing HackBench interface | **Done.** Renders in a real VS Code webview, verified through the repo's own Playwright rig |
| 3 | Selecting a map loads it via the core | **Done.** Mechanism plus wiring; 30-44ms per load. Limited to the 438 reachable slots |
| 4 | Map paused at initial configuration | **Solved by reload.** Re-trigger the 30ms load; no savestates needed |
| 5 | Play button | **Trivial.** Resume pumping frames |
| 6 | Pause returns to edit mode and resets | **Solved.** Stop pumping, then re-trigger the load |
| 7 | Edit Mario's starting grid position | **Edit loop proven on geometry.** This specific field is gated by entrance logic; see below |
| 8 | Bonus: edit a sprite's start position | Not attempted |

### The honest asterisk on criterion 7

The edit loop is proven on level geometry. Mario's spawn position specifically
runs through the most heavily gated path in the level loader, and
`spikes/libretro-view-engine/t2-mario-start-writeback.md` documents why it was a poor first edit:

- His in-screen X can take only **5 legal values** (`0, 16, 112, 128, 224`), and
  Y only 15, because the per-level byte stores a 3-bit or 4-bit index into a
  ROM-wide shared table rather than a coordinate.
- So free drag-to-move would let a user express positions the ROM cannot
  represent. Snapping-drag or a properties panel listing legal values is the
  honest UI.

Choosing this as the first edit cost four agents. A terrain edit tests the same
hypothesis with none of the entrance logic.

## Booting straight into the level, not through the game's boot

The panel used to show the Nintendo Presents logo and the title screen on
every open. It now goes black straight into the map. Measured in emulated
frames from power-on to playable, e2e rig, vanilla ROM, level `$001`, one
machine: **463 cold, 38 restored**. The logo alone runs to roughly frame 230,
so a 66-frame arrival cannot have rendered it. Screen samples across a
restored open at 0, 150, 300, 450, 600, 900 and 1200 ms show black, then the
level, with no title screen in any of them.

Three separate things were wrong, and only the third was the one being
complained about.

**1. The WRAM search forced the boot to run.** `findWram()` ran before
everything else and located WRAM by planting a signature through the cheat
API and waiting ~90 emulated frames for the CPU to write it. Those frames ARE
the boot. The savestate cache could never help, because the search always ran
first. Fixed by caching the WRAM base alongside the state.

The base is worth caching because it is stable: observed identical across two
core instances in one session (`0x21b8c4` both times, snes9x-wasm, one
machine). It is still verified rather than trusted, and a failed verification
falls back to the search.

**2. Verification by byte fingerprint cannot work.** Whatever is running
underneath changes WRAM every frame, so an exact snapshot only matches on the
frame it was taken. Verify by invariant instead: GameMode reading a value in
the level-load sequence, twice.

**3. The state was captured at the wrong point.** A state taken at the title
screen restores TO the title screen, and mode `$0F` then dissolves it on the
way out, so every open replayed a mosaic fade of the Nintendo title. Capture
at `GM10FadeToLevel` instead: after the fade-out finishes and before
`GM11LoadLevel` reads `OverworldOverride` (`bank_00.asm:2597-2632`). The
screen is already black there and nothing level-specific has happened, so one
state serves every level.

### No fade at all, and why the mosaic could get stuck

The fade is not wanted, and trying to make it COMPLETE correctly was the wrong
repair. It is now skipped, by landing it on its own last step.

`GMTransitionMosaic` (`bank_00.asm:4075-4100`) does, per pass:

```
MosaicSize += MosaicRate[Y]          ; db -1<<4, 1<<4
Brightness += BrightnessRate[Y]      ; db 1,-1
if Brightness == BrightnessLimits[Y] ; db 15,0
    INC GameMode
HW_MOSAIC = %00000011 | MosaicSize
```

With `Y=0` those are `-16`, `+1` and a limit of `15`. So writing
`MosaicSize = $10` and `Brightness = $0E` when GameMode reaches `$13` makes
ONE pass land MosaicSize on 0 and Brightness on the limit: the mode advances
and that same pass writes `HW_MOSAIC` clear. `MosaicDirection` is pinned to 0
so the arithmetic does not depend on what the restored state left behind.

This also explains the stuck mosaic seen on a sub-area. **The transition modes
are the only code that writes `HW_MOSAIC`**, so a fade that advanced to `$14`
with MosaicSize still high leaves the hardware register set and nothing ever
clears it. Writing MosaicSize after reaching `$14` cannot help, and was tried.

Cost: restored arrival dropped from 66 to 38 emulated frames. Sub-area `$0D8`
verified rendering sharp with the correct palette.

### What a Mesen trace of a real overworld entry settled

A full CPU trace of a human entering a level from the overworld (1.07 GB,
8.3M lines, and a second 539-frame capture agreeing with it) answered two
questions that had previously been inferred from the jump table.

**The overworld's level-entry instruction is `bank_04.asm:1812-1816`**, traced
live at `$0491DD` and `$0491E5`:

```
LDA #$02 / STA KeepModeActive / ... / INC GameMode   ; Fade to level
```

That `INC` takes GameMode `$0E` to `$0F`, after which the ROM runs `$10 $11
$12 $13 $14` by itself. So forcing GameMode to `$0F` genuinely is the
overworld's own entry point, now confirmed rather than assumed.

The `KeepModeActive` write is not decoration and we were missing it.
`GMTransitionMosaic` opens with `DEC KeepModeActive / BPL Return`
(`bank_00.asm:4076-4077`), so the value sitting there decides how many frames
the transition idles. Forcing the mode without it left a stale title-screen
value in charge of the fade.

**The boot cannot be skipped.** `$00B888` executes **zero times** across the
whole trace. It decompresses GFX32/GFX33, the player's graphics, and
`bank_00.asm:2300` is its only call site in the entire disassembly, inside
`GM01Presents` behind the Nintendo Presents timer. Entering a level never
re-establishes the player's graphics; it assumes the boot already did. This
is why an earlier attempt to inject before the title screen rendered Mario as
yellow vertical stripes. Running the boot once and keeping the machine state
is the only route, which is what the cache does.

Corollary for anyone tempted by the same idea: libretro has no
"set the program counter" call, and this core's export list confirms it
(33 exports in `vendor/cores/snes9x-wasm/snes9x_libretro.js`, none reaching a
CPU register). A savestate is the only mechanism that resumes at a different
instruction, and it works because it carries WRAM, VRAM and CGRAM with it.

### Still true after this work

The FIRST open of a given ROM still boots once, about 10s, and persists the
state to disk keyed by ROM content hash. Edits reach the core as patches
applied at boot rather than written back to the file, so editing does not
invalidate that key.

The panel arrives RUNNING, not paused. Criteria 4 through 6 in the table above
are described as solved in mechanism, and they are, but no play/pause control
is wired up, so an unattended panel will let Mario be killed by a sprite.

## Edits reach the emulator, as layered patch files

The spike's original question was whether a libretro core could be the view
engine. It can. The follow-on question, whether an edit can reach it, is also
answered: yes, through ordered IPS patch layers.

Confirmed by hand in a real Extension Development Host: select a sprite in the
map editor, press Delete, open the emulator preview, and the sprite is gone.

### Shape

An edit writes ONE IPS file into `<rom>.hackbench/`, listed in a manifest that
holds application order plus the op that produced it. Base ROM plus layers in
order is what both the map editor and the emulator render. The ROM file is
never written.

IPS rather than a private format because a layer then applies with any
patcher, so it does not depend on HackBench existing. The cost is that a layer
holds ROM bytes, so the directory is gitignored.

### A layer is frozen at edit time, and that is load-bearing

Each layer is computed once against the ROM as it stood when the edit was
made, then stored as bytes. Deriving every layer from the base instead is
wrong in a way that is easy to miss: two "move this sprite one tile right"
edits each compute the same destination from the same starting position, so
flattening them moves the sprite one tile rather than two. A test asserts both
halves.

Undo drops the top layer and deletes its file rather than stacking an inverse,
so the rebuilt ROM is byte-identical to the earlier state.

### The hazard that nearly shipped silently

**27 sprite pointers in the vanilla cart are shared by more than one level
that has real Layer 1 data.** `$7C3F0` serves eight: `$C6`, `$CB`, `$F3`,
`$FF`, `$1D5`, `$1D6`, `$1E1`, `$1EE`. Sprite data is patched in place, so
editing one of those levels edits all of them, and the others would change
silently and still look correct.

The editor now names the affected levels and asks first. That is a stopgap.
The real fix is relocating a level's sprite data to free space and repointing
it, which is NOT built and is the one correctness blocker before this is safe
for general use.

### Two bugs worth remembering

**A patched ROM must be a real Buffer.** `RomFile.buffer` is type-asserted as
`Buffer` while it may hold a `Uint8Array`, and host-side readers call
Buffer-only methods on it. Passing a raw `Uint8Array` made `buildMapPayload`
throw, and its `catch` keeps the PREVIOUS model rather than failing. The
result: the emulator showed the edit and the map editor did not. A test now
asserts both the fix and the throw it guards against.

**A one-sprite change rebuilt the whole level.** Measured on level `$001`:
`buildMapPayload` 79ms of an ~85ms host total, plus shipping 512KB of ROM to
the webview and rehydrating every char, tile and sprite. The webview now drops
the sprite locally and redraws at once, with every host rejection path
re-sending so an optimistic removal cannot outlive one round trip. The
underlying cost is untouched; a targeted "sprites changed" message is the
proper fix.

### What is NOT proven

- No end-to-end test that an edit reaches the rendered frame. Hands only.
- Nothing tested against a romhack. All of this is vanilla.
- Three edit operations exist, all horizontal: move object, move sprite,
  delete sprite. No add, no vertical move, no object deletion.
- Undo is top-of-stack only.

## The core can supply graphics, so we need not decode any

The premise behind rendering a level without our own pixel pipeline: after a
level loads, the emulator holds the decompressed characters and the live
palette. Both are reachable, and a Map16 page composed from them renders
correctly.

### Where PPU memory lives

`READ_CORE_MEMORY` answers `-1 no memory map defined`, so everything is found
in the wasm heap. Measured on one machine, snes9x-wasm, 128MB heap:

| region | location | found by |
|---|---|---|
| WRAM | `0x21b8c4` | planting a signature through the cheat API |
| VRAM | `wram_base + 0x20024`, 64KB | identity, see below |
| CGRAM | `0x112888`, a separate allocation ~1.08MB below WRAM | content match |

Neither offset should be hardcoded. CGRAM's is not structural at all, and
VRAM's `+0x20024` is measured on one core instance. Re-derive per session.

**Finding VRAM needs the 3BPP detail.** The obvious search fails: SMW's level
GFX files are 3BPP, 24 bytes per tile, while VRAM holds them expanded to 4bpp
at 32 bytes, so a decompressed file never appears verbatim. What survives
unchanged is the first 16 bytes of each tile, planes 0 and 1. Search for
those, then REQUIRE the next tile's 16 bytes 32 bytes further on. GFX `$14`,
`$01` and `$20` then land at VRAM offsets `0x0000`, `0xD000` and `0xF060`:
one 64KB window, all 32-byte aligned, which a wrong base cannot produce.

**A density sweep is not good enough.** It put VRAM at `wram_base+0x20000`,
36 bytes short, and the render came out as real SMW tiles in the wrong
places. That reads as "close" rather than "broken", which is the trap.

### Composing Map16

`charNum * 32` from VRAM byte 0, and palette row times 16 colours. Both
confirmed against a Mesen tilemap readout: tile index `$182` at tile address
`$1820.w` is `$3040` bytes and `$182 * 32` is `$3040`; palette index 2 at
palette address `$20` is colour 32, which is row 2.

Map16 composition still comes from the ROM's own tables, read with the
shipped `Map16.ts`. The level's `objectTileset` matters, since page 0 is
tileset-specific.

### Palette animation, measured rather than reconstructed

Sampling all 256 CGRAM entries once per frame for 240 frames:

| level | animated |
|---|---|
| `$105`, `$00B`, `$01C` | 1 entry: index `$64`, row 6 col 4, period 4 frames, 5 values |
| `$0C5` | none |

That confirms this repo's existing note about the level NMI animating `$64`,
as a measurement of the cart rather than a claim about SMW, so it holds for a
hack that animates something else. `$0C5` matters too: a viewer cannot assume
an animated entry exists.

Enough to drive an animation toggle. Off is one CGRAM snapshot, on is
re-reading CGRAM and redrawing, and which tiles are affected follows from the
Map16 definitions: any subtile on palette row 6 using colour 4. Deferred
until the core runs alongside the editor rather than headlessly.

### What this does not solve

Sprite COMPOSITION. VRAM gives the pixels; knowing which tiles form a
Magikoopa and how they are laid out is still ROM interpretation, and
off-screen sprites are never in OAM. The core reduces that problem to tile
lookup rather than removing it.

## Repo state on this branch

Additive only. `src/providers/EmulatorPreviewProvider.ts`,
`src/webview/emulatorPreview/`, `test/e2e/emulatorPreview.spec.ts`, plus minimal
edits to `extension.ts`, `webpack.config.js` and `package.json`. One agent also
made a small additive change to the shared fixture
`test/e2e/fixtures/workbench.ts` (exposes the temp dirs); harmless and
backwards compatible, but noted because that file is shared. `npm run lint` is
clean and `tsc --noEmit` passes.

## Evidence-hygiene note on ROM paths

Two agents' reports state they used `test/roms/Super Mario World (USA).vanilla.sfc`.
That path does not exist in this worktree; `test/roms/` is gitignored and absent,
and the browser harnesses take the ROM path as a command-line argument to
`serve.py`. So the path in their prose is wrong.

The underlying data is sound. Both reported 524288 bytes headerless, one ran a
full exact compare against the file it was actually serving before every cell,
and their byte reads agree with independent verification on the real vanilla ROM
under the user's home directory: `A9 EB A0 00` at `0x16CB`, `0x5B` at
`0x2F105`, and pointer `DD 88 06` at `0x2E30F`. The Node harnesses in
`spikes/libretro-view-engine/node/` reference that absolute path explicitly.

Recorded so nobody tries to reproduce from a path that is not there.

## The question

Can a libretro core act as HackBench's view engine, rendering maps the user
edits, with edits applied by patching the ROM the core is running?

## A REAL EDIT: one object moved cleanly, and reversed

Not a deletion. The sandy triangular platform in `$105` is the screen-0 object at
file `0x308E8` (`x=13, y=18, objNum=0x3A`). Byte 1's low nibble is local X per
`src/rom/LevelParser.ts`. Changing it from 13 to 6 moves the platform 7 tiles
(112px) left.

- **Moved cleanly:** 18.98% diff, bbox x=[64,251] y=[95,192]. The platform
  slides left; logo, border, copyright and Mario icon are bit-identical.
  `t13/evidence/B2_baseline_f500.png` vs `B1_moved_f500.png`.
- **Reproducible:** two independent boots of the moved version are pixel-identical.
- **Round trip clean:** revert the byte, `system_restart()`, re-pump to frame 500,
  and the result is pixel-identical to two independent fresh baselines. So the
  edit is a controlled transformation, not corruption.

**Constraint for an editor:** object bytes are expanded into the Map16 buffer
once, at level or screen load. A byte patch only takes visual effect if applied
before that load. An editor cannot poke a live object byte and expect the current
frame to update; it must trigger a reload. The 30ms reload above is that trigger.

Untested, so not ruled out: a malformed edit that desynchronizes the stream. Only
a position nibble within its own bit field was ever touched.

## KEEPING THE LEVEL UP: tested recipe

The level dies for two independent reasons, and both need handling.

1. **Mario is killed** around frame 900. With inputs frozen he stands still and
   the first sprite on screen 0 reaches him: id `$BD`, "Sliding Koopa, no shell",
   from `$105`'s sprite stream at SNES `$07C4CA` (file `0x3C4CA`), reached via
   `Ptrs05EC00` at SNES `$05EC00` (`bank_05.asm:7247-7258`), indexed by the full
   16-bit level id times 2, fixed bank `$07`.
2. **The demo table expires.** `TitleScreenInputSeq` durations sum to 1426
   frames, then `FadeOutBackToTitle` fires (`bank_00.asm:3359-3362`).

Recipe, validated over two independent runs to **30000 frames** with 0.00% pixel
diff against a frame-500 baseline at every checkpoint, including a fine sweep
across the naive 34*255 = 8670 boundary:

1. Patch `0x16CC`/`0x16CE` to force-load the level.
2. Zero the 34 demo input bytes at even offsets `0x1C1F..0x1C61`.
3. Truncate the sprite stream: write `$FF` after the 1-byte sprite header at file
   `0x3C4CB`. Same mechanism as the object-stream truncation, bank `$07`.
4. Stretch all 34 duration bytes at odd offsets `0x1C20..0x1C62` to `$FF`.

**A cleaner-looking ASM fix was tried and rejected on evidence.** NOPing the
3-byte `STX.W TitleInputIndex` at file `0x1C7F` (`8E F4 1D` -> `EA EA EA`,
`bank_00.asm:3358`) to pin the demo at pair 0 looked tidier, but empirically
degrades: by frame 10000 it had drifted to different content and by 20000 the
frame was visually corrupted. Cause not understood. Use the data-only
duration stretch.

### Open discrepancy, stated not resolved

The WRAM-locating technique that worked first try in the Node harness (plant a
pattern via `set_cheat`, find it by exact heap search) was attempted
independently in the browser-pane harness and returned **zero heap hits**. The
Node result is validated three ways and is not in doubt there, but the method is
not confirmed portable across harnesses. Anyone relying on it should re-verify in
their own environment rather than assuming.

## THE EDIT LOOP, END TO END, AT 30-44ms

`spikes/libretro-view-engine/node/editloop.cjs`. One run, headless:

```
load #1  65 frames, 44ms   Map16 grid: 25 25 25 25 ...   ($25 = default fill tile)
patched ROM 0x308E2: 0x58 -> 0xFF   (truncate Layer-1 object stream)
load #2  45 frames, 30ms   Map16 grid: 00 00 00 00 ...
Map16 bytes differing: 256/256
```

The full cycle is: patch a ROM byte in the heap, write `GameMode` to `0x11`
(`!GameMode_LoadLevel`), let the ROM's own state machine run
`0x11 -> 0x12 -> 0x13 -> 0x14`, then read the game's own re-expanded Map16 grid.
Every one of 256 sampled tiles changed.

**No pixels are involved.** This compares the tile grid HackBench would render,
read from the cart's own expansion. It is both the edit loop and the oracle.

### Skipping the demo entirely

Once the WRAM base is known, WRAM is directly writable through the heap; cheats
were only ever needed to locate it. So the attract-mode demo, Mario's death, and
the whole title-screen detour can be bypassed by driving the game's own state
machine:

```js
H[base+0x0109] = overrideByte;   // OverworldOverride, rammap.asm:1033
H[base+0x1F11] = submapFlag;     // OWPlayerSubmap,    SMW_U.sym:10966
H[base+0x0100] = 0x11;           // GameMode_LoadLevel, rammap.asm:977
```

Cold boot reaches the title screen at about frame 285. From there a level loads
in 45-65 frames.

**Caveat on the timing figures.** 30-44ms is CPU time to execute those emulated
frames with a synchronous pump, not wall clock at 60fps. A UI that pumps the
reload synchronously and only then resumes rendering should see comparable
numbers; one that waits on `requestAnimationFrame` will take about a second for
65 frames instead. Not yet measured in a webview.

**Correction.** An earlier note in this document treated `Map16LowPtr`
(`$7E006B`) as the grid base. It is not. It is transient per-object scratch:
after loading `$105` it reads `$7EFC50`, which is `Map16TilesLow + $3450`, the
last page-table entry (`bank_00.asm` `DATA_00BAD8`), not the buffer start. The
`rammap.asm:551-559` comments describing it as "pointer to Layer 1 Map16 data"
are misleading.

## THE ORACLE: Map16 buffer layout, measured and traced

- **Fixed whole-level buffers**, not camera windows. `Map16TilesLow` at SNES
  `$7EC800` (`rammap.asm:2114`) and `Map16TilesHigh` at `$7FC800`
  (`rammap.asm:2138`), 14336 bytes each, ending exactly at their bank tops.
  **Read these fixed labels, not the pointer variables.**
- **Low/High means low byte and high byte of ONE tile id**, not Layer 1 versus
  Layer 2. `GenerateTile` (`bank_00.asm:7213-7220`) sets `Map16LowPtr+2=$7E` and
  `Map16HighPtr+2=$7F`, and the object handlers in `bank_0D.asm` write
  `[Map16LowPtr],Y` and `[Map16HighPtr],Y` per object, together forming one id
  (empty tile = low `$25` + high `$00` = `$0025`). Both layers write into the
  same pair of arrays, sequenced by `LayerProcessing` (`bank_05.asm:424-465`).
- Verified for `$105`: real content runs from offset 301 to exactly 8639, and
  `8640 = 20 screens * 0x1B0`, matching the header's screen count.
- **Per-screen stride depends on orientation and is chosen per level-mode AND
  per-layer**, via `LoadBlkPtrs`/`LoadBlkTable2` (`bank_00.asm:6999-7135`):
  horizontal `$1B0`, vertical `$200`. It is not "L1 uses one, L2 the other"; in
  mode 3 L1 uses `$200` while L2 uses `$1B0` for the same level. Modes 9 and 11
  resolve to a null pointer, matching `ObjectExpander.ts`'s existing boss-arena
  special-casing.

## THE ORACLE: results across 95 levels

Cart's own expanded grid versus `buildMapWithGraph`, swept over real and
reachable levels.

| Outcome | Levels |
|---|---|
| Identical | **62 (65%)** |
| Switch-palace tile family only | ~27 |
| **Real defect** | **5** |
| Undiagnosed | 1 |

The ~27 differ only in `$6A-$6D` vs `$16A-$16D`, which is
`SwitchPalaceAlternateBehavior` swapping the rendered quad rather than the grid
id, compared against a fresh save. Semantic, not a bug.

**The real defect, filed as a task.** `CODE_05801E` (`bank_05.asm:20-49`) forces
`ObjectTileset := 0` whenever a level's Layer 2 is a preset background (L2
pointer bank byte `$FF`), regardless of the header. `MapBuilder.ts` never applies
this. Confirmed by reading `ObjectTileset` at `$0018E1` from the running game:
all five affected levels read `0` at runtime while their headers say `1`. On
`$93`, `$94`, `$d3`, `$193`, `$194`, object `$3C` then paints a full-width wall
the cart never draws, about 212 of 432 tiles.

`$1d2` fails the other way: the cart has tiles HackBench renders as empty. Open.

**This is the oracle earning its keep.** A real rendering defect, root-caused to
an ASM line, confirmed against the running game rather than against another
reading of the same disassembly.

### A limit on the force-load mechanism, found here

Of 161 real and reachable levels, **66 failed an identity gate**: the level that
actually loaded had a runtime mode and screen count not matching the requested
id's header, many collapsing to a bogus 1-screen mode-0 level. So the
`OverworldOverride` force-load is **not reliable for every id** in the nominally
reachable set. This is a harness limitation, not a HackBench bug, and it
constrains any "select any map and preview it" feature. Undiagnosed.

## VERDICT: YES. This works.

**A ROM edit to level data reaches the rendered frame.** Proven end to end.

Recipe: force-load level `$105` by patching `0x16CC`/`0x16CE`, then truncate its
Layer-1 object stream by writing `$FF` at file offset `0x308E2`. Measured at
frames 400, 500 and 600:

| Frame | Pixel diff vs baseline (frozen demo) |
|---|---|
| 400 | 12.99% |
| 500 | 13.36% |
| 600 | 13.65% |

Visually unambiguous: the baseline shows a sandy triangular platform and green
bushes with Mario standing on the ground; the truncated run has all of it gone,
replaced by plain background. Evidence: `t10/evidence/W1_baseline_freeze_f600.png`
vs `W2_truncated_freeze_f600.png`. Independent fresh boots reproduce at 0.00%
apart, so it is fully deterministic.

**The unfrozen run is the stronger proof.** Without the demo freeze the diff
grows to 42.22% at f500 and 53.72% at f600, because Mario falls out of view
entirely: the platform his trajectory depended on no longer exists. The game's
collision and physics diverged, which a rendering artifact cannot do.

So every capability the project needs is demonstrated: load an arbitrary level
into a rendering core, edit the ROM it is executing, and see the edit change both
what is drawn and how the game behaves.

## Established: works

**Core boots and renders SMW in a browser.** 5/5 boots. Video dimensions
256x224. Evidence: `t0/evidence/q1_*.png`.

**The ROM is locatable and writable in the WASM heap.** Exactly one copy, at
`Module.HEAPU8` offset `0x80ff10`, verified by full 524288-byte compare against
disk at boot and again after 1700 frames. Heap is 134217728 bytes and
`ALLOW_MEMORY_GROWTH` never triggered growth in any session. Confirmed
independently by two agents.

**An arbitrary level can be force-loaded by patching two ROM bytes.** File
offset `0x16CC` = override byte, `0x16CE` = submap byte. This is the immediate
operand pair in `GM03LoadTitleScreen` falling through to `CODE_0096CF` and
`GM11LoadLevel` (`bank_00.asm:2613-2632`). Sole occurrence of `A9 EB A0 00` in
the ROM at `0x16CB`. Cross-check: the label `CODE_0096CF` encodes SNES
`$0096CF`, and LoROM conversion lands exactly on the `STA $0109` at `0x16CF`.

Verified with a negative control (unpatched boots to the title screen) and two
distinct levels (`$105` a forest level, `$002` a sky level), ~55% of pixels
differing pairwise.

Encoding, from the TRACED MECHANISM block in `tools/mesen/headless_capture.lua`:
`submapFlag = levelId >= 0x100 ? 1 : 0`; `lowByte = levelId & 0xFF`;
`overrideByte = lowByte < 0x25 ? lowByte : lowByte + 0x24`.
Reachable set is `[0x001,0x0DB]` union `[0x101,0x1DB]`, **438 of 512 slots**.
Low byte `$00` falls through to the overworld path; low byte `> $DB` is
unrepresentable in one byte.

**The attract-mode demo can be frozen.** Hijacking the title screen's level slot
means the game replays canned inputs from `TitleScreenInputSeq`
(`bank_00.asm:3323`), located at ROM offset `0x1C1F`: 34 two-byte
(input, duration) pairs, `$FF` terminator at `0x1C63`. Zeroing the 34 input
bytes at even offsets leaves Mario standing still. Verified identical bounding
box across 600 frames. Do NOT use `$FF` to stop the demo; it is the end-of-data
sentinel and falls into `FadeOutBackToTitle`, exiting the level.

**`simulate_input` works**, even on the forced-level-load path. Mario ran right
and died on command.

**The core runs inside a real VS Code webview, rendering a level.** Verified
through the repo's own Playwright-against-real-VS-Code rig (`test/e2e/`, from
PR #371), not a hand-assembled image. Evidence:
`t9/evidence/vscode-emulator-preview.png` shows the Extension Development Host
with HackBench's Maps tree and an "Emulator Preview: $105" panel rendering the
level. Reproduced on two runs.

**Core load time over the webview transport is 195ms** for the 6.3MB wasm plus
JS glue, measured around the `EJS_Runtime()` factory call, identical across two
runs. Much cheaper than expected; this is not a bottleneck.

The working configuration, which is the reusable part:

- CSP: `default-src 'none'; script-src 'nonce-X' 'wasm-unsafe-eval' 'unsafe-eval';
  connect-src <webview.cspSource>; style-src 'unsafe-inline';` This is the same
  combination `MapEditorProvider` already uses for `spc.wasm`. Worked first try.
- `localResourceRoots` must include both `dist/webview` and
  `vendor/cores/snes9x-wasm`.
- Override `Module.locateFile` to return the `webview.asWebviewUri(...)` result
  for the `.wasm`. The core's own `document.currentScript`-relative default never
  engages once overridden, and `document.currentScript` turned out to behave
  correctly in a webview anyway, contrary to expectation.

Implementation: `src/providers/EmulatorPreviewProvider.ts`,
`src/webview/emulatorPreview/main.ts`, `test/e2e/emulatorPreview.spec.ts`, plus
minimal additive edits to `extension.ts`, `webpack.config.js` and
`package.json`. 305 lines. `npm run lint` clean (0 errors, 14 pre-existing
warnings in other files), `npm run compile` builds all 9 webpack configs.

Level selection is wired, not hardcoded: `hackbench.openEmulatorPreview(levelId?)`
falls back to reading the active `hackbench.mapEditor` tab's `.smwmap` descriptor
through the existing `smwrom://` filesystem, with no `MapEditorProvider` changes.
The e2e test drives the command with no map tab open, so the screenshot shows the
`0x105` fallback path rather than the wiring being exercised.

## Established: does not work

**ROM edits above bank `$00` do not reach the rendered frame.** Patches at
`0x2D94F` (branch NOP, bank `$05`), `0x2F105` / `0x2F305` (spawn tables, bank
`$05`), and `0x308DD`+ (Layer-1 objects, header, and a full truncation of the
object stream, bank `$06`) all verifiably persist in the heap, on immediate
readback, after `_system_restart`, and after 1700 further frames, yet render
pixel-identical. Reproduced independently by two agents.

Truncating the entire object stream to zero objects left the terrain unchanged
and Mario still standing, which is impossible if the CPU were reading the
patched bytes.

**WRAM cannot be located in the heap by behavioral scanning.** ~1700 candidates
semantically write-tested, plus a neighborhood sweep and outliers. Zero hits.
An earlier claimed base of 7537574 is wrong, not merely unconfirmed.

**Savestates: we were calling them wrong. Now solved on paper, not yet tested.**
Full detail in `spikes/libretro-view-engine/t11-emulatorjs-api.md`, traced to `EmulatorJS/EmulatorJS`
`data/src/GameManager.js` at v4.2.2 and the underlying C in
`EmulatorJS/RetroArch` `tasks/task_save.c`.

- Save: call `save_state_info()` as a **string** (`cwrap(..., 'string', [])`),
  not a number. It returns `"size|pointer|flag"`. Parse it and read the state
  bytes directly from `HEAPU8` at `pointer .. pointer+size`. No filesystem.
- Load: `FS.writeFile('/game.state', bytes)` then `load_state('game.state', 0)`.
- `load_state`'s return value is meaningless by construction. The C is
  `int load_state(char *path, int rv) { content_load_state(path,false,false); return rv; }`
  It returns its second argument. An agent inferred this from behaviour and was
  right.
- `cmd_save_state()` is a real but different code path, RetroArch's async
  desktop save-to-file task, whose destination EmulatorJS never configures. That
  is why it wrote nothing findable.

**Memory access: candidate paths exist, none yet tested.**

- `READ_CORE_MEMORY` / `WRITE_CORE_MEMORY` over
  `Module.EmscriptenSendCommand()` / `EmscriptenReceiveCommandReply()`.
  RetroArch's standard remote-command protocol, predates our build, read and
  write. Needs the core to expose a memory map; unverified for snes9x.
- `get_memory_data("RETRO_MEMORY_SYSTEM_RAM")` would be cleanest, a live pointer
  into WRAM, but was added in commit `ed326574` dated 2026-02-06, eight months
  after our core build. Probably absent; check by grepping the wasm export table
  for the literal string.
- `set_cheat` / `reset_cheat` confirmed present, write-only, forwards raw code
  strings to snes9x's own decoder via `retro_cheat_set`. Enough to plant a known
  byte at a known SNES address and then locate WRAM by exact search rather than
  by the behavioural guessing that already failed.

**Checked against our actual binary** (`vendor/cores/snes9x-wasm/`):

| String | In wasm |
|---|---|
| `READ_CORE_MEMORY` | **present** |
| `WRITE_CORE_MEMORY` | **present** |
| `get_memory_data` | absent |
| `RETRO_MEMORY_SYSTEM_RAM` | absent |
| `EmulatorJSGetMemoryData` | absent |

So the command-channel path is the one to pursue, and the post-dated
`get_memory_data` API really is missing as predicted.

Caveat on method: `save_state_info` also greps as absent despite being
demonstrably callable, returning 780656. Binary grep gives false negatives here.
Treat the positives as reliable and the negatives as suggestive only.

This is the highest-value untested item left. A working memory read would give
`GameMode` polling (so we stop guessing frame numbers, which is what cost this
spike six agents) and `Map16LowPtr` at `$7E006B`, which is the oracle: the
cart's own expanded Map16 grid, computed by the ROM's handlers, readable on any
romhack.

**Savestates did not work through the exported functions as first attempted.** `cmd_save_state()`
writes no file anywhere in the emscripten FS, even after pre-creating the
configured state directories. `load_state(a,b)` returns exactly its second
argument for every combination tried, so the return is not a success flag.
Restores never restored. However `supports_states()` returns 1 and
`save_state_info()` returns a constant 780656, consistent with
`retro_serialize_size()`, so the core CAN serialize and the plumbing is what is
missing.

**`_pause_main_loop` / `_resume_main_loop` do not exist** in this build. Only
`toggleMainLoop(i32)` is exported, established by parsing the wasm binary's
Type/Function/Export sections. `toggleMainLoop` produced no observable halt, but
this is very likely an artifact: the harness monkeypatches
`requestAnimationFrame` and pumps frames synchronously, bypassing the scheduler
that pause gates. In any environment where we drive the pump, pause is trivially
"stop pumping".

## RESOLVED: writes DO reach the CPU

A 2x2 experiment (bank `$00` vs `$05`, patched before boot vs after
`_system_restart`) returned **all four cells working**, two runs each, zero
run-to-run variation.

- Bank `$00` control: patching `0x16CC`/`0x16CE` pre-boot and post-restart both
  load level `$105`, 99.5% pixel diff from baseline, the two cells pixel-identical
  to each other.
- Bank `$05`: overwriting `Layer1Ptrs[$C7]` at file `0x2E255` with
  `Layer1Ptrs[$105]`'s bytes changed the title screen's terrain, 94.9% diff,
  again identical pre-boot and post-restart.

Artifact controls, both returning 0.0% diff: calling the ROM-locating scan with
zero bytes changed, and writing a byte to its own stock value. So the observed
changes were caused by content, not by the act of writing.

**Neither bank nor timing gates reachability.** Both earlier hypotheses are dead.

Also disproved: the idea that `_system_restart` is a partial soft reset
preserving WRAM. It was directly observed replaying the entire boot sequence,
black screen through "Nintendo Presents" to the title.

## SOLVED: WRAM is readable, and a headless Node harness exists

Two things that change how all of this should be done.

### The core runs headless under Node

No browser, no canvas, no VS Code, no port contention, and a loop measured in
seconds rather than minutes. `spikes/libretro-view-engine/node/harness.cjs` and `spikes/libretro-view-engine/node/oracle.cjs`.

Requirements: supply `wasmBinary` directly rather than letting it fetch, shim
`document`/`window`/`ResizeObserver`/`WebGL*`, give `document.body` event
methods, return a permissive Proxy from `canvas.getContext()`, and set
`video_driver = "null"` alongside `audio_enable = false`.

### WRAM located by identity, not guessing

`set_cheat` writes to SNES bus addresses. Plant a distinctive pattern, then find
it in the heap by exact search:

```js
const setCheat = M.cwrap('set_cheat','null',['number','number','string']);
// code format AAAAAAVV: six hex digits of SNES address, two of value
setCheat(i, 1, '7E1000A5');   // writes $A5 to $7E1000
```

Plant eight bytes at `$7E1000`, pump ~60 frames, search `HEAPU8` for the exact
pattern, subtract `0x1000`. **WRAM base came out at `0x21b8c4`.**

Validated three independent ways:

| Check | Result |
|---|---|
| Planted pattern found | single hit, exact |
| `GameMode $7E0100` at title screen | `7`, matching `!GameMode_TitleScreen` (`rammap.asm:989`) |
| `TrueFrame $7E0013` over 60 pumped frames | advanced exactly 60 mod 256 |
| `EffFrame $7E0014` over the same | advanced exactly 60 mod 256 |

An earlier agent spent ~1700 semantically-tested candidates on behavioural
scanning and found nothing. Planting a known byte found it on the first attempt.

### The command channel is a dead end, definitively

`READ_CORE_MEMORY` and `WRITE_CORE_MEMORY` are present and the channel replies,
but snes9x answers `-1 no memory map defined`; it never calls
`RETRO_ENVIRONMENT_SET_MEMORY_MAPS`. `READ_CORE_RAM` (achievements-gated)
returns nothing. Closed, not unknown.

### The oracle works

With WRAM readable, `Map16LowPtr` at `$7E006B` resolves to `$7EBAB0` once a level
is up, and the bytes there are real Map16 tile IDs:
`59 59 59 59 ... 5a 5b 59 59 ...`. That is the cart's own expanded tile grid,
computed by the ROM's own handlers, readable on any romhack. It is the
correctness check `ObjectExpander` has never had.

## SOLVED: what frame 1700 was actually showing

Polling `GameMode` through a full run gives the whole story:

```
f230:  0x07 TitleScreen       <- demo starts, level $105 loads, override works
f950:  0x15 FadeToGameOver    <- Mario DIES
f990:  0x17 GameOver
f1295: 0x0B FadeToOverworld
f1390: 0x14 Level             <- a DIFFERENT level, via the normal overworld path
```

With inputs zeroed Mario stands still and a sprite reaches him around frame 950.
The game falls through Game Over to the overworld and loads whatever the save
file points at. **Every agent measuring at frame 1700 was looking at a different
level loaded by a different path**, which is exactly why patches to `$105`'s
tables appeared inert.

The earlier explanation in this document, that the demo's ~1426-frame duration
sum expires first, is wrong as the operative cause. Death gets there first. The
duration figure is real but not what ended the level.

**The fix is not a better frame number. It is to poll `GameMode` and require
`0x14`, and to check it has not moved to `0x15` before trusting a measurement.**

## Also solved: every null result was measured at the wrong frame

Hijacking the title screen's level slot means the game runs its attract-mode
demo, and **that demo is finite.** `TitleScreenInputSeq` at ROM `0x1C1F` is 34
(input, duration) pairs; the 34 duration bytes at odd offsets sum to roughly
**1426 frames**. When the `$FF` terminator at `0x1C63` is reached,
`bank_00.asm:3359-3365` falls into `FadeOutBackToTitle` and sets `GameMode` to
`FadeToTitleScreen`. Freezing the input bytes zeroes the buttons but leaves the
durations intact, so the sequence still expires on schedule.

**Every agent measured at frame 1700, past the end of the thing being tested.**
Five null results across five agents, all from the same wrong measurement point.
It also explains the transition blackout one agent hit around frame 1200.

Level `$105` genuinely does load. It was directly observed at **frames 360-600**
as a light-blue cave background with a sandy triangular platform, matching an
independent redirect of `Layer1Ptrs[$C7]` to `$105`'s data. It is simply not
what is on screen by frame 1700.

Evidence: redirecting `Layer1Ptrs[$105]` to `Layer1Ptrs[$002]`'s bytes gave
0.04% diff at frame 1700 (one HUD digit), while the early-frame trace
(`t10/evidence/namebanner_105_f*`) shows the real geometry.

**Measure at 400, 500 and 600.** For a longer window, also patch the duration
bytes at odd offsets `0x1C20..0x1C62` to `$FF`, which stretches the sequence to
roughly 34 * 255 frames with the terminator intact.

Caveat: the demo freeze is not side-effect free. It was observed to break level
`$005` specifically, leaving the logo up instead of gameplay. Run tests both
with and without it.

## The former open question, now explained

Reachability is not the variable. Which reads happen on our load path is.

Note the offsets, which now contradict any bank-based story:

| Offset | Bank | What | Result |
|---|---|---|---|
| `0x2E255` | `$05` | `Layer1Ptrs[$C7]` pointer | **works** |
| `0x2F105` / `0x2F305` | `$05` | spawn tables | no effect |
| `0x308DD`+ | `$06` | Layer-1 object data | no effect |

Same bank, opposite outcomes.

One observation is the thread to pull. Redirecting `Layer1Ptrs[$C7]` to
`Layer1Ptrs[$105]`'s bytes produced blue mountain/cave terrain, while loading
`$105` normally produces green forest. Two readings:

1. Geometry is redirected but tileset and palette are not, so the same shapes
   render under different graphics.
2. **Loading `$105` via `OverworldOverride` does not read `Layer1Ptrs[$105]` at
   all**, in which case every patch to the data it points at was always inert.

Reading 2 would explain every failed edit in this spike at once. The
distinguishing test is to redirect `Layer1Ptrs[$105]` itself (file `0x2E30F`)
to another level's bytes while loading `$105` normally, and see whether the
terrain changes.

### The pointer chain checks out arithmetically

Worth recording, because it means the failure is not an offset error anywhere in
the chain:

`CODE_05D8B7` (`bank_05.asm:7227-7240`) runs under `REP #$30`, so `LDA.B _E`
reads the `_E`/`_F` pair at `$7E000E`/`$7E000F` as one 16-bit level id, then
`ASL` + `ADC _E` multiplies it by 3. For `$105`: `$105 * 3 = $30F`, so
`Layer1Ptrs + $30F` = SNES `$05E30F` = file `0x2E30F`. The pointer there reads
`DD 88 06` = SNES `$0688DD`, which converts to file `6 * 0x8000 + 0x08DD` =
`0x308DD`. Every agent's arithmetic agrees, and `HEADER_SIZE = 5`
(`src/rom/LevelParser.ts:132`, citing `CODE_0584E3:645-651`) makes `0x308E2` a
genuine first-object boundary.

So "we patched the wrong byte" is ruled out. Either the data is read and the
patch should have shown, or a different level is being loaded.

### One hypothesis raised and disproved statically

I suspected `LDA.W OWPlayerSubmap,Y` (`bank_05.asm:7221`) might read the wrong
byte, because the `TAY` that sets `Y` to the player index
(`bank_05.asm:7204-7208`) sits on the normal overworld path, which the override
branch skips. It does not. `CODE_05D83E` at `bank_05.asm:7165-7168` reads:

```
CODE_05D83E:
    STZ.B _F
    LDY.B #$00
    LDA.W OverworldOverride
    BNE CODE_05D8A2
```

`Y` is explicitly zeroed immediately before the override branch, so the read is
`OWPlayerSubmap[0]` at `$7E1F11` exactly as `headless_capture.lua` traced it.
Also checked: `ClearMemory` does cover `$7E1F11`, but runs at the top of
`GM03LoadTitleScreen` before `CODE_0096CF` writes the submap, and GM03 falls
straight through into `GM11LoadLevel`, so the ordering is sound on paper.

### Still worth testing empirically

Whether `_F` actually ends up 1. Loading `$005` instead of the intended `$105`
would make every patch indexed at `$105` inert, which fits every failure in this
spike. `$005` is DONUT PLAINS 3 and `$105` is Yoshi's Island 1; both are
grassland, which is a plausible reason nobody questioned the screenshots. The
test is to boot `0x16CE` = `$01` and `0x16CE` = `$00` with everything else
identical and diff the frames. Ground truth on which level loaded is available
from this repo's own `src/rom/SmwLevelNames.ts`, which decodes the ROM's name
table at `$04A0FC` (indexed by translevel, not level id).

## Cost, measured

| Operation | Wall clock | Runs |
|---|---|---|
| Cold boot to gameplay (1700 pumped frames) | ~1.7s | 1 |
| `_system_restart` to gameplay | ~2.0s | 1 |
| `_system_restart` call itself | ~0.4ms | 1 |

A held `simulate_input` press is sticky and survives `_system_restart`, and hung
one run on a black screen for 4000+ frames until released.

## Gotchas that cost hours

1. **`audio_enable = false` in `retroarch.cfg` before boot is mandatory.**
   RetroArch gates core stepping on audio buffer drain and WebAudio never drains
   here. Without it the core boots, reports correct video dimensions, and never
   steps a frame. It looks exactly like a broken core.
2. **`requestAnimationFrame` stalls permanently** (after ~7 calls) when the
   browser pane is occluded. Workaround: monkeypatch rAF to a capture-only stub
   and invoke it synchronously, re-arming with `Module.resumeMainLoop()`.
3. **The canvas needs a fixed CSS size.** Otherwise a DPI path runs away
   (1280x960 to 2560x1920 to 81920x61440) and aborts the instance with
   `RuntimeError: unreachable`. Do not click the canvas either; it crashed the
   core once.
4. `cmd_take_screenshot` and other `cmd_*` calls are deferred to a later core
   iteration. Poll with a pumped frame, never `setTimeout`.
5. **`findRom()` only works before any patch**, since it matches against the
   pristine disk image. After a patch it returns -1 and callers read garbage
   from a bogus offset. Cache the offset once at boot.
6. Frame ~1200 can land in a transition blackout; 1700 and 2300 post-restart are
   known-good measurement points.
7. **The browser pane is a single shared resource.** Concurrent agents driving
   it collide: tab focus changes underneath them and JavaScript lands on another
   agent's page. Serialize browser work, or origin-guard every call.
8. **`parent: document.body` is mandatory in the `EJS_Runtime` config.** Omit it
   and Emscripten's `specialHTMLTargets["!parent"]` resolves to `undefined`, a
   later `document.querySelector("!parent")` fallback throws
   `'!parent' is not a valid selector`, and boot dies silently. Root-caused by
   grepping the vendored core's own source.

## Defects found in existing repo content

**`readMarioStartPos` ignores the per-level screen number.**
`src/rom/L3Loader.ts:296-322` has no orientation branch and never reads
`DATA_05F600`. The ASM (`bank_05.asm:7375-7384`) overwrites the provisional X
high byte with the screen number for horizontal levels, and the Y high byte for
vertical ones. 32 of 512 levels have a nonzero screen number: 26 horizontal
(wrong X) and 6 vertical (wrong Y). Filed as a separate task.

**`SMWDisX/bank_05/MEMO.md:76` states a gating condition backwards**, as
`ShowMarioStart != 0`. `bank_05.asm:7419-7420` is `LDA.W ShowMarioStart / BNE`,
which skips the hardcode when nonzero, so the condition is `== 0`.

## Useful discoveries

`SMW_U.sym` is a compiled symbol table and settles RAM addresses
authoritatively, rather than counting `skip` directives in `rammap.asm`.
`UseSecondaryExit` is `$7E1B93` (`SMW_U.sym:12265`).

Level `$105` is Yoshi's Island 1 (`docs/rom/smw-overworld-wram.md:47`), 5120x432,
20 screens (`docs/spikes/per-pass-canvas-spike.md:55`).

## Licensing note

The vendored core is snes9x, whose licence is non-commercial freeware, not open
source. Fine for a throwaway spike that distributes nothing. If any of this
ships, use bsnes (GPLv3) or ares (ISC) instead, and note that obligations
trigger on distribution regardless of whether money changes hands.
