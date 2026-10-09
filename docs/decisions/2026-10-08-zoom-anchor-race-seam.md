Ruled 2026-10-08 (Brian)

## Question

Issue #547 asks that each of four planted zoom-anchor defects turn a test red. Plant 2 (the `renderedZoom` guard in `afterCommit`, `theia/extension/src/browser/map-view-widget.tsx`) cannot be driven by UI input `[INF]` (scheduling probe, see Why). Do seam-driven tests satisfy the issue, or is that half shelved as unreachable?

## Options considered

- 1A: drive both plants through an in-page seam (call `afterCommit` or dispatch a scroll in the same `page.evaluate` as the click).
- 2A: rule the seam unreachable, keep the guard with an evidence-scoped comment, accept three of four plants red, close #548 on its 13 clean runs.
- Plants 3 and 4 need no decision: both are already red on `test/suite/unit/ZoomController.test.ts` (1 failed / 64 passed each, adversarial review). `[EST]`

## Ruling

Owner wording, verbatim: "2A". Paraphrase, kept separate: the option listed above as 2A. `[EST]`

## Why

- A stale-zoom commit needs a time-sliced render, which this widget never triggers; two clicks before a commit batch into one commit at the newer zoom. `[INF]` from the mechanism: Lumino 2.0.5 runs its message loop in a microtask (`theia/node_modules/@lumino/messaging/dist/index.js:141-147`, `Promise.resolve().then`), so `onUpdateRequest` calls `render()` with the latest zoom before React's commit task.
- Probe: about 99 of 100 trials, a scroll in the same task as the click failed its own precondition; shelved branch `feature/issue-547-zoom-anchor-race` at 4c203811, React 19.3, Lumino 2.0.5, one machine. This is the failure rate of that test, not a count of stale-zoom commits. `[EST]`
- A test that calls the guard through a seam would pass for a state real input cannot produce. `[INF]` from the probe above.
- Plant 1 is reachable: a screen reply is a microtask, so a held reply released in the same task as the click runs before the React commit. The test in `theia/browser-app/test/map-view.spec.cjs` asserts that precondition itself (committed zoom still the old one, replies consumed, controller at the new zoom). With `restoreAnchor` added to `sync`: red 10 of 10 runs, each on the drift assert (662 content px on $105, 260.66 on $109). Without it: green 20 of 20 (`--repeat-each 10`). One machine. An earlier 3-run plant batch had one precondition flake (pending replies not yet parked), since fixed. `[EST]`

## Applies to

- Plant 2 has no test. The guard stays, with the comment at `afterCommit` pointing here.
- #548 (gfx flake) was closed on its 13 clean runs; its close comment points here.
- Re-open if the widget starts using transitions or other time-sliced renders. `[OPEN]`
