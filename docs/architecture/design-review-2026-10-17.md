# Design and architecture review, 2026-10-17

Owner-directed review of the whole repository for duplication, anti-patterns,
and the same problem solved more than once by agents unaware of each other.
Not a bug hunt. Umbrella issue for the mechanical fixes: #1006. Judgment
calls went to the Decisions queue the same day.

## Evidence

- jscpd 5.4 over `src`, `theia/extension/src`, `tools`, `test` (min 60
  tokens, 6 lines): 292 exact clones, 4,326 duplicated lines, 2.0 percent
  (first measurement, 2026-10-17). Re-measured with jscpd 5.4.0, same
  parameters, on develop 2ec8a060 before the batches (2026-10-18): 294
  clones, 4,344 duplicated lines, 1.93 percent; on develop 9be1dd33 with all
  five merged (2026-10-20): 265 clones, 3,373 duplicated lines, 1.46
  percent, over 971 files and 230,861 lines.
- A reachability script over every relative import in `src`, `theia`,
  `tools` and `test`, seeded from the Theia app and the tools scripts.
- Grep counts of local helper definitions; `git blame` on each.
- A script comparing the two 65816 instruction-length tables entry by entry.

## Duplication fixed under #1006

Each batch is one PR off `develop`, written by a Sonnet implementer and
verified before it opens.

| Batch | What was duplicated | Where it lived |
| --- | --- | --- |
| 1 core helpers | the hex formatter (`src/rom/hex.ts` exists since May; 17 local re-definitions plus 20 inline forms, dated 2026-09-18 to 2026-10-11 across seven teams); little-endian word readers (9 local one-liners); the 4BPP decoder re-implemented in `AnimationLoader`; two identical hillside stampers in `extendedHandlers`; the object-triple decode written twice in `LevelParser` | `src/rom`, `src/project`, `tools/scripts` |
| 2 atomic write | seven temp-then-rename writers with different guarantees (pid in the name, fsync, rename retry); `overview.md` still said `project-server.ts` was exempt from the working-copy gate | `src/project`, `tools/scripts`, docs |
| 3 opcode table | two 65816 instruction-length tables; `PaletteAnimationDetect`'s copy had $61/$62 and $81/$82 swapped, which a walk crossing `ADC (dp,X)` or `STA (dp,X)` would mis-step on; the surviving table was one entry per line, 244 lines for 256 entries | `src/rom/dispatch/HandlerWalk.ts`, `src/rom/PaletteAnimationDetect.ts` |
| 4 Theia helpers | 17 copies of "build a RomFile from the working copy"; six methods in `music-server.ts` repeating the same four-line prologue; the grid toggle button as identical JSX in two widgets; four more local hex helpers | `theia/extension/src` |
| 5 test support | the scroll-simulator capture loader copied into five tests (95 lines each) although `scrollSim_capture.ts` exports it; the music synthetic fixture copied into four tests; three `le16`/`long` builders in `test/suite/support` | `test` |

All five merged as squash commits: batch 3 opcode table #1021 (2026-10-19
02:02Z), 5 test support #1022 (2026-10-19 05:22Z), 2 atomic write #1020
(2026-10-19 16:44Z), 1 core helpers #1129 (2026-10-20 00:54Z), 4 Theia helpers
#1130 (2026-10-20 06:55Z). Each was verified under the shared run lock with the
full unit suite with and without the ROM corpus, plus the two Theia builds and
the grid-toggle Playwright cases for batch 4, before promotion; CodeRabbit
approved each.

## Sent to Decisions

1. **Core only the reference tree reaches.** 106 of 248 core files (15,968
   lines) are imported by nothing under `theia/` or `tools/`: the retired
   `*Appearance` classes and everything that serialises them for the old
   webview, the scroll simulator, `MarioTileDispatch`, `SlopeResolver`,
   `LineGuide`, `BlockBehaviorLoader`, `EditStack`, `LevelEdits`. Thirteen
   commits touched the retired tree after the ruling that retired it.
   Coverage counts it as core. Recommended: move it under `src/reference`.
2. **ROM-to-DTO logic in the shell.** Seven `node/` modules (about 2,700
   lines, six with no Theia import) hold decode and composition that the
   architecture doc says lives in core. Recommended: a shell-free core tree
   the servers import.
