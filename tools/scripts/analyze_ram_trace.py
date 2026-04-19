"""
Analyze a WRAM trace from tools/mesen/ram_trace.lua to find byte positions
that stably differ between main-area ($106) and sub-area ($1CA) of a SMW
level.

Segmentation rule: consecutive samples with gameMode == 0x14 form a "level
session". Non-0x14 samples are session boundaries. Re-entering $14 after a
non-$14 gap starts a new session.

Output: top byte positions ranked by (between-session variance / within-session
stability). A position that's always 0x00 in session 1 and always 0x42 in
session 2 is a perfect candidate.

Usage: python tools/scripts/analyze_ram_trace.py tools/mesen/ram_trace.txt
"""
import re, sys
from collections import Counter, defaultdict


def parse_trace(path):
    """Yield (sample_num, game_mode, {range_name: [byte, ...]}) tuples."""
    range_starts = {}  # name -> start-addr, extracted from header comments
    with open(path) as f:
        current = None
        ranges = {}
        for line in f:
            line = line.rstrip()
            m = re.match(r'^# range (\S+)\s+\$([0-9A-Fa-f]+)\.\.\$([0-9A-Fa-f]+)', line)
            if m:
                range_starts[m.group(1)] = int(m.group(2), 16)
                continue
            m = re.match(r'^=== sample (\d+)\s+frames=(\d+)\s+gameMode=([0-9A-Fa-f]+)', line)
            if m:
                if current is not None:
                    yield current['sample'], current['mode'], ranges, range_starts
                current = {'sample': int(m.group(1)), 'mode': int(m.group(3), 16)}
                ranges = {}
                continue
            m = re.match(r'^(\w+):\s+(.*)', line)
            if m and current is not None:
                name = m.group(1)
                hex_bytes = m.group(2).split()
                ranges[name] = [int(h, 16) for h in hex_bytes]
        if current is not None:
            yield current['sample'], current['mode'], ranges, range_starts


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    path = sys.argv[1]

    samples = list(parse_trace(path))
    if not samples:
        print('No samples parsed.')
        sys.exit(1)

    range_starts = samples[0][3]
    print(f'parsed {len(samples)} samples across {len(range_starts)} ranges')

    # Segment by level session: runs of consecutive gameMode == 0x14.
    sessions = []  # list of list-of-sample-indices
    cur = []
    for i, (_, mode, _, _) in enumerate(samples):
        if mode == 0x14:
            cur.append(i)
        else:
            if cur:
                sessions.append(cur)
                cur = []
    if cur:
        sessions.append(cur)

    print(f'found {len(sessions)} level sessions: sizes={[len(s) for s in sessions]}')
    if len(sessions) < 2:
        print('Need >=2 sessions to diff. Enter the sub-area and come back '
              'at least once during the trace.')
        sys.exit(1)

    # For each byte position, collect per-session value distributions.
    # Position key: (range_name, byte_offset).
    session_value_sets = defaultdict(list)  # (range, offset) -> list-of-sets-per-session
    for sess_idxs in sessions:
        per_byte = defaultdict(set)
        for si in sess_idxs:
            _, _, ranges, _ = samples[si]
            for name, vals in ranges.items():
                for off, v in enumerate(vals):
                    per_byte[(name, off)].add(v)
        for k, vs in per_byte.items():
            session_value_sets[k].append(vs)

    # Score each position.
    # Ideal: within each session the set has exactly 1 value, and values
    # differ across sessions. Penalize positions that fluctuate within a
    # session (noise) or are constant across all sessions (useless).
    scored = []
    for (name, off), per_sess in session_value_sets.items():
        if len(per_sess) < len(sessions):
            continue
        session_modes = []
        stability = 0
        for vs in per_sess:
            if len(vs) == 1:
                stability += 1
            session_modes.append(tuple(sorted(vs)))
        distinct_sessions = len(set(session_modes))
        if distinct_sessions < 2:
            continue
        # Score = per-session stability * cross-session diversity.
        score = stability * distinct_sessions
        scored.append((score, name, off, session_modes))

    scored.sort(reverse=True)
    print(f'\ntop candidates (stability × distinct-session-values):')
    print(f'{"score":>5} {"addr":>10}  session values')
    for score, name, off, session_modes in scored[:30]:
        addr = range_starts[name] + off
        vals = '  '.join('{' + ','.join(f'{v:02X}' for v in sm) + '}' for sm in session_modes)
        print(f'{score:>5} ${addr:06X}  {vals}')

    # Also print bytes that are CONSTANT per session AND differ between sessions
    # (the gold standard: unambiguous sublevel indicator).
    print(f'\nstable-per-session AND different-between-sessions (gold candidates):')
    gold = []
    for score, name, off, session_modes in scored:
        if all(len(sm) == 1 for sm in session_modes) and len(set(session_modes)) == len(session_modes):
            gold.append((name, off, session_modes))
    if not gold:
        print('  (none — no byte is 100% stable per session AND fully distinct across all sessions)')
    else:
        for name, off, session_modes in gold[:50]:
            addr = range_starts[name] + off
            vals = ' -> '.join(f'{sm[0]:02X}' for sm in session_modes)
            print(f'  ${addr:06X}  session values: {vals}')


if __name__ == '__main__':
    main()
