# SMW Translevel -> Level Number Conversion

`CODE_05D8A2` (SMWDisX bank_05.asm:7216-7226) builds a slot number from two
independent gates.

## Formula

```
low  = translevel >= biasThreshold ? translevel - bias : translevel   # bank_05.asm:7217-7220
high = OWPlayerSubmap != 0 ? 1 : 0                                    # bank_05.asm:7223-7226
slot = (high << 8) | low
```

The high byte comes from the player's submap, never from the translevel. A
translevel at or above the threshold on the main map is still biased and
still lands in $000-$0FF. `biasThreshold` and `bias` ($25 and $24 on
vanilla) are read from the `CMP`/`SBC` operands
(`src/rom/OverworldEntrances.ts`).

Statically, the submap flag is the buffer half a launch tile sits in:
`CODE_05D83E` adds $400 to the `OWLayer1Translevel` index when
`OWPlayerSubmap` is non-zero (bank_05.asm:7205-7212).

## Overworld-accessible ranges

Read from the slots the translevel walk (CODE_04D7F2, bank_04.asm:5295-5309)
actually produces, per buffer half:

- **Main map: $000 to the highest main-half slot**
- **Submaps: the lowest to the highest sub-half slot**; empty when no
  sub-half tile carries a translevel

On vanilla these are $000-$024 and $101-$138 (one ROM, measured). No compare
in `CODE_05D8A2` caps the submap range, so the data is the only bound.

## Implementation

`isOverworldLevel(index, bounds)` in `src/rom/SmwRom.ts`, with `bounds` from
`deriveOverworldEntrances(rom).levelBounds`. That is `null` when the entry
code, the walk or its call are not stock, and `null` names no root: there is
no fallback to the vanilla ranges.
