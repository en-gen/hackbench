# HackBench

> A Super Mario World ROM editor. Desktop app, non-destructive, patch-first.

[![CI](https://github.com/en-gen/hackbench/actions/workflows/ci.yml/badge.svg)](https://github.com/en-gen/hackbench/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

HackBench opens a Super Mario World ROM and lets you browse and edit
what is inside it: maps, palettes, graphics and music, with an emulator
running your working copy beside them.

It never modifies your ROM. Every edit becomes a patch layer in a
**project**, and the project is what you keep, share and version. When you
are ready to distribute, HackBench exports a real `.ips`.

> **Status: pre-alpha.** No packaged release yet, so the only way to run it
> is to build from source. Expect breaking changes. Early testers are very
> welcome, and bug reports from a source build are especially useful.

## A project is a hack, not a workspace

This is the part worth understanding before anything else.

A HackBench project references your ROM by **identity** (sha256, size,
title). It stores no path, because where the ROM lives is a fact about your
machine, and it stores no ROM bytes at all.

```
MyHack/
  MyHack.hbproj      manifest: what the hack is, and which ROM it is built on
  levels/            created with the project
  snapshots/         created with the project
  ops/               your edits, as ordered layers of {address, old, new}
  export/            the .ips you ship
  saves/             the emulator's save game (SRAM, not ROM content)
```

What follows from that:

- **The project folder is safe to commit and share.** It contains no
  Nintendo content, so it can live in a public repository.
- **Collaboration works.** Two people with their own legally obtained ROMs
  of the same revision can work on one project, and the committed bytes are
  identical for both.
- **Undo is portable.** A layer carries the old value as well as the new, so
  a fresh clone on another machine has working undo and redo.
- **Your ROM is never written to.** The only thing HackBench writes to
  a ROM is nothing at all.

## What you can do today

| View | State |
|------|-------|
| **Maps** | every map in the ROM, grouped with real counts; opening one shows its decoded header beside the raw bytes |
| **Palettes** | **editable.** Pick a color, click OK, it becomes a layer |
| **Map16** | **editable.** Subtiles write through the same layer mechanism |
| **Graphics** | every GFX file decoded, selectable bit depth and palette row, and the Map16 tile editor |
| **Audio** | every BGM track with bank details, plus the sound effect explorer |
| **Emulator** | docked in the bottom panel beside Problems, running your working copy through a libretro core you supply |

Undo and redo work across the layer stack and survive closing the project.

Edits propagate between the views that read the working copy: recolor a
palette cell and an already-open GFX sheet repaints with no manual reload.
The Maps view is **not** one of them yet. It still reads the base ROM
directly, so a palette edit is not visible there; see
[docs/glossary.md](docs/glossary.md), "Working copy".

Level editing is not wired up yet. Opening a map shows what the ROM says
about that slot, with every field traceable to an ASM citation and the raw
header bytes shown beside the decode, so you can check it rather than trust
it. The tile canvas and the editor grow out of that.

## Install

There is no release to install yet. Build from source:

```bash
git clone https://github.com/en-gen/hackbench
```

```bash
cd hackbench && npm install
```

```bash
yarn --cwd theia install
```

```bash
yarn --cwd theia build
```

```bash
yarn --cwd theia start
```

You need Node 22.12 or newer, `npm`, and `yarn` 1.x. Theia 1.75 pins
Electron 42.8.1, whose engines field requires it, which is why CI builds the
desktop app on 22. The first build is slow; it bundles the whole frontend.

Full walkthrough: [docs/guide/getting-started.md](docs/guide/getting-started.md).

## Usage

1. **File > New Project...** Give it a name, pick your ROM with the
   file dialog, choose where the project folder goes. HackBench shows you
   the ROM identity before writing anything.
2. Browse with the **Maps**, **Graphics**, **Palettes** and **Audio** views
   in the left sidebar. The Emulator is in the bottom panel: View > Emulator.
3. Edit a palette: click a swatch, change it, click **OK**. That commits one
   layer. Nothing downstream moves until you confirm.
4. **File > Export Patch** writes an `.ips` into your project's `export/`.

You supply your own legally obtained ROM. See [Legal](#legal).

## Documentation

- [Documentation index](docs/README.md) - everything, organized
- [Getting started](docs/guide/getting-started.md) - first project to first patch
- [Architecture overview](docs/architecture/overview.md) - how it is built
- [The project format](docs/architecture/project-format.md) - `.hbproj`,
  layers, export
- [Glossary](docs/glossary.md) - domain terms, which are precise here
- [Testing guide](docs/testing.md) - test layout and the ROM-legality position
- [Contributing](CONTRIBUTING.md) - dev setup, branch strategy, PR checklist
- [Roadmap](https://github.com/en-gen/hackbench/milestones) - tracked as
  GitHub milestones
- [Code of conduct](CODE_OF_CONDUCT.md) - [Security policy](SECURITY.md)

## About the VS Code extension

HackBench began as a Visual Studio Code extension, and that code is still in
the tree: `src/providers/` and `src/webview/`, plus the entry point
`src/extension.ts` and its helpers at the `src/` root. **The project has
since changed course**: HackBench is a desktop application, and the extension is
not a shipping target, is not published, and receives no new features.

It is kept because it holds a large body of working ROM interpretation,
which is the expensive part to get right, and because it remains a useful
worked example of reading SMW data. It still builds and is covered by CI.

## License

HackBench is open source under the [MIT License](./LICENSE).

HackBench bundles [@smwcentral/spc-player][spc] (LGPL-2.1-only), which
remains governed by its own license. See
[THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) for details, including
how to exercise your LGPL relink rights.

[spc]: https://github.com/telinc1/smwcentral-spc-player

## Legal

Super Mario World, its code, and all of its assets (graphics, palette data,
level data, audio, text, map tiles, etc.) are © Nintendo.

HackBench contains **no ROM bytes of any kind**: not the raw ROM file, not
compressed asset slices, not decompressed GFX, not CGRAM dumps, not tilemap
snapshots. This applies to the source tree, the packaged application, and
every fixture, test input, and documentation sample.

Projects you create contain no ROM content either, which is what makes
them safe to share. The `.ips` patches you export contain only your own
changes.

You must supply your own legally obtained ROM. HackBench is an unofficial
tool with no affiliation with, endorsement by, or sponsorship from Nintendo.
Developers who own a legal ROM can run richer tests locally: see the
[Testing guide](docs/testing.md).

## Credits

- **Telinc1** - [`@smwcentral/spc-player`][spc]
- **IsoFrieze** - [SMWDisX](https://github.com/IsoFrieze/SMWDisX)
  disassembly, an indispensable reference
- **SMWCentral** - ROM/RAM maps and community knowledge
- **FuSoYa** - Lunar Magic, the tool that set the bar
