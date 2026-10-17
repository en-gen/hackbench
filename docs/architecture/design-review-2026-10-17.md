# Design and architecture review, 2026-10-17

Owner-directed review of the whole repository for duplication, anti-patterns,
and the same problem solved more than once by agents unaware of each other.
Not a bug hunt. Umbrella issue for the mechanical fixes: #1006. Judgment
calls went to the Decisions queue the same day.

## Evidence

- jscpd 5.4 over `src`, `theia/extension/src`, `tools`, `test` (min 60
  tokens, 6 lines): 292 exact clones, 4,326 duplicated lines, 2.0 percent.
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

## Other smells, recorded only

- Largest files: `objectHandlers/standardHandlers.ts` 5,105;
  `map-view-widget.tsx` 1,462; `SpriteDrawEngine.ts` 1,408;
  `map16-view-widget.tsx` 1,140; `map-explorer-widget.tsx` 1,081;
  `SpriteTileLoader.ts` 1,083; `ObjectExpander.test.ts` 3,652.
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
