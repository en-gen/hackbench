Ruled 2026-10-05 (Brian)

## Question

How does the Maps "show surfaces / show walls" overlay derive collision?

## Options considered

The hand-ported classifier; running SMW block code on the 65816 core per Map16 tile.

## Ruling

Owner choice 2026-10-05, wording not recorded. The core probe, composed node-side as polylines and drawn as SVG. `[INF]`

## Why

- Hacks with patched block code come out right. `[EST]`
- Hack support is deferred to a later milestone (2026-10-05): the spec targets vanilla and the probe's dependence on the vanilla-only level loader is acceptable. Not a blocker. `[EST]`

## Applies to

- Spike kept as reference in `spikes/collision-probe/` (`--rom <path>`).
- Agents run on Sonnet; the owner pre-approved Opus escalation if an agent struggles or turns in poor work on this feature. Escalate without asking, then tell the owner. `[EST]`
