# SNES Development Reference

> Synthesized from the official Nintendo SNES Development Manual Books I & II
> (© 1993–1995 Nintendo). This document extracts the technical specifications
> relevant to reading and editing Super Mario World ROM files.

---

## 1. ROM Header (Internal)

The internal ROM header is located at LoROM offset `$7FB0`–`$7FFF` (file offset, after any 512-byte copier header).

| Offset | Field | Notes |
|--------|-------|-------|
| `$FFB0`–`$FFBF` | Maker Code / Game Code | ASCII identifiers |
| `$FFC0`–`$FFD4` | Game Title | 21 bytes, ASCII, space-padded |
| `$FFD5` | Map Mode | `$20`=LoROM, `$21`=HiROM, `$30`=LoROM fast, `$31`=HiROM fast, `$23`=SA-1, `$25`=ExHiROM |
| `$FFD6` | Cartridge Type | `$00`=ROM only, `$01`=ROM+RAM, `$02`=ROM+RAM+Battery; upper nibble: co-processor (`$0x`=DSP, `$1x`=SuperFX, `$2x`=OBC1, `$3x`=SA-1) |
| `$FFD7` | ROM Size | `$09`=3–4Mbit, `$0A`=5–8Mbit, `$0B`=9–16Mbit, `$0C`=17–32Mbit, `$0D`=33–64Mbit |
| `$FFD8` | RAM Size | `$00`=none, `$01`=16Kbit, `$03`=64Kbit, `$05`=256Kbit, `$06`=512Kbit, `$07`=1Mbit |
| `$FFD9` | Country Code | `$01`=North America (NTSC), `$00`=Japan |
| `$FFDA` | Fixed Value | Always `$33` |
| `$FFDB` | Mask ROM Version | Starts at `$00`, increments per revision |
| `$FFDC`–`$FFDD` | Complement Check | 1's complement of checksum |
| `$FFDE`–`$FFDF` | Checksum | 16-bit sum of all ROM bytes |

### Checksum Calculation

Sum all bytes in the ROM data. If the ROM isn't a power-of-2 size (e.g., 12Mbit), calculate as if it were the next power of 2 (16Mbit) by repeating the remainder region. The lower 16 bits of the total = checksum. `Checksum + Complement Check = $FFFF`.

---

## 2. Memory Map

### LoROM (Mode 20/30) — used by SMW

| Bank Range | Address Range | Maps To |
|------------|---------------|---------|
| `$00`–`$3F` | `$8000`–`$FFFF` | ROM (32 KB per bank) |
| `$00`–`$3F` | `$0000`–`$1FFF` | WRAM (first 8 KB mirror) |
| `$00`–`$3F` | `$2000`–`$5FFF` | I/O registers (PPU, CPU, DMA) |
| `$00`–`$3F` | `$6000`–`$7FFF` | Expansion (SRAM for some carts) |
| `$40`–`$6F` | `$0000`–`$FFFF` | Extended ROM (uncommon) |
| `$70`–`$7D` | `$0000`–`$7FFF` | SRAM |
| `$7E` | `$0000`–`$FFFF` | WRAM (first 64 KB) |
| `$7F` | `$0000`–`$FFFF` | WRAM (second 64 KB) |
| `$80`–`$FF` | — | Mirrors of `$00`–`$7F` |

**LoROM file offset formula:**
```
offset = (bank & 0x7F) × 0x8000 + (addr − 0x8000)
```
Add 512 if a copier header is present (detected when `fileSize % 1024 === 512`).

### HiROM (Mode 21/31)

| Bank Range | Address Range | Maps To |
|------------|---------------|---------|
| `$00`–`$3F` | `$8000`–`$FFFF` | ROM upper 32 KB |
| `$40`–`$7D` | `$0000`–`$FFFF` | ROM full 64 KB banks |
| `$C0`–`$FF` | `$0000`–`$FFFF` | ROM full 64 KB banks |

**HiROM file offset formula:**
```
offset = (bank & 0x3F) × 0x10000 + addr
```

---

## 3. PPU — Picture Processing Unit

