# HackBench

> A Super Mario World ROM editor, built as a Visual Studio Code extension.

[![CI](https://github.com/en-gen/hackbench/actions/workflows/ci.yml/badge.svg)](https://github.com/en-gen/hackbench/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

HackBench opens a Super Mario World ROM as a navigable virtual folder
tree inside VS Code. Levels, palettes, graphics, and music each get a
dedicated editor that reads live from the ROM - no export/import step,
no separate app to juggle. Think of it as Lunar Magic for people who
live in an IDE.

> **Status:** pre-alpha. Core read-path for levels, palettes, GFX, and
> music is working; write-back is in progress. Pinning a release at
> `0.1.0` - expect breaking changes until `0.2.0`.
>
> **Distribution plan:** HackBench will ship as a regular VS Code
> extension through the Visual Studio Code Marketplace, auto-updating
> like any other extension. Until the first Marketplace release, the
> only way to try it is to build from source (below). Early testers
> who want to help shake out alpha/beta bugs are very welcome.

## Features

- **Virtual filesystem.** Open a `.smc` or `.sfc` and the ROM mounts as
  `smwrom://<slug>/` in the Explorer - levels, palettes, and GFX appear
  as virtual files you can open like anything else.
- **Level viewer.** Layer 1 objects + sprites parsed directly from ROM
  bytecode, rendered against live Map16 + GFX + palette data.
- **Palette editor.** All 16 CGRAM rows per palette group, BGR555 with
  bit-replicated 8-bit display.
- **GFX viewer.** All 50 decompressed tile sheets, auto-detected 2BPP /
  3BPP / 4BPP, palette-swappable in-view.
- **Music player.** SPC700 playback via [@smwcentral/spc-player][spc]
  (LGPL-2.1 - see [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md)).

[spc]: https://github.com/telinc1/smwcentral-spc-player

## Install

### Once we hit Marketplace release

You'll install HackBench like any other VS Code extension - search
`HackBench` in the Extensions sidebar (Ctrl+Shift+X / Cmd+Shift+X),
click **Install**, and VS Code handles updates automatically. **This
path isn't live yet** - pending the `v0.1.0` Marketplace publish.

### Build from source (current alpha/beta path)

If you want to help test HackBench before the Marketplace release, or
you just want the latest `develop` changes:

```bash
git clone https://github.com/en-gen/hackbench
cd hackbench
npm install
npm run compile
```

Open the folder in VS Code and hit **F5** to launch an Extension
Development Host with HackBench loaded. Bug reports from this path
are especially welcome - see
[CONTRIBUTING.md](./CONTRIBUTING.md) and
[issue templates](https://github.com/en-gen/hackbench/issues/new/choose).

## Usage

1. Run **HackBench: Open ROM…** from the Command Palette (or right-click
   a `.sfc` / `.smc` in the Explorer).
2. Pick a legal, unmodified Super Mario World ROM. See [Legal](#legal)
   below - HackBench does not ship ROM data.
3. The ROM mounts as `smwrom://<name>/` with `levels/`, `palettes/`, and
   `gfx/` virtual folders.
4. Double-click any `.smwlevel`, `.smwpalette`, `.smwgfx`, or
   `.smwmusic` file to open its editor.

## Documentation

- [Architecture](docs/architecture.md) - extension host, providers,
  webviews, message protocol
- [ROM format reference](docs/smw-rom-format.md) - LoROM addressing,
  pointer tables, Map16, GFX files
- [Roadmap](docs/roadmap.md) - planned features and milestones
- [Testing guide](docs/testing.md) - test layout, ROM-legality policy,
  how to run richer local tests with your own ROM
- [Contributing](CONTRIBUTING.md) - dev setup, branch strategy, PR
  checklist
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)

## License

HackBench is open source under the [MIT License](./LICENSE).

HackBench bundles [@smwcentral/spc-player][spc] (LGPL-2.1-only), which
remains governed by its own license. See
[THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) for details,
including how to exercise your LGPL relink rights.

## Legal

Super Mario World, its code, and all of its assets (graphics, palette
data, level data, audio, text, map tiles, etc.) are © Nintendo.
HackBench contains **no ROM bytes of any kind**: not the raw ROM file,
not compressed asset slices, not decompressed GFX, not CGRAM dumps, not
tilemap snapshots. This applies to the source tree, the packaged
extension, and every fixture, test input, and documentation sample.

You must supply your own legally-obtained ROM. HackBench is an
unofficial tool with no affiliation with, endorsement by, or
sponsorship from Nintendo. Developers who own a legal ROM can run
richer tests locally - see [Testing guide](docs/testing.md).

## Credits

- **Telinc1** - [`@smwcentral/spc-player`][spc]
- **IsoFrieze** - [SMWDisX](https://github.com/IsoFrieze/SMWDisX)
  disassembly, an indispensable reference
- **SMWCentral** - ROM/RAM maps and community knowledge
- **FuSoYa** - Lunar Magic, the tool that set the bar
