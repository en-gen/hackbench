# SMW Overworld Level Mapping

## Translevel Number System

SMW uses a **translevel number** (0x00–0x5F, 96 values) to identify overworld-accessible levels.
The translevel is stored at WRAM `$7E:13BF` when entering a level from the overworld.

### Conversion: Translevel → Lunar Magic Room Number (= L1 Pointer Table Index)

| Translevel Range | Map Area     | Pointer Table Index | Count |
|------------------|-------------|---------------------|-------|
| $00–$24          | Main map    | $000–$024           | 37    |
| $25–$5F          | Submaps     | $101–$13B           | 59    |
| **Total**        |             |                     | **96**|

**Formula** (from memory-map.html, `$7E:13BF` description):
- If translevel <= $24: `room = translevel` (direct 1:1)
- If translevel > $24: `room = translevel + $DC`  (i.e., $25 → $101, $5F → $13B)

The simplified formula `+$DC` comes from `$100 - $24 = $DC`. The detailed formula is:
1. If translevel > $24, subtract $24
2. Check `$7E:1F11`/`$7E:1F12` - if on a submap, add $100
3. Submaps always use translevels > $24, so the net effect is `+$DC`

### Level Pointer Table Ranges

| Index Range   | Purpose                                    |
|---------------|---------------------------------------------|
| $000–$024     | Main overworld levels (directly accessible) |
| $025–$0FF     | Secondary exits (doors, pipes, subareas, bonus games) - NOT overworld-accessible |
| $100          | Often unused or special                     |
| $101–$13B     | Submap levels (Yoshi's Island, Donut Plains, etc.) - directly accessible |
| $13C–$1FF     | More secondary exits, unused slots          |

### Overworld Flag Table

WRAM `$7E:1EA2` - 96 bytes, one per translevel (0x00–0x5F).

| Bit | Mask | Meaning |
|-----|------|---------|
| 0   | $01  | Normal exit beaten |
| 1   | $02  | Secret exit beaten |
| 6   | $40  | Midway point reached |
| 7   | $80  | Level beaten (general) |
| 2–5 |      | Path direction flags |

Initial values from ROM at `$009EE0` as 2-byte pairs `[translevel, flags_to_set]`.

### Midpoint Entrances

Midpoints do NOT use separate level pointer slots ($100+). They use the
**secondary entrance tables** at `$05F800`–`$05FE00`:

| ROM Address | Contents                     |
|-------------|------------------------------|
| $05F800     | (implied by level ID)        |
| $05FA00     | Destination level number lo  |
| $05FC00     | Destination screen/X pos     |
| $05FE00     | Action flags + level num hi  |

Each table has 512 one-byte entries. No L1 pointer sharing between $0xx and $1xx.

## Key ROM Addresses

| Address       | Description                                             |
|---------------|---------------------------------------------------------|
| $05:E000      | L1 pointer table - lo bytes (512 entries)               |
| $05:E200      | L1 pointer table - hi bytes                             |
| $05:E400      | L1 pointer table - bank bytes                           |
| $05:E600      | L2 pointer table - lo/hi/bank (512 entries)             |
| $05:EC00      | Sprite pointer table - lo bytes                         |
| $05:EE00      | Sprite pointer table - hi bytes                         |
| $05:F000      | Sprite pointer table - bank bytes                       |
| $05:D760      | GFX tileset ID lookup: `[spriteSet] → tilesetId`       |
| $04:9964      | Exit path entry locations (5 bytes/entry)               |
| $04:99AA      | Exit path exit destinations (5 bytes/entry)             |
| $04:99F0      | Exit path tile positions (2 bytes/entry)                |
| $04:D678      | Exit directions table (96 bytes, by translevel)         |
| $05:D608      | Event associations table (by translevel)                |
| $00:9EE0      | Initial level flags for $1EA2 ([translevel, flags] pairs) |
