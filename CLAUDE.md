# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**HackBench** - a VS Code extension for editing Super Mario World (SNES) ROM files. Opening a ROM mounts it as a navigable virtual folder tree. Custom editors handle level, palette, and GFX tile-sheet viewing/editing. Package name `hackbench`; marketplace ID `engenb.hackbench`; command/view/viewType IDs use the `hackbench.*` namespace.

## Branch strategy

- `main` - reserved for releases. Sits at the repo's initial commit
  `afbc580` and has received nothing since. Never commit or PR here;
  it moves only when a release is cut from `develop`.
- `develop` - default branch and integration base; all PRs target here
- `feature/*` - branch off `develop`, one concern per branch
- After merging a PR: `git checkout develop && git pull origin develop && git checkout -b feature/<next>`

Do not add `Co-Authored-By: Claude` lines to commits. Do not add "Generated with Claude Code" footers or any AI attribution to PR bodies or commit messages.

## Commands

```bash
npm run compile        # webpack dev build - extension + all four webview bundles
npm run watch          # rebuild on save
npm run package        # production build (minified, hidden source maps)
npm run lint           # ESLint src, test, tools, theia, root config; --max-warnings 0
npm run lint:fix       # auto-fix
npm run format         # Prettier over JS/TS/CSS
npm run format:check   # Prettier check mode, as CI runs it
npm run test:unit      # Vitest unit tests (single run)
npm run test:unit:watch
```

To run a single test file: `npx vitest run test/suite/unit/GraphicsDecoder.test.ts`

To launch the extension: **F5** in VS Code (Extension Development Host).

## Architecture

### Extension host (`src/`)

```
extension.ts              - activate(); registers all providers and commands
RomSession.ts             - holds the open SmwRom + URI slug for the session
rom/                      - pure ROM parsing, zero VS Code dependency
providers/                - VS Code integration layer (FileSystem, TreeView, editors)
webview/                  - sandboxed browser bundles, one subfolder per editor
```

### ROM parsing layer (`src/rom/`)

All modules are plain TypeScript with no VS Code imports - independently testable.

| File | Purpose |
|------|---------|
| `addressing.ts` | LoROM SNES address ↔ file offset conversion |
| `RomFile.ts` | Binary ROM wrapper; all reads go through SNES-addressed helpers |
| `SmwRom.ts` | SMW pointer tables, level list, header parsing |
| `LcLz2.ts` | LC_LZ2 decompressor (used for all GFX files) |
| `GfxLoader.ts` | GFX file loading: pointer tables → decompress → decode tiles into VRAM slots |
| `GraphicsDecoder.ts` | 2BPP/3BPP/4BPP tile decoders; BGR555 → RGBA conversion |
| `PaletteLoader.ts` | ROM palette groups → CGRAM rows |
| `LevelParser.ts` | Layer-1 object + sprite stream parser; level header |
| `ObjectExpander.ts` | Level object → 2D Map16 tile grid |

### Virtual filesystem

Opening a ROM mounts `smwrom://<slug>/`. Each virtual file is a small JSON descriptor; the editor provider reads it and fetches actual ROM data on demand.

```
smwrom://<slug>/
  maps/000.smwmap         ← { romPath, levelIndex }
  palettes/global.smwpalette
  gfx/GFX00.smwgfx        ← { romPath, gfxIndex }
```

Domain terms (slot, map, level, entry map, sub area, launch tile, submap) are
defined in [docs/glossary.md](docs/glossary.md). They are not interchangeable;
using them loosely is how this project produced five different level counts.

### Providers (`src/providers/`)

| Provider | Virtual file | Editor |
|----------|-------------|--------|
| `SmwFileSystemProvider` | - | Implements `vscode.FileSystemProvider` for `smwrom://` |
| `RomExplorerProvider` | - | TreeDataProvider sidebar |
| `MapEditorProvider` | `.smwmap` | Map tile grid + object/sprite overlay |
| `PaletteEditorProvider` | `.smwpalette` | Palette group browser |
| `GfxViewerProvider` | `.smwgfx` | Tile sheet viewer |

