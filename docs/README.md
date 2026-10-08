# HackBench documentation

HackBench is a Super Mario World ROM editor, built as a desktop application
on Eclipse Theia and Electron.

## Start here

| If you want to...                      | Read                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| run HackBench and make your first edit | [guide/getting-started.md](guide/getting-started.md)                                     |
| understand how it is put together      | [architecture/overview.md](architecture/overview.md)                                     |
| know what a word means here            | [glossary.md](glossary.md)                                                               |
| contribute                             | [codebase map](architecture/codebase-map.md), then [CONTRIBUTING.md](../CONTRIBUTING.md) |
| know the house rules for docs         | [CONVENTIONS.md](CONVENTIONS.md)                                                         |

## Current state

What a freshly started session reads first. Keep it short; detail lives in the linked files.

- **Open decisions.** See [decisions/README.md](decisions/README.md); Proposed files are waiting on the owner.
- **Hypotheses.** [hypotheses.md](hypotheses.md) holds claims not yet established.
- **Recent corrections.** Listed here when a primary source overturns a doc, newest first, one line each with the file corrected. (none yet)
- **Conventions.** [CONVENTIONS.md](CONVENTIONS.md) is the contract: tags, citation, corrections, file shapes.
- **Protocols.** [protocols/README.md](protocols/README.md) lists the modes the owner can enact.
- **Runbooks.** [runbooks/README.md](runbooks/README.md) holds the methods.

## Guide

- [getting-started.md](guide/getting-started.md) - build, create a project,
  edit a palette, export a patch

## Architecture

- [overview.md](architecture/overview.md) - the three trees, the edit model,
  how a ROM becomes pixels
- [project-format.md](architecture/project-format.md) - `.hbproj`, patch
  layers, the working copy, BPS or IPS export
- [theia-shell.md](architecture/theia-shell.md) - the six extensions, the
  browser/common/node split, RPC wiring
- [codebase-map.md](architecture/codebase-map.md) - where code lives, what
  tests run where, the commit gates

## Project-wide

- [glossary.md](glossary.md) - domain vocabulary. Slot, map, level, entry
  map, sub area, launch tile and submap are **not** interchangeable, and
  using them loosely is how this project once produced five different level
  counts.
- [testing.md](testing.md) - test layout, the ROM-legality position, and how
  to run the richer ROM-backed tests locally
- [references.md](references.md) - published SNES and SMW documentation this
  project relies on
- [ui-conventions.md](ui-conventions.md) - house UI rules, each cited to
  the correction that produced it

## Features and subsystems

How a given part of the app reads the ROM and what it refuses to guess.
These live at the docs root rather than in a subfolder, because the code
that cites them does so by that path.

- [music-playback.md](music-playback.md) - how the Music panel turns ROM
  bytes into sound, and whose limitation each limitation is
- [sfx-tables.md](sfx-tables.md) - where sound effects live, found without
  assuming an address, and why custom music reports none
- [gfx-arena-budget.md](gfx-arena-budget.md) - how much editing fits in the
  GFX arena, measured across 6 ROMs
- [layer-previews.md](layer-previews.md) - what a layer preview is for;
  inherits the UI conventions above

## ROM reference

How the ROM is laid out and how its data is read. Claims here are
cited to the disassembly.

- [rom/smw-rom-format.md](rom/smw-rom-format.md) - LoROM addressing, pointer
  tables, Map16, GFX files
- [rom/smw-memory-map.md](rom/smw-memory-map.md) - the memory map
- [rom/smw-level-header.md](rom/smw-level-header.md) - the 5-byte primary header
- [rom/smw-translevel-formula.md](rom/smw-translevel-formula.md) - translevel
  to level number
- [rom/smw-overworld-levels.md](rom/smw-overworld-levels.md) - overworld
  level mapping
- [rom/smw-overworld-wram.md](rom/smw-overworld-wram.md) - overworld WRAM tables
- [rom/level-rendering.md](rom/level-rendering.md) - the level rendering pipeline
- [rom/obj-priority.md](rom/obj-priority.md) - OBJ priority and the
  compositor pass list
- [rom/map-data-mechanics.md](rom/map-data-mechanics.md) - how maps grow,
  relocate and share pointers; sprite-stream limits; acts-like
- [rom/block-contents.md](rom/block-contents.md) - what each item block
  ($111-$12D) holds, by X column and game state

## Sprites

Per-sprite derivations and the design of the table-driven draw engine. These
are long because they show the trace, which is the point.

- [sprites/sprite-gfx-routine-reading.md](sprites/sprite-gfx-routine-reading.md) -
  reading a sprite's draw routine off the ROM
- [sprites/sprite-dispatch-chains.md](sprites/sprite-dispatch-chains.md) -
  reading through the shared handler stubs
- [sprites/sprite-draw-path-census.md](sprites/sprite-draw-path-census.md) -
  how far a table-driven engine can reach
- [sprites/sprite-engine-divergence.md](sprites/sprite-engine-divergence.md) -
  Phase 1 divergence report
- [sprites/sprite-engine-wiring.md](sprites/sprite-engine-wiring.md) -
  editor wiring
- [sprites/sprite-overlay-removal.md](sprites/sprite-overlay-removal.md) -
  removal of path and movement overlays
- [sprites/sprite-validation-batches.md](sprites/sprite-validation-batches.md)
- [sprites/sprite-1f-magikoopa.md](sprites/sprite-1f-magikoopa.md)
- [sprites/sprite-4d-monty-mole.md](sprites/sprite-4d-monty-mole.md)
- [sprites/smw-sprite-2c-yoshi-egg.md](sprites/smw-sprite-2c-yoshi-egg.md)

## Spikes and investigations

Findings from throwaway probes. Kept for the conclusions, not the code.

- [spikes/cgram-oracle.md](spikes/cgram-oracle.md)
- [spikes/palette-animation-detect.md](spikes/palette-animation-detect.md)
- [spikes/music-bank-song-table.md](spikes/music-bank-song-table.md)
- [spikes/per-pass-canvas-spike.md](spikes/per-pass-canvas-spike.md)
- [spikes/vscode-ui-testing-spike.md](spikes/vscode-ui-testing-spike.md)

## Ideas

Proposals under consideration. Not decisions, and not necessarily current.

- [ideas/](ideas/) - level classification, map rendering engines, emulator
  oracle testing, overworld scene pipeline, sprite properties panel, MCP server

## Plans and specs

Designs agreed before implementation, dated and kept as written.

- [superpowers/specs/](superpowers/specs/) - accepted designs
- [superpowers/plans/](superpowers/plans/) - the implementation plans from them

## Mockups

- [mockups/](mockups/) - HTML wireframes

## House rules for documentation

Two that come up constantly:

- **State the evidence scope with every claim.** Not "deterministic" but
  "byte-identical across 6 cold runs, one machine, Mesen 2.x". Two claims in
  this project were asserted well past their evidence and nearly shipped.
- **Cite ROM behavior to `SMWDisX file:line`.** Trace it. Do not copy the
  assembly into this repository; copies rot when the disassembly is
  regenerated.
