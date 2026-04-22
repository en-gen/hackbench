#!/usr/bin/env python
"""
Stitch Map16 level dumps from tools/mesen/auto_walker.lua into a
canonical fixture. Handles both horizontal and vertical levels — each
`dumps.txt` is per-level-id, so orientation is uniform within a file
(we detect it from the tick headers and fail if mixed).

Horizontal tick block:

  === tick N  marioCol=X  range=A..B ===
  r 0: <29-ish tiles, cols A..B>
  r 1: ...
  ...
  r26: ...

Vertical tick block:

  === tick N  marioRow=Y  range=A..B (VERTICAL) ===
  r  0: <32 tiles, cols 0..31>
  r  1: ...
  ...
  rNNN: ...

Each tile is either a 3-hex number or ".". For overlapping cells across
ticks we keep the observation from the tick whose Mario position is
closest to that cell along the main axis (col in horiz, row in vert):
Mario's immediate vicinity is the most recently expanded by SMW and
therefore the most trustworthy.

Usage:
  python stitch_map16_dumps.py <in.txt> <out.txt> [--report]

Inputs and outputs typically live under
  C:/Users/engenb/OneDrive/hackbench-fixtures/maps/<hhh>/
  { dumps.txt, map16.txt }
(see tools/mesen/auto_walker.lua DUMPS_DIR). ROM-derived data is kept out
of the repo; each developer captures from their own legally owned ROM.
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Unified tick header — matches both orientations. The marker group captures
# "Col" or "Row"; the VERTICAL tail is optional (horizontal dumps omit it).
TICK_RE = re.compile(
    r'===\s*tick\s+(\d+)\s+mario(Col|Row)=(-?\d+)\s+range=(-?\d+)\.\.(-?\d+)'
    r'(?:\s+\(VERTICAL\))?\s*==='
)
ROW_RE  = re.compile(r'r\s*(\d+):\s*(.*)')

EMPTY = 0x25
# Horizontal levels always have 27 rows. Vertical levels are always 32 cols
# (2 sub-screens × 16) wide; height depends on LevelScrLength.
HORIZ_ROWS = 27
VERT_COLS  = 32


@dataclass
class Tick:
    tick: int
    vertical: bool
    # Mario's position on the *main* axis for this tick.
    # Horizontal: marioCol. Vertical: marioRow.
    mario_focus: int
    # `range=lo..hi` from the header. Horizontal: col range. Vertical: row range.
    range_lo: int
    range_hi: int
    # row index (absolute in the level) → list of tile IDs along that row.
    rows: dict[int, list[int]] = field(default_factory=dict)


def parse_dumps(text: str) -> list[Tick]:
    ticks: list[Tick] = []
    current: Tick | None = None
    for raw in text.splitlines():
        m = TICK_RE.search(raw)
        if m:
            if current is not None:
                ticks.append(current)
            current = Tick(
                tick=int(m.group(1)),
                vertical=(m.group(2) == 'Row'),
                mario_focus=int(m.group(3)),
                range_lo=int(m.group(4)),
                range_hi=int(m.group(5)),
            )
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
            current.rows[row] = tiles
    if current is not None:
        ticks.append(current)
    return ticks


def detect_orientation(ticks: list[Tick]) -> bool:
    """Return True if the file's ticks are vertical. Abort on mixed files."""
    if not ticks:
        return False
    vert = {t.vertical for t in ticks}
    if len(vert) > 1:
        print(
            "error: dump file mixes horizontal and vertical ticks — "
            "split by level and re-run.",
            file=sys.stderr,
        )
        sys.exit(2)
    return vert.pop()


