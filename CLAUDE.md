# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**HackBench** - a Super Mario World (SNES) ROM editor, built as an Eclipse Theia and Electron desktop application. Command and view IDs use the `hackbench.*` namespace.

It is NOT a VS Code extension. It began as one, and that code is still in the tree under `src/providers/` and `src/webview/`, but the project changed course: the extension is not a shipping target, is not published, and receives no new features. It is kept as a reference implementation for reading SMW data, and it still builds. Do not add features there.

Work is non-destructive and project-based. A `.hbproj` project references a ROM by identity and never copies it; every edit is an ordered patch layer under `ops/`; `Export Patch` diffs the working copy into a real `.ips`. See [docs/architecture/project-format.md](docs/architecture/project-format.md).

## Branch strategy

- `main` - reserved for releases. It does not exist in this repo yet; it is
  created when the first release is cut from `develop`. Never PR to it.
- `develop` - default branch and integration base; all PRs target here
- `feature/*` - branch off `develop`, one concern per branch
- After merging a PR: `git checkout develop && git pull origin develop && git checkout -b feature/<next>`

The repo went public on 2026-09-27 with rewritten history. The old repo is
the private `en-gen/hackbench-archive`; issue and PR numbers from before then
are archive numbers (`C:/Projects/hackbench-tools/issue-map.tsv` maps issues).

## Merging

A PR merges itself: `develop` requires green CI plus one approving review
from anyone with write access. In practice that is CodeRabbit, which approves
once its comments are resolved (`.coderabbit.yaml`); GitHub cannot require
the approval to be CodeRabbit's, so a human approval merges it too.

- Once the verifier has passed, when one is required (re-run rule below), turn
  on auto-merge: `gh pr merge <n> -R en-gen/hackbench --auto --squash`, then
  confirm it took (`gh pr view <n> --json autoMergeRequest`); the command has
  failed silently.
- A significant UI change or a feature addition gets the `needs-owner` label
  instead, and auto-merge stays off. Bugfixes and minor tweaks, rendering
  fixes included, auto-merge. Unclear significance defaults to `needs-owner`.
  The plan-summary gate names which applies, so the owner can override it.
  CI cannot run Playwright (no ROM), so for an auto-merged rendering fix the
  verifier's local Playwright run is the only UI check.
- The orchestrator opens the PR and owns it until it merges, but a
  sub-agent answers the reviews: the implementer if still available, else a
  fresh implementer given the brief and the PR. Answer every CodeRabbit
  review, including a "changes requested" one, without being asked: fix a
  valid finding, or reply with the reason when it is wrong, then resolve the
  thread. An unresolved thread withholds approval. The `develop` ruleset
  dismisses stale approvals on push, so a merged commit carries a review of
  its final state; that holds only while the ruleset keeps that setting.
- Any push after the verifier's report, CodeRabbit fixes included, re-runs
  the verifier; a fix that changes logic or removes a check goes to the
  adversarial reviewer first. Before pushing a fix to a PR, disable
  auto-merge (`gh pr merge <n> -R en-gen/hackbench --disable-auto`) so it
  cannot race the re-run; re-enable it only after the verifier passes on the
  new head.
- CodeRabbit re-reviews each push by itself. Do not comment
  `@coderabbitai review` or `full review` (the free open-source plan has an
  hourly review limit) and never `@coderabbitai approve`.
- A CI re-run reuses the PR's original merge commit. When the fix is on
  `develop`, merge `develop` into the branch (never rebase or force-push)
  instead of re-running.
- Repo admins can bypass the approval; agents never do.

Do not add `Co-Authored-By: Claude` lines to commits. Do not add "Generated with Claude Code" footers or any AI attribution to PR bodies or commit messages.

## Issues

Every issue gets a GitHub issue type: `Bug`, `Feature` or `Task`. The
templates set it; `gh` does not, so pass it: `gh issue create --type Bug`.
Use the type, not a `bug` or `enhancement` label.

