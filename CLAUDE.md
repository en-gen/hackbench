# CLAUDE.md

Guidance for every Claude Code session in this repo: the main session and
every role agent. Keep it short; every agent pays for every line on every
call.

- **Main session (not launched with a brief):** you are the orchestrator and
  work from [docs/agents/orchestrator.md](docs/agents/orchestrator.md),
  injected at session start. It holds merging, PRs, issues and delegation.
- **Role agents:** your role file in `.claude/agents/` plus this file.
- **ROM rules** load automatically from `.claude/rules/rom-interpretation.md`
  when you read or edit `src/`, `test/`, `tools/` or the node backend. Read it
  before any ROM design discussion.

## Project

**HackBench** - a Super Mario World (SNES) ROM editor, built as an Eclipse Theia and Electron desktop application. Command and view IDs use the `hackbench.*` namespace.

It is NOT a VS Code extension. That origin survives under `src/providers/` and `src/webview/` as a reference implementation for reading SMW data: not shipped, no new features.

Work is non-destructive and project-based. A `.hbproj` project references a ROM by identity and never copies it; every edit is an ordered patch layer under `ops/`; `Export Patch` diffs the working copy into a real `.ips`. See [docs/architecture/project-format.md](docs/architecture/project-format.md).

## Branches and commits

- `develop` is the default branch and every PR's base. `main` is reserved for
  releases and does not exist yet; never PR to it.
- `feature/<name>` off `develop`, one concern per branch.
- No `Co-Authored-By: Claude` lines, "Generated with Claude Code" footers or
  any AI attribution in commits or PR bodies.
- The repo went public on 2026-09-27 with rewritten history. Issue and PR
  numbers from before then belong to the private `en-gen/hackbench-archive`
  (`C:/Projects/hackbench-tools/issue-map.tsv` maps issues).

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

Each one corresponds to a defect that actually reached review in this repo.

## Enforced mechanically

`npm install` sets `core.hooksPath` to `.githooks`. Two gates run on
pre-commit, pre-push and in CI:

- `tools/scripts/check-staged-style.sh`: ESLint at `--max-warnings 0` and
  Prettier check over staged JS/TS/CSS. Warnings are fatal.
  `test/suite/gates/lintGate.test.ts` proves both halves go red.
- `tools/scripts/check-content.mjs` (#678): blocks ROM-derived bytes (the
  copyright rule in `docs/testing.md`; `.gitignore` alone is defeated by
  `git add -f`) and em-dashes in added lines. `--no-verify` only with a reason
  stated in the PR.

## Claim discipline

State the evidence scope with every claim, in comments, docs and commit
messages: not "deterministic" but "byte-identical across 6 cold runs, one
machine, Mesen 2.x". Cite ROM behaviour to `SMWDisX file:line`; trace it, do
not copy assembly into source.

## Oracles must be proven able to fail

- Any check, harness or test that reports a verdict needs a committed test
  proving it goes red on a planted defect. (A determinism check once reported
  "byte-identical across 5 runs" having compared zero files.)
- Never accept a single-case acceptance test; sweep the range.
- **CI has no ROM**, so every gate, refusal or bounds check needs a SYNTHETIC
  fixture: build the bytes in the test. With the corpus removed, deleting an
  opcode gate outright once passed 5 of 5 green.
- Gate corpus tests with `describe.skipIf`, never by generating cases from a
  corpus listing: a loop over an empty array registers nothing, so 45 of 50
  cases once vanished with a zero skip count.
- Report passed and skipped counts with and without the corpus. Identical
  counts mean the tests need no ROM or are not registering.

## Every feature ships with a Playwright test

Acceptance is automated; manual testing is for exploring. Every feature
issue states acceptance criteria as assertions ("clicking File > Open with
no project prompts to locate the ROM", not "works"). Assert BEHAVIOUR, not
presence: a menu that ignores clicks and a black logo on a black bar both
pass an "is it on screen" check. Bind performance measurements to the thing
measured (read the core's frame counter, assert frozen spans separately from
the average).

## Size budgets

Every brief states an expected size; stop and ask when heading past it.
Comment-to-code ratio near 0.60 is the house ceiling
(`tools/mesen/l1_dump.lua`); comments say WHY, not WHAT. No scaffolding for
unapproved phases.

## Agent workflow

Every agent follows these. Role-specific rules are in `.claude/agents/`.

- Test first: see it fail on the old code before the fix lands.
- Report exact test counts, passed and skipped. A mutation sweep you design is
  a smoke test, not coverage evidence; never write "all killed".
- Batches (captures, sweeps, bulk generation): deliver ONE sample and stop
  for the owner's sign-off.
- Launched processes run hidden and never steal focus. Scratch files go in
  your session scratchpad, not `/tmp`. One-off probe scripts are not
  committed.
- ROM and disassembly questions go to `smw-mcp` before raw ASM reads or
  ad-hoc ROM scripts; log hand-answered ones in `smw-mcp/docs/query-log.md`.
- One agent per worktree, at `C:/Projects/.worktrees/hackbench/<task>`,
  never inside the repo or beside it.
- Never certify your own work. Never merge, rebase a pushed branch, or
  force-push.
- Never load images into context; decide from numbers. Images are for the
  owner and PRs.
- Spawn a sub-agent only when it saves cost or context, by role, with an
  explicit `model`.
- `npm run gitnexus` refreshes the index after a commit; never a bare
  `gitnexus analyze`, which rewrites the marked region below with em-dashes.

<!-- gitnexus:start -->

# GitNexus - Code Intelligence

This project is indexed by GitNexus as **hackbench** (13349 symbols, 36106 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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

| Resource                                   | Use for                                  |
| ------------------------------------------ | ---------------------------------------- |
| `gitnexus://repo/hackbench/context`        | Codebase overview, check index freshness |
| `gitnexus://repo/hackbench/clusters`       | All functional areas                     |
| `gitnexus://repo/hackbench/processes`      | All execution flows                      |
| `gitnexus://repo/hackbench/process/{name}` | Step-by-step execution trace             |

## CLI

| Task                                         | Read this skill file                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md`       |
| Blast radius / "What breaks if I change X?"  | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?"             | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md`       |
| Rename / extract / split / refactor          | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md`     |
| Tools, resources, schema reference           | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md`           |
| Index, status, clean, wiki CLI commands      | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md`             |

<!-- gitnexus:end -->
