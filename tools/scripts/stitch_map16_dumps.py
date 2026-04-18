#!/usr/bin/env python3
"""
Stitch Map16 level dumps from tools/mesen/record_level_map16.lua into a
canonical fixture.

Each tick block in the input looks like:

  === tick N  marioCol=X  range=A..B ===
  r 0: <tiles>
  r 1: <tiles>
  ...
  r26: <tiles>

Each tile is either a 3-hex number or ".". For overlapping cells across
ticks we keep the observation from the tick whose `marioCol` is closest to
that col (Mario's immediate vicinity is the most recently expanded by SMW
and therefore the most trustworthy).

Usage:
  python stitch_map16_dumps.py <in.txt> <out.txt> [--report]

The output fixture is not committed (see .gitignore test/fixtures/); each
developer regenerates it locally from their own Mesen capture.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

TICK_RE = re.compile(r'===\s*tick\s+(\d+)\s+marioCol=(-?\d+)\s+range=(-?\d+)\.\.(-?\d+)\s*===')
ROW_RE  = re.compile(r'r\s*(\d+):\s*(.*)')

EMPTY = 0x25
ROWS_TOTAL = 27


def parse_dumps(text: str) -> list[dict]:
    ticks: list[dict] = []
    current: dict | None = None
    for raw in text.splitlines():
        m = TICK_RE.search(raw)
        if m:
            if current:
                ticks.append(current)
            current = {
                'tick': int(m.group(1)),
                'marioCol': int(m.group(2)),
                'lo': int(m.group(3)),
                'hi': int(m.group(4)),
                'rows': {},
            }
            continue
        m = ROW_RE.match(raw)
        if m and current is not None:
            row = int(m.group(1))
            tiles: list[int] = []
            for tok in m.group(2).split():
                if tok == '.':
                    tiles.append(EMPTY)
                else:
                    try:
                        tiles.append(int(tok, 16))
                    except ValueError:
                        tiles.append(EMPTY)
            current['rows'][row] = tiles
    if current:
        ticks.append(current)
    return ticks


def stitch(ticks: list[dict]) -> dict[tuple[int, int], int]:
    """Return {(col,row): tile_id}, choosing the observation closest to mario each cell."""
    best: dict[tuple[int, int], tuple[int, int]] = {}
    for t in ticks:
        mcol = t['marioCol']
        lo   = t['lo']
        hi   = t['hi']
        for row, tiles in t['rows'].items():
            for i, tile in enumerate(tiles):
                col = lo + i
                if col > hi:
                    break
                dist = abs(col - mcol)
                prev = best.get((col, row))
                if prev is None or dist < prev[0]:
                    best[(col, row)] = (dist, tile)
    return {k: v[1] for k, v in best.items()}


def write_fixture(grid: dict[tuple[int, int], int], out_path: Path) -> None:
    if not grid:
        out_path.write_text("# empty grid\n", encoding='utf-8')
        return
    cols = sorted({c for (c, _) in grid})
    min_col, max_col = cols[0], cols[-1]
    lines = [f"# level Map16 fixture. col {min_col}..{max_col} inclusive, rows 0..{ROWS_TOTAL - 1}."]
    lines.append(f"# '???' = not observed in any tick; treat as unknown in comparisons.")
    lines.append(f"# min_col={min_col} max_col={max_col} rows={ROWS_TOTAL}")
    for row in range(ROWS_TOTAL):
        parts = [f"r{row:2d}:"]
        for col in range(min_col, max_col + 1):
            tile = grid.get((col, row))
            if tile is None:
                parts.append("???")
            elif tile == EMPTY:
                parts.append(" . ")
            else:
                parts.append(f"{tile:03x}")
        lines.append(" ".join(parts))
    out_path.write_text("\n".join(lines) + "\n", encoding='utf-8')


def main() -> int:
    args = sys.argv[1:]
    report_only = False
    if '--report' in args:
        report_only = True
        args.remove('--report')
    if len(args) < (1 if report_only else 2):
        print(__doc__, file=sys.stderr)
        return 2
    src = Path(args[0])
    text = src.read_text(encoding='utf-8')
    ticks = parse_dumps(text)
    grid = stitch(ticks)

    print(f"ticks parsed:        {len(ticks)}")
    if ticks:
        tnums = [t['tick'] for t in ticks]
        print(f"tick numbers:        {min(tnums)}..{max(tnums)}  ({len(set(tnums))} unique)")
    print(f"cells observed:      {len(grid)}")
    cols_seen = sorted({c for (c, _) in grid.keys()})
    if cols_seen:
        print(f"col range observed:  {cols_seen[0]}..{cols_seen[-1]}  ({cols_seen[-1] - cols_seen[0] + 1} cols)")
    if ticks:
        mario_cols = [t['marioCol'] for t in ticks]
        print(f"mario range visited: {min(mario_cols)}..{max(mario_cols)}")

    if not report_only:
        out = Path(args[1])
        write_fixture(grid, out)
        print(f"fixture written to   {out}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
