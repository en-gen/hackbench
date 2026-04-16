# SMW Object Format — Research Findings

## Key Discovery: ALL Standard Objects Are 3 Bytes

**The current `LevelParser.ts` is WRONG.** It uses a mixed 2/3-byte format, but testing
against level $104 (Yoshi's House) proves ALL objects are 3 bytes:

```
Byte 0: NYYY XXXX
  N    = New screen flag (bit 7)
  YYY  = Y position (bits 6-4), range 0-12
  XXXX = X position (bits 3-0), range 0-15

Byte 1: SSSS SSSS
  Settings byte (object-specific — encodes size, sub-type, or position data)

Byte 2: OOOO OOOO
  Object number ($00-$FF)
```

**Proof:** Level $104 raw object data (after 5-byte header):
```
0e 00 85 | 78 00 2f | 10 02 1d | 10 06 1d | 10 0b 1d | 
11 03 1d | 11 09 1d | 11 0d 1d | 12 07 1d | ff (terminator)
```
3-byte parsing gives 9 objects + clean $FF terminator.
2-byte parsing produces 45 garbled objects that parse past the terminator.

## Object Number Encoding

Object number in byte 2 is a direct index into a per-tileset dispatch table.
The settings byte (byte 1) provides object-specific parameters (width, height, sub-type).

## ROM Dispatch Tables

### Normal Object Table (Tileset 0/7/C)
- **Address:** `$0DA455`
- **Size:** 189 bytes = 63 entries × 3-byte pointers
- **Objects:** $01–$3F (object $00 = "all extended objects")
- **Bank:** All handlers in bank $0D

Key handlers for level $104:
- Objects $01–$0E → `$0DA8C3` (shared ground/terrain handler)
- Object $1D → `$0DB461` (unique — fence/tree structure?)
- Object $2F → `$0DB3E3` (shared generic tilemap placement)

### Extended Object Table
- **Address:** `$0DA10F`
- **Size:** 768 bytes = 256 entries × 3-byte pointers
- **Objects:** $00–$FF extended object numbers
- **Notable:** ExtObj $02-$0F and $98-$FF are unused ($000000)

## Object Numbers > $3F

Object $85 in level $104 is above the $01–$3F range. This means:
- Either byte 2 encodes BOTH the object number and additional settings
- Or objects > $3F use a separate dispatch mechanism
- Needs investigation: is $85 split as high nibble=8 (tileset sub-group?) + low nibble=5 (sub-object)?

## Level $104 Object Analysis

| Raw Bytes | Y | X | Settings | ObjNum | Meaning |
|-----------|---|---|----------|--------|---------|
| `0e 00 85` | 0 | 14 | $00 | $85 | Unknown (> $3F, needs investigation) |
| `78 00 2f` | 7 | 8 | $00 | $2F | Generic tilemap placement |
| `10 02 1d` | 1 | 0 | $02 | $1D | Fence/tree at settings=$02 |
| `10 06 1d` | 1 | 0 | $06 | $1D | Same object, settings=$06 |
| `10 0b 1d` | 1 | 0 | $0B | $1D | Same object, settings=$0B |
| `11 03 1d` | 1 | 1 | $03 | $1D | Same at X=1 |
| `11 09 1d` | 1 | 1 | $09 | $1D | Same at X=1 |
| `11 0d 1d` | 1 | 1 | $0D | $1D | Same at X=1 |
| `12 07 1d` | 1 | 2 | $07 | $1D | Same at X=2 |

## Next Steps

1. **Fix `LevelParser.ts`** — change to 3-byte format for ALL objects
2. **Disassemble handler at `$0DB461`** (object $1D) to see what Map16 tiles it places
3. **Disassemble handler at `$0DA8C3`** (objects $01–$0E) for ground/terrain
4. **Investigate objects > $3F** — how $85 is dispatched
5. **Rewrite `ObjectExpander.ts`** to use ROM dispatch tables instead of hardcoded guesses