3. **Per-call ROM copies.** Every server call copies the working copy into a
   new `RomFile`; `map-screen.ts` grew its own caches to cope. Recommended:
   one read-only `RomFile` per working-copy version from the registry.
4. **Three result conventions** (`ok:`, `status:`, `kind:`) in core.
   Recommended: write the convention down, apply to new code.
5. **Ten widgets hand-wire the same subscriptions.** Recommended: one helper.
6. **Hand-ported layer 1 handlers beside the interpreter** (5,105 plus 1,271
   lines of ports; 584 of interpreter). Recommended: record that ports are
   the oracle and go as the interpreter passes.
7. **The worktree parent is a scratch heap**: 145 registered worktrees, 40
   loose files. Recommended: one proven-merged cleanup pass and a rule.
8. **Core explains itself in VS Code terms**: 39 core files mention the
   webview; `RomFile.buffer` is typed `Buffer` while documented as possibly
   a `Uint8Array`. Recommended: one pass to make the core speak for itself.
9. **Missing scroll-simulator captures**, filed as D140 on 2026-10-18.
   Recommended: follow D100, since the simulator is reachable only from the
   reference tree (checked on develop: `scrollSim.ts` and `src/rom/scroll/*`
   are imported only by four model files used solely by `src/providers` and
   `src/webview`).

The first eight were filed as D100 to D107 and all were ruled by 2026-10-18.
The first (core only the reference tree reaches) was ruled B: delete the VS
Code tree and the core reachable only from it, tracked as #1100.

## Found while verifying the fixes

