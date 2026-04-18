# Prompt: design automated visual regression tests for level rendering

Paste the text below into a fresh Claude Code session in this repo. It is self-contained and does not rely on the current conversation's context.

---

## Context

This is HackBench, a VS Code extension that parses Super Mario World ROMs and renders levels. The level-expansion pipeline (`src/rom/ObjectExpander.ts` calling handlers in `src/rom/objectHandlers/`) is a port of SMW's 65816 assembly from `C:\Projects\SMWDisX`. The port currently has bugs and we're hunting them.

A Mesen-backed ground-truth workflow exists and is documented in the memory file `reference_mesen_fixture_pipeline.md`. In summary:

1. **Mesen recorder** (`tools/mesen/record_level_map16.lua`) writes level-wide Map16 dumps while a human pilots Mario through a level.
2. **Stitcher** (`tools/scripts/stitch_map16_dumps.py`) combines the per-tick dumps into a canonical fixture at `test/fixtures/level_001_map16.txt`.
3. **Fixture diff test** (`test/suite/unit/Level001Fixture.test.ts`) runs our TS port's `expandMap` and counts cells that disagree with the fixture.
4. **Visual diff PNG** (`test/suite/unit/Level001DiffImage.test.ts`) renders both grids as actual pixels (using `TileRenderer`) stacked as two strips, with red rectangles on mismatched cells. Output: `tools/mesen/level_001_diff.png`.

The PNG approach works brilliantly for one level. The human can eyeball the image and confirm diffs are real. Now we want to scale it up into an automated regression suite.

## What to design

A test suite that:

1. **Supports multiple level fixtures** not just $001. The workflow for capturing a new level should be: someone walks Mario through it in Mesen once, runs the stitcher, commits the fixture file, and from then on the suite includes that level in every run.
2. **Runs on every handler-affecting change** so a regression is caught immediately. Initially just locally (`npx vitest run`) with the ROM at `test/roms/Super Mario World (USA).vanilla.sfc`; longer-term, CI-friendly.
3. **Produces a visual report** that summarizes results at a glance. The PNG per level is the right primitive. A top-level `reports/` HTML index linking each level's current diff image, diff count, and diff delta vs the previous commit would let a reviewer approve or reject at a glance.
4. **Serves as a regression guard** - failing the test suite when diff count for any level increases, not just when it hits zero. "Don't make it worse" is a useful bar while we're still fixing.
5. **Handles the ROM gracefully** - the SMW ROM is gitignored (and must stay that way, see `feedback_no_fixtures.md`). Tests skip cleanly if the ROM isn't present.

## Concrete deliverables I want you to propose

Don't implement yet. Present a short design doc covering:

### A. Fixture format and storage

Current fixture is an ASCII text file. Is that the right format for many levels? Consider: compactness, diffability in git, ease of stitcher regeneration, ability to mark "unobserved" and "collected-mid-walk" cells explicitly.

### B. Test structure

Is a per-level Vitest test-file the right granularity, or should we have one parameterized test-file that iterates over all fixtures? How should we name/organize them?

### C. PNG generation and snapshot-testing tools

Currently the diff image is rendered via a minimal inline PNG encoder. For snapshot testing, consider tools already in the JS ecosystem: `jest-image-snapshot`, `pixelmatch`, `looks-same`. Pick one (or argue for the inline approach staying) and show how it plugs in.

### D. Report output

How should a developer see the state of things? Single HTML page per run? Per-level PNGs plus a summary `reports/INDEX.md`? Comments in vitest output? Consider: what does the CI dashboard surface, and what does a reviewer look at when diagnosing a failure?

### E. Capturing new level fixtures

What's the step-by-step a human runs when they want to add level $105 to the suite? Keep it short - currently the workflow is Mesen → script → stitcher → commit fixture. Walk through making that as frictionless as possible.

### F. Known-unobserved cells

The fixture marks `???` for cells Mario never walked near (SMW lazy-loads). Our test currently skips those from the diff. But a handler bug could "fix" a `???` cell into a real tile (or leave it `???`). Propose how the suite should treat these - skip, or require fixture re-capture when a cell that was `???` becomes observable?

### G. Collectibles mid-walk

Mario collects coins and dragon coins as he walks. Those cells are empty in the fixture but our port correctly emits them. Propose how to mark them "ignore this cell" (e.g., an explicit allow-list or a "don't-care mask" file alongside the fixture).

### H. Diff-count guard vs snapshot guard

Two models:
- **Count guard**: test fails if the diff count increases. Easy to reason about. Doesn't catch "same count but different cells" regressions.
- **Snapshot guard**: test fails if the diff image changes at all. Stricter but noisier when intended handler changes also fix a previously-diff cell.

Propose how to combine them. Maybe count guard for the Vitest failure, snapshot guard with explicit "update snapshot" for rewarding PR review.

### I. CI considerations

The SMW ROM can't be in the repo. How would CI run these tests? Options: require the ROM as a secret/artifact and skip-if-missing (current approach extended to CI), or run the suite only locally as a pre-commit step. Argue for one.

## What NOT to do

- Don't write any test code yet. This is a design pass.
- Don't propose committing ROMs or LM-derived content (strictly forbidden - see `CLAUDE.md` and `feedback_no_fixtures.md`).
- Don't propose adding giant npm deps for minor wins. The existing inline PNG encoder works; only recommend a library if it meaningfully improves the developer experience.
- Don't propose a fully automated Mesen-bot that plays levels. That's a separate rabbit hole.

## Files to read before designing

- `CLAUDE.md` (project overview)
- `tools/mesen/record_level_map16.lua` (recorder)
- `tools/scripts/stitch_map16_dumps.py` (stitcher)
- `tools/scripts/visualize_fixture_diff.py` (text diff)
- `test/suite/unit/Level001Fixture.test.ts` (current diff-counting test)
- `test/suite/unit/Level001DiffImage.test.ts` (current PNG renderer)
- `test/fixtures/level_001_map16.txt` (current fixture)
- User memory `reference_mesen_fixture_pipeline.md` (workflow reference)

## Deliverable format

A markdown design doc under `docs/ideas/automated-visual-regression-design.md`. 600-1000 words. Include a proposed directory layout, a short code sketch only where it clarifies a decision, and a clearly ordered implementation phase list (phase 1: MVP, phase 2: ..., etc.).
