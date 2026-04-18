# SNES Graphics Technical Reference

> Compiled from the Mega Cat Studios Super Nintendo Graphics Guide and corroborating technical sources (SNESdev Wiki, SnesLab, Super Famicom Development Wiki).
> Intended as a reference for direct ROM reading and graphics display - no emulation layer.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Memory Areas](#memory-areas)
3. [Color Format (BGR555)](#color-format-bgr555)
4. [CGRAM - Palette Storage](#cgram--palette-storage)
5. [Tile Formats](#tile-formats)
6. [Background Layers](#background-layers)
7. [Tilemaps](#tilemaps)
8. [Sprites and OAM](#sprites-and-oam)
9. [ROM Organization](#rom-organization)
10. [Key PPU Registers](#key-ppu-registers)

---

## System Overview

The SNES PPU (Picture Processing Unit) renders graphics using three dedicated memory regions separate from main RAM:

| Memory | Size | Purpose |
|--------|------|---------|
| VRAM | 64 KB | Tile graphics data + tilemaps |
| CGRAM | 512 bytes | Color palette (256 entries × 2 bytes) |
| OAM | 544 bytes | Sprite attributes (128 sprites) |

The SNES uses **indirect/indexed color**: tile pixels store palette indices, not raw color values. The PPU looks up each index in CGRAM to get the actual display color. This decouples tile shape from color, allowing palette swaps without changing tile data.

**Palette swaps in SMW**: because tile graphics only store *which color slot* each pixel uses (not the color itself), the same tile data can look completely different depending on which CGRAM sub-palette is active. SMW exploits this for: BG palette variants (different sky/terrain colors per level via `bgPalette` header field), FG tile variants (cave vs. overworld via `fgVariant = spriteSet & 0x07`), Mario vs. Luigi vs. Fire forms (row 13 swap), and reusing the same sprite GFX for multiple sprite types via the sprite palette field.

The display resolution is **256×224 pixels** (standard) or 256×239 (overscan). High-resolution modes double the horizontal resolution to 512 pixels.

---

## Memory Areas

### VRAM (64 KB)

- Address range: word-addressed, 0x0000–0x7FFF (16-bit words = 32,768 words = 65,536 bytes)
- Stores both **tile graphics** (bitplane data) and **tilemaps** (background maps)
- Layout within VRAM is configurable via PPU registers; the game chooses where to place tile data and tilemaps
- Accessed CPU-side only during VBlank/forced-blank via registers $2116/$2117 (address), $2118/$2119 (write), $2139/$213A (read)

### CGRAM (512 bytes)

- 256 color entries × 2 bytes each
- Accessed via $2121 (address), $2122 (write), $213B (read)
- Auto-increments address after every 2-byte (word) write

### OAM (544 bytes)

- Split into two tables (see [Sprites and OAM](#sprites-and-oam))
- Accessed via $2102/$2103 (address), $2104 (write), $2138 (read)

---

## Color Format (BGR555)

Each CGRAM entry is a **16-bit word** (2 bytes), little-endian, storing a 15-bit color:

```
Bit:  15  14  13  12  11  10   9   8   7   6   5   4   3   2   1   0
      0   B4  B3  B2  B1  B0  G4  G3  G2  G1  G0  R4  R3  R2  R1  R0
```

Written as two bytes (low byte first):

```
Low byte:  GGGRRRRR  (bits 0–7:  R[4:0] in bits 4–0, G[1:0] in bits 7–5)
High byte: 0BBBBBGG  (bits 8–15: G[4:2] in bits 2–0, B[4:0] in bits 7–3, bit 15 unused)
```

Compact notation: `0BBBBBGG GGGRRRRR`

- Each channel: 5 bits, values 0–31
- Total addressable colors: 32,768 (2^15)
- Bit 15 is always 0 (unused/ignored by hardware)

### Converting to 8-bit RGB for display

To convert a 5-bit channel value to 8-bit:

```
// Simple left-shift (loses precision, common approach)
r8 = r5 << 3;

// More accurate (replicates high bits into low bits)
r8 = (r5 << 3) | (r5 >> 2);
```

The second method maps 0→0 and 31→255 correctly.

---

## CGRAM - Palette Storage

### Layout

CGRAM is 512 bytes = 256 entries of 2 bytes each, organized as 16 sub-palettes of 16 colors:

```
Entry 0–15:    Sub-palette 0  (BG palette 0)
Entry 16–31:   Sub-palette 1  (BG palette 1)
Entry 32–47:   Sub-palette 2  (BG palette 2)
Entry 48–63:   Sub-palette 3  (BG palette 3)
Entry 64–79:   Sub-palette 4  (BG palette 4)
Entry 80–95:   Sub-palette 5  (BG palette 5)
Entry 96–111:  Sub-palette 6  (BG palette 6)
Entry 112–127: Sub-palette 7  (BG palette 7)
Entry 128–143: Sub-palette 8  (Sprite palette 0)
Entry 144–159: Sub-palette 9  (Sprite palette 1)
Entry 160–175: Sub-palette 10 (Sprite palette 2)
Entry 176–191: Sub-palette 11 (Sprite palette 3)
Entry 192–207: Sub-palette 12 (Sprite palette 4)
Entry 208–223: Sub-palette 13 (Sprite palette 5)
Entry 224–239: Sub-palette 14 (Sprite palette 6)
Entry 240–255: Sub-palette 15 (Sprite palette 7)
```

### Background vs. Sprite Palette Split

- **Backgrounds**: use sub-palettes 0–7 (CGRAM entries 0–127)
- **Sprites**: use sub-palettes 8–15 (CGRAM entries 128–255)

### Special Entries

- **Entry 0** (first color of sub-palette 0): the **backdrop color** - displayed where no tile/sprite is rendered, and where all rendering is windowed out
- **Entry 0 of each sub-palette**: treated as **transparent** for tiles and sprites; the pixel is considered see-through

### Palette Usage by Tile Depth

| Tile depth | Colors per tile | Sub-palette size | Entries used |
|-----------|----------------|-----------------|-------------|
| 2bpp | 4 | 4 entries | Selectable from first 8 (BG) or last 8 (sprite) sub-palettes in groups of 4 |
| 4bpp | 16 | 16 entries | One full sub-palette (0–7 for BG, 8–15 for sprites) |
| 8bpp | 256 | 256 entries | Entire CGRAM (entry 0 still transparent) |
| Mode 7 | 256 | 256 entries | Entire CGRAM |

---

## Tile Formats

All SNES tiles are **8×8 pixels**. The SNES uses **planar** (bitplane) storage: each bit of a pixel's color index is stored in a separate plane. Planes are interleaved in pairs.

The number of bitplanes determines the number of colors per tile:

| Format | Bitplanes | Colors per tile | Bytes per tile |
|--------|-----------|----------------|----------------|
| 2bpp | 2 | 4 | 16 |
| 3bpp | 3 | 8 | 24 |
| 4bpp | 4 | 16 | 32 |
| 8bpp | 8 | 256 | 64 |
| Mode 7 | - (chunky) | 256 | 64 |

### 2bpp Format (16 bytes per tile)

Used in: Mode 0 (all BGs), Mode 1 BG3, Mode 4 BG2, Mode 5 BG2

Byte layout (each pair = one pixel row):

```
Byte  0: Row 0, Bitplane 0  (bit 7 = leftmost pixel's bit 0)
Byte  1: Row 0, Bitplane 1  (bit 7 = leftmost pixel's bit 1)
Byte  2: Row 1, Bitplane 0
Byte  3: Row 1, Bitplane 1
...
Byte 14: Row 7, Bitplane 0
Byte 15: Row 7, Bitplane 1
```

To decode pixel at column `c` (0=left, 7=right) of row `r`:

```
bp0 = (byte[r*2 + 0] >> (7 - c)) & 1
bp1 = (byte[r*2 + 1] >> (7 - c)) & 1
paletteIndex = (bp1 << 1) | bp0   // 0–3
```

### 3bpp Format (24 bytes per tile)

Used in: Mode 0 BG3 (rare; SNES has no native 3bpp hardware, requires software handling)

```
Bytes  0–15: Bitplanes 0 and 1, interleaved by row (same as 2bpp)
Bytes 16–23: Bitplane 2, one byte per row (Row 0, Row 1, ... Row 7)
```

Decode:

```
bp0 = (byte[r*2 + 0] >> (7 - c)) & 1
bp1 = (byte[r*2 + 1] >> (7 - c)) & 1
bp2 = (byte[16 + r]  >> (7 - c)) & 1
paletteIndex = (bp2 << 2) | (bp1 << 1) | bp0   // 0–7
```

### 4bpp Format (32 bytes per tile)

Used in: Mode 1 BG1/BG2, Mode 2 BG1/BG2, Mode 3 BG2, Mode 4 BG1 (partial), Mode 5 BG1, Mode 6 BG1, all sprites

This is the most common SNES tile format.

```
Bytes  0–15: Bitplanes 0 and 1, interleaved by row (same as 2bpp)
Bytes 16–31: Bitplanes 2 and 3, interleaved by row

Byte  0: Row 0, BP0
Byte  1: Row 0, BP1
Byte  2: Row 1, BP0
Byte  3: Row 1, BP1
...
Byte 14: Row 7, BP0
Byte 15: Row 7, BP1
Byte 16: Row 0, BP2
Byte 17: Row 0, BP3
Byte 18: Row 1, BP2
Byte 19: Row 1, BP3
...
Byte 30: Row 7, BP2
Byte 31: Row 7, BP3
```

Decode:

```
bp0 = (byte[r*2 + 0]  >> (7 - c)) & 1
bp1 = (byte[r*2 + 1]  >> (7 - c)) & 1
bp2 = (byte[16 + r*2] >> (7 - c)) & 1
bp3 = (byte[17 + r*2] >> (7 - c)) & 1
paletteIndex = (bp3 << 3) | (bp2 << 2) | (bp1 << 1) | bp0   // 0–15
```

### 8bpp Format (64 bytes per tile)

Used in: Mode 3 BG1, Mode 4 BG1 (full 8bpp)

Four interleaved plane pairs, each covering two additional bitplanes per 16-byte block:

```
Bytes  0–15: BP0 and BP1 interleaved (same pattern as 4bpp first half)
Bytes 16–31: BP2 and BP3 interleaved
Bytes 32–47: BP4 and BP5 interleaved
Bytes 48–63: BP6 and BP7 interleaved
```

Decode: combine all 8 bits at column `c`, row `r` across the four pairs:

```
paletteIndex = bp0 | (bp1<<1) | (bp2<<2) | (bp3<<3)
             | (bp4<<4) | (bp5<<5) | (bp6<<6) | (bp7<<7)   // 0–255
```

### Mode 7 Format (64 bytes per tile)

Mode 7 uses a **chunky pixel** format - no bitplanes. Each byte is one pixel's palette index directly:

```
Byte 0: pixel (0,0)   [row 0, col 0]
Byte 1: pixel (0,1)   [row 0, col 1]
...
Byte 7: pixel (0,7)
Byte 8: pixel (1,0)   [row 1, col 0]
...
Byte 63: pixel (7,7)
```

Note: In VRAM, Mode 7 tile data and the tilemap are interleaved - the high byte of each VRAM word is the tile's pixel/graphics byte, and the low byte is the tile's map entry. This is unique to Mode 7.

### Tile Size: 8×8 vs. 16×16

Via register $2105 (bit 4 per BG), tiles can be treated as **16×16** pixels. In this case:

- Each 16×16 tile consists of four 8×8 sub-tiles arranged in a 2×2 grid
- The tilemap entry specifies the top-left sub-tile number
- Top-right = tile + 1, bottom-left = tile + 16, bottom-right = tile + 17
- Sub-tiles must be adjacent in VRAM on a 16-tile-wide grid

---

## Background Layers

The SNES supports 8 BG modes selected by bits 2–0 of register $2105:

### BG Mode Table

| Mode | BG1 | BG2 | BG3 | BG4 | Notes |
|------|-----|-----|-----|-----|-------|
| 0 | 2bpp (4c) | 2bpp (4c) | 2bpp (4c) | 2bpp (4c) | 4 layers, limited colors |
| 1 | 4bpp (16c) | 4bpp (16c) | 2bpp (4c) | - | Most common mode |
| 2 | 4bpp (16c) | 4bpp (16c) | OPT* | - | Offset-per-tile on BG3 |
| 3 | 8bpp (256c) | 4bpp (16c) | - | - | |
| 4 | 8bpp (256c) | 2bpp (4c) | OPT* | - | Offset-per-tile on BG3 |
| 5 | 4bpp (16c) | 2bpp (4c) | - | - | 512-px hires horizontal |
| 6 | 4bpp (16c) | - | OPT* | - | 512-px hires + offset-per-tile |
| 7 | 8bpp (256c) | - | - | - | Matrix transform, 128×128 tilemap |
| 7+EXTBG | 8bpp (256c) | 7bpp* | - | - | Mode 7 with secondary BG layer |

*OPT = Offset-Per-Tile (special scrolling feature). Mode 7 EXTBG BG2 uses 7 bits of color + 1 priority bit.

### Mode 1 Detail (most common)

- BG1: 4bpp, 16 colors per tile, sub-palettes 0–7
- BG2: 4bpp, 16 colors per tile, sub-palettes 0–7
- BG3: 2bpp, 4 colors per tile, sub-palettes 0–7
- BG3 can be given the highest priority (above all others) by setting bit 3 of $2105

### Mode 7 Detail

- Single background layer
- Full affine matrix transformation (rotation, scaling, shearing)
- Tilemap: 128×128 tiles = 16,384 bytes in VRAM
- Tile data: 256 tiles × 64 bytes = 16,384 bytes (chunky format)
- Both tilemap and tile data interleaved in VRAM words
- Supports boundary behavior: tile wrap, screen fill, or transparent outside
- Transformation matrix registers: $211B–$2120

---

## Tilemaps

A tilemap is a 2D array of 16-bit entries stored in VRAM. It describes which tile to draw at each position and how to draw it.

### Tilemap Entry Format (2 bytes per tile)

```
Bit 15:    v  - Vertical flip   (1 = flip tile vertically)
Bit 14:    h  - Horizontal flip (1 = flip tile horizontally)
Bit 13:    o  - Tile priority   (0 = low priority, 1 = high priority)
Bits 12–10: ppp - Palette number (0–7, selects sub-palette)
Bits 9–0:  cccccccccc - Tile index (0–1023)
```

Full bit notation (high byte first): `vhopppcc cccccccc`

### Tilemap Dimensions

Base size is **32×32 tiles** (1024 entries × 2 bytes = 2048 bytes per tilemap).

Extended sizes via bits 0–1 of $2107–$210A:

| Bits | Tilemap Size | Description |
|------|-------------|-------------|
| 00 | 32×32 | 1 tilemap block |
| 01 | 64×32 | 2 tilemap blocks, horizontal |
| 10 | 32×64 | 2 tilemap blocks, vertical |
| 11 | 64×64 | 4 tilemap blocks |

Each additional tilemap block is placed consecutively in VRAM. For a 64×32 map, the second block (for tiles at X ≥ 32) immediately follows the first.

### Tilemap VRAM Address

Register $2107 (BG1), $2108 (BG2), $2109 (BG3), $210A (BG4):

```
Bits 7–2: aaaaaа  - Base address (multiply by 0x800 to get VRAM byte offset)
Bits 1–0: ss      - Size bits (see table above)
```

Example: value $58 = base 0x16 → VRAM byte offset 0x16 × 0x800 = 0xB000

### Tile Index to VRAM Character Data

Character (tile data) base address set by $210B (BG1/BG2) and $210C (BG3/BG4):

```
$210B bits 7–4: BG2 character base (multiply by 0x2000 for VRAM byte offset)
$210B bits 3–0: BG1 character base
$210C bits 7–4: BG4 character base
$210C bits 3–0: BG3 character base
```

VRAM address of tile N's graphics:

```
charBase = (baseField << 13)          // in bytes
tileAddr = charBase + (N × bytesPerTile)

// bytesPerTile: 16 for 2bpp, 32 for 4bpp, 64 for 8bpp
```

For sprites, the name table base is from $2101 bits 5–3 (name select) and bits 2–1 (base):

```
spriteBase = (nameBase << 14)
spriteAddr = spriteBase + (tileNum × 32)   // sprites always 4bpp = 32 bytes
```

---

## Sprites and OAM

### OAM Overview

OAM (Object Attribute Memory) holds data for up to **128 sprites**. Total size: **544 bytes**, split into two tables.

### OAM Table 1 (Low Table - 512 bytes)

4 bytes per sprite, sprites 0–127:

```
Byte 0:  xxxxxxxx  - X position, bits 7–0 (low 8 bits of 9-bit X coordinate)
Byte 1:  yyyyyyyy  - Y position (0–255; sprite appears 1 scanline below Y value)
Byte 2:  cccccccc  - Tile index, bits 7–0 (low 8 bits of 9-bit tile number)
Byte 3:  vhoopppc  - Attribute byte:
           bit 7:   v = vertical flip
           bit 6:   h = horizontal flip
           bits 5–4: oo = priority (0–3; higher = drawn in front of more BG layers)
           bits 3–1: ppp = palette (0–7, selects sprite sub-palette 8–15)
           bit 0:   c = tile index bit 8 (MSB of tile number, for name table selection)
```

### OAM Table 2 (High Table - 32 bytes)

2 bits per sprite; each byte covers 4 consecutive sprites (starting with the lowest index):

```
Bits 1–0: sprite N+0  - bit 1 = size toggle, bit 0 = X coordinate bit 8 (sign bit)
Bits 3–2: sprite N+1
Bits 5–4: sprite N+2
Bits 7–6: sprite N+3
```

Byte 0 covers sprites 0–3, byte 1 covers sprites 4–7, etc.

X coordinate bit 8 functions as a −256 offset. Combined with the low 8 bits, the full 9-bit X is signed and allows sprites to be partially off the left edge of the screen.

### Sprite Sizes

Configured globally for all sprites via $2101 bits 7–5 (`ooo`). Each sprite toggles between the "small" or "large" size using its Table 2 size bit:

| $2101 bits 7–5 | Small | Large |
|---------------|-------|-------|
| 000 | 8×8 | 16×16 |
| 001 | 8×8 | 32×32 |
| 010 | 8×8 | 64×64 |
| 011 | 16×16 | 32×32 |
| 100 | 16×16 | 64×64 |
| 101 | 32×32 | 64×64 |
| 110 | 16×32 | 32×64 |
| 111 | 16×32 | 32×64 |

Sizes 110 and 111 are rectangular; others are square.

### Sprite Tile Organization in VRAM

Sprites always use 4bpp tiles (32 bytes each). The tile grid in VRAM is **16 tiles wide**:

```
Tile N+1:  immediately to the right of tile N   (adjacent in VRAM)
Tile N+16: immediately below tile N
```

A 16×16 sprite = 4 tiles: N, N+1, N+16, N+17.
A 32×32 sprite = 16 tiles: rows of 4 tiles, each row starting 16 tiles below the previous.
A 64×64 sprite = 64 tiles.

$2101 bits 2–1 select the base address for the low name table; bit 0 is unused. The tile index bit 8 (from OAM byte 3 bit 0) selects between the low and high name tables, which are separated by 0x1000 VRAM words (4096 words = 8192 bytes).

### Sprite Priority

Sprites have a 2-bit priority field (0–3) in OAM byte 3. This interacts with BG layer priorities:

| Sprite Priority | Drawn above BG layers |
|----------------|----------------------|
| 3 (highest) | All BG layers |
| 2 | BG1 low, BG2 low, BG3 high/low |
| 1 | BG1 low, BG2 low |
| 0 (lowest) | Only where no BG is drawn |

Within the same priority level, lower OAM index = drawn on top (lower index wins).

### Per-Scanline Limits

- **32 sprites per scanline** maximum (evaluation order: lowest OAM index first)
- **34 sprite slivers per scanline** (an 8-pixel-wide column of a sprite; a 64-wide sprite = 8 slivers)
- Sprites exceeding limits are not rendered (called "sprite overflow" or dropout); lower-priority sprites (higher OAM index) are dropped first

### Sprite Y Coordinate Notes

- Sprite appears at scanline `Y + 1` (hardware adds 1 to Y)
- To hide a sprite off-screen, set Y = 224 (or any value ≥ 224) for 224-line display
- Y wraps: value 240 places sprite near the top of the screen in some configurations

---

## ROM Organization

### ROM Types

SNES ROMs come in two primary memory mapping layouts, identified by the Map Mode byte at ROM offset $FFD5 (or $7FD5 in the file for LoROM):

| Value | Type | Banks | Bytes/Bank | Max ROM Size |
|-------|------|-------|-----------|-------------|
| $20 / $30 | LoROM | $00–$7D, $80–$FF | 32 KB (upper half only) | 4 MB |
| $21 / $31 | HiROM | $C0–$FF | 64 KB | 4 MB |
| $25 / $35 | ExHiROM | Extended | 64 KB | 8 MB |

Speed bit (bit 4 of $FFD5): 0 = SlowROM (2.68 MHz), 1 = FastROM (3.58 MHz).

### ROM Header Location

The internal ROM header occupies CPU addresses $00FFC0–$00FFDF. File offset varies by type:

| ROM Type | File Offset of Header |
|----------|-----------------------|
| LoROM | $007FC0 |
| HiROM | $00FFC0 |
| ExHiROM | $40FFC0 |

Some ROMs have a **512-byte copier header** prepended to the file. If the file size modulo 1024 = 512, subtract 512 from all offsets above.

### ROM Header Fields

All offsets are CPU addresses (subtract bank offset to get file position):

| CPU Addr | Bytes | Field |
|----------|-------|-------|
| $FFC0–$FFD4 | 21 | Game title (uppercase ASCII, space-padded) |
| $FFD5 | 1 | Map mode + ROM speed |
| $FFD6 | 1 | Chipset type |
| $FFD7 | 1 | ROM size: actual size = `1 << N` KB |
| $FFD8 | 1 | RAM size: actual size = `1 << N` KB (0 = no RAM) |
| $FFD9 | 1 | Country/region code |
| $FFDA | 1 | Developer ID |
| $FFDB | 1 | ROM version (0 = v1.0) |
| $FFDC–$FFDD | 2 | Checksum complement (XOR of checksum = $FFFF) |
| $FFDE–$FFDF | 2 | Checksum (sum of all ROM bytes, 16-bit) |

### Address Conversion: ROM File ↔ SNES Bus

**LoROM**: each 32 KB ROM bank maps to the upper half of an SNES bank:

```
SNES bus address $BB:AAAA (BB = bank, AAAA = 0x8000–0xFFFF)
File offset = (BB & 0x7F) * 0x8000 + (AAAA - 0x8000)
```

**HiROM**: each 64 KB ROM bank maps 1:1 to an SNES bank:

```
SNES bus address $BB:AAAA (BB = $C0–$FF)
File offset = (BB - $C0) * 0x10000 + AAAA
// or equivalently, via mirror banks $00-$3F upper 32KB:
File offset = (BB & 0x3F) * 0x10000 + AAAA
```

### Locating Graphics Data in ROM

SNES ROMs have no standardized graphics directory. Graphics tile data is loaded into VRAM at runtime via DMA from arbitrary ROM addresses. To find graphics in a ROM file:

1. Identify the ROM type (LoROM/HiROM) from $FFD5
2. Disassemble initialization code to find DMA transfers that load VRAM (look for writes to $420B with channel pointing to ROM source and VRAM destination)
3. The source address in the DMA control registers ($43x2–$43x4) is the ROM bus address of the tile data
4. Convert the bus address to a file offset using the formula above
5. The tile data at that offset will be in 2bpp, 4bpp, or 8bpp interleaved planar format depending on the BG mode

Super Mario World graphics, as an example, are organized with background tiles in the early banks and sprite tiles loaded dynamically. Many games use compressed graphics (common schemes: LZ77, RLE, Huffman); Super Mario World uses a custom compression scheme.

---

## Key PPU Registers

### Display Control

| Register | Name | Description |
|----------|------|-------------|
| $2100 | INIDISP | Screen on/off, brightness (0–15) |
| $2105 | BGMODE | BG mode (bits 2–0), BG3 priority (bit 3), tile sizes (bits 4–7) |
| $212C | TM | Main screen layer enable (bits: BG1–4, OBJ) |
| $212D | TS | Sub screen layer enable |
| $2133 | SETINI | Interlace, overscan, pseudo-hires, Mode 7 EXTBG |

### Tilemap and Character Base

| Register | Description |
|----------|-------------|
| $2107 | BG1 tilemap base address + size |
| $2108 | BG2 tilemap base address + size |
| $2109 | BG3 tilemap base address + size |
| $210A | BG4 tilemap base address + size |
| $210B | BG1 (low nibble) and BG2 (high nibble) character base |
| $210C | BG3 (low nibble) and BG4 (high nibble) character base |

### Scroll Registers

| Register | Description |
|----------|-------------|
| $210D | BG1 horizontal scroll (write twice: low, high) |
| $210E | BG1 vertical scroll |
| $210F | BG2 horizontal scroll |
| $2110 | BG2 vertical scroll |
| $2111 | BG3 horizontal scroll |
| $2112 | BG3 vertical scroll |
| $2113 | BG4 horizontal scroll |
| $2114 | BG4 vertical scroll |

### VRAM Access

| Register | Description |
|----------|-------------|
| $2115 | Video port control (address increment mode) |
| $2116/$2117 | VRAM word address (low/high byte) |
| $2118/$2119 | VRAM data write (low/high byte) |
| $2139/$213A | VRAM data read |

### CGRAM Access

| Register | Description |
|----------|-------------|
| $2121 | CGRAM byte address (0–511, auto-selects which color/byte) |
| $2122 | CGRAM write (two sequential writes = one color entry) |
| $213B | CGRAM read |

### OAM Access

| Register | Description |
|----------|-------------|
| $2101 | OAM size and name select ($2101 bits 7–5 = size, bits 4–3 = name select, bits 2–1 = base select) |
| $2102/$2103 | OAM address (low/high bits of word address) |
| $2104 | OAM data write |
| $2138 | OAM data read |

### Sprite Register $2101 Detail

```
Bits 7–5: OBJ size select (see sprite size table)
Bits 4–3: Name select - selects which of two 256-tile name tables to use for the high-bit tile slot
           00 = no offset, 01 = +256 tiles, 10 = +512 tiles, 11 = +768 tiles
Bits 2–1: Base select - OAM tile base address = (bits 2–1) × 0x2000 VRAM words
Bit  0:   Unused
```

### DMA Registers (for bulk VRAM loading)

| Register | Description |
|----------|-------------|
| $420B | Start DMA (bit N = enable channel N) |
| $43x0 | Channel X control (direction, type, address increment) |
| $43x1 | B-bus address (PPU register target, e.g., $18 for VRAM data) |
| $43x2/$43x3/$43x4 | A-bus source address (low, high, bank) |
| $43x5/$43x6 | Transfer byte count |

---

## Quick Reference: Decoding a 4bpp Tile from ROM

Given a 32-byte blob at ROM file offset `tileOffset` (after address conversion), decoded as a 4bpp tile:

```javascript
function decode4bppTile(rom, tileOffset) {
  const pixels = new Uint8Array(64); // 8x8

  for (let row = 0; row < 8; row++) {
    const bp01_lo = rom[tileOffset + row * 2];       // BP0
    const bp01_hi = rom[tileOffset + row * 2 + 1];   // BP1
    const bp23_lo = rom[tileOffset + 16 + row * 2];  // BP2
    const bp23_hi = rom[tileOffset + 16 + row * 2 + 1]; // BP3

    for (let col = 0; col < 8; col++) {
      const bit = 7 - col;
      const bp0 = (bp01_lo >> bit) & 1;
      const bp1 = (bp01_hi >> bit) & 1;
      const bp2 = (bp23_lo >> bit) & 1;
      const bp3 = (bp23_hi >> bit) & 1;
      pixels[row * 8 + col] = (bp3 << 3) | (bp2 << 2) | (bp1 << 1) | bp0;
    }
  }

  return pixels; // values 0–15, index into sub-palette
}
```

To convert a palette index to RGB (given a 2-byte CGRAM entry `cgWord`):

```javascript
function cgramEntryToRGB(cgWord) {
  const r5 = (cgWord >> 0) & 0x1F;
  const g5 = (cgWord >> 5) & 0x1F;
  const b5 = (cgWord >> 10) & 0x1F;

  // Scale 5-bit to 8-bit
  return {
    r: (r5 << 3) | (r5 >> 2),
    g: (g5 << 3) | (g5 >> 2),
    b: (b5 << 3) | (b5 >> 2),
  };
}
```

---

## Sources

- [Mega Cat Studios - Super Nintendo Graphics Guide](https://megacatstudios.com/blogs/retro-development/super-nintendo-graphic-guide)
- [SNESdev Wiki - Tiles](https://snes.nesdev.org/wiki/Tiles)
- [SNESdev Wiki - Backgrounds](https://snes.nesdev.org/wiki/Backgrounds)
- [SNESdev Wiki - Palettes / CGRAM](https://snes.nesdev.org/wiki/Palettes)
- [SNESdev Wiki - Sprites](https://snes.nesdev.org/wiki/Sprites)
- [SNESdev Wiki - OAM Layout](https://snes.nesdev.org/wiki/OAM_layout)
- [SNESdev Wiki - Memory Map](https://snes.nesdev.org/wiki/Memory_map)
- [SNESdev Wiki - ROM Header](https://snes.nesdev.org/wiki/ROM_header)
- [SnesLab - Graphics Format](https://sneslab.net/wiki/Graphics_Format)
- [Super Famicom Development Wiki - Backgrounds](https://wiki.superfamicom.org/backgrounds)
- [Super Famicom Development Wiki - SNES Sprites](https://wiki.superfamicom.org/snes-sprites)
- [Super NES Programming / Graphics Tutorial - Wikibooks](https://en.wikibooks.org/wiki/Super_NES_Programming/Graphics_tutorial)
- [Bumbershoot Software - SNES Graphics Data](https://bumbershootsoft.wordpress.com/2023/09/16/snes-graphics-data/)
- [raphnet - SNES Graphics Information](https://www.raphnet.net/divers/retro_challenge_2019_03/qsnesdoc.html)
