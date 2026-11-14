Proposed 2026-11-14 (delta, #1231, #1176)

# The wording for a moved sprite whose first moments could not be worked out

## Question

A moved sprite is checked for "never appears in play" (D156, `startsBehind`). When no verdict comes back, the unverified line must say why. The loader case already has its words ("the map's sprite loader is not the stock one"). A spawn run that was refused (a step budget, a table past its end) needs its own, and the loader words would be wrong for it.

## Options considered

1. Reuse the loader line: wrong reason, tells the owner to look at the loader.
2. A second plain line for the refused case, no hex, routine names or issue numbers, not the internal refusal text.

## Ruling

wording not recorded. Option 2, proposed string: "its first moments on screen could not be worked out, so it is drawn where its start-up code leaves it".

## Why

- It states what the owner sees (the sprite is drawn at its start-up position) and that the first-moments check gave no answer, without internal terms.
- The internal refusal text stays out of the Properties panel; it is for the developer.
- May be reworded by #1388 when the unverified lines are worded together.

## Applies to

`UNCHECKED_REFUSED` in `theia/extension/src/node/map-sprites.ts`; `SpriteModel.spawnUnchecked` (`'loader' | 'refused'`) in `src/rom/sprites/interp/SpriteRunner.ts`.
