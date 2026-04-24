#!/usr/bin/env python3
"""
find_sprite_levels.py — scan vanilla SMW ROM for levels containing given sprite IDs.

Usage:
  python tools/scripts/find_sprite_levels.py <sprite_id> [sprite_id ...] [--top N]

sprite_id accepts:  $08  0x08  8  (hex with/without prefix, or decimal)
--top N            show first N levels per sprite (default 5)

Example:
  python tools/scripts/find_sprite_levels.py $08 $09
  python tools/scripts/find_sprite_levels.py 0x05 0x06 0x07 --top 3

Level names come from the Ptrs05EC00 label table in SMWDisX/bank_05.asm so
they stay in sync with the disassembly without any hardcoded mapping.
"""

import sys
import re
import argparse

ROM_PATH   = r"C:\Users\engenb\Super Mario World (USA).vanilla.sfc"
DISASM_PATH = r"C:\Projects\SMWDisX\bank_05.asm"


def snes_to_offset(bank: int, addr: int, header: int = 0) -> int:
    return (bank & 0x7F) * 0x8000 + (addr & 0x7FFF) + header


def parse_sprite_id(s: str) -> int:
    return int(s.lstrip('$'), 16)


def load_level_labels(disasm_path: str) -> dict[int, str]:
    """Parse Ptrs05EC00 from bank_05.asm → {level_index: label_name}."""
    labels: dict[int, str] = {}
    in_table = False
    idx = 0
    with open(disasm_path, encoding='utf-8', errors='replace') as f:
        for line in f:
            stripped = line.strip()
            if stripped == 'Ptrs05EC00:':
                in_table = True
                idx = 0
                continue
            if not in_table:
                continue
            m = re.match(r'dw\s+(\w+)', stripped)
            if m:
                labels[idx] = m.group(1)
                idx += 1
            elif stripped and not stripped.startswith(';'):
                break   # first non-dw, non-blank, non-comment line ends the table
    return labels


def label_display(label: str) -> str:
    """Strip trailing SpritesFFF hex suffix; keep sub-area info readable."""
    # e.g. "DP3Sprites005" → "DP3"
    #      "DSHSub1Sprites0ED" → "DSHSub1"
    #      "TestLevelSprites" → "(test)"
    #      "EmptySprites" → "(empty)"
    if label in ('TestLevelSprites',):
        return '(test level)'
    if label in ('EmptySprites',):
        return '(empty)'
    return re.sub(r'Sprites[0-9A-Fa-f]*$', '', label)


def scan_levels(
    rom: bytes,
    header: int,
    target_ids: set[int],
) -> dict[int, list[int]]:
    """Return {sprite_id: [level_indices ...]} in first-occurrence order."""
    ptr_base = snes_to_offset(0x05, 0xEC00, header)
    found: dict[int, list[int]] = {sid: [] for sid in target_ids}

    for level in range(0x200):
        lo = rom[ptr_base + level * 2]
        hi = rom[ptr_base + level * 2 + 1]
        data_off = snes_to_offset(0x07, (hi << 8) | lo, header)
        if data_off + 4 > len(rom):
            continue

        seen_this_level: set[int] = set()
        i = 1   # byte 0 is the header (SpriteMemorySetting / buoyancy flags)
        while data_off + i + 2 < len(rom):
            if rom[data_off + i] == 0xFF:
                break
            sprite_id = rom[data_off + i + 2]
            if sprite_id in target_ids and sprite_id not in seen_this_level:
                found[sprite_id].append(level)
                seen_this_level.add(sprite_id)
            i += 3

    return found


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Find SMW levels containing the given sprite IDs.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument('sprites', nargs='+', help='Sprite IDs (e.g. $08 0x09 10)')
    parser.add_argument('--top', type=int, default=5, metavar='N',
                        help='Show first N levels per sprite (default: 5)')
    args = parser.parse_args()

    try:
        target_ids = {parse_sprite_id(s) for s in args.sprites}
    except ValueError as exc:
        print(f'error: bad sprite ID — {exc}', file=sys.stderr)
        sys.exit(1)

    with open(ROM_PATH, 'rb') as f:
        rom = f.read()

    header = 512 if len(rom) % 1024 == 512 else 0
    labels = load_level_labels(DISASM_PATH)
    found  = scan_levels(rom, header, target_ids)

    for sid in sorted(target_ids):
        levels = found[sid]
        print(f'\n${sid:02X}  ({len(levels)} levels total)')
        for lvl in levels[:args.top]:
            raw   = labels.get(lvl, '')
            name  = label_display(raw)
            print(f'  ${lvl:03X}  {name}')
        if len(levels) > args.top:
            print(f'  ... and {len(levels) - args.top} more')


if __name__ == '__main__':
    main()
