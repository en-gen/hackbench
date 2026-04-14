# SMW Translevel → Level Number Conversion

Source: `$7E:13BF` description in `docs/memory-map.html`

## Formula

```
if translevel <= $24:
    level_number = translevel          # main overworld
else:
    level_number = translevel + $DC    # submaps ($25→$101, $5F→$13B)
```

## Overworld-Accessible Pointer Table Ranges

- **$000–$024** — Main overworld (37 slots)
- **$101–$13B** — Submaps (59 slots)
- **Total: 96** overworld-accessible level slots

## NOT Overworld-Accessible

- **$025–$0FF** — Secondary exits (pipes, doors, subareas, bonus rooms)
- **$13C–$1FF** — More secondary exits and unused slots

## Implementation

```typescript
// src/rom/SmwRom.ts
export function isOverworldLevel(index: number): boolean {
  return (index >= 0x000 && index <= 0x024) || (index >= 0x101 && index <= 0x13B)
}
```
