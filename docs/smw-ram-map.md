# Super Mario World — RAM Memory Map Reference

Source: SMW Central memory map (RAM only: banks `$7E`/`$7F`).  
This is **not** a ROM map. All addresses are runtime RAM addresses.

---

## Table of Contents

1. [Palettes](#palettes)
2. [Graphics / VRAM](#graphics--vram)
3. [Player](#player)
4. [Sprites](#sprites)
5. [Level State / Camera](#level-state--camera)
6. [Overworld](#overworld)
7. [Yoshi](#yoshi)

---

## Palettes

| Address | Size | Description |
|---------|------|-------------|
| `$7E:0680` | 1 byte | Index to palette updating tables uploaded every frame. `$00` = use table at `$0682`; `$03` = use table at `$0905`; `$06` = use table at `$0703`. |
| `$7E:0681` | 1 byte | Index into the table at `$7E:0682` during lightning, Magikoopa, and Big Boo Boss palette effects. |
| `$7E:0682–0694` | 19 bytes | Dynamic palette upload table. Used for lightning/Magikoopa/Big Boo Boss palette effects. `$0682` = byte count to transfer; `$0683` = color number (stored to SNES `$2122`). |
| `$7E:0701–0702` | 2 bytes | Background color. Used during gameplay in conjunction with SNES register `$2132`. |
| `$7E:0703–08F2` | 512 bytes | Full CGRAM palette (256 colors × 2 bytes, BGR555). Only uploaded to CGRAM during level load. Also partially used during overworld load. |
| `$7E:0903–0904` | 2 bytes | Copy of background color from `$0701`. |
| `$7E:0905–0AF4` | 496 bytes | Copy of palettes 0–F from `$0703–$08F2`. The original game only includes the first half of palette F (up to color F7). Used in overworld path event fades and level fade routines. |
| `$7E:1494` | 1 byte | Direction of color fading at level end. Bit 7: `$00` = getting darker; `$80` = getting brighter. |
| `$7E:1FFB` | 1 byte | Lightning flash color index. Values `$00–$07` only. `$07` = brightest white; lower = closer to black. |

### Player Palette Pointer

| Address | Size | Description |
|---------|------|-------------|
| `$7E:0D82–0D83` | 2 bytes | 16-bit pointer (bank `$00`) to the player palette data. `$B2C8` = regular Mario; `$B2DC` = regular Luigi; `$B2F0` = fire Mario; `$B304` = fire Luigi. |

---

## Graphics / VRAM

| Address | Size | Description |
|---------|------|-------------|
| `$7E:0012` | 1 byte | Stripe image loader index. Value must be divisible by 3. Controls which VRAM stripe image is uploaded (title screen, overworld border, cutscene BGs, etc.). |
| `$7E:0D76–0D77` | 2 bytes | GFX33 DMA — first source address for animated graphics. |
| `$7E:0D78–0D79` | 2 bytes | GFX33 DMA — second source address for animated graphics. |
| `$7E:0D7A–0D7B` | 2 bytes | GFX33 DMA — third source address for animated graphics. |
| `$7E:0D7C–0D7D` | 2 bytes | GFX33 DMA — first VRAM destination address for animated graphics. |
| `$7E:0D7E–0D7F` | 2 bytes | GFX33 DMA — second VRAM destination address for animated graphics. |
| `$7E:0D80–0D81` | 2 bytes | GFX33 DMA — third VRAM destination address for animated graphics. |
| `$7E:0D85–0D98` | 20 bytes | 16-bit RAM pointers for uploading player, Yoshi, and Podoboo on-screen tiles. Two sets of 10 bytes; each two bytes covers two 8×8 tiles. |
| `$7E:0D99–0D9A` | 2 bytes | Low two bytes of the 24-bit RAM address (bank `$7E`) of tile 7F graphics; used during the player graphics DMA routine. |
| `$7E:192B` | 1 byte | Sprite GFX setting from the level header. Also used on the overworld and in cutscenes to determine which GFX files to upload. |
| `$7E:1B9A` | 1 byte | Background scroll activated flag. Set by the orange platform sprite (`$5E`) and flying turn blocks (`$C1`). Triggers the fast BG scroll sprite. |
| `$7E:1BA3–1BE2` | 64 bytes | Buffer for Mode 7 tile data uploaded to VRAM for non-platform Mode 7 bosses (8×8 tile = 64 bytes in 8bpp). |
| `$7E:2000–$7E:5CFF` | 23808 bytes | GFX32 decompressed. Loaded during the Nintendo Presents logo; never modified afterward. |
| `$7E:7D00–$7E:ACFF` | 12288 bytes | GFX33 decompressed. Loaded during the Nintendo Presents logo; never modified afterward. |
| `$7E:AD00–$7E:B8FF` | 3072 bytes | GFX file decompression buffer (3bpp for unexpanded GFX, 4bpp for expanded). May extend further for large files (LT3, AN2, etc.). |
| `$7F:C0C0–$7F:C0F7` | 56 bytes | Lunar Magic ExAnimation output table. 8 sub-tables × 7 bytes, written by LM's ExAnimation routine each frame. |

### Map16 / VRAM Pointer Table

| Address | Size | Description |
|---------|------|-------------|
| `$7E:0FBE–$7E:13BD` | 1024 bytes | Table of 16-bit pointers to VRAM data for each original Map16 tile (tiles `$000–$1FF`), indexed by `tile × 2`. References tables near `$0D8000`. |

---

## Player

### Position and Movement

| Address | Size | Description |
|---------|------|-------------|
| `$7E:007A` | 1 byte | Accumulating fraction bits for player X speed (fixed-point, fractions of 256). |
| `$7E:007B` | 1 byte | Player X speed (signed 8-bit), in 1/16 px/frame. Positive = rightward; negative = leftward. |
| `$7E:007D` | 1 byte | Player Y speed (signed 8-bit), in 1/16 px/frame. Positive = downward; negative = upward. Capped at a maximum downward speed. |
| `$7E:007E–007F` | 2 bytes | Player X position (16-bit) within the screen. |
| `$7E:0080–0081` | 2 bytes | Player Y position (16-bit) within the screen. May be offset by `$1888` (screen shake) and small powerup-based displacements. |
| `$7E:0090` | 1 byte | Player Y position within a block (`$0096 & $0F`). Indicates top/bottom contact. |
| `$7E:0091` | 1 byte | Y position of player head and feet within a block. |
| `$7E:0092` | 1 byte | Player X position within a block (`($0094 + $08) & $0F`). |
| `$7E:0093` | 1 byte | Side of a block the player is on. `$00` = right side; `$01` = left side. |
| `$7E:0094–0095` | 2 bytes | Player X position (16-bit) within the level, next frame (one frame ahead of `$D1`). Also used as on-screen X on the overworld border. |
| `$7E:0096–0097` | 2 bytes | Player Y position (16-bit) within the level, next frame (one frame ahead of `$D3`). Also used as on-screen Y on the overworld border. |
| `$7E:00D1–00D2` | 2 bytes | Player X position (16-bit) within the level, current frame. |
| `$7E:00D3–00D4` | 2 bytes | Player Y position (16-bit) within the level, current frame. |
| `$7E:13DA` | 1 byte | Accumulating fraction bits for player X position (upper 4 bits used: `%xxxx0000`). |
| `$7E:13DC` | 1 byte | Accumulating fraction bits for player Y position (upper 4 bits used: `%yyyy0000`). |

### State and Flags

| Address | Size | Description |
|---------|------|-------------|
| `$7E:0019` | 1 byte | Current player powerup status. `$00` = small; `$01` = big; `$02` = fire; `$03` = cape; `$04` = balloon; `$05` = Yoshi. |
| `$7E:0071` | 1 byte | Player animation trigger state. Non-zero = performing an action, cannot be player-controlled (used for cutscenes). |
| `$7E:0072` | 1 byte | Player in-air flag and midair pose value. Set based on how the player became airborne. |
| `$7E:0074` | 1 byte | Player climbing flag. Format: `n--shftb`. Non-zero indicates which interaction points touch a climbable tile. `n` = net (1) or vine (0). |
| `$7E:0076` | 1 byte | Player direction. `$00` = left; `$01` = right. |
| `$7E:0077` | 1 byte | Player blocked status. Bitfield: `S--M^v<>`. `M` = inside tile; `^` = tile above; `v` = tile below; `<` = tile left; `>` = tile right. |
| `$7E:0078` | 1 byte | Flags to disable parts of the player sprite (hiding, disable star timer decrement, etc.). |
| `$7E:0088` | 1 byte | Timer for how long the player travels into a pipe before warping. Also used in castle destruction scenes for input holding. |
| `$7E:0089` | 1 byte | Action taken when the player enters/exits a pipe. Also a timer for No Yoshi cutscene input. |
| `$7E:13DB` | 1 byte | Player walking/running frame counter, cycling between 0 and max (defined per powerup). |
| `$7E:13DD` | 1 byte | Pose while player is turning around on the ground with non-zero X speed. |
| `$7E:13DE` | 1 byte | Poses used on the overworld and during credits (3-frame animation cycle). Also a "looking up" flag. |
| `$7E:13DF` | 1 byte | Controls which cape frame is shown while walking, sprint-jumping, etc. |
| `$7E:13E0` | 1 byte | Player pose index. Controls which sprite frame Mario/Luigi uses. Poses `$40`/`$41` = invisible. |
| `$7E:13E1` | 1 byte | What kind of slope the player is on (also set during cape flight). |
| `$7E:13E2` | 1 byte | Spinjump fireball timer. Increments while spinjumping with fire power; fires when low 4 bits clear. |
| `$7E:13E3` | 1 byte | Player wall-running flag. |
| `$7E:13E4` | 1 byte | Player P-meter / dash timer. Increments `+$02`/frame with dash held while on ground; decrements otherwise. `$70` = full P-speed. |
| `$7E:13E9–13EA` | 2 bytes | Cape interaction X position within the level. |
| `$7E:13EB–13EC` | 2 bytes | Cape interaction Y position within the level. |
| `$7E:13ED` | 1 byte | Player slope-slide pose (`$1C`). Also set negative (bit 7) when landing from flight (enables sliding). |
| `$7E:13EE` | 1 byte | What kind of slope the player is on. |
| `$7E:13EF` | 1 byte | Player on-ground flag. `$01` = Layer 1; `$02` = Layer 2; `$03` = both. Doubled if running fast up a slope. |
| `$7E:13F9` | 1 byte | Player graphical layer priority. `$01` = behind objects; `$02` = behind objects and sprites; `$03` = behind sprites only. |
| `$7E:13FA` | 1 byte | Whether player can immediately jump out of water. `$00` = no; `$01` = yes. |
| `$7E:13FB` | 1 byte | Player frozen flag (controls and animation frozen; other sprites still interact with player). |
| `$7E:13FF` | 1 byte | Player direction (`$76`) × 2. Used when scrolling horizontally. |
| `$7E:1407` | 1 byte | Player cape-flight phase. Also controls player pose during flight (table at `$00:CE79`). |
| `$7E:1408` | 1 byte | Index for cape glide table at `$00:D7D4`. `$00` = rise; `$01` = glide down; etc. |
| `$7E:1409` | 1 byte | Furthest dive stage reached during flight. Values: `$F8` (not aiming), `$F4` (partial), `$F0` (full aim). |
| `$7E:148F` | 1 byte | Player is holding an object flag (throw block, key, shell, etc.). |
| `$7E:14A6` | 1 byte | Cape spin timer. |
| `$7E:185C` | 1 byte | Flag to disable player interaction with objects (non-zero = disabled). |
| `$7E:188B` | 1 byte | Player image-relative Y position, used with shaking ground effect (`$1887`). 8-bit. |
| `$7E:18D2` | 1 byte | Star kill combo counter. Increments each sprite killed by star. `$01`=200pts ... `$05`=2000pts, etc. |

### Identity and Stats

| Address | Size | Description |
|---------|------|-------------|
| `$7E:0DB3` | 1 byte | Which character is in play. `$00` = Mario; `$01` = Luigi. (For overworld, prefer `$0DD6`.) |
| `$7E:0DB4` | 1 byte | Mario's lives (2-player mode only; use `$0DBE` in most cases). |
| `$7E:0DB5` | 1 byte | Luigi's lives (2-player mode only; use `$0DBE` in most cases). |
| `$7E:0DB6` | 1 byte | Mario's coin count (2-player mode only; use `$0DBF` in most cases). |
| `$7E:0DB7` | 1 byte | Luigi's coin count (2-player mode only; use `$0DBF` in most cases). |
| `$7E:0DB8` | 1 byte | Mario's powerup status (2-player mode only; use `$0019` in most cases). |
| `$7E:0DB9` | 1 byte | Luigi's powerup status (2-player mode only; use `$0019` in most cases). |
| `$7E:0DBC` | 1 byte | Item in Mario's item box (2-player mode only; use `$0DC2`). `$00`=none; `$01`=mushroom; `$02`=fire flower; `$03`=star; `$04`=feather. |
| `$7E:0DBD` | 1 byte | Item in Luigi's item box (2-player mode only; use `$0DC2`). |
| `$7E:0DBE` | 1 byte | Current player lives minus one (`$04` = 5 lives). |
| `$7E:0DBF` | 1 byte | Current player coin count. |
| `$7E:0DC2` | 1 byte | Item in current player's item box. `$00`=none; `$01`=mushroom; `$02`=fire flower; `$03`=star; `$04`=feather. |
| `$7E:0DD6` | 1 byte | Which character on the overworld. Equals `$0DB3 × 4`. `$00` = Mario; `$04` = Luigi. |

### Overworld Player Position

| Address | Size | Description |
|---------|------|-------------|
| `$7E:0DC7–0DC8` | 2 bytes | Overworld X position Mario is moving toward. Zero when stationary. |
| `$7E:0DC9–0DCA` | 2 bytes | Overworld Y position Mario is moving toward. Zero when stationary. |
| `$7E:0DCB–0DCC` | 2 bytes | Overworld X position Luigi is moving toward. Zero when stationary. |
| `$7E:0DCD–0DCE` | 2 bytes | Overworld Y position Luigi is moving toward. Zero when stationary. |
| `$7E:0DCF–0DD0` | 2 bytes | Player X speed on overworld. |
| `$7E:0DD1–0DD2` | 2 bytes | Player Y speed on overworld. |
| `$7E:1F13–1F16` | 4 bytes | Player animation on overworld. `$1F13/$1F14` = Mario image; `$1F15/$1F16` = Luigi image. High bytes unused. |
| `$7E:1F17–1F18` | 2 bytes | Overworld X position of Mario. |
| `$7E:1F19–1F1A` | 2 bytes | Overworld Y position of Mario. |
| `$7E:1F1B–1F1C` | 2 bytes | Overworld X position of Luigi. |
| `$7E:1F1D–1F1E` | 2 bytes | Overworld Y position of Luigi. |
| `$7E:1F1F–1F20` | 2 bytes | Mario's overworld X position ÷ 16. Used for tile lookup, level entry, and level name display. |
| `$7E:1F21–1F22` | 2 bytes | Mario's overworld Y position ÷ 16. |
| `$7E:1F23–1F24` | 2 bytes | Luigi's overworld X position ÷ 16. |
| `$7E:1F25–1F26` | 2 bytes | Luigi's overworld Y position ÷ 16. |

---

## Sprites

### Standard Sprite Tables (12 slots each)

| Address | Size | Description |
|---------|------|-------------|
| `$7E:009E–00A9` | 12 bytes | Sprite number / Acts Like setting. For custom sprite actual ID, see `$7F:AB9E`. |
| `$7E:00AA–00B5` | 12 bytes | Sprite Y speed. |
| `$7E:00B6–00C1` | 12 bytes | Sprite X speed. |
| `$7E:00C2–00CD` | 12 bytes | Miscellaneous sprite table (often a pointer to sub-data). |
| `$7E:00D8–00E3` | 12 bytes | Sprite Y position, low byte. |
| `$7E:00E4–00EF` | 12 bytes | Sprite X position, low byte. |
| `$7E:14C8–14D3` | 12 bytes | Sprite status table. `$00` = empty; `$01` = slot taken, init not yet run; `$08+` = active states. |
| `$7E:14D4–14DF` | 12 bytes | Sprite Y position, high byte. |
| `$7E:14E0–14EB` | 12 bytes | Sprite X position, high byte. |
| `$7E:14EC–14F7` | 12 bytes | Accumulating fraction bits for sprite Y position (`%YYYY0000`). |
| `$7E:14F8–1503` | 12 bytes | Accumulating fraction bits for sprite X position (`%XXXX0000`). |
| `$7E:1588–1593` | 12 bytes | Sprite blocked status. Format: `asb?udlr`. |
| `$7E:15A0–15AB` | 12 bytes | Sprite off-screen flag, horizontal. |
| `$7E:15C4–15CF` | 12 bytes | Flag: sprite is more than 4 tiles off-screen horizontally (used by large sprites). |
| `$7E:15D0–15DB` | 12 bytes | Sprite is on Yoshi's tongue. `$00` = no; `$01` = yes. |
| `$7E:15DC–15E7` | 12 bytes | Flag to disable sprite interaction with objects. |
| `$7E:15F6–1601` | 12 bytes | Sprite YXPPCCCT property byte. Used in sprite graphics routines. |
| `$7E:1656–1661` | 12 bytes | Sprite properties, Tweaker byte 1: `sSjJcccc` (smoke, hop shells, jump-kill, palette, etc.). |
| `$7E:1662–166D` | 12 bytes | Sprite properties, Tweaker byte 2: `dscccccc` (straight fall on death, shell death frame, clipping). |
| `$7E:166E–1679` | 12 bytes | Sprite properties, Tweaker byte 3: `lwcfpppg` (layer 2 interaction, water splash, cape/fire immunity, palette). |
| `$7E:167A–1685` | 12 bytes | Sprite properties, Tweaker byte 4: `dpmksPiS` (player interaction, powerup-on-eat, etc.). |
| `$7E:1686–1691` | 12 bytes | Sprite properties, Tweaker byte 5: `dnctswye` (object interaction, coin-on-clear, direction, etc.). |
| `$7E:190F–191B` | 12 bytes | Sprite properties, Tweaker byte 6: `wcdj5sDp` (wall sticking, silver POW coin, 2-tile height, etc.). |

### Sprite Load Status

| Address | Size | Description |
|---------|------|-------------|
| `$7E:1938–19B7` | 128 bytes | Sprite load status within the level. `$00` in a slot = sprite will respawn when scrolled back on-screen. |

### OAM

| Address | Size | Description |
|---------|------|-------------|
| `$7E:0420–049F` | 128 bytes | OAM extra bits table (1 byte per OAM tile). Format: `%000000SX`. `S` = size (0=8×8, 1=16×16); `X` = bit 9 of tile number. |

### Extended Sprites (10 slots)

| Address | Size | Description |
|---------|------|-------------|
| `$7E:170B–1714` | 10 bytes | Extended sprite type number. Last 2 slots reserved for fireballs. |
| `$7E:1715–171E` | 10 bytes | Extended sprite Y position, low byte. |
| `$7E:171F–1728` | 10 bytes | Extended sprite X position, low byte. |
| `$7E:1729–1732` | 10 bytes | Extended sprite Y position, high byte. |
| `$7E:1733–173C` | 10 bytes | Extended sprite X position, high byte. |
| `$7E:173D–1746` | 10 bytes | Extended sprite Y speed. |
| `$7E:1747–1750` | 10 bytes | Extended sprite X speed. |
| `$7E:1751–175A` | 10 bytes | Accumulating fraction bits for extended sprite Y position. |
| `$7E:175B–1764` | 10 bytes | Accumulating fraction bits for extended sprite X position. |
| `$7E:1765–176E` | 10 bytes | Miscellaneous extended sprite table. |
| `$7E:176F–1778` | 10 bytes | Miscellaneous extended sprite table (lifespan timer, decrements to zero). |
| `$7E:1779–1782` | 10 bytes | Extended sprite "behind scenery" flag. |

### Minor Extended Sprites (12 slots)

| Address | Size | Description |
|---------|------|-------------|
| `$7E:17F0–17FB` | 12 bytes | Minor extended sprite type number. |
| `$7E:17FC–1807` | 12 bytes | Minor extended sprite Y position, low byte. |
| `$7E:1808–1813` | 12 bytes | Minor extended sprite X position, low byte. |
| `$7E:1814–181F` | 12 bytes | Minor extended sprite Y position, high byte. |
| `$7E:1820–182B` | 12 bytes | Minor extended sprite Y speed. |
| `$7E:182C–1837` | 12 bytes | Minor extended sprite X speed. |
| `$7E:1838–1843` | 12 bytes | Accumulating fraction bits for minor extended sprite Y speed. |
| `$7E:1844–184F` | 12 bytes | Accumulating fraction bits for minor extended sprite X speed. |
| `$7E:1850–185B` | 12 bytes | Miscellaneous minor extended table (often a lifespan timer). |
| `$7E:18EA–18F5` | 12 bytes | Minor extended sprite X position, high byte. |

### Bounce Sprites (4 slots)

| Address | Size | Description |
|---------|------|-------------|
| `$7E:1699–169C` | 4 bytes | Bounce sprite type number. |
| `$7E:16A1–16A4` | 4 bytes | Bounce sprite Y position, low byte. |
| `$7E:16A5–16A8` | 4 bytes | Bounce sprite X position, low byte. |
| `$7E:16A9–16AC` | 4 bytes | Bounce sprite Y position, high byte. |
| `$7E:16AD–16B0` | 4 bytes | Bounce sprite X position, high byte. |
| `$7E:16B1–16B4` | 4 bytes | Bounce sprite Y speed. |
| `$7E:16B5–16B8` | 4 bytes | Bounce sprite X speed. |
| `$7E:16C5–16C8` | 4 bytes | Bounce sprite timer (frames until despawn; turn blocks go spinning when this expires). |

### Cluster Sprites (20 slots)

| Address | Size | Description |
|---------|------|-------------|
| `$7E:1892–18A5` | 20 bytes | Cluster sprite type number. |
| `$7E:1E02–1E15` | 20 bytes | Cluster sprite Y position, low byte. |
| `$7E:1E16–1E29` | 20 bytes | Cluster sprite X position, low byte. |
| `$7E:1E2A–1E3D` | 20 bytes | Cluster sprite Y position, high byte. |
| `$7E:1E3E–1E51` | 20 bytes | Cluster sprite X position, high byte. |
| `$7E:1E52–1E65` | 20 bytes | Cluster sprite Y speed. |
| `$7E:1E66–1E79` | 20 bytes | Cluster sprite X speed. |

### Score / 1-Up Sprites (6 slots)

| Address | Size | Description |
|---------|------|-------------|
| `$7E:16E1–16E6` | 6 bytes | Score / 1-up sprite type number. |
| `$7E:16E7–16EC` | 6 bytes | Score sprite Y position, low byte. |
| `$7E:16ED–16F2` | 6 bytes | Score sprite X position, low byte. |
| `$7E:16F3–16F8` | 6 bytes | Score sprite X position, high byte. |
| `$7E:16F9–16FE` | 6 bytes | Score sprite Y position, high byte. |
| `$7E:16FF–1704` | 6 bytes | Score sprite upward movement timer (max `$30` frames; half speed above `$00`). |

### Shooters (8 slots)

| Address | Size | Description |
|---------|------|-------------|
| `$7E:1783–178A` | 8 bytes | Shooter type. `$00`=none; `$01`=Bullet Bill; `$02`=Torpedo Launcher. |
| `$7E:178B–1792` | 8 bytes | Shooter Y position, low byte. |
| `$7E:1793–179A` | 8 bytes | Shooter Y position, high byte. |
| `$7E:179B–17A2` | 8 bytes | Shooter X position, low byte. |
| `$7E:17A3–17AA` | 8 bytes | Shooter X position, high byte. |
| `$7E:17AB–17B2` | 8 bytes | Shooter fire timer (decrements every 2 frames). |

### Overworld Sprites (16 slots)

| Address | Size | Description |
|---------|------|-------------|
| `$7E:0DE5–0DF4` | 16 bytes | Overworld sprite number. |
| `$7E:0E35–0E44` | 16 bytes | Overworld sprite X position, low byte. |
| `$7E:0E45–0E54` | 16 bytes | Overworld sprite Y position, low byte. |
| `$7E:0E55–0E64` | 16 bytes | Overworld sprite Z position, low byte (distance from ground). |
| `$7E:0E65–0E74` | 16 bytes | Overworld sprite X position, high byte. |
| `$7E:0E75–0E84` | 16 bytes | Overworld sprite Y position, high byte. |
| `$7E:0E85–0E94` | 16 bytes | Overworld sprite Z position, high byte. |
| `$7E:0E95–0EA4` | 16 bytes | Overworld sprite X speed. |
| `$7E:0EA5–0EB4` | 16 bytes | Overworld sprite Y speed. |
| `$7E:0EB5–0EC4` | 16 bytes | Overworld sprite Z speed. |

### Boo Ring Sprites (2 rings)

| Address | Size | Description |
|---------|------|-------------|
| `$7E:0FAE–0FAF` | 2 bytes | Angle low byte (`$0FAE` = ring 1, `$0FAF` = ring 2). |
| `$7E:0FB0–0FB1` | 2 bytes | Angle high byte. |
| `$7E:0FB2–0FB3` | 2 bytes | Ring center X position, low byte. |
| `$7E:0FB4–0FB5` | 2 bytes | Ring center X position, high byte. |
| `$7E:0FB6–0FB7` | 2 bytes | Ring center Y position, low byte. |
| `$7E:0FB8–0FB9` | 2 bytes | Ring center Y position, high byte. |
| `$7E:0FBA–0FBB` | 2 bytes | Offscreen flag for Boo ring. `$01` = offscreen. |

### Pixi Custom Sprite Tables (bank `$7F`)

| Address | Size | Description |
|---------|------|-------------|
| `$7F:AB10–AB1B` | 12 bytes | Extra bits for each sprite slot. |
| `$7F:AB1C–AB27` | 12 bytes | Custom-load signal flag (used during sprite loading for custom generators/shooters). |
| `$7F:AB28–AB33` | 12 bytes | First extra property byte per sprite slot. |
| `$7F:AB34–AB3F` | 12 bytes | Second extra property byte per sprite slot. High 2 bits control Pixi original-code execution. |
| `$7F:AB40–AB4B` | 12 bytes | First extra extension byte per sprite slot. |
| `$7F:AB4C–AB57` | 12 bytes | Second extra extension byte per sprite slot. |
| `$7F:AB58–AB63` | 12 bytes | Third extra extension byte per sprite slot. |
| `$7F:AB64–AB6F` | 12 bytes | Fourth extra extension byte per sprite slot. |
| `$7F:AB9E–ABA9` | 12 bytes | Custom sprite number (from Pixi list.txt). Vanilla sprites mirror `$9E`. |
| `$7F:AF00–AFFF` | 256 bytes | Extended sprite load status table (Pixi). Supports up to 255 sprites per level. |

---

## Level State / Camera

### Level Pointers

| Address | Size | Description |
|---------|------|-------------|
| `$7E:0065–0067` | 3 bytes | 24-bit pointer to layer 1 data (level and overworld). Also used during credits for VRAM line upload tracking. |
| `$7E:0068–006A` | 3 bytes | 24-bit pointer to layer 2 data. |
| `$7E:006B–006D` | 3 bytes | 24-bit pointer to low byte of Map16 block data (used during level load). |
| `$7E:006E–0070` | 3 bytes | 24-bit pointer to high byte of Map16 block data (used during level load). |
| `$7E:00CE–00D0` | 3 bytes | 24-bit pointer to the level's sprite data. |

### Camera / Scrolling

| Address | Size | Description |
|---------|------|-------------|
| `$7E:0045–0046` | 2 bytes | Map16 column/row for VRAM upload when layer 1 scrolls left/up. |
| `$7E:0047–0048` | 2 bytes | Map16 column/row for VRAM upload when layer 1 scrolls right/down. |
| `$7E:0049–004A` | 2 bytes | Map16 column/row for VRAM upload when interactive layer 2 scrolls left/up. |
| `$7E:004B–004C` | 2 bytes | Map16 column/row for VRAM upload when interactive layer 2 scrolls right/down. |
| `$7E:004D–004E` | 2 bytes | Last layer 1 X/Y where VRAM upload occurred, scrolling left/up. Low 4 bits forced to 0. |
| `$7E:004F–0050` | 2 bytes | Last layer 1 X/Y where VRAM upload occurred, scrolling right/down. Low 4 bits forced to 0. |
| `$7E:0051–0052` | 2 bytes | Last interactive layer 2 X/Y where VRAM upload occurred, scrolling left/up. |
| `$7E:0053–0054` | 2 bytes | Last interactive layer 2 X/Y where VRAM upload occurred, scrolling right/down. |
| `$7E:0055` | 1 byte | Scroll direction for layer 1. `$00` = left/up; `$02` = right/down. |
| `$7E:0056` | 1 byte | Scroll direction for layer 2. `$00` = left/up; `$02` = right/down. |
| `$7E:005E` | 1 byte | Level width in screens (horizontal levels). Camera stops scrolling right at this screen number. |
| `$7E:005F` | 1 byte | Level height in screens (vertical levels). Camera stops scrolling down at this screen number. |
| `$7E:1400` | 1 byte | Auto-camera movement control. If set, L/R are ignored and camera moves to the correct player position. |
| `$7E:1411–1412` | 2 bytes | Horizontal/vertical scroll enable flags from level header. `$1411` = horizontal; `$1412` = vertical. `$00` = disable; `$01` = enable. |
| `$7E:1417–1418` | 2 bytes | Base vertical offset of layer 2 from layer 1 (when vertical scrolling is enabled). |
| `$7E:142A–142F` | 6 bytes | Horizontal static camera region settings (size and position of dead zone where player movement doesn't scroll the camera). |

### Layer 2 Scroll Commands

| Address | Size | Description |
|---------|------|-------------|
| `$7E:143E` | 1 byte | Scroll command number for layer 1. Also used in castle cutscenes. |
| `$7E:143F` | 1 byte | Scroll command number for layer 2. Set by scroll sprite init routines. |
| `$7E:1446–1447` | 2 bytes | Layer 1 X speed (scroll code). `$0001–$7FFF` = left; `$8000–$FFFF` = right. |
| `$7E:1448–1449` | 2 bytes | Layer 1 Y speed (scroll code). `$0001–$7FFF` = up; `$8000–$FFFF` = down. |
| `$7E:144A–144B` | 2 bytes | Layer 2 X speed (scroll code). |
| `$7E:144C–144D` | 2 bytes | Layer 2 Y speed (scroll code). |

### Level Header Mirror

| Address | Size | Description |
|---------|------|-------------|
| `$7E:1692` | 1 byte | Sprite memory setting from level header. |
| `$7E:190E` | 1 byte | Sprite buoyancy settings from level header. Bits: `XY-- ----`. `X` = enable buoyancy (reduces max on-screen sprites); `Y` = enable water splash. |

---

## Overworld

| Address | Size | Description |
|---------|------|-------------|
| `$7E:0DD3` | 1 byte | Player direction on overworld. `$00` = up; `$02` = down; `$04` = left; `$06` = right. |
| `$7E:0EF5` | 1 byte | Bits 5–7 track which overworld Koopa Kids have been defeated (pulled Mario into a level that was beaten). |
| `$7E:0EF6` | 1 byte | Which Koopa Kid trigger tile the player is standing on (tiles `$49`, `$4A`, `$4B` → indices 0, 1, 2). Unused in the original game. |
| `$7E:0EF7` | 1 byte | Bit 7 set = auto-enter level the player is standing on. Also used by Koopa Kid and Piranha Plant overworld sprites. |
| `$7E:13C1` | 1 byte | Current layer 1 overworld tile the player is standing on. |
| `$7E:13C3` | 1 byte | Current player submap. `$00`=main; `$01`=Yoshi's Island; `$02`=Vanilla Dome; `$03`=Forest of Illusion; `$04`=Valley of Bowser; `$05`=Special World; `$06`=Star World. |
| `$7E:13D0` | 1 byte | VRAM tile index during castle/switch palace/fortress destruction. `$00`=pressed green switch; `$01`=yellow/red/blue switch; `$02`=destroyed fortress; etc. |
| `$7E:13D1` | 1 byte | Tile value of the castle/fortress/switch that is being destroyed (looked up via event table at `$04E5D6`). |
| `$7E:1B78–1B79` | 2 bytes | Flag for whether a hard-coded overworld path should be processed. `$0000`=no; `$0001`=yes. |
| `$7E:1B7A–1B7B` | 2 bytes | Index into hard-coded tile tables `$049086` and `$0490CA` for current walking tile. |
| `$7E:1B7C` | 1 byte | Accumulating fraction bits for layer 1 X speed (free-scroll camera return). |
| `$7E:1B7D` | 1 byte | Accumulating fraction bits for layer 1 Y speed (free-scroll camera return). |
| `$7E:1B7E` | 1 byte | Mirror of `$13C1`. Used to check for complementary corner path tiles. |
| `$7E:1B80` | 1 byte | Flag: player is moving across a ladder or vine path tile (tiles `$3F–$41`). |
| `$7E:1B82` | 1 byte | X position of current castle/fortress destruction explosion on-screen. Also X of appearing event sprite tiles. |
| `$7E:1B83` | 1 byte | Y position of current castle/fortress destruction explosion on-screen. Also Y of appearing event sprite tiles. |
| `$7E:1B87` | 1 byte | Stage of the save and 2-player life exchange prompts on the overworld. |
| `$7E:1B8D–1B8E` | 2 bytes | X positions for overworld fade in/out windowing HDMA transition. |
| `$7E:1B8F–1B90` | 2 bytes | Y positions for overworld fade in/out windowing HDMA transition. |
| `$7E:1B9C` | 1 byte | Player entering a warp pipe or star flag. `$00`=no; `$01`=yes. |
| `$7E:1BA0` | 1 byte | Ground shake flag for the Valley of Bowser entrance rising event. Set to `$FF` to trigger. Also changes music and adds sound effects. |
| `$7E:1DE8` | 1 byte | Pointer index for submap switching scene routines (`$13D9 = $0A`). |
| `$7E:1DE9` | 1 byte | Non-zero = activate an overworld event on load (otherwise event handling is skipped). |
| `$7E:1DEA` | 1 byte | Overworld event to run at level end. `$FF` = no event. |
| `$7E:1DEB–1DEC` | 2 bytes | Event tile to load to the overworld. Starts at a set value at level end, increments until it reaches `$1DED`. |
| `$7E:1DED–1DEE` | 2 bytes | Last event tile to load during a given overworld event. |
| `$7E:1DF0–1DF1` | 2 bytes | X position of the camera during overworld free-scroll (low/high byte). |
| `$7E:1DF2–1DF3` | 2 bytes | Y position of the camera during overworld free-scroll (low/high byte). |
| `$7E:1DF6` | 1 byte | Star Road / Warp Pipe tile handler index (tile index × 2 → destination coordinates). |
| `$7E:1EA2–1F01` | 96 bytes | Overworld level state flags (1 byte per level). Format: `bmesudlr`. `b`=beaten; `m`=midway passed; `e`=unused (LM uses for event tile). |
| `$7E:1F02–1F10` | 15 bytes | Overworld event flags (bitfield). Each bit = one event; 0=not run, 1=run. |
| `$7E:1F11` | 1 byte | Current submap for Mario. |
| `$7E:1F12` | 1 byte | Current submap for Luigi. |
| `$7E:1F49–1FD5` | 141 bytes | SRAM transfer buffer for `$1EA2–$1F2E`. |

### Overworld Tilemap (bank `$7F`)

| Address | Size | Description |
|---------|------|-------------|
| `$7F:0000–3FFF` | 16384 bytes | Layer 2 overworld event tilemap (YXPCCCTT properties). Space after `$7F:0D00` used by Lunar Magic for expanded area. |
| `$7F:4000–7FFF` | 16384 bytes | Layer 2 tilemap for the whole overworld (including submaps from `$7F:6000`). Two bytes per 8×8 tile (tile number + YXPPCCCT). |

---

## Yoshi

| Address | Size | Description |
|---------|------|-------------|
| `$7E:0DBA` | 1 byte | Mario's Yoshi color. `$04`=yellow; `$06`=blue; `$08`=red; `$0A`=green. |
| `$7E:0DBB` | 1 byte | Luigi's Yoshi color. Same values as `$0DBA`. |
| `$7E:0DC1` | 1 byte | Player can carry Yoshi across levels. `$00`=no; `$01`=yes. |
| `$7E:13C7` | 1 byte | Yoshi color (refreshed on level change). `$04`=yellow; `$06`=blue; `$08`=red; `$0A`=green. |
| `$7E:141E` | 1 byte | Yoshi has wings flag. `$02` = winged Yoshi. `$01` = allows fireballs without fire power. |
| `$7E:187A` | 1 byte | Riding Yoshi flag. `$00`=no; `$01`=yes; `$02`=yes and turning around. |
| `$7E:18AC` | 1 byte | Timer until Yoshi swallows the sprite in his mouth. Decrements every 4th frame. |
| `$7E:18AD` | 1 byte | Yoshi walk frame counter (`$00–$02`). |
| `$7E:18AF` | 1 byte | Yoshi squat timer. Set to `$0C` when player hops on; handles duck frame. |
| `$7E:18B0–18B1` | 2 bytes | Yoshi X position (used for berry detection by walking into one). |
| `$7E:18B2–18B3` | 2 bytes | Yoshi Y position (used for berry detection by walking into one). |
| `$7E:18D4` | 1 byte | Red berries eaten by Yoshi. At 10, Yoshi lays an egg (mushroom). |
| `$7E:18D5` | 1 byte | Pink berries eaten by Yoshi. At 2, Yoshi lays an egg (coin game cloud). |
| `$7E:18D6` | 1 byte | Type of berry being eaten. `$00`=coin; `$01`=red; `$02`=pink; `$03`=green. |
| `$7E:18DA` | 1 byte | Sprite number that spawns when Yoshi lays an egg. `$74`=mushroom; `$6A`=coin game cloud. |
| `$7E:18DC` | 1 byte | Player is ducking with Yoshi flag. Cannot turn around while set. |
| `$7E:18DE` | 1 byte | Egg-laying timer after 10 red berries are eaten. Default `$20`. Player is frozen while above `$01`. |
| `$7E:18DF` | 1 byte | Sprite slot + 1 of the currently active Yoshi, current frame. `$00` = no Yoshi active. |
| `$7E:18E2` | 1 byte | Sprite slot + 1 of the currently active Yoshi, previous frame. Prefer this over `$18DF`. |
| `$7E:18E7` | 1 byte | Yoshi ground stomp flag. `$01` = Yellow Yoshi with a shell stomps on landing. |
| `$7E:18E8` | 1 byte | Yoshi growing animation timer. Starts at `$40`, decrements. Freezes everything except Yoshi. |
| `$7E:191C` | 1 byte | Yoshi has a key in his mouth. `$00`=no; `$01`=yes. |
