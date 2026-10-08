# Performance gates - design

Status: approved direction (owner, 2026-09-28). Owner delegated the remaining
design decisions to the orchestrator.

## Goal

Performance becomes a validation gate agents can rely on. A benchmark run
every other night compares develop's head against the last commit that
passed. A confirmed, significant regression files one issue in
`en-gen/hackbench`, and a local agent session picks it up the next morning,
bisects it, and fixes it through the normal PR rules.

Not a per-PR gate. Not a trend dashboard (results are stored so one can be
built later).

## Decisions

| Question | Decision |
|---|---|
| Runner | GitHub-hosted `ubuntu-latest`, baseline and candidate PAIRED in one job |
| Cadence | Every other night; skipped when develop has not moved since the last run |
| Coverage v1 | Core microbenchmarks, app feature timings, startup and heap |
| Detection | Paired ratio, bootstrap confidence interval, one confirmation pass |
| Fixer | Local scheduled Claude session on the owner's machine |
| Fixer autonomy | Fix + PR under normal merge rules; an intended cost is proposed as a rebaseline, never "fixed" |
| Emulator framerate | Out of scope v1 (the emulator-view spec already guards it) |

## 1. Result format

Every suite writes one JSON file, and nothing downstream knows which tool
produced it:

```json
{
  "schema": 1,
  "sha": "<commit>",
  "suite": "core" | "app",
  "harness": "<sha256>",
  "results": [
    { "id": "core.lclz2.decompress.synthetic-64k", "unit": "ms", "better": "lower",
      "samples": [1.21, 1.19, 1.20] }
  ]
}
```

- `id` is stable and dotted: `<family>.<area>.<case>`. Families: `core`,
  `app`, `startup`, `heap`.
- `unit` is `ms` or `bytes/cycle`. `better` is always `lower` in v1.
- `samples` are per-iteration values after warm-up is discarded, produced by
  a bounded batched sampler rather than a fixed wall-clock time budget (see
  section 2's Core sampler note) - a fixed number of samples every time, so
  a result file's size never depends on how fast the measured code happens
  to be.
- `harness` (design D1) is `computeHarness()`'s sha256 of the benchmark code
  that produced this doc, over the files enumerated by `HARNESS_PATHS` in
  `tools/perf/results.mjs`. `compare.mjs` exits 2 when the two sides'
  harness hashes differ.
- Writer and reader live in `tools/perf/results.mjs`, with a schema check
  that rejects an empty `results` array, a result with no samples, a missing
  `harness`, or a non-positive `ms` sample. A suite that measured nothing
  must fail, never report green.

## 2. Suites

### Core (`test/perf/core/*.bench.ts`)

Vitest 5.0.2 (the version this repo installs) dropped the old top-level
`bench()`/`describe` benchmarking API this section originally assumed, in
favour of an in-test `bench` fixture backed by a pluggable provider. Rather
than adopt that provider abstraction, `test/perf/support/perfCase.ts` is a
small hand-rolled batched sampler: `perfCase(id, fn)` registers `id` with
`it.skipIf(!shouldRun(id))`, so an id excluded by `HB_PERF_ONLY` shows up as
skipped rather than silently absent. When it runs, it calibrates a batch
size (quadrupling until one batch clears 1 ms), discards 3 warmup batches, then
records exactly 20 timed batches divided by the batch size - a fixed sample
count regardless of how fast the case is, which also sidesteps tinybench's
own time-budget mode: it ran several of this suite's sub-millisecond cases
into millions of iterations, large enough that `JSON.stringify` on the
retained samples threw "Invalid string length" (measured while building
this suite). Separate config `vitest.perf.config.ts` so `test:unit` never
runs benchmarks; its `testTimeout` is 10 minutes (design D4) so a
catastrophic regression measures as a slow, honest sample instead of
erroring out as a vitest timeout.

- Synthetic cases build their input in the file (content rule: no ROM bytes
  in the repo) and run anywhere, including hackbench CI.
- Corpus cases use `test/suite/support/corpus.ts` and gate with
  `describe.skipIf(!hasRom(...))`, never by looping over a corpus listing.
- v1 set, 12 synthetic cases plus one corpus-gated case: LC_LZ2 decompress
  (4k/64k), 4bpp tile decode (tile/sheet), palette load, level parse +
  object expand for a small and a large map, working copy build with 10 and
  100 layers, IPS export, and a corpus-gated ROM load.

### App (`theia/browser-app/perf/*.perf.cjs`)

Playwright against `build:browser`, a separate `playwright.perf.config.cjs`
so the e2e run never collects these.

- Timings come from marks the APP emits, not from `waitForSelector` around
  it. `theia/extension/src/common/perf-marks.ts` exposes
  `perfStart(name)` / `perfEnd(name)`, backed by `performance.mark` and
  `performance.measure` with a `hb:` prefix. Widgets place `perfEnd` where
  the work is actually done (canvas drawn, not widget attached). A spec
  reads `performance.getEntriesByType('measure')` via `page.evaluate`.
- v1 cases: open project, open Maps / Map16 / Palette / GFX views, apply one
  edit, undo it. `app.open-maps` is cold only because the spec creates a new
  project per sample: in the current backend a new manifest gets a new
  `WorkingRom`, whose bytes array is a distinct object, and `L1ModelCache`
  keys on that identity, so it misses. A cache keyed on content would make
  this case warm without any test failing. It ends at the first screen
  drawn; it is the "draw one map" case. `startup.shell` runs first on its
  own server.
- Marks are keyed by name and valid for single-view specs only. Moving a
  mark's call site changes what is measured without changing the harness
  hash. The check is manual and explicit: before bisecting an app, startup
  or heap regression, the fixing agent runs
  `git log --oneline <base>..<cand> -G 'perf(Start|End|EndAfterPaint)\(' -- theia/extension/src`
  The output is candidates only. The agent inspects each listed commit's
  marker and its consumer, and names a commit as a moved boundary only when
  it changes the affected benchmark's own mark (same name as the id's
  measure), stating that scope in the issue comment. A moved boundary is a
  measurement change, not a regression.
