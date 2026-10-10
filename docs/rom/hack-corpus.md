# Hack corpus (101 SMW Central hacks)

> **Bottom line**
>
> - The store holds 101 SMWC hacks, all patched; counted 2026-10-10 by `ls patches | wc -l` and index.json `patch_result`, and 101 of 101 built ROMs match their index sha256. Entry 27209 (ARMAGEDDON) is typed Tool-Assisted, Pit. `[EST]`
> - Every "of 99" figure below was measured on the 99 hacks patched at the 2026-09-26 survey (#543), before 41112 was added; they were not re-derived on 101. `[EST]`
> - 97 of 99 keep the core tables and routines HackBench reads; the two exceptions are the old hex-edited hacks 5551 and 9678. `[EST]`
> - Palettes are edited in place, never relocated. `[EST]`
> - Detection is required for: a replaced LC_LZ2 decompressor (17 of 99), absent or relocated MAP16AppTable readers (12 of 99). `[EST]`

| Source                                                                     | Identifier                                                                                                | As of                                                                        | Retrieved  |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------- |
| SMWC top-download list, patched onto vanilla copies with npm `rom-patcher` | store `hackbench-tools/hacks` (`patches/<smwc id>/`, `roms/<id>.sfc`, `index.json`, 433 MB at 2026-10-10) | built 2026-09-26 (41112 added later that day, retried after the survey's 99) | 2026-09-26 |
| Survey script                                                              | `scripts/hack-survey.js`, smw-mcp branch `feature/hack-survey`                                            | 2026-09-26                                                                   | 2026-09-26 |
| Results and outliers                                                       | en-gen/hackbench#543                                                                                      | 2026-09-26                                                                   | 2026-09-26 |

## Held on 97 of 99

`DATA_05B96B`, `DATA_05B97D`, the GFX list tables, `$00ABD3`, `Ptrs05EC00`, `CODE_05BB39`, `CODE_00F545`. `[EST]`

## Must be detected

- `$05D8B1` holds the Lunar Magic `JSL` on 99 of 99. `CLAUDE.md` once cited "4 of 6"; that claim is outdated. `[EST]`
- `CODE_0580BD` is intact, but its leading `JSL` target is redirected on most hacks. Verify call targets as well as bytes. `[EST]`
- 31 of 99 (measured on the 99 patched at the time, #589) moved all 63 standard handlers into the `$8D` mirror. That is a bank-mirror artifact; filter it before counting custom handlers. `[EST]`

## Lunar Magic version marker

- `Lunar Magic Version X.XX` sits at SNES `$0FF0A0` on 101 of 105 ROMs (34 versions, 1.61 to 3.63). `[EST]` measured 2026-10-03, #302.
- It does not predict routine hooks (same 105-ROM measurement, 2026-10-03, #302): `$0DA415` (standard object dispatch) is stock on 91, a JML on 12 (11 targets, LM 2.32 to 3.51, including GPW2's `JML $92CCD2`), other bytes on 2. Version 2.53 appears both hooked and stock. `[EST]`
- The hook comes from a separate patch, so read the path bytes, not the marker. `[INF]`
- 8 of 99 hacks hold the SA-1 remap `E2 30 AD 31 79 22 FA 86 00` at that location. `[EST]`
- Hack titles above are public SMW Central names. Ownership of the downloads: the session that built the store; the architecture-review session reads only.

## Growing the store and re-deriving the figures

- `npx tsx tools/scripts/hack-fetch.ts --list | --next [--count N] | --id <smwc id>` fetches the most-downloaded SMWC hacks not yet in the store, applies each patch to the vanilla ROM, and appends a provenance record to `index.json` (the first copy of the day is kept as `index.json.bak-<date>`). It uses only the JSON listing, about 6 s between calls, and stops on an HTML answer. Each download goes in its own new directory, only the one patch file is read from the archive, and nothing is executed. A hack with no single `.bps` or `.ips`, or whose patch fails to apply, is recorded with `patch_result` "failed" and a reason, so it is not retried. `[EST]` 2026-10-10, #543, first run on 9794.
- `npx tsx tools/scripts/hack-survey.ts [--out figures.json]` recomputes the counts above from ROM bytes over the store (and the store plus the six corpus ROMs). It prints counts only. Update the figures here by hand from its output, with the date and corpus size. `[EST]`
- Smoke check, 2026-10-10 (store of 101 before the first new hack, restricted to the 99 hacks of the 2026-09-26 survey): LC_LZ2 replaced 17, MAP16AppTable readers absent or moved 12, all 63 handlers in `$8D` 31, SA-1 remap at `$0DA415` 8, core items held 97 (5551 and 9678 differ; 17478's sprite-pointer lead-in matches zero or several places, so that one item is unchecked), all as printed. Dispatch at `$0DA415` on the 99 is stock 86, JML 11, other 2, and 91, 12, 2 with the six corpus ROMs, matching the #302 figures. One figure does not reproduce: `$05D8B1` holds the `JSL` on 98 of 99, because 9678 does not, against the 99 of 99 above. `[EST]`
