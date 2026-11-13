# Design and architecture review, 2026-11-05

Owner-directed second pass over the shipping code for cohesion, duplication,
mistakes and the overall design approach. The first pass
([design-review-2026-10-17.md](design-review-2026-10-17.md)) looked for
duplication only and was "not a bug hunt"; this one hunts bugs too. An earlier
architecture review of 2026-09-24 is tracked in #263.

Nothing was changed. Judgment calls went to the Decisions queue as D181 to
D184 and the bug list went to Planning the same day.

## Evidence

- Reviewed: `develop` at 05d062f7, read from a `git archive` snapshot, because
  the review worktree could not be merged up to develop.
- Scope: the 280 files the app ships. A reachability script over relative
  imports, seeded from `theia/extension/src`, reaches 149 of the 264 files
  under `src/rom` and `src/project` (43,699 lines); the other 131 files are
  `theia/extension/src` itself. 105 core files (15,549 lines) are reached only
  from `src/providers` and `src/webview` and were not reviewed.
- Seven reviewers (Opus), one per area, each read every file in its area in
  full: project layer and servers; map and Map16 frontend; the other frontend
  widgets; core graphics, palette, audio and patch formats; core level and
  overworld readers; object handlers, dispatch and the 65816 interpreter;
  sprite model and sprite interpreter.
- Each reviewer's leading claims were then re-read against the cited lines by
  the review lead. A finding marked "reviewer only" below did not get that
  second read.
- jscpd 5.4.0 over `src`, `theia/extension/src`, `tools` and `test` (min 60
  tokens, 6 lines), the same settings as 2026-10-17.
- Grep counts of local helper definitions and of the three result shapes.
- `gh issue list --search` for each finding, to separate new findings from
  ones already filed.
- Not done: no build, no unit run, no Playwright run, no ROM. Every bug below
  is a reading of the code, not an observed failure. Line numbers are
  develop's at 05d062f7.

## Verdict

The design is sound and the newest code is the most careful. The recurring
fault is that a derived fact has no single owner: the check and the read work
out the same address separately, and each view recomputes what a sibling
already computed. The copies then drift, and each module's tests pin only its
own copy. This is the same verdict #263 reached on 2026-09-24 ("the problems
are in wiring and consistency, not in the shape of the system").

Of the 18 bugs listed, 6 were already filed and are still open, 2 were half
filed, and 10 are new.

## Bugs

### Already filed, still open on develop

