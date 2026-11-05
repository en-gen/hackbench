Proposed 2026-11-05 (Charlie)

# Line-guided picks read drawnParts after #840

## Question

#840 narrowed `PassResult.parts` to the writes made under the sprite's own slot and put every other tile write of a plain run in `PassResult.companions`; `drawnParts` is the two together. #987 (line-guided sprites, $62-$68) landed on develop reading `.parts` in four places that decide whether a pass draws or where a sprite shows. Which does the merged code read?

## Options considered

A. Swap the four reads to `drawnParts` and change nothing else in #987's code: the pass-after-the-line pick (`online + 1`), the pass-2 pick of the line-step rule, the "drew no OAM tile" test, and `startsBehind` (the first drawing pass and its extent).
B. Leave #987's code verbatim and read `.parts`.
C. Hold the merge for the line-guided owner to say.

## Ruling

wording not recorded. 2026-11-05: option A was taken by the lead on Overwatch's word, as [PROP], to unblock the merge of #1087; it is not ruled. [INF]

## Why

- `parts` used to be every tile write of the pass. After #840 it is the sprite's own writes, so a read of `parts` in #987's code would see less than it was written against. In a plain run, `drawnParts` (parts plus companions) is exactly the old set, so A keeps #987's behavior there. [EST: plain-run own plus companion equals the old `touched` set by construction, `SpriteRunner.ts` Machine hook]
- In a neighbor run `companions` is empty, so A and B read the same.
- B would let a line-guided sprite whose draw is made under another slot read as "drew nothing" or pick the wrong pass, while the map view still drew the picture.
- C costs a merge conflict that grows with every develop commit; A changes four `.parts` reads and no condition or branch.

## Applies to

`src/rom/sprites/interp/SpriteRunner.ts`: the `online` branch, the pass-2 pick, the `drew no OAM tile` test, `startsBehind`. Not `LineGuided*.ts`, the $62-$68 drawing, or the Properties-pane line-guided frames. Promotion to Ruled is the owner's.
