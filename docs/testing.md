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
- **Tests that need real ROM data are developer-local only.** They are
  either skipped automatically when no ROM is present, or depend on fixtures
  that live under `test/fixtures/` (gitignored).
- **Everything under `test/fixtures/` is gitignored** by default. If you
  regenerate fixtures locally, they stay on your machine. See
  [.gitignore](../.gitignore) for the specific rule.

Do not submit PRs that add ROM data, decompressed game resources, or
fixtures derived from the ROM. These will be rejected.

## The content gate

`tools/scripts/check-staged-content.sh` (issue #678) enforces the rule above
mechanically, since the repo is public and a push is publication:

- Any binary file is blocked outright unless it sits under `build/icons/` or
  `theia/no-native/`. A fixed extension list (`.ppm`, `.png`, `.bin`, `.chr`,
  `.raw`, `.dmp`, and more - a decoded ROM sheet often lands as one of
  these) is blocked the same way even when git reads the file as text, since
  an ASCII (P3) `.ppm` is still a decoded GFX sheet.
- `.asm` is blocked outright: disassembly excerpts belong in SMWDisX, never
  copied into this repo.
- Text content is sniffed for a base64 blob over ~300 characters, a
  `data:image/...;base64,` URI carrying a real payload, and a hex/byte-array
  literal over 256 bytes.

It runs in three modes, sharing the same rule functions:

- `staged` - the pre-commit hook (`.githooks/pre-commit`).
- `range BASE HEAD` - CI, and `.githooks/pre-push` (which computes the
  range per pushed ref, including new branches).
- `history` - every blob reachable from every ref
  (`git rev-list --objects --all`), whole file content rather than just
  added lines. This is the oracle for the repo migration: content that was
  added and later deleted still reached GitHub's history (and its
  `refs/pull/*` copies) the moment it was first pushed, so it still has to
  be reported. Output is one machine-readable line per offender:
  `BLOCKED (<rule>): <path> (first added in <sha>)`. CI runs this against
  full history once the repo goes public (`.github/workflows/ci.yml`);
  it is skipped while private because the pre-migration history still
  holds known offenders that get purged at migration, not fixed in CI.

`npm install` sets `core.hooksPath` to `.githooks` automatically
(`tools/scripts/set-hooks-path.sh`, run via the `prepare` lifecycle script),
so both hooks are wired up without a manual `git config` step. The
pre-commit hook can still be bypassed with `git commit --no-verify`; the
pre-push hook then catches it anyway, as long as the push itself does not
also pass `--no-verify` (which skips every hook - nothing at the hook level
can stop that).

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
per-layer capture harness and its PowerShell runners are not here: they
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

These run in CI on Node 20 and Node 22 and are the project's primary
correctness gate.

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

`tools/scripts/capture_gate.ts` (en-gen/hackbench#421) builds the Map16
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

## Playwright never touches your app data

Specs create projects, which writes `recent-projects.json`, `rom-registry.json`
and `core-registry.json` in per-machine app data (`src/project/appData.ts`:
`APPDATA` on Windows, `XDG_DATA_HOME` on Linux). `playwright.config.cjs` points
both at a per-run folder under the OS temp dir before any spec loads, which
every process it starts inherits, and deletes it when the run exits. It never
reuses a server already on port 3000, since that server's app data is unknown.

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
ignores the environment there.

`test/suite/gates/playwrightAppDataGate.test.ts` checks, without a ROM: the
config's folder is where the registries resolve; the webServer (through
Playwright's env merge), `own-backend.cjs` and `start-test-server.cjs` spawn
options hand it to a child process; `reuseExistingServer` is false; each
refusal fires; a real `recent-projects.json` edited during a run comes out
holding that edit. It plants a non-isolating harness and a snapshot/restore
harness to show that last check can fail. It does not start a server.

## Commands

```bash
npm run lint           # ESLint on src/
npm run test:unit      # Vitest, single run
npm run test:unit -- --coverage    # + v8 coverage
npx vitest run test/suite/unit/LcLz2.synthetic.test.ts   # one file
```

## Related docs

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) - general dev setup and PR flow
- [Testing milestone](https://github.com/en-gen/hackbench/milestone/12) -
  tracks critical-path test priorities
- [`docs/rom/smw-rom-format.md`](./rom/smw-rom-format.md) - ROM layout reference