- `startup.*`: fresh server and page per round, time from navigation to the
  shell's `hb:shell-ready` mark.
- `heap.*`: open and close a view 20 times, forced GC through CDP
  `HeapProfiler.collectGarbage` before each `Runtime.getHeapUsage`, and
  report the least-squares slope in bytes per cycle. One heap number is
  too noisy to gate on; a slope is not.
- Electron startup is out of scope v1 (the suite drives the browser build).

## 3. Paired runner (`tools/perf/paired.mjs`)

```
node tools/perf/paired.mjs --base <dir> --cand <dir> --suite core
     [--rounds N] [--only id,id] [--plant <id>=<factor>] --out <file>
```

- `<dir>` is a built checkout. The runner runs base and cand ABBA (design
  D3: `base, cand, cand, base` in blocks of two rounds, rather than strict
  alternation) for N rounds (minimum 5, design D2; default core 10, app 6
  once PR 2 wires the app suite), running the suite's command in each dir,
  and collects each round's result file. Rounds are still paired by index
  regardless of execution order - ABBA just cancels a linear drift (the
  machine warming up, thermal throttling) across the run instead of biasing
  one side.
- Design D1: before any round runs, the candidate's harness files (those
  enumerated by `HARNESS_PATHS` in `tools/perf/results.mjs`) are overlaid
  onto the base directory, and restored afterwards, so base and cand always
  measure with the SAME benchmark code. Without this, a renamed or newly
  added case compares against stale harness code on one side, or simply
  does not exist there - the exact hole a rename or a bisect that predates
  the harness itself would fall into.
- `--only` limits to named ids; the confirmation pass and bisect use it.
- The same tool runs in CI and locally, so a bisect measures exactly what
  the nightly measured. Only the `core` suite is wired in PR 1; `app` lands
  in PR 2.

## 4. Detector (`tools/perf/compare.mjs`)

Per result id:

1. Round value = median of that round's samples.
2. Pair ratio `r_i = cand_i / base_i` for each round.
3. Estimate = median of `r_i`; 95% interval by bootstrap over the pairs,
   2000 resamples (minimum 1000, `--resamples` validated), seeded PRNG
   (`--seed`, a finite integer) so the verdict is reproducible from the
   file.
4. REGRESSION when the interval's lower bound exceeds `1 + threshold`.
   Thresholds by family: `core` 0.10, `app` 0.15, `startup` 0.15. A family
   outside this set is refused (`Object.hasOwn`, never a silent default),
   as is a unit that does not match its family (`heap` must be
   `bytes/cycle`, everything else `ms`).
   `heap` uses differences, not ratios, because a slope near zero makes a
   ratio meaningless: `d_i = cand_i - base_i`, bootstrap the median of
   `d_i`, and regress when the lower bound exceeds
   `max(0.25 * |median(base)|, 64 KiB)` per cycle.
5. IMPROVEMENT is the mirror, reported but never actioned.
6. An id present on one side only is reported as `added` / `removed`, not
   compared. `removed` still fails the run (design D1): a benchmark that
   vanished needs the owner's acknowledgement the same way a regression
   does; `added` stays informational.
