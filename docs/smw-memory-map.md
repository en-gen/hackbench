# SMW ROM Memory Map

Verified addresses for Super Mario World (SNES, USA release).
All addresses are SNES LoROM 24-bit unless noted otherwise.
All multi-byte values are little-endian.

Sources: SMW Central memory map, smwspeedruns.com/Level_Data_Format,
sneslab.net/wiki/SMW_level_data_format, datacrystal.tcrf.net

---

## Addressing

LoROM formula: `fileOffset = bank * 0x8000 + (addr & 0x7FFF)`
- Banks $00–$3F, addr $8000–$FFFF → ROM
- Banks $70–$7D → SRAM (not in file)
- Banks $7E–$7F → WRAM (not in file)
- Banks $80–$FF → mirrors of $00–$7F
- Copier header: 512 bytes prepended to some ROM dumps (`fileSize % 1024 === 512`)

---

## ROM Header

| Address   | Size | Description |
|-----------|------|-------------|
| `$00FFC0` | 21 B | Internal ROM name (ASCII, space-padded) — `"SUPER MARIOWORLD"` |
| `$00FFD5` | 1 B  | ROM speed/map mode (`$20` = LoROM, `$30` = LoROM fast) |
| `$00FFD7` | 1 B  | ROM size byte (`n` → `1 << n` KB) |
| `$00FFD8` | 1 B  | SRAM size byte |

---

## Level Data

### Layer-1 Object Pointer Tables

512 levels, indexed $000–$1FF. Each pointer is reconstructed from three
separate byte tables (lo, hi, bank):

| Address    | Size     | Description |
|------------|----------|-------------|
| `$05E000`  | 512 B    | L1 object pointer — low byte  |
| `$05E200`  | 512 B    | L1 object pointer — high byte |
| `$05E400`  | 512 B    | L1 object pointer — bank byte |

Reconstruction: `ptr = (bank << 16) | (hi << 8) | lo`

### Layer-1 Sprite Pointer Tables

| Address    | Size     | Description |
|------------|----------|-------------|
| `$05EC00`  | 512 B    | Sprite pointer — low byte  |
| `$05EE00`  | 512 B    | Sprite pointer — high byte |
| `$05F000`  | 512 B    | Sprite pointer — bank byte |

### Level Primary Header (5 bytes at L1 pointer)

Objects start at byte offset 5 (after the header).

| Byte | Bits  | Field              | Notes |
|------|-------|--------------------|-------|
| 0    | 7–5   | BG palette row     | 3-bit |
| 0    | 4–0   | Level length       | screens - 1 |
| 1    | 7–5   | BG color           | 3-bit |
| 1    | 4–0   | Level mode         | determines layer layout |
| 2    | 7     | Layer 3 priority   | |
| 2    | 6–4   | Music index        | 3-bit |
| 2    | 3–0   | Sprite set         | 4-bit, indexes GFX sprite table |
| 3    | 7–6   | Time limit         | 00=unlimited |
| 3    | 5–3   | Sprite palette     | 3-bit |
| 3    | 2–0   | FG palette set     | 3-bit |
| 4    | 7–6   | Item memory        | |
| 4    | 5–4   | Vertical scroll    | |
| 4    | 3–0   | **Tileset ID**     | 4-bit, indexes GFX FG/BG table |

### Level Object Format

**Standard (2 bytes)** — when byte0 high nibble ≤ $A:
```
byte0: YYYY XXXX   (Y = tile row 0–$A, X = local column in screen)
byte1: TTTT PPPP   (T = object type nibble, P = param/size nibble)
```
Absolute X = `screen * 16 + (byte0 & 0xF)`

**Extended (3 bytes)** — when byte0 high nibble > $A:
```
byte0: ???? XXXX
byte1: 00YY YYYY   (Y = tile row, 6-bit)
byte2: NNNNNNNN   (extended object number)
```
Object type = `0x100 + byte2`

**Screen advance:** `$FF $FF` — increments screen counter  
**Terminator:** lone `$FF`

### Secondary Entrance Tables (pipes/doors)

| Address    | Size     | Description |
|------------|----------|-------------|
| `$05F800`  | 512 B    | Destination level — low byte (one per entrance) |
| `$05FA00`  | 512 B    | Secondary entrance Y/screen data |
| `$05FC00`  | 512 B    | Secondary entrance X/screen data |
| `$05FE00`  | 512 B    | Bits 7=slippery, 3=dest level high bit, 2–0=Mario action |

Destination level = `(($05FE00[n] >> 3) & 1) << 8 | $05F800[n]`

---

## Color Palettes

### BGR555 Format

All SNES palette colors are 16-bit little-endian BGR555:
```
bit 15:    unused (0)
bits 14–10: Blue  (5-bit, 0–31)
bits 9–5:  Green (5-bit, 0–31)
bits 4–0:  Red   (5-bit, 0–31)
```
Convert to 8-bit RGB: `R = (v & 0x1F) << 3`, `G = ((v>>5) & 0x1F) << 3`, `B = ((v>>10) & 0x1F) << 3`

