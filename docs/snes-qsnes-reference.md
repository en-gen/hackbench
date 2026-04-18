# SNES Hardware Quick Reference
## Based on Qwertie's SNES Graphics Documentation (qsnesdoc)

Source: https://www.raphnet.net/divers/retro_challenge_2019_03/qsnesdoc.html

This document consolidates the technically useful information from the qsnesdoc reference for use in a SNES ROM editor/viewer. Focus is on PPU registers, memory layout, data formats, and DMA - everything needed to parse and display graphics from a SNES ROM without emulation.

---

## Table of Contents

1. [PPU Memory Overview](#ppu-memory-overview)
2. [VRAM Layout and Addressing](#vram-layout-and-addressing)
3. [Tilemap Entry Format](#tilemap-entry-format)
4. [Tile (Character) Data Format](#tile-character-data-format)
5. [CGRAM Palette Format](#cgram-palette-format)
6. [OAM Sprite Format](#oam-sprite-format)
7. [Video Modes](#video-modes)
8. [PPU Registers](#ppu-registers)
9. [DMA Registers](#dma-registers)
10. [HDMA Registers and Tables](#hdma-registers-and-tables)
11. [CPU / Interrupt / Joypad Registers](#cpu--interrupt--joypad-registers)
12. [WRAM Access Registers](#wram-access-registers)
13. [Priority / Render Order](#priority--render-order)
14. [Mode 7 Special Format](#mode-7-special-format)

---

## PPU Memory Overview

The SNES PPU has three private memory regions, all separate from main (WRAM) and ROM:

| Region | Size    | Purpose                              | CPU Access Registers         |
|--------|---------|--------------------------------------|------------------------------|
| VRAM   | 64 KB   | Tile graphics data + tilemaps        | $2115–$2119, $2139–$213A     |
| OAM    | 544 B   | Sprite attribute table (128 sprites) | $2101–$2104, $2138           |
| CGRAM  | 512 B   | Color palette (256 entries × 2 B)    | $2121–$2122, $213B           |

All three are write-only during active display; safe to write during V-blank or with screen forced blank ($2100 bit 7 = 1).

---

## VRAM Layout and Addressing

### Address Units

VRAM is addressed in **words** (2 bytes). The registers $2116/$2117 hold a **word address** (0–$7FFF). Byte addresses are word address × 2.

Total VRAM: 65,536 bytes = 32,768 words.

### Tilemap Base Addresses

Registers $2107–$210A specify where each background's tilemap starts in VRAM.

Formula: `word_address = address_bits << 11` (i.e., multiply the 6-bit field by 2048 words = 4096 bytes)

Tilemap sizes by screen size bits:

| Bits 1-0 | Tile Dimensions | Byte Size   |
|----------|-----------------|-------------|
| `00`     | 32×32 tiles     | 2 KB        |
| `01`     | 64×32 tiles     | 4 KB (two 32×32 maps side-by-side) |
| `10`     | 32×64 tiles     | 4 KB (two 32×32 maps stacked)      |
| `11`     | 64×64 tiles     | 8 KB (four 32×32 maps)             |

When width = 64 tiles, there are **two adjacent 32×32 tilemaps** in VRAM, not one 64-wide map. Each 32×32 tilemap is 2 KB (1024 words × 2 bytes).

### Character (Tile) Data Base Addresses

Registers $210B/$210C specify where tile graphics data lives in VRAM.

Formula: `byte_address = address_bits << 13` (i.e., multiply the 4-bit field by 8192 bytes)

- `$210B` bits 3-0: BG1 character base
- `$210B` bits 7-4: BG2 character base
- `$210C` bits 3-0: BG3 character base
- `$210C` bits 7-4: BG4 character base

### Character Address Calculation (Background Tiles)

```
byte_address = (base_location << 13) + (8 × color_depth_in_planes × char_number)
```

Where `color_depth_in_planes`:
- 2bpp tiles: 2 planes → 16 bytes per tile
- 4bpp tiles: 4 planes → 32 bytes per tile
- 8bpp tiles: 8 planes → 64 bytes per tile

### Character Address Calculation (Sprites)

```
byte_address = (base_location << 14) + (32 × char_number)
```

Sprites always use 4bpp (16 colors), so each 8×8 tile = 32 bytes.

Sprite tile data is organized in **16-tile rows** with 512-byte spacing between rows regardless of sprite size. For larger sprites, multiple 8×8 tiles are drawn from adjacent character numbers:
- 16×16 sprite: 4 tiles (2×2 grid)
- 32×32 sprite: 16 tiles (4×4 grid) - tiles stored in interleaved 16-tile rows
- 64×64 sprite: 64 tiles (8×8 grid)

---

## Tilemap Entry Format

Each tilemap entry is **2 bytes** (1 word):

```
High Byte:  v h o p p p c c
Low Byte:   c c c c c c c c
```

| Bits       | Field | Description                                      |
|------------|-------|--------------------------------------------------|
| [15]       | v     | Vertical flip (1 = flip tile vertically)         |
| [14]       | h     | Horizontal flip (1 = flip tile horizontally)     |
| [13]       | o     | Priority bit (tile draws above/below sprites)    |
| [12:10]    | ppp   | Palette number (0–7)                             |
| [9:0]      | cccccccccc | Character (tile) number (0–1023)          |

**Palette indexing:** The palette number selects which sub-palette to use. For BG tiles with N colors, the CGRAM index = `palette_number × N + pixel_value`. For 256-color tiles, the pixel value directly indexes CGRAM (palette field is unused).

---

## Tile (Character) Data Format

SNES tiles use a **planar** (bitplane) format, not packed pixels. Each 8×8 tile's bits are stored across multiple bitplanes.

### 2bpp Tile (4 colors, 16 bytes per tile)

```
Byte  0: Row 0, Plane 0 (bit 0 of each pixel, MSB = leftmost pixel)
Byte  1: Row 0, Plane 1 (bit 1 of each pixel)
Byte  2: Row 1, Plane 0
Byte  3: Row 1, Plane 1
...
Byte 14: Row 7, Plane 0
Byte 15: Row 7, Plane 1
```

### 4bpp Tile (16 colors, 32 bytes per tile)

```
Bytes  0–15: Planes 0–1 for all 8 rows (same as 2bpp above)
Byte  16: Row 0, Plane 2
Byte  17: Row 0, Plane 3
Byte  18: Row 1, Plane 2
Byte  19: Row 1, Plane 3
...
Byte  30: Row 7, Plane 2
Byte  31: Row 7, Plane 3
```

### 8bpp Tile (256 colors, 64 bytes per tile)

```
Bytes  0–31: Planes 0–3 for all 8 rows (same as 4bpp)
Bytes 32–63: Planes 4–7 for all 8 rows (same interleave pattern)
```

### Pixel Value Reconstruction

For each row, read all plane bytes. For each pixel column (bit 7 = leftmost):

```
pixel_value = (plane0_bit << 0) | (plane1_bit << 1) | (plane2_bit << 2) | ...
```

A pixel value of 0 is transparent (for sprites; BG color 0 is backdrop).

---

## CGRAM Palette Format

CGRAM holds 256 color entries, each **2 bytes** (1 word), totaling 512 bytes.

### Color Entry Format

```
Bit:  15  14 13 12 11 10  9  8  7  6  5  4  3  2  1  0
      ?   b  b  b  b  b   g  g  g  g  g  r  r  r  r  r
```

| Bits  | Channel | Range  |
|-------|---------|--------|
| [14:10] | Blue  | 0–31   |
| [9:5]   | Green | 0–31   |
| [4:0]   | Red   | 0–31   |
| [15]    | Unused| Always 0 |

### Converting to 8-bit RGB

```
R8 = (R5 << 3) | (R5 >> 2)   // or simply R5 * 8 for approximate
G8 = (G5 << 3) | (G5 >> 2)
B8 = (B5 << 3) | (B5 >> 2)
```

### Palette Allocation by Layer

- **BG tiles (2bpp / 4 colors):** 8 palettes of 4 colors = 32 CGRAM entries each BG → 4 BGs × 32 = 128 entries used
- **BG tiles (4bpp / 16 colors):** 8 palettes of 16 colors = 128 CGRAM entries per BG
- **BG tiles (8bpp / 256 colors):** 1 palette of 256 colors = all 256 CGRAM entries
- **Sprites (always 4bpp / 16 colors):** Palettes 8–15 = CGRAM entries **128–255** (8 palettes × 16 colors)

Sprite CGRAM starts at entry 128. Sprite palette 0 = entries 128–143, palette 1 = entries 144–159, etc.

---

## OAM Sprite Format

OAM is **544 bytes** total for 128 sprites:
- **Primary table:** 512 bytes = 128 sprites × 4 bytes each
- **Secondary table:** 32 bytes = 2 bits per sprite × 128 sprites

### Primary OAM Entry (4 bytes per sprite)

```
Byte 0: xxxxxxxx   X position (low 8 bits, signed)
Byte 1: yyyyyyyy   Y position (0–255; sprite appears at Y+1)
Byte 2: cccccccc   Character number (low 8 bits of 9-bit value)
Byte 3: vhoopppc
```

**Byte 3 bit fields:**

| Bits  | Field | Description                              |
|-------|-------|------------------------------------------|
| [7]   | v     | Vertical flip                            |
| [6]   | h     | Horizontal flip                          |
| [5:4] | oo    | Priority (0=behind all BG, 3=above all BG)|
| [3:1] | ppp   | Palette (selects palette 8–15 in CGRAM)  |
| [0]   | c     | Character number MSB (bit 8 of 9-bit #)  |

### Secondary OAM Table (32 bytes, 2 bits per sprite)

Each byte covers 4 sprites (2 bits each), sprite 0 in the LSBs of byte 0:

```
Byte N bits: [s1 x1 | s0 x0]   for sprites (N*4)+1 and (N*4)+0
             [s3 x3 | s2 x2]   etc.
```

| Bit | Field | Description                         |
|-----|-------|-------------------------------------|
| 1   | s     | Size toggle (0=small size, 1=large size per $2101) |
| 0   | x     | X position MSB (bit 8, sign extension for X > 255) |

### Sprite Sizes (register $2101 bits 7-5)

| Bits 7-5 | Small Size | Large Size |
|----------|------------|------------|
| `000`    | 8×8        | 16×16      |
| `001`    | 8×8        | 32×32      |
| `010`    | 8×8        | 64×64      |
| `011`    | 16×16      | 32×32      |
| `100`    | 16×16      | 64×64      |
| `101`    | 32×32      | 64×64      |
| `110`    | Undefined  | Undefined  |
| `111`    | Undefined  | Undefined  |

The SNES supports up to 128 sprites total. Behavior when too many large sprites appear on one scanline is undefined (hardware typically disables excess sprites).

---

## Video Modes

Set by register $2105 bits 2-0.

### Mode Color Depths per Background

| Mode | BG1       | BG2       | BG3       | BG4       | Notes                        |
|------|-----------|-----------|-----------|-----------|------------------------------|
| 0    | 2bpp (4)  | 2bpp (4)  | 2bpp (4)  | 2bpp (4)  | 128 total colors             |
| 1    | 4bpp (16) | 4bpp (16) | 2bpp (4)  | -         | Most common mode             |
| 2    | 4bpp (16) | 4bpp (16) | -         | -         | Offset-per-tile scroll       |
| 3    | 8bpp (256)| 4bpp (16) | -         | -         |                              |
| 4    | 8bpp (256)| 2bpp (4)  | -         | -         | Offset-per-tile scroll       |
| 5    | 4bpp (16) | 2bpp (4)  | -         | -         | 512-pixel wide (interlaced)  |
| 6    | 4bpp (16) | -         | -         | -         | 512-wide + offset-per-tile   |
| 7    | 8bpp (256)| -         | -         | -         | Rotation/scaling; special VRAM layout |

### Palette Counts per Mode

| Mode | BG1 Palettes | BG2 Palettes | BG3 Palettes | BG4 Palettes |
|------|-------------|-------------|-------------|-------------|
| 0    | 8           | 8           | 8           | 8           |
| 1    | 8           | 8           | 8           | -           |
| 2    | 8           | 8           | -           | -           |
| 3    | 1 (direct)  | 8           | -           | -           |
| 4    | 1 (direct)  | 8           | -           | -           |
| 5    | 8           | 8           | -           | -           |
| 6    | 8           | -           | -           | -           |
| 7    | 1 (direct)  | -           | -           | -           |

### Tile Size Options (register $2105 bits 7-4)

Register $2105 bits 7-4 (`dcba`) set tile size per BG layer:
- `a` (bit 4): BG1 tile size - 0=8×8, 1=16×16
- `b` (bit 5): BG2 tile size - 0=8×8, 1=16×16
- `c` (bit 6): BG3 tile size - 0=8×8, 1=16×16
- `d` (bit 7): BG4 tile size - 0=8×8, 1=16×16

16×16 BG tiles are composed of four 8×8 character tiles arranged 2×2.

---

## PPU Registers

All addresses are in the CPU's $00 bank ($0000–$FFFF).

### Screen Display

#### $2100 - Screen Display (W)
```
Bit 7:    d    Force blank (1 = screen off/black)
Bits 3-0: bbbb Brightness (0=off, 15=full)
```

#### $2105 - Screen Mode and Tile Size (W)
```
Bit 7:    d    BG4 tile size (0=8×8, 1=16×16)
Bit 6:    c    BG3 tile size
Bit 5:    b    BG2 tile size
Bit 4:    a    BG1 tile size
Bit 3:    p    Mode 1 priority (see Priority section)
Bits 2-0: mmm  Video mode (0–7)
```

### Background Control

#### $2107 - BG1 Tilemap Address and Size (W)
#### $2108 - BG2 Tilemap Address and Size (W)
#### $2109 - BG3 Tilemap Address and Size (W)
#### $210A - BG4 Tilemap Address and Size (W)
```
Bits 7-2: aaaaaa  Tilemap VRAM word address = value << 11
Bits 1-0: ss      Screen size (00=32×32, 01=64×32, 10=32×64, 11=64×64)
```

#### $210B - BG1/BG2 Character Data Address (W)
```
Bits 7-4: bbbb  BG2 character base address = value << 13 (bytes)
Bits 3-0: aaaa  BG1 character base address = value << 13 (bytes)
```

#### $210C - BG3/BG4 Character Data Address (W)
```
Bits 7-4: dddd  BG4 character base address = value << 13 (bytes)
Bits 3-0: cccc  BG3 character base address = value << 13 (bytes)
```

### Scroll Registers

All scroll registers are **double-write** (write twice to set 11 bits). Written as: first write = bits [7:0], second write = bits [10:8] in low 3 bits (bits [7:3] are previous high bits, partially).

The actual scroll behavior for double-write: write low byte first, then high byte (only bits 2-0 matter for bits 10-8 of the 11-bit value).

#### $210D - BG1 Horizontal Scroll / Mode 7 X (W, double-write)
#### $210E - BG1 Vertical Scroll / Mode 7 Y (W, double-write)
#### $210F - BG2 Horizontal Scroll (W, double-write)
#### $2110 - BG2 Vertical Scroll (W, double-write)
#### $2111 - BG3 Horizontal Scroll (W, double-write)
#### $2112 - BG3 Vertical Scroll (W, double-write)
#### $2113 - BG4 Horizontal Scroll (W, double-write)
#### $2114 - BG4 Vertical Scroll (W, double-write)

Scroll range: 0–1023 pixels (11-bit value). Bits 10-8 apply to Mode 7 extended fields.

### VRAM Access

#### $2115 - VRAM Port Control (W)
```
Bit 7:    i    Increment timing (0=after $2118/$2139, 1=after $2119/$213A)
Bits 5-4: ff   Full graphic (address remapping, usually 00)
Bits 1-0: rr   Increment rate:
               00 = +1 word (2 bytes)
               01 = +32 words (64 bytes)
               10 = +128 words (256 bytes)
               11 = +128 words (256 bytes)
```

Bits 5-4 remap VRAM addresses for specific column-based tile access patterns (set to `00` for normal sequential access).

#### $2116 - VRAM Address Low (W)
#### $2117 - VRAM Address High (W)

Sets 16-bit **word address** (0–$7FFF) for VRAM operations. Write low byte first, then high byte.

#### $2118 - VRAM Data Write Low (W)
#### $2119 - VRAM Data Write High (W)

Write to VRAM at address set by $2116/$2117. Auto-increments based on $2115.

#### $2139 - VRAM Data Read Low (R)
#### $213A - VRAM Data Read High (R)

Read from VRAM. **A dummy read is required after writing the address** before actual data is valid. Auto-increments based on $2115.

### OAM Access

#### $2101 - OAM Size and Character Address (W)
```
Bits 7-5: sss  Sprite size selection (see size table)
Bits 4-2: nnn  Name selection (additional sprite name table offset - limited documentation)
Bits 1-0: bb   Sprite character base = value << 14 (byte address)
```

#### $2102 - OAM Address Low (W)
```
Bits 7-0: aaaaaaaa  Low byte of OAM byte address
```

#### $2103 - OAM Address High (W)
```
Bit 7:  r  OAM priority rotation (1 = rotate first-rendered sprite)
Bit 0:  m  OAM address MSB (bit 8; set to 1 to access secondary table at bytes 512–543)
```

Set $2103 then $2102 together to specify OAM access address.

#### $2104 - OAM Data Write (W)
```
Bits 7-0: dddddddd  Data byte to write to OAM
```

Writes are buffered in pairs; primary OAM is written in pairs only.

#### $2138 - OAM Data Read (R)
```
Bits 7-0: dddddddd  Data byte read from OAM
```

### CGRAM Access

#### $2121 - CGRAM Address (W)
```
Bits 7-0: aaaaaaaa  CGRAM word address (0–255)
```

#### $2122 - CGRAM Data Write (W)
```
Bits 7-0: dddddddd  Data byte (write twice: low byte then high byte per color entry)
```

#### $213B - CGRAM Data Read (R)
```
Bits 7-0: dddddddd  Data byte (read twice per entry)
```

### Layer Enable

#### $212C - Main Screen Designation (W)
#### $212D - Sub Screen Designation (W)
```
Bit 4: s  Sprites enable
Bit 3: d  BG4 enable
Bit 2: c  BG3 enable
Bit 1: b  BG2 enable
Bit 0: a  BG1 enable
```

### Window Registers

#### $2123 - Window Mask Settings for BG1 and BG2 (W)
```
Bits 7-4: BG2 window settings
Bits 3-0: BG1 window settings
```

#### $2124 - Window Mask Settings for BG3 and BG4 (W)
```
Bits 7-4: BG4 window settings
Bits 3-0: BG3 window settings
```

#### $2125 - Window Mask Settings for OBJ and Color (W)
```
Bits 7-4: Color/math window settings
Bits 3-0: Sprite window settings
```

Per 4-bit group: `dcba`
- bit 3 (d): Enable window 2
- bit 2 (c): Window 2 invert (clip outside if 0, inside if 1)
- bit 1 (b): Enable window 1
- bit 0 (a): Window 1 invert

#### $2126 - Window 1 Left Position (W)
#### $2127 - Window 1 Right Position (W)
#### $2128 - Window 2 Left Position (W)
#### $2129 - Window 2 Right Position (W)
```
Bits 7-0: xxxxxxxx  X pixel position (0–255)
```

#### $212A - Mask Logic for BGs (W)
```
Bits 7-6: BG4 window logic
Bits 5-4: BG3 window logic
Bits 3-2: BG2 window logic
Bits 1-0: BG1 window logic
```

Logic values: `00`=OR, `01`=AND, `10`=XOR, `11`=XNOR

#### $212B - Mask Logic for OBJ and Color (W)
```
Bits 3-2: Color window logic
Bits 1-0: Sprite window logic
```

Same logic values as $212A.

#### $212E - Main Screen Window Mask Designation (W)
#### $212F - Sub Screen Window Mask Designation (W)
```
Bit 4: s  Sprites window enable
Bit 3: d  BG4 window enable
Bit 2: c  BG3 window enable
Bit 1: b  BG2 window enable
Bit 0: a  BG1 window enable
```

### Scan Counter / Latch

#### $2137 - Software H/V Counter Latch (R)

Reading latches current H/V beam position into $213C/$213D. No useful return value.

#### $213C - Horizontal Scan Location (R, double-read)
```
Bits 8-0: lllllllll  Current horizontal pixel position
```

#### $213D - Vertical Scan Location (R, double-read)
```
Bits 8-0: lllllllll  Current scanline number
```

---

## DMA Registers

The SNES has **8 DMA channels** (channels 0–7). Register addresses for channel N: replace `X` with `0`–`7` in `$43X?`.

### DMA Initiation

#### $420B - DMA Enable (W)
```
Bits 7-0: One bit per channel; write 1 to start that channel's transfer
          Bit 7 = Channel 7, Bit 0 = Channel 0
```

#### $420C - HDMA Enable (W)
```
Bits 7-0: One bit per channel; write 1 to enable HDMA on that channel
```

### Per-Channel Registers

#### $43X0 - DMA/HDMA Control (W)
```
Bit 7:    d    Direction (0=CPU→PPU, 1=PPU→CPU) [DMA only]
Bit 6:    a    Indirect addressing mode [HDMA only]
Bit 3:    i    Fixed address (1=source/dest address does not increment)
Bit 2:    f    Address decrement (0=increment, 1=decrement) [ignored if bit 3=1]
Bits 2-0: ttt  Transfer type (see table)
```

**Transfer type table:**

| `ttt` | Pattern              | Registers Written Per "Unit"   |
|-------|----------------------|--------------------------------|
| `000` | 1 register × 1       | Dest+0                         |
| `001` | 2 registers × 1      | Dest+0, Dest+1                 |
| `010` | 1 register × 2       | Dest+0, Dest+0                 |
| `011` | 2 registers × 2      | Dest+0, Dest+1, Dest+0, Dest+1 |
| `100` | 4 registers × 1      | Dest+0, Dest+1, Dest+2, Dest+3 |
| `101–111` | Undefined       | -                              |

Note: Types `000` and `010` appear identical but behave differently in HDMA mode.

#### $43X1 - DMA Destination Register (W)
```
Bits 7-0: bbbbbbbb  Register offset added to $2100
                    e.g., $18 → writes to $2118 (VRAM data)
```

Common destination values:
- `$04` → $2104 (OAM data)
- `$18` → $2118 (VRAM low byte)
- `$19` → $2119 (VRAM high byte)
- `$22` → $2122 (CGRAM data)

#### $43X2 - DMA Source Address Low (W)
#### $43X3 - DMA Source Address High (W)
#### $43X4 - DMA Source Address Bank (W)

Together: 24-bit source address in CPU address space.

#### $43X5 - DMA Byte Count Low (W) [DMA only]
#### $43X6 - DMA Byte Count High (W) [DMA only]

16-bit byte count. Value `$0000` = transfer 65536 bytes.

#### $43X7 - HDMA Indirect Bank (W) [HDMA only]

Bank byte for the indirect data address in indirect HDMA mode.

#### $43X8 - HDMA Table Address Low (RW) [HDMA]
#### $43X9 - HDMA Table Address High (RW) [HDMA]

16-bit pointer to current position in the HDMA table (auto-updated during HDMA operation).

#### $43XA - HDMA Scanline Counter (RW) [HDMA]

Remaining scanlines for current HDMA table segment (auto-updated).

### Typical DMA Usage (VRAM Transfer)

To copy tile data from ROM/RAM to VRAM:
1. Write VRAM word address to $2116/$2117
2. Set $2115 = $80 (increment after high byte write)
3. Set $4300 = $01 (channel 0: CPU→PPU, 2-reg transfer to consecutive addresses)
4. Set $4301 = $18 (destination = $2118, VRAM low)
5. Set $4302/$4303/$4304 = source 24-bit address
6. Set $4305/$4306 = byte count
7. Write $01 to $420B to start

---

## HDMA Registers and Tables

HDMA (H-blank DMA) runs automatically every scanline, writing values to PPU registers to create per-scanline effects (gradients, wavy distortion, window animations, etc.).

### HDMA Table Format - Direct Mode (bit 6 of $43X0 = 0)

Each segment in the table:

```
[count_byte] [data0] [data1] ...   (data bytes = transfer-type width)
[count_byte] [data0] [data1] ...
...
[00]                               (terminator)
```

**Count byte:**
- Bits 6-0: Number of scanlines to apply this data
- Bit 7: Continuous mode (0=write once at start of segment, 1=write every scanline)

With transfer type `001` (2 bytes), each segment has 2 data bytes. With type `000` (1 byte), 1 data byte.

### HDMA Table Format - Indirect Mode (bit 6 of $43X0 = 1)

```
[count_byte] [addr_low] [addr_high]
[count_byte] [addr_low] [addr_high]
...
[00]
```

The 16-bit address (addr_low, addr_high) combined with the bank in `$43X7` forms a 24-bit pointer to where the actual data values are stored. HDMA fetches values from that location rather than from the table itself.

### Continuous vs. One-Shot Mode

- **One-shot (bit 7 of count = 0):** Data is written only on the first scanline of the segment; the PPU register holds that value for N scanlines.
- **Continuous (bit 7 of count = 1):** Data is written every scanline. The table must contain enough data words for each scanline.

---

## CPU / Interrupt / Joypad Registers

### Interrupt and Timing

#### $4200 - Interrupt Enable and Joypad Request (W)
```
Bit 7: n  NMI enable (V-blank interrupt)
Bit 5: v  V-counter IRQ enable
Bit 4: h  H-counter IRQ enable
Bit 0: j  Auto-read joypad enable
```

#### $4207 - H-Count IRQ Trigger Low (W)
#### $4208 - H-Count IRQ Trigger High (W)
```
Bits 8-0: lllllllll  Horizontal pixel position to fire IRQ
```

#### $4209 - V-Count IRQ Trigger Low (W)
#### $420A - V-Count IRQ Trigger High (W)
```
Bits 8-0: lllllllll  Scanline number to fire IRQ
```

#### $4210 - NMI Flag (R)
```
Bit 7:    n     NMI occurred (1=yes, cleared on read)
Bits 3-0: vvvv  Chip version number
```

#### $4211 - IRQ Flag (R)
```
Bit 7: i  IRQ occurred (1=yes, cleared on read)
```

#### $4212 - PPU Status (R)
```
Bit 7: v  In V-blank (1=yes)
Bit 6: h  In H-blank (1=yes)
Bit 0: j  Joypad auto-read complete (1=ready)
```

### Joypad

#### $4218/$4219 - Joypad 1 Auto-Read Data (R)
#### $421A/$421B - Joypad 2 Auto-Read Data (R)
#### $421C/$421D - Joypad 3 Auto-Read Data (R)
#### $421E/$421F - Joypad 4 Auto-Read Data (R)

Auto-read data is available after $4212 bit 0 goes high.

**Joypad data layout (16 bits, $421N = high byte, $421N+1 = low byte):**

| Bit | Button     |
|-----|------------|
| 15  | B          |
| 14  | Y          |
| 13  | Select     |
| 12  | Start      |
| 11  | Up         |
| 10  | Down       |
| 9   | Left       |
| 8   | Right      |
| 7   | A          |
| 6   | X          |
| 5   | L          |
| 4   | R          |
| 3-0 | (unused, 0)|

#### $4016 - Old-Style Joypad 1 (RW)
#### $4017 - Old-Style Joypad 2 (RW)

Write any value to strobe (latch) buttons. Read bit 0 repeatedly to get button states serially.

### Multiplication / Division

#### $4202 - Multiplicand (W)
#### $4203 - Multiplier (W)

Write both; result appears in $4216/$4217 after ~8 cycles. 8×8 → 16-bit unsigned.

#### $4204 - Dividend Low (W)
#### $4205 - Dividend High (W)
#### $4206 - Divisor (W)

Write dividend then divisor; 16÷8 unsigned. Quotient in $4214/$4215, remainder in $4216/$4217.

#### $4214 - Quotient Low (R)
#### $4215 - Quotient High (R)
#### $4216 - Product/Remainder Low (R)
#### $4217 - Product/Remainder High (R)

---

## WRAM Access Registers

The WRAM (128 KB main RAM) can be accessed via the CPU bus normally ($7E0000–$7FFFFF) or via these registers:

#### $2180 - WRAM Data (RW)
```
Bits 7-0: dddddddd  Read/write byte at current WRAM address
```

Auto-increments the address after each access.

#### $2181 - WRAM Address Low (W)
#### $2182 - WRAM Address High (W)
#### $2183 - WRAM Address Bank (W)
```
Bits 16-0: xxxxxxxxxxxxxxxxx  17-bit WRAM address (bits above 16 ignored)
```

---

## Priority / Render Order

The SNES renders layers back-to-front. The order depends on the video mode and the priority bit (o) in each tilemap entry and the priority bits (oo) in each sprite's OAM byte 3.

### Standard Priority Order (all modes, or Mode 1 with p=0)

Back (drawn first) → Front (drawn last):

| Order | Layer           | Priority bit |
|-------|-----------------|-------------|
| 1     | BG4             | o=0         |
| 2     | BG3             | o=0         |
| 3     | Sprites         | oo=00       |
| 4     | BG4             | o=1         |
| 5     | BG3             | o=1         |
| 6     | Sprites         | oo=01       |
| 7     | BG2             | o=0         |
| 8     | BG1             | o=0         |
| 9     | Sprites         | oo=10       |
| 10    | BG2             | o=1         |
| 11    | BG1             | o=1         |
| 12    | Sprites         | oo=11       |

### Mode 1 with p=1 ($2105 bit 3 = 1)

BG3 priority-1 tiles are elevated above sprites with priority 1 and BG1/BG2 priority-0 tiles:

| Order | Layer           | Priority bit |
|-------|-----------------|-------------|
| 1     | BG4             | o=0         |
| 2     | BG3             | o=0         |
| 3     | Sprites         | oo=00       |
| 4     | BG3             | o=1         |  ← elevated
| 5     | BG2             | o=0         |
| 6     | BG1             | o=0         |
| 7     | BG2             | o=1         |
| 8     | Sprites         | oo=01       |
| 9     | BG1             | o=1         |
| 10    | Sprites         | oo=10 and 11|

The p-bit is **only effective in Mode 1**; in all other modes the priority system behaves as if p=0.

---

## Mode 7 Special Format

Mode 7 is completely different from all other modes.

### VRAM Layout

Mode 7 uses the **first 32 KB of VRAM** (bytes $0000–$7FFF). Data is interleaved word-by-word:

```
Word 0:  Low byte  = Tilemap entry for tile (0,0)
         High byte = Graphic pixel data for tile 0, pixel 0
Word 1:  Low byte  = Tilemap entry for tile (1,0)
         High byte = Graphic pixel data for tile 0, pixel 1
...
```

The tilemap covers a 128×128 tile grid (16,384 entries). Each entry is simply a **tile number** (0–255).

### Tile Graphics

- 256 tiles total
- Each tile is 8×8 pixels
- Each pixel is 1 byte (8bpp, 256 colors)
- Tile N's graphics data starts at word address: `64 × N` → byte offset `128 × N`
- Graphics data is interleaved within the same memory space as the tilemap

### Color

Single palette of 256 colors; pixel value directly indexes CGRAM entry 0–255. Color 0 is the background/transparent color.

### Rotation and Scaling

Mode 7 supports affine transformation via scroll registers $210D/$210E and additional write-only registers around $211A–$2120 (transformation matrix A, B, C, D and center X/Y). These are not fully documented in the qsnesdoc source but the mode is commonly used for pseudo-3D floor/ceiling effects.

The `EXTBG` bit (bit 6 of $2133) enables a second BG layer in Mode 7 using the graphic data's upper bit as a priority flag.

---

## APU / SPC700 Communication

The SPC700 audio processor has 4 communication ports shared with the main CPU:

| CPU Address | SPC700 Address | Direction | Description          |
|-------------|----------------|-----------|----------------------|
| $2140       | $00F4          | RW        | Communication port 0 |
| $2141       | $00F5          | RW        | Communication port 1 |
| $2142       | $00F6          | RW        | Communication port 2 |
| $2143       | $00F7          | RW        | Communication port 3 |

The CPU writes to $2140–$2143 to send data to the SPC700; the SPC700 writes to $00F4–$00F7 to send data back to the CPU. These ports are the only communication channel between the two processors. The SPC700 boot ROM must be initialized before audio programs can be loaded.

---

## Quick Address Reference

### PPU Write-Only Registers ($21xx)

| Address | Register Name              | Notes                          |
|---------|----------------------------|--------------------------------|
| $2100   | Screen Display             | Force blank, brightness        |
| $2101   | OAM Size and Name Select   | Sprite sizes, base address     |
| $2102   | OAM Address Low            |                                |
| $2103   | OAM Address High + Rotate  |                                |
| $2104   | OAM Data Write             |                                |
| $2105   | BG Mode and Tile Size      | Mode 0-7, BG tile sizes        |
| $2106   | Screen Pixelation          | (mosaic effect)                |
| $2107   | BG1 Tilemap Address+Size   |                                |
| $2108   | BG2 Tilemap Address+Size   |                                |
| $2109   | BG3 Tilemap Address+Size   |                                |
| $210A   | BG4 Tilemap Address+Size   |                                |
| $210B   | BG1/BG2 Character Address  |                                |
| $210C   | BG3/BG4 Character Address  |                                |
| $210D   | BG1 H-Scroll / M7 X        | Double-write                   |
| $210E   | BG1 V-Scroll / M7 Y        | Double-write                   |
| $210F   | BG2 H-Scroll               | Double-write                   |
| $2110   | BG2 V-Scroll               | Double-write                   |
| $2111   | BG3 H-Scroll               | Double-write                   |
| $2112   | BG3 V-Scroll               | Double-write                   |
| $2113   | BG4 H-Scroll               | Double-write                   |
| $2114   | BG4 V-Scroll               | Double-write                   |
| $2115   | VRAM Port Control          | Increment mode                 |
| $2116   | VRAM Address Low           |                                |
| $2117   | VRAM Address High          |                                |
| $2118   | VRAM Data Write Low        |                                |
| $2119   | VRAM Data Write High       |                                |
| $211A   | Mode 7 Setting             |                                |
| $211B   | Mode 7 Matrix A Low        | Double-write                   |
| $211C   | Mode 7 Matrix B Low        | Double-write                   |
| $211D   | Mode 7 Matrix C Low        | Double-write                   |
| $211E   | Mode 7 Matrix D Low        | Double-write                   |
| $211F   | Mode 7 Center X            | Double-write                   |
| $2120   | Mode 7 Center Y            | Double-write                   |
| $2121   | CGRAM Address              |                                |
| $2122   | CGRAM Data Write           | Double-write per color         |
| $2123   | Window BG1/BG2 Settings    |                                |
| $2124   | Window BG3/BG4 Settings    |                                |
| $2125   | Window OBJ/Color Settings  |                                |
| $2126   | Window 1 Left              |                                |
| $2127   | Window 1 Right             |                                |
| $2128   | Window 2 Left              |                                |
| $2129   | Window 2 Right             |                                |
| $212A   | BG Window Logic            | OR/AND/XOR/XNOR                |
| $212B   | OBJ/Color Window Logic     |                                |
| $212C   | Main Screen Enable         | Which layers are on            |
| $212D   | Sub Screen Enable          |                                |
| $212E   | Main Screen Window Mask    |                                |
| $212F   | Sub Screen Window Mask     |                                |
| $2130   | Color Addition Select      | Which layers use color math    |
| $2131   | Color Math Designation     | Add/subtract, which layers     |
| $2132   | Fixed Color Data           | Color for color math           |
| $2133   | Screen Mode/Video Select   | EXTBG, pseudo-hi-res, etc.     |

### PPU Read-Only Registers

| Address | Register Name              | Notes                          |
|---------|----------------------------|--------------------------------|
| $2134   | Multiplication Result Low  | M7A × M7B product              |
| $2135   | Multiplication Result Mid  |                                |
| $2136   | Multiplication Result High |                                |
| $2137   | Software H/V Latch         | Read to latch beam position    |
| $2138   | OAM Data Read              |                                |
| $2139   | VRAM Data Read Low         |                                |
| $213A   | VRAM Data Read High        |                                |
| $213B   | CGRAM Data Read            | Double-read per color          |
| $213C   | Horizontal Scan Count      | Double-read for 9 bits         |
| $213D   | Vertical Scan Count        | Double-read for 9 bits         |
| $213E   | PPU1 Status                |                                |
| $213F   | PPU2 Status                |                                |

### CPU Registers ($42xx–$43xx)

| Address | Register Name              |
|---------|----------------------------|
| $4200   | Interrupt Enable           |
| $4201   | Programmable I/O Port      |
| $4202   | Multiplicand               |
| $4203   | Multiplier                 |
| $4204   | Dividend Low               |
| $4205   | Dividend High              |
| $4206   | Divisor                    |
| $4207   | H-Count IRQ Low            |
| $4208   | H-Count IRQ High           |
| $4209   | V-Count IRQ Low            |
| $420A   | V-Count IRQ High           |
| $420B   | DMA Enable                 |
| $420C   | HDMA Enable                |
| $420D   | ROM Speed                  |
| $4210   | NMI Flag                   |
| $4211   | IRQ Flag                   |
| $4212   | PPU Status                 |
| $4213   | Programmable I/O In        |
| $4214   | Quotient Low               |
| $4215   | Quotient High              |
| $4216   | Product/Remainder Low      |
| $4217   | Product/Remainder High     |
| $4218   | Joypad 1 Low               |
| $4219   | Joypad 1 High              |
| $421A   | Joypad 2 Low               |
| $421B   | Joypad 2 High              |
| $421C   | Joypad 3 Low               |
| $421D   | Joypad 3 High              |
| $421E   | Joypad 4 Low               |
| $421F   | Joypad 4 High              |
| $43X0   | DMA/HDMA Control (ch X)    |
| $43X1   | DMA Destination (ch X)     |
| $43X2   | DMA Source Low (ch X)      |
| $43X3   | DMA Source High (ch X)     |
| $43X4   | DMA Source Bank (ch X)     |
| $43X5   | DMA Byte Count Low (ch X)  |
| $43X6   | DMA Byte Count High (ch X) |
| $43X7   | HDMA Indirect Bank (ch X)  |
| $43X8   | HDMA Table Addr Low (ch X) |
| $43X9   | HDMA Table Addr High (ch X)|
| $43XA   | HDMA Line Counter (ch X)   |

### WRAM Registers

| Address | Register Name    |
|---------|------------------|
| $2180   | WRAM Data        |
| $2181   | WRAM Address Low |
| $2182   | WRAM Addr High   |
| $2183   | WRAM Addr Bank   |

### APU Ports

| Address | Register Name    |
|---------|------------------|
| $2140   | APU Port 0       |
| $2141   | APU Port 1       |
| $2142   | APU Port 2       |
| $2143   | APU Port 3       |

---

## Notes for ROM Editor / Viewer

When parsing a SNES ROM file for graphics display (no emulation):

1. **Tile data is in ROM,** and during gameplay is DMA'd to VRAM. The ROM addresses of tile data depend on the game's ROM mapping (LoROM vs HiROM) and which bank/offset the game loads from.

2. **Tilemap data may also be in ROM** (compressed or raw). Raw tilemaps can be identified by pairs of bytes in the tilemap entry format (10-bit char number + 3-bit palette + priority + flip flags).

3. **CGRAM palette data** is usually initialized from a table in ROM during startup and during level loads.

4. **To render a tile correctly** from ROM data without a running PPU:
   - Find the tile's bitplane data using the character address formula
   - Decode each row's bitplanes into pixel values
   - Look up each pixel value in the appropriate palette
   - Convert 15-bit BGR to 24-bit RGB for display

5. **Super Mario World** uses Mode 1 (BG1/BG2 in 4bpp, BG3 in 2bpp) with 8×8 and 16×16 tiles on different layers.

6. **Color 0 of sprite palettes** (CGRAM entries 128, 144, 160, 176, 192, 208, 224, 240) is always transparent for sprites regardless of the actual color stored there.

7. **Color 0 of BG palettes** (CGRAM entry 0 for the first palette) is the backdrop color when no BG pixel is opaque.
