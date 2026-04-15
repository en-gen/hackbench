"""
find-overworld-names.py
=======================
Investigates where (if anywhere) level/area names are stored in a vanilla SMW ROM.

Three passes:
  1. ASCII scan  — search the raw binary for printable ASCII strings ≥ 4 chars
                   that look like they could be level names.
  2. Tile-encoded scan — SMW uses an internal font for on-screen text. Known
                   character mappings let us decode tile streams back to ASCII
                   and search those decoded streams for recognisable words.
  3. Overworld event/title table scan — reads bytes around the documented
                   overworld event association table ($05D608) and the level
                   flag initialisation table ($009EE0) to see what's stored near
                   each overworld level slot.

Usage:
    python scripts/find-overworld-names.py <rom.sfc>

Output goes to stdout so you can pipe it:
    python scripts/find-overworld-names.py rom.sfc | tee overworld-names-report.txt
"""

import sys
import struct
import re
from pathlib import Path

# ---------------------------------------------------------------------------
# ROM loading + LoROM helpers
# ---------------------------------------------------------------------------

COPIER_HEADER = 512

def load_rom(path: str) -> tuple[bytes, bool]:
    data = Path(path).read_bytes()
    has_header = (len(data) % 1024) == COPIER_HEADER
    return data, has_header

def lorom_to_offset(snes_addr: int, has_header: bool) -> int | None:
    bank = (snes_addr >> 16) & 0xFF
    addr = snes_addr & 0xFFFF
    eff  = bank & 0x7F
    if eff <= 0x3F:
        if addr < 0x8000:
            return None
        off = eff * 0x8000 + (addr - 0x8000)
    elif eff <= 0x6F:
        off = (eff - 0x40) * 0x10000 + addr
    else:
        return None
    return off + (COPIER_HEADER if has_header else 0)

def read_bytes(rom: bytes, snes_addr: int, length: int, has_header: bool) -> bytes | None:
    off = lorom_to_offset(snes_addr, has_header)
    if off is None or off + length > len(rom):
        return None
    return rom[off:off + length]

def offset_to_snes(file_off: int, has_header: bool) -> int:
    """Reverse LoROM: file offset → SNES address (approximate, bank $00+)."""
    off = file_off - (COPIER_HEADER if has_header else 0)
    if off < 0:
        return -1
    bank = off // 0x8000
    addr = 0x8000 + (off % 0x8000)
    return (bank << 16) | addr


# ---------------------------------------------------------------------------
# Pass 1 — raw ASCII string scan
# ---------------------------------------------------------------------------

LEVEL_KEYWORDS = [
    b"YOSHI", b"DONUT", b"VANILLA", b"FOREST", b"CHOCOLATE", b"VALLEY",
    b"BOWSER", b"BUTTER", b"CHEESE", b"COOKIE", b"SODA", b"STAR",
    b"SPECIAL", b"GHOST", b"IGGY", b"MORTON", b"LEMMY", b"ROY",
    b"WENDY", b"LARRY", b"LUDWIG", b"PLAINS", b"ILLUSION", b"ISLAND",
    b"SWITCH", b"PALACE", b"CASTLE", b"BRIDGE", b"MOUNTAIN", b"SECRET",
    b"TUBULAR", b"GNARLY", b"GROOVY", b"MONDO", b"AWESOME", b"FUNKY",
    b"OUTRAGEOUS",
]

def pass1_ascii_scan(rom: bytes, has_header: bool) -> None:
    print("=" * 70)
    print("PASS 1 — Raw ASCII keyword scan")
    print("=" * 70)

    hits: list[tuple[int, str, bytes]] = []

    for kw in LEVEL_KEYWORDS:
        pos = 0
        while True:
            idx = rom.find(kw, pos)
            if idx < 0:
                break
            snippet = rom[max(0, idx-4):idx+32]
            hits.append((idx, kw.decode(), snippet))
            pos = idx + 1

    if not hits:
        print("  No ASCII keyword hits found in raw binary.\n")
        return

    hits.sort()
    seen_offsets: set[int] = set()
    for off, kw, snippet in hits:
        if any(abs(off - s) < 8 for s in seen_offsets):
            continue   # skip near-duplicate windows
        seen_offsets.add(off)
        snes = offset_to_snes(off, has_header)
        printable = ''.join(chr(b) if 0x20 <= b < 0x7F else '.' for b in snippet)
        print(f"  file ${off:06X}  SNES ~${snes:06X}  kw={kw:<12}  |{printable}|")

    print(f"\n  {len(seen_offsets)} hit region(s) found.\n")