Work is tracked on the [HackBench board](https://github.com/orgs/en-gen/projects/1).
Its Status is the claim: Backlog, Ready, In progress, In review, Done.
Before starting an issue, check it is not In progress, then move it there;
move it to In review when the branch is pushed. File new issues with
`--project HackBench`. Touch only `en-gen` repos and projects.

## Pull requests show what they draw

A PR that changes UI or graphics rendering embeds images of the result
inline in its description. A fix or improvement shows before and after:
same view, same map, same data.

Rendered SMW graphics are ROM-derived, so they never enter this repo's
history. They go to the private `en-gen/hackbench-pr-assets` repo, and
`gh` cannot attach files the way the web editor does, so upload with:

```bash
tools/scripts/pr-image.sh <branch-name> shot.png map.before.png map.after.png
```

It prints the markdown to paste into the PR body or a comment
(`gh pr create --body-file`, `gh pr comment --body-file`). Files named
`<x>.before.png` and `<x>.after.png` print as one side-by-side row. Capture
images with launched processes hidden; the verifier captures them
(implementers do not) and hands the files to the orchestrator, who attaches
them.

## Commands

From the repo root:

```bash
npm run lint           # ESLint src, test, tools, theia, root config; --max-warnings 0
npm run lint:fix       # auto-fix
npm run format         # Prettier over JS/TS/CSS
npm run format:check   # Prettier check mode, as CI runs it
npm run test:unit      # Vitest unit tests (single run)
npm run test:unit:watch
npm run typecheck:theia
npm run gitnexus       # refresh the index; never a bare `gitnexus analyze`
```

The desktop app, from `theia/`. `build` and `start` target Electron, which
is the shipping form; `build:browser` and `start:browser` are what the
Playwright suite drives.

```bash
yarn --cwd theia install
yarn --cwd theia build
yarn --cwd theia start
```

The reference VS Code extension still builds with `npm run compile`
(webpack dev build; `watch` rebuilds on save, `package` is the production
build). **F5** in VS Code launches it in an Extension Development Host.
Neither is how HackBench ships.

To run a single test file: `npx vitest run test/suite/unit/GraphicsDecoder.test.ts`

## Architecture

Domain terms (slot, map, level, entry map, sub area, launch tile, submap) are
defined in [docs/glossary.md](docs/glossary.md). They are not interchangeable;
using them loosely is how this project produced five different level counts.

Three trees. Full picture in
[docs/architecture/overview.md](docs/architecture/overview.md).

```
src/rom/        the core: ROM parsing, decoding, decompression
src/project/    the core: projects, patch layers, working copy, export
theia/          the application: widgets, commands, RPC servers
src/providers/  the original VS Code extension, REFERENCE ONLY
src/webview/    its webview bundles, REFERENCE ONLY
```

### The core (`src/rom/`, `src/project/`)

All modules are plain TypeScript with **no shell imports**: no Theia, no VS
Code. That is what makes them testable without starting an application, and
it is why the Theia backend may import the core directly while its frontend
may not import anything that touches a file.

| File                 | Purpose                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `addressing.ts`      | LoROM SNES address ↔ file offset conversion                                  |
| `RomFile.ts`         | Binary ROM wrapper; all reads go through SNES-addressed helpers              |
| `SmwRom.ts`          | SMW pointer tables, level list, header parsing                               |
| `LcLz2.ts`           | LC_LZ2 decompressor (used for all GFX files)                                 |
| `GfxLoader.ts`       | GFX file loading: pointer tables → decompress → decode tiles into VRAM slots |
| `GraphicsDecoder.ts` | 2BPP/3BPP/4BPP tile decoders; BGR555 → RGBA conversion                       |
| `PaletteLoader.ts`   | ROM palette groups → CGRAM rows                                              |
| `LevelParser.ts`     | Layer-1 object + sprite stream parser; level header                          |
| `ObjectExpander.ts`  | Level object → 2D Map16 tile grid                                            |

| File (`src/project/`)               | Purpose                                                     |
| ----------------------------------- | ----------------------------------------------------------- |
| `Project.ts`                        | `.hbproj` manifest, ROM identity, directory layout          |
| `WorkingRom.ts`                     | the store: base bytes with every layer applied, in order    |
| `OpsStore.ts`                       | persists layers under `ops/`, undone ones under `ops/redo/` |
| `ExportPatch.ts`                    | diffs the working copy into a real `.ips`                   |
| `RomRegistry.ts`, `CoreRegistry.ts` | per-machine paths to the ROM and the libretro core          |

A view that shows ROM content must read the WORKING COPY, never the base
bytes, or an edit in one view is invisible in another. Palette, GFX and
Map16 comply; the Maps view does not yet, and
`test/suite/gates/workingCopyGate.test.ts` exempts `project-server.ts` by
name. It is a rule with one known exception, not a description.

### The Theia shell (`theia/`)

`extension/package.json` declares six frontend and backend pairs: hackbench
(shell, projects), palette, music (audio: BGM and SFX), gfx, map16,
emulator. `common/` holds the service
interface and `SERVICE_PATH` for each, so a protocol change breaks the compile
rather than the runtime. `node/` is the only side allowed to touch the ROM.
`browser/` never reads a file; it asks over JSON-RPC.

Details, including the two distinct change-notification paths, in
[docs/architecture/theia-shell.md](docs/architecture/theia-shell.md).

An on-screen zoom control uses `ZoomController` + `ZoomStepper`
(`theia/extension/src/browser/`), anchored on the cursor. Ctrl + wheel is
cancelled shell-wide, so `build:browser` never page-zooms and editors don't
scroll on it (#651).

### Reference only: the VS Code extension

`src/providers/`, `src/webview/`, `src/extension.ts` and its `src/`-root
helpers are the original VS Code extension, kept for the ROM interpretation
they hold. Not a shipping target; no new features. Its virtual filesystem,
providers and webview protocol are documented in
[src/providers/CLAUDE.md](src/providers/CLAUDE.md), loaded only when you
work in that tree.

## The ROM is a collection of lookup tables

Read the tables. Do not model the behaviour.

SMW stores what it needs in tables, and a romhack still has to run on a stock
SNES, so those tables stay where the hardware expects them. Almost every
question this project asks ("which levels exist", "what does this exit lead
to", "what is this level called") is answered by finding the right table and
the right index into it. We are not building an emulator. Where a table is
enough, reading the table IS the answer; reach for code only when the table
alone cannot tell you whether it is still the one the ROM uses.

**The table is never the hard part. The index is.** Reading 512 three-byte
entries is trivial. The work is knowing what indexes them. The exit-graph bug
took a day and the answer was that `DATA_05F800` is indexed
`(submapFlag << 8) | rawByte`, with the high byte coming from `OWPlayerSubmap`
and NOT from the translevel: two independent gates in one routine
(`bank_05.asm:7217-7226`). Trace the ASM to learn the index, then read the
table. Do not port the routine.

**If you are describing behaviour, you have lost the thread.** Every defect
this project has shipped came from modelling instead of reading:

| Defect                 | What it did                                                                      | What it should have done                  |
| ---------------------- | -------------------------------------------------------------------------------- | ----------------------------------------- |
| `screenHasExitTrigger` | invented Map16 tile scanning, cited an address with zero hits in the disassembly | read `DATA_05F800`                        |
| `levelHasObjects()`    | invented a "modes 0-20 valid" rule with a fabricated line citation               | compare the L1 pointer against the filler |
| exit-graph high byte   | derived it from `ExitTableHigh` bit 3, which the game never reads for this       | take it from the submap flag              |

Both fabricated citations are tracked in issue #311. Neither was caught by
tests; both were caught by someone re-reading the disassembly.

**The one case where table-reading is not enough.** Lunar Magic replaces
routines, not just data. `$05D8B1` holds the `BEQ` opcode `$F0` in a stock ROM
(`bank_05.asm:7224`); in this repo's 6-ROM corpus the 2 stock ROMs hold `$F0`
and the 4 edited ones hold `$22` (a JSL), which is an empirical observation of
ROM bytes, not an ASM claim. On such a ROM the stock table may be bypassed
entirely in favour of a precomputed one. So: read the table, but check that
the routine which reads it still exists. When it does not, fail closed and say
the tier is unavailable. Emitting vanilla-shaped output for a patched ROM is
the worst outcome available, because it is confidently wrong and looks right.

**Relocation is rarer than override. Measure before assuming either.** Palettes
were measured across the 6-ROM corpus: all eight stock tables sit at their
vanilla addresses on 6 of 6, and the variant-offset table at `$00ABD3` plus the
two `LDA #imm` sites feeding CGRAM column 1 are byte-identical on 6 of 6. The
data does not move. What changes is the CONTENT in place - GPW2 edits 4 of the
8 tables, Invictus 2 - and, separately, Lunar Magic writes per-level override
blocks through `$0EF600`: 157 levels on GPW2, 161 on Invictus, 53 on GPW 1.2,
0 on the three unedited ROMs. So for palettes a fixed address is safe and
reading the override table is mandatory, which is the opposite shape to music,
where AddmusicK moves the data and deletes the call. Do not generalise one
subsystem's answer to another; both cost one probe to check.

**Existing is not the same as reached.** A patch that leaves a routine
byte-identical and diverts control before it passes every existence check.
Poking `$00A418` to `RTS`, or the NMI vector at `$00FFEA` to anywhere, leaves
`$00A41A..$00A435` pristine while the ROM animates nothing; a detector
anchored only on the callee reports vanilla with full confidence. Hijacking an
entry point is the commonest patch shape there is, so verify the PATH as well
as the destination: the vector, the branch displacement, the call site. Those
are a handful of readable bytes.

**The recipe, when a value lives in code rather than a table.** Six separate
features got this wrong before review caught them, so it is written out:

1. Read the operand where it sits. `LDA #imm`, `LDA abs,Y`, an `AND` mask, a
   run of `LSR`, a branch displacement. These are readable bytes and reading
   them is interpretation, not assumption.
2. Gate on the opcode first. Confirm the instruction is still the one you
   think you are reading, at the offset you think it is. A fixed offset into a
   replaced routine lands mid-instruction and yields a plausible wrong answer:
   `$008148` reads `$20`, the operand of a `SEP`, and the derived music bank
   address comes out `$0EAE60` against a true `$0EAED6`.
3. Prefer a byte PATTERN over a fixed address, so a relocated but intact
   routine is still found. More than one match means you cannot say which one
   runs, which is unavailable, not a guess.
4. Never fall back to the vanilla value. Report unavailable with a reason.
   Keeping the stock constants as a documented cross-check is fine; reading
   one as a default is the defect.
5. Validate the result independently where you can. A derived bank address
   whose header holds a sane `blockSize` and whose pointer table terminates is
   evidence; one that lands on filler is not.

**Scope each issue to vanilla plus refusal.** A fix is done when it is correct
on vanilla and refuses a hack it does not recognize, with a reason. Recognizing
a particular hack's code (a Lunar Magic hook, a relocated routine) is its own
issue, ranked by how often the SMW Central sweep (#543) meets it. Adding hack
support inside a correctness fix is what roughly doubled #488-#490.

**Viewers draw; they do not blank.** Where a view cannot verify what it draws,
it draws the best data it has, marks it unverified and says why. That is not a
vanilla fallback: the data still comes from this ROM, and the view says it is
unverified instead of presenting it as fact.

## Knowledge Integration (External Disassembly)

Domain library: `C:\Projects\SMWDisX`. SMW ROM constants, handler ports, and ASM-behavior questions are authoritative there - not in this file. This section is the router; `SMWDisX` is the store.

**Global SNES rulebook** (addressing, BGR555, VRAM layout): `@C:\Projects\SMWDisX\.claude\rules\snes-global.md` - load this whenever any `src/rom/` task touches color math, LoROM offsets, or VRAM slot assignments.

**Pillar 1 - Scoped Rules (`src/rom/`)**: Any work touching `src/rom/` requires cross-referencing the matching bank folder in `SMWDisX`. Do not port or assert ROM behavior without tracing to an ASM line there first.

**Pillar 1a - ASM is REFERENCE, not a source to hardcode from**: Use the
disassembly to trace which lookups happen, in what order, and how graphics are
composed and presented. Do NOT derive logic from the ROM and then hardcode it.
This tool targets romhacks, and the ROM's code can be manipulated in ways that
invalidate any such derivation. A hardcoded derivation does not merely go
stale: it renders confidently wrong on the user's own ROM with every test
still green.

In practice:

- Sprite identity comes from the MAP's sprite stream. Everything about that
  sprite is then looked up from ROM tables: one hardcoded address per SHARED
  table, indexed by the id. `SprTilemapOffset[id]`, `Sprite166EVals[id]`, the
  handler pointer at `$01:85CC + id*2`. Values always read from the ROM.
- Where a value lives inside one sprite's own handler rather than a shared
  table, anchor it as an OFFSET FROM THE ROM-RESOLVED HANDLER POINTER, not as
  an absolute address, so a relocated handler still resolves.
- **If HackBench can interpret the ROM directly to produce graphics or
  animation, it MUST. It must go no further.** Opcodes are readable bytes, so
  reading them is interpretation, not assumption. Do not stop at data tables
  and hardcode the rest.
- Worked examples, all verified readable on the vanilla ROM. A shift count is
  the number of consecutive `$4A` (`LSR A`) bytes at an address: `$01:BE96`
  reads 6 and the OR-bit slice reads 3, which a descriptor should COUNT rather
  than hardcode. A displacement can be the opcode itself: `$FE` at `$01:BEC3`
  is `INC abs,X` on `$0301`, so the 1 px top-tile nudge is +1 on
  `OAMTileYPos+$100`, and a hack that changed it to `$DE` would correctly read
  as -1. Comparison thresholds are plain immediates.
- The line is at ASSUMPTION, not at opcodes. **We are not building an
  emulator, but content we load for editing must be INTERPRETED, not assumed
  from the ROM.** Running the ROM to see what happens is out of scope.
  Reading bytes - including opcodes - to determine what the ROM does with
  the content we are about to show the user is in scope and required.
- Static control-flow reading is on the required side of that line. Walking
  instructions from a known entry to find which write is REACHED is reading,
  because it evaluates no condition and holds no machine state; it follows
  determinate transfers and refuses everything else. The palette-animation
  detector does this to resolve a relocated routine, and it exists because
  the byte scan it replaced reported a ROM as animating a slot the hack had
  disabled. A walk that refuses conditional branches fails closed; a scan
  that takes the first plausible match fails confident.
- One bounded exception, for L1 object handlers only (#351):
  `src/rom/objectHandlers/interpret.ts` evaluates a handler's bytes over a
  fixed opcode set, a named memory surface and step/write budgets, and
  refuses anything else with a reason. Do not extend it to other subsystems
  without a decision of the same kind.
- A derivation that truly cannot be read must be NAMED as a hack-fragility
  point and paired with honest degradation: compare the handler against its
  vanilla bytes and DECLINE TO ASSERT when it diverges, rather than rendering
  vanilla with confidence. Reach for this only after establishing the value is
  genuinely unreadable, which is rarer than it first appears.

**Pillar 2 - Context Budgeting**: Load domain knowledge on demand using `@C:\Projects\SMWDisX\<bank_xx>\MEMO.md` syntax. Never read entire bank folders speculatively; load only the MEMO.md for the bank(s) directly relevant to the current task.

**Pillar 2a - Ask smw-mcp before spelunking**: ROM and disassembly questions (level entrances, pointer tables, sprite lists, which levels use a tile, what a routine does, whether a citation is right) go through the `smw-mcp` server's tools first. `smw-mcp` is ours to change as the work needs.

- **Codify repeats.** Log every question answered by hand in `smw-mcp/docs/query-log.md`. That includes ad-hoc ROM scripts, repeated table reads, raw `sed`/`grep`/`Read` of `.asm` line ranges, and hand-checked `file:line` citations. Past 3 of a kind, add it to `smw-mcp` as a tool, with tests and SMWDisX citations, then use the tool.
- **Tune what does not help.** Log a result that was not useful in the same file's Effectiveness section, then fix the tool: output far larger than the question needed, a missing field that forced a follow-up, a wrong answer, an error. Falling back to raw reads because a tool is broken counts; fix the tool.

**Pillar 3 - Memory Snapshot Protocol**: SMWDisX is our fork (`en-gen/SMWDisX`) and our tool. Whenever a detail of the disassembly is learned or confirmed, record it in `SMWDisX/<bank_xx>/MEMO.md` for the bank where the routine lives. This covers a multi-routine trace, a single table's meaning, one flag bit, or which index a lookup uses. Delegated research counts: a sub-agent confirms the citations, then writes the memo from the findings.

- **Content:** the address range, the behavior decoded, the non-obvious invariants, and the issue or PR that exercised it.
- **Wrong memos:** correct them in place, and say what was corrected and why.
- **Publishing:** write, commit and push; no proposal step. Stage only the memo files you changed.
- **Never edit the disassembly code.** Its instructions, labels, data and addresses are reference SMW. Annotations, comments, memos and docs that help development are welcome.

## Files never to commit

`*.smc`, `*.sfc`, `*.rom`, `*.ips`, `*.bps` are gitignored.

The ROM corpus and the emulator tooling are no longer in the repo at all.
`test/roms/`, `test/magic/` and the binary half of `tools/mesen/` moved to
`<projects>/hackbench-tools/{roms,magic,mesen,fixtures,dispel,spcplay}/`.
Gitignoring stops a commit; it does not stop `git clean -x`, which deletes
ignored files, and these are cartridges and captures that cannot be
downloaded again. Outside the repo, git cannot reach them.

The interactive dump scripts `tools/mesen/l1_dump.lua`, `l2_dump.lua`,
`l3_dump.lua` and `tools/mesen/README.md` stay tracked here. The headless
per-layer capture harness (`headless_capture.lua`, its PowerShell wrappers,
the sweep and the mutation test) lives in `en-gen/hackbench-validation`
under `capture/`, not here.

Nothing hardcodes the new location. Tests ask `test/suite/support/corpus.ts`
(`romPath`, `hasRom`, `freshRom`, `CORPUS`, `VANILLA`), which reads
`HACKBENCH_ROMS`, then walks up for `hackbench-tools/roms`, then falls back
to the legacy `test/roms`. See [docs/testing.md](docs/testing.md).

# Quality gates

These exist because each one corresponds to a defect that actually reached review in this repo. They are not generic best practice.

## Enforced mechanically

`npm install` sets `core.hooksPath` to `.githooks` automatically
(`tools/scripts/set-hooks-path.cjs`, run via the `prepare` script); nothing
to do per clone. Two gates run on pre-commit, pre-push and in CI.

`tools/scripts/check-staged-style.sh` runs ESLint at `--max-warnings 0` and
Prettier in check mode over the staged JS/TS/CSS. Warnings are fatal: the
gate previously exited 0 while reporting 14 of them, and `src/` was the only
tree it looked at. `test/suite/gates/lintGate.test.ts` plants a defect per
rule and proves both halves go red, and asserts the package.json scripts
still carry the flags that make them able to fail.

`tools/scripts/check-content.mjs` (issue #678) blocks ROM-derived bytes
(the copyright rule in `docs/testing.md`, previously guarded only by
`.gitignore`, which `git add -f` silently defeats) and em-dashes in newly
added lines, in `staged`/`range`/`push`/`history` modes. Override with
`git commit --no-verify` only with a stated reason in the PR; `.githooks/
pre-push` still catches a `--no-verify`'d commit unless the push itself
also skips hooks.

## Claim discipline

State the evidence scope with every claim, in comments, docs and commit messages. Not "deterministic" but "byte-identical across 6 cold runs, one machine, Mesen 2.x". Two separate claims in this repo were asserted far past their evidence and nearly shipped: "memory callbacks do not fire under `--testrunner`" (false: only `$7E`-prefixed absolute addresses fail) and a determinism result generalised from three title-screen frames.

Cite ROM behaviour to `SMWDisX file:line`. Trace it; do not copy the assembly into our source. Copies rot when the disassembly is regenerated.

## Oracles must be proven able to fail

Any check, harness or test that reports a verdict needs a committed test proving it goes red on a planted defect. Verdicts that cannot fail are worse than no verdict. Real examples from this repo: a determinism check that printed "all artifacts byte-identical across 5 runs" having compared zero files, and a wrapper that exited 0 on run codes `14,14,14,14,0`.

Never accept a single-case acceptance test. A debounce tuned to level `$105` false-failed 22% of levels with a factually wrong diagnosis. Sweep the range.

**CI has no ROM, so every safeguard needs a test that runs without one.**
The corpus cannot be committed and lives outside the repo, so CI is
permanently the corpus-absent case. A safeguard proven only by corpus tests is unproven where
it actually runs. Measured on the music branch: with the corpus removed,
deleting the opcode gate outright, shifting an operand offset by one, and
falling back to the vanilla address when the gate fails all passed 5 of 5
green. That last one is the defect the gate exists to prevent.

Two rules follow, and the second is the subtle one:

- Every gate, refusal or bounds check gets at least one SYNTHETIC fixture
  exercising it. Build the bytes in the test; do not reach for a ROM.
- Gate with `describe.skipIf`, never by generating cases from a corpus
  listing. `for (const file of romFiles)` over an empty array registers
  nothing, so the cases do not skip, they cease to exist: the run is green,
  the skip count reads zero, and 45 of 50 cases silently vanished. The 91
  `describe.skipIf` uses already in the suite do this correctly.

Report skipped counts both ways when you report a suite. A count that is
identical with and without the corpus means either the tests need no ROM, or
they are not registering at all, and those look the same from the outside.

## Every feature ships with a Playwright test

Features are validated by automated UI tests, not by someone clicking through
the app. Manual testing is for exploring, never for acceptance.

Playwright drives the Electron app directly through `_electron`, which is
proven: a shell spike ran 18 cases against a real window, including an
emulator core booting and holding framerate.

Rules:

- Every feature issue states its acceptance criteria as assertions a test can
  make. "Works" is not acceptance; "clicking File > Open with no project
  prompts to locate the ROM" is.
- Assertions check BEHAVIOUR, not presence. Two defects in the shell spike
  rendered perfectly and did nothing: a menu bar appended by node instead of
  attached ignored every click, and a logo drawn in its default black on a
  black bar was present and invisible. Both pass an "is it on screen" check.
  Assert that a click opens a menu, and assert a contrast RATIO.
- The oracle rule applies here as everywhere. A UI test that cannot go red is
  worse than none. Plant the defect and prove it fails.
- Performance claims are assertions too, with the measurement bound to the
  thing being measured. A framerate meter that counted requestAnimationFrame
  callbacks reported a confident 59.9fps for an emulator core that was frozen.
  Read the core's own frame counter, and assert a frozen-span count separately
  from an average, because an average survives a freeze.

## Size budgets

State an expected size in every implementation brief, and stop and ask if the work is heading past it. A Phase 1 task scoped at roughly 150 lines of mechanism returned 813 lines, most of it narration.

Comment-to-code ratio is the house signal: `tools/mesen/l1_dump.lua` sits near 0.60. Much above that means the code is being explained rather than written. Comments should say WHY, not restate WHAT.

Do not build scaffolding for phases that have not been approved.

## Agent workflow

The top-level session is the orchestrator and works from
@docs/agents/orchestrator.md. It reviews and verifies nothing itself: no
change is implemented before the owner approves a plan summary (contents in
that file), every code change to the application, tooling or CI gets two
fresh-agent reviews and a verifier, and it relays their reports and decides.
Operational Markdown (CLAUDE.md, `docs/`, `.claude/`, PR and issue templates)
runs the machinery, not the app, so it skips both reviews and the verifier;
hooks, pre-push and CI still check its content and style. `tools/`,
`.githooks/` and `.github/workflows/` keep the reviews. Its own code edits go
to the verifier too. An agent launched with a brief is an implementer or
reviewer and follows these rules instead:

- Write the test first and see it fail on the old code before the fix lands.
- Write Playwright specs where the brief asks; do NOT run them. Your gates
  are lint, `format:check`, `test:unit` and the Theia build. The verifier
  runs Playwright.
- Report exact test counts, passed and skipped.
- A mutation sweep you design is a smoke test, not coverage evidence. Run it
  against the full suite, and never write "all killed" in a commit message:
  three implementer tables that claimed it each failed independent review.
- If the work batches (captures, sweeps, bulk generation), deliver ONE sample
  and stop for the owner's sign-off. A 100-level sweep was redone after the
  first look at a single capture found three defects.
- Launched processes run hidden and never steal focus. Scratch files go in
  your session scratchpad, not `/tmp`, which other agents share. One-off
  probe scripts are not committed.
- Use `smw-mcp` before raw ASM or ad-hoc ROM scripts.
- Push your branch; do not open the PR or merge.
- One agent per worktree. Two agents in one worktree produced a review whose findings referenced files another agent was editing underneath it.
- Worktrees go in `C:/Projects/.worktrees/<repo>/<task>`, never inside the repo and never as a sibling.
- The implementer never certifies its own work.
- Agents are right-sized by role (`.claude/agents/`): `implementer` and
  `simplify-reviewer` on Sonnet, `adversarial-reviewer` on Opus, `grunt` on
  Haiku, `verifier` on Sonnet. The orchestrator is the only Opus session
  that plans. An agent spawned without a role runs on Sonnet, not the
  orchestrator's Opus.
  Never use a small model for the adversarial gate.
- Keep the GitNexus index fresh. A hook reports it stale after a commit; the
  refresh is `npm run gitnexus`, never a bare `gitnexus analyze`. The bare
  command rewrites the gitnexus-marked region of CLAUDE.md and AGENTS.md with
  em-dashes the pre-commit gate then blocks, and it once destroyed this whole
  section by writing over it. The wrapper normalises the generated text,
  repairs the full-text index when incremental analysis corrupts it, and fails
  loudly if the marker creeps back above this heading.

<!-- gitnexus:start -->
# GitNexus - Code Intelligence

This project is indexed by GitNexus as **hackbench** (12998 symbols, 34955 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root - it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "develop"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol - callers, callees, which execution flows it participates in - use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace - use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/hackbench/context` | Codebase overview, check index freshness |
| `gitnexus://repo/hackbench/clusters` | All functional areas |
| `gitnexus://repo/hackbench/processes` | All execution flows |
| `gitnexus://repo/hackbench/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
