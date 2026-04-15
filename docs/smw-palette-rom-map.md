# SMW Palette ROM Map

> Source: SMW Central ROM Map (palette-tagged entries)

## DMA Parameter Blocks (Palette Init Routine)

These addresses contain the 2-byte parameters embedded in SMW's palette loading code at `$00:ABF0`–`$00:ACEC`. Each palette DMA group has a Pointer, Starting Index, X-Span-1, and Y-Span-1.

### Layer 3 Palettes

| Address | Size | Description |
|---------|------|-------------|
| `$00AC06` | 2 bytes | Layer 3 Palettes Pointer |
| `$00AC0B` | 2 bytes | Layer 3 Palettes Starting Index |
| `$00AC10` | 2 bytes | Layer 3 Palettes X-Span -1 |
| `$00AC15` | 2 bytes | Layer 3 Palettes Y-Span -1 |

### Foreground/Sprite Palettes

| Address | Size | Description |
|---------|------|-------------|
| `$00AC1D` | 2 bytes | Foreground/Sprite Palettes Pointer |
| `$00AC22` | 2 bytes | Foreground/Sprite Palettes Starting Index |
| `$00AC27` | 2 bytes | Foreground/Sprite Palettes X-Span -1 |
| `$00AC2C` | 2 bytes | Foreground/Sprite Palettes Y-Span -1 |

### Back Area Colours

| Address | Size | Description |
|---------|------|-------------|
| `$00AC3C` | 2 bytes | Back Area Colours Pointer |

### Tileset-Specific FG Palettes

| Address | Size | Description |
|---------|------|-------------|
| `$00AC42` | 2 bytes | Tileset Specific FG Palettes Pointer |
| `$00AC59` | 2 bytes | Tileset Specific FG Palettes Starting Index |
| `$00AC5E` | 2 bytes | Tileset Specific FG Palettes X-Span -1 |
| `$00AC63` | 2 bytes | Tileset Specific FG Palettes Y-Span -1 |

### Tileset-Specific Sprite Palettes

| Address | Size | Description |
|---------|------|-------------|
| `$00AC6B` | 2 bytes | Tileset Specific Sprite Palettes Pointer |
| `$00AC82` | 2 bytes | Tileset Specific Sprite Palettes Starting Index |
| `$00AC87` | 2 bytes | Tileset Specific Sprite Palettes X-Span -1 |
| `$00AC8C` | 2 bytes | Tileset Specific Sprite Palettes Y-Span -1 |

### Layer 2 Background Palettes

| Address | Size | Description |
|---------|------|-------------|
| `$00AC94` | 2 bytes | Layer 2 Background Palettes Pointer |
| `$00ACAB` | 2 bytes | Layer 2 Background Palettes Starting Index |
| `$00ACB0` | 2 bytes | Layer 2 Background Palettes X-Span -1 |
| `$00ACB5` | 2 bytes | Layer 2 Background Palettes Y-Span -1 |

### Layer 1 Berry Palettes

| Address | Size | Description |
|---------|------|-------------|
| `$00ACBD` | 2 bytes | Layer 1 Berry Palettes Pointer |
| `$00ACC2` | 2 bytes | Layer 1 Berry Palettes Starting Index |
| `$00ACC7` | 2 bytes | Layer 1 Berry Palettes X-Span -1 |
| `$00ACCC` | 2 bytes | Layer 1 Berry Palettes Y-Span -1 |

### Berry Sprite Palettes

| Address | Size | Description |
|---------|------|-------------|
| `$00ACD4` | 2 bytes | Berry Sprite Palettes Pointer |
| `$00ACD9` | 2 bytes | Berry Sprite Palettes Starting Index |
| `$00ACDE` | 2 bytes | Berry Sprite Palettes X-Span -1 |
| `$00ACE3` | 2 bytes | Berry Sprite Palettes Y-Span -1 |

---

## Palette Data Tables

### Back Area Color

| Address | Size | Description |
|---------|------|-------------|
| `$00B0A0` | 16 bytes | Shared background area colour. Back area colour 0–7 |

