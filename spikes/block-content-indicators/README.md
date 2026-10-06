# Block content indicators: how should a question block show what it holds?

Status: done. The owner picked D4. Spike code, not product code.

The mockup is not committed (it embeds ROM graphics). Rebuild it locally.

## Rebuild the mockup

Prerequisites:

- `npm ci` at the repo root.
- The vanilla ROM, found through `test/suite/support/corpus.ts`: set
  `HACKBENCH_ROMS` to the folder holding it, or keep it under
  `hackbench-tools/roms` beside the repo.

```bash
npx tsx spikes/block-content-indicators/probe.ts   # extracts graphics to assets.json
node spikes/block-content-indicators/gen.cjs       # builds mockup.html
```

Both files land in this folder and are gitignored. Open `mockup.html` in a
browser; no server needed. Both scripts take optional path arguments
(`probe.ts [out.json]`, `gen.cjs [assets.json] [out.html]`).

## What it compares

Six ways to show a block's contents on the map, over real graphics from the
vanilla ROM: A, D, C2, E2, D3, D4 (variants of badge size, placement and hover
behaviour).

## Pick: D4

Half-scale contents in the block's bottom-right quadrant, scaling up to the
full block bounds on hover, no outline.

## Graphics source

Level $105 of the vanilla ROM. Item tiles per SMWDisX `bank_01.asm:9528`
(PowerUpTiles), `bank_01.asm:8921` (vine), `bank_02.asm:3432` (coin).

## Known gaps

- Star uses palette frame 0 only (no cycling).
- Items are drawn unflipped.
- Vine shows one animation frame.
