# SMW ROM Memory Map

Verified addresses for Super Mario World (SNES, USA release).
All addresses are SNES LoROM 24-bit unless noted otherwise.
All multi-byte values are little-endian.

Sources: SMW Central memory map, smwspeedruns.com/Level_Data_Format,
sneslab.net/wiki/SMW_level_data_format, datacrystal.tcrf.net

---

## Addressing

LoROM formula: `fileOffset = (bank & 0x7F) * 0x8000 + (addr - 0x8000)`
- Banks $00–$3F, addr $8000–$FFFF → ROM
- Banks $40–$6F, addr $0000–$FFFF → ROM extended
- Banks $70–$7D → SRAM (not in file)
- Banks $7E–$7F → WRAM (not in file)
- Banks $80–$FF → mirrors of $00–$7F
- Copier header: 512 bytes prepended to some ROM dumps (`fileSize % 1024 === 512`)

---

## ROM Header

| Address   | Size | Description |
|-----------|------|-------------|
| `$00FFC0` | 21 B | Internal ROM name (ASCII, space-padded) - `"SUPER MARIOWORLD"` |
| `$00FFD5` | 1 B  | ROM speed/map mode (`$20` = LoROM, `$30` = LoROM fast) |
| `$00FFD7` | 1 B  | ROM size byte (`n` → `1 << n` KB) |
| `$00FFD8` | 1 B  | SRAM size byte |

---

## Level Data

### Level Pointer Tables

512 levels indexed $000–$1FF. L1 and L2 use **interleaved 3-byte entries**
`(lo, hi, bank)` at `base + i*3`. The sprite table uses **2-byte entries**
`(lo, hi)` at `base + i*2` - all sprite data is in bank $07 (implicit).

| Address   | Size    | Stride | Description |
|-----------|---------|--------|-------------|
| `$05E000` | 1536 B  | 3      | L1 object pointer table - `(lo, hi, bank)` per level |
| `$05E600` | 1536 B  | 3      | L2 object pointer table - `(lo, hi, bank)` per level |
| `$05EC00` | 1024 B  | 2      | Sprite pointer table - `(lo, hi)` per level; bank = $07 implicit |

**L1/L2 reconstruction:** `ptr = (bank << 16) | (hi << 8) | lo`
where bytes are at `base + i*3`, `base + i*3 + 1`, `base + i*3 + 2`.

**Sprite reconstruction:** `ptr = $070000 | (hi << 8) | lo`
where bytes are at `base + i*2`, `base + i*2 + 1`.

**bank = $FF** in L2 pointer → preset background level (BG2 placed by 65816
subroutine at `$0D0000 | (hi<<8) | lo`; cannot be decoded without CPU emulation).

### Level Primary Entrance / Settings Tables

One byte per level, 512 entries each.

| Address   | Size   | Byte format  | Description |
|-----------|--------|--------------|-------------|
| `$05F000` | 512 B  | `ssssyyyy`   | L2 scroll settings [7:4], primary entrance Y position [3:0] |
| `$05F200` | 512 B  | `ttaaaxxx`   | L3 BG type [7:6], Mario start action [5:3], initial X position [2:0] |
| `$05F400` | 512 B  | `mmmmffbb`   | Midway entrance screen [7:4], FG initial scroll pos [3:2], BG initial scroll pos [1:0] |
| `$05F600` | 512 B  | `iuveeeee`   | Disable No-Yoshi-Intro flag [7], unknown V-pos flag [6], vertical level flag [5], primary entrance screen# [4:0] |

### Secondary Entrance Tables

One byte per secondary entrance (pipes, doors, midpoints), 512 entries each.

⚠ As of Lunar Magic v2.50, these tables may be dynamically relocated to
accommodate expanded secondary exit counts. Use the pointer at the given address
to find the current location:
- `$05F800` pointer: `read3($0DE191)` → relocated destination level lo-byte table
- `$05FA00` pointer: `read3($0DE198)` → relocated Y/screen table
- `$05FC00` pointer: `read3($0DE19F)` → relocated X/screen table
- `$05FE00` pointer: `read3($05DC81)` → relocated flags table

| Address   | Size   | Byte format  | Description |
|-----------|--------|--------------|-------------|
| `$05F800` | 512 B  | lo byte      | Destination level - low byte of level number |
| `$05FA00` | 512 B  | `bbffyyyy`   | BG initial pos [7:6], FG initial pos [5:4], Mario Y pos [3:0] (index into table at $05D730/$05D740) |
| `$05FC00` | 512 B  | `xxxeeeee`   | Mario X pos [7:5] (index into table at $05D750/$05D758), destination screen# [4:0] |
| `$05FE00` | 512 B  | `s???hAAA`   | Slippery flag [7], dest level high bit [3], Mario start action [2:0] |

Destination level = `(($05FE00[n] >> 3) & 1) << 8 | $05F800[n]`

### Level Primary Header (5 bytes at L1 pointer)

Object data begins at byte offset 5.