### BG Palettes (Layer 2 Background, rows 0–1 cols 2–7)

| Address | Size | Description |
|---------|------|-------------|
| `$00B0B0` | 24 bytes | BG Palette 0 |
| `$00B0C8` | 24 bytes | BG Palette 1 |
| `$00B0E0` | 24 bytes | BG Palette 2 |
| `$00B0F8` | 24 bytes | BG Palette 3 |
| `$00B110` | 24 bytes | BG Palette 4 |
| `$00B128` | 24 bytes | BG Palette 5 |
| `$00B140` | 24 bytes | BG Palette 6 |
| `$00B158` | 24 bytes | BG Palette 7 |

### BG Secondary (rows 0–1 cols 8–F)

| Address | Size | Description |
|---------|------|-------------|
| `$00B170` | 16 bytes | Palette 0 colours 8-F in levels |
| `$00B180` | 16 bytes | Palette 1 colours 8-F in levels |

### FG Palettes (Layer 1 Foreground, rows 2–3 cols 2–7)

| Address | Size | Description |
|---------|------|-------------|
| `$00B190` | 12 bytes | Palette 2 colours 2-7, FG Palette 0 |
| `$00B19C` | 12 bytes | Palette 3 colours 2-7, FG Palette 0 |
| `$00B1A8` | 12 bytes | Palette 2 colours 2-7, FG Palette 1 |
| `$00B1B4` | 12 bytes | Palette 3 colours 2-7, FG Palette 1 |
| `$00B1C0` | 12 bytes | Palette 2 colours 2-7, FG Palette 2 |
| `$00B1CC` | 12 bytes | Palette 3 colours 2-7, FG Palette 2 |
| `$00B1D8` | 12 bytes | Palette 2 colours 2-7, FG Palette 3 |
| `$00B1E4` | 12 bytes | Palette 3 colours 2-7, FG Palette 3 |
| `$00B1F0` | 12 bytes | Palette 2 colours 2-7, FG Palette 4 |
| `$00B1FC` | 12 bytes | Palette 3 colours 2-7, FG Palette 4 |
| `$00B208` | 12 bytes | Palette 2 colours 2-7, FG Palette 5 |
| `$00B214` | 12 bytes | Palette 3 colours 2-7, FG Palette 5 |
| `$00B220` | 12 bytes | Palette 2 colours 2-7, FG Palette 6 |
| `$00B22C` | 12 bytes | Palette 3 colours 2-7, FG Palette 6 |
| `$00B238` | 12 bytes | Palette 2 colours 2-7, FG Palette 7 |
| `$00B244` | 12 bytes | Palette 3 colours 2-7, FG Palette 7 |

### Shared Sprite Palettes (rows 4–13 cols 2–7)

| Address | Size | Description |
|---------|------|-------------|
| `$00B250` | 12 bytes | Palette 4 colours 2-7 |
| `$00B25C` | 12 bytes | Palette 5 colours 2-7 |
| `$00B268` | 12 bytes | Palette 6 colours 2-7 (colour 4 overwritten in levels, not boss rooms) |
| `$00B274` | 12 bytes | Palette 7 colours 2-7 |
| `$00B280` | 12 bytes | Palette 8 colours 2-5 (cols 6-7 only during Nintendo Presents; overwritten by Mario palette) |
| `$00B28C` | 12 bytes | Palette 9 colours 2-7 |
| `$00B298` | 12 bytes | Ludwig palette / palette A colours 2-7 |
| `$00B2A4` | 12 bytes | Roy palette / palette B colours 2-7 |
| `$00B2B0` | 12 bytes | Palette C colours 2-7 |
| `$00B2BC` | 12 bytes | Morton palette / palette D colours 2-7 |

### Player Palettes (row 8 cols 6–F)

