# Super Mario World — ROM Format Reference

Sources:
- SMWDisX disassembly (github.com/IsoFrieze/SMWDisX)
- smwspeedruns.com/Level_Data_Format
- smwspeedruns.com/Overworld_Data_Format
- datacrystal.tcrf.net/wiki/Super_Mario_World_(SNES)/GFX_Files
- smw-editor.github.io/docs/smw-rom
- sneslab.net/wiki/LC_LZ2
- superfamicom.org

---

## ROM Identity

| Field | Value |
|---|---|
| Internal name | `SUPER MARIOWORLD     ` (21 bytes, space-padded) |
| ROM size | 512 KiB |
| Mapper | LoROM (slow, $20) |
| Cartridge type | Normal + Battery ($02) |
| SRAM size | 2 KiB |
| Country | USA ($01) |
| Version | 1.0 |
| Checksum | $A0DA |
| Complement | $5F25 |
| CRC32 (USA) | B19ED489 |

### SNES Internal Header (LoROM, PC address £007FC0)

| PC Offset | SNES Addr | Field | Length |
|---|---|---|---|
| £007FC0 | $00FFC0 | Game title | 21 bytes |
| £007FD5 | $00FFD5 | Map mode | 1 byte |
| £007FD6 | $00FFD6 | Cartridge type | 1 byte |
| £007FD7 | $00FFD7 | ROM size | 1 byte |
| £007FD8 | $00FFD8 | SRAM size | 1 byte |
| £007FD9 | $00FFD9 | Region/destination | 1 byte |
| £007FDA | $00FFDA | Developer ID | 1 byte |
| £007FDB | $00FFDB | Version number | 1 byte |
| £007FDC | $00FFDC | Checksum complement | 2 bytes |
| £007FDE | $00FFDE | Checksum | 2 bytes |

**PC ↔ SNES address conversion (LoROM):**
```
PC → SNES:  SNES = ((PC << 1) & 0x7F0000) | (PC & 0x7FFF) | 0x808000
SNES → PC:  PC   = ((SNES & 0x7F0000) >> 1) | (SNES & 0x7FFF)
```
Note: addresses with (SNES & 0xFFFF) < 0x8000 are not ROM space (WRAM/I/O/SRAM).

---

## ROM Bank Layout

| Banks (SNES) | PC Range | Contents |
|---|---|---|
| $00–$07 | £000000–£03FFFF | Main game code |
| $08–$0B | £040000–£05FFFF | All 52 GFX files (LC_LZ2 compressed) |
| $0C | £060000–£067FFF | Additional code/data |
| $0D | £068000–£06FFFF | Map16 tile data (vanilla) |
| $0E | £070000–£077FFF | Additional code/data |
| $0F | £078000–£07FFFF | ExGFX pointer tables, Lunar Magic data |

---

## GFX Files

### Overview

- **Count:** 52 files, named GFX00–GFX33 (hex) = decimal 0–51
- **Storage:** LC_LZ2 compressed, stored in banks $08–$0B (PC £040000–£05FFFF)
- **Storage order in ROM:** GFX32 first, then GFX33, then GFX00, GFX01, … GFX31 (NOT in numeric order)
- **Decompressed size:** 4096 bytes (0x1000) per standard file = 128 tiles × 32 bytes (4bpp)
- **AllGFX.bin offset:** GFX file N starts at byte offset N × 0x1000 in Lunar Magic's AllGFX.bin export

### Pointer Tables (ROM addresses of compressed GFX data)

| Table | SNES Address | Contents |
|---|---|---|
| Low byte | $00B992 | lo byte of SNES pointer, one byte per file |
| High byte | $00B9C4 | hi byte of SNES pointer, one byte per file |
| Bank byte | $00B9F6 | bank byte of SNES pointer, one byte per file |

To get the SNES address of compressed GFX file N:
```
lo   = ROM[$00B992 + N]
hi   = ROM[$00B9C4 + N]
bank = ROM[$00B9F6 + N]
snesAddr = (bank << 16) | (hi << 8) | lo
```

