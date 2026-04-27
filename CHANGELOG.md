# Changelog

All notable changes to HackBench are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Koopa patrol overlay no longer teleports up to a parallel slope at
  stair-step slope corners (visible regression at level $006 col 92 with
  the blue koopa $006). The overlay scan now uses edge-matched surface
  continuity from a new `SurfacePath` module instead of a `±1`-row
  heuristic, so the patrol band tracks the same polyline the editor's
  "Show surfaces" overlay draws.
- Koopa / ground-walker patrol overlays now correctly walk on $11A item
  blocks, $11C wood-plank platforms, and other page-1 tiles whose acts-
  like low byte falls in `$17-$1C` (block-behavior table value $00).
  The sprite-side floor / wall / ceiling classification was incorrectly
  gating on `DATA_00F05C` (the block-behavior table), but the ROM's
  sprite-collision routines (`CODE_01928E`, `CODE_0192C9`,
  `CODE_01933B` at bank_01.asm:2613/2646/2705) only check the page-0
  high-byte BEQ and a low-byte range. F05C governs Mario's
  hit-from-below dispatch (`CODE_00F17F`), not collidability.

### Changed

- "Show surfaces" editor overlay now consumes the shared `SurfacePath`
  module — same source of truth as the sprite-patrol scan. Both views
  agree on silhouette suppression, slope vs flat classification, and
  priority-decorative passthrough; only the floor predicate differs
  (Mario perspective for the overlay, sprite for the scan).
- Project renamed from `smw-editor` to `hackbench`. Marketplace ID,
  command IDs, view IDs, and viewType IDs are now under the
  `hackbench.*` namespace. Virtual filesystem URI scheme (`smwrom://`)
  and content file extensions (`.smwlevel`, `.smwpalette`, `.smwgfx`,
  `.smwmusic`) are unchanged.

### Added

- `LICENSE` - MIT
- `THIRD_PARTY_LICENSES.md` - LGPL-2.1 attribution for
  `@smwcentral/spc-player`
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`
- GitHub issue forms, pull request template, Dependabot config

## [0.1.0] - 2026-04-17

Initial pre-alpha release.

### Added

- Virtual filesystem provider for `smwrom://` - opens a SMW ROM as a
  navigable folder tree.
- Level viewer: Layer 1 object + sprite parsing from ROM bytecode,
  rendered against live Map16 + GFX + palette data.
- Palette editor: all 16 CGRAM rows per palette group, BGR555 with
  bit-replicated 8-bit display.
- GFX viewer: all 50 decompressed tile sheets, auto-detected 2BPP /
  3BPP / 4BPP, palette-swappable in-view.
- Music player: SPC700 playback via `@smwcentral/spc-player`.
- Tree-view sidebar with Maps and Resources sections.

### Known limitations

- Read-only - write-back of edited levels/palettes/GFX is not yet
  implemented.
- Layer 2 preset backgrounds (ROM bank `$FF` sentinel) are not
  decodable without CPU emulation and show a placeholder.
- Some tall/slope object handlers have alignment edge cases under
  investigation.

[Unreleased]: https://github.com/en-gen/hackbench/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/en-gen/hackbench/releases/tag/v0.1.0