| Address | Size | Description |
|---------|------|-------------|
| `$00B2C8` | 20 bytes | Mario Palette |
| `$00B2DC` | 20 bytes | Luigi palette (colours 6-F of palette 8 while small/big/caped Luigi) |
| `$00B2F0` | 20 bytes | Fire Mario's palette |
| `$00B304` | 20 bytes | Fire Luigi palette (colours 6-F of palette 8 while fire Luigi) |

### Sprite Palettes E & F (rows 14–15 cols 2–7)

| Address | Size | Description |
|---------|------|-------------|
| `$00B318` | 24 bytes | Sprite palette 0, loaded to palettes E and F |
| `$00B330` | 24 bytes | Sprite palette 1, loaded to palettes E and F |
| `$00B348` | 24 bytes | Sprite palette 2, loaded to palettes E and F |
| `$00B360` | 24 bytes | Sprite palette 3, loaded to palettes E and F |
| `$00B378` | 24 bytes | Sprite palette 4, loaded to palettes E and F |
| `$00B390` | 24 bytes | Sprite palette 5, loaded to palettes E and F |
| `$00B3A8` | 24 bytes | Sprite palette 6, loaded to palettes E and F |
| `$00B3C0` | 24 bytes | Sprite palette 7, loaded to palettes E and F |

### Sprite Rows 5–7 cols 9–F

| Address | Size | Description |
|---------|------|-------------|
| `$00B552` | 14 bytes | Palette 5 colours 9-F |
| `$00B560` | 14 bytes | Palette 6 colours 9-F |
| `$00B56E` | 14 bytes | Palette 7 colours 9-F |

### Berry/Secondary cols 9–F

| Address | Size | Description |
|---------|------|-------------|
| `$00B674` | 14 bytes | Palettes 2 and 9, colours 9-F |
| `$00B682` | 14 bytes | Palettes 3 and A, colours 9-F |
| `$00B690` | 14 bytes | Palettes 4 and B, colours 9-F |

### Bowser Palettes

| Address | Size | Description |
|---------|------|-------------|
| `$00B69E` | 112 bytes | Bowser palettes (8 palettes, 7 colours each) |

---

## Overworld Palettes

### Overworld Map Layer 2

| Address | Size | Description |
|---------|------|-------------|
| `$00AD1E` | 7 bytes | Palette IDs to use for each submap |
| `$00AD28` | 2 bytes | OW Map Layer 2 Palettes Pointer |
| `$00AD30` | 2 bytes | OW Map Layer 2 Palettes Pointer (Special World Passed) |
| `$00AD4D` | 2 bytes | OW Map Layer 2 Palettes Starting Index |
| `$00AD52` | 2 bytes | OW Map Layer 2 Palettes X-Span -1 |
| `$00AD57` | 2 bytes | OW Map Layer 2 Palettes Y-Span -1 |

### Overworld Map Layer 1

| Address | Size | Description |
|---------|------|-------------|
| `$00AD5F` | 2 bytes | OW Map Layer 1 Palettes Pointer |
| `$00AD64` | 2 bytes | OW Map Layer 1 Palettes Starting Index |
| `$00AD69` | 2 bytes | OW Map Layer 1 Palettes X-Span -1 |
| `$00AD6E` | 2 bytes | OW Map Layer 1 Palettes Y-Span -1 |

### Overworld Map Sprites

| Address | Size | Description |
|---------|------|-------------|
| `$00AD76` | 2 bytes | OW Map Sprite Palettes Pointer |
| `$00AD7B` | 2 bytes | OW Map Sprite Palettes Starting Index |
| `$00AD80` | 2 bytes | OW Map Sprite Palettes X-Span -1 |
| `$00AD85` | 2 bytes | OW Map Sprite Palettes Y-Span -1 |

### Overworld Map Layer 3

| Address | Size | Description |
|---------|------|-------------|
| `$00AD8D` | 2 bytes | OW Map Layer 3 Palettes Pointer |
| `$00AD92` | 2 bytes | OW Map Layer 3 Palettes Starting Index |
| `$00AD97` | 2 bytes | OW Map Layer 3 Palettes X-Span -1 |
| `$00AD9C` | 2 bytes | OW Map Layer 3 Palettes Y-Span -1 |