| Byte | Bits | Field            | Notes |
|------|------|------------------|-------|
| 0    | 7–5  | BG palette row   | 3-bit variant selector for CGRAM rows 0–1 |
| 0    | 4–0  | Level length     | Screen count = value + 1 |
| 1    | 7–5  | BG color         | 3-bit back-area color index |
| 1    | 4–0  | Level mode       | determines layer layout (0=horizontal, etc.) |
| 2    | 7    | Layer 3 priority | |
| 2    | 6–4  | Music index      | 3-bit |
| 2    | 3–0  | (mode ext)       | Level mode low bits |
| 3    | 7–6  | Time limit       | 00=unlimited |
| 3    | 5–4  | Sprite palette   | 2-bit CGRAM row 4–8 variant |
| 3    | 3–0  | Sprite set       | 4-bit GFX sprite file set index |
| 4    | 7–6  | Item memory      | |
| 4    | 5–4  | Vertical scroll  | |
| 4    | 3–0  | BG type ID       | 4-bit background type; NOT the GFX tileset index |

### Level Object Format

**Standard (2 bytes)** - when byte0 high nibble ≤ $C (yNibble 0–12):
```
byte0: YYYY XXXX   (Y nibble 0–12 = tile row × 2; X = local col in screen)
byte1: PPPP OOOO   (P = param/size nibble; O = object type nibble)
```
Absolute X = `screen * 16 + (byte0 & 0xF)`  
Absolute Y = `(byte0 >> 4) * 2`  (Y nibble 0 → row 0, nibble 12 → row 24)

**Extended (3 bytes)** - when byte0 high nibble ≥ $D (yNibble $D–$F):
```
byte0: ???? XXXX
byte1: 00YY YYYY   (Y = tile row, 6-bit, used directly - no ×2)
byte2: NNNNNNNN   (extended object number)
```
Object type = `0x100 + byte2`

**Screen advance:** `$FF $FF` - increments screen counter  
**Terminator:** lone `$FF`

---

## Level Data Blobs (Banks $06–$07)

The actual binary level data lives in ROM banks $06 and $07.
Use the pointer tables at $05E000 / $05E600 / $05EC00 to locate specific levels -
the addresses below are fixed in vanilla SMW but move in hacked/LM-edited ROMs.

### Object Data - Bank $06 ($068000–$06FFFF)