### Webview layer (`src/webview/`)

Webpack bundles each editor's `main.ts` into `dist/webview/<name>.js`. Communication is via `postMessage`: webview sends `{ type: 'ready' }`, extension replies `{ type: 'load', ...payload }` or `{ type: 'error', message }`. GFX viewer payload includes `rawBytes` + `defaultBpp` for client-side re-decode.

## The ROM is a collection of lookup tables

Read the tables. Do not model the behaviour.

SMW stores what it needs in tables, and a romhack still has to run on a stock
SNES, so those tables stay where the hardware expects them. Almost every
question this project asks ("which levels exist", "what does this exit lead
to", "what is this level called") is answered by finding the right table and
the right index into it. We are not building an emulator. Where a table is
enough, reading the table IS the answer; reach for code only when the table
alone cannot tell you whether it is still the one the cart uses.

**The table is never the hard part. The index is.** Reading 512 three-byte
entries is trivial. The work is knowing what indexes them. The exit-graph bug
took a day and the answer was that `DATA_05F800` is indexed
`(submapFlag << 8) | rawByte`, with the high byte coming from `OWPlayerSubmap`
and NOT from the translevel: two independent gates in one routine
(`bank_05.asm:7217-7226`). Trace the ASM to learn the index, then read the
table. Do not port the routine.

**If you are describing behaviour, you have lost the thread.** Every defect
this project has shipped came from modelling instead of reading:

| Defect | What it did | What it should have done |
|---|---|---|
| `screenHasExitTrigger` | invented Map16 tile scanning, cited an address with zero hits in the disassembly | read `DATA_05F800` |
| `levelHasObjects()` | invented a "modes 0-20 valid" rule with a fabricated line citation | compare the L1 pointer against the filler |
| exit-graph high byte | derived it from `ExitTableHigh` bit 3, which the game never reads for this | take it from the submap flag |

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
were measured across the 6-cart corpus: all eight stock tables sit at their
vanilla addresses on 6 of 6, and the variant-offset table at `$00ABD3` plus the
two `LDA #imm` sites feeding CGRAM column 1 are byte-identical on 6 of 6. The
data does not move. What changes is the CONTENT in place - GPW2 edits 4 of the
8 tables, Invictus 2 - and, separately, Lunar Magic writes per-level override
blocks through `$0EF600`: 157 levels on GPW2, 161 on Invictus, 53 on GPW 1.2,
0 on the three unedited carts. So for palettes a fixed address is safe and
reading the override table is mandatory, which is the opposite shape to music,
where AddmusicK moves the data and deletes the call. Do not generalise one
subsystem's answer to another; both cost one probe to check.

**Existing is not the same as reached.** A patch that leaves a routine
byte-identical and diverts control before it passes every existence check.
Poking `$00A418` to `RTS`, or the NMI vector at `$00FFEA` to anywhere, leaves
`$00A41A..$00A435` pristine while the cart animates nothing; a detector
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

## Knowledge Integration (External Disassembly)

Domain library: `C:\Projects\SMWDisX`. SMW ROM constants, handler ports, and ASM-behavior questions are authoritative there - not in this file. This section is the router; `SMWDisX` is the store.

**Global SNES rulebook** (addressing, BGR555, VRAM layout): `@C:\Projects\SMWDisX\.claude\rules\snes-global.md` - load this whenever any `src/rom/` task touches color math, LoROM offsets, or VRAM slot assignments.

**Pillar 1 - Scoped Rules (`src/rom/`)**: Any work touching `src/rom/` requires cross-referencing the matching bank folder in `SMWDisX`. Do not port or assert ROM behavior without tracing to an ASM line there first.

**Pillar 1a - ASM is REFERENCE, not a source to hardcode from**: Use the
disassembly to trace which lookups happen, in what order, and how graphics are
composed and presented. Do NOT derive logic from the ROM and then hardcode it.
This tool targets romhacks, and the ROM's code can be manipulated in ways that
invalidate any such derivation. A hardcoded derivation does not merely go
stale: it renders confidently wrong on the user's own cart with every test
still green.

In practice:

- Sprite identity comes from the MAP's sprite stream. Everything about that
  sprite is then looked up from ROM tables: one hardcoded address per SHARED
  table, indexed by the id. `SprTilemapOffset[id]`, `Sprite166EVals[id]`, the
  handler pointer at `$01:85CC + id*2`. Values always read from the cart.
- Where a value lives inside one sprite's own handler rather than a shared
  table, anchor it as an OFFSET FROM THE ROM-RESOLVED HANDLER POINTER, not as
  an absolute address, so a relocated handler still resolves.
- **If HackBench can interpret the ROM directly to produce graphics or
  animation, it MUST. It must go no further.** Opcodes are readable bytes, so
  reading them is interpretation, not assumption. Do not stop at data tables
  and hardcode the rest.
- Worked examples, all verified readable on the vanilla cart. A shift count is
  the number of consecutive `$4A` (`LSR A`) bytes at an address: `$01:BE96`
  reads 6 and the OR-bit slice reads 3, which a descriptor should COUNT rather
  than hardcode. A displacement can be the opcode itself: `$FE` at `$01:BEC3`
  is `INC abs,X` on `$0301`, so the 1 px top-tile nudge is +1 on
  `OAMTileYPos+$100`, and a hack that changed it to `$DE` would correctly read
  as -1. Comparison thresholds are plain immediates.
- The line is at ASSUMPTION, not at opcodes. **We are not building an
  emulator, but content we load for editing must be INTERPRETED, not assumed
  from the ROM.** Running the cart to see what happens is out of scope.
  Reading bytes - including opcodes - to determine what the cart does with
  the content we are about to show the user is in scope and required.
- Static control-flow reading is on the required side of that line. Walking
  instructions from a known entry to find which write is REACHED is reading,
  because it evaluates no condition and holds no machine state; it follows
  determinate transfers and refuses everything else. The palette-animation
  detector does this to resolve a relocated routine, and it exists because
  the byte scan it replaced reported a cart as animating a slot the hack had
  disabled. A walk that refuses conditional branches fails closed; a scan
  that takes the first plausible match fails confident.
- A derivation that truly cannot be read must be NAMED as a hack-fragility
  point and paired with honest degradation: compare the handler against its
  vanilla bytes and DECLINE TO ASSERT when it diverges, rather than rendering
  vanilla with confidence. Reach for this only after establishing the value is
  genuinely unreadable, which is rarer than it first appears.

**Pillar 2 - Context Budgeting**: Load domain knowledge on demand using `@C:\Projects\SMWDisX\<bank_xx>\MEMO.md` syntax. Never read entire bank folders speculatively; load only the MEMO.md for the bank(s) directly relevant to the current task.

**Pillar 3 - Memory Snapshot Protocol**: After resolving a complex SNES logic problem (multi-routine control flow, OAM layout, palette tricks), propose a Memory Snapshot: a concise summary for `SMWDisX/<bank_xx>/MEMO.md`. Include the address range covered, the behavior decoded, non-obvious invariants, and the PR that exercised it. Only propose a snapshot when the analysis is non-trivial - single-table lookups do not warrant one.

## Files never to commit

`*.smc`, `*.sfc`, `*.rom`, `*.ips`, `*.bps`, `test/roms/`, `test/magic/` are gitignored.

# Quality gates

These exist because each one corresponds to a defect that actually reached review in this repo. They are not generic best practice.

## Enforced mechanically

Enable the hooks once per clone:

```bash
git config core.hooksPath .githooks
```

Two scripts run on pre-commit and in CI.

`tools/scripts/check-staged-style.sh` runs ESLint at `--max-warnings 0` and
Prettier in check mode over the staged JS/TS/CSS. Warnings are fatal: the
gate previously exited 0 while reporting 14 of them, and `src/` was the only
tree it looked at. `test/suite/gates/lintGate.test.ts` plants a defect per
rule and proves both halves go red, and asserts the package.json scripts
still carry the flags that make them able to fail.

`tools/scripts/check-staged-content.sh` runs on pre-commit and in CI. It blocks ROM-derived bytes (the copyright rule in `docs/testing.md`, previously guarded only by `.gitignore`, which `git add -f` silently defeats) and em-dashes in newly added lines. Override with `git commit --no-verify` only with a stated reason in the PR.

## Claim discipline

State the evidence scope with every claim, in comments, docs and commit messages. Not "deterministic" but "byte-identical across 6 cold runs, one machine, Mesen 2.x". Two separate claims in this repo were asserted far past their evidence and nearly shipped: "memory callbacks do not fire under `--testrunner`" (false: only `$7E`-prefixed absolute addresses fail) and a determinism result generalised from three title-screen frames.

Cite ROM behaviour to `SMWDisX file:line`. Trace it; do not copy the assembly into our source. Copies rot when the disassembly is regenerated.

## Oracles must be proven able to fail

Any check, harness or test that reports a verdict needs a committed test proving it goes red on a planted defect. Verdicts that cannot fail are worse than no verdict. Real examples from this repo: a determinism check that printed "all artifacts byte-identical across 5 runs" having compared zero files, and a wrapper that exited 0 on run codes `14,14,14,14,0`.

Never accept a single-case acceptance test. A debounce tuned to level `$105` false-failed 22% of levels with a factually wrong diagnosis. Sweep the range.

**CI has no cartridge, so every safeguard needs a test that runs without one.**
`test/roms/` is gitignored and cannot be committed, so CI is permanently the
corpus-absent case. A safeguard proven only by corpus tests is unproven where
it actually runs. Measured on the music branch: with the corpus removed,
deleting the opcode gate outright, shifting an operand offset by one, and
falling back to the vanilla address when the gate fails all passed 5 of 5
green. That last one is the defect the gate exists to prevent.

Two rules follow, and the second is the subtle one:

- Every gate, refusal or bounds check gets at least one SYNTHETIC fixture
  exercising it. Build the bytes in the test; do not reach for a cart.
- Gate with `describe.skipIf`, never by generating cases from a corpus
  listing. `for (const file of romFiles)` over an empty array registers
  nothing, so the cases do not skip, they cease to exist: the run is green,
  the skip count reads zero, and 45 of 50 cases silently vanished. The 91
  `describe.skipIf` uses already in the suite do this correctly.

Report skipped counts both ways when you report a suite. A count that is
identical with and without the corpus means either the tests need no cart, or
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
  prompts to locate the cart" is.
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

- One agent per worktree. Two agents in one worktree produced a review whose findings referenced files another agent was editing underneath it.
- Worktrees go in `C:/Projects/.worktrees/<repo>/<task>`, never inside the repo and never as a sibling.
- The implementer never certifies its own work. Every non-trivial change gets two fresh-agent reviews against the diff, adversarial and simplification, and the orchestrator independently builds and runs before accepting.
- Never use a small model for the adversarial gate.
- Keep the GitNexus index fresh. A hook reports it stale after a commit; the
  refresh is `npm run gitnexus`, never a bare `gitnexus analyze`. The bare
  command rewrites the gitnexus-marked region of CLAUDE.md and AGENTS.md with
  em-dashes the pre-commit gate then blocks, and it once destroyed this whole
  section by writing over it. The wrapper normalises the generated text,
  repairs the full-text index when incremental analysis corrupts it, and fails
  loudly if the marker creeps back above this heading.

<!-- gitnexus:start -->
# GitNexus - Code Intelligence

This project is indexed by GitNexus as **hackbench** (9694 symbols, 25292 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
