# Emulator-Backed Oracle Testing

Status: proposal, not implemented. Drafted 2026-09-13, revised same day after
an adversarial pass invalidated the first determinism claim.

Extends [docs/testing.md](../testing.md) with new test categories backed by
headless Mesen. Read the legal position in that document first; nothing here
changes it.

## Problem

Rendering correctness is currently validated by a human looking at the screen
and reporting what looks wrong. That loop is slow, non-reproducible, and cannot
gate a pull request. An agent working on the render pipeline has no way to
self-check its work.

The gap is measurable. Running the suite twice, once with a local ROM and
fixtures present and once from a clean checkout (the CI condition):

| | Collected | Passed | Skipped |
|---|---|---|---|
| Local | 2277 | 2270 | 7 |
| Clean checkout | 2221 | 2159 | 62 |

111 tests (4.9%) do not run in CI. This is by design and matches the policy in
`docs/testing.md`. The concern is not the count but the concentration:

```
  31  AnimationLoader.tilesets.test.ts    CI runs   0/31
  13  ObjectExpander.test.ts              CI runs 163/176
  12  L3Loader.test.ts                    CI runs  25/37
  10  AnimationLoader.test.ts             CI runs   0/10
   8  integration/mapBuilder.test.ts      CI runs   0/8
   8  scrollDispatch.test.ts              CI runs   0/8
   7  integration/smwRom.test.ts          CI runs   0/7
   6  SpcBuilder.test.ts                  CI runs   0/6
   5  L2Loader.test.ts                    CI runs   0/5
   5  PaletteLoader.test.ts               CI runs   2/7
   4  GfxLoader.test.ts                   CI runs   0/4
   2  ExAnimationLoader.test.ts           CI runs   6/8
```

Every module implicated in outstanding render defects is dark or nearly dark in
CI: `GfxLoader` 0 of 4, `PaletteLoader` 2 of 7, `AnimationLoader` and its
tileset companion 0 of 41, `L2Loader` 0 of 5, and the entire integration suite
0 of 15. The 4.9% that is missing is close to the whole of the project's
empirical coverage.

## Mesen headless capability

Verified against `tools/mesen/Mesen.exe` and
`test/roms/Super Mario World (USA).vanilla.sfc` on 2026-09-13. The LM-modified
`.magic.sfc` was not used and is not suitable.

Mesen 2 ships a headless test-runner mode:

```
Mesen.exe --testrunner <script.lua> <rom>
```

It loads the ROM and the Lua script, runs at maximum speed with no GUI, and
exits when the script calls `emu.stop(code)`.

Confirmed working:

1. **Headless rendering.** `emu.takeScreenshot()` returns a PNG as a Lua
   string, full composed SNES output at 256x224.
2. **Exit codes propagate.** `emu.stop(42)` produced process exit code 42.
3. **State injection.** `emu.createSavestate()` returned a 178,929 byte string
   and `emu.loadSavestate()` restored it: a poke to `$7E0DBF` reverted from
   `0x77` to `0x00` and `frameCount` rewound from 339 to 304.
4. **Input injection.** `emu.getInput(0)` returns the full SNES pad, and
   `emu.setInput` drives a scripted route.
5. **PPU register state.** `emu.getState()` exposes `ppu.bgMode`,
   `ppu.mainScreenLayers`, `ppu.subScreenLayers`, `ppu.scanline`, `frameCount`,
   and per-layer `ppu.layers[0..3]` fields `hscroll`, `vscroll`,
   `tilemapAddress`, `chrAddress`, `largeTiles`, `doubleWidth`, `doubleHeight`.
6. **Video memory is directly readable.** `emu.read` accepts memory types
   `snesVideoRam`, `snesCgRam`, `snesSpriteRam`, `snesWorkRam` and
   `snesPrgRom`. This is the basis of the parity design below.

### API gotchas

- `emu.createSavestate` and `emu.loadSavestate` must be called from inside an
  `emu.addMemoryCallback` handler registered with `emu.callbackType.exec`.
  From an `endFrame` event callback they fail with "This function must be
  called inside an exec memory operation callback for the main CPU".
- `emu.takeScreenshot()` returns 256x224. `emu.getScreenBuffer()` returns
  61,184 entries, which is 256x239 including overscan. Do not mix the two.
- The existing `tools/mesen` Lua dumpers are interactive, driven by Space and
  the arrow keys. They must be reworked into scripted routes to run headless.

## Determinism: required conditions

An earlier draft of this document claimed the emulator was deterministic on the
evidence of three sampled frames, captured during boot and title screen, with
no input injection, in a single session on one machine. **That claim was
wrong.** It is recorded here because the failure mode it nearly introduced, a
flaky oracle producing arbitrary green and red, is worse than having no oracle.

Proper test: six cold-process runs, sampling power-on WRAM plus screenshots and
an 8KB WRAM region ($7E0000-$7E1FFF) at frames 900, 1800, 2700 and 3600. Those
are real gameplay frames because SMW's attract demo runs unattended, exercising
sprites, physics and RNG. A fixed input schedule was injected via `emu.setInput`
to exercise that path too.