| Address   | Size   | Contents |
|-----------|--------|----------|
| `$068000` | 99 B   | Level 012, 019, 01E, 025–092, 09C–0BC, 10C, 112, 124, 129, 12E–12F, 131, 133, 137–192, 19C–1BA |
| `$068063` | 90 B   | *Unused*: Ride Among the Clouds |
| `$0680BD` | 123 B  | *Unused*: Mushroom Scales |
| `$068138` | 282 B  | *Unused*: Boss Test |
| `$068252` | 6 B    | Level 09B, 19B |
| `$068258` | 6 B    | Level 095, 098–09A, 195, 198–19A |
| `$06825E` | 6 B    | Level 096, 097, 196, 197 |
| `$068264` | 135 B  | *Unused*: Lava Cave (Layer 2) |
| `$0682EB` | 177 B  | *Unused*: Lava Cave |
| `$06839C` | 15 B   | *Unused*: Twin Blocks |
| `$0683AB` | 342 B  | *Unused*: Beta level 01A |
| `$068501` | 60 B   | *Unused*: Beta level 01A (Layer 2) |
| `$06853D` | 36 B   | *Unused*: Pipe 'n' Ground |
| `$068561` | 42 B   | Level 093, 194 |
| `$06858B` | 42 B   | Level 094, 193 |
| `$0685B5` | 78 B   | Level 0C7 |
| `$068603` | 24 B   | Level 0C5 |
| `$06861B` | 6 B    | Level 0C4, 0EB, 0F0, 0FB, 1DA, 1E6, 1E7, 1F9 (Layer 2) |
| `$068621` | 21 B   | Level 0EB, 0F0, 0FB, 1DA, 1E7, 1F9 |
| `$068636` | 6 B    | Level 0CC, 0D5, 0D9, 0DF, 0E2, 0E5, 1DE |
| `$06863C` | 24 B   | Level 0FF |
| `$068654` | 33 B   | Level 000, 100 |
| `$068675` | 18 B   | *Unused*: Ghost House Exit |
| `$068687` | 6 B    | Level 1EB, 1F6 |
| `$06868D` | 67 B   | Level 014 |
| `$0686D0` | 91 B   | Level 11B |
| `$06872B` | 67 B   | Level 121 |
| `$06876E` | 64 B   | Level 008 |
| `$0687AE` | 69 B   | Level 0CA |
| `$0687F3` | 69 B   | Level 1D8 |
| `$068838` | 69 B   | Level 1D7 |
| `$06887D` | 66 B   | Level 0C9 |
| `$0688BF` | 30 B   | Level 003 |
| `$0688DD` | 283 B  | Level 105 |
| `$0689F8` | 55 B   | Level 1CB |
| `$068A2F` | 388 B  | Level 106 |
| `$068BB3` | 43 B   | Level 1CA |
| `$068BDE` | 655 B  | Level 103 |
| `$068E6D` | 64 B   | Level 1FD |
| `$068EAD` | 230 B  | Level 102 |
| `$068F93` | 30 B   | Level 1FF |
| `$068FB1` | 76 B   | Level 1BE |
| `$068FFD` | 370 B  | Level 101 |
| `$06916F` | 118 B  | Level 1FC |
| `$0691E5` | 503 B  | Level 015–017 |
| `$0693DC` | 151 B  | Level 0FD |
| `$069473` | 250 B  | Level 0E3 |
| `$06956D` | 192 B  | Level 009 (Layer 2) |
| `$06962D` | 353 B  | Level 009 |
| `$06978E` | 121 B  | Level 0E9 |
| `$069807` | 116 B  | Level 004 |
| `$06987B` | 34 B   | Level 0FA |
| `$06989D` | 83 B   | Level 0DE, 0F9 |
| `$0698F0` | 95 B   | Level 0FE |
| `$06994F` | 18 B   | Level 0C4 |
| `$069961` | 445 B  | Level 005 |
| `$069B1E` | 151 B  | Level 0F4 |
| `$069BB5` | 407 B  | Level 006 |
| `$069D4C` | 55 B   | Level 0D2 |
| `$069D83` | 61 B   | Level 0C3 |
| `$069DC0` | 110 B  | Level 007 |
| `$069E2E` | 145 B  | Level 0E8 |
| `$069EBF` | 165 B  | Level 0E7 (Layer 2) |
| `$069F64` | 313 B  | Level 0E7 |
| `$06A09D` | 151 B  | Level 0E6 |
| `$06A134` | 316 B  | Level 00A |
| `$06A270` | 130 B  | Level 0C2 |
| `$06A2F2` | 130 B  | Level 013, 0EC, 0EE |
| `$06A374` | 172 B  | Level 0ED, 0F2 |
| `$06A420` | 47 B   | Level 0F1 |
| `$06A44F` | 18 B   | Level 0E4 |
| `$06A461` | 268 B  | Level 10B |
| `$06A56D` | 76 B   | Level 1C6 |
| `$06A5B9` | 71 B   | *Unused data* |
| `$06A600` | 745 B  | Level 11A |
| `$06A8E9` | 85 B   | Level 1EF |
| `$06A93E` | 33 B   | Level 1EF (Layer 2) |
| `$06A95F` | 841 B  | Level 118 |
| `$06ACA8` | 97 B   | Level 1C3 |
| `$06AD09` | 271 B  | Level 107, 1FB |
| `$06AE18` | 101 B  | Level 1EA |
| `$06AE7D` | 824 B  | Level 10A |
| `$06B1B5` | 133 B  | Level 1C2 |
| `$06B23A` | 151 B  | Level 1F7 |
| `$06B2D1` | 337 B  | Level 119 |
| `$06B422` | 190 B  | Level 1F5 |
| `$06B4E0` | 320 B  | Level 11C |
| `$06B620` | 70 B   | Level 1F4 |
| `$06B666` | 229 B  | Level 1F3 |
| `$06B74B` | 162 B  | Level 1F3 (Layer 2) |
| `$06B7ED` | 42 B   | Level 1F2 |
| `$06B817` | 495 B  | Level 109 |
| `$06BA06` | 45 B   | Level 1F1 |
| `$06BA33` | 54 B   | Level 1F0 |
| `$06BA69` | 352 B  | Level 001 |
| `$06BBC9` | 106 B  | Level 0D8 |
| `$06BC33` | 187 B  | Level 002 |
| `$06BCEE` | 33 B   | Level 0CB |
| `$06BD0F` | 167 B  | Level 00B |
| `$06BDB6` | 247 B  | Level 0E0, 0E1 |
| `$06BEAD` | 748 B  | Level 00F |
| `$06C199` | 43 B   | Level 0BF |
| `$06C1C4` | 433 B  | Level 010 |
| `$06C375` | 46 B   | Level 0C1 |
| `$06C3A3` | 203 B  | Level 00E |
| `$06C46E` | 39 B   | Level 00E (Layer 2) |
| `$06C495` | 127 B  | Level 0DC |
| `$06C514` | 69 B   | Level 0DC (Layer 2) |
| `$06C559` | 403 B  | Level 0DB |
| `$06C6EC` | 151 B  | Level 0DA |
| `$06C783` | 454 B  | Level 011 |
| `$06C949` | 27 B   | Level 0C6 |
| `$06C964` | 1692 B | *Empty* (filled with $FF) |
| `$06D000` | 220 B  | Level 00C |
| `$06D0DC` | 24 B   | Level 0F3 |
| `$06D0F4` | 226 B  | Level 00D |
| `$06D1D6` | 100 B  | Level 0DD |
| `$06D23A` | 465 B  | Level 11E |
| `$06D40B` | 744 B  | Level 120 |
| `$06D6F3` | 545 B  | Level 123 |
| `$06D914` | 46 B   | Level 1F8 |
| `$06D942` | 151 B  | Level 1BC |
| `$06D9D9` | 229 B  | Level 020 |
| `$06DABE` | 207 B  | Level 11D, 1E8, 1E9 |
| `$06DB8D` | 837 B  | Level 11D, 1E8, 1E9 (Layer 2) |
| `$06DED2` | 116 B  | Level 1FA |
| `$06DF46` | 21 B   | Level 1E6 |
| `$06DF5B` | 425 B  | Level 11F |
| `$06E104` | 36 B   | Level 1DF |
| `$06E128` | 91 B   | Level 1C1 |
| `$06E183` | 135 B  | Level 122 |
| `$06E20A` | 253 B  | Level 01F |
| `$06E307` | 317 B  | Level 0D6 |
| `$06E444` | 396 B  | Level 022, 0D0, 0D1 |
| `$06E5D0` | 414 B  | Level 0F5, 0F6 |
| `$06E76E` | 52 B   | Level 0BE |
| `$06E7A2` | 115 B  | Level 021 |
| `$06E815` | 130 B  | Level 0FC |
| `$06E897` | 238 B  | Level 024 |
| `$06E985` | 118 B  | Level 0CF |
| `$06E9FB` | 181 B  | Chocolate Island 2 - Level 1 |
| `$06EAB0` | 91 B   | Chocolate Island 2 - Level 2 |
| `$06EB0B` | 103 B  | Level 0CE |
| `$06EB72` | 76 B   | Chocolate Island 2 - Level 3 |
| `$06EBBE` | 102 B  | Chocolate Island 2 - Level 4 |
| `$06EC24` | 90 B   | Level 0CD |
| `$06EC7E` | 75 B   | Chocolate Island 2 - Level 5 |
| `$06ECC9` | 286 B  | Level 023 |
| `$06EDE7` | 79 B   | Level 0D7 |
| `$06EE36` | 199 B  | Level 01B |
| `$06EEFD` | 352 B  | Level 0EF |
| `$06F05D` | 263 B  | Level 117 |
| `$06F164` | 505 B  | Level 1ED |
| `$06F35D` | 205 B  | Level 1EC |
| `$06F42A` | 210 B  | Level 1EC (Layer 2) |
| `$06F4FC` | 21 B   | Level 1EE |
| `$06F511` | 40 B   | Level 1C0 |
| `$06F539` | 2759 B | *Empty* (filled with $FF; used by Lunar Magic for extended data) |

