# Headless capture route (Phase 1)

Phase 1 of [docs/ideas/emulator-oracle-testing.md](../../docs/ideas/emulator-oracle-testing.md):
a scripted, headless, deterministic route that reaches a configured Super
Mario World level from power-on with **no human input and no simulated
button-press navigation**, replacing the "Enter a level from the overworld"
step in `l1_dump.lua` / `l2_dump.lua` / `l3_dump.lua` (which stay
interactive-only and are not modified by this work).

Files:

- `headless_capture.lua` -- the route itself. Edit `LEVEL_ID` and
  `SAMPLE_FRAMES` in the `CONFIG` table at the top of the file, or override
  `LEVEL_ID` per run via the `HB_LEVEL_ID` environment variable (accepts hex
  like `0x105` or decimal) without editing the file. `OUTPUT_DIR` there is a
  fallback only; normally set it via `-OutputDir` on the wrapper below, which
  plumbs it through the `HB_CAPTURE_OUT` environment variable.
- `../scripts/run_headless_capture.ps1` -- wrapper that handles the SRAM
  hazard, sets `OUTPUT_DIR` and `HB_LEVEL_ID` (via `-LevelId`), and always
  passes the two required determinism flags.
- `../scripts/run_headless_sweep.ps1` -- runs the route across a fixed set of
  27 levels (one Mesen launch per level, each into its own subdirectory) and
  reports a pass/fail table. This is the project's regression test for the
  verification layer itself -- see "Route-drift guard proof" and "Known
  limitations" below for why a single-level test is not trustworthy here.

## Running it

```powershell
./tools/scripts/run_headless_capture.ps1
```

Or invoke Mesen directly:

```
Mesen.exe --testrunner tools/mesen/headless_capture.lua "test/roms/Super Mario World (USA).vanilla.sfc" ^
  --snes.rampoweronstate=AllZeros --snes.disableframeskipping=true
```

