# SNES Hardware Reference - ROM Editor/Viewer

Primary source: Rodrigo Copetti, *Super Nintendo Architecture* (copetti.org/writings/consoles/super-nintendo/)  
Supplementary details drawn from established SNES hardware documentation (No Intro, SNES Developer Manual, anomie's register docs).

---

## Table of Contents

1. [CPU](#1-cpu)
2. [Memory Map](#2-memory-map)
3. [LoROM vs HiROM](#3-lorom-vs-hirom)
4. [PPU - Graphics System](#4-ppu--graphics-system)
5. [Tiles](#5-tiles)
6. [Tilemaps](#6-tilemaps)
7. [Background Modes](#7-background-modes)
8. [Sprites (OAM)](#8-sprites-oam)
9. [Palettes (CGRAM)](#9-palettes-cgram)
10. [Color Math and Windows](#10-color-math-and-windows)
11. [DMA and HDMA](#11-dma-and-hdma)
12. [SPC700 / S-SMP Audio](#12-spc700--s-smp-audio)
13. [S-DSP - Sound Generation](#13-s-dsp--sound-generation)
14. [Cartridge and ROM Structure](#14-cartridge-and-rom-structure)
15. [Practical Notes for ROM Editors](#15-practical-notes-for-rom-editors)

---

## 1. CPU

**Chip**: Ricoh 5A22 - a customized WDC 65C816 variant.

| Property | Value |
|---|---|
| Architecture | 16-bit (65816 ISA) |
| External data bus | 8-bit |
| Internal data bus | 16-bit |
| Address bus | 24-bit (16 MB address space) |
| Max clock | 3.58 MHz (FastROM, internal registers) |
| Min clock | 1.79 MHz (slow bus regions) |
| General registers | A (accumulator), X, Y - each switchable between 8-bit and 16-bit mode |

**Extras on the 5A22** (not on a stock 65816):
- Hardware **multiply**: 8-bit × 8-bit → 16-bit result (WRMPYA/WRMPYB/RDMPYL/RDMPYH)
- Hardware **divide**: 16-bit ÷ 8-bit → 16-bit quotient + 16-bit remainder (WRDIVL/WRDIVH/WRDIVB/RDDIVL/RDDIVH)
- DMA controller (8 channels)
- HDMA controller
- Interrupt inputs for V-Blank (NMI) and H-Blank (IRQ)

**DRAM refresh**: WRAM is dynamic RAM. The CPU inserts a refresh cycle periodically, causing approximately a 3% effective clock slowdown.

**Bus topology**:
- **A Bus** (24-bit, CPU-controlled): Cartridge ROM, WRAM, CPU registers
- **B Bus** (8-bit, PPU-controlled): PPU registers ($2100–$21FF), WRAM mirror, audio CPU ports

DMA transfers require source and destination on different buses (A Bus → B Bus or vice versa).

---

## 2. Memory Map

The 65816 has a 24-bit address space: **Bank** (bits 23–16) : **Offset** (bits 15–0).

### LoROM System Map (banks $00–$7D, $80–$FF)

```
Bank    Offset          Region
------  --------------  ------------------------------------------
$00–$3F $0000–$1FFF     WRAM mirror (first 8 KB)
$00–$3F $2000–$20FF     Unused / open bus
$00–$3F $2100–$21FF     PPU / APU / DMA registers (B Bus)
$00–$3F $2200–$2FFF     Expansion (Enhancement chips, etc.)
$00–$3F $3000–$3FFF     DSP / SuperFX registers (chip-dependent)
$00–$3F $4000–$40FF     Old-style joypad (manual read)
$00–$3F $4100–$41FF     Unused
$00–$3F $4200–$44FF     CPU registers (DMA, HDMA, IRQ, NMI, math)
$00–$3F $8000–$FFFF     LoROM cartridge ROM (32 KB per bank)
$40–$7D $0000–$FFFF     LoROM cartridge ROM (A15 ignored: $0000-$7FFF mirrors $8000-$FFFF of the same bank when no SRAM is present; "expand ROM" hacks use the full range, up to the 4 MB ceiling)
$7E      $0000–$1FFF    WRAM (first 8 KB, same as mirrors above)
$7E      $2000–$FFFF    WRAM (remaining ~120 KB of first 64 KB)
$7F      $0000–$FFFF    WRAM (second 64 KB, total = 128 KB)
$80–$BF $0000–$7FFF     Mirrors of $00–$3F (lower half)
$80–$BF $8000–$FFFF     LoROM ROM (FastROM-capable, same data as $00–$3F)
$C0–$FF $0000–$FFFF     LoROM ROM upper banks (less common)
```

### HiROM System Map

```
Bank    Offset          Region
------  --------------  ------------------------------------------
$00–$3F $0000–$1FFF     WRAM mirror
$00–$3F $2100–$21FF     PPU / APU / DMA registers
$00–$3F $4200–$44FF     CPU registers
$00–$3F $6000–$7FFF     Cartridge SRAM (if present)
$00–$3F $8000–$FFFF     HiROM ROM (upper 32 KB of 64 KB bank)
$40–$7D $0000–$FFFF     HiROM ROM (full 64 KB banks)
$7E–$7F  (same as LoROM) WRAM
$80–$BF $0000–$3FFF     Mirrors + registers (FastROM speed)
$80–$BF $8000–$FFFF     HiROM ROM (FastROM)
$C0–$FF $0000–$FFFF     HiROM ROM (full 64 KB banks, FastROM)
```

### Key Register Blocks

| Address Range | Purpose |
|---|---|
| $2100–$2143 | PPU registers (screen mode, BG setup, scroll, window, color math) |
| $2140–$2143 | SPC700 communication ports (APU I/O) - 4 bytes, bidirectional |
| $2180–$2183 | WRAM access port (WMDATA, WMADDL, WMADDM, WMADDH) |
| $4200–$420D | CPU control (NMI enable, IRQ enable, joypad auto-read, HDMA enable) |
| $4210–$4212 | Status flags (NMI flag, IRQ flag, V/H counter) |
| $4214–$4217 | Division/multiply results |
| $4300–$437A | DMA channels 0–7 (10 registers × 8 channels) |
| $2104–$2106 | OAM address and data write |
| $2121–$2122 | CGRAM address and data write |
| $2115–$2119 | VRAM address and data read/write |

### Memory Sizes Summary

| Region | Size | Type | Notes |
|---|---|---|---|
| WRAM | 128 KB | DRAM | $7E:0000–$7F:FFFF |
| VRAM | 64 KB | SRAM | Two 32 KB chips; PPU-internal |
| CGRAM | 512 bytes | SRAM | 256 color entries × 2 bytes |
| OAM | 544 bytes | SRAM | 128 sprites × 4 bytes + 32 extra bytes |
| Audio RAM (PSRAM) | 64 KB | PSRAM | SPC700-internal |
| Cartridge ROM | up to 4 MB (std) / ~7.9 MB (ext) | ROM/Flash | Mapper-dependent |
| Cartridge SRAM | up to 64 KB | Battery-backed SRAM | Save data |

---

## 3. LoROM vs HiROM

Both are **cartridge memory mapping schemes** that describe how ROM banks are exposed into the CPU's 24-bit address space.

### LoROM

- ROM data appears in **32 KB windows** at offsets `$8000–$FFFF` of each bank.
- Banks `$00–$3F` and `$80–$BF` each expose one 32 KB ROM chunk.
- **128 banks** available → theoretical maximum **4 MB** of ROM (128 × 32 KB).
- Mirroring: Bank `$00` offset `$8000` = Bank `$80` offset `$8000` (same ROM data; `$80+` are FastROM-capable).
- ROM is accessed **one half-bank at a time**, leaving the lower `$0000–$7FFF` for registers and WRAM mirrors.
- SRAM typically at banks `$70–$7D`, offset `$0000–$7FFF`, on boards that carry SRAM; on boards without it, "expand ROM" hacks reuse the same address range as ROM data instead (see the System Map table above).
- **4 MB ceiling, no "ExLoROM"**: a board that ignored only A15 (not A23) beyond the plain per-bank formula - sometimes called "ExLoROM" - does not exist. The nesdev.org forum thread "CPU->Cart Address Mapping for ExLoROM/ExHiROM" (forums.nesdev.org/viewtopic.php?t=14808) concludes as much, and notes that a board which *did* ignore only A15 would make A23 a ROM address bit instead, mapping banks `$00–$3F` to `+0x400000` and `$40–$7F` to `+0x600000` (snes9x's `Map_JumboLoROMMap`). Applying the plain per-bank formula past 4 MB reads every low bank as the wrong 4 MB half - measured on an 8 MB image, where every bank in `$00–$3F` returned the far half's data instead of the near half's. Practical ceiling for the formula above: **4 MB** (128 banks × 32 KB). Mitigation: a ROM editor should reject non-LoROM map-mode bytes at open time rather than silently misreading an incompatible board.
- **WRAM select and the `$FE`/`$FF` mirror**: `/WRAMSEL` (SNESdev's WRAM_pinout: "/CS3 connected to /WRAMSEL to map S-WRAM to ... $7E-7F:0000-FFFF") decodes only the literal banks `$7E`/`$7F`, not A23 - so their `$FE`/`$FF` mirror is real cartridge ROM, not WRAM. An address converter must test the raw bank for the WRAM exclusion before folding `$80–$FF` down to `$00–$7F`, or it wrongly rejects an expanded ROM's top bank.

### HiROM

- ROM data appears in **full 64 KB banks** at offsets `$0000–$FFFF`.
- Banks `$40–$7D` and `$C0–$FF` expose the ROM directly as full banks.
- Banks `$00–$3F` and `$80–$BF` expose the **upper 32 KB** (`$8000–$FFFF`) of each corresponding ROM bank, plus registers in the lower half.
- **64 banks** of 64 KB → theoretical maximum **4 MB** ROM.
- SRAM typically at banks `$20–$3F`, offset `$6000–$7FFF`.
- Less bank switching needed for code that spans 64 KB. Preferred for large continuous data blocks.
- **ExHiROM**: Extends ROM into upper banks, reaching ~7.9 MB.

### Identifying the Mapper

The **ROM header** (inside the cartridge ROM) contains a mapper type byte. For SNES:

| Header Address (LoROM) | Header Address (HiROM) | Field |
|---|---|---|
| $7FD5 | $FFD5 | Map mode byte (bit 0 = HiROM, bit 4 = FastROM) |
| $7FD6 | $FFD6 | Cartridge type (ROM only, ROM+SRAM, ROM+SRAM+Battery, etc.) |
| $7FD7 | $FFD7 | ROM size (1 << N KB) |
| $7FD8 | $FFD8 | SRAM size (1 << N KB) |
| $7FDA | $FFDA | Developer ID |
| $7FDB | $FFDB | Version number |
| $7FDC–$7FDD | $FFDC–$FFDD | Checksum complement + checksum |
| $7FE0–$7FEF | $FFE0–$FFEF | Native mode vectors (COP, BRK, ABORT, NMI, IRQ) |
| $7FF0–$7FFF | $FFF0–$FFFF | Emulation mode vectors |

**Map mode byte** (`$7FD5` / `$FFD5`):
- Bit 0 = `0` → LoROM; `1` → HiROM
- Bit 4 = `1` → FastROM (3.58 MHz ROM access)
- Other bits indicate enhancement chips (SA-1, SuperFX, etc.)

**FastROM**: The CPU can access ROM at 3.58 MHz instead of 2.68 MHz if the cartridge PCB and ROM chip support it and the program accesses ROM through the `$80–$FF` bank range (which maps to fast speed) rather than `$00–$3F`.

---

## 4. PPU - Graphics System

The SNES uses **two PPU chips** (Picture Processing Units), commonly called PPU1 and PPU2, that work together:

- **PPU1**: Handles tile and sprite fetching from VRAM, sprite evaluation.
- **PPU2**: Handles color math, windowing, final pixel output to the analog encoder.

### PPU Memory

| Memory | Size | Access |
|---|---|---|
| VRAM | 64 KB (two 32 KB chips) | PPU-internal; CPU writes via $2115–$2119 |
| CGRAM | 512 bytes | PPU-internal; CPU writes via $2121–$2122 |
| OAM | 544 bytes | PPU-internal; CPU writes via $2102–$2104 |

The PPU can access VRAM only during **H-Blank and V-Blank**. CPU writes to VRAM during active rendering are unreliable and typically done during V-Blank or via DMA.

### Display Timings

| Parameter | NTSC | PAL |
|---|---|---|
| Visible resolution | 256 × 224 | 256 × 240 |
| Refresh rate | ~60 Hz | ~50 Hz |
| Total scanlines | 262 | 312 |
| H-Blank per line | ~51 master clocks | same |
| V-Blank scanlines | 38 (NTSC) | 72 (PAL) |
| Pixel aspect ratio | 8:7 | 8:7 |

Pixels are **not square** - on a 4:3 TV, 256 horizontal pixels stretch to fill the same width as ~292 square pixels would.

### Rendering Pipeline

Each scanline, the PPU:
1. Fetches tilemap entries for each active BG layer.
2. Fetches tile pixel data from VRAM.
3. Evaluates which sprite pixels fall on the scanline (32-sprite-per-line limit).
4. Applies per-layer priority rules to determine which pixel is on top.
5. Applies color math (addition/subtraction/half) between Main Screen and Sub Screen.
6. Applies window masking.
7. Outputs the final pixel through the analog encoder.

### PPU Registers (key ones)

| Register | Address | Purpose |
|---|---|---|
| INIDISP | $2100 | Screen brightness (0–15) and forced blanking |
| OBSEL | $2101 | Sprite (OAM) tile base address and size selection |
| OAMADDL/H | $2102–$2103 | OAM address for read/write |
| OAMDATA | $2104 | OAM data write port |
| BGMODE | $2105 | BG mode (0–7) and BG3 priority |
| MOSAIC | $2106 | Mosaic effect size and layers |
| BG1SC–BG4SC | $2107–$210A | Per-BG tilemap base address and size |
| BG12NBA / BG34NBA | $210B–$210C | Per-BG tile data (character) base address |
| BG1HOFS/VOFS–BG4HOFS/VOFS | $210D–$2114 | Per-BG scroll offsets |
| VMAIN | $2115 | VRAM address increment mode |
| VMADDL/H | $2116–$2117 | VRAM address |
| VMDATAL/H | $2118–$2119 | VRAM data write |
| CGADD | $2121 | CGRAM address |
| CGDATA | $2122 | CGRAM data write |
| W1/W2 registers | $2123–$212A | Window position and mask settings |
| WOBJSEL | $212B–$212C | Window logic operators per layer |
| COLDATA | $2132 | Sub Screen fixed color |
| CGWSEL / CGADSUB | $2130–$2131 | Color math enable flags |
| TM / TS | $212C–$212D | Main Screen / Sub Screen layer enable |
| STAT77/78 | $213E–$213F | PPU status (read-only) |

---

## 5. Tiles

Tiles are the fundamental graphics unit. All background and sprite graphics are built from **8×8 pixel tiles** stored in VRAM (16×16 pixel tiles are assembled from 2×2 grids of 8×8 tiles).

### Tile Color Depths

| Bit Depth | Colors per Tile | Bytes per 8×8 Tile | Used In |
|---|---|---|---|
| 2 bpp | 4 | 16 bytes | Mode 0 all layers; Mode 1 BG3; Mode 5/6 BG2 |
| 4 bpp | 16 | 32 bytes | Mode 1 BG1/BG2; Mode 2, 3, 4, 5 BG1; Mode 6 BG1 |
| 8 bpp | 256 | 64 bytes | Mode 3 BG1; Mode 4 BG1; Mode 7 |

### Planar Tile Format

SNES tiles use a **bitplane** format. For an 8×8 tile:

**2 bpp** (16 bytes total):
```
Row 0: [Plane 0, byte 0] [Plane 1, byte 0]
Row 1: [Plane 0, byte 1] [Plane 1, byte 1]
...
Row 7: [Plane 0, byte 7] [Plane 1, byte 7]
```
Each row = 2 bytes. Pixel color index = bit from plane 1 (MSB) : bit from plane 0 (LSB).

**4 bpp** (32 bytes total):
```
Planes 0+1 interleaved (16 bytes):
  Row 0: [P0 byte 0] [P1 byte 0] ... Row 7: [P0 byte 7] [P1 byte 7]
Planes 2+3 interleaved (16 bytes):
  Row 0: [P2 byte 0] [P3 byte 0] ... Row 7: [P2 byte 7] [P3 byte 7]
```
Pixel color index = P3:P2:P1:P0 (4-bit value, 0–15).

**8 bpp** (64 bytes total):
```
Planes 0+1 (16 bytes) + Planes 2+3 (16 bytes) + Planes 4+5 (16 bytes) + Planes 6+7 (16 bytes)
```
Pixel color index = P7:P6:P5:P4:P3:P2:P1:P0 (8-bit value, 0–255).

Color index **0** is always transparent for sprites and lower-priority BG layers.

### Tile Addressing in VRAM

VRAM is addressed in **words** (2-byte units), so VRAM address `$0000` = byte offset `$0000`, VRAM address `$0001` = byte offset `$0002`.

The **BG character base address** is set via registers `$210B` (BG1/BG2) and `$210C` (BG3/BG4):
- 4-bit value, each unit = `$1000` words = `$2000` bytes of VRAM.
- So value `0` = VRAM `$0000`, value `1` = VRAM `$2000`, value `2` = VRAM `$4000`, etc.

The **sprite (OBJ) tile base address** is set by `OBSEL` ($2101):
- Bits 2–0: Base address (`× $2000` bytes of VRAM).
- Bits 4–3: Second sprite name table offset.

---

## 6. Tilemaps

A **tilemap** (also called a screenmap or name table) is a grid of entries stored in VRAM that tells the PPU which tile to draw at each position and how to draw it.

### Tilemap Dimensions

| SC Size | Tilemap Grid | Pixel Coverage | VRAM Usage |
|---|---|---|---|
| 32×32 (1 screen) | 32×32 tiles | 256×256 px | 2 KB (1024 words) |
| 64×32 (H double) | 64×32 tiles | 512×256 px | 4 KB (2 tilemap blocks) |
| 32×64 (V double) | 32×64 tiles | 256×512 px | 4 KB |
| 64×64 (both) | 64×64 tiles | 512×512 px | 8 KB |

The BG size is set via bits 1–0 of each BGnSC register (`$2107–$210A`).

### Tilemap Base Address

Bits 7–2 of BGnSC = tilemap base address in VRAM (in units of `$0400` words = `$0800` bytes).

### Tilemap Entry Format (2 bytes per tile, 16-bit word)

```
Bit 15:    Y-Flip (vertical flip)
Bit 14:    X-Flip (horizontal flip)
Bit 13:    Priority (0 = behind, 1 = above)
Bits 12–10: Palette number (0–7, selects which of 8 palettes to use)
Bits 9–0:  Tile number (0–1023, indexes into character data)
```

The **palette number** selects from 8 palettes of 16 colors each (for 4 bpp layers). The actual CGRAM address of the palette = `palette_number × 16` for 4 bpp, `palette_number × 4` for 2 bpp. For 8 bpp layers, all 256 colors are used directly.

### Scroll Registers

Each BG layer has horizontal and vertical scroll registers (`BG1HOFS`, `BG1VOFS`, etc. at `$210D–$2114`). These are 10-bit values (0–1023), allowing scrolling within the full 1024×1024 pixel tilemap space.

---

## 7. Background Modes

Set via `BGMODE` register (`$2105`), bits 2–0.

| Mode | BG1 | BG2 | BG3 | BG4 | Notes |
|---|---|---|---|---|---|
| 0 | 2 bpp (4 colors) | 2 bpp (4 colors) | 2 bpp (4 colors) | 2 bpp (4 colors) | 4 layers; limited colors |
| 1 | 4 bpp (16 colors) | 4 bpp (16 colors) | 2 bpp (4 colors) | - | Most common mode |
| 2 | 4 bpp (16 colors) | 4 bpp (16 colors) | - | - | Offset-per-tile scroll |
| 3 | 8 bpp (256 colors) | 4 bpp (16 colors) | - | - | Direct RGB color in Mode 3 BG1 |
| 4 | 8 bpp (256 colors) | 2 bpp (4 colors) | - | - | Offset-per-tile |
| 5 | 4 bpp (16 colors) | 2 bpp (4 colors) | - | - | 512×224 hi-res; interlace → 512×448 |
| 6 | 4 bpp (16 colors) | - | - | - | Hi-res + offset-per-tile; 1 layer only |
| 7 | 8 bpp | - | - | - | Affine transform (rotation/scale); EXTBG adds second layer |

### Mode 1 Details (Most Common)

- BG1 and BG2: 4 bpp (16 colors each, from palettes 0–7)
- BG3: 2 bpp (4 colors, from palettes 0–3)
- BG3 can be given top priority via bit 3 of `BGMODE` (used for HUDs)
- Typical priority order (front to back): OBJ high > BG1 high > OBJ low > BG2 high > BG1 low > BG3 high (if priority bit set) > BG2 low > BG3 low > BG1 low > backdrop

### Mode 7 Details

Mode 7 renders a **single affine-transformed layer**:
- 8 bpp, 256 colors (direct palette from CGRAM offset 0)
- The **tilemap is 128×128 tiles** (1 byte per entry), stored in the first VRAM chip
- The **tileset is 256 tiles** of 8×8 pixels at 8 bpp (64 bytes each), stored in the second VRAM chip
- Total VRAM: 16 KB tilemap + 16 KB tileset = 32 KB
- The transformation is defined by a **2×2 matrix** (registers M7A, M7B, M7C, M7D at `$211B–$211E`) plus scroll center (M7X, M7Y at `$211F–$2120`)
- Matrix values are 16-bit signed fixed-point (8 integer, 8 fractional bits)
- **EXTBG** (`$2133` bit 6): Enables a second layer using BG2, which reads bit 7 of each Mode 7 pixel as a priority flag

### Offset-Per-Tile (Modes 2, 4, 6)

BG3 in these modes acts as an **offset layer**: each 8×8 column can have independent horizontal and/or vertical scroll applied to BG1 (and BG2 in Mode 2). Used for parallax or per-column effect scrolling.

---

## 8. Sprites (OAM)

Up to **128 sprites** are defined in OAM (Object Attribute Memory, 544 bytes).

### OAM Layout

OAM is split into two tables:

**Table 1** (512 bytes = 128 sprites × 4 bytes):

Each sprite entry:
```
Byte 0:    X position (low 8 bits; bit 8 is in Table 2)
Byte 1:    Y position (0–239; sprite is off-screen if ≥ 240)
Byte 2:    Tile number (low 8 bits)
Byte 3:
  Bit 7:   Y-flip
  Bit 6:   X-flip
  Bit 5:   Priority (bits 4–5 combined: 0=lowest, 3=highest)
  Bit 4:   Priority (continued)
  Bit 3:   Palette number (bits 3–1 select palette 0–7 from sprite palettes)
  Bit 2:   Palette (continued)
  Bit 1:   Palette (continued)
  Bit 0:   Name table select (selects between two sprite tile base areas)
```

**Table 2** (32 bytes = 128 sprites × 2 bits):

Each byte covers 4 sprites (2 bits per sprite):
```
Bits 1–0 for sprite N:
  Bit 1: Size select (0 = small size, 1 = large size)
  Bit 0: X position bit 8 (sign bit, extends X to −256 to +255)
```

### Sprite Sizes

Two sizes are active at once, selected by `OBSEL` (`$2101`) bits 6–4:

| OBSEL[6:4] | Small | Large |
|---|---|---|
| 000 | 8×8 | 16×16 |
| 001 | 8×8 | 32×32 |
| 010 | 8×8 | 64×64 |
| 011 | 16×16 | 32×32 |
| 100 | 16×16 | 64×64 |
| 101 | 32×32 | 64×64 |

Large sizes (32×32, 64×64) are assembled from a grid of 8×8 tiles.

### Sprite Priority

OAM Table 2 bits 4–5 (priority field) determines rendering order relative to BG layers:
- Priority 3 = in front of all BGs
- Priority 0 = behind all BGs (except backdrop)

When multiple sprites overlap, lower OAM index (sprite 0) wins (is drawn on top).

**Scanline limit**: Only 32 sprites per scanline are rendered. Sprites with higher OAM index are dropped first. This causes the "sprite flicker" seen in games that exceed the limit.

### Sprite Tile Organization

Sprite tiles are pulled from VRAM starting at the **OBJ base address** (`OBSEL` bits 2–0 × `$2000` bytes). The **name table** bit in OAM byte 3 bit 0 selects between two tile pools offset by the amount in `OBSEL` bits 4–3 (0, 4096, 8192, or 12288 tiles).

All sprite tiles are **4 bpp** (16 colors) regardless of background mode.

Sprite palettes use **CGRAM offsets $80–$FF** (palette slots 8–15 in the 16-color groupings). The 9 palette selections refer to palettes at CGRAM `$80`, `$90`, `$A0`, `$B0`, `$C0`, `$D0`, `$E0`, `$F0` (8 palettes × 16 colors each = 128 colors for sprites).

---

## 9. Palettes (CGRAM)

**CGRAM** holds all color data: 512 bytes = **256 color entries × 2 bytes each**.

### Color Format

Each entry is a **15-bit BGR color** packed into 2 bytes (little-endian word):

```
Bits 14–10: Blue  (0–31)
Bits  9–5:  Green (0–31)
Bits  4–0:  Red   (0–31)
Bit  15:    Unused (typically 0)
```

The 5 bits per channel give a range of 0–31 (not 0–255). The actual output is scaled by the DAC to analog RGB levels.

### Palette Organization

| CGRAM Offset | Palette | Used By |
|---|---|---|
| $00–$FF | Palettes 0–7 (8 palettes × 16 colors) | BG layers (4 bpp modes) |
| $00–$7F | Palettes 0–7 (8 palettes × 16 colors) | BG layers |
| $80–$FF | Palettes 8–15 (sprite palettes) | OBJ/sprites (4 bpp) |
| $00–$FF | All 256 entries | 8 bpp BG layers (direct) |

For **2 bpp** layers: 4 colors per palette, 8 palettes in the first 64 CGRAM entries.  
For **4 bpp** layers: 16 colors per palette, 8 palettes (BG at `$00`, sprites at `$80`).  
For **8 bpp** layers: all 256 CGRAM entries as one contiguous palette.

**Color 0 in each palette** is transparent (not drawn) for BG tiles and sprites. CGRAM entry `$00` (palette 0 color 0) is the **backdrop color** - the color shown where no opaque pixel exists.

### CGRAM Access

Write to `CGADD` (`$2121`) to set the byte address (not word address), then write pairs of bytes to `CGDATA` (`$2122`). CGRAM address auto-increments after each complete 2-byte (word) write.

---

## 10. Color Math and Windows

### Main Screen and Sub Screen

The PPU maintains two parallel rendering pipelines:
- **Main Screen**: Normal rendered output (BG layers + sprites assigned here).
- **Sub Screen**: A secondary layer used for color math blending.

Each BG layer and OBJ can be independently assigned to Main Screen, Sub Screen, or both (`TM`/`TS` registers at `$212C–$212D`).

### Color Math Operations

When color math is enabled (`CGADSUB` at `$2131`), the final pixel from the Sub Screen is blended with the Main Screen pixel:

| Operation | Formula |
|---|---|
| Addition | Result = Main + Sub (clamped to 31) |
| Subtraction | Result = Main − Sub (clamped to 0) |
| Half-addition | Result = (Main + Sub) / 2 |
| Half-subtraction | Result = (Main − Sub) / 2 |

The Sub Screen can also be set to a **fixed color** (via `COLDATA` at `$2132`) instead of a rendered layer - useful for static transparency tints.

### Windows

Two rectangular windows (W1, W2) can be defined per scanline via registers `$2126–$2129` (left/right edge positions).

Each BG layer and OBJ can specify:
- Whether it is clipped inside, outside, both, or neither window area
- The **logic operator** combining W1 and W2 (OR, AND, XOR, XNOR)

Windows are commonly used for:
- Letterboxing / border effects
- Irregular masked regions (cave openings, water surfaces)
- Enabling color math only in specific screen areas

### Mosaic

The mosaic effect (`MOSAIC` at `$2106`) pixelates selected BG layers by freezing each pixel's color for N×N pixel blocks (N = 1–16).

---

## 11. DMA and HDMA

The SNES has **8 DMA channels** (`$4300–$437A`), each independently configurable.

### General-Purpose DMA (GPDMA)

Used to transfer bulk data (tile graphics, palettes) into VRAM or CGRAM during V-Blank.

**Operation**: Writing to `MDMAEN` (`$420B`) with channel bitmask starts all enabled channels. The CPU is halted until all transfers complete.

**Per-channel registers** (channel N at base `$4300 + N×$10`):

| Offset | Register | Purpose |
|---|---|---|
| +0 | DMAPn | Transfer mode and direction flags |
| +1 | BBADn | B Bus address (PPU register to target, e.g. `$18` for `$2118` VRAM) |
| +2–3 | A1TnL/H | A Bus source address (low/high bytes) |
| +4 | A1Bn | A Bus source bank |
| +5–6 | DASn | Transfer size in bytes (or indirect table address for HDMA) |
| +7 | DASBn | Indirect bank (HDMA) |

**Transfer modes** (DMAPn bits 2–0):

| Mode | Bytes Written | Destination Pattern |
|---|---|---|
| 0 | 1 | $dest |
| 1 | 2 | $dest, $dest+1 (most common for VRAM: writes $2118 then $2119) |
| 2 | 2 | $dest, $dest (same register twice) |
| 3 | 4 | $dest, $dest, $dest+1, $dest+1 |
| 4 | 4 | $dest, $dest+1, $dest+2, $dest+3 |

**VRAM transfer example**: To copy tile data to VRAM:
1. Set `VMAIN` ($2115) = `$80` (word increment after high byte write, increment by 1 word)
2. Set `VMADDL/H` ($2116–$2117) to target VRAM word address
3. Configure DMA channel: B Bus = `$18` (`$2118`), mode 1, source = ROM/WRAM address, size = byte count
4. Enable DMA channel via `MDMAEN` ($420B)

**CGRAM transfer example**: B Bus target = `$22` (`$2122`), set `CGADD` first, mode 0, transfer palette bytes.

### HDMA (Horizontal DMA)

HDMA transfers **up to 4 bytes** to any B Bus register **every scanline** during H-Blank. This allows per-scanline register changes without CPU intervention - essential for raster effects.

HDMA runs throughout the frame (if enabled via `HDMAEN` at `$420C`). It does **not** halt the CPU.

**HDMA Table Format** (in WRAM or ROM):

```
Byte 0: Line count (bits 6–0 = number of scanlines this entry applies to;
                     bit 7 = 1 means repeat the same data each scanline,
                             0 means read new data each scanline)
Byte 1+: Data bytes to write (1–4 bytes depending on transfer mode)
...
Next entry...
Byte 0 = $00: End of HDMA table
```

**HDMA uses** in games:
- Smoothly varying scroll offsets per scanline (wavy water effects)
- Per-scanline color math enable (split screen lighting)
- Changing BG mode mid-frame
- Variable-width window masking per scanline
- Mode 7 perspective effects (varying scale per scanline)

---

## 12. SPC700 / S-SMP Audio

The audio system is **completely separate** from the main CPU and runs independently once initialized.

### Components

| Component | Role |
|---|---|
| **SPC700** (S-SMP) | 8-bit CPU; runs the sound driver program; controls S-DSP |
| **S-DSP** | Digital Signal Processor; plays 8 ADPCM audio channels |
| **PSRAM** | 64 KB of audio RAM shared by SPC700 and S-DSP |

### SPC700 CPU

- Custom 8-bit processor with a vaguely 6502-like instruction set (but not compatible)
- Runs at ~1.024 MHz
- Has access to the full 64 KB PSRAM address space
- Contains a **64-byte internal boot ROM** at `$FFC0–$FFFF` (visible only during boot; can be hidden after init)

### Boot Sequence and Communication

On power-on:
1. SPC700 executes its internal 64-byte boot ROM.
2. Boot ROM configures communication ports and signals readiness.
3. Main CPU detects readiness by reading port `$2140`.
4. Main CPU uploads the **sound driver program** and audio data into PSRAM via 4 I/O ports.
5. Main CPU signals the SPC700 to start executing the uploaded program.
6. SPC700 runs the sound driver, which controls the S-DSP independently.

### Communication Ports

Four bidirectional ports connect the main CPU to the SPC700:

| Main CPU Address | SPC700 Address | Direction | Purpose |
|---|---|---|---|
| $2140 | $00F4 | Bidirectional | Port 0 |
| $2141 | $00F5 | Bidirectional | Port 1 |
| $2142 | $00F6 | Bidirectional | Port 2 |
| $2143 | $00F7 | Bidirectional | Port 3 |

Data written by the main CPU to `$2140` appears at SPC700 address `$00F4`, and vice versa. These 4 bytes are used for the initial upload handshake and for runtime commands (play music track, set volume, SFX triggers, etc.).

### PSRAM Layout (game-dependent, but typical)

```
$0000–$00EF   Zero page - SPC700 fast-access variables
$00F0–$00FF   SPC700 internal registers (DSP data/address, timer control, I/O ports)
$0100–$01FF   Stack
$0200–$xxxx   Sound driver code
$xxxx–$xxxx   Instrument/sample directory (DSP source directory)
$xxxx–$xxxx   BRR-encoded audio samples (instruments)
$xxxx–$xxxx   Music sequence data
$xxxx–$FFBF   Available for audio data
$FFC0–$FFFF   Boot ROM (or remapped to PSRAM after hide-ROM flag set)
```

The **sample directory** is a table of 4-byte entries, each containing:
- 2 bytes: Start address of BRR sample in PSRAM
- 2 bytes: Loop point address within the BRR sample

The S-DSP register `DIR` (DSP register `$5D`) × 256 gives the base address of this table.

---

## 13. S-DSP - Sound Generation

The S-DSP plays **8 simultaneous audio channels** (voices), each independently configurable.

### S-DSP Register Access

SPC700 writes to the S-DSP via two registers in its own address space:
- `$00F2` - DSP register address select
- `$00F3` - DSP register data read/write

DSP registers are 8-bit, addressed `$00–$7F`.

### Per-Voice Registers (voice N = channels 0–7)

DSP register addresses for voice N: `$N0–$N9` (e.g., voice 0 = `$00–$09`, voice 1 = `$10–$19`).

| Offset | Register | Purpose |
|---|---|---|
| $x0 | VOL (L) | Left volume (signed 8-bit, −128 to +127) |
| $x1 | VOL (R) | Right volume (signed 8-bit) |
| $x2 | P (low) | Pitch (low byte); 14-bit pitch value |
| $x3 | P (high) | Pitch (high 6 bits) |
| $x4 | SRCN | Sample number (index into sample directory) |
| $x5 | ADSR1 | ADSR enable + attack + decay rates |
| $x6 | ADSR2 | Sustain level + sustain rate |
| $x7 | GAIN | Gain mode and level (used when ADSR disabled) |
| $x8 | ENVX | Current envelope value (read-only) |
| $x9 | OUTX | Current sample output (read-only) |

**Pitch**: 14-bit value, where `$1000` = original sample rate (32 kHz). Higher = faster/higher pitch, lower = slower/lower pitch. This is how instruments play at different musical pitches.

**Negative volume** (`VOL` signed): Inverts the audio signal phase. Setting left and right channels to opposite signs creates a surround/out-of-phase effect.

### ADSR Envelope

| Phase | Register Bits | Description |
|---|---|---|
| Attack | ADSR1 bits 3–0 | Rate at which volume rises from 0 to max |
| Decay | ADSR1 bits 6–4 | Rate at which volume falls from max to sustain level |
| Sustain level | ADSR2 bits 7–5 | Target volume level (0–7, where 7 = max) |
| Sustain rate | ADSR2 bits 4–0 | Rate of continued slow decay during sustain |
| Release | Triggered by key-off | Fast decay to silence |

ADSR is enabled by setting bit 7 of ADSR1. When disabled, the GAIN register controls volume directly.

### Global DSP Registers

| Register | Address | Purpose |
|---|---|---|
| MVOL L/R | $0C / $1C | Master volume left/right |
| EVOL L/R | $2C / $3C | Echo volume left/right |
| KON | $4C | Key-on bits (start sample playback, one bit per voice) |
| KOFF | $5C | Key-off bits (begin release phase) |
| FLG | $6C | Reset, mute, echo disable, noise frequency |
| ENDX | $7C | Flags set when sample reaches its loop/end point |
| EFB | $0D | Echo feedback volume |
| PMON | $2D | Pitch modulation enable (per voice) |
| NON | $3D | Noise enable (per voice) |
| EON | $4D | Echo enable (per voice) |
| DIR | $5D | Sample directory base address (in PSRAM, ÷256) |
| ESA | $6D | Echo buffer start address (in PSRAM, ÷256) |
| EDL | $7D | Echo delay (length); 0 = 0 ms, each step = ~16 ms |
| FIR 0–7 | $0F,$1F,$2F,$3F,$4F,$5F,$6F,$7F | 8-tap FIR filter coefficients for echo |

### BRR (Bit Rate Reduced) Sample Format

All audio samples are stored as **BRR-compressed PCM** in PSRAM. BRR compresses audio to approximately 3.56:1 ratio.

**Block structure** (9 bytes per block = 16 samples):
```
Byte 0: Header
  Bits 7–4: Shift amount (0–12; right-shift for decoded samples)
  Bits 3–2: Filter (0–3; selects IIR predictor coefficients)
  Bit 1:    Loop flag (this block is a valid loop point)
  Bit 0:    End flag (this is the last block of the sample)
Bytes 1–8: 16 nibbles of 4-bit signed sample deltas (2 nibbles per byte, high nibble first)
```

**Decoding**: Each nibble is sign-extended to 16 bits, shifted left by the header shift amount, then an IIR filter is applied using the previous two decoded samples and the filter coefficients.

The **loop flag** marks which block to return to after the end block is reached. This is how looping instruments work - the sample plays through once, then loops from the loop point to the end indefinitely.

### Echo System

The S-DSP has a built-in echo/delay effect:
- Controlled by DSP registers `ESA` (echo buffer start), `EDL` (echo delay length), `EFB` (feedback), `EON` (per-voice echo enable), and the 8-tap FIR filter coefficients.
- The echo buffer resides **in PSRAM** at address `ESA × 256`, with size = `EDL × 2048` bytes.
- Maximum echo delay = 15 × 2048 bytes = 30,720 bytes ≈ 240 ms.
- **Warning**: The echo buffer is dynamic and must not overlap with other audio data in PSRAM, or corruption will occur.

### Sound Driver Pattern

Games upload a **sound driver** into PSRAM alongside audio data. The driver is custom software that:
1. Reads music sequence data (often a MIDI-like event list) from PSRAM
2. Maps musical notes to sample numbers and pitch values
3. Writes to DSP KON/KOFF registers to start/stop notes
4. Updates voice pitch, volume, and effects registers each "tick"
5. Responds to commands from the main CPU via the 4 I/O ports (`$00F4–$00F7`)

**SPC files** (`.spc`) are a standard dump format capturing the full state of PSRAM + DSP registers + SPC700 registers, allowing standalone playback of SNES music.

---

## 14. Cartridge and ROM Structure

### ROM Header

Located inside the ROM at a fixed offset depending on mapper type. The header is **64 bytes** starting at:
- **LoROM**: `$007FC0` in the ROM file (bank `$00`, offset `$FFC0` = absolute byte `$7FC0`)
- **HiROM**: `$00FFC0` in the ROM file (bank `$00`, offset `$FFC0` = absolute byte `$FFC0`)

Some ROMs have a **512-byte copier header** prepended; subtract 512 from byte offsets when present.

**Detecting LoROM vs HiROM**: Read byte at `$7FD5` (LoROM) and `$FFD5` (HiROM). Whichever has a valid map mode byte and a passing checksum is the correct mapping. The checksum complement at `[header+$1C]` + checksum at `[header+$1E]` should equal `$FFFF`.

### ROM Header Fields

| Offset from $FFB0 | Length | Field |
|---|---|---|
| $00–$0F | 16 bytes | Maker code (2 chars) + Game code (4 chars) + padding |
| $10–$14 | 5 bytes | Fixed expansion RAM size, special version, cartridge/sub type |
| $15 | 1 byte | Map mode |
| $16 | 1 byte | Cartridge type |
| $17 | 1 byte | ROM size (power of 2 in KB: actual = 1024 × 2^n bytes) |
| $18 | 1 byte | SRAM size (1024 × 2^n bytes; 0 = no SRAM) |
| $19 | 1 byte | Destination code (region) |
| $1A | 1 byte | Fixed ($33 for new-style headers) |
| $1B | 1 byte | Mask ROM version |
| $1C–$1D | 2 bytes | Checksum complement |
| $1E–$1F | 2 bytes | Checksum |
| $20–$2F | 16 bytes | Native vectors (COP, BRK, ABORT, NMI/VBlank, RESET, IRQ) |
| $30–$3F | 16 bytes | Emulation vectors |

**Checksum**: Sum of all bytes in the ROM (with certain bytes treated as `$FF`), truncated to 16 bits. Complement = `$FFFF ^ checksum`.

### Enhancement Chips

Some cartridges contain additional chips that expand capabilities:

| Chip | Purpose |
|---|---|
| Super FX / GSU | Custom RISC processor for 3D polygon rendering (Star Fox) |
| SA-1 | Fast 65816 clone at 10.74 MHz with additional RAM |
| DSP-1/2/3/4 | Math co-processor (vector operations for Mode 7 games) |
| CX4 | Wireframe math (Mega Man X2/X3) |
| S-DD1 | Real-time graphics decompressor |
| SPC7110 | Data decompressor + RTC |
| OBC1 | Sprite management (Metal Combat) |
| BS-X / Satellaview | Flash memory cartridge system |

---

## 15. Practical Notes for ROM Editors

### Locating Graphics Data

1. **Tile data**: In VRAM, but ultimately sourced from ROM. Games typically DMA-copy tiles from ROM into VRAM during level load or V-Blank. Search for DMA setup code (writes to `$420B`) to find where tiles are loaded from.
2. **Common compressions**: SNES games frequently compress graphics in ROM using LZ variants (LZ77, LZ2, custom schemes). SMW uses a custom LZ-like format. Decompress before parsing tile data.
3. **Tile format**: Once located, tiles are in the planar bitplane format described in Section 5. The bit depth depends on which BG mode the game uses for that data.

### Locating Tilemap / Level Data

1. Level tilemaps reference tile indices (10-bit) and palette/flip attributes per the 16-bit entry format (Section 6).
2. Level data is almost always compressed in ROM. Look for decompression routines called during level load.
3. The VRAM address where tilemaps are stored is configured by `BGnSC` registers - trace the level-loading code to find which VRAM addresses the game uses.

### Locating Palette Data

1. Palette data in ROM is raw 15-bit BGR words (little-endian), typically in contiguous blocks of 16 or 32 entries (32 or 64 bytes).
2. Games load palettes via DMA to CGRAM (B Bus address `$22`, set `CGADD` first) or via direct `CGDATA` writes in V-Blank.

### Locating Audio Data

1. The main CPU uploads the entire SPC700 program + audio data to PSRAM at startup or level load.
2. Search for writes to `$2140–$2143` (SPC700 ports) followed by upload loops - this is where audio data originates in ROM.
3. In PSRAM, the sample directory (at `DIR × 256`) lists BRR sample start and loop addresses.
4. BRR data is identified by its 9-byte block structure (1-byte header + 8 bytes of nibbles).
5. **SPC dumps**: Tools can extract PSRAM + SPC700 state into `.spc` files for analysis.

### VRAM Layout Strategy (typical games)

```
$0000–$1FFF   Sprite tiles (4 bpp, 16 colors each)
$2000–$3FFF   BG1 tiles (4 bpp)
$4000–$5FFF   BG2 tiles (4 bpp) or BG1 extended
$6000–$6FFF   BG3 tiles (2 bpp) - often UI/HUD
$7000–$73FF   BG1 tilemap (32×32 = 2 KB)
$7400–$77FF   BG2 tilemap
$7800–$7BFF   BG3 tilemap
$7C00–$7FFF   Available / second tilemap screens
```
(Actual layout varies per game - determined by BGnSC and BGnNBA register values.)

### Key Sizes at a Glance

| Item | Size |
|---|---|
| 8×8 tile @ 2 bpp | 16 bytes |
| 8×8 tile @ 4 bpp | 32 bytes |
| 8×8 tile @ 8 bpp | 64 bytes |
| 32×32 tilemap (1 screen) | 2 KB (2048 bytes) |
| Full palette (256 colors) | 512 bytes |
| 16-color sub-palette | 32 bytes |
| OAM (all 128 sprites) | 544 bytes |
| BRR block (16 samples) | 9 bytes |
| SNES color entry | 2 bytes (15-bit BGR) |

---

*Reference compiled from: Rodrigo Copetti's Super Nintendo Architecture article (copetti.org), supplemented by established SNES hardware documentation.*
