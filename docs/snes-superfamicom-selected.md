# SNES Super Famicom Wiki - Selected Technical Reference

Compiled from:
- https://wiki.superfamicom.org/palettes
- https://wiki.superfamicom.org/sprites
- https://wiki.superfamicom.org/backgrounds
- https://wiki.superfamicom.org/windows
- https://wiki.superfamicom.org/rendering-the-screen
- https://wiki.superfamicom.org/transparency
- https://wiki.superfamicom.org/pointers

---

## Table of Contents

1. [Palettes](#palettes)
2. [Sprites](#sprites)
3. [Backgrounds](#backgrounds)
4. [Windows](#windows)
5. [Rendering the Screen](#rendering-the-screen)
6. [Transparency](#transparency)
7. [Pointers](#pointers)

---

# Palettes

Source: https://wiki.superfamicom.org/palettes

## CGRAM Overview

The SNES stores palettes in CGRAM (Color Graphics RAM). CGRAM is 512 bytes total, supporting 256 colors at 2 bytes each.

## 15-Bit BGR Color Format

Colors are stored in 15-bit BGR format:

```
0BBBBBGG GGGRRRRR
```

- Bit 15 is unused (must be 0)
- Each color component (R, G, B) ranges from 0–31
- Two bytes are stored in little-endian (LSB) order

## 24-Bit RGB to 15-Bit BGR Conversion

**Formula:**

```
R = R / 8
G = G / 8
B = B / 8
Color = B × 1024 + G × 32 + R
```

**Example - White (255, 255, 255):**

```
R = 255 / 8 = 31
G = 255 / 8 = 31
B = 255 / 8 = 31
Color = 31 × 1024 + 31 × 32 + 31 = 32767 (0x7FFF)
```

Stored as `FF 7F` in LSB order.

**Bitwise approach:**

```c
c = color;  // 0x00RRGGBB packed
int r = (c & 0xF80000) >> 19;
int g = (c & 0x00F800) >>  6;
int b = (c & 0x0000F8) <<  7;
return b | g | r;
```

## 15-Bit BGR to 24-Bit RGB Conversion

**Formula (arithmetic):**

```
R = ((color       ) % 32) * 8
G = ((color /   32) % 32) * 8
B = ((color / 1024) % 32) * 8
```

**Formula (bitwise):**

```
R = (Color & 31) * 8
G = ((Color >> 5) & 31) * 8
B = ((Color >> 10) & 31) * 8
```

**Note on precision loss:** Conversion from 5-bit to 8-bit loses precision. To stretch the range to a proper 0–255 output:

```
R = R + R / 32
G = G + G / 32
B = B + B / 32
```

## Sub-Palette Architecture

| Property | Value |
|---|---|
| Total colors in CGRAM | 256 |
| Number of sub-palettes | 16 |
| Colors per sub-palette | 16 |
| BG layers use | First 8 sub-palettes (indices 0–7) |
| Sprites use | Remaining 8 sub-palettes (indices 8–15) |

**Mode 0 exception:** 4 BG layers with separate 8 sub-palettes of 4 colors each.

**256-color modes:** Use all 256 colors across tiles.

**Color 0 transparency rule:** In all modes and for all BGs, color 0 in any palette is considered transparent.

---

# Sprites

Source: https://wiki.superfamicom.org/sprites

## Overview

The SNES has 128 independent sprites. The sprite definitions are stored in Object Attribute Memory, or OAM.

## OAM Structure

OAM consists of 544 bytes, organized as two tables:

| Table | Size | Description |
|---|---|---|
| Low table | 512 bytes | 128 records × 4 bytes each |
| High table | 32 bytes | 128 records × 2 bits each |

### OAM Access Registers

| Register | Description |
|---|---|
| `$2102` | Word address (low byte of OAM address) |
| `$2103` | Bit 0: table select (0=low table, 1=high table); bit 7: priority rotation |
| `$2104` | Write port |
| `$2138` | Read port |

## Low Table Record Format (4 bytes per sprite)

```
byte OBJ*4+0: xxxxxxxx     (X position, low byte)
byte OBJ*4+1: yyyyyyyy     (Y position)
byte OBJ*4+2: cccccccc     (First tile index)
byte OBJ*4+3: vhoopppN     (Flags: v-flip, h-flip, priority, palette, name table)
```

### Byte 3 Bit Field Breakdown

| Bits | Field | Description |
|---|---|---|
| 7 | v | Vertical flip |
| 6 | h | Horizontal flip |
| 5–4 | oo | Priority (0–3) |
| 3–1 | ppp | Palette selector (sprite palette 0–7) |
| 0 | N | Name table select |

## High Table Format (2 bits per sprite)

Each byte in the high table covers 4 sprites (OBJ indices N×4 through N×4+3):

```
bit 0 of byte OBJ/4: X (high bit of X position for sprite OBJ*4+0)
bit 1 of byte OBJ/4: s (size flag for sprite OBJ*4+0)
bit 2 of byte OBJ/4: X (high bit for sprite OBJ*4+1)
bit 3 of byte OBJ/4: s (size flag for sprite OBJ*4+1)
bit 4 of byte OBJ/4: X (high bit for sprite OBJ*4+2)
bit 5 of byte OBJ/4: s (size flag for sprite OBJ*4+2)
bit 6 of byte OBJ/4: X (high bit for sprite OBJ*4+3)
bit 7 of byte OBJ/4: s (size flag for sprite OBJ*4+3)
```

## Sprite Attribute Summary

| Field | Bits | Description |
|---|---|---|
| X position | 9 bits total | Low 8 from low table byte 0; bit 8 (sign/overflow) from high table. Signed: 0–239 on-screen, -63 to -1 off-left |
| Y position | 8 bits | 0–239 on-screen; -63 to -1 off-top |
| Tile | 8 bits | `rrrrcccc` - row (high 4 bits) and column (low 4 bits) in a 16×16 tile table |
| Palette | 3 bits (ppp) | Selects from 8 sprite palettes; maps to CGRAM indices 128+ppp×16 through 128+ppp×16+15 |
| Priority | 2 bits (oo) | Sprite-to-background priority (0=lowest, 3=highest) |
| H-flip | 1 bit (h) | Horizontal flip |
| V-flip | 1 bit (v) | Vertical flip |
| Size | 1 bit (s) | 0=small size, 1=large size (as configured in `$2101`) |
| Name table | 1 bit (N) | Selects which of two VRAM character tables to use |

## Palettes

Eight 16-color sprite palettes are available, starting at CGRAM index 128.

- Sprite palettes 0–3: do NOT participate in color math
- Sprite palettes 4–7: DO participate in color math when enabled
- First color (index 0) in each palette is always transparent

## VRAM Character Table

Sprites use two 16×16 tile character tables in VRAM. The N bit in OAM byte 3 selects which table.

### VRAM Address Calculation

```
VRAMAddr = ((Base<<13) + (cccccccc<<4) + (N ? ((Name+1)<<12) : 0)) & 0x7FFF
```

Where:
- `Base` = Name Base Address bits from `$2101` (bits 3–7, shifted)
- `Name` = Name Select bits from `$2101` (bits 0–2)
- `cccccccc` = tile byte from OAM byte 2

### Register $2101 - Object Size and Character Address

| Bits | Field | Description |
|---|---|---|
| 7–5 | Object size | Selects two sprite sizes (small/large). See size table |
| 4–3 | Name select | Offset for second name table |
| 2–0 | Name base address | Base VRAM address for character data |

### Sprite Size Options (bits 7–5 of $2101)

| Value | Small | Large |
|---|---|---|
| 000 | 8×8 | 16×16 |
| 001 | 8×8 | 32×32 |
| 010 | 8×8 | 64×64 |
| 011 | 16×16 | 32×32 |
| 100 | 16×16 | 64×64 |
| 101 | 32×32 | 64×64 |
| 110 | 16×32 | 32×64 |
| 111 | 16×32 | 32×32 |

### Tile Wrapping Example (32×32 sprite at tile $1FE)

| Y offset | x | x+8 | x+16 | x+24 |
|---|---|---|---|---|
| y | $1FE | $1FF | $1F0 | $1F1 |
| y+8 | $10E | $10F | $100 | $101 |
| y+16 | $11E | $11F | $110 | $111 |
| y+24 | $12E | $12F | $120 | $121 |

## Sprite Priority

### Relative to Backgrounds

Determined by the priority bits (oo, bits 4–5) in OAM byte 3:

| Sprite Priority | Rendered above |
|---|---|
| 3 | All BGs |
| 2 | BG1 and BG2 |
| 1 | BG1 |
| 0 | Nothing (behind all BGs) |

### Relative to Other Sprites

Controlled by bit 7 of `$2103`:

- **Priority rotation disabled (bit 7 = 0):** Sprite 0 always has highest priority; sprite 127 lowest.
- **Priority rotation enabled (bit 7 = 1):** Sprite `(OAMAddr & 0xFE) >> 1` has the highest priority. Priority wraps: FirstSprite > FirstSprite+1 > ... > 127 > 0 > ... > FirstSprite-1.

## Sprite Drawing Process (Per-Scanline)

### Phase 1: Range Evaluation

The PPU scans through sprites to find those whose X range overlaps the current scanline:

- First 32 sprites with `-size < X < 256` are selected for rendering
- If more than 32 sprites qualify, bit 6 of `$213E` is set (Range overflow flag)

### Phase 2: Time Evaluation

For each selected sprite, tiles are loaded left-to-right (accounting for h-flip):

- Only tiles with `-8 < X < 256` are counted against the tile budget
- Maximum 34 8×8 tiles can be loaded per scanline
- If more than 34 tiles are needed, bit 7 of `$213E` is set (Time overflow flag)
- Tiles that didn't fit are not drawn

### Phase 3: Association

Each tile is linked to its X position (accounting for 256/−256 wrap), palette, and priority.

**Note:** Off-screen sprites (X = 256 exactly) do not count toward the range or time limits.

---

# Backgrounds

Source: https://wiki.superfamicom.org/backgrounds

## BG Mode Selection - Register $2105 (BGMODE)

Bits 0–2 select the background mode:

| Mode | BG1 colors | BG2 colors | BG3 colors | BG4 colors |
|---|---|---|---|---|
| 0 | 4 | 4 | 4 | 4 |
| 1 | 16 | 16 | 4 | - |
| 2 | 16 | 16 | - | - |
| 3 | 256 | 16 | - | - |
| 4 | 256 | 4 | - | - |
| 5 | 16 | 4 | - | - |
| 6 | 16 | - | - | - |
| 7 | 256 | - | - | - |
| 7EXTBG | 256 | 128 | - | - |

Additional $2105 bits:

| Bits | Description |
|---|---|
| 3 | Mode 1 BG3 priority: 0=normal, 1=BG3 priority 1 tiles above all sprites |
| 4 | BG1 tile size: 0=8×8, 1=16×16 |
| 5 | BG2 tile size: 0=8×8, 1=16×16 |
| 6 | BG3 tile size: 0=8×8, 1=16×16 |
| 7 | BG4 tile size: 0=8×8, 1=16×16 |

Mode 1 variation: controlled by bit 3 of `$2105`.
Mode 7 variation (EXTBG): controlled by bit 6 of `$2133 (SETINI)`.

In all modes and for all BGs, color 0 in any palette is considered transparent.

## Tilemap Configuration

### Register $2107–$210A (BGnSC - BG Screen Base and Size)

One register per BG layer (BG1=$2107, BG2=$2108, BG3=$2109, BG4=$210A):

| Bits | Description |
|---|---|
| 7–2 | Tilemap base address (word address = value << 9, i.e., VRAM byte address = value << 10) |
| 1–0 | Tilemap size select |

### Tilemap Size Bits (bits 1–0 of BGnSC)

```
00  →  32×32 tiles (single screen)
        Layout: AA
                AA

01  →  64×32 tiles (two screens side-by-side)
        Layout: AB
                AB

10  →  32×64 tiles (two screens stacked)
        Layout: AA
                BB

11  →  64×64 tiles (four screens)
        Layout: AB
                CD
```

Maximum possible BG area: 1024×1024 pixels (using 16×16 tiles + 64×64 tilemap).

### Tilemap Entry Format (2 bytes per tile entry)

```
Byte layout (high byte first, then low byte):
  vhopppcc cccccccc

  v          = Vertical flip (1=flipped)
  h          = Horizontal flip (1=flipped)
  o          = Tile priority bit (0 or 1)
  ppp        = Palette number (3 bits; meaning varies by mode - see mode sections)
  cccccccccc = Tile/character number (10 bits)
```

### Tilemap Word Address Calculation

```
WordAddr = (Addr<<9)
         + ((Y & 0x1F) << 5)
         + (X & 0x1F)
         + (SY ? ((Y & 0x20) << (SX ? 6 : 5)) : 0)
         + (SX ? ((X & 0x20) << 5) : 0)
```

Where:
- `Addr` = tilemap base address bits (from BGnSC bits 7–2)
- `X`, `Y` = tile coordinates
- `SX` = tilemap extends horizontally beyond 32 tiles (bit 0 of BGnSC)
- `SY` = tilemap extends vertically beyond 32 tiles (bit 1 of BGnSC)

## Character Data (CHR) Address

### Registers $210B–$210C (BGnCHR - BG Character Data Address)

| Register | Bits 3–0 | Bits 7–4 |
|---|---|---|
| $210B | BG1 chr base | BG2 chr base |
| $210C | BG3 chr base | BG4 chr base |

Each 4-bit value gives a base address: `VRAM byte address = value << 13`

### Character Data Address Calculation

```
ByteAddr = (Base << 13) + (TileNumber * 8 * NumBitplanes)
```

### Bitplane Storage Format

- **4-color (2bpp):** Bitplanes 0–1 stored as interleaved low/high bytes of each word (8 words = 16 bytes per tile)
- **16-color (4bpp):** Bitplanes 0–1 first (as above), then bitplanes 2–3 in same format (32 bytes per tile)
- **256-color (8bpp):** Stored the same as two 4-color tiles (64 bytes per tile)

### 16×16 Tile Mode

When the appropriate tile size bit of `$2105` is set, each entry in the tilemap represents a 16×16 block using four 8×8 character tiles: Tile, Tile+1, Tile+16, Tile+17.

## BG Scrolling

### Scroll Registers $210D–$2114

| Register | Description |
|---|---|
| $210D | BG1 Horizontal Scroll (BGnHOFS) - also Mode 7 H scroll |
| $210E | BG1 Vertical Scroll (BGnVOFS) - also Mode 7 V scroll |
| $210F | BG2 Horizontal Scroll |
| $2110 | BG2 Vertical Scroll |
| $2111 | BG3 Horizontal Scroll |
| $2112 | BG3 Vertical Scroll |
| $2113 | BG4 Horizontal Scroll |
| $2114 | BG4 Vertical Scroll |

All scroll registers are write-twice (two 8-bit writes to set a 16-bit value).

### Write-Twice Combination Formula

```
For BGnHOFS:
  Value = (NewByte << 8) | (PrevByte & ~7) | ((CurrentValue >> 8) & 7)

For BGnVOFS:
  Value = (NewByte << 8) | PrevByte
```

**Note:** Many games set vertical scroll to -1 (0xFFFF) rather than 0. Reason: the SNES loads OBJ data for each scanline during the previous scanline, so a VOFS of -1 skips the partially-visible top row.

### Screen-to-Tilemap Coordinate Conversion

```
Size   = 8 or 16 (depending on tile size bit in $2105)
TileX  = (ScreenX + BGnHOFS) / Size
TileY  = (ScreenY + BGnVOFS) / Size
→ Look up the tile entry at (TileX, TileY) in the tilemap
```

## Direct Color Mode

Enabled by bit 0 of `$2130 (CGWSEL)`. Applies to 256-color BGs in Modes 3, 4, and 7.

In Direct Color mode, the character data byte directly encodes the color:

```
Character data byte treated as: BBGGGRRR

Final color:
  Red   = RRRr0   (R = bits 2–0; r = BG palette bit 0)
  Green = GGGg0   (G = bits 5–3; g = BG palette bit 1)
  Blue  = BBb00   (B = bits 7–6; b = BG palette bit 2)
```

Palette bits are taken from `ppp` in the tilemap entry. Any pixel with character data = 0 is still transparent.

## Mode 0 Detail

4 BG layers of 4 colors each. 

Palette index for a BG tile: `ppp * 4 + (BG# - 1) * 32`

### Priority Order (front to back):

| Priority | Layer |
|---|---|
| 1 | Sprites (priority 3) |
| 2 | BG1 tiles (priority 1) |
| 3 | BG2 tiles (priority 1) |
| 4 | Sprites (priority 2) |
| 5 | BG1 tiles (priority 0) |
| 6 | BG2 tiles (priority 0) |
| 7 | Sprites (priority 1) |
| 8 | BG3 tiles (priority 1) |
| 9 | BG4 tiles (priority 1) |
| 10 | Sprites (priority 0) |
| 11 | BG3 tiles (priority 0) |
| 12 | BG4 tiles (priority 0) |

## Mode 1 Detail

2 BGs of 16 colors + 1 BG of 4 colors. Palette index: `ppp * ncolors`

### Priority Order when bit 3 of $2105 is SET (BG3 high priority):

| Priority | Layer |
|---|---|
| 1 | BG3 tiles (priority 1) |
| 2 | Sprites (priority 3) |
| 3 | BG1 tiles (priority 1) |
| 4 | BG2 tiles (priority 1) |
| 5 | Sprites (priority 2) |
| 6 | BG1 tiles (priority 0) |
| 7 | BG2 tiles (priority 0) |
| 8 | Sprites (priority 1) |
| 9 | Sprites (priority 0) |
| 10 | BG3 tiles (priority 0) |

### Priority Order when bit 3 of $2105 is CLEAR (normal):

Same as above, except BG3 (priority 1) moves from position 1 to position 8.

## Mode 2 Detail

2 BGs of 16 colors each. Palette index: `ppp * 16`

Mode 2 is an Offset-Per-Tile mode. BG3 acts as the offset source.

### Offset-Per-Tile Formula

```
HOFS = X + BGnHOFS
VOFS = Y + BGnVOFS
ValidBit = 0x2000 for BG1, or 0x4000 for BG2

if (!IsFirst8x8Tile(BGn, HOFS)) {
    Hval = GetTile(BG3, (HOFS & 7) | (((X-8) & ~7) + (BG3HOFS & ~7)), BG3VOFS)
    Vval = GetTile(BG3, (HOFS & 7) | (((X-8) & ~7) + (BG3HOFS & ~7)), BG3VOFS + 8)
    if (Hval & ValidBit) HOFS = (HOFS & 7) | ((X & ~7) + (Hval & ~7))
    if (Vval & ValidBit) VOFS = Y + Vval
}
Pixel[X,Y] = GetPixel(Get8x8Tile(BGn, HOFS, VOFS), HOFS, VOFS)
```

Key behaviors:
- The leftmost visible tile is rendered normally (no OPT applied)
- The "new" horizontal offset completely overrides BGnHOFS, except the lower 3 bits of the original BGnHOFS are still used
- The current Y screen position does NOT affect which row of BG3's tilemap is referenced for OPT
- BG3 VOFS selects offset column, BG3 VOFS+8 selects offset row

## Mode 3 Detail

One 256-color BG + one 16-color BG.

```
BG1 palette index: 0 (uses all 256 colors; Direct Color Mode can apply)
BG2 palette index: ppp * 16
```

Register `$2130` bit 0 may enable Direct Color Mode on BG1.

## Mode 4 Detail

One 256-color BG + one 4-color BG.

```
BG1 palette index: 0
BG2 palette index: ppp * 4
```

Mode 4 is the second Offset-Per-Tile mode. OPT entry packing differs from Mode 2:

```
Val = GetTile(BG3, ...)
if (Val & 0x8000) {
    Hval = 0
    Vval = Val
} else {
    Hval = Val
    Vval = 0
}
```

(One BG3 tile entry encodes either an H or V offset, not both.)

## Mode 5 Detail

One 16-color BG + one 4-color BG. Palette: `ppp * ncolors`

Mode 5 uses pseudo-hires rendering (512-pixel-wide scanline). Instead of normal 8/16-pixel tile widths, it always takes a 16-pixel-wide tile and uses only half the pixels (every other half-pixel).

If interlace mode is on, the screen becomes 448 or 478 half-lines tall instead of 224 or 239.

## Mode 6 Detail

One 16-color BG only. Palette: `ppp * ncolors`

Mode 6 has the same half-pixel oddities as Mode 5. Additionally, Mode 6 is an Offset-Per-Tile mode.

Mode 6 always uses 8-pixel (16 half-pixel) wide tiles, including for BG3 (the OPT source).

## Mode 7 Detail

One BG of 256 colors with full matrix transformation.

### Tilemap and Character Data Structure

The tilemap and character map are interleaved in VRAM. Each word:
- Low byte = tilemap entry (1-byte character map index, 0–255)
- High byte = character data (packed pixel, one byte per pixel)

The tilemap is 128×128 entries (one byte each).

### Address Calculations

**Tilemap byte address:**
```
ByteAddr = (((Y & ~7) << 4) + (X >> 3)) << 1
```

**Pixel byte address:**
```
ByteAddr = (((TileData << 6) + ((Y & 7) << 3) + (X & 7)) << 1) + 1
```

### Matrix Transformation

Mode 7 supports full matrix transformation. See registers `$211B–$2120` for the transformation formula. HDMA can change the matrix per scanline for perspective effects.

### Register $211A (M7SEL) - Mode 7 Settings

| Bits | Description |
|---|---|
| 1–0 | Screen flip: bit 0 = horizontal flip, bit 1 = vertical flip |
| 6 | Field fill: 0=wrap around, 1=fill with transparent or tile 0 |
| 7 | Field extension: 0=wrap, 1=use bit 6 to control fill |

If bit 7 of `$211A` is set, bit 6 controls what fills the space outside the 1024×1024 map:
- Bit 6 = 0: transparent
- Bit 6 = 1: repeat tile 0 pattern

### Mode 7 EXTBG

Activated by bit 6 of `$2133 (SETINI)`. Adds a BG2 layer:
- BG2 uses the same tilemap and character data as BG1
- The high bit of each pixel byte is a priority bit (not a color bit)
- BG2 has 128 colors (7-bit pixel data)
- BG2 uses the Mode 7 scroll registers (`$210D–$210E`) rather than the normal BG2 registers (`$210F–$2110`)
- BG1 (256-color) supports Direct Color Mode; BG2 does not

### Mode 7 Priority (front to back):

| Priority | Layer |
|---|---|
| 1 | Sprites (priority 3) |
| 2 | Sprites (priority 2) |
| 3 | Sprites (priority 1) |
| 4 | BG1 |
| 5 | Sprites (priority 0) |

### Mode 7 EXTBG Priority (front to back):

| Priority | Layer |
|---|---|
| 1 | Sprites (priority 3) |
| 2 | Sprites (priority 2) |
| 3 | BG2 pixels (priority bit = 1) |
| 4 | Sprites (priority 1) |
| 5 | BG1 |
| 6 | Sprites (priority 0) |
| 7 | BG2 pixels (priority bit = 0) |

## BG Rendering Process Summary

1. Get H and V offsets (from scroll registers, or via offset-per-tile calculation for modes 2, 4, 6)
2. Translate screen (X, Y) to playing-field (X, Y) using offsets
3. Look up the tilemap entry at those coordinates
4. Use the tile number and base address to locate character data in VRAM
5. De-bitplane the character data into a pixel buffer
6. Apply palette, flip, and priority

---

# Windows

Source: https://wiki.superfamicom.org/windows

## Overview

The SNES provides two masking windows (Window 1 and Window 2). Windows can mask off a portion of any BG layer or the sprite layer on a per-scanline basis. Window positions can be adjusted per-scanline using HDMA.

## Window Position Registers

| Register | Description |
|---|---|
| `$2126` | Window 1 left edge (inclusive) |
| `$2127` | Window 1 right edge (inclusive) |
| `$2128` | Window 2 left edge (inclusive) |
| `$2129` | Window 2 right edge (inclusive) |

## Window Enable Registers

### $212A (WBGLOG) - Window Logic for BG Layers

Controls how Window 1 and Window 2 are combined for each BG:

| Bits | Layer | Description |
|---|---|---|
| 1–0 | BG1 | Window 1+2 combination logic |
| 3–2 | BG2 | Window 1+2 combination logic |
| 5–4 | BG3 | Window 1+2 combination logic |
| 7–6 | BG4 | Window 1+2 combination logic |

### $212B (WOBJLOG) - Window Logic for OBJ and Color Window

| Bits | Layer | Description |
|---|---|---|
| 1–0 | OBJ | Window 1+2 combination logic |
| 3–2 | Color | Window 1+2 combination logic |

### Window Combination Logic Values (2-bit)

| Value | Operation |
|---|---|
| 00 | OR |
| 01 | AND |
| 10 | XOR |
| 11 | XNOR |

## Window Layer Enable Registers

### $2123 (WBG12EN) - Window Enable for BG1 and BG2

| Bits | Description |
|---|---|
| 0 | BG1 Window 1 enable |
| 1 | BG1 Window 1 invert (1=inside becomes outside) |
| 2 | BG1 Window 2 enable |
| 3 | BG1 Window 2 invert |
| 4 | BG2 Window 1 enable |
| 5 | BG2 Window 1 invert |
| 6 | BG2 Window 2 enable |
| 7 | BG2 Window 2 invert |

### $2124 (WBG34EN) - Window Enable for BG3 and BG4

Same structure as $2123 but for BG3 (bits 0–3) and BG4 (bits 4–7).

### $2125 (WOBJSEN) - Window Enable for OBJ and Color Window

Same structure as $2123 but for OBJ (bits 0–3) and Color Window (bits 4–7).

## Main Screen and Sub-Screen Masking

### $212E (WSEL) - Window Mask for Main Screen

Controls which layers are clipped on the main screen by the window mask.

### $212F (WSEL) - Window Mask for Sub Screen

Controls which layers are clipped on the sub-screen by the window mask.

## Color Window

The color window has two distinct functions, both controlled by register `$2130`:

1. **Color clipping:** Clips pixel colors to black (color 0) inside/outside the window
2. **Color math prevention:** Prevents color math from being applied inside/outside the window

### Register $2130 (CGWSEL) - Color Addition Select

| Bits | Description |
|---|---|
| 7–6 | Color clipping: 00=never, 01=outside window, 10=inside window, 11=always |
| 5–4 | Color math prevention: 00=never, 01=outside window, 10=inside window, 11=always |
| 1 | Sub-screen enable (0=fixed color, 1=sub-screen) |
| 0 | Direct Color Mode enable (for 256-color BGs) |

**Color clipping** sets the pixel to black (color 0) before color math is applied. This means:
- If clipping is active, color math operates on black
- Half-math is also suppressed when clipping is active

**Color math prevention** disables all color math for affected pixels.

### Hi-Res Mode Color Window Behavior

In hires modes (Mode 5/6), the previous main-screen pixel's window status is used to determine whether the color window effect applies to the corresponding sub-screen pixel.

## Practical Example

Setup: BG1 = red pixels, BG2 = blue pixels in an 8×8 checkerboard, sub-screen = green, color math = add.

- Without color window: result is yellow (red+green) and blue checkerboard (BG2 pixels not participating in math)
- With color window clipping inside a horizontal band: pixels inside the window become black before addition → the clipped region shows green and black checkerboard

---

# Rendering the Screen

Source: https://wiki.superfamicom.org/rendering-the-screen

## Main Screen and Sub-Screen

The SNES renders two independent screens:

- **Main screen:** The primary display output (what is actually shown)
- **Sub-screen:** A secondary compositing plane used for color math

Each of the 5 layers (BG1, BG2, BG3, BG4, OBJ) can independently appear on the main screen, the sub-screen, or both.

### $212C (MSCREEN) - Main Screen Designation

| Bit | Layer |
|---|---|
| 0 | BG1 on main screen |
| 1 | BG2 on main screen |
| 2 | BG3 on main screen |
| 3 | BG4 on main screen |
| 4 | OBJ on main screen |

### $212D (SSCREEN) - Sub-Screen Designation

Same bit layout as $212C, but for the sub-screen.

## Mosaic Filter

Register: `$2106 (MOSAIC)`

| Bits | Description |
|---|---|
| 7–4 | Mosaic block size minus 1 (0=1×1 i.e. no effect, 15=16×16) |
| 3 | BG4 mosaic enable |
| 2 | BG3 mosaic enable |
| 1 | BG2 mosaic enable |
| 0 | BG1 mosaic enable |

Sprites are not affected by the mosaic filter.

### Mosaic Operation

Each X×X block of pixels is replaced by the upper-leftmost pixel of that block. Block edges align to the screen's left edge at the scanline where `$2106` was written (or the first visible scanline if not written that frame).

### Hires Mode Mosaic (Modes 5 and 6)

Hires modes use 2X×X blocks of half-pixels instead of X×X pixel blocks.

With `$2106 = $0F` (size=16): Creates 1×1 blocks, expanding each half-pixel to cover its paired odd half-pixel. This makes both BG1 and BG2 pixels visible side by side (normally only one is visible per pixel location in hires).

Example with `$2106 = $03`:
- Mode 5, red pixel on BG1 and blue on BG2 at same location
- Without mosaic: only one color visible
- With `$2106 = $03` (4×4 block): both red and blue become visible

### Mode 7 / EXTBG Mosaic

Mode 7 BG2 (EXTBG) uses `$2106` bits differently:
- Bit 0: Controls vertical mosaic
- Bit 1: Controls horizontal mosaic

This allows asymmetric mosaic blocks:

| $2106 high nibble | Bit 1 | Bit 0 | Block shape |
|---|---|---|---|
| $F (16 block size) | 0 | 1 | 1×16 (tall strip) |
| $F (16 block size) | 1 | 0 | 16×1 (wide strip) |
| $F (16 block size) | 1 | 1 | 16×16 (square) |

## Color Math (Color Addition/Subtraction)

Color math is applied after per-layer rendering and window masking.

### Register $2131 (CGADSUB) - Color Math Control

| Bits | Description |
|---|---|
| 7 | Color math operation: 0=add, 1=subtract |
| 6 | Half-math: 0=full result, 1=divide result by 2 |
| 5 | Enable color math for backdrop (color 0 of main screen) |
| 4 | Enable color math for OBJ layers |
| 3 | Enable color math for BG4 |
| 2 | Enable color math for BG3 |
| 1 | Enable color math for BG2 |
| 0 | Enable color math for BG1 |

### Register $2132 (COLDATA) - Fixed Color Data

Sets the fixed color used when sub-screen is not enabled or the sub-screen pixel is transparent.

| Bits | Description |
|---|---|
| 7 | Apply to Blue channel |
| 6 | Apply to Green channel |
| 5 | Apply to Red channel |
| 4–0 | Color intensity (0–31) |

Write once per channel. Each write updates the channel(s) indicated by bits 5–7.

### Color Math Operations

Determined by `$2130` bit 1 (sub-screen enable) and `$2131` bits 6–7 (half + add/sub):

| $2130 bit 1 | $2131 bit 7 | $2131 bit 6 | Operation |
|---|---|---|---|
| 0 | 0 | 0 | Add fixed color; clip to max (31) |
| 0 | 0 | 1 | Add fixed color; divide result by 2 |
| 0 | 1 | 0 | Subtract fixed color; clip to 0 |
| 0 | 1 | 1 | Subtract fixed color; divide by 2 |
| 1 | 0 | 0 | Add sub-screen pixel (or fixed color if sub-screen is backdrop) |
| 1 | 0 | 1 | Add sub-screen pixel, divide by 2; or add fixed color without division |
| 1 | 1 | 0 | Subtract sub-screen pixel (or fixed color); clip to 0 |
| 1 | 1 | 1 | Subtract sub-screen pixel, divide by 2; or subtract fixed color without division |

### Halving Exception

If either the main-screen pixel or sub-screen pixel is transparent (all enabled layers are transparent or clipped), the result is NOT halved even if half-math is enabled.

## Per-Scanline Rendering Pipeline

For each pixel on each scanline:

1. **Layer selection:** Find the first enabled main-screen layer (BG or OBJ) that has a non-transparent pixel at this X position, respecting priority order. If all layers are transparent, use the backdrop (color 0 from palette).

2. **Color window clipping:** If the color window is configured to clip this pixel:
   - Set the pixel color to black (0,0,0) before color math
   - Suppress half-math

3. **Color math application:** If the layer has color math enabled (via `$2131`) and color math is not prevented by the color window:
   - Retrieve the sub-screen pixel (or fixed color) at this position
   - Perform add/subtract operation on each R, G, B channel independently
   - Apply halving if configured (and neither pixel is transparent)
   - Clip each channel to 0–31

4. **Output:** The resulting pixel is sent to the display.

---

# Transparency

Source: https://wiki.superfamicom.org/transparency

## Overview

The SNES simulates transparency through color math operations between the main screen and sub-screen (or a fixed color). All operations are performed on 5-bit R, G, B channels independently (values 0–31).

## The Four Transparency Operations

### 1. Color Addition

Adds R, G, B values of main screen and sub-screen separately. Results are capped at 31 (no overflow). Neutral color is black (0,0,0).

Formula per channel:
```
Result = min(MainChannel + SubChannel, 31)
```

**Use cases:** Transparent light rays, lightening overlapping layers.
**Example:** Chrono Trigger curtain effects.

### 2. Color Addition then Halving (Averaging)

Adds channels, then right-shifts the 6-bit result by 1 (effectively averaging).

Formula per channel:
```
Result = (MainChannel + SubChannel) >> 1
```

No neutral color exists; a layer can be averaged with itself.

**Use cases:** Water, fog, clouds, semi-transparent shadows.
**Example:** Secret of Mana water effects.

### 3. Color Subtraction

Subtracts the sub-screen R, G, B channels from the main screen channels. Results below 0 are clamped to 0. Neutral color is black.

Formula per channel:
```
Result = max(MainChannel - SubChannel, 0)
```

**Use cases:** Transparent shadows, night or stormy weather simulation.
**Example:** Donkey Kong Country "Torchlight Trouble" level.

### 4. Color Subtraction then Halving

Same as subtraction, but the result is right-shifted after clamping to 0.

Formula per channel:
```
Result = max(MainChannel - SubChannel, 0) >> 1
```

Rarely used in practice (produces extremely dark results).

## Hardware Limitations

- **Two-layer maximum:** Color math always occurs between exactly 2 pixels from different layers. At most two layers participate in a single transparency operation.
- **Sprite restriction:** A sprite cannot be transparent through another sprite, because all sprites are merged into a single layer. Multiple transparent objects can exist but cannot overlap without clipping.
- **Sprite palette constraint:** For sprite layers, color math is either always disabled, or - if enabled - only sprites using palettes 4–7 receive the effect. Palettes 0–3 are never affected by color math.

## Main Screen / Sub-Screen Architecture

| Screen | Role |
|---|---|
| Main screen | Primary display output (what is shown) |
| Sub-screen | Secondary compositing plane for color math |

The 5 layers (BG1, BG2, BG3, BG4, Sprites) are individually assignable to main screen, sub-screen, or both via registers `$212C` and `$212D`.

## Transparency Behavior with Transparent Pixels

If either participating screen pixel is transparent (all enabled layers at that position are transparent or clipped), the halving step is suppressed even if half-math is configured.

Specific cases:

| Situation | Behavior |
|---|---|
| Main screen pixel is transparent | Color 0 (backdrop) is added/subtracted against sub-screen. Never halved. |
| Sub-screen pixel is transparent | Fixed color from `$2132` is added/subtracted against main screen. Never halved. |
| Both transparent | Backdrop color used; no math applied |

## Related Registers

| Register | Name | Description |
|---|---|---|
| `$2130` | CGWSEL | Color window and sub-screen control |
| `$2131` | CGADSUB | Color math enable per layer and operation type |
| `$2132` | COLDATA | Fixed color (used when sub-screen is disabled or transparent) |
| `$212C` | MSCREEN | Main screen layer enables |
| `$212D` | SSCREEN | Sub-screen layer enables |

---

# Pointers

Source: https://wiki.superfamicom.org/pointers

## Definition

A pointer is a string of hexadecimal bytes (usually 2 bytes) that references a location in ROM. Pointers are used to tell the ROM to jump to a different place in data or code.

## Pointer Structure

Pointers reference data blocks (such as text strings) that are terminated by an end byte. The end byte value varies by ROM but `FF` is common:

```
*        *       *
Stick[FF]Club[FF]Copper[FF]
```

Asterisks mark pointer reading locations. Each pointer points to the start of a data block.

## Pointer Calculation Method

To calculate the 2-byte pointer value for a given ROM offset:

1. **Identify the ROM offset** of the target data (e.g., `02A840`)

2. **Subtract the SNES ROM header size** (200 hex = 512 decimal bytes):
   ```
   02A840 - 200 = 02A640
   ```

3. **Remove the bank byte** (first two hex digits):
   ```
   02A640 → A640
   ```

4. **Reverse the byte order** (little-endian):
   ```
   A640 → 40A6
   ```
   This 2-byte value `40 A6` is the pointer as stored in ROM.

## Pointer Range Validation

All pointers, before byte-swapping, MUST be in the range `$8000`–`$FFFF`.

If the calculated value is below `$8000`, add `$8000`:

```
Example: raw value = 6238
6238 + 8000 = E238
Reverse bytes → 38E2  (final pointer stored in ROM)
```

## ROM Expansion

SNES ROMs are expanded in multiples of 32KB (`$8000` bytes). ROM sizes and their hex offsets (excluding headers):

| Hex Offset | Megabytes |
|---|---|
| `080000` | 0.5 |
| `100000` | 1.0 |
| `180000` | 1.5 |
| `200000` | 2.0 |
| `280000` | 2.5 |
| `300000` | 3.0 |
| `380000` | 3.5 |
| `400000` | 4.0 |
| `480000` | 4.5 |
| `500000` | 5.0 |

ROM is expanded by appending `FF` bytes in 32KB (`$8000`) multiples.

---

*End of document. Source: https://wiki.superfamicom.org/*
