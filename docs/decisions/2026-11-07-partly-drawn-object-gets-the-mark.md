Proposed 2026-11-07 (quebec, #1034)

# A partly drawn object also gets the "!" mark

## Question

An object whose tiles land partly outside the map's tile space draws the tiles that fit. Does it also get the "!" mark with the off-buffer reason, or only an object with no tile drawn?

## Options considered

A. Mark it. The object keeps its drawn tiles and gets the mark and the reason "Some of its tiles land outside the map's tile space, so they are not drawn."
B. Mark only an object with no tile drawn.

## Ruling

wording not recorded. Option A was taken as [PROP] on Overwatch's word, 2026-11-07, for owner review. Not ruled.

A second [PROP], 2026-11-07, on Overwatch's word: #1034 is accepted at 84 of 80 source lines (4 over: two reviewer-found fixes), the mark-text `PLAIN_REASONS` fix and the wrapped read fix (`peekTile`). Splitting them would have meant a deferred CodeRabbit thread, which blocks approval. Not ruled.

## Why

1. #1034 acceptance 1 allows the mark.
2. D52: nothing is lost without a sign. Under option B the lost tiles of a partly drawn object would vanish silently.
3. #969 defined the mark for an object not drawn at all, so a partly drawn object is a case it did not cover.

## Applies to

`refuseOffBuffer` in `src/rom/objectHandlers/cursor.ts` and its interpreter-path call in `interpretedDraw.ts` (#1034). No vanilla map is marked: none writes outside the buffer.
