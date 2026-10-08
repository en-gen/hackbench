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

Modes: `staged` (pre-commit), `range BASE HEAD` (CI), `push REMOTE`
(`.githooks/pre-push`, reading stdin ref-updates and querying the remote
live via `git ls-remote` rather than trusting local, possibly stale,
remote-tracking refs), and `history` (every blob reachable from every ref

- the repo-migration oracle, run in CI only once public; also refuses a
  shallow clone, a grafts file, and a tag/ref pointing at a blob or tree
  outside any commit's tree).

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

| Planted defect                                              | Cases red |
| ----------------------------------------------------------- | --------- |
| `paths` entry for `cloudevents` renamed                     | 3         |
| `patterns` entry `cloudevents/*` renamed                    | 1         |
| `ImportExpression` selector (string literal) disabled       | 2         |
| `ImportExpression` template-literal selector disabled       | 1         |
| `require()` selector (string literal) disabled              | 1         |
| `require()` template-literal selector disabled              | 1         |
| `module.require()` selector (string literal) disabled       | 1         |
| `module.require()` template-literal selector disabled       | 1         |

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
reuses a server already on port 3000, since that server's app data is unknown.

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

## The validation repository

- `en-gen/hackbench-validation` is private and holds the Playwright e2e workflow (`e2e-playwright.yml`; builds the Theia browser shell and runs `theia/browser-app/test` against the requested ref, manually or via hackbench's manual-only `e2e-dispatch.yml`), the nightly run, the perf nightly (#415) and the Mesen per-graphics-layer capture harness (`capture/`). `[EST]`
- map-diff was deleted 2026-09-25. `[EST]`
- The CI secrets live there; `en-gen` is a Free org, so secrets are duplicated per repo. The ROM is pulled from OneDrive at run time. `[EST]`
- `MAX_SKIPPED` gates on the known skips (emulator-view needs the core, gfx-view needs Invictus, music-view needs GPW2). Measured 8 on 2026-09-22; the emulator spec has since grown from 5 to 21 tests, so re-measure. `[OPEN]`
- The libretro core is `snes9x_libretro.{js,wasm}` in the `hackbench-cores` checkout, outside every worktree. The app records its location in `core-registry.json` under the app data directory; read that first. `[EST]`
- Run emulator specs from any worktree with `HB_CORE_JS` set to the core's `.js` path; without it the suite silently skips, and CI has no core and skips too. `[EST]`
- Nightly cost is why e2e is not per-PR. `[EST]`

## Related docs

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) - general dev setup and PR flow
- [Testing milestone](https://github.com/en-gen/hackbench/milestone/12) -
  tracks critical-path test priorities
- [`docs/rom/smw-rom-format.md`](./rom/smw-rom-format.md) - ROM layout reference
