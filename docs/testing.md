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

## Getting a ROM (locally)

You can play the ROM-dependent tests if you own a legal copy of
_Super Mario World (USA)_. We validate against a specific dump:

|          |                                                 |
| -------- | ----------------------------------------------- |
| Filename | `test/roms/Super Mario World (USA).vanilla.sfc` |
| Size     | 524,288 bytes (no copier header)                |
| SHA-1    | `6B47BB75D16514B6A476AA0C73A683A2A4C18765`      |

Drop your vanilla ROM at that path. The `test/roms/` directory is
gitignored, so the ROM will never be accidentally committed.

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

Blocks marked with `describe.skipIf(!romPresent)` or `if (!romPresent)`.
Examples:

- `SmwRom integration` - opens the ROM and exercises the pointer-table
  logic end-to-end.
- `GfxLoader (ROM-only)` - checks that `loadGfxRaw`/`loadGfxFile` return
  expected sizes and pixel counts for specific GFX files.
- `PaletteLoader (requires ROM)` - verifies CGRAM assembly for level $104.

These skip cleanly when `test/roms/Super Mario World (USA).vanilla.sfc`
is missing. If you've dropped your ROM in place, they run automatically.

## Writing new tests

Order of preference, highest to lowest:

1. **Pure-function test with synthetic inputs.** Always preferred.
2. **Property/round-trip tests** that validate internal consistency
   (e.g., encode-then-decode returns the original).
3. **ROM-dependent test with `skipIf(!romPresent)`.** Acceptable when
   testing ROM-traversal code paths. Remember: these won't run in CI.
4. **Fixture-based tests that read from `test/fixtures/`.** Fine for
   local cross-validation, but gate them on fixture presence and never
   commit the fixtures themselves.

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
- [`docs/smw-rom-format.md`](./smw-rom-format.md) - ROM layout reference
