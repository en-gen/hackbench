# SNES / Super Famicom Technical Reference

Sourced from https://wiki.superfamicom.org/ - covers PPU/graphics, memory map, ROM format,
DMA/HDMA, SPC700/APU/BRR, controllers, and auxiliary chips. Intended for ROM-file reading,
level-graphics display, and audio playback without emulation.

---

## Table of Contents

1. [System Overview & Timing](#1-system-overview--timing)
2. [Memory Map](#2-memory-map)
3. [ROM Header & Cartridge Formats](#3-rom-header--cartridge-formats)
4. [PPU - Palettes & CGRAM](#4-ppu--palettes--cgram)
5. [PPU - BG Modes & Tilemaps](#5-ppu--bg-modes--tilemaps)
6. [PPU - Sprites / OAM](#6-ppu--sprites--oam)
7. [PPU - Rendering, Color Math & Windows](#7-ppu--rendering-color-math--windows)
8. [DMA & HDMA](#8-dma--hdma)
9. [SPC700 / APU](#9-spc700--apu)
10. [BRR Audio Sample Format](#10-brr-audio-sample-format)
11. [N-SPC Music Format](#11-n-spc-music-format)
12. [SPC File Format & ID666 Tags](#12-spc-file-format--id666-tags)
13. [65816 CPU](#13-65816-cpu)
14. [Controller Input](#14-controller-input)
15. [Complete Register Reference](#15-complete-register-reference)
16. [SA-1 Coprocessor Registers](#16-sa-1-coprocessor-registers)
17. [BS-X Satellaview Header](#17-bs-x-satellaview-header)
18. [Open Bus Behavior](#18-open-bus-behavior)
19. [Expansion Chips Summary](#19-expansion-chips-summary)

---

## 1. System Overview & Timing

### Master Clock

| Region | Frequency |
|--------|-----------|
| NTSC   | ~21.477 MHz (exactly 1,890,000,000/88 Hz) |
| PAL    | 21.281370 MHz |

### CPU (S-CPU 5A22) Timing

- **Memory access speeds**
  - Fast (IO): 6 master cycles
  - Slow: 8 master cycles
  - XSlow (CPU-internal $4000–$41FF): 12 master cycles
  - FastROM enabled via `$420D` bit 0; requires 120 ns or faster ROM on real hardware

- **Scanline structure (NTSC)**
  - 1,364 master cycles per scanline
  - Exception: non-interlace mode scanline `$F0` on alternating frames = 1,360 cycles
  - 262 scanlines in non-interlace mode
  - Interlace frames with `$213F` bit 7 = 0 → 263 scanlines

- **V-Blank** starts at scanline `$E1` (224-line) or `$F0` (239-line overscan), runs to end of frame
- **WRAM refresh**: CPU pauses ~40 cycles starting ~536 cycles after each scanline begins

### PPU (S-PPU) Timing

- 340 dots per scanline (dots 323 and 327 are 6 master cycles instead of 4)
- Pixel output: 1 pixel per 4 master cycles, dots 22–277 on scanlines 1–224 (or 239)
- **H-Blank**: dots 274 through 1 (of next scanline)
- **V-Blank**: scanline `$E1`/`$F0` H=0, ends at V=0 H=0
- VRAM access: 4 master cycles per access; 256 memory-access cycles per visible scanline
- H-Blank sprite/tile pre-fetch: 84 cycles (34 sprite tiles × 2 + 16 overhead)
- OAM auto-reset at H=10 on scanline 225/240 when V-Blank begins (force-blank must be off)

### Audio (S-APU) Timing

- SPC700 clock: nominally 1,024,000 Hz; actual ~1,026,900 Hz (master ÷ 24)
- DSP output rate: 32,000 Hz (1 sample per 32 SPC700 cycles)
- Fast timer tick: every 16 SPC700 cycles (~64 kHz)
- Slow timer tick: every 128 SPC700 cycles (~8 kHz)

### NMI / IRQ

- NMI goes low at H=0.5, V=V-Blank start; goes high at V=0 H=0 or on `$4210` read
- IRQ (H=0 case): fires at 1,374 master cycles after previous scanline dot 0
- IRQ (other): fires at 14 + H×4 master cycles after current scanline dot 0
- Auto-joypad read begins dots 32.5–95.5 of first V-Blank scanline; lasts 4,224 master cycles

---

## 2. Memory Map

### Data Bus
- 8-bit data bus; open-bus behavior (MDR persists when no device drives the bus)
- Address Bus A: 24-bit (CPU ↔ WRAM, cartridge)
- Address Bus B: 8-bit (`$21xx`; CPU ↔ PPU1/PPU2/APU/expansion)

### Full Address Map

| Banks       | Offset Range   | Speed  | Device                                         |
|-------------|----------------|--------|------------------------------------------------|
| `$00–$3F`   | `$0000–$1FFF`  | Slow   | WRAM mirror (maps to `$7E:0000–$1FFF`)         |
| `$00–$3F`   | `$2000–$20FF`  | Fast   | Bus A (unmapped / open bus)                    |
| `$00–$3F`   | `$2100–$21FF`  | Fast   | Bus B - PPU1/PPU2 (`$2100–$213F`), APU (`$2140–$2143`), WRAM (`$2180–$2183`) |
| `$00–$3F`   | `$2200–$3FFF`  | Fast   | Bus A (open bus in base SNES)                  |
| `$00–$3F`   | `$4000–$41FF`  | XSlow  | CPU internal (joypad serial `$4016–$4017`)     |
| `$00–$3F`   | `$4200–$43FF`  | Fast   | CPU internal registers (interrupt, DMA, etc.)  |
| `$00–$3F`   | `$4400–$5FFF`  | Fast   | Bus A                                          |
| `$00–$3F`   | `$6000–$7FFF`  | Slow   | Bus A (cartridge expansion RAM on some carts)  |
| `$00–$3F`   | `$8000–$FFFF`  | Slow   | Bus A + /CART (LoROM data)                     |
| `$40–$7D`   | `$0000–$FFFF`  | Slow   | Bus A + /CART (HiROM / ExHiROM upper banks)    |
| `$7E–$7F`   | `$0000–$FFFF`  | Slow   | WRAM (128 KB total: `$7E:0000–$7F:FFFF`)       |
| `$80–$BF`   | (mirrors)      | -      | Same as `$00–$3F` (FastROM mirror)             |
| `$C0–$FF`   | `$0000–$FFFF`  | Note*  | Bus A + /CART                                  |

*Speed = Fast if `$420D` bit 0 set, Slow otherwise.

### Key Fixed Addresses

| Address Range      | Purpose                                   |
|--------------------|-------------------------------------------|
| `$7E:0000–$7E:1FFF`| WRAM scratchpad / stack                   |
| `$7E:2000–$7F:FFFF`| WRAM (general purpose, 126 KB)            |
| `$00–$3F:$2100–$213F` | PPU registers (Bus B)                  |
| `$00–$3F:$2140–$2143` | APU I/O ports                          |
| `$00–$3F:$2180–$2183` | WRAM access port                       |
| `$00–$3F:$4200–$421F` | CPU interrupt / joypad / math regs     |
| `$00–$3F:$420B–$420C` | DMA / HDMA enable                      |
| `$00–$3F:$4300–$437F` | DMA / HDMA channel registers (×8)      |

### ROMSEL Logic

```
/ROMSEL asserted when: (addr & 0x408000 == 0) || (addr & 0xFE0000 == 0x7E0000)
```

### LoROM vs HiROM

| Feature        | LoROM                              | HiROM                              |
|----------------|------------------------------------|------------------------------------|
| ROM banks      | 32 KB per bank at `$8000–$FFFF`   | 64 KB per bank at `$0000–$FFFF`   |
| Bank range     | `$00–$7D`, `$80–$FF`              | `$C0–$FF` (and mirrored `$40–$7D`)|
| MAD-1 pin 10   | GND                                | Vcc                                |
| Max ROM size   | 4 MB (ExLoROM up to 8 MB)         | 4 MB (ExHiROM up to 8 MB)         |
| Header location| `$7FBx` (bank `$00`)              | `$FFBx` (bank `$00`)              |

### LoROM Address Conversion (ROM offset → SNES pointer)

1. Subtract 512 (`$200`) if a copier header is present
2. Remove the bank byte (top two hex digits / high byte of 3-byte address)
3. Byte-swap the remaining 16-bit value
4. If result < `$8000`, add `$8000`

Example: ROM offset `$02A640` → strip bank → `$A640` → swap → `$40A6`

### ROM Size Conventions

Must be multiples of 32 KB (`$8000`); stable at 80,000-byte multiples:

| Size   | Hex offset |
|--------|------------|
| 0.5 MB | `$080000`  |
| 1.0 MB | `$100000`  |
| 2.0 MB | `$200000`  |
| 4.0 MB | `$400000`  |

---

## 3. ROM Header & Cartridge Formats

### Standard SNES Internal Header

The internal header lives at a fixed offset inside the ROM image:

| Mapping | Header base address (ROM file offset) |
|---------|--------------------------------------|
| LoROM   | `$007FB0` (or `$007FB0 + $200` with copier header) |
| HiROM   | `$00FFB0` (or `$00FFB0 + $200` with copier header) |

#### Header Fields

| Offset (from `xFB0`) | Size  | Field                    | Notes                                              |
|-----------------------|-------|--------------------------|----------------------------------------------------|
| `xFB0–xFB1`          | 2     | Maker/Licensee Code      | BCD or ASCII publisher code                        |
| `xFB2–xFB5`          | 4     | Game Code                | 4-char ASCII (newer games only)                    |
| `xFB6–xFBD`          | 8     | Reserved / Fixed         | Must be zero (or `$00`)                            |
| `xFBE`               | 1     | Expansion RAM size       | `$00` = none; size = `1 << (n + 1)` KB            |
| `xFBF`               | 1     | Special version          | Usually `$00`                                      |
| `xFC0–xFCF`          | 21    | Game Title               | ASCII, padded with spaces (`$20`)                  |
| `xFD0`               | 1     | Map Mode                 | See table below                                    |
| `xFD1`               | 1     | Cartridge Type           | See table below                                    |
| `xFD2`               | 1     | ROM Size                 | `n` → size = `1 << n` KB (e.g., `$08` = 256 KB)   |
| `xFD3`               | 1     | SRAM Size                | `n` → size = `1 << n` KB; `$00` = none            |
| `xFD4`               | 1     | Country / Destination    | `$00`=Japan, `$01`=USA, `$02`=Europe, etc.         |
| `xFD5`               | 1     | Developer / License ID   | `$33` if using extended header at `xFB0`           |
| `xFD6`               | 1     | Version                  | `$00` = 1.00                                       |
| `xFDC–xFDD`          | 2     | Checksum Complement      | `0xFFFF - checksum`                                |
| `xFDE–xFDF`          | 2     | Checksum                 | Sum of all bytes in ROM (16-bit, with wrapping)    |
| `xFE0–xFEF`          | 16    | Native mode vectors      | See interrupt vector table                         |
| `xFF0–xFFF`          | 16    | Emulation mode vectors   | See interrupt vector table                         |

#### Map Mode Byte (`xFD0`)

| Bit(s) | Meaning                                              |
|--------|------------------------------------------------------|
| 3:0    | `$0` = LoROM; `$1` = HiROM; `$5` = ExHiROM; `$A` = ExLoROM |
| 4      | `1` = FastROM (120 ns); `0` = SlowROM (200 ns)       |

Common values: `$20` = SlowROM LoROM, `$21` = SlowROM HiROM, `$30` = FastROM LoROM, `$31` = FastROM HiROM

#### Cartridge Type Byte (`xFD1`)

| Value  | Type                          |
|--------|-------------------------------|
| `$00`  | ROM only                      |
| `$01`  | ROM + RAM                     |
| `$02`  | ROM + RAM + Battery (SRAM)    |
| `$03`  | ROM + SA-1                    |
| `$13`  | ROM + SuperFX                 |
| `$25`  | ROM + OBC-1                   |
| `$34`  | ROM + SA-1 + Battery          |
| `$F3`  | ROM + Cx4                     |
| `$F5`  | ROM + SPC7110                 |

#### Interrupt Vectors (Native Mode, `$00FFEx`)

| Vector  | Address      | Event          |
|---------|--------------|----------------|
| `$FFE4` | 2 bytes      | COP            |
| `$FFE6` | 2 bytes      | BRK            |
| `$FFE8` | 2 bytes      | ABORT          |
| `$FFEA` | 2 bytes      | NMI            |
| `$FFEC` | 2 bytes      | (unused)       |
| `$FFEE` | 2 bytes      | IRQ            |

#### Interrupt Vectors (Emulation Mode, `$00FFFx`)

| Vector  | Address      | Event          |
|---------|--------------|----------------|
| `$FFF4` | 2 bytes      | COP            |
| `$FFF8` | 2 bytes      | ABORT          |
| `$FFFA` | 2 bytes      | NMI            |
| `$FFFC` | 2 bytes      | RESET          |
| `$FFFE` | 2 bytes      | IRQ/BRK        |

### Checksum Calculation

```
checksum = sum of all bytes in ROM (16-bit, wraps) 
complement = 0xFFFF XOR checksum    (stored at xFDC–xFDD)
checksum stored at xFDE–xFDF
complement + checksum must equal 0xFFFF
```

---

## 4. PPU - Palettes & CGRAM

### CGRAM Layout

- **Size**: 512 bytes = 256 colors × 2 bytes each
- **Format**: 15-bit BGR (bit 15 unused, always 0)

```
Bit layout of each 16-bit color word (stored little-endian):
  Bit 15 : 0 (unused)
  Bits 14–10 : BBBBB (Blue, 0–31)
  Bits 9–5  : GGGGG (Green, 0–31)
  Bits 4–0  : RRRRR (Red, 0–31)

Byte form: 0BBBBBGG GGGRRRRR
```

### Sub-palette Organization

- 256 colors split into **16 sub-palettes of 16 colors** each
- Background layers use sub-palettes **0–7** (palette indices 0–127)
- Sprites use sub-palettes **8–15** (palette indices 128–255)
- **Color 0 in any palette is always transparent**
- Mode 0 uses four layers × 8 sub-palettes of **4 colors** each

### Color Conversion Formulas

**24-bit RGB → 15-bit BGR:**
```
R5 = R8 / 8     (or R8 >> 3)
G5 = G8 / 8
B5 = B8 / 8
color = (B5 << 10) | (G5 << 5) | R5
White: 31*1024 + 31*32 + 31 = 0x7FFF, stored as bytes FF 7F
```

**15-bit BGR → 24-bit RGB (with range stretching):**
```
R8 = (color & 0x1F) << 3;  R8 += R8 >> 5   // replicate top 3 bits
G8 = ((color >> 5) & 0x1F) << 3;  G8 += G8 >> 5
B8 = ((color >> 10) & 0x1F) << 3;  B8 += B8 >> 5
```
Without stretching: values are 0, 8, 16, ..., 248 (not 0–255).

### CGRAM Access Registers

| Register | Address | Direction | Description |
|----------|---------|-----------|-------------|
| CGADD    | `$2121` | W         | Set CGRAM word address (0–255) |
| CGDATA   | `$2122` | W (×2)    | Write color data (write low byte then high byte) |
| CGDATAREAD | `$213B` | R (×2)  | Read color data |

Write sequence for one color:
1. Write color index (0–255) to `$2121`
2. Write low byte of color word to `$2122`
3. Write high byte of color word to `$2122`

DMA is the preferred method for bulk palette loads (destination `$2122`, mode `$00`).

### Palette by BG Mode

| Mode | BG Colors | Palette calc for BG1 | BG2 | BG3 | BG4 |
|------|-----------|----------------------|-----|-----|-----|
| 0    | 4 each    | `ppp*4 + 0`          | `ppp*4+32` | `ppp*4+64` | `ppp*4+96` |
| 1    | 16/16/4   | `ppp*16`             | `ppp*16` | `ppp*4` | - |
| 2    | 16/16     | `ppp*16`             | `ppp*16` | - | - |
| 3    | 256/16    | `0` (or Direct)      | `ppp*16` | - | - |
| 4    | 256/4     | `0` (or Direct)      | `ppp*4` | - | - |
| 5    | 16/4      | `ppp*16`             | `ppp*4` | - | - |
| 6    | 16        | `ppp*16`             | - | - | - |
| 7    | 256       | `0` (or Direct)      | - | - | - |

---

## 5. PPU - BG Modes & Tilemaps

### BG Mode Selection (`$2105` BGMODE, bits 2–0)

| Mode | BG1 Colors | BG2 Colors | BG3 Colors | BG4 Colors | Notes |
|------|-----------|-----------|-----------|-----------|-------|
| 0    | 4         | 4         | 4         | 4         | All 4 BGs active |
| 1    | 16        | 16        | 4         | -         | BG3 priority via `$2105` bit 3 |
| 2    | 16        | 16        | -         | -         | BG3 = offset-per-tile data |
| 3    | 256       | 16        | -         | -         | BG1 supports Direct Color |
| 4    | 256       | 4         | -         | -         | BG3 = offset-per-tile; BG1 Direct Color |
| 5    | 16        | 4         | -         | -         | Hi-res 512-wide; always 16px tiles |
| 6    | 16        | -         | -         | -         | Hi-res + offset-per-tile |
| 7    | 256       | -         | -         | -         | Matrix transform; 128×128 tilemap |
| 7EXTBG | 256    | 128       | -         | -         | Enable via `$2133` bit 6 |

`$2105` bit 3: Mode 1 BG3 priority - when set, BG3 renders above BG1/BG2 sprites.

### BGMODE Register (`$2105`)

```
Bit 7: BG4 tile size  (0=8×8, 1=16×16)
Bit 6: BG3 tile size
Bit 5: BG2 tile size
Bit 4: BG1 tile size
Bit 3: Mode 1 BG3 priority
Bits 2–0: BG Mode (0–7)
```

### Tilemap Address & Size (`$2107`–`$210A` = BG1SC–BG4SC)

```
Bits 7–2: Tilemap base address in VRAM → word address = value << 9
Bits 1–0: Tilemap size
  00 = 32×32 tiles (single tilemap A, 2 KB)
  01 = 64×32 tiles (tilemaps A, B side-by-side)
  10 = 32×64 tiles (tilemaps A, B stacked)
  11 = 64×64 tiles (tilemaps A, B, C, D in 2×2 grid)
```

Each tilemap = `$800` bytes = 1,024 entries × 2 bytes.

Tilemap word address calculation:
```
addr = (BGnSC.bits7-2 << 9)
     + ((Y & 0x1F) << 5)
     + (X & 0x1F)
     + (SY ? ((Y & 0x20) << (SX ? 6 : 5)) : 0)
     + (SX ? ((X & 0x20) << 5) : 0)
```
where SX/SY = 1 if tilemap is 64-wide / 64-tall.

### Tilemap Entry Format (2 bytes per tile, little-endian)

```
Bit 15    : v - Vertical flip
Bit 14    : h - Horizontal flip
Bit 13    : o - Tile priority (0 = low, 1 = high)
Bits 12–10: ppp - Sub-palette index (3 bits)
Bits 9–0  : cccccccccc - Tile number (10 bits, 0–1023)
```

Byte 0 (low): `cccccccc` (tile bits 7–0)
Byte 1 (high): `vhopppcc` (flip, priority, palette, tile bits 9–8)

### Character (Tile) Data Base Address (`$210B`–`$210C`)

```
$210B (BG12NBA):
  Bits 7–4: BG2 character base (× $2000 bytes = × 4096 words)
  Bits 3–0: BG1 character base

$210C (BG34NBA):
  Bits 7–4: BG4 character base
  Bits 3–0: BG3 character base
```

Character data byte address = `(Base << 13) + (TileNumber × bpp × 8)`

### Tile Bitplane Storage

8×8 pixels per tile. Each row = 1 byte per bitplane. Leftmost pixel = bit 7.

| BG Colors | Bitplanes | Bytes/tile | Storage layout |
|-----------|-----------|------------|----------------|
| 2 (4 colors) | 2 | 16 | BP0 row0, BP1 row0, BP0 row1, BP1 row1, … |
| 4 (16 colors) | 4 | 32 | 16 bytes BP0+BP1, then 16 bytes BP2+BP3 |
| 8 (256 colors) | 8 | 64 | Two 4-bitplane tiles packed consecutively |

For 4-color tiles: each row = 2 bytes (BP0 byte, BP1 byte).
For 16-color tiles: first 16 bytes = BP0+BP1; next 16 bytes = BP2+BP3.

Pixel color index = (BP3_bit << 3) | (BP2_bit << 2) | (BP1_bit << 1) | BP0_bit

### 16×16 Tile Mode

Enabled per BG via bits 7–4 of `$2105`. Tilemap entry `N` maps to 2×2 block:

```
Top-left:  tile N
Top-right: tile N + 1
Bot-left:  tile N + 16
Bot-right: tile N + 17
```

H/V flip applies to entire 16×16 block. No wrapping: tile `$2FF` fetches `$2FF`, `$300`, `$30F`, `$310`.

### BG Scrolling

Write-twice registers (`$210D`–`$2114`); all share a single "previous byte" latch:

| Register | Address | Direction |
|----------|---------|-----------|
| BG1HOFS  | `$210D` | W (×2)    |
| BG1VOFS  | `$210E` | W (×2)    |
| BG2HOFS  | `$210F` | W (×2)    |
| BG2VOFS  | `$2110` | W (×2)    |
| BG3HOFS  | `$2111` | W (×2)    |
| BG3VOFS  | `$2112` | W (×2)    |
| BG4HOFS  | `$2113` | W (×2)    |
| BG4VOFS  | `$2114` | W (×2)    |

Write sequence (horizontal offset):
```
NewValue = desired 10-bit offset
Write (NewValue & 0xFF) to BGnHOFS
Write ((NewValue >> 8) & 0x03) to BGnHOFS
```

Internal register update formulas:
```
BGnHOFS = (NewByte << 8) | (PrevByte & ~7) | ((CurrentValue >> 8) & 7)
BGnVOFS = (NewByte << 8) | PrevByte
```

**Scanline 0 correction**: Games often write VOFS = -1 (not 0) because SNES does not output scanline 0 to screen (though it renders it). Interlaced screens use VOFS = -2.

Tile lookup from screen pixel (X, Y):
```
Size = 8 or 16 (from $2105 bit for that BG)
TileX = (X + BGnHOFS) / Size
TileY = (Y + BGnVOFS) / Size
```

### Mode 7

- 128×128 tilemap, 1 byte per entry (character index, not a full tilemap word)
- Character data: 1 byte per pixel (packed, not bitplaned)
- Tilemap byte address: `(((Y & ~7) << 4) + (X >> 3)) << 1`
- Pixel byte address: `(((TileData << 6) + ((Y & 7) << 3) + (X & 7)) << 1) + 1`
- Matrix transform via `$211B`–`$2120` (M7A–M7D, M7X, M7Y)
- Screen flip: `$211A` (M7SEL) bits 0–1
- Extended play field: `$211A` bit 7; fill color select: `$211A` bit 6
- EXTBG (BG2 from Mode 7 data): `$2133` bit 6; BG2 pixel bit 7 = priority bit

### Mode 2 / Mode 4 / Mode 6 (Offset-Per-Tile)

BG3 encodes per-tile scroll offsets for BG1/BG2:
- Horizontal validity bit: `$2000` (BG1) or `$4000` (BG2)
- Mode 2/6: BG3 leftmost tile offset applied starting at tile 1; lower 3 bits of BGnHOFS always added; BGnVOFS fully replaced
- Mode 4: if `Val & $8000`, use as vertical offset (H=0); else use as horizontal

### Direct Color Mode

Enabled by `$2130` (CGWSEL) bit 0. Applies to 256-color BGs (Modes 3, 4, 7).
Character byte interpreted as `BBGGGRRR`:

```
Red   = RRRr0  (r = palette bit 0)
Green = GGGg0  (g = palette bit 1)
Blue  = BBb00  (b = palette bit 2)
```

Character data = 0 is still transparent. Recommended near-black: `$01`, `$08`, `$09`.

### VRAM Access Registers

| Register | Address | Direction | Description |
|----------|---------|-----------|-------------|
| VMAIN    | `$2115` | W         | Increment mode |
| VMADDL   | `$2116` | W         | VRAM word address (low) |
| VMADDH   | `$2117` | W         | VRAM word address (high) |
| VMDATAL  | `$2118` | W         | VRAM write data (low byte) |
| VMDATAH  | `$2119` | W         | VRAM write data (high byte) |
| VMDATALREAD | `$2139` | R      | VRAM read data (low, buffered) |
| VMDATAHREAD | `$213A` | R      | VRAM read data (high, buffered) |

**VMAIN (`$2115`) bit layout:**
```
Bit 7  : i - Increment on high byte write (0=incr on low, 1=incr on high)
Bits 3–2: mm - Address remapping
  00 = no remap
  01 = remap bits [7:0] → [12:5], bits [4:2] → [4:2], bits [1:0] → [14:13] (8×8 tile remap)
  10 = similar 64-wide remap
  11 = similar 128-wide remap
Bits 1–0: ii - Increment amount (00=+1, 01=+32, 10=+128, 11=+128)
```

VRAM read is buffered: read address is latched when VMADDL/H is written; actual data available after one dummy read or from the buffer register.

---

## 6. PPU - Sprites / OAM

### OAM Memory Layout

- **Total**: 544 bytes
- **Low table**: 512 bytes → 128 sprites × 4 bytes each
- **High table**: 32 bytes → 128 sprites × 2 bits each (4 sprites per byte)

### Low Table - 4 Bytes Per Sprite

| Byte offset | Field | Description |
|-------------|-------|-------------|
| `OBJ*4 + 0` | X (low) | X position bits 7–0 (signed) |
| `OBJ*4 + 1` | Y      | Y position (0–239; offscreen = 240+) |
| `OBJ*4 + 2` | Tile   | Character index (bits 7–0 of tile number) |
| `OBJ*4 + 3` | Attr   | See attribute byte below |

**Attribute byte (byte 3) bit layout:**
```
Bit 7: v - Vertical flip
Bit 6: h - Horizontal flip
Bits 5–4: oo - Priority (0=lowest, 3=highest relative to BGs)
Bits 3–1: ppp - Palette (selects CGRAM 128 + ppp*16 through +ppp*16+15)
Bit 0: N - Name table select
```

### High Table - 2 Bits Per Sprite

Each byte in the 32-byte high table covers 4 sprites (`OBJ/4`):

```
Bits 7–6: sprite (OBJ&3)==3 - [size_bit, x_high_bit]
Bits 5–4: sprite (OBJ&3)==2
Bits 3–2: sprite (OBJ&3)==1
Bits 1–0: sprite (OBJ&3)==0
  bit 1 of pair = size flag (0=small, 1=large)
  bit 0 of pair = X position bit 8 (high bit, sign extension)
```

### Sprite Sizes (`$2101` OBSEL)

```
Bits 7–5: sss - Size pair select
  000 : 8×8  / 16×16
  001 : 8×8  / 32×32
  010 : 8×8  / 64×64
  011 : 16×16 / 32×32
  100 : 16×16 / 64×64
  101 : 32×32 / 64×64
  110 : 16×32 / 32×64
  111 : 16×32 / 32×32

Bits 4–3: nn - Name table select offset (for N=1 tiles)
Bits 2–0: bbb - Name table base address (× $2000 in VRAM)
```

### Sprite VRAM Tile Address Calculation

```
word_addr = ((bbb << 13) + (cccccccc << 4) + (N ? ((nn+1) << 12) : 0)) & 0x7FFF
```

Where:
- `bbb` = base address bits from `$2101`
- `cccccccc` = tile index from OAM byte 2
- `N` = name table bit from OAM byte 3 bit 0
- `nn` = name table offset from `$2101` bits 4–3

### OAM Access Registers

| Register | Address | Direction | Description |
|----------|---------|-----------|-------------|
| OBSEL    | `$2101` | W         | Sprite size & tile base |
| OAMADDL  | `$2102` | W         | OAM word address (low) |
| OAMADDH  | `$2103` | W         | OAM address high bit + priority rotation |
| OAMDATA  | `$2104` | W         | OAM write port |
| OAMDATAREAD | `$2138` | R      | OAM read port |

`$2103` bit 7: Priority rotation - when set, sprite at FirstSprite index always appears on top.

### Sprite Display Limits (per scanline)

- Maximum **32 sprites** in range (`-size < X < 256`)
- Maximum **34 8×8 tiles** renderable
- Overflow flags in `$213E`: bit 6 = range overflow, bit 7 = tile overflow

### Sprite Palettes

8 palettes (palettes 8–15 in CGRAM, indices 128–255). Only palettes 12–15 (indices 4–7 within sprite range) participate in color math.

### DMA to OAM (Practical Workflow)

1. During game logic, build OAM buffer in WRAM (512 + 32 bytes extended)
2. Move off-screen sprites (Y=`$F0` = 240) for unused slots
3. Pack the high table: 4 sprites per byte (size + X-bit-8)
4. During V-Blank, DMA the buffer to OAM:
   - Set `$2102`=`$00`, `$2103`=`$00` (OAM address = 0)
   - DMA channel: source=buffer, dest=`$2104`, mode=`$00` (1-byte), count=544

---

## 7. PPU - Rendering, Color Math & Windows

### Layer Priority Order (highest to lowest)

For each pixel, the PPU walks this list and uses the first non-transparent, non-clipped pixel:

```
Sprites priority 3
BG1 priority 1 tile bit
Sprites priority 2
BG2 priority 1
BG1 priority 0
Sprites priority 1
BG2 priority 0
Sprites priority 0
Backdrop (CGRAM color 0)
```

(Exact order varies per mode; Mode 1 BG3 priority-boost moves BG3 above sprites.)

### Mosaic Filter (`$2106` MOSAIC)

```
Bits 7–4: xxxx - Pixel block size (0=1×1 off, 1=2×2, ... 15=16×16)
Bit 3: D - Apply to BG4
Bit 2: C - Apply to BG3
Bit 1: B - Apply to BG2
Bit 0: A - Apply to BG1
```

Sprites are never affected by mosaic. Block positioning aligns to screen left at the scanline where `$2106` was written.

### Color Math Operations

Two-screen architecture: **main screen** (displayed) + **sub screen** (source for math).

`$2131` (CGADSUB) designates which layers participate:
```
Bit 7: s - Add or subtract (0=add, 1=subtract)
Bit 6: h - Half math (divide result by 2)
Bit 5: b - Backdrop participates
Bit 4: o - Sprite layer (palettes 4–7 only)
Bit 3: 4 - BG4
Bit 2: 3 - BG3
Bit 1: 2 - BG2
Bit 0: 1 - BG1
```

`$2130` (CGWSEL) bits 1–0 select what the sub-screen contributes:
```
00: Subscreen pixel (or fixed color if transparent)
01: Fixed color only
10: (same as 00 in most contexts)
11: Fixed color only
```

**Operations (based on `$2130` bits 7–6 and `$2131` bits 7–6):**
- Add: `R, G, B` added separately; clipped to 31 max
- Add+Half: added then shifted right (6-bit result → 5-bit)
- Subtract: sub-screen subtracted from main; clipped to 0 min
- Subtract+Half: subtract then shift right

**Fixed color register `$2132` (COLDATA):**
```
Bit 7: b - Apply value to Blue component
Bit 6: g - Apply value to Green component
Bit 5: r - Apply value to Red component
Bits 4–0: ccccc - Intensity (0–31)
```

**Transparency edge cases:**
- If main-screen pixel is transparent: palette 0 used; math not halved even if half-flag set
- If sub-screen pixel is transparent: fixed color (`$2132`) used; never halved

### Window Clipping

Windows 1 and 2 each have left/right edge positions:
```
WH0 ($2126): Window 1 left edge
WH1 ($2127): Window 1 right edge
WH2 ($2128): Window 2 left edge
WH3 ($2129): Window 2 right edge
```

**Window mask settings `$2123`–`$2125`:**

| Register | Covers | Bit layout |
|----------|--------|-----------|
| `$2123` (W12SEL) | BG1, BG2 | `BG2W2EN BG2W2INV BG2W1EN BG2W1INV BG1W2EN BG1W2INV BG1W1EN BG1W1INV` |
| `$2124` (W34SEL) | BG3, BG4 | Same pattern for BG3, BG4 |
| `$2125` (WOBJSEL) | OBJ, Color | Same pattern for sprites and color window |

**Window mask logic `$212A`–`$212B`:**
- `$212A` (WBGLOG): logic op for each BG pair (2 bits per BG: 00=OR, 01=AND, 10=XOR, 11=XNOR)
- `$212B` (WOBJLOG): same for OBJ and color window

**Color window modes (`$2130` bits 7–6 and 5–4):**
- 00 = Never apply
- 01 = Apply outside window
- 10 = Apply inside window
- 11 = Always apply

### Main/Sub Screen Layer Enable

| Register | Address | Description |
|----------|---------|-------------|
| TM       | `$212C` | Main screen layer enable (`---o4321`) |
| TS       | `$212D` | Sub screen layer enable |
| TMW      | `$212E` | Main screen window mask enable |
| TSW      | `$212F` | Sub screen window mask enable |

### Screen Display (`$2100` INIDISP)

```
Bit 7: x - Force blank (1=screen black, VRAM/OAM accessible)
Bits 3–0: bbbb - Master brightness (0=black, 15=full)
```

### Display Initialization / Setini (`$2133` SETINI)

```
Bit 7: s - External sync (0=normal)
Bit 6: e - Mode 7 EXTBG enable
Bit 3: p - Pseudo-hires (512-wide output in Mode 0–6)
Bit 2: o - Overscan (0=224 lines, 1=239 lines)
Bit 1: I - Interlace sprites (1=use 8×16 sprite tiles in interlace)
Bit 0: i - Interlace screen (1=interlace; 448 or 478 lines)
```

---

## 8. DMA & HDMA

### DMA Channel Registers (`$43x0`–`$43xA`, x = channel 0–7)

| Address | Name  | R/W | Description |
|---------|-------|-----|-------------|
| `$43x0` | DMAPx | R/W | DMA/HDMA control |
| `$43x1` | BBADx | R/W | Bus B (PPU) destination register (`$21xx`) |
| `$43x2` | A1TxL | R/W | Source address low byte |
| `$43x3` | A1TxH | R/W | Source address high byte |
| `$43x4` | A1Bx  | R/W | Source address bank |
| `$43x5` | DASxL | R/W | DMA count low / HDMA indirect addr low |
| `$43x6` | DASxH | R/W | DMA count high / HDMA indirect addr high |
| `$43x7` | DASBx | R/W | HDMA indirect address bank |
| `$43x8` | A2AxL | R/W | HDMA table current address low |
| `$43x9` | A2AxH | R/W | HDMA table current address high |
| `$43xA` | NLTRx | R/W | HDMA line counter (repeat + count) |

### DMAPx Control Register (`$43x0`) Bit Layout

```
Bit 7: d - Transfer direction (0=CPU→PPU, 1=PPU→CPU)
Bit 6: a - HDMA addressing mode (0=direct, 1=indirect)
Bit 5: (unused)
Bit 4: i - Address increment/decrement (0=auto, 1=fixed)
Bit 3: f - Address direction (0=increment, 1=decrement) [only if bit 4=0]
Bits 2–0: ttt - Transfer mode
  000: 1 byte → 1 register
  001: 2 bytes → 2 consecutive registers (write once each)
  010: 2 bytes → 1 register (write twice)
  011: 4 bytes → 2 registers (write twice each)
  100: 4 bytes → 4 consecutive registers
  101: 4 bytes → 2 registers (alternating)
```

### DMA Enable Register (`$420B` MDMAEN)

Write a bitmask (bit 0 = channel 0, bit 7 = channel 7) to trigger DMA. Lower-numbered channels execute first. CPU halts for duration of transfer.

### DMA Timing

- 8 master cycles per byte transferred
- 8 master cycles overhead per channel
- 8–24 master cycles total overhead for entire DMA initiation
- Alignment to 8-cycle boundary required
- Independent of FastROM setting

### DMA Code Example (tile upload to VRAM)

```assembly
LDA #$80           ; Increment on high-byte write
STA $2115          ; VMAIN

LDX #VRAM_ADDR     ; Target VRAM word address
STX $2116          ; VMADDL/H

LDA #$00           ; Transfer mode: 1 reg, auto-increment, CPU→PPU
STA $4300          ; DMAPx (channel 0)

LDA #$18           ; Destination: $2118 (VMDATAL)
STA $4301          ; BBADx

LDX #TILE_DATA_ADDR ; Source address (lo/hi)
STX $4302
LDA #TILE_DATA_BANK
STA $4304

LDX #TILE_DATA_SIZE
STX $4305          ; DASxL/H (byte count)

LDA #$01           ; Enable channel 0
STA $420B          ; MDMAEN
```

### HDMA Enable Register (`$420C` HDMAEN)

Same bitmask as `$420B` but for HDMA channels. Transfers execute once per H-Blank during active display (scanlines 0–224 or 0–239). HDMA stops at V-Blank.

### HDMA Table Format

Tables are arrays of cells terminated by `$00`:

**Each cell:**
```
Byte 0: line count byte
  Bits 6–0: N - Number of lines (1–128; $00 = end of table)
  Bit 7:    r - Repeat flag
    r=0: Write data once, skip N-1 scanlines (N total)
    r=1: Write data every scanline for N scanlines
    $80 special: write every line for 128 lines
Bytes 1+: Data bytes (1, 2, or 4 bytes depending on transfer mode)
```

**Direct mode example (mode 000, 1 byte each):**
```assembly
.db $20, $FF       ; Write $FF once, skip 31 lines (32 total)
.db $80, $AA       ; Write $AA every line for 128 lines
.db $00            ; End of table
```

**Indirect mode:** cell data = 16-bit offset into a secondary data table; bank specified in `$43x7`.

### HDMA Timing per Scanline

- ~18 master cycles overhead for all active channels
- 8 master cycles per channel (direct mode)
- 24 master cycles per channel (indirect mode)
- 16 master cycles for indirect address load
- 8 master cycles per byte transferred
- Maximum: 466 master cycles/scanline (all 8 indirect channels, 4-byte transfer)

### HDMA Constraints

- HDMA does not occur during V-Blank
- HDMA takes priority over DMA when both would occur simultaneously
- Cannot access: `$4300–$437F`, `$420B`, `$420C` via HDMA
- WRAM (`$2180–$2183`) cannot be on both busses simultaneously

---

## 9. SPC700 / APU

### SPC700 CPU Register Set

| Register | Width | Description |
|----------|-------|-------------|
| A        | 8-bit | Accumulator |
| X        | 8-bit | Index register |
| Y        | 8-bit | Index register |
| SP       | 8-bit | Stack pointer (stack at `$0100–$01FF`) |
| PC       | 16-bit | Program counter |
| PSW      | 8-bit | Processor status word |

### PSW Flag Register

| Bit | Flag | Description |
|-----|------|-------------|
| 7   | N    | Negative (MSB of result) |
| 6   | V    | Overflow |
| 5   | P    | Direct page select (0=`$00xx`, 1=`$01xx`) |
| 4   | B    | Break |
| 3   | H    | Half carry (BCD) |
| 2   | I    | Interrupt enable (unused on SPC700) |
| 1   | Z    | Zero |
| 0   | C    | Carry |

### SPC700 Memory Map

| Range          | Purpose |
|----------------|---------|
| `$0000–$00EF`  | Zero page 0 (direct page when P=0) |
| `$00F0–$00FF`  | Hardware registers |
| `$0100–$01FF`  | Zero page 1 / stack space |
| `$0200–$FFBF`  | General RAM (62.75 KB) |
| `$FFC0–$FFFF`  | IPL ROM (64 bytes, read-only) or RAM (controlled by undocumented X bit in `$F1`) |

Total: 64 KB addressable.

### SPC700 Hardware Registers (`$F0`–`$FF`)

| Address | Register | R/W | Description |
|---------|----------|-----|-------------|
| `$F0`   | -        | R/W | Undocumented |
| `$F1`   | Control  | W   | Timer enable & port clear |
| `$F2`   | DSPADDR  | R/W | DSP register pointer |
| `$F3`   | DSPDATA  | R/W | DSP register read/write |
| `$F4`   | Port 0   | R/W | SNES↔SPC communication port 0 |
| `$F5`   | Port 1   | R/W | Port 1 |
| `$F6`   | Port 2   | R/W | Port 2 |
| `$F7`   | Port 3   | R/W | Port 3 |
| `$F8`   | -        | R/W | Regular RAM |
| `$F9`   | -        | R/W | Regular RAM |
| `$FA`   | Timer 0  | W   | Timer 0 period (8 kHz base) |
| `$FB`   | Timer 1  | W   | Timer 1 period (8 kHz base) |
| `$FC`   | Timer 2  | W   | Timer 2 period (64 kHz base) |
| `$FD`   | Counter 0| R   | Timer 0 count-up (4-bit, resets on read) |
| `$FE`   | Counter 1| R   | Timer 1 count-up |
| `$FF`   | Counter 2| R   | Timer 2 count-up |

### Control Register (`$F1`) Bit Layout

```
Bit 7: (reserved)
Bit 6: (reserved)
Bit 5: PC32 - Clear ports 2 & 3 (write 1 to reset)
Bit 4: PC10 - Clear ports 0 & 1
Bit 3: (reserved)
Bit 2: ST2  - Enable Timer 2
Bit 1: ST1  - Enable Timer 1
Bit 0: ST0  - Enable Timer 0
```

### Timers

| Timer | Clock    | Counter width | Use |
|-------|----------|---------------|-----|
| 0     | 8 kHz    | 8-bit period, 4-bit count | Tempo |
| 1     | 8 kHz    | 8-bit period, 4-bit count | Tempo |
| 2     | 64 kHz   | 8-bit period, 4-bit count | SFX timing |

Writing to `$FA`–`$FC` sets period. Reading `$FD`–`$FF` returns count (auto-reset to 0 on read).

### APU ↔ SNES Communication Ports

SNES CPU accesses ports at `$2140`–`$2143`; SPC700 sees them at `$F4`–`$F7`.

| SNES addr | SPC addr | Direction |
|-----------|----------|-----------|
| `$2140`   | `$F4`    | Bidirectional |
| `$2141`   | `$F5`    | Bidirectional |
| `$2142`   | `$F6`    | Bidirectional |
| `$2143`   | `$F7`    | Bidirectional |

### APU Transfer Protocol (SNES→SPC)

1. **Wait for ready**: poll until `$2140`=`$AA` and `$2141`=`$BB`
2. **Initialize**: write non-zero value to `$2141`, load destination address into `$2142`–`$2143`, write `$CC` to `$2140`
3. **Wait for ACK**: poll `$2140` until it equals `$CC`
4. **Transfer loop** (one byte per iteration):
   - Write data byte to `$2141`
   - Write counter (increment from previous) to `$2140`
   - Poll `$2140` until it matches written counter value
5. **Subsequent transfers**: increment counter by 2 (skip 0); write non-zero address to `$2141`, new address to `$2142`–`$2143`, write counter to `$2140`, wait for ACK
6. **Execute**: write `$00` to `$2141`, write execution address to `$2142`–`$2143`, increment counter by 2, write to `$2140`

### DSP Registers

Accessed via `$F2` (address) and `$F3` (data). 128 registers total.

#### Per-Voice Registers (voices 0–7; register address = `voice*16 + offset`)

| Offset | Name    | Description |
|--------|---------|-------------|
| `x0`   | VOL(L)  | Left channel volume (8-bit signed) |
| `x1`   | VOL(R)  | Right channel volume (8-bit signed) |
| `x2`   | P(L)    | Pitch low 8 bits |
| `x3`   | P(H)    | Pitch high 6 bits (14-bit total pitch) |
| `x4`   | SRCN    | Source (sample) number (0–255) |
| `x5`   | ADSR(1) | Bits 7=ADSR enable, 6–4=decay, 3–0=attack |
| `x6`   | ADSR(2) | Bits 7–5=sustain level, 4–0=sustain/release rate |
| `x7`   | GAIN    | Envelope gain when ADSR disabled |
| `x8`   | ENVX    | Current envelope value (7-bit, read-only) |
| `x9`   | OUTX    | Waveform × envelope output (8-bit signed, read-only) |

#### Global DSP Registers

| Address | Name    | Description |
|---------|---------|-------------|
| `$0C`   | MVOL(L) | Main volume left (8-bit signed) |
| `$1C`   | MVOL(R) | Main volume right |
| `$2C`   | EVOL(L) | Echo volume left |
| `$3C`   | EVOL(R) | Echo volume right |
| `$4C`   | KON     | Key On bitmask (bit per voice; write 1 to trigger) |
| `$5C`   | KOF     | Key Off bitmask (fade-out) |
| `$6C`   | FLG     | Flags: bit 7=reset, bit 6=mute, bit 5=echo off, bits 4–0=noise clock |
| `$7C`   | ENDX    | Sample end flags (read-only; bit set when BRR end block reached) |
| `$0D`   | EFB     | Echo feedback coefficient (8-bit signed) |
| `$2D`   | PMON    | Pitch modulation enable bitmask (voice 0 always 0) |
| `$3D`   | NON     | Noise enable bitmask |
| `$4D`   | EON     | Echo enable bitmask |
| `$5D`   | DIR     | Sample directory base address (× `$100` = byte address) |
| `$6D`   | ESA     | Echo buffer start address (× `$100`) |
| `$7D`   | EDL     | Echo delay (bits 3–0; delay = value × 16 ms) |
| `$xF`   | COEF    | FIR filter coefficient for voice x (8 taps: `$0F`, `$1F`, … `$7F`) |

### Pitch Formula

```
Hz_to_pitch : P = Hz / 7.8125
Pitch_to_Hz : Hz = P × 7.8125

Pitch values:
  $0400 = 2 octaves below original
  $0800 = 1 octave below
  $1000 = original pitch (4096)
  $2000 = 1 octave above
  $3FFF = ~2 octaves above (max)
```

### Sample Directory Format

At address `DIR × $100`, an array of 4-byte entries (one per SRCN value):

```
Bytes 0–1: Start address of BRR sample (little-endian 16-bit)
Bytes 2–3: Loop point address of BRR sample (little-endian 16-bit)
```

---

## 10. BRR Audio Sample Format

### Overview

BRR (Bit Rate Reduction): SNES's lossy audio compression. Ratio 32:9 - for every 32 bytes of 16-bit PCM, 9 bytes of BRR.

Each BRR block = **9 bytes**: 1 header byte + 8 data bytes (16 nibbles = 16 samples).

### Header Byte

```
Bits 7–4: RANGE  - Left-shift amount for decoded nibble (0–11 valid; 12–15 invalid)
Bits 3–2: FILTER - Filter type (0–3)
Bit 1:    LOOP   - Set on last block if sample loops
Bit 0:    END    - Set on last block of sample
```

### Data Bytes

Each byte contains two 4-bit signed nibbles (high nibble first):
```
Byte n contains: high nibble = sample 2n, low nibble = sample 2n+1
```

### Decoding Algorithm

For each nibble `s` (4-bit value):

```
1. Sign-extend: if s >= 8, s = s | 0xFFF0  (16-bit signed)
2. Shift left:  shifted = s << RANGE
3. Clip to 15-bit signed range
4. Apply filter (using prev1 and prev2, the previous two output samples):
```

**Filter 0** (no filter): `output = shifted`

**Filter 1**: `output = shifted + (prev1 * 15/16)`  
Coefficients: A=15/16, B=0

**Filter 2**: `output = shifted + (prev1 * 61/32) - (prev2 * 15/16)`  
Coefficients: A≈1.90625, B≈-0.9375

**Filter 3**: `output = shifted + (prev1 * 115/64) - (prev2 * 13/16)`  
Coefficients: A≈1.796875, B≈-0.8125

Final sample clipped to 16-bit signed range (`-32768` to `+32767`).

### Loop Configuration

- LOOP bit must be set in the END block only
- Loop point address must be 9-byte BRR block-aligned
- Loop/end addresses stored in sample directory at `DIR × $100`

---

## 11. N-SPC Music Format

Used by Super Mario World, F-Zero, Super Metroid, Kirby Super Star, and 150+ other titles. Also known as Kankichi-kun or SQ & DBOOT.

### Data Hierarchy

```
Song List  → array of pointers to Block Lists
Block List → array of (block pointer, repeat count, loop point)
Sequences  → per-voice VCMD (Voice Command) streams
```

### Super Mario World Version (Old, 24 Commands, `$DA`–`$F2`)

This is a reduced command set. Commands are shifted relative to the standard N-SPC.

### Standard N-SPC Voice Commands (27 Commands, `$E0`–`$FA`)

| VCMD     | Hex      | Arguments     | Description |
|----------|----------|---------------|-------------|
| End/Ret  | `$00`    | -             | End sequence or return from subroutine |
| Note length | `$01`–`$7F` | [len] optional [vel] | Note length (48 = quarter note) |
| Notes    | `$80`–`$C7` | -          | Pitch (chromatic, 6 octaves) |
| Tie      | `$C8`    | -             | Extend previous note |
| Rest     | `$C9`    | -             | Silence |
| Perc note | `$CA`–`$DF` | -         | Percussion note |
| Instrument | `$E0`  | [xx]          | Set instrument (SRCN index) |
| Pan      | `$E1`    | [xx]          | Pan (low 5 bits = 0–20; bits 6–7 = phase reverse) |
| Pan Fade | `$E2`    | [xx yy]       | Fade to pan |
| Vibrato On | `$E3` | [xx yy zz]   | Delay/rate/depth |
| Vibrato Off | `$E4` | -            | Disable vibrato |
| Main Vol | `$E5`   | [xx]          | Master volume |
| Main Vol Fade | `$E6` | [xx yy]   | Fade master volume |
| Tempo    | `$E7`    | [xx]          | Playback speed |
| Tempo Fade | `$E8` | [xx yy]       | Fade tempo |
| Global Transpose | `$E9` | [xx]  | Semitone transpose (signed) |
| Voice Transpose | `$EA` | [xx]   | Per-voice transpose |
| Tremolo On | `$EB` | [xx yy zz]   | Delay/rate/depth |
| Tremolo Off | `$EC` | -           | Disable tremolo |
| Volume   | `$ED`    | [xx]          | Voice volume |
| Vol Fade | `$EE`    | [xx yy]       | Fade volume |
| Subroutine | `$EF` | [xx yy zz]   | Call block `$yyxx` for `zz+1` times |
| Vibrato Fade | `$F0` | [xx]       | Fade vibrato depth |
| Pitch Env To | `$F1` | [xx yy zz] | Pitch slide up: delay/length/semitones |
| Pitch Env From | `$F2` | [xx yy zz] | Pitch slide down |
| Pitch Env Off | `$F3` | -        | Disable pitch envelope |
| Tuning   | `$F4`    | [xx]          | Fine tuning |
| Echo VBits/Vol | `$F5` | [xx yy zz] | Echo voice bits, L vol, R vol |
| Echo Off | `$F6`   | -             | Disable echo |
| Echo Params | `$F7` | [xx yy zz] | Delay (EDL), feedback (EFB), FIR index |
| Echo Vol Fade | `$F8` | [xx yy zz] | Fade echo volume |
| Pitch Slide | `$F9` | [xx yy zz]  | Slide within current note: delay/length/target |
| Perc Base | `$FA`  | [xx]          | Set percussion patch base |

### Note Pitch Mapping (`$80`–`$C7`)

```
$80–$8B : Octave 1: C, C#, D, D#, E, F, F#, G, G#, A, A#, B
$8C–$97 : Octave 2
$98–$A3 : Octave 3
$A4–$AF : Octave 4
$B0–$BB : Octave 5
$BC–$C7 : Octave 6
```

### Tempo Scaling

Tempo byte → BPM ≈ `(byte × 60) / 24` (approximately; varies per game's implementation).

### Echo Parameter DSP Mapping

`$F7` arguments map directly to DSP registers:
- `xx` → EDL (echo delay, `$7D`): delay = `xx × 16 ms`
- `yy` → EFB (echo feedback, `$0D`): 8-bit signed
- `zz` → FIR filter index (0–3 in most games)

---

## 12. SPC File Format & ID666 Tags

### File Structure

| Offset     | Size   | Content |
|------------|--------|---------|
| `$00000`   | 33     | Header string: `"SNES-SPC700 Sound File Data v0.30"` |
| `$00021`   | 2      | `$1A $1A` (fixed) |
| `$00023`   | 1      | Tag presence: `$1A`=ID666 present, `$1B`=no tag |
| `$00024`   | 1      | Version minor |
| `$00025`   | 2      | SPC700 PC register |
| `$00027`   | 1      | SPC700 A register |
| `$00028`   | 1      | SPC700 X register |
| `$00029`   | 1      | SPC700 Y register |
| `$0002A`   | 1      | SPC700 PSW register |
| `$0002B`   | 1      | SPC700 SP register |
| `$0002C`   | 2      | Reserved (`$00 $00`) |
| `$0002E`–`$000D7` | varies | ID666 text or binary tag |
| `$00100`   | 65536  | 64 KB SPC700 RAM snapshot |
| `$10100`   | 128    | DSP registers (128 bytes) |
| `$10180`   | 64     | Unused |
| `$101C0`   | 64     | Extra RAM (IPL ROM region) |
| `$10200`+  | var    | Extended ID666 (`xid6` RIFF chunk) |

### ID666 Text Format (`$0002E`–`$000D8`)

| Offset   | Size | Field |
|----------|------|-------|
| `$0002E` | 32   | Song title |
| `$0004E` | 32   | Game title |
| `$0006E` | 16   | Dumper name |
| `$0007E` | 32   | Comments |
| `$0009E` | 11   | Dump date (MM/DD/YYYY) |
| `$000A9` | 3    | Play length (seconds, ASCII) |
| `$000AC` | 5    | Fade length (milliseconds, ASCII) |
| `$000B1` | 32   | Artist name |
| `$000D1` | 1    | Channel disable flags |
| `$000D2` | 1    | Emulator ID (`$31`=ZSNES, `$32`=Snes9x, …) |
| `$000D3` | 45   | Reserved (`$00`) |

### ID666 Binary Format (`$0002E`–`$000D8`)

| Offset   | Size | Field |
|----------|------|-------|
| `$0002E`–`$000B0` | same | Same as text up to date |
| `$0009E` | 4    | Date: YYYYMMDD (binary) |
| `$000A9` | 2    | Play length (binary, seconds) |
| `$000AB` | 1    | `$00` |
| `$000AC` | 3    | Fade length (binary, milliseconds) |
| `$000AF` | 1    | `$00` |
| `$000B0` | 32   | Artist |
| `$000D0` | 1    | Channel disable flags |
| `$000D1` | 1    | Emulator ID (`$01`=ZSNES, `$02`=Snes9x, …) |
| `$000D2` | 46   | Reserved |

### Extended ID666 (`xid6` chunk at `$10200`)

RIFF-style chunk. Each sub-chunk:
```
Byte 0: Item ID
Byte 1: Type (0=header, 1=string, 4=32-bit int)
Bytes 2–3: Data (if type=0) or length (if type≠0)
```

Common item IDs:
- `$01` Song name (string)
- `$02` Game name (string)
- `$05` Dump date (YYYYMMDD, int)
- `$30` Intro length (1/64000 sec ticks, int)
- `$31` Loop length
- `$32` End length
- `$33` Fade length
- `$34` Muted voices bitmask
- `$35` Loop count
- `$36` Mixing level (amplification)

---

## 13. 65816 CPU

### Register Set

| Register | Width | Description |
|----------|-------|-------------|
| A        | 8/16-bit | Accumulator (M flag selects width) |
| X, Y     | 8/16-bit | Index registers (X flag selects width) |
| S        | 16-bit | Stack pointer |
| D        | 16-bit | Direct page base address |
| DBR      | 8-bit  | Data bank register (default data bank) |
| PB       | 8-bit  | Program bank (instruction fetch bank) |
| PC       | 16-bit | Program counter |
| P        | 8-bit  | Processor status (flags) |

### Processor Status Register (P) Flags

| Bit | Flag | Description |
|-----|------|-------------|
| 7   | N    | Negative |
| 6   | V    | Overflow |
| 5   | M    | Accumulator size (0=16-bit, 1=8-bit; native mode only) |
| 4   | X    | Index register size (0=16-bit, 1=8-bit) |
| 3   | D    | Decimal mode |
| 2   | I    | IRQ disable |
| 1   | Z    | Zero |
| 0   | C    | Carry |

In emulation mode, bits 4–5 are B (Break) and fixed 1 respectively.

### Operating Modes

**Native mode** (emulation bit cleared via `CLC; XCE`):
- Full 16-bit registers selectable via M and X flags
- 24-bit addressing
- NMI vector: `$00FFEA`, IRQ: `$00FFEE`

**Emulation mode** (emulation bit set via `SEC; XCE`):
- 8-bit registers (6502-compatible)
- 16-bit addressing only
- RESET vector: `$00FFFC`

### SEP / REP Instructions

```
SEP #xx  - Set processor flags (bits set in xx become 1 in P)
REP #xx  - Reset processor flags (bits set in xx become 0 in P)

SEP #$20 - Switch A to 8-bit
REP #$20 - Switch A to 16-bit
SEP #$10 - Switch X,Y to 8-bit
REP #$10 - Switch X,Y to 16-bit
REP #$30 - Switch all to 16-bit
```

### Key Addressing Modes

| Mode | Example | Description |
|------|---------|-------------|
| Immediate | `LDA #$12` | Constant |
| Absolute | `LDA $1234` | 16-bit in DBR |
| Absolute Long | `LDA $123456` | 24-bit full address |
| Direct Page | `LDA $12` | D + 8-bit offset |
| Indexed (X/Y) | `LDA $1234,X` | Absolute + index |
| Indirect | `LDA ($12)` | Direct page indirect |
| Stack Relative | `LDA $02,S` | S + offset |
| PC Relative | `BRA $xx` / `BRL $xxxx` | Branch offset |

### Long Jump / Call

- `JML $xxxxxx` - Update PB and jump (24-bit)
- `JSL $xxxxxx` - Long subroutine call (pushes 3-byte return address)
- `RTL` - Return from long call

---

## 14. Controller Input

### Auto-Joypad Read

Enabled by `$4200` (NMITIMEN) bit 0. Reads occur automatically at start of V-Blank. Results in:

| Register | Address | Contents |
|----------|---------|----------|
| JOY1L    | `$4218` | Controller port 1, buttons low byte |
| JOY1H    | `$4219` | Controller port 1, buttons high byte |
| JOY2L    | `$421A` | Controller port 2, buttons low byte |
| JOY2H    | `$421B` | Controller port 2, buttons high byte |
| JOY3L    | `$421C` | Port 3 low |
| JOY3H    | `$421D` | Port 3 high |
| JOY4L    | `$421E` | Port 4 low |
| JOY4H    | `$421F` | Port 4 high |

### Button Bit Layout (16-bit, read from JOY1L+JOY1H)

```
Bit 15: B
Bit 14: Y
Bit 13: Select
Bit 12: Start
Bit 11: Up
Bit 10: Down
Bit 9:  Left
Bit 8:  Right
Bit 7:  A
Bit 6:  X
Bit 5:  L (Left shoulder)
Bit 4:  R (Right shoulder)
Bits 3–0: 0000 (always 0 for standard controller)
```

### Serial (Manual) Read

```
Write $01 to $4016  - latch controllers
Write $00 to $4016  - release latch
Then read $4016 (port 1) and $4017 (port 2) 16 times each.
Each read shifts out one bit (MSB first): B, Y, Sel, Start, Up, Down, Left, Right, A, X, L, R, 0, 0, 0, 0
```

`$4212` (HVBJOY) bit 0: auto-joypad busy flag (1 = reading in progress).

### IOBit / Multitap

`$4201` (WRIO) bit 7: latch PPU H/V counters  
`$4201` bit 6: Multitap select for port 2

---

## 15. Complete Register Reference

### Bus B PPU/APU Registers (`$2100`–`$2183`)

| Address | Name       | R/W | Bit pattern        | Description |
|---------|------------|-----|--------------------|-------------|
| `$2100` | INIDISP    | W   | `x---bbbb`         | Force blank (x), brightness 0–15 (bbbb) |
| `$2101` | OBSEL      | W   | `sssnnbbb`         | Sprite size (sss), name table offset (nn), base address (bbb) |
| `$2102` | OAMADDL    | W   | `aaaaaaaa`         | OAM word address low |
| `$2103` | OAMADDH    | W   | `p------b`         | Priority rotation (p), OAM address high bit (b) |
| `$2104` | OAMDATA    | W   | `dddddddd`         | OAM write data |
| `$2105` | BGMODE     | W   | `DCBAemmm`         | Tile sizes DCBA (per BG), mode 1 priority (e), mode (mmm) |
| `$2106` | MOSAIC     | W   | `xxxxDCBA`         | Mosaic pixel size (xxxx), enable per BG (DCBA) |
| `$2107` | BG1SC      | W   | `aaaaaayx`         | BG1 tilemap address (aaaaaa<<9), size (yx) |
| `$2108` | BG2SC      | W   | `aaaaaayx`         | BG2 tilemap address |
| `$2109` | BG3SC      | W   | `aaaaaayx`         | BG3 tilemap address |
| `$210A` | BG4SC      | W   | `aaaaaayx`         | BG4 tilemap address |
| `$210B` | BG12NBA    | W   | `bbbbaaaa`         | BG2 chr base (bbbb), BG1 chr base (aaaa) |
| `$210C` | BG34NBA    | W   | `bbbbaaaa`         | BG4 chr base (bbbb), BG3 chr base (aaaa) |
| `$210D` | BG1HOFS    | W×2 | 10-bit            | BG1 horizontal scroll |
| `$210E` | BG1VOFS    | W×2 | 10-bit            | BG1 vertical scroll |
| `$210F` | BG2HOFS    | W×2 | 10-bit            | BG2 horizontal scroll |
| `$2110` | BG2VOFS    | W×2 | 10-bit            | BG2 vertical scroll |
| `$2111` | BG3HOFS    | W×2 | 10-bit            | BG3 horizontal scroll |
| `$2112` | BG3VOFS    | W×2 | 10-bit            | BG3 vertical scroll |
| `$2113` | BG4HOFS    | W×2 | 10-bit            | BG4 horizontal scroll |
| `$2114` | BG4VOFS    | W×2 | 10-bit            | BG4 vertical scroll |
| `$2115` | VMAIN      | W   | `i---mmii`         | VRAM increment on high (i), remap (mm), amount (ii) |
| `$2116` | VMADDL     | W   | `aaaaaaaa`         | VRAM address low byte |
| `$2117` | VMADDH     | W   | `aaaaaaaa`         | VRAM address high byte |
| `$2118` | VMDATAL    | W   | `dddddddd`         | VRAM data write low |
| `$2119` | VMDATAH    | W   | `dddddddd`         | VRAM data write high |
| `$211A` | M7SEL      | W   | `rc----yx`         | Mode 7: oversized field (r), fill (c), flip Y (y), flip X (x) |
| `$211B` | M7A        | W×2 | 16-bit signed     | Mode 7 matrix A |
| `$211C` | M7B        | W×2 | 16-bit signed     | Mode 7 matrix B |
| `$211D` | M7C        | W×2 | 16-bit signed     | Mode 7 matrix C |
| `$211E` | M7D        | W×2 | 16-bit signed     | Mode 7 matrix D |
| `$211F` | M7X        | W×2 | 13-bit signed     | Mode 7 center X |
| `$2120` | M7Y        | W×2 | 13-bit signed     | Mode 7 center Y |
| `$2121` | CGADD      | W   | `cccccccc`         | CGRAM color index (0–255) |
| `$2122` | CGDATA     | W×2 | `0bbbbbgggggrrrrr` | CGRAM write (low then high byte) |
| `$2123` | W12SEL     | W   | `ABCDabcd`         | Window enable/invert for BG1 (abcd) and BG2 (ABCD) |
| `$2124` | W34SEL     | W   | `ABCDabcd`         | Window enable/invert for BG3, BG4 |
| `$2125` | WOBJSEL    | W   | `ABCDabcd`         | Window enable/invert for OBJ, color window |
| `$2126` | WH0        | W   | `xxxxxxxx`         | Window 1 left edge |
| `$2127` | WH1        | W   | `xxxxxxxx`         | Window 1 right edge |
| `$2128` | WH2        | W   | `xxxxxxxx`         | Window 2 left edge |
| `$2129` | WH3        | W   | `xxxxxxxx`         | Window 2 right edge |
| `$212A` | WBGLOG     | W   | `44332211`         | Window mask logic per BG (2 bits each: OR/AND/XOR/XNOR) |
| `$212B` | WOBJLOG    | W   | `----ccoo`         | Window mask logic for color (cc), OBJ (oo) |
| `$212C` | TM         | W   | `---o4321`         | Main screen: enable OBJ (o), BG4–BG1 (4321) |
| `$212D` | TS         | W   | `---o4321`         | Sub screen layer enable |
| `$212E` | TMW        | W   | `---o4321`         | Main screen window mask enable |
| `$212F` | TSW        | W   | `---o4321`         | Sub screen window mask enable |
| `$2130` | CGWSEL     | W   | `ccmm--sd`         | Color window (cc=clip, mm=math prevent), sub-screen (s), direct color (d) |
| `$2131` | CGADSUB    | W   | `shbo4321`         | Math: subtract (s), half (h), backdrop (b), OBJ (o), BG4–1 |
| `$2132` | COLDATA    | W   | `bgrccccc`         | Fixed color: apply to B/G/R (bgr), intensity (ccccc) |
| `$2133` | SETINI     | W   | `se--poIi`         | Ext sync (s), EXTBG (e), pseudo-hires (p), overscan (o), interlace sprites (I), interlace (i) |
| `$2134` | MPYL       | R   | `xxxxxxxx`         | Signed multiply result low byte |
| `$2135` | MPYM       | R   | `xxxxxxxx`         | Multiply result middle byte |
| `$2136` | MPYH       | R   | `xxxxxxxx`         | Multiply result high byte |
| `$2137` | SLHV       | R   | `--------`         | Software latch H/V counters (read to latch) |
| `$2138` | OAMDATAREAD| R   | `xxxxxxxx`         | OAM read |
| `$2139` | VMDATALREAD| R   | `xxxxxxxx`         | VRAM read low (buffered) |
| `$213A` | VMDATAHREAD| R   | `xxxxxxxx`         | VRAM read high (buffered) |
| `$213B` | CGDATAREAD | R×2 | `0bbbbbgggggrrrrr` | CGRAM read |
| `$213C` | OPHCT      | R×2 | `-------x xxxxxxxx` | H counter (9-bit, read low then high) |
| `$213D` | OPVCT      | R×2 | `-------x xxxxxxxx` | V counter (9-bit) |
| `$213E` | STAT77     | R   | `trm-vvvv`         | Time over (t), range over (r), master/slave (m), PPU1 version (vvvv) |
| `$213F` | STAT78     | R   | `fl-pvvvv`         | Interlace field (f), latch flag (l), NTSC/PAL (p), PPU2 version (vvvv) |
| `$2140` | APUIO0     | R/W | `xxxxxxxx`         | APU port 0 |
| `$2141` | APUIO1     | R/W | `xxxxxxxx`         | APU port 1 |
| `$2142` | APUIO2     | R/W | `xxxxxxxx`         | APU port 2 |
| `$2143` | APUIO3     | R/W | `xxxxxxxx`         | APU port 3 |
| `$2180` | WMDATA     | R/W | `xxxxxxxx`         | WRAM sequential access data |
| `$2181` | WMADDL     | W   | `aaaaaaaa`         | WRAM address bits 7–0 |
| `$2182` | WMADDM     | W   | `aaaaaaaa`         | WRAM address bits 15–8 |
| `$2183` | WMADDH     | W   | `-------a`         | WRAM address bit 16 |

### CPU Internal Registers (`$4200`–`$421F`)

| Address | Name     | R/W | Bit pattern       | Description |
|---------|----------|-----|-------------------|-------------|
| `$4200` | NMITIMEN | W   | `n-yx---a`        | NMI enable (n), H/V IRQ mode (yx), auto-joypad (a) |
| `$4201` | WRIO     | W   | `abxxxxxx`        | I/O: latch (a), pad 2 (b) |
| `$4202` | WRMPYA   | W   | `mmmmmmmm`        | Multiplicand A (unsigned) |
| `$4203` | WRMPYB   | W   | `mmmmmmmm`        | Multiplier B (triggers multiply) |
| `$4204` | WRDIVL   | W   | `dddddddd`        | Dividend low |
| `$4205` | WRDIVH   | W   | `dddddddd`        | Dividend high |
| `$4206` | WRDIVB   | W   | `bbbbbbbb`        | Divisor (triggers divide) |
| `$4207` | HTIMEL   | W   | `hhhhhhhh`        | H-counter IRQ trigger low |
| `$4208` | HTIMEH   | W   | `-------h`        | H-counter IRQ trigger bit 8 |
| `$4209` | VTIMEL   | W   | `vvvvvvvv`        | V-counter IRQ trigger low |
| `$420A` | VTIMEH   | W   | `-------v`        | V-counter IRQ trigger bit 8 |
| `$420B` | MDMAEN   | W   | `76543210`        | DMA channel enables |
| `$420C` | HDMAEN   | W   | `76543210`        | HDMA channel enables |
| `$420D` | MEMSEL   | W   | `-------f`        | FastROM enable (f) |
| `$4210` | RDNMI    | R   | `n---vvvv`        | NMI flag (n, cleared on read), CPU version |
| `$4211` | TIMEUP   | R   | `i-------`        | IRQ flag (i, cleared on read) |
| `$4212` | HVBJOY   | R   | `vh-----a`        | V-blank (v), H-blank (h), auto-joypad busy (a) |
| `$4213` | RDIO     | R   | `abxxxxxx`        | I/O port read |
| `$4214` | RDDIVL   | R   | `qqqqqqqq`        | Division quotient low |
| `$4215` | RDDIVH   | R   | `qqqqqqqq`        | Division quotient high |
| `$4216` | RDMPYL   | R   | `xxxxxxxx`        | Multiply product low / division remainder low |
| `$4217` | RDMPYH   | R   | `xxxxxxxx`        | Multiply product high / remainder high |
| `$4218` | JOY1L    | R   | `byetUDLR`        | Controller 1 low byte (B,Y,Sel,Start,U,D,L,R) |
| `$4219` | JOY1H    | R   | `axlr0000`        | Controller 1 high byte (A,X,L,R,0,0,0,0) |
| `$421A` | JOY2L    | R   | `byetUDLR`        | Controller 2 low |
| `$421B` | JOY2H    | R   | `axlr0000`        | Controller 2 high |
| `$421C` | JOY3L    | R   | `xxxxxxxx`        | Controller 3 low |
| `$421D` | JOY3H    | R   | `xxxxxxxx`        | Controller 3 high |
| `$421E` | JOY4L    | R   | `xxxxxxxx`        | Controller 4 low |
| `$421F` | JOY4H    | R   | `xxxxxxxx`        | Controller 4 high |

### Joypad Serial Registers (`$4016`–`$4017`)

| Address | R/W | Description |
|---------|-----|-------------|
| `$4016` | W   | Bit 0: latch controllers |
| `$4016` | R   | Bit 0: Data1 (port 1), bit 1: Data2 |
| `$4017` | R   | Bit 0: Data1 (port 2), bits 4–2: `111` (tied high) |

### DMA/HDMA Channel Registers (`$43x0`–`$43xA`, x=0–7)

| Address | Name   | R/W | Description |
|---------|--------|-----|-------------|
| `$43x0` | DMAPx  | R/W | Control (see Section 8) |
| `$43x1` | BBADx  | R/W | PPU bus B destination (`$21` + this value) |
| `$43x2` | A1TxL  | R/W | Source low byte |
| `$43x3` | A1TxH  | R/W | Source high byte |
| `$43x4` | A1Bx   | R/W | Source bank |
| `$43x5` | DASxL  | R/W | Byte count low / HDMA indirect addr low |
| `$43x6` | DASxH  | R/W | Byte count high / HDMA indirect addr high |
| `$43x7` | DASBx  | R/W | HDMA indirect bank |
| `$43x8` | A2AxL  | R/W | HDMA table current addr low |
| `$43x9` | A2AxH  | R/W | HDMA table current addr high |
| `$43xA` | NLTRx  | R/W | Bit 7=repeat, bits 6–0=line counter |

---

## 16. SA-1 Coprocessor Registers

The SA-1 is a second 65C816 CPU on some cartridges (e.g. Super Mario RPG, Kirby Super Star, Donkey Kong Country 2/3). Registers split across SNES-side writes (`$2200`–`$225B`) and SA-1-side reads (`$2300`–`$230E`).

### SNES-Side Write Registers (`$2200`–`$225B`)

| Address | Description |
|---------|-------------|
| `$2200` | SA-1 CPU Control: `IRrNmmmm` (IRQ, Ready, reset, NMI flags, SNES message nibble) |
| `$2201` | SNES CPU INT Enable: IRQ and char conversion DMA interrupt |
| `$2202` | SNES CPU INT Clear |
| `$2203`–`$2204` | SA-1 Reset Vector (16-bit in bank `$00`) |
| `$2205`–`$2206` | SA-1 NMI Vector |
| `$2207`–`$2208` | SA-1 IRQ Vector |
| `$2209` | SNES CPU Control: `IS-Nmmmm` |
| `$220A` | SA-1 INT Enable: `ITDN----` (SNES/timer/DMA/NMI) |
| `$220B` | SA-1 INT Clear |
| `$220C`–`$220D` | SNES NMI Vector |
| `$220E`–`$220F` | SNES IRQ Vector |
| `$2210` | H/V Timer Control: `T-----VH` |
| `$2211` | Timer Restart (write to reset) |
| `$2212`–`$2213` | H-Count (0–340 or 0–511 in linear mode) |
| `$2214`–`$2215` | V-Count (0–261 or 0–311) |
| `$2220`–`$2223` | MMC Banks C–F: `B----AAA` |
| `$2224` | SNES BW-RAM Mapping: `---BBBBB` |
| `$2225` | SA-1 BW-RAM Mapping: `SBBBBBBB` |
| `$2226` | SNES BW-RAM Write Enable: `P-------` |
| `$2227` | SA-1 BW-RAM Write Enable |
| `$2228` | BW-RAM Protected Area: `----AAAA` |
| `$2229` | SNES I-RAM Protection (8 × 256-byte blocks) |
| `$222A` | SA-1 I-RAM Protection |
| `$2230` | DMA Control: `CPMT-DSS` |
| `$2231` | DMA Parameters: `E--SSSCC` (end, char size, color mode) |
| `$2232`–`$2234` | DMA Source (24-bit) |
| `$2235`–`$2237` | DMA Destination (24-bit; `$2236`=I-RAM, `$2237`=BW-RAM) |
| `$2238`–`$2239` | DMA Terminal Counter (16-bit byte count) |
| `$223F` | BW-RAM Bitmap Format: `C-------` |
| `$2240`–`$224F` | Bitmap Register Files |
| `$2250` | Arithmetic Control: `------OO` (00=multiply, 01=divide, 10=sum) |
| `$2251`–`$2252` | Multiplicand / Dividend (16-bit signed) |
| `$2253`–`$2254` | Multiplier (signed) / Divisor (unsigned) |
| `$2258` | Variable-Length Bit Processing: `H---VVVV` |
| `$2259`–`$225B` | Variable-Length ROM Address (execute on `$225B` write) |

### SA-1-Side Read Registers (`$2300`–`$230E`)

| Address | Description |
|---------|-------------|
| `$2300` | SNES Flag Read: `IVDNmmmm` |
| `$2301` | SA-1 Flag Read: `ITDNmmmm` |
| `$2302`–`$2303` | H-Count read |
| `$2304`–`$2305` | V-Count read |
| `$2306`–`$230A` | Arithmetic Results (40-bit) |
| `$230B` | Overflow Flag: `O-------` |
| `$230C`–`$230D` | Variable-Length Data Port (16-bit) |
| `$230E` | SA-1 Version Code |

---

## 17. BS-X Satellaview Header

Header at `$7FBx` (LoROM) or `$FFBx` (HiROM).

| Offset       | Size | Field |
|--------------|------|-------|
| `xFB0–xFB1`  | 2    | Maker/Licensee Code |
| `xFB2–xFB5`  | 4    | Program Type (see below) |
| `xFB6–xFBF`  | 10   | Reserved |
| `xFC0–xFCF`  | 16   | Title (Shift-JIS) |
| `xFD0–xFD3`  | 4    | Block Allocation Flags (1 bit per Mbit block) |
| `xFD4–xFD5`  | 2    | Limited Starts counter |
| `xFD6`       | 1    | Date - Month |
| `xFD7`       | 1    | Date - Day |
| `xFD8`       | 1    | ROM Speed & Map Mode (upper=speed, lower=LoROM/HiROM) |
| `xFD9`       | 1    | File/Execution Type |
| `xFDA`       | 1    | Fixed value `$33` |
| `xFDB`       | 1    | Version: `1 + ord(value)/10` |
| `xFDC–xFDD`  | 2    | Inverse Checksum |
| `xFDE–xFDF`  | 2    | Checksum |
| `xFE0–xFFF`  | 32   | Exception Vectors (same as SNES ROM header) |

**Program Type values:** `$00000000`=65C816, `$00000100`=BS-X Bytecode, `$00000200`=SA-1

**Block Allocation Flags:** bit 7 = last page (`$CE0000`–`$CFFFFF`), bit 0 = first (`$C00000`–`$C1FFFF`)

**Limited Starts (boot count limit):** `$FC`=5, `$BC`=4, `$9C`=3, `$8C`=2, `$84`=1, `$80`=0, `$00`=unlimited

**File/Execution Type (`xFD9`) bits:**
- Bits 3–0: 0 (unused)
- Bit 4: Soundlink mute (1=muted)
- Bits 6–5: Execution area (0=FLASH, 1=FLASH→PSRAM)
- Bit 7: Skip St.GIGA intro

Checksum: sum of all blocks indicated by allocation flags; complement + checksum = `$FFFF`.

---

## 18. Open Bus Behavior

### CPU Open Bus (MDR)

The S-CPU contains a Memory Data Register (MDR) that holds the value from the last data bus operation. Reading unmapped addresses returns the MDR value (no device drives the bus).

- CPU IO cycles (`$4016`, `$4017`, `$4000`–`$41FF`) do **not** update the MDR
- JSL and JSR(a,X) have specific sequencing to avoid open-bus reads mid-instruction

### PPU Open Bus

PPU1 and PPU2 each have their own MDR, updated only during reads of that PPU's registers.

- Undefined bits in read registers return the PPU's MDR value for those bits
- **PPU1 MDR** updated by reads from: `$2134`–`$2136`, `$2138`–`$213A`
- **PPU2 MDR** updated by reads from: `$213B`–`$213D`

---

## 19. Expansion Chips Summary

| Chip | Games | Key Features |
|------|-------|--------------|
| SA-1 | Super Mario RPG, DKC2, Kirby Super Star | Second 65C816 @ 10.74 MHz; bitmap arithmetic; variable-length bit processing |
| SuperFX / GSU | Star Fox, Yoshi's Island | 3D rendering RISC processor; own SRAM |
| DSP-1 | Super Mario Kart, Pilotwings | Matrix math coprocessor |
| DSP-2 | Dungeon Master | Pixel masking |
| DSP-3 | SD Gundam GX | - |
| DSP-4 | Top Gear 3000 | Road generation |
| Cx4 (HG51B169) | Mega Man X2/X3 | Wireframe graphics |
| S-DD1 | Street Fighter Alpha 2, Star Ocean | On-the-fly graphics decompression |
| SPC7110 | Far East of Eden Zero, etc. | Graphics/data decompression + RTC |
| S-RTC | Dai Kaiju Monogatari 2 | Real-time clock |
| OBC-1 | Metal Combat | Object control |
| ST010 | F1 ROC II | AI coprocessor |
| MX15001TFC | Nintendo Power | Flash cartridge |
| Super Game Boy | - | GB-Z80 CPU for Game Boy compatibility |

---

*Document compiled from https://wiki.superfamicom.org/ - pages: memory-mapping, palettes, sprites, backgrounds, rendering-the-screen, windows, transparency, dma-and-hdma, spc700-reference, bit-rate-reduction-(brr), transferring-data-from-rom-to-the-snes-apu, nintendo-music-format-(n-spc), spc-and-rsn-file-format, id666-format, registers, sa-1-registers, bs-x-satellaview-header, expansion-chips, timing, open-bus, pointers, grog's-guide-to-dma-and-hdma-on-the-snes, 65816-reference, controllers, writing-the-header, schematics-ports-and-pinouts. Compiled 2026-04-13.*
