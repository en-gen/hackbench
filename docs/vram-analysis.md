# VRAM Analysis — Yoshi's House (Level $104)

Empirical analysis of SMW VRAM layout using a full 65536-byte VRAM dump taken
from Mesen2 while level $104 ("Yoshi's House") was loaded and running.

Dump file: `tools/mesen/Debugger/Super Mario World (USA) - SnesVideoRam.dmp`

---

## VRAM Layout Summary

VRAM is 64 KB (32K 16-bit words). The dump revealed two clearly distinct regions:

| Byte range   | Word range    | Content type      | Entropy     | Notes |
|---|---|---|---|---|
| $0000–$3FFF  | $0000–$1FFF  | **Character data** (tile graphics) | High (420–507 unique words per 4KB) | All FG/BG tile GFX |
| $4000–$7FFF  | $2000–$3FFF  | **BG Tilemaps**    | Low (17–177 unique words per 4KB)  | Structured arrays  |

### Character data slots (bytes $0000–$3FFF)

Each slot holds 128 tiles × 32 bytes/tile (4bpp) = 4096 bytes.

| Slot | Char range  | Byte range       | GFX source |
|------|-------------|------------------|------------|
| fg1  | $000–$07F  | $0000–$0FFF      | tilesetId → FG slot 1 |
| fg2  | $080–$0FF  | $1000–$1FFF      | tilesetId → FG slot 2 |
| fg3  | $100–$17F  | $2000–$2FFF      | tilesetId → FG slot 3 |
| an1  | $180–$1FF  | $3000–$3FFF      | tilesetId → animated slot |

**Chars $200 and above are NOT present in VRAM for this level.** The byte range
$4000–$7FFF is occupied entirely by tilemaps.

⚠ Our GfxLoader.ts incorrectly assumes chars $200–$3FF exist at bytes $4000–$7FFF.
Those bytes are tilemap data, not char data. GFX slots an2/bg1/bg2/bg3 are either
not loaded in this level's configuration, or are loaded at a different VRAM position
that varies by level type.

### Tilemap slots (bytes $4000–$7FFF)

| Byte range  | Unique words | First 2 bytes | Probable role |
|-------------|-------------|---------------|---------------|
| $4000–$4FFF | 17          | `10F8 10F8…`  | BG1 tilemap (FG layer, nearly all sky) |
| $5000–$5FFF | 119         | `10F8 10F8…`  | BG1 tilemap (FG layer, screen 2 buffer?) |
| $6000–$6FFF | 56          | `00F8 00F8…`  | BG2 tilemap (background, simple/sparse) |
| $7000–$7FFF | 177         | `012E 012F…`  | **BG2 tilemap (background, detailed)** |

---

## BG2 Tilemap (VRAM $7000–$7FFF)

This is the Layer 2 background tilemap visible in Yoshi's House.

### Layout

The 2048-word region stores **two 32×32 SNES tilemap pages** in sequence:
- Words 0–1023 (bytes $7000–$77FF): Page 0 — char rows 0–31 of the level
- Words 1024–2047 (bytes $7800–$7FFF): Page 1 — char rows 32–63 (rows 32–53 = bottom 11 Map16 rows)

Each row in the tilemap is **32 words wide** (32 8×8 chars = 16 Map16 tiles = 1 screen width).

SNES tilemap word format: `YXOPCCCTTTTTTTTTT` (little-endian)
- bit 15: flipY
- bit 14: flipX
- bit 13: priority
- bits 12–10: palette (0–7)
- bits 9–0: charNum (relative to BG2 char base register)

### CharNums used

All charNums in the BG2 tilemap fall in the range **$000–$159** — entirely within
the fg1/fg2/fg3 char slots already loaded. No additional GFX files are needed.

Key charNums observed:
- `$0F8`, `$0F9` — sky/background filler tiles (fg2 slot)
- `$0FC`, `$0FF` — transparent/clear tiles (fg2 slot)
- `$100`–`$15F` — foreground scenery chars (fg3 slot)

Full unique charNum set:
```
000 010 011 018 020 03c 03d 03f 040 042 043 045 046 047 048 04f 050
058 05d 068 069 06c 06d 06e 071 075 085 086 087 088 089 095 096 097
099 0b8 0b9 0d8 0d9 0f8 0f9 0fc 0ff 100 101 102 103 104 105 106 107
108 109 10a 10b 10c 10d 10e 10f 110 111 112 113 114 115 116 117 118
119 11a 11b 11c 11d 11e 11f 120 121 122 123 124 125 126 127 128 129
12a 12b 12c 12d 12e 12f 130 139 13a 13b 13c 13d 13f 140 141 144 145
146 14d 14e 14f 150 151 152 153 154 155 156 157 158 159
```