7. Design D2: fewer than 5 paired rounds for an id, or base and cand
   holding unequal round counts, is malformed input (exit 2) - the
   bootstrap needs a real sample to resample from. So is a harness hash
   (design D1) that differs between base and cand.

Output: a JSON verdict and a Markdown table (id, base median, cand median,
ratio, interval, verdict). Exit 0 clean, 1 regression or an unacknowledged
removal, 2 malformed input.

Confirmation: the workflow re-runs the paired runner with `--only` on every
flagged id; an issue is filed only for ids that regress in BOTH passes.

## Design decisions D1-D5 (adversarial review, PR 1)

Settled during PR 1's review; the substance is woven into sections 1-4 and
7 above, this is the index.

| # | Decision |
|---|---|
| D1 | Harness parity: `paired.mjs` overlays the candidate's harness files (those enumerated by `HARNESS_PATHS` in `tools/perf/results.mjs`) onto the base directory before running it (restored after), and every result doc carries a `harness` sha256 (section 1) that `compare.mjs` exits 2 on a mismatch. Closes the hole where a renamed or newly added case would compare against stale code, or a bisect would predate the benchmark harness itself. `removed` (section 4, point 6) exits 1, needing the owner's acceptance the same as a regression. |
| D2 | A minimum of 5 paired rounds per id, and equal round counts between base and cand, or `compare.mjs` exits 2 (section 4, point 7). `--resamples` validated as an integer >= 1000, `--seed` as a finite integer. `bisect.mjs`'s default round count is likewise >= 5. |
| D3 | `paired.mjs` runs base and cand ABBA (`base, cand, cand, base` per block of two rounds) instead of strict alternation, cancelling a linear drift across the run; pairing stays by round index regardless of execution order. |
| D4 | `vitest.perf.config.ts`'s `testTimeout` is 10 minutes, so a catastrophic regression measures as an honest (if very slow) sample instead of erroring out as a vitest timeout that the pipeline could mistake for a build failure. |
| D5 | `bisect.mjs` worktrees default to `<parent-of-repo>/.worktrees/hackbench/perf-bisect-<id>-<good7>` (CLAUDE.md's placement convention) and are removed in a finally. Builds with `npm ci`; on Windows spawns `npm.cmd`. The `git bisect run` step is this file's own `--step` mode, not a generated source string - `exitCodeForStep` is a plain, directly-tested function (0 good, 1 bad, else skip). |

## 5. Nightly workflow (`en-gen/hackbench-validation`, `perf-nightly.yml`)

- `cron: '0 9 */2 * *'`, plus `workflow_dispatch` with inputs
  `hackbench_ref`, `base_ref` and `plant`.
- Gate job: skip when develop's head already carries a `perf-nightly`
  status. Base = newest develop commit with a `perf-nightly` success status
  in the last 100. None found: an A/A run (head against itself) only when no
  `perf-nightly` status of any state exists in that window (bootstrap);
  otherwise the run fails closed ("base out of window") until the owner
  runs `accept.sh`.
- A separate job pulls the ROM with `RCLONE_CONF` and hands it over as a
  one-day artifact, so the secret never shares a job with hackbench code.
- Checks out hackbench at base and at candidate into two dirs, installs and
  builds both. The app suite runs only when both sides have it.
- A run that fails before a verdict posts `failure` on `perf-nightly-infra`,
  never on `perf-nightly`, so one broken night cannot move or block the
  base; the next scheduled run retries the same head.
- Runs core then app through `paired.mjs`, then `compare.mjs`, then the
  confirmation pass.
- Reports into hackbench with `HACKBENCH_REPORT_TOKEN`, only for a scheduled
  run or a dispatch with no `base_ref` whose candidate is develop's head.
  Any other dispatch posts context `perf-manual` and never files.
  - one issue labelled `perf-regression`, type Bug, project HackBench, with
    the table, base..cand compare link, the run link, and the exact local
    repro command. Each id is marked `<!-- perf-id: <id> -->`; an open issue
    carrying the exact marker gets a comment instead of a second issue;
  - then commit status `perf-nightly` on the candidate: `success` only when
    nothing was flagged, `error` ("unconfirmed") when pass 1 flagged ids the
    confirmation pass cleared, `failure` on a confirmed regression.
- Candidate code never sees a secret: checkouts keep no credentials, and
  the rclone config is deleted once the ROM is copied.
- Commits the raw rounds and verdict to the `perf-data` branch of
  hackbench-validation as `runs/<date>-<sha7>.json`.

Because the base only advances on a run that flagged nothing, an unfixed
regression keeps failing each run instead of silently becoming the new
normal, and one noisy confirmation pass cannot wave it through.

### Accepting an intended cost

`tools/perf/accept.sh <sha> "<reason>"` posts a `perf-nightly` success
status on that commit, making it the new base. Only the owner runs it. The
fixing agent may PROPOSE it on the issue with its evidence; it never runs it.

## 6. Fixing agent (local scheduled task)

Daily at 07:00 local on the owner's machine. The session:

1. Lists open `perf-regression` issues whose board status is not In
   progress. None: exit quietly.
2. Moves the oldest to In progress and works as the orchestrator
   (`docs/agents/tech-lead.md`). The scheduled fixer session registers as
   `both`, so it is its own BA and assigns itself the oldest issue;
   everything else follows the tech-lead manual.
   The fixer posts its plan summary on the issue and proceeds to a fix only
   when the active shift waives the plan gate (night-shift) or the owner has
   approved. Under day-shift it still bisects and classifies, which are
   analysis, and stops before any fix lands until approved.
3. Bisects between the issue's base and candidate SHAs with
   `tools/perf/bisect.mjs --id <id>` (git worktrees, paired runs,
   `--only`), naming the first bad commit. For an app, startup or heap id
   it first runs the moved-boundary check in section 2 and stops with a
   comment if a listed commit explains the change.
4. Classifies: accidental cost, fix it; intended cost of a feature, comment
   the evidence and propose `accept.sh`, then stop.
5. A fix ships as a normal PR: failing benchmark evidence before, paired
   run showing the recovery after, two reviews, normal merge rules.

## 7. Proving the gates can fail

Per the oracle rule, each verdict has a committed test that plants a defect:

- `compare.mjs` unit tests on synthetic rounds: a planted 20% slowdown is
  REGRESSION; A/A noise at 5% jitter is clean across 200 seeded trials with
  at most 2 false positives; one-sided ids, empty results, a result with
  no samples, unequal round counts, and a base/cand harness mismatch exit 2.
  A set of adversarial witnesses (an upper-bound-only check, a point
  estimate substituted for the interval, a dropped seed, an off-by-one in
  the bootstrap index, a bootstrap that never resamples, unpaired rounds, an
  ignored family threshold, a wrong threshold value, and CI-percentile and
  improvement-bound mixups) each has a value set chosen so that specific bug
  flips the verdict.
- `results.mjs` rejects an empty or sample-less file, a missing `harness`,
  and a non-positive `ms` sample.
- `--plant <id>=<factor>` in the runner, applied only to the candidate side:
  for core, `perfCase`'s sampler times a batch, then busy-waits once for
  `elapsed * (factor - 1)` before taking the batch's end timestamp, so
  calibration and sampling both see the scaled cost consistently rather
  than padding each call; for app it sets CDP
  `Emulation.setCPUThrottlingRate` on the candidate, so the app's own marks
  genuinely slow. Renderer throttling only proves render-bound cases, so
  app plants are refused outside an explicit PLANTABLE list. For `heap.*`
  the candidate page retains `factor x 64 KiB` per cycle. A factor below 1
  or a non-numeric factor is refused, and the runners fail if the planted id
  (or any `--only` id) produced no result at all.
- The workflow's `plant` input runs the whole pipeline end to end and is
  GREEN only when the plant id is confirmed, red otherwise, so the oracle
  itself can fail. A planted run never files or posts `perf-nightly`.
- A heap unit test: a synthetic series with a planted slope regresses; a
  flat one with noise does not; the 64 KiB floor holds even when the base
  median is near zero.
- `bisect.mjs`'s `git bisect run` step is `--step` mode of the same file
  (design D5), not a generated source string, so `exitCodeForStep` (0 good,
  1 bad, everything else - a build failure included - a skip) is a plain
  function under test, not a string match on generated code.

## Work breakdown

| PR | Repo | Contents | Size |
|---|---|---|---|
| 1 perf-core | hackbench | results.mjs, compare.mjs, paired.mjs, bisect.mjs, accept.sh, core benches, vitest perf config, npm scripts, unit tests | ~2,500 lines incl. tests - grew past the original ~600-line estimate mainly from D1-D5 plus adversarial-review witness tests added after two rounds of review (issue #413) |
| 2 perf-app | hackbench | perf-marks.ts, marks in widgets, app/startup/heap perf specs, perf Playwright config | ~450 lines |
| 3 perf-nightly | hackbench-validation | perf-nightly.yml, report script, perf-data branch | ~250 lines |
| 4 fixer | local | scheduled task prompt; docs/testing.md section | small |

PR 1 lands first; 2 and 3 follow in parallel.

## Future (not built)

Trend view over `perf-data`; slow-creep detection against a 14-day-old
base; instruction-count benchmarks for synthetic core cases; Electron
startup.
