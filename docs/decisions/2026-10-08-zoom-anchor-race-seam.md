Ruled 2026-10-08 (Brian)

## Question

Issue #547 asks that each of four planted zoom-anchor defects turn a test red. Plant 2 (the `renderedZoom` guard in `afterCommit`, `theia/extension/src/browser/map-view-widget.tsx`) cannot be driven by UI input. Do seam-driven tests satisfy the issue, or is that half shelved as unreachable?

## Options considered

- 1A: drive both plants through an in-page seam (call `afterCommit` or dispatch a scroll in the same `page.evaluate` as the click).
- 2A: rule the seam unreachable, keep the guard with an evidence-scoped comment, accept three of four plants red, close #548 on its 13 clean runs.
- Plants 3 and 4 need no decision: both are already red on `test/suite/unit/ZoomController.test.ts` (1 failed / 64 passed each, adversarial review). `[EST]`

## Ruling

2A, as listed above.

## Why

- A stale-zoom commit needs a time-sliced render, which this widget never triggers; two clicks before a commit batch into one commit at the newer zoom. Scheduling probe: 99 of 100 trials, shelved branch `feature/issue-547-zoom-anchor-race` at 4c203811, React 19.3, Lumino 2.0.5, one machine. `[EST]`
- A test that calls the guard through a seam would pass for a state real input cannot produce. `[INF]` from the probe above.
- Plant 1 is reachable: a screen reply is a microtask, so a held reply released in the same task as the click runs before the React commit. The test in `theia/browser-app/test/map-view.spec.cjs` asserts that precondition itself (committed zoom still the old one, replies consumed, controller at the new zoom). Red 3 of 3 runs with `restoreAnchor` added to `sync`, green 3 of 3 without, one machine. `[EST]`

## Applies to

- Plant 2 has no test. The guard stays, with the comment at `afterCommit` pointing here.
- Re-open if the widget starts using transitions or other time-sliced renders. `[OPEN]`