The S-PPU generates the video output. All PPU registers are at addresses `$2100`–`$213F` (I/O region, accessible from banks `$00`–`$3F` and `$80`–`$BF`).

### 3.1 BG Modes

The SNES supports 8 BG modes (0–7) set via register `$2105` (BGMODE).

**SMW uses Mode 1** (3 BG layers + OBJ):

| Layer | Bit Depth | Colors/Tile | Palettes | Colors on Screen |
|-------|-----------|-------------|----------|-----------------|
| BG1 (foreground) | 4bpp | 16 | 8 | 128 |
| BG2 (background) | 4bpp | 16 | 8 | 128 |
| BG3 (status bar) | 2bpp | 4 | 8 | 32 |
| OBJ (sprites) | 4bpp | 16 | 8 | 128 |

- BG tile cell size: 8×8 or 16×16
- OBJ cell sizes: 8×8, 16×16, 32×32, 64×64 (selectable pairs)
- OBJ attributes: H-flip, V-flip, display priority (against BG)

### 3.2 Key PPU Registers

| Address | Name | R/W | Function |
|---------|------|-----|----------|
| `$2100` | INIDISP | W | Screen display: D7=forced blank, D3–D0=brightness (0–15) |
| `$2101` | OBSEL | W | OBJ size select + character base address |
| `$2105` | BGMODE | W | BG mode (D2–D0) + character size bits (D4–D7) |
| `$2106` | MOSAIC | W | Mosaic size (D7–D4) + mosaic enable per BG (D3–D0) |
| `$2107`–`$210A` | BGnSC | W | BG1–4 tilemap base address + screen size |
| `$210B`–`$210C` | BGnNBA | W | BG character data base address |
| `$210D`–`$2114` | BGnHOFS/VOFS | W | BG1–4 horizontal/vertical scroll |
| `$2115` | VMAIN | W | VRAM address increment mode |
| `$2116`–`$2117` | VMADDL/H | W | VRAM address (word address) |
| `$2118`–`$2119` | VMDATAL/H | W | VRAM data write (low/high byte) |
| `$2121` | CGADD | W | **CG-RAM address** (palette index 0–255) |
| `$2122` | CGDATA | W | **CG-RAM data write** (BGR555, 2 writes per color) |
| `$212C` | TM | W | Main screen layer enable (D0=BG1..D4=OBJ) |
| `$212D` | TS | W | Sub screen layer enable |
| `$2130` | CGWSEL | W | Color math control: D1=CC ADD enable, D0=Direct Select |
| `$2131` | CGADSUB | W | Color math: ADD/SUB, half, per-layer enable |
| `$2132` | COLDATA | W | Color constant data (fixed color for math) |
| `$2133` | SETINI | W | Screen mode: interlace, pseudo-512, overscan |
| `$213B` | CGDATAREAD | R | **CG-RAM data read** (BGR555, 2 reads per color) |

### 3.3 VRAM (Video RAM) — 64 KB

VRAM holds both tile character data and tilemap (screen) data. Addressed as 32K words (each word = 2 bytes).

**Writing to VRAM:**
1. Set increment mode via `$2115` (VMAIN)
2. Set word address via `$2116`/`$2117` (VMADDL/H)
3. Write data via `$2118`/`$2119` (VMDATAL/H)

**Tile character data formats:**
- 2bpp: 16 bytes/tile (planes 0–1 interleaved by row)
- 3bpp: 24 bytes/tile (planes 0–1 as 2bpp + plane 2 appended)
- 4bpp: 32 bytes/tile (planes 0–1, then planes 2–3)
- 8bpp: 64 bytes/tile

**Tilemap entry format** (2 bytes per tile):
```
Byte 1 (high): V H P P P C C C
Byte 0 (low):  C C C C C C C C
```
- `V` = vertical flip
- `H` = horizontal flip
- `PPP` = priority (palette number for this tile, 0–7)
- `CCCCCCCCCC` = 10-bit character number (tile index in VRAM)

---

## 4. CG-RAM (Color Generator RAM) — Palettes

CG-RAM holds **256 colors** (512 bytes). Each color is a 15-bit BGR555 word.

### 4.1 BGR555 Color Format

