"""
Developer-only script: dump vanilla SMW GFX files to LOCAL fixtures.

========================================================================
  ⚠  HackBench distributes no SMW ROM data, decompressed or otherwise.
     This script produces Nintendo-copyrighted output on YOUR machine
     only. Never commit anything it writes. The output directory is
     gitignored; keep it that way. See docs/testing.md.
========================================================================

For developers who own a legal copy of Super Mario World (USA), this
script builds a local set of LC_LZ2 compressed/decompressed pairs that
can back cross-validation tests for src/rom/LcLz2.ts.

The reference decompressor is the Python `decomp()` from the vendored
snesrev/smw project (tools/vendor/snesrev-smw/util.py, MIT). It's a
completely independent implementation from our TypeScript code, so a
bug in ours will surface as a byte mismatch.

Usage:
  # Place your vanilla ROM first (gitignored):
  #   test/roms/Super Mario World (USA).vanilla.sfc
  #   SHA-1: 6B47BB75D16514B6A476AA0C73A683A2A4C18765
  python tools/dump-vanilla-gfx.py

Reads:   test/roms/Super Mario World (USA).vanilla.sfc   (your ROM)
Writes:  test/fixtures/gfx/GFX<HH>.bin      (decompressed bytes)
         test/fixtures/gfx/GFX<HH>.lz2.bin  (raw compressed slices)

The CI test suite uses *synthetic* LC_LZ2 vectors (no ROM content) in
test/suite/unit/LcLz2.synthetic.test.ts. If you want the richer
fixture-based validation locally, write a *.fixtures.test.ts guarded by
existsSync() — don't commit that file unless it also works fine without
the fixtures present.
"""

import os
import sys

# Make the vendored util.py importable without modifying it.
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "vendor", "snesrev-smw"))

import util  # noqa: E402

REPO_ROOT = os.path.abspath(os.path.join(HERE, os.pardir))
ROM_PATH = os.path.join(REPO_ROOT, "test", "roms", "Super Mario World (USA).vanilla.sfc")
OUT_DIR = os.path.join(REPO_ROOT, "test", "fixtures", "gfx")

# SMW GFX pointer tables (SNES addresses, bank $00).
# Lo/Hi/Bank bytes live at three adjacent 50-byte tables:
#   $00:B992 = lo[50]
#   $00:B9C4 = hi[50]
#   $00:B9F6 = bank[50]
# For index N, pointer = (bank[N] << 16) | (hi[N] << 8) | lo[N]
GFX_PTR_LO_ADDR = 0x00B992
GFX_PTR_HI_ADDR = 0x00B9C4
GFX_PTR_BANK_ADDR = 0x00B9F6
GFX_FILE_COUNT = 50  # vanilla SMW has 50 standard GFX files; indices 0x00–0x31.


def snes_to_file_offset(snes_addr: int) -> int:
    """LoROM: SNES $XXYYYY → file offset ((bank & 0x7F) * 0x8000 + (addr & 0x7FFF))."""
    bank = (snes_addr >> 16) & 0xFF
    off = snes_addr & 0xFFFF
    return (bank & 0x7F) * 0x8000 + (off & 0x7FFF)


def main() -> int:
    if not os.path.isfile(ROM_PATH):
        print(f"ERROR: vanilla ROM not found at {ROM_PATH}", file=sys.stderr)
        return 1

    rom = util.load_rom(ROM_PATH)
    # util.decomp() reads directly from util.ROM's byte array using SNES addresses.
    # It returns a bytearray of the decompressed payload (terminator $FF consumed).

    os.makedirs(OUT_DIR, exist_ok=True)

    print(f"Dumping {GFX_FILE_COUNT} GFX files from {os.path.basename(ROM_PATH)} to "
          f"{os.path.relpath(OUT_DIR, REPO_ROOT)}/")

    for i in range(GFX_FILE_COUNT):
        lo = util.get_byte(GFX_PTR_LO_ADDR + i)
        hi = util.get_byte(GFX_PTR_HI_ADDR + i)
        bank = util.get_byte(GFX_PTR_BANK_ADDR + i)
        snes_ptr = (bank << 16) | (hi << 8) | lo

        # decomp(ea, rb, return_length=True) decompresses and also returns the
        # number of input bytes consumed (including the $FF terminator). We
        # use that length to slice out the exact compressed input.
        decompressed, clen = util.decomp(snes_ptr, rom.get_byte, return_length=True)
        # Slice compressed bytes directly from raw ROM — rom.get_byte() asserts
        # SNES addresses stay in $8000–$FFFF per bank, which a long compressed
        # blob can cross. File offsets don't have that restriction.
        file_off = snes_to_file_offset(snes_ptr)
        compressed = bytes(rom.ROM[file_off:file_off + clen])

        dec_path = os.path.join(OUT_DIR, f"GFX{i:02X}.bin")
        cmp_path = os.path.join(OUT_DIR, f"GFX{i:02X}.lz2.bin")
        with open(dec_path, "wb") as f:
            f.write(bytes(decompressed))
        with open(cmp_path, "wb") as f:
            f.write(compressed)
        print(f"  [{i:2d}] GFX{i:02X}: SNES ${snes_ptr:06X} -> "
              f"compressed {clen:4d}B -> decompressed {len(decompressed):5d}B")

    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