### Object Data - Bank $07 ($078000–$07FFFF)

| Address   | Size   | Contents |
|-----------|--------|----------|
| `$078000` | 24 B   | Ghost house entrance |
| `$078018` | 6 B    | Empty level (header only) - used as L2 when no background needed |
| `$07801E` | 15 B   | Castle entrance 1 |
| `$07802D` | 33 B   | **Level 104** (Yoshi's House) |
| `$07804E` | 18 B   | No Yoshi sign entrance 1 |
| `$078060` | 33 B   | *Unused*: Ghost House Exit |
| `$078081` | 15 B   | *Unused*: Three bushes |
| `$078090` | 15 B   | Castle entrance 2 |
| `$07809F` | 18 B   | No Yoshi sign entrance 2 |
| `$0780B1` | 18 B   | No Yoshi sign entrance 3 |
| `$0780C3` | 42 B   | Level 108 |
| `$078100` | 1204 B | Level 01D |
| `$0785B4` | 303 B  | Level 0EA |
| `$0786E3` | 488 B  | Level 01C |
| `$0788CB` | 106 B  | Level 0C0 |
| `$078935` | 151 B  | Level 0BD |
| `$0789CC` | 337 B  | Level 01A |
| `$078B1D` | 45 B   | Level 01A (Layer 2) |
| `$078B4A` | 109 B  | Level 0D4 |
| `$078BB7` | 51 B   | Level 0D4 (Layer 2) |
| `$078BEA` | 42 B   | Level 0D3 |
| `$078C14` | 178 B  | Level 018 |
| `$078CC6` | 229 B  | Level 0F8 |
| `$078DAB` | 249 B  | Level 0F7 |
| `$078EA4` | 893 B  | Level 116 |
| `$079221` | 18 B   | Level 1E5 |
| `$079233` | 151 B  | Level 1E4 |
| `$0792CA` | 178 B  | Level 115 |
| `$07937C` | 102 B  | Level 115 (Layer 2) |
| `$0793E2` | 451 B  | Level 1E3 |
| `$0795A5` | 75 B   | Level 1E3 (Layer 2) |
| `$0795F0` | 366 B  | Level 1E2 |
| `$07975E` | 30 B   | Level 1E2 (Layer 2) |
| `$07977C` | 135 B  | Level 0C8 |
| `$079803` | 100 B  | Level 114, 1D9 |
| `$079867` | 258 B  | Level 1DD |
| `$079969` | 109 B  | Level 1DB, 1DC |
| `$0799D6` | 235 B  | Level 113 |
| `$079AC1` | 151 B  | Level 1BB |
| `$079B58` | 556 B  | Level 10F |
| `$079D84` | 94 B   | Level 1BF |
| `$079DE2` | 320 B  | Level 110 |
| `$079F22` | 262 B  | Level 1FE |
| `$07A028` | 268 B  | Level 111 |
| `$07A134` | 69 B   | Level 111 (Layer 2) |
| `$07A179` | 1159 B | *Empty* (filled with $FF) |
| `$07A600` | 142 B  | Level 10D |
| `$07A68E` | 121 B  | Level 1D4 |
| `$07A707` | 94 B   | Level 1D3 |
| `$07A765` | 157 B  | Level 1D2 |
| `$07A802` | 61 B   | Level 1D1 |
| `$07A83F` | 154 B  | Level 1D0 |
| `$07A8D9` | 91 B   | Level 1CF |
| `$07A934` | 45 B   | Level 1CF (Layer 2) |
| `$07A961` | 130 B  | Level 1CE |
| `$07A9E3` | 51 B   | Level 1CE (Layer 2) |
| `$07AA16` | 97 B   | Level 1CD |
| `$07AA77` | 82 B   | Level 1CC |
| `$07AAC9` | 304 B  | Level 1BD |
| `$07ABF9` | 310 B  | Level 10E |
| `$07AD2F` | 6 B    | Level 1C7 |
| `$07AD35` | 481 B  | Level 134 |
| `$07AF16` | 15 B   | Level 1D6 |
| `$07AF25` | 169 B  | Level 130 |
| `$07AFCE` | 21 B   | Level 1D5 |
| `$07AFE3` | 78 B   | Level 132 |
| `$07B031` | 243 B  | Level 135 |
| `$07B124` | 327 B  | Level 136 |
| `$07B26B` | 347 B  | Level 12A |
| `$07B3C6` | 168 B  | Level 1C4, 1C5 |
| `$07B46E` | 210 B  | Level 12B |
| `$07B540` | 829 B  | Level 12C |
| `$07B87D` | 25 B   | Level 1C9 |
| `$07B896` | 114 B  | Level 1C8 |
| `$07B908` | 438 B  | Level 12D |
| `$07BABE` | 339 B  | Level 128 |
| `$07BC11` | 356 B  | Level 127 |
| `$07BD75` | 21 B   | Level 1E1 |
| `$07BD8A` | 91 B   | Level 1E0 |
| `$07BDE5` | 384 B  | Level 126 |
| `$07BF65` | 705 B  | Level 125 |
| `$07C226` | 218 B  | *Empty* (filled with $FF) |

### Sprite Data - Bank $07 ($07C300–$07E76F)

| Address   | Size  | Contents |
|-----------|-------|----------|
| `$07C300` | 14 B  | *Unused*: Ride Among the Clouds |
| `$07C30E` | 50 B  | *Unused*: Mushroom Scales |
| `$07C340` | 5 B   | Level 09B, 19B |
| `$07C345` | 5 B   | Level 09A, 19A |
| `$07C34A` | 5 B   | Level 099, 199 |
| `$07C34F` | 5 B   | Level 098, 198 |
| `$07C354` | 5 B   | Level 097, 197 |
| `$07C359` | 14 B  | Level 096, 196 |
| `$07C367` | 14 B  | Level 095, 195 |
| `$07C375` | 38 B  | *Unused*: Lava Cave |
| `$07C39B` | 14 B  | *Unused*: Twin Blocks |
| `$07C3A9` | 50 B  | *Unused*: Beta level 01A |
| `$07C3DB` | 8 B   | Level 093, 194 |
| `$07C3E3` | 11 B  | Level 094, 193 |
| `$07C3EE` | 2 B   | Level 0BD, 0DA, 0E6, 0F4, 0FA, 0FD, 1BB, 1BC, 1C9, 1CB, 1E0, 1E4, 1F4, 1F7 |
| `$07C3F0` | 5 B   | Level 0C6, 0CB, 0F3, 0FF, 1D5, 1D6, 1E1, 1EE |
| `$07C3F5` | 8 B   | Level 0C4, 0F0, 0FB, 1DA, 1E6, 1F9 |
| `$07C3FD` | 5 B   | *Unused*: Goal 1 |
| `$07C402` | 5 B   | *Unused*: Goal 2 |
| `$07C407` | 5 B   | Level 000, 100 |
| `$07C40C` | 8 B   | Level 0EB, 1E7 |
| `$07C414` | 14 B  | Level 0D5, 0DF, 0E2, 1DE |
| `$07C422` | 5 B   | Level 10D, 1D0 |
| `$07C427` | 26 B  | Level 0C7 |
| `$07C441` | 5 B   | Level 0C5 |
| `$07C446` | 5 B   | Level 014 |
| `$07C44B` | 5 B   | Level 0CA |
| `$07C450` | 35 B  | Level 11B |
| `$07C473` | 5 B   | Level 1D8 |
| `$07C478` | 32 B  | Level 121 |
| `$07C498` | 5 B   | Level 1D7 |
| `$07C49D` | 35 B  | Level 008 |
| `$07C4C0` | 5 B   | Level 0C9 |
| `$07C4C5` | 5 B   | Level 003 |
| `$07C4CA` | 104 B | Level 105 |
| `$07C532` | 77 B  | Level 106 |
| `$07C57F` | 20 B  | Level 1CA |
| `$07C593` | 92 B  | Level 103 |
| `$07C5EF` | 5 B   | Level 1FD |
| `$07C5F4` | 101 B | Level 102 |
| `$07C659` | 8 B   | Level 1FF |
| `$07C661` | 14 B  | Level 1BE |
| `$07C66F` | 80 B  | Level 101 |
| `$07C6BF` | 17 B  | Level 1FC |
| `$07C6D0` | 5 B   | Level 1F6 |
| `$07C6D5` | 116 B | Level 015–017 |
| `$07C749` | 8 B   | Level 0E3 |
| `$07C751` | 86 B  | Level 009 |
| `$07C7A7` | 14 B  | Level 0E9 |
| `$07C7B5` | 8 B   | Level 004 |
| `$07C7BD` | 14 B  | Level 0DE, 0F9 |
| `$07C7CB` | 14 B  | Level 0FE |
| `$07C7D9` | 107 B | Level 005 |
| `$07C844` | 137 B | Level 006 |
| `$07C8CD` | 29 B  | Level 0D2 |
| `$07C8EA` | 26 B  | Level 0C3 |
| `$07C904` | 17 B  | Level 007 |
| `$07C915` | 17 B  | Level 0E8 |
| `$07C926` | 29 B  | Level 0E7 |
| `$07C943` | 5 B   | Level 0E5 |
| `$07C948` | 98 B  | Level 00A |
| `$07C9AA` | 32 B  | Level 0C2 |
| `$07C9CA` | 17 B  | Level 013, 0EC, 0EE |
| `$07C9DB` | 23 B  | Level 0ED, 0F2 |
| `$07C9F2` | 26 B  | Level 0F1 |
| `$07CA0C` | 11 B  | Level 0E4 |
| `$07CA17` | 86 B  | Level 10B |
| `$07CA6D` | 26 B  | Level 1C6 |
| `$07CA87` | 122 B | Level 11A |
| `$07CB01` | 41 B  | Level 1EF |
| `$07CB2A` | 155 B | Level 118 |
| `$07CBC5` | 23 B  | Level 1C3 |
| `$07CBDC` | 53 B  | Level 107, 1FB |
| `$07CC11` | 20 B  | Level 1EA |
| `$07CC25` | 149 B | Level 10A |
| `$07CCBA` | 26 B  | Level 1C2 |
| `$07CCD4` | 143 B | Level 119 |
| `$07CD63` | 5 B   | Level 1F5 |
| `$07CD68` | 44 B  | Level 11C |
| `$07CD94` | 44 B  | Level 1F3 |
| `$07CDC0` | 8 B   | Level 1F2 |
| `$07CDC8` | 68 B  | Level 109 |
| `$07CE0C` | 8 B   | Level 1F1 |
| `$07CE14` | 8 B   | Level 1F0 |
| `$07CE1C` | 158 B | Level 001 |
| `$07CEBA` | 5 B   | Level 0D8 |
| `$07CEBF` | 71 B  | Level 002 |
| `$07CF06` | 71 B  | Level 00B |
| `$07CF4D` | 98 B  | Level 0E0, 0E1 |
| `$07CFAF` | 128 B | Level 00F |
| `$07D02F` | 20 B  | Level 0BF |
| `$07D043` | 140 B | Level 010 |
| `$07D0CF` | 8 B   | Level 0C1 |
| `$07D0D7` | 29 B  | Level 00E |
| `$07D0F4` | 29 B  | Level 0DC |
| `$07D111` | 65 B  | Level 0DB |
| `$07D152` | 5 B   | Level 0D9 |
| `$07D157` | 158 B | Level 011 |
| `$07D1F5` | 101 B | Level 00C |
| `$07D25A` | 170 B | Level 00D |
| `$07D304` | 8 B   | Level 0DD |
| `$07D30C` | 116 B | Level 11E |
| `$07D380` | 197 B | Level 120 |
| `$07D445` | 128 B | Level 123 |
| `$07D4C5` | 8 B   | Level 1F8 |
| `$07D4CD` | 80 B  | Level 020 |
| `$07D51D` | 5 B   | Level 0CC |
| `$07D522` | 74 B  | Level 11D, 1E8, 1E9 |
| `$07D56C` | 11 B  | Level 1FA |
| `$07D577` | 80 B  | Level 11F |
| `$07D5C7` | 8 B   | Level 1DF |
| `$07D5CF` | 38 B  | Level 1C1 |
| `$07D5F5` | 83 B  | Level 122 |
| `$07D648` | 32 B  | Level 01F |
| `$07D668` | 113 B | Level 0D6 |
| `$07D6D9` | 104 B | Level 022, 0D0, 0D1, 0F5, 0F6 |
| `$07D741` | 11 B  | Level 0BE |
| `$07D74C` | 77 B  | Level 021 |
| `$07D799` | 38 B  | Level 0FC |
| `$07D7BF` | 38 B  | Level 024 |
| `$07D7E5` | 5 B   | Level 0CF |
| `$07D7EA` | 59 B  | Chocolate Island 2 (Sprites) |
| `$07D825` | 38 B  | Chocolate Island 2 (Sprites) |
| `$07D84B` | 35 B  | Level 0CE |
| `$07D86E` | 26 B  | Chocolate Island 2 (Sprites) |
| `$07D888` | 17 B  | Chocolate Island 2 (Sprites) |
| `$07D899` | 8 B   | Level 0CD |
| `$07D8A1` | 29 B  | Chocolate Island 2 (Sprites) |
| `$07D8BE` | 152 B | Level 023 |
| `$07D956` | 8 B   | Level 0D7 |
| `$07D95E` | 83 B  | Level 01B |
| `$07D9B1` | 62 B  | Level 0EF |
| `$07D9EF` | 35 B  | Level 117 |
| `$07DA12` | 50 B  | Level 1ED |
| `$07DA44` | 59 B  | Level 1EC |
| `$07DA7F` | 20 B  | Level 1C0 |
| `$07DA93` | 74 B  | Level 01D |
| `$07DADD` | 50 B  | Level 0EA |
| `$07DB0F` | 134 B | Level 01C |
| `$07DB95` | 38 B  | Level 0C0 |
| `$07DBBB` | 62 B  | Level 01A |
| `$07DBF9` | 41 B  | Level 0D4 |
| `$07DC22` | 11 B  | Level 0D3 |
| `$07DC2D` | 14 B  | Level 018 |
| `$07DC3B` | 38 B  | Level 0F8 |
| `$07DC61` | 179 B | Level 0F7 |
| `$07DD14` | 98 B  | Level 116 |
| `$07DD76` | 5 B   | Level 1E5 |
| `$07DD7B` | 56 B  | Level 115 |
| `$07DDB3` | 5 B   | Level 1E3 |
| `$07DDB8` | 23 B  | Level 1E2 |
| `$07DDCF` | 50 B  | Level 0C8 |
| `$07DE01` | 14 B  | Level 114, 1D9 |
| `$07DE0F` | 44 B  | Level 1DD |
| `$07DE3B` | 20 B  | Level 1DB, 1DC |
| `$07DE4F` | 185 B | Level 113 |
| `$07DF08` | 140 B | Level 10F |
| `$07DF94` | 29 B  | Level 1BF |
| `$07DFB1` | 47 B  | Level 110 |
| `$07DFE0` | 68 B  | Level 1FE |
| `$07E024` | 14 B  | Level 1EB |
| `$07E032` | 53 B  | Level 111 |
| `$07E067` | 38 B  | Level 1D4 |
| `$07E08D` | 56 B  | Level 1D3 |
| `$07E0C5` | 35 B  | Level 1D2 |
| `$07E0E8` | 44 B  | Level 1D1 |
| `$07E114` | 29 B  | Level 1CF |
| `$07E131` | 47 B  | Level 1CE |
| `$07E160` | 35 B  | Level 1CD |
| `$07E183` | 26 B  | Level 1CC |
| `$07E19D` | 35 B  | Level 10E, 1BD |
| `$07E1C0` | 5 B   | Level 1C7 |
| `$07E1C5` | 92 B  | Level 134 |
| `$07E221` | 125 B | Level 130 |
| `$07E29E` | 17 B  | Level 132 |
| `$07E2AF` | 134 B | Level 135 |
| `$07E335` | 167 B | Level 136 |
| `$07E3DC` | 38 B  | Level 12A |
| `$07E402` | 38 B  | Level 1C4, 1C5 |
| `$07E428` | 62 B  | Level 12B |
| `$07E466` | 134 B | Level 12C |
| `$07E4EC` | 5 B   | Level 1C8 |
| `$07E4F1` | 131 B | Level 12D |
| `$07E574` | 107 B | Level 128 |
| `$07E5DF` | 113 B | Level 127 |
| `$07E650` | 164 B | Level 126 |
| `$07E6F4` | 101 B | Level 125 |
| `$07E759` | 20 B  | **Level 104** (Yoshi's House) |
| `$07E76D` | 2 B   | Level 012, 019, 01E, 025–092, 09C–0BC, 10C, 112, 124, 129, 12E–12F, 131, 133, 137–192, 19C–1BA |

---

## Color Palettes

### BGR555 Format

All SNES palette colors are 16-bit little-endian BGR555:
```
bit 15:     unused (0)
bits 14–10: Blue  (5-bit, 0–31)
bits 9–5:   Green (5-bit, 0–31)
bits 4–0:   Red   (5-bit, 0–31)
```
Convert to 8-bit RGB: `R = (v & 0x1F) << 3`, `G = ((v>>5) & 0x1F) << 3`, `B = ((v>>10) & 0x1F) << 3`

### Hardcoded Palette ROM Addresses

Each entry is **24 bytes = 12 colors** covering CGRAM indices 1–12.
CGRAM index 0 of every row is transparent.

| Address    | CGRAM Row | Label          | Description |
|------------|-----------|----------------|-------------|
| `$00B0A0`  | -         | Back area color | 2 bytes only, single BGR555 word |
| `$00B0B0`  | 0         | BG Palette 0   | Background tiles |
| `$00B0C8`  | 1         | BG Palette 1   | Background tiles (alt) |
| `$00B190`  | 2         | FG Palette 0   | Foreground/hills/clouds |
| `$00B1A8`  | 3         | FG Palette 1   | Foreground (alt) |
| `$00B318`  | 14 ($E)   | Sprite Palette E | Shared sprite colors |
| `$00B330`  | 15 ($F)   | Sprite Palette F | Shared sprite colors |

### Runtime Palette Rows (NOT in fixed ROM locations)

Rows 4–13 are assembled at runtime from tileset-specific tables:
- **Rows 4–12:** Sprite palettes loaded from tileset table
- **Row 13:** Mario's palette - RAM pointer at `$7E:0D82`
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

Indexed by: sprite set from header byte 3 bits 3–0, tileset ID from `$05D760[spriteSet]`.

### VRAM Layout (⚠ needs verification)

VRAM char number ranges per slot (approximate - not yet verified against SMW's level init code):

| Slot | Chars       | Palette rows | Notes |
|------|-------------|--------------|-------|
| FG1  | $000–$03F   | 0–3          | Foreground tileset |
| FG2  | $040–$07F   | 0–3          | Foreground tileset |
| FG3  | $080–$0BF   | 0–3          | Foreground tileset |
| SP1  | $100–$13F   | 8–15         | Sprite graphics |
| SP2  | $140–$17F   | 8–15         | Sprite graphics |
| SP3  | $180–$1BF   | 8–15         | Sprite graphics |
| SP4  | $1C0–$1FF   | 8–15         | Sprite graphics |

---

## Map16 Tiles

| Address    | Description |
|------------|-------------|
| `$0D8000`  | Map16 page 0 - tiles $000–$0FF (8 bytes each) |
| `$0DC000`  | Map16 page 1 - tiles $100–$1FF (8 bytes each) |

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

### Level Exit Tables ($049964–$049A0D, 170 bytes total)

These three tables together describe every exit point on the overworld map -
which tile Mario stands on when leaving a level, and where he ends up after.
This is the link between "a level's exit" and "which overworld tile Mario walks
to next."

> **WRAM note:** SNES Work RAM lives at `$7E0000–$7FFFFF`. Addresses `$0000–$1FFF`
> in any bank mirror to WRAM `$7E0000–$7E1FFF`. SMW Central annotations like
> `($1F19)` are WRAM runtime addresses - they tell you *which RAM location the
> overworld code writes the table value into*, not ROM addresses. Useful as
> Mesen watchpoints; not part of the ROM table layout.

If no entry matches the tile Mario is on, he is not moved and tries to exit again.

#### $049964–$0499A9 - Exit Source Positions (14 entries × 5 bytes)

Where each exit *originates* - the overworld tile Mario is standing on when
he clears a level and triggers a path exit.

| Offset | Size | Field   | Description |
|--------|------|---------|-------------|
| +0     | 2 B  | Y pos   | Y tile position of the exit trigger (written to WRAM $1F19) |
| +2     | 2 B  | X pos   | X tile position of the exit trigger (written to WRAM $1F21) |
| +4     | 1 B  | Submap  | Overworld submap index - 0=Yoshi's Island, 1=Donut Plains, … (written to WRAM $13C3) |

#### $0499AA–$0499EF - Exit Destination Positions (14 entries × 5 bytes)

Where each exit *leads* - the overworld tile Mario ends up on after the path
animation plays. Same 5-byte format as the source table.

| Offset | Size | Field   | Description |
|--------|------|---------|-------------|
| +0     | 2 B  | Y pos   | Target Y tile position (written to WRAM $1F19) |
| +2     | 2 B  | X pos   | Target X tile position (written to WRAM $1F21) |
| +4     | 1 B  | Submap  | Target submap index (written to WRAM $13C3) |

#### $0499F0–$049A0D - Exit High Position Adjustments (15 entries × 2 bytes)

Fine-grained position correction for the destination tile; applied on top of
the destination entry from the table above.

| Offset | Size | Field       | Description |
|--------|------|-------------|-------------|
| +0     | 1 B  | Y high ÷ 16 | High byte of Y position divided by 16 (written to WRAM $1F1D) |
| +1     | 1 B  | X high ÷ 16 | High byte of X position divided by 16 (written to WRAM $1F1F) |

### Translevel Table

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