| Condition | WRAM across 6 runs | Screenshots across 6 runs |
|---|---|---|
| Default settings | 6 variants | 3 to 4 variants |
| `+ rampoweronstate=AllZeros` | identical | 2 to 3 variants |
| `+ disableframeskipping=true` | identical | identical |

Two independent sources of nondeterminism, neither visible in the original
probe:

1. **Power-on RAM randomization.** `tools/mesen/settings.json` carries
   `Snes.RamPowerOnState = "Random"`, so uninitialized WRAM differed on every
   run. Note that `Snes.EnableRandomPowerOnState = false` does **not** gate
   this, despite the name.
2. **Frame skipping.** With RAM zeroed, emulation was deterministic but
   `takeScreenshot` still varied. The video path drops frames at maximum speed,
   so the capture did not reliably correspond to the requested frame.

A third hazard is not a setting but a side effect:

3. **SRAM carryover.** Every run writes `Saves/<rom>.srm`. Run N+1 therefore
   starts from run N's savegame unless the file is controlled. Any harness must
   reset or pin it per run.

**Required invocation for any capture:**

```
Mesen.exe --testrunner <script.lua> <rom> \
  --snes.rampoweronstate=AllZeros \
  --snes.disableframeskipping=true
```

Still unproven, and must not be assumed: determinism across machines, across
Mesen builds, and across operating systems. Option A below depends on it.

## Design: parity by state, not by picture

HackBench draws an editor view: whole level, arbitrary scroll, no HUD, grid
overlays, animation frozen. Mesen draws a gameplay frame: 256x224, sprites,
status bar, HDMA, color math. These are different artifacts by intent and will
not match pixel for pixel. A design that compares final images produces either
false failures or a threshold so loose that it catches nothing.

The resolution is to compare the state that produces the picture rather than the
picture. VRAM, CGRAM and OAM are the PPU's inputs. They are
presentation-independent: they describe what the hardware would draw regardless
of how either side chooses to display it. HackBench's pipeline emits
intermediates that map onto them directly.

| Tier | Oracle | Validates | State |
|---|---|---|---|
| 1. Model | `map16.txt` Lua dump | object expansion, whole-level grid | exists |
| 2. Register | `emu.getState()` PPU fields | scroll, layer enable, BG mode | proposed |
| 3. Video memory | `snesVideoRam`, `snesCgRam`, `snesSpriteRam` | GFX decode, palette, tilemap, sprite placement | proposed |
| 4. Composite | framebuffer | compositor only, narrow | optional |

### Tier 2: register assertions

For a level and a fixed scripted route, record PPU register values per frame and
assert HackBench's model produces the same values. Example: at frame N of route
R in level `$105`, the model's `Layer2YPos` equals `ppu.layers[1].vscroll`.

Small numeric expectations, no images. A failure names the wrong number. This
targets the layer scroll divergences that have cost the most time.

### Tier 3: video memory parity

The centre of this design. Compare HackBench's intermediates against the
emulator's actual video memory at a defined frame:

| HackBench artifact | Emulator oracle | Memory type |
|---|---|---|
| `GraphicsDecoder` tile bitmaps | tile data in VRAM | `snesVideoRam` |
| `PaletteLoader` CGRAM rows | actual CGRAM | `snesCgRam` |
| BG tilemap entries | actual BG tilemap | `snesVideoRam` |
| Sprite `Appearance` output | actual OAM entries | `snesSpriteRam` |

Every failure is diagnostic. "CGRAM row 6 entry 4 is `$1C7F`, expected `$0C7F`"
rather than "2,140 pixels differ". This tier maps directly onto the modules that
are currently dark in CI: `GfxLoader`, `PaletteLoader` and `AnimationLoader`
exist to produce VRAM and CGRAM contents, so their output is exactly what this
compares.

**Boundary.** VRAM holds only what is currently uploaded: the visible window
plus whatever SMW has DMA'd for the current animation frame. This tier validates
the decode, palette and upload path precisely at a defined frame. It cannot
validate whole-level object expansion, because that data is not in VRAM. That
remains Tier 1's responsibility, where it already works.

### Tier 4: composite comparison, optional

A narrow check on HackBench's compositor: feed it emulator-supplied VRAM and
CGRAM, render one BG layer with the others force-blanked, sprites off and scroll
pinned, then compare rasters.

This tier may not be worth building. If the constrained case turns out too
artificial to resemble anything a user sees, drop it. Tiers 1 to 3 already cover
every module that has produced defects. It is recorded as optional rather than
planned.

## Validating the harness itself

A wrong oracle manufactures false confidence at scale, which is worse than no
oracle. The project already has a live example: `smw-mcp`'s `get_ram_writes`
returns "0 write sites" for RAM variables that have five writers, because it
matches only literal `$XXXX` operands and the disassembly writes symbolically.
Confident, empty, and wrong.

