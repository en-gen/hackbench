# SMW Palette Loading Analysis

Research based on reading `src/rom/PaletteLoader.ts` and cross-referencing
`docs/level-rendering.md`. The Mesen Palette Viewer screenshot for level $104
(Yoshi's House) shows all 256 CGRAM entries as loaded by the game at runtime.

## Key Principle

**Palettes are level-specific.** At level load time, SMW selects palette data from
ROM based on level header fields (spriteSet, bgPaletteRow, spritePalette, etc.) and
copies it into SNES CGRAM. The Mesen palette viewer shows CGRAM as-loaded for the
specific level — not a global palette.

---

## CGRAM Layout (SMW)

CGRAM = 256 × BGR555 = 16 rows × 16 colors.

| CGRAM row | Indices     | SNES role           | SMW usage |
|-----------|-------------|---------------------|-----------|
| 0         | $00–$0F    | BG sub-palette 0    | Layer 2 BG tiles — color 0 = transparent |
| 1         | $10–$1F    | BG sub-palette 1    | Layer 2 BG tiles |
| 2         | $20–$2F    | BG sub-palette 2    | Layer 1 FG terrain |
| 3         | $30–$3F    | BG sub-palette 3    | Layer 1 FG terrain |
| 4         | $40–$4F    | BG sub-palette 4    | Layer 1 FG terrain |
| 5         | $50–$5F    | BG sub-palette 5    | FG terrain |
| 6         | $60–$6F    | BG sub-palette 6    | FG terrain / scenery |
| 7         | $70–$7F    | BG sub-palette 7    | FG terrain / scenery |
| 8         | $80–$8F    | OBJ sub-palette 0   | Sprite palette |
| 9         | $90–$9F    | OBJ sub-palette 1   | Sprite palette |
| 10        | $A0–$AF    | OBJ sub-palette 2   | Sprite palette |
| 11        | $B0–$BF    | OBJ sub-palette 3   | Sprite palette |
| 12        | $C0–$CF    | OBJ sub-palette 4   | Sprite palette |
| 13        | $D0–$DF    | OBJ sub-palette 5   | **Player palette** (Mario, Luigi, etc.) |
| 14        | $E0–$EF    | OBJ sub-palette 6   | Global sprite palette E |
| 15        | $F0–$FF    | OBJ sub-palette 7   | Global sprite palette F |

Color index 0 in every row is transparent (not drawn).

---

## PaletteLoader.ts — Current vs Expected

| CGRAM row(s) | Indices      | Current formula                          | Expected formula                          | Status |
|---|---|---|---|---|
| 0            | $00–$0F     | `$00B0B0` (variant 0)                    | `$00B0B0` (variant 0)                     | ✓ |
| 1            | $10–$1F     | `$00B0C8` (variant 0)                    | `$00B0C8` (variant 0)                     | ✓ |
| 2            | $20–$2F     | `$00B190` (variant 0)                    | `$00B190` (variant 0)                     | ✓ |
| 3            | $30–$3F     | `$00B1A8` (variant 0)                    | `$00B1A8` (variant 0)                     | ✓ |
| 4–8          | $40–$8F     | `$00B348 + spriteSet × 120`              | `$00B348 + spriteSet × 120`               | ✓ |
| **9–12**     | **$90–$CF** | **❌ NOT LOADED**                         | (see below — berry/Yoshi/misc)           | **BUG** |
| 13           | $D0–$DF     | `$00B2C8 + marioVariant × 20`            | `$00B2C8 + marioVariant × 20`             | ✓ |
| 14           | $E0–$EF     | `$00B318`                                | `$00B318`                                 | ✓ |
| 15           | $F0–$FF     | `$00B330`                                | `$00B330`                                 | ✓ |

---

## Bugs Found

### Bug 1 — CGRAM rows 9–12 ($90–$CF) not loaded ← CRITICAL

Four CGRAM rows covering 64 colors are **never written** by PaletteLoader.ts.
These rows contain sprite palette data for Yoshi, berries, coins, key items, and
other non-player sprites.

- **Symptom**: Any sprite whose palette map selects sub-palette 1–4 (OBJ rows 1–4,
  i.e. CGRAM $90–$CF) renders with placeholder gray instead of actual colors.
- **User observation**: "player palettes correct, but others look wrong" — consistent
  with rows 9–12 being blank in our output while CGRAM $D0–$DF (row 13, player)
  loads correctly.
- **Expected source**: Likely continuation of the sprite set palette table at $B348
  or a separate Yoshi/berry table. Exact addresses need verification via Mesen.
- **Color count loaded per row**: The sprite palette load at $B348 reads 24 bytes
  (12 colors) per row but skips rows 9–12 entirely.

### Bug 2 — Only 12 of 15 colors loaded per palette row

`PALETTE_ENTRY_BYTES = 24` reads 24 bytes = 12 colors per sub-palette row.
SNES CGRAM rows hold 16 colors (color 0 transparent + 15 visible colors = 30 bytes).

- **Current**: loads colors 1–12 per row
- **Missing**: colors 13–15 per row
- **Impact**: Sprites/tiles that use colors 13–15 (rightmost 3 of each sub-palette)
  will render black instead of the correct color.

### Bug 3 — BG/FG palette variant addresses unverified ⚠

When `bgPaletteRow > 0` or `fgVariant > 0`, the loader reads from the $B0E0 region
(BG variants) and $B1C0 region (FG variants). These offsets are not confirmed
against live CGRAM captures and may have wrong stride or indexing.

- **Variant 0** (default): confirmed correct (addresses $B0B0, $B0C8, $B190, $B1A8)
- **Variants 1+**: addresses inferred, marked ⚠ in code, not validated

---

## Mesen Palette Viewer — Yoshi's House ($104)

From the screenshot:

- Row $D ($D0–$DF, player): Fire Mario red/yellow — **confirmed correct** by user
- Row $E ($E0–$EF, global E): appears populated
- Row $F ($F0–$FF, global F): appears populated
- Rows $9–$C ($90–$CF, sprite sub-palettes 1–4): these are what our code **does not load**

---

## Fix Plan

### Priority 1: Load CGRAM rows 9–12

Need to identify the ROM source for OBJ sub-palettes 1–4 (CGRAM $90–$CF).

**Investigation approach** — run this Mesen Lua script to identify where the data comes from:
```lua
-- Watch for writes to CGRAM $90-$CF during level load
emu.addMemoryCallback(function(addr, val)
    local state = emu.getState()
    emu.log(string.format("CGRAM[$%02X] = $%04X  PC=$%06X", addr, val, state.cpu.pc))
end, emu.callbackType.write, 0x90, 0xCF, emu.memType.cgRam)
```

If CGRAM writes at $90–$CF happen via DMA, the CPU PC will point to the DMA setup
code. Check the DMA source register ($4302–$4304) at that point to get the ROM address.

**Likely source**: `$00B348 + spriteSet × 120` already covers some sprite rows. The
remaining rows 9–12 may be a second block at `$00B3F8 + spriteSet × N` or they may
come from the Yoshi/berry/berry palette area. The custom per-level palette block at
`$0EF600 + levelIndex × 514` (Lunar Magic) may also be relevant.

### Priority 2: Fix color count (12 → 15 per row)

Change `PALETTE_ENTRY_BYTES` from 24 to 30 (15 colors × 2 bytes).
Update all read loops accordingly.

### Priority 3: Verify variant loading with live data

Use Mesen CGRAM dump (export all 512 bytes of CGRAM) and compare byte-by-byte
against what PaletteLoader.ts would compute for a level with non-zero bgPaletteRow.

---

## Action Items

- [ ] Run the Lua watchpoint script to find ROM source of CGRAM $90–$CF
- [ ] Export full CGRAM from Mesen for level $104 (`SnesCgRam.dmp`)
- [ ] Compare expected vs actual CGRAM byte-by-byte in a script
- [ ] Fix `PALETTE_ENTRY_BYTES` from 24→30 and expand loops
- [ ] Load rows 9–12 once ROM source is confirmed
- [ ] Validate BG/FG variant loading with at least one non-zero variant level
