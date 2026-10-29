# HackBench Testing Guide

## Legal position - read first

**HackBench does not distribute any Super Mario World ROM data, decompressed
resources, or other content derived from the ROM.** Super Mario World is
© Nintendo, and any bytes extracted from it - compressed _or_ decompressed,
whole files _or_ narrow slices - remain Nintendo's copyrighted property.
Committing that data to this repository would create legal exposure and is
forbidden by project policy.

This affects how the test suite is organized:

- **CI runs only on content original to this project** - hand-crafted test
  vectors, pure-function assertions, synthetic inputs.
- **Small vanilla tables are not committed either.** A test that needs vanilla
  behaviour asserts the decoded result in a corpus-gated test (`describe.skipIf`)
  and uses made-up tables everywhere else.
- **Tests that need real ROM data are developer-local only.** They are
  either skipped automatically when no ROM is present, or depend on fixtures
  that live under `test/fixtures/` (gitignored).
- **Everything under `test/fixtures/` is gitignored** by default. If you
  regenerate fixtures locally, they stay on your machine. See
  [.gitignore](../.gitignore) for the specific rule.

Do not submit PRs that add ROM data, decompressed game resources, or
fixtures derived from the ROM. These will be rejected.

## The content gate

`tools/scripts/check-content.mjs` (issue #678) blocks: ROM/save/patch and
native/wasm extensions, `.asm`-family disassembly, and any binary file (a
NUL byte, or content that isn't valid UTF-8, anywhere in the blob) except
a `build/icons/**` PNG/ICO/ICNS whose magic bytes match its extension and
is 512 KB or smaller; plus, on text content, base64 blobs, `data:...;
base64,` payloads, oversized hex/byte-token counts (xxd dumps, `db`/`dw`/
`.byte` directives, `\x` escapes), and disassembly-shaped listings. Text
over 8 MB is blocked outright as `oversize`, never sniffed. Commit
messages and annotated tag bodies get the same text-content rules. An
in-file `content-gate: allow <rule> -- <reason>` pragma, only at the
start of a comment line, exempts one file from one content rule.

`rom-provenance` (#812): a comment that says nearby data was copied from the
game (`vanilla $<address>` or `0x<address>`, `copied|taken|lifted|dumped
from`, `from the ROM at $<address>`, `ROM bytes`, `real ROM
bytes|data|values`), either leading and followed within 3 lines by a CODE
line, or trailing on the literal's own line, blocks when that code holds a
numeric array literal opening of 2+ elements (decimal, `0x`, `$`, mixed). A
literal inside a comment is a citation and never counts. Comments are `//`
(trailing too, spaced or not), `/* */` (open blocks carry across lines),
and a leading `#` or `*`; delimiters inside quoted strings are skipped. In
`.md` files a leading `#` or `*` is a heading or bullet, not a comment;
`<!-- -->` is one, and `/*` opens a block only at line start. A 4-byte copy
cannot be told from invented values by content, so the claim is the signal;
say "invented values" instead, or add the pragma. A decimal array with `0x`
elements mixed in counts toward `byte-tokens` too.

Modes: `staged` (no hook runs it since #1183), `range BASE HEAD` (CI), `push REMOTE`
(`.githooks/pre-push`, reading stdin ref-updates and querying the remote
live via `git ls-remote` rather than trusting local, possibly stale,
remote-tracking refs), and `history [REF]` (the repo-migration oracle, run
in CI only once public: every blob reachable from `REF`, default `HEAD`,
plus tags, never other branches, so an unmerged branch cannot fail an
unrelated ref (unless tagged) (D59 A); a ref
that does not resolve exits 2; it also refuses a shallow clone, a grafts file,
and a tag pointing at a blob or tree outside any commit's tree). Trade-off of
D59 A: a branch pushed with no PR, or a PR whose base is not develop, main or
feature/\*\*, gets no server-side scan until it is merged or PR'd; the
pre-push hook is the only check there.

Read budget (#461): before any content is buffered, object sizes are
checked with `git cat-file --batch-check`. A blob over 32 MiB, or (in
`staged`, `range` and a per-ref `push`) a set whose total exceeds 128 MiB,
exits 2 naming the path; path-rule hits (such as a staged `.smc`) are still
printed alongside the refusal. `history`, and a `push` to an empty remote,
skip the total refusal and read in chunks of at most 128 MiB instead, so
memory stays bounded as history grows. A size exactly at a limit passes.
The largest tracked file today is 340 KB. The limits can be overridden with
`CONTENT_GATE_MAX_BLOB_BYTES` and `CONTENT_GATE_MAX_TOTAL_BYTES`; these exist
so tests need not write megabytes, not for normal use.

A commit MESSAGE already on protected `develop` cannot be amended, so a false
positive there would red `history` mode forever. Such a message goes in
`tools/scripts/content-gate-reviewed.txt` as `<sha> <rule> -- <reason>`,
after a person checks it. It exempts that message for that rule only; file
content is never exempt, and a malformed line or unknown rule exits 2.

`npm install` sets `core.hooksPath` to `.githooks` automatically
(`tools/scripts/set-hooks-path.cjs`). The only bypass is
`git commit --no-verify` / `git push --no-verify`.

### The 8-byte window rule (synthetic carts)

A synthetic cart must not carry the game's code. The rule is mechanical: no 8 consecutive bytes with at least 3
distinct values may also occur anywhere in the vanilla ROM. `test/suite/support/vanillaWindows.ts` holds the
checker (it reports each hit as an SNES address) and `test/suite/unit/sprites/SyntheticSpriteRomNoVanilla.test.ts`
applies it to the sprite cart, the default and each `SyntheticOptions` value on its own; it needs the vanilla ROM and
skips without it. `CastleFlames.test.ts` applies it to the bytes its fixtures write over the plain cart.

Where a reader in `src/` fixes the game's opcodes (or a fixture keeps the game's operand values on purpose), the
window stays and the gate's allow list names the region and why. Each region spans at most 64 bytes and lists its
exact hit count: a count that rises, drops or reaches zero fails until the list is updated, and planted cases prove
those checks go red.

ExecutePtr, CallSpriteInit and the grinder handler (#1082) were removed by running them instead: a stock-code
SHA-256 needs at least 24 unknown bytes (not masked, not stated elsewhere in the working tree), and each of those had
fewer. The runs follow the stock-code exception in `.claude/rules/rom-interpretation.md` (added in #1030): a fixed
entry, a step budget, a refusal that names why. Entries are reached from HandleSprite through the ROM's own operands
and tables: ExecutePtr from its JSL operand, CallSpriteInit from its status table, the grinder handler from the MAIN
pointer table.

- `checkExecutePtr` calls the routine as a JSL with a table of its own in WRAM, for all 256 indices, and requires
  the landing, the popped frame, the kept registers and no register or SRAM write.
- `resolveTables` runs CallSpriteInit for every sprite number in three slots and requires the JSL frame at
  ExecutePtr, the number as the index and the run status as the only write besides the frame; the INIT table is read
  from that frame.
- `grinderDrawsBeforeSnap` runs the handler in every slot, then in slot 3 with each WRAM cell it reads set to every
  value, one cell at a time, and requires the draw, the interact and the line step in that order; it returns a
  reason, which the runner puts in `lineGateReason`. Known limit: a hook that needs two cells set together (for
  example `LDA $9D / AND $13 / BNE`) is not caught. The three expected routine addresses are the old `targets`,
  fixed for vanilla; a relocated routine fails closed.
- Register and SRAM writes are refused in all three runs (the bus reports SRAM stores through `onSramWrite`).
  Evidence scope: the vanilla USA ROM and the synthetic cart, one machine, 2026-10-18.
- The block spawn dispatcher, slot search and status write are one 81-byte span (`BLOCK_SPAWN_DISPATCHER`).

Planted defects for each are in `test/suite/unit/sprites/ShapeRuns.test.ts`.

The fix for an allowed region is to make the reader recognize the code by SHA-256 (as
`CastleFlames.ts` and `SubmapFlagGate.ts` do), then delete the region.

Source-text probes read the file text only, so they miss runs built from helpers, named opcodes or spread
arrays. The assembled gate, run against the built cart, is the oracle; a clean probe alone proves nothing.

## Where the corpus lives

The ROM corpus is **outside the repo**, beside the clone:

```
<projects>/
  hackbench/              the clone (and <projects>/.worktrees/hackbench/* )
  hackbench-tools/
    roms/                 the cartridges
    mesen/                Mesen.exe, Saves/, Debugger/, GameConfig/
    magic/  fixtures/  dispel/  spcplay/
```

It used to be `test/roms/` and `tools/mesen/` inside the checkout. Both
were gitignored, which stops a commit but not a `git clean -x`: that
command deletes ignored files, and these are cartridges and captures that
cannot be downloaded again. Outside the repo, git cannot reach them at all.
The interactive dump scripts `tools/mesen/*.lua` and their README stay
tracked in the repo; only the gitignored payload moved. The headless
per-graphics-layer capture harness and its PowerShell runners are not here: they
live in `en-gen/hackbench-validation` under `capture/`.

Nothing in the suite hardcodes any of this. `test/suite/support/corpus.cjs`
resolves the corpus directory for both the Vitest suites (through
`corpus.ts`) and the Playwright specs:

1. `HACKBENCH_ROMS`, returned as given, even if it does not exist: an
   explicit override that names nothing should make the suites skip, not
   fall through to some other corpus. `HACKBENCH_TOOLS/roms` likewise.
2. The nearest ancestor of the repo root holding `hackbench-tools/roms`,
   walked to the filesystem root, so every worktree layout resolves it.
3. `<repo root>/test/roms`, the old layout, so a clone that has not moved
   its corpus still runs.

When none exist it returns a path that does not, so `hasRom` reads false
and the suites SKIP rather than throwing during collection.

## SingleStepTests data (the 65816 core)

`test/suite/unit/cpu/SingleStep.test.ts` runs `src/rom/cpu/Cpu65816.ts`
against [SingleStepTests/65816](https://github.com/SingleStepTests/65816):
512 files (`{op}.{n|e}.json`, 10,000 cases each), one `it` per file. The data
is about 2.7 GB of data (3.2 GB as a git clone). It has no licence (GitHub
reports none, upstream issue 9 asks for MIT and is open), so nothing is
vendored. Clone it to `<hackbench-tools>/singlestep65816/` or point
`HACKBENCH_SINGLESTEP` at the clone (or its `v1` directory); without it every
case skips. The harness compares registers, flags, memory and the ordered
write log from the vectors' cycles; reads, dummy cycles and timing are not
compared. Concessions: MVN/MVP files are cut by the data at 100 cycles, so the
harness runs 14 byte moves and expects `pc + 2`; in emulation mode a
same-address write pair (an 8-bit RMW's old-value write) is collapsed (see
`test/suite/support/singleStep.ts`). Ground truth is Clark and WDC
documentation (<https://6502.org/tutorials/65c816opcodes.html>) confirmed by
Snes9x or bsnes, not the vectors. (PEI is the one place Snes9x differs: it
wraps the pointer at DL=0, while Clark and the vectors, which the core follows,
do not.) `DISPUTED` in
that file lists the 44 vectors where the core deliberately differs from the
data (`e1.e` #8668, upstream issue 3; 43 `fc.e` page-cross vectors, issues 6
and 7). The main run executes them rather than skipping them. A disputed vector
is excused only when its whole diff is of the disputed kind: for `e1.e`, A (P
may also differ); for `fc.e`, write order (the $FF and $1FF stack bytes may
also differ). Any other difference counts as a failure. A corpus-gated test
asserts that exactly 1 and 43 such vectors exist per file and that each one
still differs from the core in that way, so an exception that stops being
needed goes red. The synthetic `Cpu65816.test.ts` and `Cpu65816Edges.test.ts`
run in CI; they hold the planted-defect proofs for the harness and the edge
cases the random vectors rarely reach.

## Getting a ROM (locally)

You can play the ROM-dependent tests if you own a legal copy of
_Super Mario World (USA)_. We validate against a specific dump:

|          |                                            |
| -------- | ------------------------------------------ |
| Filename | `Super Mario World (USA).vanilla.sfc`      |
| Size     | 524,288 bytes (no copier header)           |
| SHA-1    | `6B47BB75D16514B6A476AA0C73A683A2A4C18765` |

Drop your vanilla ROM in the corpus directory above, or set
`HACKBENCH_ROMS` to wherever you keep it. Either way it is outside the
repo, so it cannot be committed by accident or removed by `git clean -x`.

**A ROM modified by Lunar Magic is not suitable.** LM rewrites parts of
the ROM on save and shifts some addresses, producing silent mismatches
against expected vanilla behavior. If you also keep an LM copy, name it
with a `.magic.sfc` suffix (e.g., `... (USA).magic.sfc`) so it's obvious.

## Test categories

### 1. Pure-function tests (always run, no ROM needed)

Most of `test/suite/unit/` falls here. These test decoders, parsers, and
helpers with hand-crafted byte sequences or literal inputs. Examples:

- [`LcLz2.synthetic.test.ts`](../test/suite/unit/LcLz2.synthetic.test.ts)
  - exercises every LC_LZ2 command type with synthetic vectors created
    from the format spec, not dumped from any ROM.
- [`GraphicsDecoder.test.ts`](../test/suite/unit/GraphicsDecoder.test.ts)
  - feeds planar byte patterns into the 2bpp/3bpp/4bpp decoders and
    checks pixel output.
- [`ObjectExpander.test.ts`](../test/suite/unit/ObjectExpander.test.ts)
  (the non-integration portion) - feeds tiny constructed object streams
  into the expander.

These run in CI on Node 22 and are the project's primary
correctness gate, except on a docs-only pull request (see below).

CI jobs (`.github/workflows/ci.yml`): `Changes` decides the rest; `Content
policy` always runs; `Static checks` (lint, format, type-checks, compile),
`Unit tests`, `Spike serve hardening` and `Theia type-check` run in parallel.
A pull request whose changed paths are all under `docs/` or end in `.md`
(`tools/scripts/ci-changes.mjs`) skips those four; pushes and manual runs
never skip. The required `Build & Test` check is an aggregate over the jobs
(`tools/scripts/ci-aggregate.mjs`): it fails on an unreadable filter result
or a heavy job skipped when code changed. `ciGate.test.ts` plants both
failures.

### 2. ROM-dependent tests (skipped in CI, run locally if ROM present)

Blocks marked with `describe.skipIf(!romPresent)` or `it.skipIf(...)`.
That spelling is not a style preference, it is the whole mechanism: see
"Gate with skipIf, never by discovery" below. Examples:

- `SmwRom integration` - opens the ROM and exercises the pointer-table
  logic end-to-end.
- `GfxLoader (ROM-only)` - checks that `readGfxFile`/`loadGfxFile` return
  expected sizes and pixel counts for specific GFX files.
- `PaletteLoader (requires ROM)` - verifies CGRAM assembly for level $104.

These skip cleanly when `Super Mario World (USA).vanilla.sfc` is not in the
corpus directory. If you've dropped your ROM in place, they run
automatically. Ask for it with the helper, never by building a path:

```ts
import { VANILLA, hasRom, romPath } from '../support/corpus'

describe.skipIf(!hasRom(VANILLA))('...', () => {
  it('...', () => {
    // Inside the case: a describe body still runs at collection time.
    const rom = SmwRom.open(romPath(VANILLA))
  })
})
```

### Gate with skipIf, never by discovery

A case that is absent is not a case that is skipped. Measured on the suite
at 830be6f by running it twice, once with the corpus attached and once
without, and diffing the TEST COUNTS rather than the skip counts: 154 cases
existed with the corpus and did not exist without it. None was reported as
skipped, because none was ever registered. CI has no ROM, so that was
CI's permanent state.

Four spellings produced it, all of them now banned by
`test/suite/gates/testRegistrationGate.test.ts`:

- `readdirSync(ROM_DIR)` at module scope, then `for (const f of romFiles)`
  around the cases. An empty listing registers nothing.
- A declared corpus `.filter(existsSync)` before the loop, which drops the
  absent ROMs out of the list instead of skipping them.
- `cond ? describe : describe.skip`, and bare `.skip` / `.todo`.
- `if (romPresent) { it(...) }`, which leaves no trace in any count at all.

Do this instead: DECLARE the corpus as a list of names, loop over the whole
list, and gate each entry with `describe.skipIf(!present(file))`. The case
is registered on every machine and the skip count names it.

Reading the corpus INSIDE a case body stays fine: the case exists either
way. Put a tripwire on the listing so it cannot pass vacuously, as
`Map16.tileCount.test.ts` does with `expect(carts.length).toBeGreaterThan(0)`.

Nest no `describe.skipIf` inside a suite that is itself `skipIf`: when the
outer suite skips, the inner tests end `pending`, and the summary line counts
`pending` as neither passed nor skipped, so the totals no longer add up. Put
every condition on ONE `describe.skipIf` (`!romPresent || !fs.existsSync(csv)`)
and leave the outer suite a plain `describe`. Evidence: vitest ^5.0.3,
2026-10-18, a synthetic probe (nested gave `pending`, flat gave `skipped`);
27 scrollSim capture tests showed it before this change.

## Writing new tests

Order of preference, highest to lowest:

1. **Pure-function test with synthetic inputs.** Always preferred.
2. **Property/round-trip tests** that validate internal consistency
   (e.g., encode-then-decode returns the original).
3. **ROM-dependent test with `skipIf(!romPresent)`.** Acceptable when
   testing ROM-traversal code paths. Remember: these won't run in CI, so
   the gate has to be honest about what it disabled.
4. **Fixture-based tests that read from `test/fixtures/`.** Fine for
   local cross-validation, but gate them on fixture presence with
   `skipIf` and never commit the fixtures themselves. Mesen captures are
   found through `MESEN_FIXTURES_DIR` in
   `test/suite/unit/fixtures/loadMesenFixture.ts`; a gate on an env var
   nothing sets is a permanently dark test, not a gated one.

When in doubt, ask on the PR whether the test has any ROM-derived bytes
in it.

`lintGate.test.ts` creates and deletes files under `test/suite/gates/__fixtures__`
while other workers run, so any walker over `test/` must skip that directory
(#754). The three walkers that do: `sourceFiles` in `controlBytesGate.test.ts`,
`testFiles` in `testRegistrationGate.test.ts`, and `walk` in
`perfConfigSeparation.test.ts`.

## Proving an oracle can fail

A test that cannot go red is worse than no test, because it reports
confidence it has not earned. Every gate, refusal and bounds check gets a
planted defect run against it, and the result is recorded here so a later
reader can re-run it rather than take the comment's word.

How to run one: change the single line the defect targets, run only that
file's suite, confirm the expected number of failures, revert. Anchor on a
single line - these files use CRLF, so a multi-line search string will not
match and the "mutation" silently becomes a no-op that looks like a pass.

Three of the entries below were added only after a first pass showed the
test could not fail. That is the point of doing it.

### `src/rom/L2UploaderTable.ts` - L2 uploader by level mode

Run against `L2UploaderTable.test.ts` and `MapScreenL2.test.ts`; one
line changed per row, synthetic ROMs, no corpus needed. Command:
`npx vitest run test/suite/unit/L2UploaderTable.test.ts test/suite/unit/MapScreenL2.test.ts`.
With the corpus: 2 files passed, 62 tests passed, 0 skipped. With
`HACKBENCH_ROMS` pointing at an empty directory: 2 files passed, 52 tests
passed, 10 skipped. Measured 2026-10-11, one machine, after the develop
merge. These are the counts for these two files only; the full `test:unit`
counts are reported in the PR.

| Planted defect                                    | Tests red |
| ------------------------------------------------- | --------- |
| Drop `REP #$30` from the caller pattern           | 11        |
| Cache the table without the ROM version           | 1         |
| Wildcard the `SEP` opcode of the dispatch         | 2         |
| Drop the ExecutePtrLong gate                      | 1         |
| Drop the "no pointer table after it" refusal      | 1         |
| Classify an unknown target as objects             | 4         |
| `buildL2Inputs`: drop the "uploads no L2" refusal | 1         |
| `buildL2Inputs`: drop the pointer-bank check      | 3         |
| `buildL2Inputs`: mask the mode with `$0F`         | 1         |

### `src/rom/MusicData.ts` - level music table

| Planted defect                                                  | Files red |
| --------------------------------------------------------------- | --------- |
| Hardcode the table address instead of reading the LDA.L operand | 2         |
| Take the first of several matching sites                        | 1         |
| Fall back to the stock address when no site is found            | 1         |
| Drop the out-of-range refusal                                   | 1         |
| Read nine bytes rather than eight                               | 4         |
| Wildcard the `AND #$07` mask                                    | 1         |
| Wildcard the `LDA.L` opcode                                     | 1         |
| Read the operand one byte early                                 | 4         |

### `src/rom/MusicData.ts` - map attribution

| Planted defect                                         | Files red |
| ------------------------------------------------------ | --------- |
| Count filler slots                                     | 5         |
| Drop the shift, bucketing maps by sprite set           | 6         |
| Read header byte 1 instead of byte 2                   | 6         |
| Mask the music index to 2 bits                         | 2         |
| Overwrite rather than merge two slots onto one command | 1         |
| Fall back to the ungated table                         | 1         |
| Emit command buckets with no maps in them              | 1         |

### `src/rom/SpcBuilder.ts` - overworld and credits path gates

| Planted defect                                    | Files red |
| ------------------------------------------------- | --------- |
| Fall back to the ungated stock address            | 6         |
| Skip the JSR opcode check at the call site        | 1         |
| Skip the routine shape check                      | 4         |
| Ignore the STA operand targets                    | 1         |
| Read the callee operand one byte late             | 2         |
| Take the callee's bank from a constant            | 1         |
| Point the credits gate at the overworld call site | 3         |
| Remove the BNE hop from the level gate            | 2         |

One assertion in `SpcBuilderBankGates.test.ts` is NOT in this list: the
sub-`$8000` callee case characterises `loromToOffset` (addressing.ts:51)
rather than anything in `SpcBuilder.ts`, and no defect planted in
`SpcBuilder.ts` turns it red. It is marked as such in the file. It does go
red when `loromToOffset` stops refusing, which was confirmed separately.

### `src/rom/MusicCatalog.ts`

| Planted defect                                       | Files red |
| ---------------------------------------------------- | --------- |
| Always use the level bank's locator                  | 5         |
| Omit the call site from a refusal                    | 3         |
| Include the command itself in `sharedWith`           | 1         |
| Attribute every bank rather than only the level bank | 1         |
| Read the level music table for every bank            | 1         |
| Drop the attribution-unavailable reason              | 1         |
| Take `blockSize` from the pointer count              | 1         |

### `src/project/Aliases.ts`

| Planted defect                              | Files red |
| ------------------------------------------- | --------- |
| Drop the two-digit key padding              | 10        |
| Truncate ids to one byte                    | 1         |
| Lowercase the keys                          | 3         |
| Collapse the namespaces into one table      | 2         |
| Keep non-string values                      | 1         |
| Drop the length cap                         | 1         |
| Drop the trim                               | 2         |
| Keep control characters                     | 1         |
| Leave an emptied namespace as `{}`          | 1         |
| Rewrite the manifest from known fields only | 1         |
| Skip the `openProject` refusal              | 1         |
| Delete only the canonical spelling of a key | 2         |

### Map16 tile editor - the write gate, the palettes and the preview tabs

Run with the corpus ABSENT and the `theia/` workspace absent, which is
what CI has. Every case below registers and runs in that state except where
noted, which is the point: an earlier version of the write-path suite
imported `Map16ServiceImpl`, could not resolve
`@theia/core/shared/inversify`, and none of its cases ever ran in CI while
passing locally.

One machine, vitest 4.1.5. Thirteen planted defects, each reverted after
the run:

| Planted defect                                                            | Cases red |
| ------------------------------------------------------------------------- | --------- |
| Gate the BG extent on the FG fill-loop count again                        | 3         |
| Let `nextQuadrantWord` truncate an out-of-range value instead of refusing | 3         |
| Remove the write-path capacity gate                                       | 4         |
| Take `maxColorIndex` across all sheets rather than per sheet              | 1         |
| Make `tileFrameCount` ignore `animatedTileIds`                            | 1         |
| Feed the character palettes raw VRAM instead of animation frame 0         | 2 *       |
| Make `PreviewSequence.settled` return without waiting                     | 2         |
| Drop the RPC value type check, so a boolean writes character 1            | 2         |
| Drop the tilemap-space bound from the RPC gate                            | 1         |
| Drop the tileset validation from the RPC gate                             | 1         |
| Remove the per-slot character clamp                                       | 2         |
| Make the clamp return the slot CAPACITY, so a short sheet over-offers     | 2         |
| Take the edit axis from the picker rather than the sheet on screen        | 2         |

`*` This one is the exception to the corpus-absent rule: both cases that
catch it are `describe.skipIf(!romPresent)`, so with no cartridge the
mutation runs GREEN. That is stated rather than hidden. The claim is that
the atlas and the character palettes composite from the same VRAM, which is
a fact about a CALL SITE in `decodeMap16Sheet` rather than about any one
function, so no synthetic fixture reaches it; the alternative was a
source-text tripwire, which fails on a rename and passes on a respelling.
It is proven wherever a cartridge exists, and the figure it asserts (75 of
80 animated characters differing on vanilla tileset 0) is a tripwire on the
fixture itself.

A fourteenth is planted by the Playwright suite itself rather than by hand.
`map16-view.spec.cjs`'s hover-reflow oracle adds a hover rule that changes
`padding` instead of painting, confirms the same comparison catches it, and
removes the rule again. It is inline because the first version of that
oracle measured viewport coordinates and so fired on a SCROLL while saying
nothing about a reflow: an oracle that can only be trusted after someone
remembers to plant a defect by hand is one that goes untrusted.

Two of these exist because the first pass showed no test could fail. The
palette/VRAM one, because nothing compared a palette cell against the
quadrant citing it. And the edit-axis one, which began as a source-text
tripwire on the reasoning that `Map16ViewWidget` extends `ReactWidget` and
cannot be constructed in node: true, and beside the point, because the
DECISION is a pure function of the sheet and the picker. Extracting it as
`editAxisFor` turned an untestable coupling into five ordinary cases, the
same move `previewId` and `gateQuadrantWrite` made. A grep over source text
passes when the bug returns under a different spelling and fails on an
innocent rename, which is the wrong failure mode twice over.

### `eslint.config.mjs` - cloudevents is imported for types only

Run against `test/suite/gates/lintGate.test.ts` (21 cases): one line of the
rule disabled at a time, expecting the cases that need it to go red.

| Planted defect                                        | Cases red |
| ----------------------------------------------------- | --------- |
| `paths` entry for `cloudevents` renamed               | 1         |
| `patterns` entry `cloudevents/*` renamed              | 1         |
| `ImportExpression` selector (string literal) disabled | 2         |
| `ImportExpression` template-literal selector disabled | 1         |
| `require()` selector (string literal) disabled        | 1         |
| `require()` template-literal selector disabled        | 1         |
| `module.require()` selector (string literal) disabled | 1         |
| `module.require()` template-literal selector disabled | 1         |

## Viewing Mesen per-map captures

The Mesen capture harness (`en-gen/hackbench-validation`, under
`capture/`) writes one capture per map, usually as a zip per map
(`001.zip` holding `001/...`). `capture:render` turns a folder of them,
zips or extracted folders alike, into one HTML page per map plus an index:

```bash
npm run capture:render -- <captures-dir> <out-dir>
```

Both arguments are required; nothing defaults to OneDrive, a temp folder
or the repo, and relative paths are taken from where you ran npm. The
captures folder is only read. The pages embed ROM-derived bytes, so
`<out-dir>` is refused when it is inside the repo, or is, contains or
lies inside the captures folder.

The sprite grader has two tiers against these captures. Tier 1
(`spriteGrade.ts`) grades OAM shape relative to the sprite. Tier 2
(`spritePosition.ts`, `SpritePosition.test.ts`, #830) grades where the
pieces sit on the map: the capture's drawing at `drawnFrame` (the first frame
with every tile complete, not the first OAM write) against the model's pass
`drawnFrame - firstRealFrame`, counted from the model's pass 0 (the first
MAIN after INIT, as the capture's `firstRealFrame` is), so `chosen` is not
added; the lag is 1 to 116 frames over the 1957 graded records. Both sides
are placed with the capture camera; the model is seeded with the camera at
`drawnFrame`. Positions are compared in map coordinates. Graded captures never
set X bit 8; the 9-bit X is synthetic-only coverage. It reports exact, off,
missing (one side drew nothing once parked pieces are dropped, the other drew
on screen, or the record lacks `drawnFrame` or `firstRealFrame`), parked (both
sides drew only parked pieces, at matching positions: agreement), late (the
model had not drawn yet at the target pass, the capture had), lagged (target
pass past the pass count, drew or not) and refused, per sprite and per id
(`SPRITE_POSITION_OUT=<file>` dumps the records), and holds a bound per verdict
with 1% headroom (vanilla, one machine, 2026-10-10 measured: 1366 exact, 469
off, 23 missing, 18 parked, 1 late, 80 lagged, 0 refused of 1957). All 80
lagged records are captures whose first draw came 31 to 89 frames after the
first MAIN (likely the level fade-in, not traced); it is not re-aligned to the
first draw.

A map's result comes from its Foreground, Background and Effects checks;
Sprites are informational and never decide it. Exit codes:

- 0: every map is `pass` or `weak`. `weak` means every check matched, but
  the map's tiles were too uniform for the Foreground check to catch every
  misplacement it tries (a shifted or re-strided grid would also have
  matched); Checks names which.
- 1: at least one map is `fail`: a map check or a drawing-code check
  differs.
- 2: nothing failed, but at least one map is `unavailable` (its capture
  could not be read or was refused) or `incomplete` (one of its deciding
  checks compared nothing, or its Background was refused). The index
  gives the reason per map.

To view, serve the output folder and open the index:

```bash
cd <out-dir> && python -m http.server 8000   # then http://localhost:8000/
```

Each map page draws Foreground, Background, Effects and Sprites from
load-time data, with a hover readout and a Checks section: map data
against the SNES tilemap (the BG1 oracle), and our drawing code against
Mesen's per-layer pictures. The code is `tools/scripts/render_capture.ts`
and `capture_render.ts`; its tests are `test/suite/unit/Capture*.test.ts`,
synthetic only. The evidence behind the checks is in
[capture-viewer.md](capture-viewer.md).

### The L1 (foreground) data gate

`tools/scripts/capture_gate.ts` (en-gen/hackbench#205) builds the Map16
grid, defs, per-strip pipe sets, L1 chars and palette from the ROM's
working copy and checks each byte for byte against a `layers_v5` capture,
over the committed 143-map roster (`tools/scripts/fgGateMaps.ts`). It reads
captures the same `<captures-dir>/<map>` or `<map>.zip` way
`capture:render` does, from a **second, separate directory variable**:

```
HACKBENCH_CAPTURES
```

Set it to the `layers_v5` capture folder (an explicit override, unchecked,
same shape as `HACKBENCH_ROMS`); without it, `test/suite/support/corpus.cjs`
falls back to `<tools root>/captures/layers_v5`. If the ROM is present but
this resolves to nothing, `CaptureGate.corpus.test.ts` prints one console
warning naming the variable and skips - a captures folder kept outside the
tools root (OneDrive, say) needs the variable set explicitly, same as a ROM
corpus kept somewhere other than `hackbench-tools/roms`.

```bash
npm run capture:gate -- [captures-dir] [--maps 105,1bd] [--rom <path>] [--known <file>]
```

Without `[captures-dir]`, uses the resolved `HACKBENCH_CAPTURES` location.
`--known test/suite/unit/fixtures/fgKnownFailures.json` makes a map whose
mismatches match that fixture's committed count and hash, table for table,
exit 0 instead of 1 - the shape a nightly job needs, since the roster is
not fully clean (three filed HackBench defects, not this gate's to fix, are
tracked in the fixture by issue number).

Pipes are the one exception handled inside the gate rather than the known-
failure fixture: `checkPipes` allows exactly the vanilla #571 pipe-color
bug (bank_05.asm:103,110-143,899-929,931-945), reporting it as a per-map
`allowed: {rule, count}` entry rather than a mismatch, so 0 pipe mismatches
is the expected result across the whole roster. The load's own first build
of its first strip splits by orientation, both read from the ROM and never
hardcoded: a HORIZONTAL level runs bank_05.asm:907-909's pick (X =
`Layer1ScrollDir`, a word index into `Layer1TileUp`/`TileDown`), allowed
only for f(s0) itself (not an exemption) or f(s0+$1F) (exempt) - any other
value is a mismatch; a VERTICAL level never runs that pick at all
(bank_05.asm:889-891 branches away first, since `ScreenMode` comes from
`VerticalTable`), so its s0 keeps CODE_0581FB's own compiled Map16 default
for $133-$13A instead, exempt only when that default differs from f(s0). A
capture whose first 32 chronological builds are not exactly s0..s0+$1F
cannot be judged by either rule and is reported as a `load-pass` mismatch
directly.

## Sweeping the hack store

`tools/scripts/hack-sweep.ts` runs the readers behind each view (map tree,
map details for every real map, overworld, graphics, Map16, palettes, music,
SFX) over every patched ROM in the hack store, and records `ok`, `unavailable`
with every failing gate it can see, or `crash` with the error and its top
frame. The summary ranks each gate by how many hacks it alone blocks. It also
applies each patch to vanilla (`applyBps`, or `decodeIps` for IPS) and compares
the SHA-256 with the store's index.

```bash
npx tsx tools/scripts/hack-sweep.ts
```

`HACKBENCH_HACKS` names the store (default `C:/Projects/hackbench-tools/hacks`),
which the sweep only reads. `HACKBENCH_SWEEP_OUT` names the output directory
(default `C:/Projects/hackbench-tools/sweep`), which gets `results.json` and
`summary.md`. Both hold hashes, ids, names, verdicts and counts. A reason may
quote one instruction's bytes; any longer run is elided. Neither file is
committed. The sweep is hand-run, since CI has no store; its verdict and
summary code is tested in `HackSweep.synthetic.test.ts`.

Each run covers `HACKBENCH_SWEEP_BATCH` hacks (default 50, a positive integer),
taken in id order from the cursor and wrapping at the end, so repeated runs
rotate through the store. The cursor is the next smwc_id, not a position, so
adding or removing a hack does not skip or repeat another. `results.json` holds
`{ cursor, records }`; it is read and checked before any sweeping (a truncated
file stops the run with a message and nothing is overwritten), the previous one
is copied to `results.prev.json`, and every file is written through a temp file
and a rename, `results.json` last, so a killed run leaves the old state and the
next run repeats the batch. `tracking-issue.md` is written beside the summary:
new and cleared crashes, verdict changes, works-on % and blocker-rank moves for
hacks swept this run, the hacks added, and the hacks removed from the store.
Records for hacks outside the batch that are still in the store are carried
forward with `carried: true`, so `summary.md` covers the whole store and says
how many records are fresh; a carried record is never reported as changed, and
a record for a hack no longer in the store is dropped. A bare-array
`results.json` from before the cursor is read as a cursor of 0 and converted
on the next write. Evidence scope for all of the above: 51 synthetic-fixture
cases in `HackSweep.synthetic.test.ts` and `HackSweepRun.synthetic.test.ts`
(in-memory and temp-directory stores, none skipped), including a planted
mid-run death and a failing earlier write; not yet observed on a run against
the real hack store.

## Unit tests cannot reach an authenticated gh

`test/suite/support/noRealGh.ts` is a vitest `globalSetup` (#486: a test ran
`accept.sh` and posted real perf-nightly statuses). It puts a failing `gh` shim
first on PATH, sets the four GitHub token variables to a sentinel, points
`GH_CONFIG_DIR` at an empty directory, empties `GIT_ASKPASS`/`SSH_ASKPASS`, and
resets `credential.helper` through both `GIT_CONFIG_*` and
`GIT_CONFIG_PARAMETERS` (what `git -c` exports to children). A reached `gh` or
`git credential fill` then sees only a token GitHub rejects.

Every vitest config in the repo must register it in `globalSetup`;
`perfConfigSeparation.test.ts` finds the configs by glob and fails on a miss.
`perfAccept.test.ts` also refuses to run when the guard is not active.

Known limits, stated as such:

- A test that blanks or deletes the token variables, or builds an env without
  spreading `process.env`, is outside the guard.
- On Windows a test that spawns `gh` without a shell skips the shims and runs
  the real gh.exe. The sentinel token keeps it unauthenticated, except that
  `gh auth token --user <login>` reads that account's token from Windows
  Credential Manager. A test can only reach it by naming the account
  deliberately, so the guard does not block it.
- `assertGuardActive` is satisfied by reusing a leftover `hb-nogh-*` dir and
  setting the sentinel by hand. `accept.sh` still cannot post in that state,
  because the shim `gh` it reaches always fails.

## Playwright never touches your app data

Specs create projects, which writes `recent-projects.json`, `rom-registry.json`
and `core-registry.json` in per-machine app data (`src/project/appData.ts`:
`APPDATA` on Windows, `XDG_DATA_HOME` on Linux). `playwright.config.cjs` points
both at a per-run folder under the OS temp dir before any spec loads, which
every process it starts inherits, and deletes it when the run exits. It never
reuses a server already on its port, since that
server's app data is unknown.

The same folder holds the run's Theia config dir. The backend keeps user
`settings.json`, `recentworkspace.json`, `backend-settings.json`,
`workspace-metadata/` and untitled `workspaces/` in `THEIA_CONFIG_DIR`, else
`~/.theia`, so the config sets `THEIA_CONFIG_DIR`, overriding any value
already exported. The saved layout is not there: the
browser app keeps it in `localStorage`, and each Playwright test gets a fresh
browser context, so no spec inherits or changes the user's layout.

The only supported way to run specs against a server you start yourself is
`start-test-server.cjs`. It gives the server its own app data and
`THEIA_CONFIG_DIR` under the temp dir, marks that folder with the port, and
prints the two variables to export:

```bash
cd theia/browser-app
node test/start-test-server.cjs 3457 &   # or `yarn test:server`; no port picks a free one
export HB_APP_URL=http://127.0.0.1:3457 HB_TEST_APPDATA=<printed folder>
npx playwright test new-project
```

With `HB_APP_URL` set, the config refuses to load unless `HB_TEST_APPDATA`
holds that marker for the same port. That proves the pairing, not the
server's environment: a server started any other way and handed a copied
marker still writes wherever its own `APPDATA` points. The config also
refuses an `HB_TEST_APPDATA` that no Playwright run created, and any folder
outside the temp dir. macOS is refused outright, because `appData.ts`
ignores the environment there. Each run also deletes `hb-appdata-*` and
`hb-testserver-*` folders in the temp dir untouched for over a day, which a
crashed run or server left behind.

`test/suite/gates/playwrightAppDataGate.test.ts` checks, without a ROM: the
config's folder is where the registries resolve; the webServer (through
Playwright's env merge), `own-backend.cjs` and `start-test-server.cjs` spawn
options hand it, and `THEIA_CONFIG_DIR` inside it, to a child process, even
when the user already exported one; Theia's own resolution agrees (CI's
`theia-typecheck` job runs the gate with `HB_REQUIRE_THEIA=1`, so a missing
Theia install fails there instead of skipping); `reuseExistingServer` is
false; each refusal fires; stale folders are swept and nothing else; a real
`recent-projects.json` edited during a run comes out holding that edit. It
plants a non-isolating harness and a snapshot/restore harness to show that
last check can fail. It does not start a server.

- `npm run typecheck:theia` and its gate: see [theia-shell.md](architecture/theia-shell.md) (#669).

### Corpus sweeps (`npm run test:corpus`)

Sweeps that run an interpreter over every ROM in the hack corpus take minutes, not seconds: the #653 leaf sweep (`L1Interpret.leafSweep.nightly.test.ts`) is about ten minutes (546 s for its six tests in one run, one machine, run lock held, 2026-10-10, per the PR #822 body). The `*.nightly.test.ts` name keeps them out of `npm run test:unit`; `vitest.corpus.config.ts` runs them, and the nightly runner is meant to call `npm run test:corpus`, but it is not wired yet: its owner must add that command. There is no opt-in variable. The leaf sweep registers one case per corpus name and runs a case only when both that ROM and the vanilla ROM are present; otherwise that case skips (`describe.skipIf(!hasRom(name) || !hasRom(VANILLA))`), so it is per case, not all-or-nothing, and a run that reports zero skipped has the whole corpus. Set `LEAF_SWEEP_OUT=<dir>` to also write one table per ROM. Take the run lock before a full run (ownership rule), as for `test:unit`. CI has no ROMs and does not run it; the synthetic grouping tests stay in `test:unit`. Evidence scope: split of #653 Stage A, 2026-10-10 (owner ruling D8 C).

### Timing gates (`npm run test:timing`)

Two tests judge wall-clock time and flake when another vitest file runs beside them: `perfPairedE2E.timing.test.ts` and `perfSampler.timing.test.ts` (#668, #537). The `*.timing.test.ts` name keeps them out of `npm run test:unit`; `vitest.timing.config.ts` runs them one file at a time, and CI runs them as a step after the unit tests. Run `test:timing` alone, never beside another vitest run, and after any change under `tools/perf/`. `npx vitest run <timing file>` under the default config finds nothing; use `npm run test:timing -- <filter>`. Even serially they can fail on a machine already loaded by other work.

## Commands

```bash
npm run lint           # ESLint on src/
npm run test:unit      # Vitest, single run
npm run test:unit -- --coverage    # + v8 coverage
npx vitest run test/suite/unit/LcLz2.synthetic.test.ts   # one file
```

`test/suite/unit/romMapBoundaries.test.ts` (synthetic ROMs, `docs/mockups/rom-map.html` parser run in a vm) and `demoCaption.test.ts` (`OVERLAY` from `demo.cjs`, fake DOM) were each shown red on a planted defect, one machine: walking before the dedupe lookup (3 of 3 rom-map tests fail), the work-cap check placed before the repeat-pointer lookup (1 of 3), the work-cap check removed (2 of 3), and `innerHTML` restored in the caption (1 of 1).

## Perf gates

Settled by the owner 2026-09-28; design calls delegated to the orchestrator. Spec: `superpowers/specs/2026-09-28-perf-gates-design.md`.

- Nightly paired benchmarks on GitHub-hosted runners, baseline and candidate in one job, every other night. `[EST]`
- Measures core microbenchmarks, app timings, startup and heap; not emulator fps. `[EST]`
- A local scheduled Claude session fixes regressions, with a PR under normal merge rules. `[EST]`
- An intended cost is proposed through `accept.sh`; only the owner runs it. `[EST]`
- Rules in the spec: the base advances only on an unflagged run; `perf-nightly-infra` for no-verdict runs; a plant run is green only when detected. `[EST]`
- Issues: #413 core/detector, #414 app marks/specs, #415 `perf-nightly.yml` in hackbench-validation, #416 scheduled fixer and docs. #415 waits for the self-hosted runner. `[EST]`
- Status as of 2026-09-29: the owner paused; #424 and PR #430 (#414) merged since. Re-check #415 (hackbench-validation PR 24) and #416 before assuming progress. `[OPEN]`
- Known flakes #438, #443; leak #429. Numbers before 2026-09-27 are archive numbers; verify. `[OPEN]`
- Guard against forged statuses: unit tests once reached the real authenticated `gh` and posted forged `perf-nightly` success statuses on develop. PR #539 (merged 2026-10-04) added the vitest globalSetup guard `test/suite/support/noRealGh.ts`; the suite no longer needs `--exclude perfAccept.test.ts`. `[EST]`
- Statuses cannot be deleted, only superseded with `error`. A forged success is indistinguishable from a real `accept.sh` accept until #538 adds a marker. `[OPEN]`
- A stray `perf-nightly` success: compare its description with the unit-test strings ("a reason", "a valid reason", "an intended cost") before trusting it. `[EST]`
- Never print a gh credential in test output; assert with booleans.

## Playwright and RPC

- Assigning a wrapper over a Theia JSON-RPC proxy method in the page (for example `svc.mapCollision = wrapped`) never fires for the widget's own calls: the proxy builds a fresh function per property access. `[EST]` develop 00911ba2, 2026-10-07, #691.
- Effect: `map-collision.spec.cjs` "toggle off probes nothing" passed its `toBe(0)` vacuously; the late-reply race case timed out waiting on the wrapper. `[EST]`
- Rule: a spec that counts RPC calls needs a counter the app exposes (a widget data attribute or a server-side counter) or websocket frame inspection, and must prove the counter rises on a known call. `[PROP]`
- Counting RPC calls from websocket frames (`page.on('websocket')`, `framesent`): a msgpack fixstr is the byte `0xa0 + length` followed by the name, so match that byte before the name or `mapCollision` is found inside `mapCollisionCheck`. Strings are not bundled (`bundleStrings: false`, @theia/core 1.75.0 `rpc-message-encoder.js:47`). Prove the counter rises on a known call before trusting a zero. Blind spot: socket.io starts on HTTP long-polling (`ws-connection-source.js:180` passes no `transports`), so a call sent before the upgrade to websocket is not a `framesent`; wait for a binary `framesent` (RPC; the upgrade probe is text) before trusting the counter. `[EST]` Theia 1.75, one machine, #706.
- Timing a widget race: replace the service PROPERTY on the widget (`w.projects = new Proxy(real, ...)`) with a stub whose reply is a promise you control, then in ONE `page.evaluate` click the control and release the reply. The continuation is a microtask and runs before React's commit task, so the reply lands on the old layout. Assert that precondition in the same evaluate (the `data-rendered-zoom` attribute still old). Trap: Lumino's update request is also a microtask, queued at the click and drained first, so the widget's `renderedZoom` FIELD is already the new zoom while replies run; read the `data-rendered-zoom` attribute (written at commit), never the field. Poll until every pending request has its reply parked (`pending.size > 0 && parked === pending.size`) before the click. `[EST]` verified at 24496d01, Maps zoom anchor (#547), one machine, React 19.3.

## Sprite report

`npm run sprite:report` (#828) grades each sprite in the `layers_v5` captures
with id `$00`-`$C8` and at least one recorded frame with tiles (zips without
`sprite_spawns.json` are skipped) with the grader behind `spriteGrade.captures.test.ts` and commits a report to
the private `hackbench-validation` repo at `reports/sprites/<hackbench sha>/`
plus a copy at `reports/sprites/latest/`. One page per verdict (exact, shape,
close, wrong, empty, refused), an index by sprite id, our frame beside the
hardware (Mesen) frame, and an unticked `- [ ] corrupted` box per row. The
frames are ROM graphics, so the report never goes in this repo; the script
refuses any output path inside the checkout and never pushes.

```bash
npm run sprite:report                                        # commit to the sibling hackbench-validation
npm run sprite:report -- --validation <dir>                  # or HACKBENCH_VALIDATION
npm run sprite:report -- --out <dir> --no-commit             # same tree, nothing committed
npm run sprite:report -- --sheet --map 105 --out <dir>       # one contact-sheet PNG (or --sprite 1b)
```

ROM and captures come from `corpus.ts` (`HACKBENCH_ROMS`, `HACKBENCH_CAPTURES`);
a missing one exits non-zero naming it. The hardware side shows the recorded
frame the grader scores best against our chosen pass (`grade` against each
frame singly, ties to the first), drawn in OAM index order recovered from the
record's `entries` (the capture sorts each frame's tiles as JSON text, so its
list is not OAM order). The hardware order is exact except on rows labeled
"hardware overlap order unknown": there the entries did not fit the frame and
it is drawn in the capture's order. Both sides are drawn from the capture's own
VRAM and palette, so a difference is in the pieces. Graphics come from the
level-start sample, except on a dynamic card (#863): its sprite id uploads
changing graphics ($33 SMWDisX bank_01.asm:13192, $35 bank_01.asm:14879; `DYNAMIC_SPRITES`) or its tiles read different VRAM
in different samples. That card draws from the sample whose frame
(`anchorFrame + offset`) equals the record's `drawnFrame`; with none it keeps
level start and the row says "graphics at level start, may differ". Both panels of that card use the same sample, so the sentence above holds; the pixel positions, not only the colours, decide whether tiles differ. A dirty tree writes
`<sha>-dirty/`. Tick the checkboxes in the `<sha>/` folder: `latest/` is
regenerated every run, and a run refuses to replace a `<sha>/` that has a
ticked box, or with uncommitted edits or extra files, unless `--force`. Only
`reports/sprites/<key>` and `latest` are staged and committed; a failed step
(the copy, `git add`, `git status` or `git commit`) is undone (both folders restored) and exits
non-zero, naming the step (`git add -f`, so a repo that ignores `*.png` still commits the frame images); the message says "undone" only when every undo step succeeded. The commit target must have a remote URL ending in `hackbench-validation`.
The target, and any `--out` or `--sheet` path, is refused when it shares a git
store with the hackbench checkout (a worktree of it included) or any of its
remote URLs (a fork too, a local clone path included) ends in `hackbench`. An `--out` on a drive or share that
does not exist exits 2. Sheet borders: exact green, shape lime, close yellow, wrong
red, empty and refused grey. The loop in `spriteReportRun.ts` mirrors `gradeAll`, which is
private to the test file.

## The validation repository

- `en-gen/hackbench-validation` is private and holds the Playwright e2e workflow (`e2e-playwright.yml`; builds the Theia browser shell and runs `theia/browser-app/test` against the requested ref, manually or via hackbench's manual-only `e2e-dispatch.yml`), the nightly run, the perf nightly (#415) and the Mesen per-graphics-layer capture harness (`capture/`). `[EST]`
- map-diff was deleted 2026-09-25. `[EST]`
- The CI secrets live there; `en-gen` is a Free org, so secrets are duplicated per repo. The ROM is pulled from OneDrive at run time. `[EST]`
- `MAX_SKIPPED` gates on the known skips (emulator-view needs the core, gfx-view needs Invictus, music-view needs GPW2). Measured 8 on 2026-09-22; the emulator spec has since grown from 5 to 21 tests, so re-measure. `[OPEN]`
- The libretro core is `snes9x_libretro.{js,wasm}` in the `hackbench-cores` checkout, outside every worktree. The app records its location in `core-registry.json` under the app data directory; read that first. `[EST]`
- Run emulator specs from any worktree with `HB_CORE_JS` set to the core's `.js` path; without it the suite skips when the core is also missing from the fallback path (see below), and CI has no core and skips too. `[EST]`
- `HB_CORE_JS` is the absolute path to `snes9x_libretro.js` (its `.wasm` must sit beside it). `emulator-view` and `emulator-gamepad` read it; unset, they fall back to the documented path (`vendor/cores/snes9x-wasm/` inside the worktree) and skip only if the core is missing there too, which in a worktree it usually is; a skipped run still exits 0. Set it, e.g. `HB_CORE_JS=C:/Projects/hackbench-cores/snes9x-wasm/snes9x_libretro.js`, and check the run reports passed, not skipped. `[EST]`
- Nightly cost is why e2e is not per-PR. `[EST]`

## ROM-window probe

`node tools/scripts/rom-window-probe.mjs` reports 8-byte windows of text or
assembled bytes that also occur in the vanilla ROM, so a synthetic ROM,
fixture or detection pattern can be checked before pushing. It is
report-only and local-only: no hook, CI job or `check-content.mjs` runs it,
and CI has no ROM to run it against.

```
node tools/scripts/rom-window-probe.mjs <files...>        text scan (PARTIAL, below)
node tools/scripts/rom-window-probe.mjs --git-range <spec> files the range touches
node tools/scripts/rom-window-probe.mjs --bin <files...>  assembled bytes
```

`--rom <file>` skips the lookup. `--repo <dir>` names the repo `--git-range`
diffs; the ROM lookup always uses the checkout the script lives in, as
`test/suite/support/corpus.cjs` does. `--git-range` takes `a..b` (post-image
`b`), `a...b` (from `merge-base(a,b)`) or one rev (that rev against the
WORKTREE, so uncommitted edits count, and untracked files are scanned whole). It
scans each touched text file whole and keeps runs that overlap an added line;
binary files go through the bytes check; deleted lines and deleted files are
never scanned, but a touched file whose post-image cannot be read is an error.

**The text scan is partial.** It reads `0x..`, `$..`, bare two-digit hex and
decimal 0-255 tokens, with comments blanked: `//` and block comments in
JS/TS files, `;` in `.asm`/`.inc`/`.s` files, nothing in any other file
type (no Lua `--`, no markdown). Quoted strings are skipped when blanking, so
`'http://x'` hides nothing. It does not see 16-bit words, hex strings,
quoted-byte arrays, per-byte writes (`buf[a] = 0xa9`), split strings, or values
behind `as number`. Comment blanking can desync on a regex literal with an escaped slash or an
unterminated backtick, and `.c`/`.h` files get none. A comma-separated list of bare hex pairs (also in asm, e.g. `.db a9, 10, 85`), or a
space-separated decimal list, is not read reliably (a two-digit number beside
a comma is taken as decimal, otherwise as hex). Wildcard bytes (a fingerprint's
zeroed operands) split runs on purpose, so a pattern with wildcards is checked
per fixed stretch. **`--bin` on the assembled bytes is the authoritative
check:** have the fixture builder write its bytes to a scratch file
(`writeFileSync(scratch, builder())`), then run
`rom-window-probe.mjs --bin <scratch>`.

Windows with fewer than 3 distinct values are ignored (they match any ROM):
43,597 of 524,281 positions and 2,982 of 442,994 distinct windows in the
vanilla ROM (one machine). A 512-byte copier header is stripped, so no window
straddles it. Output is `HIT path:line windows=N` (`offset=0x..` for bytes) and
a `TOTAL` line, never ROM bytes. Exit codes: 0 no hit, 1 a hit, 2 nothing was
checked (no input, no ROM found, a missing `--rom` file, a git or file error;
HIT lines found before an error are still printed, the message goes to stderr
and starts `SKIP:` when no ROM exists). Exit 2 on a missing ROM is deliberate:
"probe exit 0" is cited as proof, so a run that checked nothing must not exit 0.

`bytesHits` in `tools/scripts/lib/rom-windows.mjs` is the shared in-memory
finder. The assembled-ROM tests (`SyntheticEeriesNoVanilla` and the like) and
`test/suite/support/romWindows.ts` can adopt it; that is a follow-up for their
owners.

## Run lock

Full unit runs, Theia builds and Playwright runs share a counting semaphore
of 3 lock slots, so at most 3 overlap (timeouts in #485, #771). ("Slot" in
the glossary is a ROM pointer-table index; a lock slot is a different thing.) A lock slot is
a directory under `<main checkout>/.hackbench-state/locks/`: `run` (lock
slot 1, the original single lock, so an older script's lock is slot 1),
`run-2` and `run-3`. Worktrees resolve the main checkout through git, and
`HACKBENCH_STATE_DIR` overrides it. `HACKBENCH_RUN_SLOTS` sets how many lock
slots `acquire` may create (a positive integer; anything else falls back to
3). `status`, `release` and the one-per-team check always look at every
`run` and `run-N` directory on disk, whatever the count.

```bash
MAIN_CHECKOUT="/absolute/path/to/main/checkout"
node "$MAIN_CHECKOUT/tools/scripts/run-lock.mjs" acquire --owner "<team> <worktree>" --purpose "<text>"
node "$MAIN_CHECKOUT/tools/scripts/run-lock.mjs" status
node "$MAIN_CHECKOUT/tools/scripts/run-lock.mjs" release --owner "<team> <worktree>"
```

- Always run the script from the main checkout, as above. A worktree's copy
  from before this change cannot see `run-2` and `run-3`, and would treat
  `run` as the only lock.
- Raw equivalent: `mkdir locks` then a non-recursive `mkdir` of the first
  free lock slot dir (atomic; failure means held), then write its
  `owner.txt`.
- `acquire` takes the first free lock slot and prints
  `acquired slot N by <owner>`. All held is a refusal that lists the holders.
- One lock slot per team. `acquire` is refused while any lock slot's `owner:`
  names the same team (the leading letters of the first word, lowercased, so
  `xray-909` and `xray C:/wt/b` are one team), which includes the exact same
  owner string. A lock slot with no parseable `owner:` line names no team and
  does not block. Two simultaneous acquires from one team are caught by a
  re-check after `owner.txt` is written: the one that sees the other removes
  only its own lock slot and says to retry (both may back out).
- Ports. Playwright picks a free port itself, so concurrent runs do not
  share a fixed port (best effort: the port is free when picked, not reserved
  until Theia binds it). `playwright.config.cjs` finds free ports for the app server,
  `HB_RECONNECT_PORT` and `HB_MULTIWINDOW_PORT` at startup and writes them to
  `process.env`, which its workers inherit (checked: a worker reloads the
  config and sees the same values). Set `HB_PORT` (an integer 1-65535; the
  config refuses anything else) only to force a fixed port. The `start`
  script of `theia/browser-app` stays on 3000 for servers started by hand.
  Env you set does not persist across agent tool calls, so prefix the command
  you run it with, not a separate step.
- Vitest workers. `vitest.config.ts` uses
  `max(1, floor(cores / 2 / slots))` (5 on a 32-thread machine with 3),
  so 3 full runs together use about the half of the cores one run used before.
  `HACKBENCH_VITEST_WORKERS` (positive integer) overrides it, and when `CI`
  is set the old `max(2, floor(cores / 2))` applies. The cap covers
  `test:unit` only: the corpus and timing vitest configs and Theia builds are
  uncapped. The value is a starting point, not measured under 3 concurrent
  runs.
- Shared installs are refused (#1038). `tools/scripts/check-theia-install.mjs`
  runs as the Theia `prebuild*` hooks and at the top of the Playwright config
  (unless `HB_APP_URL` or `HB_SKIP_INSTALL_GUARD` is set; the unit gates that
  only load the config set the latter). It fails when the `theia` folder or
  `theia/node_modules` is a junction or link, a
  `hackbench-*` workspace link resolves outside the checkout, or a package
  `node_modules` or `theia/node_modules/.cache` is a link out. Such a worktree
  would bundle another checkout's extension and share its nx cache. Fix for a
  junction: remove it WITHOUT a recursive delete (`cmd /c rmdir`, with
  backslashes: `theia\node_modules`), then `yarn --cwd theia install` in that
  worktree. For a linked `theia` folder, remove the link, `git checkout -- theia`,
  then install. Evidence: synthetic layouts, one Windows machine; 8.3 short
  paths compare through native realpath but are untested. The checkout is found from INIT_CWD, a PWD equal to the cwd, or the cwd, because POSIX cwd is the symlink target; that path is simulated on Windows (cwd in the target, logical path in the env) and never run on POSIX.
- `owner.txt` holds `owner:`, `purpose:` and `started:` (UTC) lines.
- Only the owner removes a lock slot, with `release` and the exact same id (no
  prefix, no padding; only the slot whose `owner:` matches is freed; blank ids and line breaks (CR, LF, U+2028, U+2029) are refused). A wrong or
  missing owner line refuses and leaves the lock; a team that holds no lock
  slot is told "<owner> holds no lock slot" with the holders (see #923 for the incident
  where a non-owner deleted one by hand). A lock taken by hand, with
  free-form text and no `owner:` line, cannot be proven, so `release` refuses
  it: it is removed by hand by its owner.
- `status` prints every lock slot (`slot N: free`, or its `owner.txt` as written
  with the age), plus `next.txt` when it is not blank. A lock with no parseable `started:` (hand-made, unreadable or
  missing `owner.txt`), or a `started:` in the future, is aged by the lock
  dir's mtime, and says so. If that age is still negative, `status` prints
  "age unknown (clock skew), report to the BA" and never calls it fresh. An
  mtime age can reset if `owner.txt` is replaced, so it is a lower bound.
  `release` on a lock dir whose `owner.txt` is missing or empty says so (an
  interrupted acquire) and refuses; report it to the BA.
- `locks/next.txt` reserves the next turn. The owner's team is the leading
  letters of its first word, lowercased (`xray-909` is `xray`); the lock is
  free for that owner only if it is the FIRST word of `next.txt` (same
  normalisation); the BA writes the team name first, and a path later in the
  line (`bravo C:/wt/923-alpha-fix`) reserves for `bravo` only.
  The reservation gates every lock slot: other teams are refused even while
  slots are free. The named team takes any free one, and the helper then
  deletes the file. If the named team already holds a lock slot it cannot
  take another, so `acquire` ignores the reservation (and says so in its
  output) rather than blocking everyone; the BA should then replace or
  delete `next.txt`. A blank `next.txt` is ignored.
- A lock slot older than 2 hours (`status` prints STALE, strictly over 120 min) is
  never removed by a non-owner. Report it to the BA with its `owner.txt`.
- The CLI finds the state dir from the script's own location, not the
  current directory. When git cannot resolve the main checkout and
  `HACKBENCH_STATE_DIR` is unset it refuses (exit 1, message names the env
  var) instead of using a lock dir somewhere else.

## Related docs

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) - general dev setup and PR flow
- [Testing milestone](https://github.com/en-gen/hackbench/milestone/12) -
  tracks critical-path test priorities
- [`docs/rom/smw-rom-format.md`](./rom/smw-rom-format.md) - ROM layout reference
