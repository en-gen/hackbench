# Mesen dump scripts

Interactive Mesen 2 Lua scripts that record ground truth while someone plays
a level. Load them in Mesen's script window, then enter a level from the
overworld; each starts capturing when `GameMode` reaches `$14` and stops when
it leaves.

- `l1_dump.lua` -- Map16 tilemap around Mario every tick, with a
  Space-toggled auto-scroll. Controls are listed at the top of the file.
- `l2_dump.lua` -- per-frame scroll state (`l2_scroll.csv`) and the L2
  (background) tilemap at level entry.
- `l3_dump.lua` -- per-frame L3 (overlay) scroll and a VRAM slice at level
  entry.

The three can run together: frame numbers are emulator-global, so frame N
means the same frame in every output. All three write under
`HACKBENCH_FIXTURES_DIR` (default `~/OneDrive/hackbench-fixtures/maps`),
outside the repo, because the dumps hold ROM-derived data.

## Headless capture moved

The scripted, headless per-layer capture route (`headless_capture.lua`, its
PowerShell wrappers, the level sweep and the mutation test) now lives in
[en-gen/hackbench-validation](https://github.com/en-gen/hackbench-validation)
under `capture/`. Its README is `capture/mesen/README.md` there.

## Where Mesen lives

`Mesen.exe`, its `Saves/`, `Debugger/`, `GameConfig/` and `Cheats/` are NOT
in this directory. They are non-redistributable binaries, and the ROM corpus
beside them is copyrighted, so both sit outside the repo where `git clean -x`
cannot delete them:

```
<projects>/hackbench-tools/mesen/    Mesen.exe, Saves/, Debugger/, ...
<projects>/hackbench-tools/roms/     the ROMs
```

Only the `*.lua` scripts and this README are tracked here.
