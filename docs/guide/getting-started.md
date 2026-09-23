# Getting started

What you need, how to run HackBench, and how to get from a ROM to an
`.ips` patch.

> HackBench is pre-alpha. There is no packaged release yet, so the only way
> to run it is to build from source.

## What you need

- **Node 22.12 or newer**, plus `npm` and `yarn` 1.x. Theia 1.75 pins
  Electron 42.8.1, whose engines field requires it.
- **A legally obtained Super Mario World ROM.** HackBench ships no ROM
  data and never will. See [Legal](../../README.md#legal).
- Optionally, a **libretro SNES core** if you want the emulator view.
  HackBench ships no core either.

## Build and run

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

The first `build` is slow; it bundles the whole frontend. After that,
`yarn --cwd theia watch` rebuilds on save.

## Create a project

A project is the hack you are making. It references your ROM by
identity and never copies it, so the project folder is safe to commit and
share. [project-format.md](../architecture/project-format.md) explains the
design.

**File > New Project...** asks for three things:

| Field | What it means |
|-------|---------------|
| Project name | the manifest filename stem, and the folder name |
| Base ROM | picked with the file dialog, never typed |
| Location | where the project folder goes |

HackBench shows the ROM identity back to you before writing anything,
so you can confirm you picked the right ROM. The project gets its **own
folder** under the location you choose, and the dialog previews the exact
path that will be written.

Title, authors, version and summary are not asked for here. Nobody knows
their summary at minute zero. They live in **Project Properties...** and the
manifest carries defaults until you fill them in.

What you get:

```
MyHack/
  MyHack.hbproj
  levels/
  snapshots/
```

`ops/`, `export/` and `saves/` appear on first use.

## Look around

Five views, all reachable from the **HackBench** command category. Maps,
Graphics, Palettes and Audio dock in the left sidebar; the Emulator docks
in the right:

- **Maps** - every map in the ROM, grouped rather than dumped in a
  flat list, with counts that mean what they say. Opening one shows its
  decoded header beside the five raw header bytes; it is not a tile canvas
  yet
- **Palettes** - the palette groups, editable
- **Graphics** - every GFX file, decoded, with a selectable bit depth and
  palette row
- **Audio** - every BGM track with bank details, and the sound effect
  explorer beside them
- **Emulator** - a libretro core running the working copy, docked in the
  bottom panel beside Problems so it sits below what you are editing; open
  it from View > Emulator

If you open a project on a machine where the ROM is not registered,
every view asks you to locate the ROM rather than showing you nothing.

## Make an edit

The palette view is the editable one today.

1. Open **Palettes** and click a swatch.
2. Change it with the color picker or the BGR555 hex field.
3. Click **OK**.

Clicking OK is what commits the edit as one layer. Nothing downstream
updates until you confirm, so a mid-drag preview never becomes part of your
hack.

Once committed, the change is live everywhere: recolor a cell that a GFX
sheet uses and the already-open sheet repaints, with no manual reload. Both
views read the same working copy.

**Undo and redo** work across the layer stack, and they survive closing the
project: an undone layer moves to `ops/redo/` rather than being deleted.

## Export a patch

**File > Export Patch** diffs the base ROM against your working copy
and writes a real `.ips` into `export/`.

The patch is what you distribute. It contains only your changes, so it
carries no Nintendo content, and it applies to the same file variant
(headered or not) that your project was built against.

Exporting with no edits succeeds and gives you an empty patch. Exporting
from a project whose ROM is not on this machine fails, because there
is nothing to diff against.

## Where things go on your machine

Two things are per-machine and deliberately not part of a project:

- the **ROM registry**, mapping ROM identity to a local path
- the **core registry**, the path to your libretro core

Both live in per-user application data, and both re-validate on every
resolve, because you can move or replace a file underneath a stale entry.

The emulator cache (savestates, heap offsets) lives there too, keyed by ROM
hash and core identity. It is the only ROM-derived output HackBench
produces, and it is kept well away from your project folder.

## Next

- [../architecture/overview.md](../architecture/overview.md) - how it works
- [../glossary.md](../glossary.md) - what "map", "slot" and "sub area" mean
  here, which is not what you might assume
- [../../CONTRIBUTING.md](../../CONTRIBUTING.md) - if you want to help
