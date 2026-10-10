# Hack corpus (146 built SMW Central hacks)

> **Bottom line**
>
> - The store holds 151 index entries: 146 SMWC hacks built, 5 not built (the archive held more than one patch file, so none was applied; see Growing the store). Counted 2026-10-10 from index.json `patch_result` and `ls patches | wc -l` (146). Entry 27209 (ARMAGEDDON) is typed Tool-Assisted, Pit. `[EST]`
> - Figures marked "of 146" or "of 152" were re-derived on 2026-10-10 with `hack-survey.ts` (owner workstation, Windows 11, hackbench commit 04a68dd3 plus this doc change, 146 built store ROMs; 152 adds the 6 corpus ROMs; 5 patches not built). Figures marked "was ... of 99 at 2026-09-26" are the old survey (#543), kept for comparison. `[EST]`
> - 144 of 146 keep the core tables and routines HackBench reads (was 97 of 99 at 2026-09-26); the two exceptions are still the old hex-edited hacks 5551 and 9678, and one hack's sprite-pointer item is unchecked (see Held on). `[EST]`
> - Palettes are edited in place, never relocated. `[EST]`
> - Detection is required for: a replaced LC_LZ2 decompressor (25 of 146, was 17 of 99), absent or relocated MAP16AppTable readers (15 of 146, was 12 of 99). `[EST]`

| Source                                                                     | Identifier                                                                                                | As of                                                                        | Retrieved  |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------- |
| SMWC top-download list, patched onto vanilla copies with npm `rom-patcher` | store `hackbench-tools/hacks` (`patches/<smwc id>/`, `roms/<id>.sfc`, `index.json`, 604 MB at 2026-10-10) | built 2026-09-26 and 2026-10-10 (146 built of 151 entries) | 2026-09-26 |
| Survey script                                                              | `scripts/hack-survey.js`, smw-mcp branch `feature/hack-survey`                                            | 2026-09-26                                                                   | 2026-09-26 |
| Results and outliers                                                       | en-gen/hackbench#543                                                                                      | 2026-09-26                                                                   | 2026-09-26 |

## Held on 144 of 146

`DATA_05B96B`, `DATA_05B97D`, the GFX list tables, `$00ABD3`, `Ptrs05EC00`, `CODE_05BB39`, `CODE_00F545`. Was 97 of 99 at 2026-09-26. The survey leaves one hack's sprite-pointer lead-in matching zero or several places, so that item is unchecked on it (145 of 146 checked on that item). `[EST]`

## Must be detected

- `$05D8B1` holds the Lunar Magic `JSL` on 145 of 146 (149 of 152 with the corpus). Was 98 of 99 at the 2026-09-26 survey: hack 9678 lacks it, and the earlier "99 of 99" in this doc was wrong. `CLAUDE.md` once cited "4 of 6"; that claim is outdated. `[EST]`
- `CODE_0580BD` is intact, but its leading `JSL` target is redirected on most hacks. Verify call targets as well as bytes. `[EST]`
- 39 of 146 (was 31 of 99 at 2026-09-26, #589; 42 of 152 with the corpus) moved all 63 standard handlers into the `$8D` mirror. That is a bank-mirror artifact; filter it before counting custom handlers. `[EST]`

## Lunar Magic version marker

- `Lunar Magic Version X.XX` sits at SNES `$0FF0A0` on 143 of 146 store ROMs, 147 of 152 with the corpus (re-derived 2026-10-10, #543). Was 101 of 105 ROMs (34 versions, 1.61 to 3.63) at 2026-10-03, #302; the version count was not re-derived. `[EST]`
- It does not predict routine hooks (2026-10-10 re-derivation): `$0DA415` (standard object dispatch) is stock on 129, a JML on 15, other bytes on 2 of the 146 store ROMs; with the corpus, 134, 16 and 2 of 152. Was 91, 12 and 2 of 105 at 2026-10-03, #302 (11 JML targets, LM 2.32 to 3.51, including GPW2's `JML $92CCD2`; targets not re-derived). Version 2.53 appears both hooked and stock. `[EST]`
- The hook comes from a separate patch, so read the path bytes, not the marker. `[INF]`
- 10 of 146 hacks (was 8 of 99 at 2026-09-26) hold the SA-1 remap `E2 30 AD 31 79 22 FA 86 00` at that location. `[EST]`
- Hack titles above are public SMW Central names. Ownership of the downloads: the session that built the store; the architecture-review session reads only.

## Growing the store and re-deriving the figures

- `npx tsx tools/scripts/hack-fetch.ts --list | --next [--count N] | --id <smwc id>` fetches the most-downloaded SMWC hacks not yet in the store, applies each patch to the vanilla ROM, and appends a provenance record to `index.json` (the first copy of the day is kept as `index.json.bak-<date>`). It uses only the JSON listing, about 6 s between calls, and stops on an HTML answer. Each download goes in its own new directory, only the one patch file is read from the archive, and nothing is executed. A hack with no single `.bps` or `.ips`, or whose patch fails to apply, is recorded with `patch_result` "failed" and a reason, so it is not retried. `[EST]` 2026-10-10, #543, first run on 9794.
- `npx tsx tools/scripts/hack-survey.ts [--out figures.json]` recomputes the counts above from ROM bytes over the store (and the store plus the six corpus ROMs). It prints counts only. Update the figures here by hand from its output, with the date and corpus size. `[EST]`
- Bulk run, 2026-10-10 (owner workstation, Windows 11, `hack-fetch.ts --next --count 49 --pages 3`, then `hack-survey.ts` at commit 04a68dd3): 49 hacks fetched, 44 built and 5 not built, all 5 because the archive held more than one patch file (6099 Brutal Mario, 9926 Archipelago of Truth Collection, 37601 Mega Mario World 2, 26197 Super Cindy World, 22072 Mario Mania), so none was applied; none failed to apply. The store is now 151 entries, 146 built. The survey figures above are from that run. It re-confirms the 2026-09-26 and #302 figures only as the old-to-new pairs printed above; one old figure did not reproduce (`$05D8B1`, 98 of 99, not 99 of 99). `[EST]`