### Title Screen Layer 3

| Address | Size | Description |
|---------|------|-------------|
| `$00ADA9` | 2 bytes | Title Screen Layer 3 Palettes (Row 1) Pointer |
| `$00ADAE` | 2 bytes | Title Screen Layer 3 Palettes (Row 1) Starting Index |
| `$00ADB3` | 2 bytes | Title Screen Layer 3 Palettes (Row 1) X-Span -1 |
| `$00ADB8` | 2 bytes | Title Screen Layer 3 Palettes (Row 1) Y-Span -1 |
| `$00ADC0` | 2 bytes | Title Screen Layer 3 Palettes (Row 2) Pointer |
| `$00ADC5` | 2 bytes | Title Screen Layer 3 Palettes (Row 2) Starting Index |
| `$00ADCA` | 2 bytes | Title Screen Layer 3 Palettes (Row 2) X-Span -1 |
| `$00ADCF` | 2 bytes | Title Screen Layer 3 Palettes (Row 2) Y-Span -1 |

### Per-Submap Overworld Palettes (rows 4–7 cols 1–7)

| Address | Size | Description |
|---------|------|-------------|
| `$00B3D8` | 14 bytes | YI Overworld Palette 4, Colours 1-7 |
| `$00B3E6` | 14 bytes | YI Overworld Palette 5, Colours 1-7 |
| `$00B3F4` | 14 bytes | YI Overworld Palette 6, Colours 1-7 |
| `$00B402` | 14 bytes | YI Overworld Palette 7, Colours 1-7 |
| `$00B410` | 14 bytes | Main OW Palette 4, Colours 1-7 |
| `$00B41E` | 14 bytes | Main OW Palette 5, Colours 1-7 |
| `$00B42C` | 14 bytes | Main OW Palette 6, Colours 1-7 |
| `$00B43A` | 14 bytes | Main OW Palette 7, Colours 1-7 |
| `$00B448` | 14 bytes | Star World OW Palette 4, Colours 1-7 |
| `$00B456` | 14 bytes | Star World OW Palette 5, Colours 1-7 |
| `$00B464` | 14 bytes | Star World OW Palette 6, Colours 1-7 |
| `$00B472` | 14 bytes | Star World OW Palette 7, Colours 1-7 |
| `$00B480` | 14 bytes | Vanilla Dome/Bowser's Valley OW Palette 4, Colours 1-7 |
| `$00B48E` | 14 bytes | Vanilla Dome/Bowser's Valley OW Palette 5, Colours 1-7 |
| `$00B49C` | 14 bytes | Vanilla Dome/Bowser's Valley OW Palette 6, Colours 1-7 |
| `$00B4AA` | 14 bytes | Vanilla Dome/Bowser's Valley OW Palette 7, Colours 1-7 |
| `$00B4B8` | 14 bytes | Forest of Illusion OW Palette 4, Colours 1-7 |
| `$00B4C6` | 14 bytes | Forest of Illusion OW Palette 5, Colours 1-7 |
| `$00B4D4` | 14 bytes | Forest of Illusion OW Palette 6, Colours 1-7 |
| `$00B4E2` | 14 bytes | Forest of Illusion OW Palette 7, Colours 1-7 |
| `$00B4F0` | 14 bytes | Special World OW Palette 4, Colours 1-7 |
| `$00B4FE` | 14 bytes | Special World OW Palette 5, Colours 1-7 |
| `$00B50C` | 14 bytes | Special World OW Palette 6, Colours 1-7 |
| `$00B51A` | 14 bytes | Special World OW Palette 7, Colours 1-7 |

---

## Special/Misc Palettes

### Castle Destruction Scenes

| Address | Size | Description |
|---------|------|-------------|
| `$009451` | 7 bytes | Back area colours for each castle destruction scene (1 byte per movie) |
| `$009459` | 7 bytes | Palette row (0-7) used by the castle in each destruction scene (1 byte per scene) |

### Menu Screens