# ---------------------------------------------------------------------------
# Pass 2 — tile-encoded text
#
# SMW on-screen text uses a 1BPP font in VRAM. The tile index for each glyph
# is NOT simple ASCII. The overworld message box and level-intro text use a
# table in the ROM that maps character codes to tile IDs.
#
# Known SMW tile encoding for the overworld message font (verified from
# disassembly references):
#   $00–$09 = '0'–'9'
#   $0A–$23 = 'A'–'Z'  (A=$0A, B=$0B, … Z=$23)
#   $24     = '\''  (apostrophe)
#   $25     = '!'
#   $26     = '.'
#   $27     = '-'
#   $28     = ','
#   $29     = '/'
#   $2A     = ':'
#   $FF     = end / space (varies by context)
#
# Strings are typically terminated by $FF or stored with a fixed length.
# We scan for any byte sequence that decodes to a recognisable word.
# ---------------------------------------------------------------------------

TILE_TO_CHAR: dict[int, str] = {
    **{i: str(i) for i in range(10)},                         # 0–9
    **{0x0A + i: chr(ord('A') + i) for i in range(26)},      # A–Z
    0x24: "'",
    0x25: "!",
    0x26: ".",
    0x27: "-",
    0x28: ",",
    0x29: "/",
    0x2A: ":",
    0xFF: " ",
}

def decode_tile_string(data: bytes, max_len: int = 32) -> str:
    out = []
    for b in data[:max_len]:
        c = TILE_TO_CHAR.get(b)
        if c is None:
            break
        out.append(c)
    return ''.join(out)

TILE_KEYWORDS = [
    "YOSHI", "DONUT", "VANILLA", "FOREST", "CHOCOLATE", "VALLEY",
    "BOWSER", "ISLAND", "PLAINS", "ILLUSION", "GHOST", "CASTLE",
    "STAR", "SPECIAL", "BUTTER", "BRIDGE", "SECRET", "MOUNTAIN",
    "COOKIE", "CHEESE", "SODA", "SWITCH", "PALACE", "TUBULAR",
    "GNARLY", "GROOVY", "AWESOME", "MONDO", "FUNKY", "OUTRAGEOUS",
]

def pass2_tile_scan(rom: bytes, has_header: bool) -> None:
    print("=" * 70)
    print("PASS 2 — Tile-encoded text scan (SMW overworld font)")
    print("=" * 70)
    print("  Tile→char: 0-9=$00-$09  A-Z=$0A-$23  space=$FF  apos=$24")
    print()

    # Only scan ROM data area, skip copier header
    base = COPIER_HEADER if has_header else 0
    hits: list[tuple[int, str]] = []

    for off in range(base, len(rom) - 6):
        decoded = decode_tile_string(rom[off:off + 32])
        if len(decoded) < 4:
            continue
        for kw in TILE_KEYWORDS:
            if kw in decoded:
                hits.append((off, decoded))
                break

    if not hits:
        print("  No tile-encoded keyword hits found.\n")
        return

    # Deduplicate nearby windows
    seen: list[int] = []
    for off, decoded in hits:
        if any(abs(off - s) < 16 for s in seen):
            continue
        seen.append(off)
        snes = offset_to_snes(off, has_header)
        raw = ' '.join(f'{b:02X}' for b in rom[off:off + len(decoded) + 1])
        print(f"  file ${off:06X}  SNES ~${snes:06X}  \"{decoded}\"")
        print(f"    raw: {raw}")

    print(f"\n  {len(seen)} region(s) found.\n")


# ---------------------------------------------------------------------------
# Pass 3 — overworld level slot survey
#
# For each of the 96 overworld-accessible translevel slots (translevel $00–$5F),
# read the 3-byte L1 pointer, the 5-byte primary header, and the event
# association byte at $05D608 + translevel. Print a table so we can see what
# distinguishes each slot and look for any embedded name data nearby.
#
# Pointer table: interleaved at $05E000 + translevel_room_index * 3
#   (room = translevel if ≤ $24, else translevel + $DC)
# ---------------------------------------------------------------------------

L1_PTR_BASE   = 0x05E000
OW_EVENT_BASE = 0x05D608
OW_EXIT_BASE  = 0x04D678

def translevel_to_room(tl: int) -> int:
    return tl if tl <= 0x24 else tl + 0xDC