**Pointer table range:** The pointer tables at $B992/$B9C4/$B9F6 have exactly 50 entries each (spacing $32 = 50 bytes between lo/hi/bank tables). Our code sets `GFX_FILE_COUNT = 50` (indices 0–49, LM names GFX00–GFX31 hex). The last two files in the 52-file LM count (LM GFX32 = decimal 50, LM GFX33 = decimal 51) may use separate pointer storage or may not exist in vanilla — **needs verification**.

**Naming convention:** LM uses hex file names. Decimal index 32 = LM "GFX20", decimal 33 = LM "GFX21", etc. Our code uses decimal indices throughout.

**Static files always loaded regardless of tileset:**
- Decimal index 32 (LM GFX20): Mario/Luigi sprite sheet (3bpp) → VRAM `an2` slot, chars $200–$27F
- Decimal index 33 (LM GFX21): Animated tile graphics (larger file, ~12 KB) → VRAM `bg1` slot, chars $280–$2FF ⚠ slot assignment unverified

### Tile Format by File

| Format | Bytes/tile | Colors | Used by |
|---|---|---|---|
| 4bpp | 32 | 16 | Standard GFX files (most terrain, sprites) |
| 3bpp | 24 | 8 | GFX32 (Mario) — SNES hardware doesn't support natively; game inserts 4th bitplane at runtime |
| 2bpp | 16 | 4 | Layer 3 GFX files |
| Mode 7 / 8bpp | 64 | 256 | GFX27 (Iggy/Larry platform, Reznor BG) |

### 4bpp Tile Format (32 bytes per tile)

```
[r0,bp1] [r0,bp2] [r1,bp1] [r1,bp2] [r2,bp1] [r2,bp2] [r3,bp1] [r3,bp2]
[r4,bp1] [r4,bp2] [r5,bp1] [r5,bp2] [r6,bp1] [r6,bp2] [r7,bp1] [r7,bp2]
[r0,bp3] [r0,bp4] [r1,bp3] [r1,bp4] [r2,bp3] [r2,bp4] [r3,bp3] [r3,bp4]
[r4,bp3] [r4,bp4] [r5,bp3] [r5,bp4] [r6,bp3] [r6,bp4] [r7,bp3] [r7,bp4]
```
Bitplanes 1+2 interleaved (row by row), then bitplanes 3+4 interleaved.

### 3bpp Tile Format (24 bytes per tile — GFX32/Mario only)

```
[r0,bp1] [r0,bp2] [r1,bp1] [r1,bp2] ... [r7,bp1] [r7,bp2]   (16 bytes: bp1+bp2 interleaved)
[r0,bp3] [r1,bp3] [r2,bp3] [r3,bp3] [r4,bp3] [r5,bp3] [r6,bp3] [r7,bp3]   (8 bytes: bp3 flat)
```

### 2bpp Tile Format (16 bytes per tile — Layer 3)

```
[r0,bp1] [r0,bp2] [r1,bp1] [r1,bp2] ... [r7,bp1] [r7,bp2]   (bp1+bp2 interleaved)
```

### GFX File Contents

