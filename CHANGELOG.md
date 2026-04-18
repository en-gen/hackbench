# Changelog

All notable changes to HackBench are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

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