| Finding | Where | Issue |
| --- | --- | --- |
| Edit layer files are named by counting the files in `ops/` and read back in plain text order. A missing file makes the next edit overwrite an existing layer. New angle, reachable from one app instance: past 9,999 layers `10000.json` sorts before `1001.json`, the stack replays out of order and the project reads as unreadable. | `src/project/OpsStore.ts:50`, `:161`, `:242` | #225, #658 |
| Layer files and the project manifest are written without flush or retry, redo files straight to their final name. `src/project/atomicWrite.ts` (from #1020) does all three and neither caller uses it. | `OpsStore.ts:163`, `:244-250`; `src/project/Project.ts:378` | #225, #243 |
| The GFX and Audio explorers apply a late reply from the previous project. The Palette explorer has the request token. | `gfx-explorer-widget.tsx:193`; `music-explorer-widget.tsx:219`; guard at `palette-explorer-widget.tsx:211` | #248 |
| The emulator reports every unreadable project as "ROM not located". | `theia/extension/src/node/emulator-server.ts:83-85` | #241 |
| The emulator frame meter keeps every sample and shows a since-start average. | `emulator-frame-meter.ts:38` | #249 |
| A hand edit to `meta/data-banks.json` drops the Layer 1 model cache but not the collision, block-contents or sprite reply caches. | `map-screen.ts:480`; `map-collision.ts:54`; `map-block-contents.ts:288`; `map-sprites.ts:923` | #766 |
| `mapSpriteFrames` re-runs every sprite on the map to answer for one. | `map-sprites.ts:1100` | #1153 |
| `readLevelStart` loops over every screen exit; the exit graph keeps only the last per screen. | `src/rom/LevelStart.ts:214-233`; `src/rom/SmwRom.ts:522-526` | #1207 |
| The shipping frontend imports the reference tree. | `palette-inspector.tsx:22-23` | #261 |
| Map16 repaints its tile strip about three times per update (inline ref callback). | `map16-view-widget.tsx:1105` | #250 |
| Screen exits in Layer 2 (background) object data are not consumed. | `src/rom/LevelParser.ts:405-418` | #905 |

### New

Seen in normal use:

1. **Deleting an emulator save can report failure after the file is gone.**
   `deleteSave` removes the file, then calls `setLabel`, which reads
   `labels.json` strictly. `storeSave` wraps the same call in try/catch.
   `src/project/SaveStore.ts:165-169`.
2. **Audio keeps playing with no Stop control.** A project change calls
   `reset()` and `load()`, neither of which stops playback; with the ROM not
   located the transport renders nothing.
   `music-explorer-widget.tsx:186-193`, `:205-210`, `:731-734`.
3. **Any working-copy edit deselects the map's selected sprite.** `onEdit`
   calls `refresh()`, which reloads sprites, and `loadSprites` ends with
   `selectSprite(undefined)`. `theia-shell.md` lists only empty ground, hide
   and close as clearing it. `map-view-widget.tsx:346-347`, `:559`.
4. **One screen's success hides another screen's failure.** Any reply clears
   `screenError`; the failed screen stays blank with no message and is
   requested again on each scroll. `map-view-widget.tsx:832-836`, `:885-888`.
5. **The palette editor accepts $8000 to $FFFF.** `normalizeBgr555Hex` takes
   any four hex digits; `applyOp` masks with $7FFF, so the layer changes
   nothing but is recorded. `palette-color-format.ts:48-52`;
   `src/rom/PaletteOp.ts:85`. Related: #239.
6. **The New Project dialog reopens with its last entries.** It is bound as a
   singleton and nothing resets its fields (reviewer only; the singleton
   binding at `hackbench-frontend-module.ts:70` was confirmed, a reset was
   searched for and not found).
7. **The sprite step cap is per run, not per sprite.** `TOTAL_STEP_CAP` is
   documented as the "cap for one whole sprite" but is counted in
   `Machine.steps`, and a placed sprite gets several machines.
   `src/rom/sprites/interp/SpriteRunner.ts:80-87`, `:527`.

Only on a modified ROM:

8. **Two rules choose a map's first entrance.** `readLevelStart` sorts by
   hops, parent slot, main before secondary, index. `MapEntrances.route` takes
   the first entry in the exit-graph walk. The Maps view opens on one while
   the Layer 2 (background) and Layer 3 heights read the other.
   `LevelStart.ts:239-240`; `SmwRom.ts:589`; `L3Loader.ts:153`.
9. **Graphics readers ask for a fixed window.** `rom.readAt(addr, 0x2000)`
   returns null when the window passes the end of the file, so a file in the
   last 8 KB, or over 8 KB compressed, is reported as "points outside the
   ROM". `GfxArena.readGfxFileTable` reads the same stream over the whole
   tail. `RomFile.readUpTo` exists for this. `src/rom/GfxLoader.ts:403`; the
   same shape at `AnimationLoader.ts:437`, `:456`, `MarioGraphics.ts:185`,
   `:193`, `ExAnimationLoader.ts:239`; `RomFile.ts:98-115`.
10. **The audio check and the audio build read different routines.**
    `music-server.ts:177` gates on `readMusicCatalog`, which follows the
    routine the ROM calls; `buildSpc` then reads the fixed upload routines,
    two of them with no intact check. `src/rom/SpcBuilder.ts:115-116`,
    `:187-190`. Related: #222, closed #234.
11. **Sibling Layer 1 object ports disagree on a size of 0.** One models the
    256-pass wrap (`standardHandlers.ts:658-667`), others draw two caps
    (`:812`), one tile (`:871`), nothing, or cap at 64. What the game does for
    each was not traced; the disagreement is the finding.
12. **About 15 object ports hard-code stock tile numbers**, although the file
    header says every immediate is read from the handler's own bytes
    (`standardHandlers.ts:50-51`; sample at `:1981-1992`). Reviewer's count.
13. **Three object sub-dispatchers draw nothing, with no note, for an unknown
    target** (`standardHandlers.ts:2513`), where the pipe dispatcher refuses
    in plain words (`:980`).
14. **Four file-offset to address converters, three answers.** At offset
    $3F0000: `null`, `$FE:8000` and `$7E:8000` (twice).
    `src/rom/addressing.ts:78`; `PaletteAnimationDetect.ts:186`;
    `Mode7Gfx.ts:153`; `MusicData.ts:79`.

### Latent

No live path reaches these today.

- `loadOverworldEvents` reads 120 words from two tables that are 112 words
  apart ($04D85D, $04D93D, $04DA1D). `src/rom/OverworldEvents.ts:47`, `:71`.
- `applyBps` computes a length with a 32-bit shift; a crafted header gives a
  negative length. `src/rom/Bps.ts:174`.
- `applyOp` checks only the first byte's offset, so a word at the last byte of
  the ROM is half written. `src/rom/PaletteOp.ts:81-87`.
- `buildLevelCgram` writes into the palette rows it was handed (reviewer
  only). `src/rom/PaletteLoader.ts:395-464`.
- The map view's screen cache is cleared only by a refresh; about 2.6 MB per
  cached screen by arithmetic, not measured (reviewer only).

### Checked and found clean

The reviewer compared all 256 rows of the instruction-length table with the
interpreter's decoding under both register widths and found no difference,
and found no fault in the interpreter's flags, wrap, stack or call handling
(reviewer only; `src/rom/dispatch/HandlerWalk.ts:65-82`,
`src/rom/cpu/Cpu65816.ts`).

## Cohesion

- **Layering, no gate.** Besides #261: `hackbench-contribution.ts:37` and
  `new-project-dialog.ts:21` import `PROJECT_EXT` from `src/project/Project.ts`,
  which loads `fs`, `crypto` and `path`. `expanderBrowserSafe.test.ts` guards
  the reference bundle against `crypto` only; nothing guards the frontend.
- **Decode logic in the shell is growing.** The seven `node/` decode modules
  D101 ruled into core were about 2,700 lines on 2026-10-17 and are 3,426.
  `map-sprites.ts` (1,106 lines) holds camera choice, offset fixing and the
  per-sprite-id dispatch.
- **"Entrance" has four shapes** (`Entrance`, `MapEntrances`,
  `OverworldEntrance`, `number | null`), and "level" names slots in `SmwRom`,
  `L2Loader`, `L3Loader` and `ObjectExpander` against the glossary. New bug 8
  follows from the first.
- **Two sprite part models.** The table engine marked for retirement
  (`map-sprites.ts:25-26`) still defines the part type the app draws.
- **Four reply caches** in `node/` with different keys, limits and lifetimes.
- **Undo is decided in two modules**, and the explorers are wired two ways
  (Maps by the contribution, the rest by themselves).
- **`map-view-widget.tsx`** (1,762 lines) has four separable jobs: collision
  state, sprite hover and selection, the screen cache, start placement.
- **Object handlers refuse in five ways**, one of them silent.
- **Result shapes.** In the 149 shipping core files, a bare `ok:` appears in
  40, `status:` in 8 and `kind:` in 32. D103 ruled `status`.

## Duplication

| jscpd 5.4.0, same settings | 2026-11-05 | 2026-10-20 |
| --- | --- | --- |
| Exact clones | 279 | 265 |
| Duplicated lines | 3,567 (1.47 percent) | 3,373 (1.46 percent) |
| Files, lines scanned | 1,046, 243,473 | 971, 230,861 |

By tree on 2026-11-05: tests 204 clones (2,545 lines), reference tree 39
(554), tools 12 (178), shipping code 14 (140).

Exact copies in shipping code are close to nil. The duplication that matters
is the same rule written more than once with different behavior:

| Rule | Copies | Do they differ? |
| --- | --- | --- |
| First entrance of a map | `LevelStart.ts:239`; `SmwRom.ts:589` | yes (new bug 8) |
| Screen-exit resolution | `SmwRom.ts:502-598`; `LevelStart.ts:214-234` | yes (#1207) |
| Graphics stream extent | `GfxLoader.ts:403`; `GfxArena.ts:418` | yes (new bug 9) |
| Player graphics unpack | `AnimationLoader.ts:416-476`; `MarioGraphics.ts:148-203` | yes (gate, buffer contents) |
| Layer 3 start height | `L3Loader.ts:329-469`; `L3Loader.ts:347-354` | yes, for some settings |
| OAM entry decode | `SpriteRunner.ts:609-638`; `CastleFlames.ts:119-146` | yes (hidden tiles) |
| 16x16 tile expansion | `SpriteDrawEngine.ts:806-820`; `map-sprites.ts:361` | yes (wrap) |
| Spawner child loop | `FiveEeries.ts:181-210`; `SpawnedChildren.ts:53-87` | yes |
| File offset to address | four sites (new bug 14) | yes |
| Per-bytes reply cache | `map-sprites.ts:932`; `map-block-contents.ts:297`; `map-collision.ts:113` | yes (LRU, FIFO, none) |
| Explorer load | Palette, GFX, Audio | yes (#248) |
| Temp-then-rename write | `atomicWrite.ts`; `OpsStore.ts:236-256` | yes (#225) |

Small helpers still copied: inline `toString(16)` at 75 sites in 41 shipping
files; relative-branch target three times; base64 of a typed array five
times; `isPlainObject` three times; `(err as Error).message` at about 25
sites, which shows "undefined" for a thrown non-Error.

## Overall design approach

What works:

- Edits are ordered layers over a read-only base, and every server reads the
  working copy through one registry.
- ROM reads are gated on the code that reaches them and refuse with a reason.
- The core runs without the shell, so it is testable without an application.
- Sprites and objects are moving from hand ports to running the game's own
  code, and the interpreter that makes that possible is the cleanest code in
  the tree.

What does not:

- **No single owner per derived fact.** Each area has pairs of readers for the
  same fact. A fix lands in one, and no test compares the two.
- **Persistence is the least careful part**, and it holds the user's work.
- **Cross-cutting frontend concerns are solved per widget** (stale replies,
  project switches, error text), so one sibling has the fix and the others do
  not.
- **The hand ports are the oracle the interpreter must match**, so their
  silent stock-tile assumptions will read as interpreter failures.

## Follow-through on earlier reviews

- 2026-09-24 (#263): of the issues this pass ran into again, #225, #241,
  #243, #247, #248, #249, #250, #252 and #261 are open. They sit in milestones
  0.3, 0.4, 1.0 and Infrastructure, behind 0.1.
- 2026-10-17: the eight rulings D100 to D107 were filed as #1100 and #1102 to
  #1108. All are open. `src/providers` and `src/webview` are still in the
  tree, `romFileOf` still copies the working bytes per call, and no shared
  subscription helper exists. `docs/CONVENTIONS.md` exists.
- Two of those would remove a class of bug found here: #1102 (one computed ROM
  state per layer version) is the natural home for the reply caches (#766),
  and #1105 (one subscription helper) for the stale-reply and project-switch
  guards (#248, new bug 2).

## Sent to Decisions

1. D181: a reused preview map tab keeps the previous map's palace and switch
   presses and its layer and collision toggles. Reset, keep, or split?
2. D182: the emulator keeps running and playing sound when its panel is
   hidden. Pause, or leave?
3. D183: faults in code already marked for retirement (the Layer 1 hand
   ports, the sprite table engine). Fix, record, or leave?
4. D184: adopt "one owner per derived fact" as a written convention with a
   consolidation umbrella, as #1006 was for helpers?

## Sent to Planning

- The 14 new bugs and 5 latent items as issue candidates.
- New angles for existing issues: the 9,999-layer ordering fault (#225, #658),
  `atomicWrite.ts` now existing (#225, #243), the `Project.ts` import (#261).
- A gate candidate: no runtime import from `theia/extension/src/browser` may
  reach `src/providers`, `src/webview` or a core module that imports a Node
  builtin, with a planted-defect test.
- A priority note, Planning's and Overwatch's call: #225 and #243 are in 0.4
  while palette, Map16 and graphics edits already write layers.

## Not checked

- Whether any finding reproduces in a running build.
- The 105 reference-only core files, `tools/` and `test/`, beyond the clone
  count.
- Game behavior behind new bugs 8, 10 and 11: the code's copies disagree; which
  copy matches the game was not traced in SMWDisX.
