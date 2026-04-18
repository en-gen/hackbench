# HackBench Testing Guide

## Legal position - read first

**HackBench does not distribute any Super Mario World ROM data, decompressed
resources, or other content derived from the ROM.** Super Mario World is
© Nintendo, and any bytes extracted from it - compressed *or* decompressed,
whole files *or* narrow slices - remain Nintendo's copyrighted property.
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
*Super Mario World (USA)*. We validate against a specific dump:

| | |
|---|---|
| Filename | `test/roms/Super Mario World (USA).vanilla.sfc` |
| Size | 524,288 bytes (no copier header) |
| SHA-1 | `6B47BB75D16514B6A476AA0C73A683A2A4C18765` |

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

### 3. Fixture-based reference tests (developer-local)

Some tests benefit from comparing against an **independent reference** -
the canonical example is the LC_LZ2 decompressor, where a different
implementation in a different language gives us cross-validation.

HackBench ships a vendored copy of the LC_LZ2 decompressor from
[`snesrev/smw`](https://github.com/snesrev/smw) (MIT) at
[`tools/vendor/snesrev-smw/`](../tools/vendor/snesrev-smw/) and a
developer-run script, [`tools/scripts/dump-vanilla-gfx.py`](../tools/scripts/dump-vanilla-gfx.py),
which:

1. Loads the vanilla ROM from your local `test/roms/` directory.
2. Uses the vendored Python decompressor to decompress every GFX file.
3. Writes each compressed slice + expected decompressed output to
   `test/fixtures/gfx/` - **a gitignored directory on your machine only**.

### Regenerating fixtures from your own ROM

```bash
# One-time: place your vanilla ROM at the expected path.
cp /path/to/your/Super\ Mario\ World\ \(USA\).sfc \
   test/roms/Super\ Mario\ World\ \(USA\).vanilla.sfc

# Dump fixtures from your ROM (output lives under gitignored test/fixtures/).
python tools/scripts/dump-vanilla-gfx.py

# You can now enable fixture-based decoder tests locally by adding a
# *.fixtures.test.ts file that reads from test/fixtures/gfx/. Keep those
# tests under a skipIf(!fixturesPresent) guard so they don't break other
# contributors' CI runs.
```

**Do not commit the contents of `test/fixtures/`.** The `.gitignore` rule
blocks the directory by default - if you're tempted to `git add -f`, don't.

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

## Commands

```bash
npm run lint           # ESLint on src/
npm run test:unit      # Vitest, single run
npm run test:unit -- --coverage    # + v8 coverage
npx vitest run test/suite/unit/LcLz2.synthetic.test.ts   # one file
```

## Related docs

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) - general dev setup and PR flow
- [`docs/roadmap.md`](./roadmap.md) - "Testing & Coverage" section tracks
  critical-path test priorities
- [`docs/smw-rom-format.md`](./smw-rom-format.md) - ROM layout reference
