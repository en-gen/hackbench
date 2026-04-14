# SMW Overworld WRAM Tables

## Overworld Tilemap (runtime, decompressed from ROM)

| WRAM Address        | Size   | Contents                              |
|---------------------|--------|---------------------------------------|
| `$7EC800–$7ECFFF`   | 2048 B | Layer 1 tilemap (visual tile IDs)     |
| `$7ED000–$7ED7FF`   | 2048 B | Translevel number per tile            |
| `$7ED800–$7EDFFF`   | 2048 B | Path direction settings per tile      |

### Tile Index Formula

```
X_tile = pixel_X / 16
Y_tile = pixel_Y / 16
index  = %-----SYX_yyyyxxxx
```

Where S = submap flag (`$7E:1F11` != 0).

## Overworld Player State

| WRAM Address | Size | Contents                           |
|--------------|------|------------------------------------|
| `$7E:1F11`   | 1 B  | Current submap (Mario): 0=Main, 1=YI, 2=VD, 3=FoI, 4=VoB, 5=Special, 6=Star |
| `$7E:1F12`   | 1 B  | Current submap (Luigi)             |
| `$7E:1F1F`   | 1 B  | Mario overworld X position / 16   |
| `$7E:1F21`   | 1 B  | Mario overworld Y position / 16   |
| `$7E:13BF`   | 1 B  | Translevel number (set on level entry) |
| `$7E:13C1`   | 1 B  | Current Layer 1 tile under player  |

## Level Flags Table

`$7E:1EA2–$7E:1F01` — 96 bytes, indexed **directly by translevel** (0x00–0x5F).

| Bit | Mask | Meaning              |
|-----|------|----------------------|
| 0   | $01  | Normal exit beaten   |
| 1   | $02  | Secret exit beaten   |
| 6   | $40  | Midway point reached |
| 7   | $80  | Level beaten         |

## Known Level Room Numbers

| Level Name       | Room # | Translevel | Submap         |
|------------------|--------|------------|----------------|
| Yoshi's Island 1 | $105   | $29        | Yoshi's Island |

Formula: `room = (translevel > $24) ? translevel + $DC : translevel`