def pass3_overworld_survey(rom: bytes, has_header: bool) -> None:
    print("=" * 70)
    print("PASS 3 — Overworld level slot survey (96 translevel slots)")
    print("=" * 70)
    print(f"  {'TL':>4}  {'Room':>4}  {'L1 ptr':>8}  {'B0':>2} {'B1':>2} {'B2':>2} {'B3':>2} {'B4':>2}  {'EventAssoc':>10}  {'ExitDir':>7}")
    print(f"  {'-'*4}  {'-'*4}  {'-'*8}  {'-'*2} {'-'*2} {'-'*2} {'-'*2} {'-'*2}  {'-'*10}  {'-'*7}")

    for tl in range(0x60):
        room = translevel_to_room(tl)
        ptr_addr = L1_PTR_BASE + room * 3
        ptr_bytes = read_bytes(rom, ptr_addr, 3, has_header)
        if ptr_bytes is None:
            print(f"  ${tl:02X}   ${room:03X}   [ptr unreadable]")
            continue

        l1_ptr = (ptr_bytes[2] << 16) | (ptr_bytes[1] << 8) | ptr_bytes[0]

        hdr = read_bytes(rom, l1_ptr, 5, has_header) if l1_ptr else None
        b = list(hdr) if hdr else [0xFF] * 5

        event_byte = read_bytes(rom, OW_EVENT_BASE + tl, 1, has_header)
        event_val  = f"${event_byte[0]:02X}" if event_byte else "??"

        exit_byte  = read_bytes(rom, OW_EXIT_BASE + tl, 1, has_header)
        exit_val   = f"${exit_byte[0]:02X}" if exit_byte else "??"

        print(f"  ${tl:02X}   ${room:03X}   ${l1_ptr:06X}    "
              f"{b[0]:02X} {b[1]:02X} {b[2]:02X} {b[3]:02X} {b[4]:02X}  "
              f"{event_val:>10}  {exit_val:>7}")

    print()


# ---------------------------------------------------------------------------
# Pass 4 — look for a level-name pointer table
#
# Lunar Magic inserts level name data into the ROM at extended addresses.
# It typically places a pointer table at a fixed bank and stores null-terminated
# strings. Let's scan bank $1D (a common LM extension bank) and any other
# high-bank regions for clusters of printable ASCII or tile-encoded strings.
# ---------------------------------------------------------------------------

def pass4_extension_banks(rom: bytes, has_header: bool) -> None:
    print("=" * 70)
    print("PASS 4 — Extension bank scan (LM / ExGFX area, banks $1D–$1F, $20+)")
    print("=" * 70)
    print("  Searching for ASCII string clusters that could be a name table...\n")

    # File-offset ranges for extension banks (LoROM: bank*$8000 + $8000 base)
    # Bank $1D: file $E8000–$EFFFF
    # Bank $1E: file $F0000–$F7FFF
    # Bank $1F: file $F8000–$FFFFF
    base = COPIER_HEADER if has_header else 0

    scan_ranges = []
    rom_data_len = len(rom) - base

    # High ROM banks beyond main game data
    for bank in range(0x1D, 0x40):
        file_start = base + bank * 0x8000
        file_end   = file_start + 0x8000
        if file_start >= len(rom):
            break
        scan_ranges.append((bank, file_start, min(file_end, len(rom))))

    MIN_STR = 4
    found_any = False

    for bank, fstart, fend in scan_ranges:
        # Find printable ASCII runs ≥ MIN_STR chars in this bank
        ascii_re = re.compile(b'[ -~]{' + str(MIN_STR).encode() + b',}')
        for m in ascii_re.finditer(rom, fstart, fend):
            text = m.group().decode('ascii', errors='replace')
            if any(kw in text.upper() for kw in
                   ["YOSHI","DONUT","VANILLA","FOREST","CHOCOLATE",
                    "VALLEY","BOWSER","ISLAND","PLAINS","CASTLE",
                    "GHOST","STAR","SPECIAL","WORLD","SWITCH"]):
                off  = m.start()
                snes = offset_to_snes(off, has_header)
                print(f"  Bank ${bank:02X}  file ${off:06X}  SNES ~${snes:06X}  \"{text[:60]}\"")
                found_any = True

    if not found_any:
        print("  No recognisable level-name strings in extension banks.\n")
    else:
        print()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scripts/find-overworld-names.py <rom.sfc>")
        sys.exit(1)

    rom_path = sys.argv[1]
    rom, has_header = load_rom(rom_path)
    print(f"ROM: {rom_path}")
    print(f"Size: {len(rom)} bytes  |  Copier header: {'yes' if has_header else 'no'}\n")

    pass1_ascii_scan(rom, has_header)
    pass2_tile_scan(rom, has_header)
    pass3_overworld_survey(rom, has_header)
    pass4_extension_banks(rom, has_header)

    print("Done. Review the output above to determine where (if anywhere)")
    print("level names are stored. Share the results for next steps.")
