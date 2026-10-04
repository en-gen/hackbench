# SMW Translevel -> Level Number Conversion

`CODE_05D8A2` (SMWDisX bank_05.asm:7216-7226) builds a slot number from two
independent gates.

## Formula

```
low  = translevel >= biasThreshold ? (translevel - bias) & $FF : translevel   # bank_05.asm:7217-7220
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

## Overworld roots

The roots are exactly the slots the translevel walk (CODE_04D7F2,
bank_04.asm:5295-5309) produces, per buffer half. They are a set, not a
range: a gap in a hack's numbering is not a root, and neither is slot $000,
which vanilla's walk never produces because its numbering starts at 1. $000
and $100 are the Bonus Games room, and $0C8 and $1C8 the Yoshi Heaven sub
areas; `src/rom/BonusEntrances.ts` reads those from `CODE_05DBAC`.

The low-byte subtract is 8-bit: when the bias exceeds the threshold, a
translevel from the threshold up to bias - 1 lands on $100 + translevel - bias,
at the top of its half. A set holds those slots as they are.

## Exit graph: the reaching flag

No slot's resolved screen exits depend on which flag reached it (static
argument, not measured on a corpus; #451). Roots are excluded from
`validDestinations`, so each root resolves once under its seeded flag, on
the Lunar Magic hook path too. A non-root is `(flag ? screenHigh : 0) << 8
| destLow`: with screenHigh 1 its bit 8 IS its flag; with screenHigh 0
(stock or hook) both flags resolve identically; readSubmapHigh refuses 2
or more. The BFS's real job is a reachability gate: an orphaned map's
data for its screen exits never contributes an edge, and a map never reached
gets no resolved screen exits.

The hook is Lunar Magic's replacement of the stock `BEQ` that picks the
entry high byte from `OWPlayerSubmap` (stock BEQ at bank_05.asm:7224,
opened via smw-mcp `get_lines`; the `$05D8B1` address is from CLAUDE.md,
not re-derived here). Whether a ROM carries the hook is decided by
`src/rom/SubmapFlagGate.ts` (`LM_ENTRY_SITE`, `LM_ENTRY_HOOK`), which is
the authority for the hook claim, not any ASM line.

## Implementation

`isOverworldLevel(index, roots)` in `src/rom/SmwRom.ts`, with `roots` from
`deriveOverworldEntrances(rom).roots`. That is `null` when the entry
code, the walk or its call are not stock, and `null` names no root: there is
no fallback to the vanilla slots.