| File | Hex | Contents |
|---|---|---|
| GFX32 | 20 | Mario (3bpp sprite) |
| GFX33 | 21 | Animated tile graphics (12 KB, larger than standard) |
| GFX00 | 00 | Nintendo Presents, Powerups |
| GFX01 | 01 | Koopa, Goomba |
| GFX02 | 02 | Spiny, Lakitu |
| GFX03 | 03 | Thwomp, Magikoopa |
| GFX04 | 04 | Buzzy Beetle, Blargg |
| GFX05 | 05 | Chainsaw, Diggin Chuck |
| GFX06 | 06 | Urchin, Dolphin |
| GFX07 | 07 | Ghost House Tiles |
| GFX08 | 08 | Yoshi's House Tiles |
| GFX09 | 09 | Sumo Bro, Pokey |
| GFX0A | 0A | Wendy, Lemmy |
| GFX0B | 0B | Roy, Morton, Ludwig |
| GFX0C | 0C | Cave, Ghost House Background |
| GFX0D | 0D | Peach, Water Background |
| GFX0E | 0E | Ninji, Disco Ball |
| GFX0F | 0F | Mario Start, Credits |
| GFX10 | 10 | Overworld Mario |
| GFX11 | 11 | Big Boo, Eerie |
| GFX12 | 12 | Dry Bones, Grinder |
| GFX13 | 13 | Hammer Bro, Chargin Chuck |
| GFX14 | 14 | Pipe Tiles, Overworld Animation (bottom half overwritten at runtime by GFX33) |
| GFX15 | 15 | Grassy Tiles (FG1 for Yoshi's Island levels) |
| GFX16 | 16 | Rope Tiles |
| GFX17 | 17 | Bush, Diagonal Pipe Tiles |
| GFX18 | 18 | Castle Tiles |
| GFX19 | 19 | Forest, Hills Background |
| GFX1A | 1A | Cave Tiles |
| GFX1B | 1B | Blue Pillars, Castle Background |
| GFX1C | 1C | Overworld Tiles |
| GFX1D | 1D | Overworld Tiles |
| GFX1E | 1E | Overworld Level Icons |
| GFX1F | 1F | Cloud, Forest Tiles |
| GFX20 | 20 | Rex, Mega Mole |
| GFX21 | 21 | Bowser |
| GFX22 | 22 | Peach, Ludwig Background |
| GFX23 | 23 | Bg Dino Torch, Dino Rhino |
| GFX24 | 24 | Mechakoopa, Bowser Fire |
| GFX25 | 25 | Iggy, Larry, Reznor |
| GFX26 | 26 | Credits Yoshi |
| GFX27 | 27 | Iggy Platform, Reznor Background (Mode 7 — 8bpp, not standard 4bpp) |
| GFX28 | 28 | HUD Letters |
| GFX29 | 29 | Title Screen |
| GFX2A | 2A | Message Box Letters |
| GFX2B | 2B | Castle Crusher |
| GFX2C | 2C | Castle Cutscene Tiles |
| GFX2D | 2D | Castle Cutscene Objects |
| GFX2E | 2E | Credits Thank You |
| GFX2F | 2F | Credits Letters |
| GFX30 | 30 | Mario & Luigi The End |
| GFX31 | 31 | Special Beaten Enemies |

### Decompression

- **Algorithm:** LC_LZ2 (Nintendo's proprietary compression)
- **Routine in ROM:** $00:B8DE
- **Decompression buffer:** SNES RAM $7E:AD00
- **Terminator byte:** $FF

#### LC_LZ2 Command Format

Header byte: `CCCLLLLL` (C = 3-bit command, L = 5-bit length)

| CCC | Name | Description |
|---|---|---|
| 000 | Direct Copy | Read (L+1) literal bytes from input |
| 001 | Byte Fill | Repeat the following 1 byte (L+1) times |
| 010 | Word Fill | Alternate 2 bytes for (L+1) total bytes written |
| 011 | Increasing Fill | Write byte, incrementing it each time, (L+1) times |
| 100 | Back Reference | Copy (L+1) bytes from output buffer at address (2 bytes, big-endian follow) |
| 101 | (unused) | — |
| 110 | (unused) | — |
| 111 | Long Length | 2-byte header: `111CCCLL LLLLLLLL` — 10-bit length, real command in CCC bits |

Terminator: `$FF`

---

## Level Data Format

### Pointer Tables

Each table is 512 entries × 3 bytes = 1536 bytes. Each entry is a 24-bit SNES address stored little-endian (lo, hi, bank).

| SNES Address | Contents |
|---|---|
| $05E000 | Layer 1 object data pointers |
| $05E600 | Layer 2 data pointers |
| $05EC00 | Sprite data pointers |

**Layer 2 bank byte:** If the bank byte of the L2 pointer entry is `$FF`, the pointed-to data is a **background tilemap** compressed in LC_RLE1. Otherwise it is object data in the same format as Layer 1 (but without a primary header — objects start at byte 0).

### Primary Level Header (5 bytes, start of Layer 1 object data)

**Confirmed via Mesen2 write watchpoints on live SMW:**

```
Byte 0 (h[0]): BBBLLLLL   BBB = BG palette row variant [7:5]   LLLLL = level length in screens – 1 [4:0]
Byte 1 (h[1]): CCCOOOOO   CCC = back area color index [7:5]    OOOOO = level mode [4:0]
Byte 2 (h[2]): 3MMMSSSS   3 = Layer 3 priority flag [7]        MMM = music [6:4]   SSSS = (unused/mode bits) [3:0]
Byte 3 (h[3]): TTPPSSSS   TT = timer [7:6]   PP = sprite palette [5:4]   SSSS = sprite set [3:0]
Byte 4 (h[4]): IIVVZZZZ   II = item memory [7:6]   VV = vertical scroll [5:4]   ZZZZ = bgTypeId [3:0]
```

Field notes:
- **BG palette** (h[0] bits 7–5): selects CGRAM rows 0–1 variant; 3 bits → values 0–7
- **Back area color** (h[1] bits 7–5): indexes into the 8 back area colors at $B0A0; 3 bits → values 0–7
- **Sprite set** (h[3] bits 3–0): 4-bit index into sprite GFX assignment table at $A8C3; also used to look up tileset ID via $05D760
- **Sprite palette** (h[3] bits 5–4): 2-bit index into sprite palette sets at $B348
- **bgTypeId** (h[4] bits 3–0): background type/tileset selector — NOT the GFX tileset index. The GFX tileset index is obtained via `ROM[$05D760 + spriteSet]`.
- **FG palette** (derived): `spriteSet & 0x07` — lower 3 bits of sprite set field select the FG tile palette variant

Note: the speedruns.com/Level_Data_Format wiki lists slightly different byte 3/4 field assignments (PPP=3-bit sprite palette, FFF=3-bit FG palette). Our layout is confirmed by Mesen2 watchpoints on $7E:192B (spriteSet) and visual palette comparison on multiple levels.

### GFX Assignment Tables

| SNES Address | Contents |
|---|---|
| $00A8C3 | Sprite GFX: 4 bytes per sprite set → SP1, SP2, SP3, SP4 GFX file indices (reverse load order: byte[3]=SP1 … byte[0]=SP4) |
| $00A92B | FG/BG GFX: 4 bytes per tileset → FG1, FG2, FG3, AnimFG file indices (same reverse order) |
| $05D760 | Tileset ID lookup: `ROM[$05D760 + spriteSet]` → tilesetId for indexing $00A92B |

### Object Data Format (L1 and L2)

**Standard 2-byte object** (when first byte's high nibble ≤ 0x0C):
```
Byte 0: YYYYXXXX   YYYY = y tile position (rows 0–12)   XXXX = x position within screen
Byte 1: TTTTPPPP   TTTT = object type (high nibble)     PPPP = param / size (low nibble)
```

**Extended 3-byte object** (when first byte's high nibble = 0x0D–0x0F):
```
Byte 0: 1110XXXX   high nibble flags extended; low = x
Byte 1: 00YYYYYY   y position (6-bit)
Byte 2: EEEEEEEE   extended object type (added to 0x100)
```

**Screen boundary:** `$FF $FF` advances the current screen counter by 1.
**Terminator:** lone `$FF` ends the object stream.

Layer 2 object data begins at byte 0 of the pointed-to block (no 5-byte primary header).

### Layer 2 Background Tilemap (when L2 bank byte = $FF)

Compressed with **LC_RLE1**:
- Header byte `FLLLLLLL`: F=0 → copy next (L+1) literal bytes; F=1 → repeat next byte (L+1) times
- Terminator: `$FF $FF`

Decompressed data is a flat array of 16-bit Map16 tile IDs covering the full level grid (screens × 16 columns × 27 rows), stored row-major. **Not yet implemented** — currently we only handle object-based L2.

---

## Map16 Data

- **Location:** Bank $0D (PC £068000)
- **Format:** 8 bytes per 16×16 tile — four 8×8 sub-tiles, each 2 bytes
- **Sub-tile word format:** `YXPCCCTT TTTTTTTT` — Y/X flip, Priority, Palette (CCC), Tile number (TT TTTTTTTT)
- **VRAM pages:** Page 0 starts at SNES $0D8000, Page 1 at $0DC000 (⚠ unverified)

---

## Palette Format

All palette data is SNES BGR555:
```
Bit layout: 0BBBBBGG GGGRRRRR
Bytes:       lo=GGGRRRRR  hi=0BBBBBGG
```
Conversion to 8-bit channel: `c8 = (c5 << 3) | (c5 >> 2)` — gives exact 0→0, 31→255.

### Palette ROM Locations (verified)

| SNES Address | Contents |
|---|---|
| $00B0A0 | Back area color (2 bytes, BGR555) |
| $00B0B0 | BG palette row 0, variant 0 (24 bytes: 12 colors × 2 bytes) |
| $00B0C8 | BG palette row 1, variant 0 |
| $00B190 | FG palette row 2, variant 0 |
| $00B1A8 | FG palette row 3, variant 0 |
| $00B2C8 | Mario palette (20 bytes: 10 colors) |
| $00B2DC | Luigi palette (20 bytes) |
| $00B2F0 | Fire Mario palette |
| $00B304 | Fire Luigi palette |
| $00B318 | Sprite palette E (24 bytes) |
| $00B330 | Sprite palette F (24 bytes) |
| $00B348 | Sprite palette sets 0–7: 8 sets × 5 rows × 24 bytes = 960 bytes |

⚠ **Partially known:** $00B0E0–$00B18F contains additional BG palette variants; structure not fully verified.

---

## Mesen prgRom Address Convention

**Critical:** Mesen's `emu.memType.prgRom` uses **full 24-bit SNES bus addresses**, NOT ROM file offsets.

- `emu.read(0x088000, prgRom)` reads SNES $088000 = start of GFX data
- `emu.read(0x0689F7, prgRom)` reads SNES $0689F7 = the L1 header for level index in earlier tests
- Addresses where `(addr & 0xFFFF) < 0x8000` are **not ROM space** in LoROM and will return zero or open-bus values — do NOT use computed file offsets as prgRom addresses

**Correct LoROM address formula for Mesen scripts:**
```lua
-- Given PC/file offset, compute valid SNES bus address:
-- snes = ((pc << 1) & 0x7F0000) | (pc & 0x7FFF) | 0x808000
-- Or use bank-aware:
-- bank = pc >> 15  (each bank = 0x8000 bytes)
-- addr = 0x8000 + (pc & 0x7FFF)
-- snes = (bank << 16) | addr
```

---

## What Is Not Yet Known / Needs Verification

1. **GFX pointer table range:** Confirmed for files 00–1F (32 files). Files 20–33 hex (decimal 32–51) — unknown whether same tables extend or separate tables exist.
2. **Exact decompressed GFX tile count:** AllGFX.bin uses 0x1000 bytes per file (= 128 tiles × 32 bytes at 4bpp), but storage format vs. VRAM slot size relationship needs verification.
3. **Layer 2 pointer table address:** $05E600 documented but not Mesen-confirmed for this project.
4. **Map16 VRAM addresses:** $0D8000 and $0DC000 listed but not verified against live VRAM.
5. **Palette variant structure at $00B0E0–$00B18F:** Partially understood.
