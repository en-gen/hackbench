# Spikes

A spike is a time-boxed exploration that answers one question. Its code may be
thrown away; what is kept is the answer. Spike code is not product code and is
excluded from ESLint and Prettier.

One sub-folder per spike, named for the question it asks. Each carries a
`FINDINGS.md` or `README.md` stating the question, the status and the outcome.

## Current spikes

| Folder                                                   | Question                                       |
| -------------------------------------------------------- | ---------------------------------------------- |
| [libretro-view-engine](libretro-view-engine/FINDINGS.md) | Can a libretro core be HackBench's view engine? |
| [sprite-oracle](sprite-oracle/FINDINGS.md)               | Does our 65816 core run real SMW sprite routines exactly as the game does? |
| [block-content-indicators](block-content-indicators/README.md) | How should a question block show what it holds? (D4 picked) |
| [progressive-powerup-indicators](progressive-powerup-indicators/README.md) | How does a block indicator show a progressive powerup (mushroom or flower/feather)? |

## Past write-ups

Spikes recorded as documents only, without a code folder, live in `docs/spikes/`:

- [cgram-oracle](../docs/spikes/cgram-oracle.md)
- [music-bank-song-table](../docs/spikes/music-bank-song-table.md)
- [palette-animation-detect](../docs/spikes/palette-animation-detect.md)
- [per-pass-canvas-spike](../docs/spikes/per-pass-canvas-spike.md)
- [vscode-ui-testing-spike](../docs/spikes/vscode-ui-testing-spike.md)
