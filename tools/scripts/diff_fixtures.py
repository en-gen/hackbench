"""Compare two Map16 fixture files cell-by-cell, within the common col range."""
import re, sys

def parse(path):
    min_col = 0
    rows = {}
    with open(path) as f:
        for line in f:
            m = re.match(r'^# min_col=(\d+) max_col=(\d+)', line)
            if m:
                min_col = int(m.group(1))
                continue
            m = re.match(r'^r\s*(\d+):\s*(.*)', line)
            if not m:
                continue
            row = int(m.group(1))
            toks = m.group(2).strip().split()
            rows[row] = toks
    return min_col, rows

a_min, a_rows = parse(sys.argv[1])
b_min, b_rows = parse(sys.argv[2])
common_rows = sorted(set(a_rows) & set(b_rows))
max_common_col = min(a_min + len(a_rows[common_rows[0]]) - 1,
                     b_min + len(b_rows[common_rows[0]]) - 1)
min_common_col = max(a_min, b_min)

diffs = 0
first = []
for row in common_rows:
    ar = a_rows[row]
    br = b_rows[row]
    for col in range(min_common_col, max_common_col + 1):
        at = ar[col - a_min]
        bt = br[col - b_min]
        if at == '???' or bt == '???':
            continue
        if at != bt:
            diffs += 1
            if len(first) < 15:
                first.append((col, row, at, bt))

print(f'common range: col {min_common_col}..{max_common_col}  rows={len(common_rows)}')
print(f'diffs: {diffs}')
for c, r, a, b in first:
    print(f'  col={c:3d} row={r:2d}  A={a:>3}  B={b:>3}')