### Palettes used

Most tiles use palette 0 (CGRAM row $00–$0F). A few scenery elements use palette 1.
Sprite-layer palettes are not used in the BG2 tilemap.

---

## L2 Pointer Format (corrected)

**All three level pointer tables (L1, L2, Sprite) use interleaved stride-3 format.**
Each level entry occupies 3 consecutive bytes: [lo, hi, bank].

| Table  | SNES base  | Entry for level i         | Total size |
|--------|------------|---------------------------|------------|
| L1     | $05E000    | base + i×3 → [lo, hi, bk] | 512 × 3 = $600 bytes |
| L2     | $05E600    | base + i×3 → [lo, hi, bk] | $600 bytes |
| Sprite | $05EC00    | base + i×3 → [lo, hi, bk] | $600 bytes |

⚠ The worktree `CLAUDE.md` incorrectly described L2/Sprite as "three separate 512-byte
sub-tables". SmwRom.ts already implements the correct interleaved stride-3 format.

### L2 bank=$FF (preset backgrounds)

When the bank byte = $FF, the level has a static preset BG (no L2 object stream).
The preset address: `SNES $0D0000 | (hi << 8) | lo`

Level $104 L2 pointer: lo=$00, hi=$D9, bk=$FF → preset at SNES **$0DD900**

---

## L2 Preset Format — NOT Raw SNES Tilemap

**Critical finding**: The ROM data at the L2 preset address ($0DD900) does NOT match
the VRAM BG2 tilemap at $7000.

| Property | ROM preset at $0DD900 | VRAM $7000 |
|---|---|---|
| First word | $29C7 (charNum $1C7, palette 2) | $012E (charNum $12E, palette 0) |
| CharNum range | $1A9–$1DF | $000–$159 |
| Palette values | 2, 6, 5 | 0, 1 |
| Full-word match | 0/2048 | — |
| CharNum-only match | 3/2048 | — |

The ROM preset data encodes tiles differently — either:

1. **Lunar Magic Map16 IDs**: The preset stores LM extended Map16 tile IDs (e.g.
   `$29C7` as ID for a Map16 tile in LM's extended pages). The game's init code
   looks up the Map16 table and writes the resulting 4-subtile SNES words to VRAM.

2. **Compressed format (LC_RLE1)**: The preset is RLE-compressed and decompresses
   to the VRAM content.

Data size: 2182 bytes before $FFFF terminator. This does not match any simple
uncompressed tilemap size (32×27×2=1728, 32×32×2=2048, etc.).

**Status: L2 preset decoding is NOT YET IMPLEMENTED.** The BG2 tilemap in VRAM
cannot currently be reconstructed from ROM data alone without implementing the
preset decoder.

---

## Rendering Implications

### What works (BG2 chars already loaded)
- All charNums in the BG2 tilemap ($000–$159) are in the fg1/fg2/fg3 slots
- Those slots are already loaded correctly by GfxLoader.ts via the tilesetId pipeline
- No new GFX loading is required for BG2 rendering

### What is broken / not implemented
1. **L2 preset decoding**: ROM preset at $0DD900 cannot be decoded to produce the
   BG2 tilemap without implementing the Map16 ID expansion or LC_RLE1 decompression
2. **an2/bg1 VRAM slots**: GfxLoader.ts assigns GFX32→chars $200 and GFX33→chars $280,
   but VRAM $4000–$7FFF is used for tilemaps in this level, not char data. Actual VRAM
   positions of GFX32/GFX33 vary by level type and are unverified.
3. **BG tilemap at $4000–$6FFF**: Roles of the three other tilemap slots are unverified
   (likely BG1/Layer 1 tilemap and scroll buffers)

### Recommended next steps
1. Determine whether the ROM preset uses LM Map16 IDs or LC_RLE1 compression
2. If LM Map16: find LM's extended Map16 table address in ROM and add a lookup
3. If LC_RLE1: implement `decompressRle1(data: Buffer): Buffer` in a new `LcRle1.ts`
4. Once decoded, build bgTileGrid by grouping 2×2 char entries into Map16Tile structs,
   using charNums that already exist in the atlas (no new GFX loading needed)

---

## Mesen Palette Viewer — Level $104

The Mesen Palette Viewer was captured with all 256 CGRAM colors loaded.

Observations:
- **Index $00**: Black (transparent) — CGRAM color 0 of sub-palette 0
- **Player palette area** ($C0–$DF): Red/yellow fire Mario colors visible — reported as correct
- **Other palettes**: Reported as incorrect by user — see palette research doc

See `docs/palette-analysis.md` (forthcoming from palette research agent) for details.
