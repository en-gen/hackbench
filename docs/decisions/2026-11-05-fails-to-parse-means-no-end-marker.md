Proposed 2026-11-05 (Kilo Team, #949)

# A slot fails to parse when its stream has no end marker

## Question

D155 says a valid pointer whose data fails to parse stays a map with a warning. What counts as failing to parse?

## Options considered

- A. The 8 KB read cap the exit graph uses. Rejected: it gives false warnings on working hack maps (Grand Poo World 2 five slots, Invictus two, Kaizo two, zero on vanilla), because a stream can run past 8 KB (one ends at offset 10131) and custom objects desync a stock walk.
- B. Walk to the file end. Rejected: about 250 ms per padding slot, and one test file went from 11.9 s to 295 s.
- C. A stock-size walk with no end marker within 128 KB (`STREAM_WALK_WINDOW`) or before the file ends. Chosen.
- D. Hack-specific object sizes. Rejected: hack compatibility is out of scope here.

## Ruling

`[PROP]` Not ruled by the owner. State C. The parent ruling is D155 A.

## Why

Evidence scope: 0 warning rows on 7 corpus ROMs, one machine; 3.6 ms per padding-slot walk on a loaded machine.

Limit: this proves the data ends, not that it parses. A walk desynced by custom objects can hit an end marker by chance, so a hack's fault can be hidden. Slots that parse but the renderer refuses keep their plain reply when opened. The exit graph keeps its 8 KB cap; a stream ending between 8 KB and 128 KB gets the connections note instead.

## Applies to

- `src/rom/SmwRom.ts` `isLevelStreamTerminated`
- `src/rom/MapTree.ts`
- `docs/glossary.md`
