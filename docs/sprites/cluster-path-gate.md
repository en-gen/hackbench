# Cluster call-path gate

`src/rom/sprites/interp/ClusterPath.ts` checks the call path from a level's sprite list to a cluster
spawn and to its draw by RUNNING THE ROM'S OWN CODE on the core (D126, FINGERPRINT MINIMUM rule 3: no
code bytes, no digest under 24 unknown bytes). Shared by the castle flames ($E6, #894) and the
rotating ring ($E2/$E3, #983).

## Stages

Each runs over three WRAM states and ends at a named address:

- The loader route (CODE_02A8C0, bank_02.asm:5348-5355), entered with the sprite id in A, a stream
  offset in Y, must reach the spawn dispatcher (CODE_02AAC0, :5631-5641) with `_3` set and the id in
  A; the dispatcher must reach the spawn with the activate flag stored (run with the cell preset to 0
  and to $FF, so only a store makes it 1); the spawn must return into the route, which must hand back
  to LoadNextSprite (:5267) with the stack, X and Y as it found them. X and Y are swept (0, a low
  value, $80 and up) so a branch on a register flag is taken both ways. Every id of the cart is run.
- The cluster loop (CODE_02F808, :15942-15958), entered with DB and X wrong and every slot holding the
  type, must draw each of the 20 slots once, in order up or down, with DB = 2, X = the slot and
  CurSpriteProcess = the slot; after each draw the draw's RTS is carried out, so the loop's own return
  path runs, and the loop must return with DB and the stack restored.
- The same loop with no cluster sprite must draw nothing and return.

## Checks

- Every instruction fetch between an entry and its target must lie in `ClusterLayout`'s spans (the
  route, the dispatcher, the spawn, the loop, the dispatch block and ExecutePtr). A fetch anywhere else
  is a hook or a wrapper: the stage is flagged and the address named. A hacked path is not followed
  past its first foreign fetch.
- Branch check: every conditional branch of the route, dispatcher and loop must fall through into a
  span and go to a span or an `exits` address (taken or not, so a branch to foreign code is flagged
  without a seed; this check uses none).
- WRAM writes are limited to the stack, the hand-off cell _3, the activate flag, CurSpriteProcess and
  ExecutePtr's scratch (the spawn's own writes are not limited: they are its job).
- A seeded fill (D126, fourth exception) catches a stray effect. It covers $0000-$1FFF; cells above are
  zero. A seed catches a dependence on game state only on a cell the seeds differ on: a threshold
  compare on a cell above $1FFF, or one all seeds hold alike, passes.

## GAP, stated and not closed

The callers of these fixed entries are not run. The long call to the loop (bank_01.asm:130) and the
$E7 threshold before the route (bank_02.asm:5290) are reached only by entering at the routine, so a
hack that blanks that call or lowers that threshold is not seen here; reaching them would mean running
the sprite-list loader and the main sprite loop on seeded level data (D178, same on develop).

## Evidence scope

Vanilla USA ROM, one machine, 2026-11-03; the three corpus hacks that hook the loop are pinned in
`ClusterPathGate.corpus.test.ts`.