| Address | Size | Description |
|---------|------|-------------|
| `$009B1D` | 2 bytes | BG Palette for File Erase screen (default: `$39C9`) |
| `$009CD4` | 2 bytes | BG Palette for File and Player Select screens (default: `$7393`) |
| `$009D8B` | 1 byte | Palette for "number of levels beaten" in Title Screen menu (YXPCCCTT format) |

### Animated Palettes

| Address | Size | Description |
|---------|------|-------------|
| `$00A41A` | 1 byte | [A9] Change to 60 to disable flashing yellow in levels (not OW) |
| `$00A41B` | 1 byte | Palette number for flashing palette (default: `$64`) |
| `$00A429` | 12 bytes | Code patch to disable flash animation of colour #64 |
| `$00A514` | 1 byte | First animated colour on overworld (default: `$6D`) |
| `$00A51D` | 1 byte | Second animated colour on overworld (default: `$7D`) |
| `$00B60C` | 16 bytes | Yoshi coin / yellow map spot animation colours |
| `$00B61C` | 16 bytes | Red map spot animation colours |
| `$00B5DE` | 16 bytes | Valley of Bowser flashing lightning colours |

### Boss/Special Palettes

| Address | Size | Description |
|---------|------|-------------|
| `$00B65E` | 14 bytes | Iggy/Larry Platform Palette |
| `$00B69E` | 112 bytes | Bowser palettes (8 palettes × 7 colours) |
| `$00B70E` | 36 bytes | "The End" palettes (3 palettes × 6 colours: Luigi, Mario, Princess) |
| `$03B902` | 128 bytes | Magikoopa palettes (8 palettes × 8 colours incl. transparent) |
| `$03B982` | 128 bytes | Big Boo Boss palettes (same layout as Magikoopa) |

### Player Direction

| Address | Size | Description |
|---------|------|-------------|
| `$00E18C` | 2 bytes | Index table for player palette based on facing direction |

### Sprite-Specific Palettes

| Address | Size | Description |
|---------|------|-------------|
| `$018335` | 4 bytes | Yoshi Egg colours (Red, Blue, Yellow, Blue) |
| `$018466` | 2 bytes | P-Switch colours (Blue, Silver) |
| `$01C616` | 4 bytes | Star sprite flash palette sequence (YXPPCCCT format) |
| `$01C7EF` | 1 byte | Chain link (connected to platform) palette |
| `$01C8CC` | 1 byte | Other chain links palette |
| `$01C8FB` | 1 byte | Wooden platform palette |
| `$01FA2F` | 3 bytes | Boo Block palette patch |
| `$01FA3A` | 3 bytes | Boo Block palettes |
| `$02A9C3` | 1 byte | Silver P-Switch sprite palette (offscreen sprites) |
| `$02B9EF` | 1 byte | Silver P-Switch sprite palette (onscreen sprites) |
| `$02CAFA` | 2 bytes | Chargin' Chuck arm palette patch (use with `$02CB2E`) |
| `$02CB2E` | 1 byte | Chargin' Chuck arm palette (use with `$02CAFA`) |
| `$02CB81` | 1 byte | Pitchin' Chuck baseball palette/GFX page |
| `$02DB1F` | 1 byte | Amazing Flyin' Hammer Brothers palette (default: `$37`) |
| `$02E10E` | 1 byte | Jumping Piranha Plant leaves palette |
| `$02ED39` | 2 bytes | Flashing Super Koopa cape palette (CCC bits) |
| `$02ED40` | 1 byte | Red/Yellow Super Koopa cape palette (CCC bits) |
| `$02F04D` | 1 byte | Angry Wiggler palette (default: `$08`, YXPPCCCT) |
| `$02F1EE` | 1 byte | Wiggler flower palette |
| `$02F3E2` | 4 bytes | Hopping birds palettes |
| `$038B37` | 6 bytes | Bowser Statue properties (OR'd with sprite palette) |

### Credits

| Address | Size | Description |
|---------|------|-------------|
| `$0CABA4` | 7 bytes | BG colour for each credits cutscene |