def stitch(ticks: list[Tick]) -> dict[tuple[int, int], int]:
    """Return {(col,row): tile_id} for each observed cell.

    Selection rules (in priority order):
      1. If any tick observed a non-empty tile at this cell, prefer the
         non-empty observation. Collectible items (coins, dragon coins,
         P-switch blocks, etc.) are removed from Map16 RAM when Mario
         collects them; treating an "after collection" empty observation as
         authoritative would silently drop real level data.
      2. Among observations of the same category (all non-empty, or all
         empty), keep the one whose Mario position is closest to this cell
         along the main axis — col in horizontal, row in vertical.
    """
    # best[(col, row)] = (is_empty, dist, tile)
    best: dict[tuple[int, int], tuple[bool, int, int]] = {}
    for t in ticks:
        for row, tiles in t.rows.items():
            for i, tile in enumerate(tiles):
                if t.vertical:
                    # Vertical: row line already has all 32 cols; col = i.
                    # Distance measured along Y (rows) to Mario's row.
                    if i >= VERT_COLS:
                        break
                    col = i
                    dist = abs(row - t.mario_focus)
                else:
                    # Horizontal: row line covers cols range_lo..range_hi.
                    # Distance measured along X (cols) to Mario's col.
                    col = t.range_lo + i
                    if col > t.range_hi:
                        break
                    dist = abs(col - t.mario_focus)
                is_empty = (tile == EMPTY)
                prev = best.get((col, row))
                if prev is None:
                    best[(col, row)] = (is_empty, dist, tile)
                elif prev[0] and not is_empty:
                    # Upgrade: previous was empty, this is non-empty — take it.
                    best[(col, row)] = (is_empty, dist, tile)
                elif prev[0] == is_empty and dist < prev[1]:
                    # Same category (both empty or both non-empty): closer-to-Mario wins.
                    best[(col, row)] = (is_empty, dist, tile)
    return {k: v[2] for k, v in best.items()}


def write_fixture(
    grid: dict[tuple[int, int], int], out_path: Path, vertical: bool,
) -> None:
    if not grid:
        out_path.write_text("# empty grid\n", encoding='utf-8')
        return

    if vertical:
        # Vertical levels: always 32 cols wide; rows vary with observation range.
        rows_seen = sorted({r for (_, r) in grid})
        min_row, max_row = rows_seen[0], rows_seen[-1]
        row_width = max(3, len(str(max_row)))   # r%Nd format grows with max_row
        lines = [
            f"# level Map16 fixture (VERTICAL). cols 0..{VERT_COLS - 1}, rows {min_row}..{max_row} inclusive.",
            f"# '???' = not observed in any tick; treat as unknown in comparisons.",
            f"# orientation=vertical min_row={min_row} max_row={max_row} cols={VERT_COLS}",
        ]
        for row in range(min_row, max_row + 1):
            parts = [f"r{row:{row_width}d}:"]
            for col in range(VERT_COLS):
                tile = grid.get((col, row))
                if tile is None:
                    parts.append("???")
                elif tile == EMPTY:
                    parts.append(" . ")
                else:
                    parts.append(f"{tile:03x}")
            lines.append(" ".join(parts))
        out_path.write_text("\n".join(lines) + "\n", encoding='utf-8')
        return

    # Horizontal: 27 rows fixed; cols vary with observation range.
    cols = sorted({c for (c, _) in grid})
    min_col, max_col = cols[0], cols[-1]
    lines = [
        f"# level Map16 fixture. col {min_col}..{max_col} inclusive, rows 0..{HORIZ_ROWS - 1}.",
        f"# '???' = not observed in any tick; treat as unknown in comparisons.",
        f"# orientation=horizontal min_col={min_col} max_col={max_col} rows={HORIZ_ROWS}",
    ]
    for row in range(HORIZ_ROWS):
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
    vertical = detect_orientation(ticks)
    grid = stitch(ticks)

    orientation = "vertical" if vertical else "horizontal"
    print(f"orientation:         {orientation}")
    print(f"ticks parsed:        {len(ticks)}")
    if ticks:
        tnums = [t.tick for t in ticks]
        print(f"tick numbers:        {min(tnums)}..{max(tnums)}  ({len(set(tnums))} unique)")
    print(f"cells observed:      {len(grid)}")
    if vertical:
        rows_seen = sorted({r for (_, r) in grid.keys()})
        if rows_seen:
            print(f"row range observed:  {rows_seen[0]}..{rows_seen[-1]}  ({rows_seen[-1] - rows_seen[0] + 1} rows)")
        if ticks:
            mario_rows = [t.mario_focus for t in ticks]
            print(f"mario range visited: row {min(mario_rows)}..{max(mario_rows)}")
    else:
        cols_seen = sorted({c for (c, _) in grid.keys()})
        if cols_seen:
            print(f"col range observed:  {cols_seen[0]}..{cols_seen[-1]}  ({cols_seen[-1] - cols_seen[0] + 1} cols)")
        if ticks:
            mario_cols = [t.mario_focus for t in ticks]
            print(f"mario range visited: col {min(mario_cols)}..{max(mario_cols)}")

    if not report_only:
        out = Path(args[1])
        write_fixture(grid, out, vertical)
        print(f"fixture written to   {out}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