**Both flags are required** -- proven necessary in
[the design doc](../../docs/ideas/emulator-oracle-testing.md#determinism-required-conditions).
The route verifies the first flag took effect and aborts otherwise (exit 10
below); the second has no WRAM-readable proof and is instead verified
functionally, by running the route N times and diffing artifact hashes
(`-Runs N` on the wrapper).

## What it does

Lets SMW's own boot sequence run untouched from power-on until `GameMode`
first reads `$07` (TitleScreen), then force-loads the configured level via
the ROM's own `OverworldOverride` hook ($7E0109) -- no button press is ever
simulated. See the module docstring at the top of `headless_capture.lua` for
the full traced mechanism with `SMWDisX` citations.

### Reachability constraint

The force-load mechanism can only reach level indices whose low byte is
`$01`-`$DB` -- that is, `[$001,$0DB] u [$101,$1DB]`. Low byte `$DC`-`$FF` is
unreachable for the arithmetic reason described in `headless_capture.lua`'s
`REACHABILITY CONSTRAINT` comment. Low byte `$00` (levels `$000` and `$100`)
is *separately* unreachable: `bank_05.asm:7167-7168` is `LDA.W
OverworldOverride / BNE CODE_05D8A2`, so an override of `0` falls through to
the normal overworld-cursor path instead of the forced-load path and is
silently ignored, not "loads level 0". `CONFIG.LEVEL_ID` is validated against
both exclusions at script start and fails immediately with
`EXIT_LEVEL_UNREACHABLE_CONFIG` rather than silently loading the wrong level
or burning a full run first.

## Exit codes

| Code | Name | Meaning |
|---|---|---|
| 0 | OK | All configured sample frames captured for the correct level. |
| 10 | POWERON_STATE_WRONG | Power-on WRAM probe ($7EC100-$7EC10F, documented unused by the entire disassembly) was not all-zero. `--snes.rampoweronstate=AllZeros` was omitted or did not take effect. |
| 11 | LEVEL_UNREACHABLE_CONFIG | `CONFIG.LEVEL_ID` fails the reachability constraint above. Checked before any frame runs. |
| 12 | TITLE_SCREEN_TIMEOUT | `GameMode` never reached `$07` within `CONFIG.TITLE_SCREEN_FRAME_BUDGET` frames. Something is wrong with the boot sequence or the ROM/build. |
| 13 | LEVEL_LOAD_TIMEOUT | The level force-load was triggered but `GameMode` never reached `$14` within `CONFIG.LEVEL_LOAD_FRAME_BUDGET` frames after the trigger. |
| 14 | WRONG_LEVEL_LOADED | `GameMode` reached `$14`, but the live `Layer1DataPtr` does not match the ROM's own `Layer1Ptrs` table entry for `CONFIG.LEVEL_ID`. The route drifted -- some other level loaded instead. Nothing is captured. |
| 15 | SAMPLE_STALL | A configured sample frame was missed by more than 60 frames (or a screenshot/WRAM write failed). Should be unreachable given `disableframeskipping=true` and no injected input; indicates a genuinely stuck emulator or disk write failure. |
| 16 | CGRAM_UNAVAILABLE | No CGRAM `memType` could be resolved from `emu.memType` (tried `snesCgRam`, `snesCgram`, `cgRam`, `cgram`). Checked before any frame runs -- the route aborts rather than producing a capture silently missing `frame_*_cgram.bin`. |

`debug.log` in the output directory mirrors every log line to a plain file.
This is necessary, not cosmetic: `emu.log`'s destination is not visible from
`--testrunner` (no GUI script window, and it does not appear on the process's
stdout) in this Mesen build -- verified this session. Read `debug.log` after
any non-zero exit.

## Verification design (why it's trustworthy)

`headless_capture.lua` verifies level entry with an `emu.addMemoryCallback`
write hook on CPU-space `$0065-$0067` (`Layer1DataPtr`), not by polling
`emu.read` from `emu.addEventCallback(endFrame)`. An earlier version of this
script used the poll+debounce design and silently mis-verified 6 of 27
levels (`$013 $01F $0DB $101 $1DA $1DB`): it reported `EXIT_WRONG_LEVEL_LOADED`
("route drift") on every one of them even though the correct level had
loaded, because its 2-frame debounce was tuned to level `$105`'s timing and
some levels' object parser starts consuming `Layer1DataPtr` in the *same*
frame it is written, leaving zero pristine frames to debounce across. A
write callback has no such requirement -- it fires at the exact CPU write,
not on a frame boundary, so it captures the pristine value regardless of how
soon the parser starts advancing it afterward.

See the `Verification.`, `FIRST COMPLETE WRITE`, and the two `Guarding
against` comments above `onLayer1PtrWrite` in `headless_capture.lua` for: the
precise definition of "first complete write" (the callback's own `value`
argument for each of the pointer's three byte-writes, closed out by the
write to the top of the range -- NOT a follow-up `emu.read`, which a 27-level
sweep proved reads a pre-write value for the byte currently being written);
why the callback needs CPU-space addresses, not `$7E`-prefixed absolute
ones; and how a stale pre-trigger write (the ROM's own title-screen level
load, which uses this identical mechanism at boot) and a write that never
happens are both handled without producing a false pass.

## SRAM handling

Every Mesen run writes `Saves/Super Mario World (USA).vanilla.srm`. The route
never reads save-slot data (it force-loads a level directly, bypassing File
Select), but `run_headless_capture.ps1` still backs up the real `.srm` and
records its SHA-256, removes it before each run (a known state), and
restores + re-verifies the hash in a `finally` block so this happens even if
the route fails or the script is interrupted.

## 27-level sweep

```powershell
./tools/scripts/run_headless_sweep.ps1
```

Runs the route once per level across a fixed 27-level set that deliberately
includes the six levels that false-failed under the old poll+debounce design
(`$013 $01F $0DB $101 $1DA $1DB`), plus a spread of other reachable levels
across both `[$001,$0DB]` and `[$101,$1DB]`. This is the acceptance test for
the verification layer itself, not a single convenient level -- tuning to
one level (`$105`) is exactly what caused the original defect. All 27 must
exit `0`.

## OUTPUT_DIR is cleaned at the start of every run

`headless_capture.lua` recursively removes and recreates `OUTPUT_DIR` before
writing anything to it, including `debug.log`. Without this, a failed run
left a *complete, plausible-looking* artifact set behind from whichever
level last succeeded into that same directory (only `debug.log` used to get
overwritten on every run), and nothing distinguished it from a real capture.
Absence of artifacts is now the only signal for "this run produced no valid
capture" -- do not add a step that repopulates `OUTPUT_DIR` from a cache or
previous run.

## Determinism check

```powershell
./tools/scripts/run_headless_capture.ps1 -Runs 5
```

Archives each run's output directory to `headless_output-runs/run_<n>/` and
prints a per-file SHA-256 table across all runs, plus a verdict line. All
output files, including `debug.log`, are compared -- if even the log's frame
numbers differ across runs, that is itself evidence of nondeterminism.

## Route-drift guard proof

The harness must fail loudly rather than silently capture the wrong level.
This is a hard merge requirement (design doc, "Validating the harness
itself") and is a committed, repeatable test, not a transcript:

```powershell
./tools/scripts/test_headless_capture_mutations.ps1
```

It runs 5 single-launch cases against COPIES of `headless_capture.lua` (the
tracked file is never modified) and asserts the specific exit code each
should produce: wrong level forced -> 14, GameMode transition never written
-> 13, unreachable `LEVEL_ID` -> 11 with zero frames run, missing
`--snes.rampoweronstate` -> 10, and the unmutated route -> 0, proving the
oracle can still pass. Skips with exit 77 if Mesen or the ROM is absent.

## Known limitations / not yet handled

- The reachability constraint above (low byte `$00` and `$DC`-`$FF` cannot
  be forced).
- Determinism across machines, operating systems, and Mesen builds is
  **not** verified by this work -- only repeated cold runs on one machine.
  See "Open questions" in the design doc.
- `disableframeskipping`'s effect has no direct WRAM-readable proof; it is
  verified only functionally (the determinism check above).
- Sample artifacts are screenshot + 8KB WRAM ($7E0000-$7E1FFF) + 512 bytes of
  PPU CGRAM (`frame_NNNN_cgram.bin`, consumed by
  `../scripts/check_cgram.ts` -- see [docs/cgram-oracle.md](../../docs/cgram-oracle.md)).
  VRAM and OAM capture are still not implemented.
- **The captured WRAM state is not equivalent to entering the level from the
  overworld normally -- it is qualified, not a full simulation of a real
  playthrough.** The override path (`CODE_05D8A2` at `bank_05.asm:7216`)
  skips `STA.W TranslevelNo` (`bank_05.asm:7215`), which sits only in the
  non-override branch immediately above `CODE_05D8A2`. That leaves
  `TranslevelNo = 0` for every forced load, regardless of `CONFIG.LEVEL_ID`,
  and several reads of it during the same load see the wrong (always-zero)
  index:
  - `bank_05.asm:7358-7360`: `OverworldEvent <- DATA_05D608[TranslevelNo]`.
    With `TranslevelNo` always `0`, this always resolves to
    `DATA_05D608[0] = $FF` (`bank_05.asm:7017`) -- confirmed empirically:
    every captured WRAM dump in the 27-level sweep shows
    `OverworldEvent=$FF` regardless of level.
  - `bank_05.asm:7361-7366`: `SkipMidwayCastleIntro` is set from
    `OWLevelTileSettings[TranslevelNo]`, so it always reads slot `0`'s
    setting instead of the target level's.
  - `bank_05.asm:7398-7399` (`CMP.B #$52`) and `bank_05.asm:7423-7430`
    (`CMP.B #$31/$32/$34/$35`) both branch on `TranslevelNo`, so any
    level-specific behavior gated on those comparisons will not trigger
    for a forced load the way it would from a real overworld entry.

  None of this affects the verification this script exists to do (whether
  the correct level's `Layer1DataPtr`/tilemap/GFX data loaded), but a
  consumer reading WRAM fields derived from `TranslevelNo` should not treat
  the capture as "identical to normal play, just automated."