### Hardcoded Palette ROM Addresses

Each entry is **24 bytes = 12 colors** covering CGRAM indices 1–12.
CGRAM index 0 of every row is transparent.

| Address    | CGRAM Row | Label          | Description |
|------------|-----------|----------------|-------------|
| `$00B0A0`  | —         | Back area color | 2 bytes only, single BGR555 word |
| `$00B0B0`  | 0         | BG Palette 0   | Background tiles |
| `$00B0C8`  | 1         | BG Palette 1   | Background tiles (alt) |
| `$00B190`  | 2         | FG Palette 0   | Foreground/hills/clouds |
| `$00B1A8`  | 3         | FG Palette 1   | Foreground (alt) |
| `$00B318`  | 14 ($E)   | Sprite Palette E | Shared sprite colors |
| `$00B330`  | 15 ($F)   | Sprite Palette F | Shared sprite colors |

### Runtime Palette Rows (NOT in fixed ROM locations)

Rows 4–13 are assembled at runtime from tileset-specific tables:
- **Rows 4–12:** Sprite palettes loaded from tileset table
- **Row 13:** Mario's palette — RAM pointer at `$7E:0D82`
  - Regular Mario: `$B2C8`, Luigi: `$B2DC`, Fire Mario: `$B2F0`, Fire Luigi: `$B304`

### Per-Level Custom Palettes (Lunar Magic)

| Address    | Size      | Description |
|------------|-----------|-------------|
| `$0EF600`  | 1272 B    | Pointer table: 424 levels × 3 bytes (24-bit SNES address) |

Each pointer → custom palette block (`$0202` bytes):
- Bytes 0–1: Back area color (BGR555)
- Bytes 2–513: All 256 CGRAM colors (little-endian BGR555)

`$000000` = use vanilla palette. `$FFFFFF` = LM hijack not installed.

---

## GFX Files

| Address    | Description |
|------------|-------------|
| `$088000`  | GFX file base address |
| `$600`     | Bytes per GFX file (64 tiles × 24 bytes 3BPP) |
| 52 files   | GFX00–GFX33 (hex), indices 0–51 |

Each file is 3BPP: 24 bytes per 8×8 tile = 64 tiles per file.

### GFX Assignment Tables

| Address    | Format                  | Description |
|------------|-------------------------|-------------|
| `$00A8C3`  | 4 bytes × sprite set    | Sprite GFX: SP1, SP2, SP3, SP4 file indices |
| `$00A92B`  | 4 bytes × tileset ID    | FG/BG GFX: FG1, FG2, FG3, AnimFG file indices |

Indexed by: sprite set from header byte 2 bits 3–0, tileset ID from header byte 4 bits 3–0.

### VRAM Layout (⚠ needs verification)

VRAM char number ranges per slot (approximate — not yet verified against SMW's level init code):

| Slot | Chars       | Palette rows | Notes |
|------|-------------|--------------|-------|
| FG1  | $000–$03F   | 0–3          | Foreground tileset |
| FG2  | $040–$07F   | 0–3          | Foreground tileset |
| FG3  | $080–$0BF   | 0–3          | Foreground tileset |
| SP1  | $100–$13F   | 8–15         | Sprite graphics |
| SP2  | $140–$17F   | 8–15         | Sprite graphics |
| SP3  | $180–$1BF   | 8–15         | Sprite graphics |
| SP4  | $1C0–$1FF   | 8–15         | Sprite graphics |

**This VRAM map is the key gap blocking correct tile rendering.** The char numbers
in Map16 subtile entries reference these VRAM positions. Until verified, the
tile renderer falls back to magenta (VRAM lookup miss).

---

## Map16 Tiles

| Address    | Description |
|------------|-------------|
| `$0D8000`  | Map16 page 0 — tiles $000–$0FF (8 bytes each) |
| `$0DC000`  | Map16 page 1 — tiles $100–$1FF (8 bytes each) |

Each 8-byte entry = four 2-byte SNES BG tile attributes (little-endian):
```
bits 15:    Y-flip
bit  14:    X-flip
bit  13:    Priority
bits 12–10: Palette row (3-bit, 0–7)
bits  9–0:  Character number (10-bit VRAM tile index)
```
Subtile order within the 8 bytes: **TL, BL, TR, BR** (column-major).

---

## Overworld

| Address    | Description |
|------------|-------------|
| `$049964`  | Exit path location table (Y, X, submap) |
| `$0499AA`  | Exit path destination table (level slot) |
| `$0499F0`  | Extra exit path destinations |

Translevel assignments (which overworld tile → which level slot) are stored
compressed in RAM at `$7ED000` (decompressed during overworld load).

---

## Sprite Data Format

Each sprite is 2 bytes:
```
byte0: YYYY XXXX   (Y = tile row, X = screen+local position)
  screen = (X >> 3) & 1
  localX = (X & 7) * 2
byte1: SSSSSSSS   (sprite ID)
```
Terminator: `$FF`
