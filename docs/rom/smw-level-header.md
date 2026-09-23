# SMW Level Primary Header (5 bytes)

Located at the start of each level's L1 data in ROM.

## Byte Layout

| Byte | Bits  | Field          | Values | Notes |
|------|-------|----------------|--------|-------|
| 0    | 7–5   | bgPalette      | 0–7    | BG palette variant for CGRAM rows 0–1 |
| 0    | 4–0   | levelLength    | 0–31   | Screen count = value + 1 |
| 1    | 7–5   | bgColor        | 0–7    | Background color setting |
| 1    | 4–0   | levelMode      | 0–20   | Level type (0=horizontal, etc.) |
| 2    | 7     | layer3Priority | 0–1    | Layer 3 priority flag |
| 2    | 6–4   | music          | 0–7    | Music track index |
| 2    | 3–0   | (unused/ext)   |        | Extended mode bits |
| 3    | 7–6   | timeLimit      | 0–3    | Timer setting |
| 3    | 5–4   | spritePalette  | 0–3    | Sprite CGRAM rows 4–8 variant |
| 3    | 3–0   | spriteSet      | 0–15   | GFX file set for VRAM (NOT palette) |
| 4    | 7–6   | itemMemory     | 0–3    | Item memory setting |
| 4    | 5–4   | verticalScroll | 0–3    | Vertical scroll behavior |
| 4    | 3–0   | bgTypeId       | 0–15   | Background type (NOT GFX tileset) |

## Important Distinctions

- **spriteSet** (byte 3, bits 3–0): Selects which GFX files load into VRAM
- **spritePalette** (byte 3, bits 5–4): Selects which color palette rows 4–8
- **GFX tilesetId**: NOT in the header. Derived at runtime via `ROM[$05D760 + spriteSet]`
- **Screen count**: `levelLength + 1` (authoritative, not FF FF pair counting)

## ROM Pointer Tables

| Table    | Lo       | Hi       | Bank     | Entries |
|----------|----------|----------|----------|---------|
| L1 data  | $05E000  | $05E200  | $05E400  | 512     |
| Sprites  | $05EC00  | $05EE00  | $05F000  | 512     |