Each color occupies 2 bytes (little-endian):
```
Bit:  15  14 13 12 11 10   9  8  7  6  5   4  3  2  1  0
       X   B  B  B  B  B   G  G  G  G  G   R  R  R  R  R
```
- Red: bits 4–0 (5 bits, 0–31)
- Green: bits 9–5 (5 bits, 0–31)
- Blue: bits 14–10 (5 bits, 0–31)
- Bit 15: unused

**Conversion to 8-bit RGB** (bit-replication for full range):
```
R8 = (R5 << 3) | (R5 >> 2)   // maps 0→0, 31→255
G8 = (G5 << 3) | (G5 >> 2)
B8 = (B5 << 3) | (B5 >> 2)
```

### 4.2 CG-RAM Layout

The 256 colors are organized into 16 sub-palettes of 16 colors each:

```
CG-RAM Index:  0x00  ···  0x0F    Sub-palette 0 (BG palette 0)
               0x10  ···  0x1F    Sub-palette 1 (BG palette 1)
               0x20  ···  0x2F    Sub-palette 2 (BG palette 2)
               ···
               0x70  ···  0x7F    Sub-palette 7 (BG palette 7)
               0x80  ···  0x8F    Sub-palette 8 (OBJ palette 0)
               0x90  ···  0x9F    Sub-palette 9 (OBJ palette 1)
               ···
               0xF0  ···  0xFF    Sub-palette 15 (OBJ palette 7)
```

In our palette viewer, this maps to a **16×16 grid** where:
- **Row** = sub-palette number (0–15)
- **Column** = color index within the sub-palette (0–15)
- **Rows 0–7** = BG sub-palettes (tiles select via 3-bit palette attribute)
- **Rows 8–15** = OBJ sub-palettes (sprites select via 3-bit palette attribute)

### 4.3 Color Index 0 — Transparency & Backdrop

- **CG-RAM[0x00]** (row 0, col 0) is special: it is the **backdrop color** — the color displayed when no BG or OBJ pixel is drawn at a screen position.
- For **all other sub-palettes** (index `N×16+0` where N > 0): color index 0 means "transparent" — that pixel is not drawn, and lower-priority layers show through.
- Color index 0 is **never drawn** for sprites (OBJ pixels with index 0 are always transparent).

### 4.4 Writing to CG-RAM

CG-RAM is accessed via registers `$2121` (CGADD) and `$2122` (CGDATA):

1. Write the palette address (0–255) to `$2121`
2. Write the low byte of the BGR555 color to `$2122`
3. Write the high byte to `$2122` (auto-increments address)

**CG-RAM can only be written during V-Blank or Forced Blank.**

### 4.5 Mode 1 Palette Assignment (SMW)