**Hard requirement: mutation proof.** No oracle is trusted until it is
demonstrated to fail on deliberately injected defects. For each tier, inject a
known bug into otherwise-correct code and require the oracle to go red:

- scroll value off by one (Tier 2)
- palette row swapped (Tier 3, CGRAM)
- tile index off by one (Tier 3, VRAM)
- BG priority bit inverted (Tier 3, tilemap)
- sprite Y offset shifted (Tier 3, OAM)

An oracle that cannot catch a planted bug is theater. These proofs are cheap and
are a merge requirement, not a follow-up.

Additional failure modes an adversarial reviewer should hunt:

1. **Same-source fallacy.** If expectation and assertion both derive from one
   capture, the test proves the capture is self-consistent, not that HackBench
   is correct. Comparison must always be emulator against HackBench.
2. **Regenerate-until-green.** Locally regenerated baselines invite laundering a
   regression into a new expectation. Regeneration must be explicit, logged and
   reviewed, never automatic and never a side effect of running tests.
3. **Route drift.** A scripted route that walks off a ledge still produces
   deterministic output. The test stays green while measuring something else.
4. **Skip-on-missing-ROM.** A wholly broken harness shows green in CI because it
   does not run there. That is precisely how the 111-test hole stayed invisible.

## Copyright constraints

`docs/testing.md` forbids committing ROM-derived bytes in any transform.

**Never committed:** the ROM; savestates, which snapshot emulated WRAM, VRAM and
CGRAM; golden PNG frames, which are frames of Super Mario World; `map16.txt`;
any VRAM, CGRAM or OAM dump; any decompressed GFX or palette data.

**Safe to commit:** the Lua route scripts and harness, which are original to
this project; SHA-256 digests of expected artifacts, which carry no expressive
content; Tier 2 and Tier 3 numeric expectations, which are measurements rather
than creative expression.

Determinism under the required flags is what makes this workable. Because a
scripted route reproduces byte-identical output, no savestate, golden image or
memory dump needs to be stored. All are regenerated locally on demand, and only
digests and numeric expectations are tracked.

## The central decision: where does this run

Tiers 2 to 4 need the ROM. The ROM cannot be in the repository or on a
GitHub-hosted runner. Without resolving this, the new tiers join the existing
111 tests in the dark and the proposal delivers nothing.

**A. Self-hosted runner.** A machine holding the ROM outside the working
directory, registered as a GitHub Actions runner. Full gating on every pull
request, including agent-authored ones. Costs a machine to maintain, introduces
a runner with repository access, and depends on cross-machine determinism that
is currently unproven.

**B. Mandatory local pre-push gate.** A git hook or explicit
`npm run test:oracle` that contributors run, with the result recorded in the
pull request. No infrastructure. Relies on discipline, and an agent can run it,
which is the main audience here.

**C. Explicit skip-count baseline.** Keep ROM-truth developer-local, but have CI
report how many tests were skipped and fail if that count rises above a recorded
baseline. Cheap, prevents silent erosion, never validates rendering in CI.

Recommendation: **B first, then A, with C regardless.** B is implementable now
and serves the actual goal, which is letting an agent verify its own render work
before requesting review. A is the durable answer but should not block the
harness being built, and needs the cross-machine determinism question answered
first. C is a few lines and directly addresses the erosion risk measured above.

## Phasing

1. Convert one `tools/mesen` dumper to a scripted headless route: no
   interactivity, fixed input schedule, deterministic exit, required flags
   enforced, SRAM pinned.
2. Tier 2 harness: capture PPU registers per frame, emit numeric expectations,
   assert from vitest. Mutation proof required before merge.
3. Tier 3 harness: capture VRAM, CGRAM and OAM at defined frames, compare
   against `GraphicsDecoder`, `PaletteLoader` and `Appearance` output. Mutation
   proof required before merge.
4. Add the skip-count baseline to `ci.yml` (option C).
5. Decide the runner question and implement B, then A.
6. Re-evaluate whether Tier 4 is worth building at all.

Every phase gets two independent fresh-agent reviews against the diff,
adversarial and simplification, with findings relayed verbatim and flawed work
scrapped rather than patched.

## Non-goals

- Replacing the Tier 1 fixtures. They work.
- Testing webview UI interaction. Separate question, would need
  `@vscode/test-cli` or Playwright.
- Reviving the dead `npm test` script, which references
  `dist-test/test/runTests.js` built from a `test/runTests.ts` that does not
  exist. Worth fixing, unrelated to this design.

## Open questions

1. Is the emulator deterministic across machines, operating systems and Mesen
   builds? Option A depends on it and it is currently unproven.
2. Which levels and routes form the baseline set? Tier 1 uses 11 levels.
3. At which frame is VRAM sampled, given that contents depend on the current
   animation frame and DMA schedule? Tier 3 needs a defined answer, not a
   convention.
4. How are route scripts versioned against ROM changes, given that a route which
   walks off a ledge silently produces a different but still deterministic
   capture?
5. Is Tier 4 worth building once Tiers 1 to 3 are in place?