- Twelve `scrollSim_*.test.ts` files warned and returned when their Mesen
  `l2_scroll.csv` capture was missing, so they passed while checking
  nothing. The captures are under neither `hackbench-tools/fixtures` nor
  `OneDrive/hackbench-fixtures` on the review machine (that folder also has no
  `maps/` directory, which `loadMesenFixture.ts` expects), so every run since
  the fixture move has reported 44 green tests that ran no comparison. The
  twelve now skip under `describe.skipIf` (merged in #1022); where the
  captures went is an open question for the owner (D140, above).
- Four of the twelve scrollSim files had nested their capture
  `describe.skipIf` inside the ROM one. With the corpus absent (CI's case)
  their 27 tests ended `pending`, which vitest's summary tallies as neither
  passed nor skipped (`8520 passed | 1617 skipped (10164)`). Flattened to one
  `skipIf` per suite in #1022 (b35724be); docs/testing.md "Gate with skipIf,
  never by discovery" records the trap (vitest ^5.0.3, synthetic probe,
  2026-10-18).
- The shared atomic writer ignored `fs.writeSync`'s byte count (CodeRabbit,
  #1020). The CodeRabbit CLI found a second fault beside it: the `wx` open sat
  inside the cleanup `try`, so a refused open deleted whatever was at the temp
  path, a sibling writer's live temp included, and a planted directory turned
  EEXIST into EISDIR. Fixed in #1020 (b9abd1c1, 2678e66b) with tests red on
  the old code; a third commit (699ed2c6) makes the zero-byte test fail in
  400 ms instead of hanging vitest if the guard regresses.
- The opcode-table doc claimed its synthetic tests caught a wrong length for
  the eight conditional branches, `$FC`, `$CB` and `$DB`; planting four of
  them turned nothing red. `HandlerWalkInsnLen.synthetic.test.ts` (11
  hardware-length witnesses) and three walk-level rows now do (#1021,
  97fac406).
- `romFileOf` attaches the project's data banks where the ten copies it
  replaced did not, so `mapDetails`, `mapStart`, the map tree, groups and
  `mapPalaceIcons` now read through the project's data-bank config; a vanilla
  project sees no difference (#1130).
- Three tests hit vitest's 5,000 ms timeout under three-slot load and passed
  alone: two git-backed cases in `SpriteReport.test.ts` and `contentGate.test.ts`
  on develop itself (2026-10-18, slot 3). Sent to Planning as an issue
  candidate.
- The staged-style pre-commit hook fails with "The command line is too long"
  when a develop merge stages 263 files on Windows (cmd.exe's limit through
  npx); the checks were run in chunks instead. Sent to Planning.
- A doc comment added in #1129's docstring pass misstates `contentFor`'s null
  contract (an id past the table throws `ShortTable`; it does not return
  null). CodeRabbit approved on the reply before the fix was pushed; the fix
  is parked on local branch fable/1129-doc-followups (185b9bd7) for #1162.
- Two 65816 width-flag polarities (`m16` versus `m8`) were swapped at the
  call site by design in batch 3, and no synthetic test could tell the
  difference until the adversarial review added immediate-mode witnesses in
  both widths. The old code had the same blind spot.
- Three of five Sonnet implementers ran the full unit suite without the
  shared run lock after `acquire` was refused (one because the check sat
  behind a pipe). The lock has a BA-managed reservation queue that an
  ad hoc session is not in, so a session outside the team roster cannot
  verify under the lock without asking Overwatch for a slot.

## Remaining after the batches

Measured on develop 9be1dd33 (2026-10-20), reference tree excluded.

- Hex formatters still local: `src/rom/sprites/interp/LevelLoader.ts:80`
  (`hexAt`), `src/rom/sprites/interp/LineGuided.ts:38`,
  `theia/extension/src/browser/music-explorer-widget.tsx:83` (`hexIndex`),
  `tools/scripts/capture_draw.ts:70` (a wrapper over `hexDigits`). Inline
  `toString(16)` sites: 129 across 56 shipping files (36 more in the
  reference tree).
- Little-endian readers still local: `SpriteDrawEngine.ts:253`,
  `scrollDispatch.ts:72`, `standardHandlers.ts:5032` and `:739`,
  `OverworldEntrances.ts:275`, `L3Loader.ts:191`, `:729`, `:742` and `:647`,
  `OverworldLoader.ts:711` (and four `readUInt16LE` calls at 458 to 491),
  `L3EntranceCamera.ts:94`, `scroll/parallaxCore.ts:359`, `SpcBuilder.ts:50`
  and `:345`, `objectHandlers/cursor.ts:212`, `BonusEntrances.ts:120`,
  `L2Loader.ts:107`, `SmwRom.ts:236`, `:251`, `:273`. Index-form reads:
  `LevelTableGate.ts` (six sites), `GfxDecompressor.ts` (four),
  `ExAnimationLoader.ts` (seven), `LevelScreenTables.ts:49`,
  `OverworldL2.ts:131`, `interp/LevelLoader.ts:160` and `:249`.
- Of the thirteen files the adversarial review listed as still carrying a
  local form, twelve still do; `Aliases.ts` is clean.
- The second object-triple decode in `getObjectStreamLength`
  (`LevelParser.ts:562`) still stands beside `decodeObjectTriple` (`:217`).
- Suggested: one more consolidation pass, same shape as batch 1, sized about
  net zero.

## Other smells, recorded only

- Largest files (develop 9be1dd33, 2026-10-20):
  `objectHandlers/standardHandlers.ts` 5,117; `ObjectExpander.test.ts` 3,652;
  `map-view-widget.tsx` 1,892; `SpriteDrawEngine.ts` 1,408;
  `map-explorer-widget.tsx` 1,147; `map16-view-widget.tsx` 1,131;
  `SpriteTileLoader.ts` 1,084.
- `SpriteTileLoader.ts` keeps frozen per-sprite tables it describes as
  "dead weight until a cart breaks the walk", beside the reader that
  replaced them; the test for the reader carries a third copy of the same
  table as its oracle.
- Test file names mix five suffix styles (`.test`, `.synthetic.test`,
  `.corpus.test`, `.rom.test`, `_<level>.test`); the corpus and synthetic
  suffixes carry meaning, the rest are per-team habit.
- Error-to-message idiom (`err instanceof Error ? err.message : String(err)`)
  written out 17 times; `clamp` written three times. Left alone: too small to
  earn a module.
- `src/rom/model/SmwRomData.ts` is reachable from nothing;
  `SpriteCollision.ts` and `BufferRenderTarget.ts` only from tests.

## What is in good shape

- Lint discipline: five `eslint-disable` lines in the whole shipping tree.
- The core imports nothing from the reference tree or the shell.
- Every node server reads through `WorkingRomRegistry`; the gate test proves
  it.
- Widgets share one lifecycle shape (`init`, `open`, `shows`, `render`) and
  one project bus; the duplication there is wiring, not design.
- Refusals carry reasons; synthetic fixtures exist for the gates.