For Mode 1 (SMW's BG mode):
- **BG1 & BG2 share** CG-RAM indices `$00`–`$7F` (sub-palettes 0–7)
- **BG3** uses indices `$00`–`$1F` only (sub-palettes 0–3, 4-color each)
- **OBJ** uses indices `$80`–`$FF` (sub-palettes 8–15)

Each BG tile's tilemap entry contains a 3-bit palette number (0–7) that selects which sub-palette to use. Each OBJ's OAM entry also contains a 3-bit palette number (0–7, mapped to sub-palettes 8–15).

---

## 5. OBJ (Sprites)

### 5.1 OAM (Object Attribute Memory)

OAM holds data for 128 sprites (544 bytes total):
- **Table 1** (512 bytes): 128 entries × 4 bytes each
- **Table 2** (32 bytes): 128 entries × 2 bits each (size bit + X MSB)

**OAM Table 1 entry (4 bytes):**
```
Byte 0: X position (low 8 bits)
Byte 1: Y position (8 bits)
Byte 2: Character number (low 8 bits)
Byte 3: V H P P  N C C C
         │ │ │ │  │ └─┘─── Palette number (0–7 → CG-RAM sub-palettes 8–15)
         │ │ └─┘──── Priority (0–3, vs BG layers)
         │ └──── H-flip
         └──── V-flip
         N = Character number bit 8 (name table select)
```

**OAM Table 2** (2 bits per sprite):
- Bit 0: Size select (0=small, 1=large; sizes set by `$2101` OBSEL)
- Bit 1: X position bit 8 (sign extension for off-screen)

### 5.2 OBJ Size Combinations

Register `$2101` (OBSEL) bits D7–D5 select the size pair:

| D7–D5 | Small | Large |
|-------|-------|-------|
| 000 | 8×8 | 16×16 |
| 001 | 8×8 | 32×32 |
| 010 | 8×8 | 64×64 |
| 011 | 16×16 | 32×32 |
| 100 | 16×16 | 64×64 |
| 101 | 32×32 | 64×64 |

### 5.3 OBJ Display Limits

Per scanline: max **32 sprites** and **34 8×8 tiles**. Exceeding these causes sprite dropout (range/time overflow flags in `$213E`).

---

## 6. DMA (Direct Memory Access)

8 DMA channels (0–7), each configured via registers `$43x0`–`$43xA` (x = channel).

### 6.1 General DMA (G-DMA)

Transfers a block of data between CPU bus and a PPU register. Used during V-Blank to bulk-transfer data to VRAM, CG-RAM, or OAM.

| Register | Function |
|----------|----------|
| `$43x0` | DMA control: direction, address mode, transfer type |
| `$43x1` | B-bus address (PPU register, e.g., `$22` for CG-RAM data) |
| `$43x2`–`$43x4` | A-bus address (source/dest in CPU space) |
| `$43x5`–`$43x6` | Transfer byte count |
| `$420B` | DMA enable (write bit mask to trigger channels) |

**Common DMA patterns:**
- **VRAM transfer**: B-bus = `$18`/`$19` (VMDATAL/H), transfer type = word
- **CG-RAM transfer**: B-bus = `$22` (CGDATA), transfer type = word (writes 2 bytes per color)
- **OAM transfer**: B-bus = `$04` (OAMDATA)

### 6.2 H-DMA

Horizontal DMA — transfers data every scanline (during H-Blank). Used for raster effects like gradient backgrounds, HDMA color math, and parallax scrolling.

- **Absolute addressing (Type 0)**: table in CPU RAM has line count + data
- **Indirect addressing (Type 1)**: table has line count + pointer to data

---

## 7. Sound (SPC700/DSP)

The SNES audio system consists of:
- **SPC700** — 8-bit sound CPU, independent from main 65816 CPU
- **DSP** — 8-channel digital signal processor
- **64 KB** Audio RAM (shared between SPC700 program and sample data)

Communication between SCPU and SPC700 via 4 I/O ports:
- `$2140`–`$2143` (SCPU side) ↔ `$00F4`–`$00F7` (SPC700 side)

### 7.1 BRR Sample Format

Audio samples use BRR (Bit Rate Reduction) compression:
- 9 bytes per block: 1 header + 8 data bytes = 16 samples
- 4 bits per sample (signed), with filter prediction
- Header: `RRRRFFLE` (range, filter, loop, end flags)

---

## 8. Co-Processors (Book II)

### 8.1 SA-1 (Super Accelerator)

A second 65816 processor clocked at 10.74 MHz (4× the SCPU). Used in games like Kirby Super Star, Super Mario RPG.

Key features:
- Parallel processing with SCPU
- Character conversion hardware (Type 1: bitmap→planar, Type 2: planar→bitmap)
- Arithmetic unit (multiplication, division, cumulative sum)
- Variable-length bit processing
- Internal timer

### 8.2 Super FX (GSU)

A custom RISC processor (Mario Chip / GSU) for 3D graphics. Used in Star Fox, Yoshi's Island.

- 16 general-purpose registers (R0–R15)
- PLOT instruction for pixel rendering
- Hardware multiply
- Cache-based execution from ROM

### 8.3 DSP1

Math co-processor for trigonometry, matrix operations, 3D projection. Used in Pilotwings, Super Mario Kart.

Commands include:
- Trigonometric functions (sin, cos, atan)
- Vector/matrix operations (3D rotation, projection)
- Attitude calculation

---

## 9. Video Timing

### NTSC

| Parameter | Value |
|-----------|-------|
| Frame rate | 60.098 Hz (1/60.098 sec per frame) |
| Scanlines per frame | 262 (non-interlace) / 263 (interlace, odd) |
| Active display | Lines 1–224 (or 1–239 in overscan) |
| V-Blank | Lines 225–261 (or 240–261 in overscan) |
| Dots per scanline | 340 (H-counter 0–339) |
| Active dots | 256 (H-counter 22–277) |
| Master clock | 21.477 MHz |
| CPU clock | 3.58 MHz (fast) / 2.68 MHz (slow) |

### PAL

| Parameter | Value |
|-----------|-------|
| Frame rate | 50.007 Hz |
| Scanlines per frame | 312 (non-interlace) |
| Active display | Lines 1–239 |
| V-Blank | Lines 240–311 |

**V-Blank is the primary window for VRAM/CG-RAM/OAM writes.** Outside V-Blank, these memories are being read by the PPU for rendering and writes produce glitches (except during Forced Blank via `$2100` D7=1).

---

## 10. Color Math (Addition/Subtraction)

The SNES can blend the Main Screen with the Sub Screen (or a fixed color constant).

### Registers

| Register | Function |
|----------|----------|
| `$2130` (CGWSEL) | Color math control: clip mode, prevent mode, CC ADD enable, direct select |
| `$2131` (CGADSUB) | D7=ADD(0)/SUB(1), D6=half enable, D5–D0=per-layer enable (OBJ,BG4,BG3,BG2,BG1,Backdrop) |
| `$2132` (COLDATA) | Fixed color constant: D7=blue, D6=green, D5=red, D4–D0=intensity |

### Modes

- **Screen Addition**: Main + Sub → brighter (light effects)
- **Screen Subtraction**: Main − Sub → darker (shadow effects)
- **Half mode**: (Main + Sub) / 2 → transparency effect
- **Color Constant**: replaces Sub screen with a fixed RGB color

---

## 11. Window Masking

Two rectangular windows (W1, W2) can mask BG layers and OBJ. Each layer can be independently enabled for either or both windows, with AND/OR/XOR/XNOR logic combining the two window regions.

| Register | Function |
|----------|----------|
| `$2123`–`$2125` | Window enable per layer + inversion |
| `$2126`–`$2129` | Window 1/2 left/right positions |
| `$212A`–`$212B` | Window logic (AND/OR/XOR/XNOR per layer) |
| `$212E`–`$212F` | Window mask designate for Main/Sub screen |

A "Color Window" can also clip or prevent color math in windowed/non-windowed regions (controlled via `$2130`).

---

## 12. Controllers

### Standard Controller

16-bit data read via registers `$4218`–`$421F` (auto-read) or `$4016`/`$4017` (manual):

```
Bit:  15 14 13 12 11 10  9  8  7  6  5  4  3  2  1  0
       B  Y  Se St Up Dn Lt Rt  A  X  L  R  -  -  -  -
```

Auto-read is enabled via `$4200` D0. Results available in `$4218`–`$421F` after V-Blank NMI.

### MultiPlayer 5 (Multitap)

Supports up to 5 controllers. Uses a BIOS routine for reading.

### Super Scope

Infrared light gun. Position detected via H/V counter latch (`$2137`, `$213C`/`$213D`).

### Mouse

2-button mouse with relative X/Y movement data.

---

## 13. Appendix: SNES Register Quick Reference

### PPU Registers ($2100–$213F)

| Addr | Name | R/W | Purpose |
|------|------|-----|---------|
| `$2100` | INIDISP | W | Display control (brightness + forced blank) |
| `$2101` | OBSEL | W | OBJ size + name base |
| `$2102`/`$2103` | OAMADDL/H | W | OAM address |
| `$2104` | OAMDATA | W | OAM data write |
| `$2105` | BGMODE | W | BG mode + tile size |
| `$2106` | MOSAIC | W | Mosaic settings |
| `$2107`–`$210A` | BG1SC–BG4SC | W | BG tilemap base + size |
| `$210B`/`$210C` | BG12NBA/BG34NBA | W | BG character base |
| `$210D`–`$2114` | BGnHOFS/VOFS | W | BG scroll offsets (2-write each) |
| `$2115` | VMAIN | W | VRAM address increment mode |
| `$2116`/`$2117` | VMADDL/H | W | VRAM word address |
| `$2118`/`$2119` | VMDATAL/H | W | VRAM data write |
| `$211A` | M7SEL | W | Mode 7 settings |
| `$211B`–`$2120` | M7A–M7D, M7X/Y | W | Mode 7 matrix + center |
| `$2121` | CGADD | W | CG-RAM address (0–255) |
| `$2122` | CGDATA | W | CG-RAM data write (BGR555, 2 writes) |
| `$2123`–`$2125` | W12SEL, W34SEL, WOBJSEL | W | Window enable/invert |
| `$2126`–`$2129` | WH0–WH3 | W | Window positions |
| `$212A`/`$212B` | WBGLOG/WOBJLOG | W | Window logic |
| `$212C` | TM | W | Main screen designation |
| `$212D` | TS | W | Sub screen designation |
| `$212E`/`$212F` | TMW/TSW | W | Main/Sub window mask |
| `$2130` | CGWSEL | W | Color math control |
| `$2131` | CGADSUB | W | Color math add/sub settings |
| `$2132` | COLDATA | W | Fixed color data |
| `$2133` | SETINI | W | Screen mode (interlace, pseudo-512, overscan) |
| `$2134`–`$2136` | MPYL/M/H | R | Multiplication result (Mode 7) |
| `$2137` | SLHV | R | Software latch for H/V counter |
| `$2138` | OAMDATAREAD | R | OAM data read |
| `$2139`/`$213A` | VMDATALREAD/H | R | VRAM data read |
| `$213B` | CGDATAREAD | R | CG-RAM data read |
| `$213C`/`$213D` | OPHCT/OPVCT | R | H/V counter data |
| `$213E` | STAT77 | R | PPU1 status (OBJ time/range overflow) |
| `$213F` | STAT78 | R | PPU2 status (interlace, PAL/NTSC) |

### CPU Registers ($4200–$4217)

| Addr | Name | R/W | Purpose |
|------|------|-----|---------|
| `$4200` | NMITIMEN | W | NMI/IRQ enable + auto-joypad read |
| `$4201` | WRIO | W | Programmable I/O port (output) |
| `$4202`/`$4203` | WRMPYA/B | W | Unsigned multiply operands |
| `$4204`–`$4206` | WRDIVL/H/B | W | Unsigned divide operands |
| `$4207`–`$420A` | HTIMEL/H, VTIMEL/H | W | H/V IRQ timer targets |
| `$420B` | MDMAEN | W | General DMA channel enable |
| `$420C` | HDMAEN | W | H-DMA channel enable |
| `$420D` | MEMSEL | W | ROM access speed (0=slow, 1=fast) |
| `$4210` | RDNMI | R | NMI flag + PPU version |
| `$4211` | TIMEUP | R | IRQ flag |
| `$4212` | HVBJOY | R | H-Blank/V-Blank/Auto-Joypad status |
| `$4214`/`$4215` | RDDIVL/H | R | Division quotient |
| `$4216`/`$4217` | RDMPYL/H | R | Multiply/remainder result |
| `$4218`–`$421F` | JOYnL/H | R | Auto-read joypad data (4 pads × 2 bytes) |

### DMA Channel Registers ($4300–$437A)

Each channel `n` (0–7) uses `$43n0`–`$43nA`:

| Offset | Name | Purpose |
|--------|------|---------|
| `$43n0` | DMAPn | DMA direction, HDMA indirect, address mode, transfer unit |
| `$43n1` | BBADn | B-bus address (PPU register low byte, e.g., `$18` for VMDATAL) |
| `$43n2`–`$43n4` | A1TnL/H/B | A-bus address (24-bit CPU address) |
| `$43n5`/`$43n6` | DASnL/H | DMA byte count / HDMA indirect address |
| `$43n7` | DASBn | HDMA indirect bank |
| `$43n8`/`$43n9` | A2AnL/H | HDMA table current address |
| `$43nA` | NTRLn | HDMA line counter |
