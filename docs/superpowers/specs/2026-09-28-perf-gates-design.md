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
  "results": [
    { "id": "core.lclz2.decompress.synthetic-64k", "unit": "ms", "better": "lower",
      "samples": [1.21, 1.19, 1.20] }
  ]
}
```

- `id` is stable and dotted: `<family>.<area>.<case>`. Families: `core`,
  `app`, `startup`, `heap`.
- `unit` is `ms` or `bytes/cycle`. `better` is always `lower` in v1.
- `samples` are per-iteration values after warm-up is discarded.
- Writer and reader live in `tools/perf/results.mjs`, with a schema check
  that rejects an empty `results` array or a result with no samples. A
  suite that measured nothing must fail, never report green.

## 2. Suites

### Core (`test/perf/core/*.bench.ts`)

`vitest bench` (Vitest 5, tinybench), separate config
`vitest.perf.config.ts` so `test:unit` never runs benchmarks. A custom
reporter step converts Vitest's `--outputJson` into the result format.

- Synthetic cases build their input in the file (content rule: no ROM bytes
  in the repo) and run anywhere, including hackbench CI.
- Corpus cases use `test/suite/support/corpus.ts` and gate with
  `describe.skipIf(!hasRom(...))`, never by looping over a corpus listing.
- v1 set, about 8-12 cases: LC_LZ2 decompress, 4bpp tile decode, palette
  load, level parse + object expand for a small and a large map, working
  copy build with N layers, IPS export.

### App (`theia/browser-app/perf/*.perf.cjs`)

Playwright against `build:browser`, a separate `playwright.perf.config.cjs`
so the e2e run never collects these.

- Timings come from marks the APP emits, not from `waitForSelector` around
  it. `theia/extension/src/common/perf-marks.ts` exposes
  `perfStart(name)` / `perfEnd(name)`, backed by `performance.mark` and
  `performance.measure` with a `hb:` prefix. Widgets place `perfEnd` where
  the work is actually done (canvas drawn, not widget attached). A spec
  reads `performance.getEntriesByType('measure')` via `page.evaluate`.
- v1 cases: open project, open Maps / Map16 / Palette / GFX views, draw one
  map, apply one edit, undo it.
- `startup.*`: fresh server and page per round, time from navigation to the
  shell's `hb:shell-ready` mark.
- `heap.*`: open and close a view 20 times, forced GC through CDP
  `HeapProfiler.collectGarbage` before each `Runtime.getHeapUsage`, and
  report the least-squares slope in bytes per cycle. One heap number is
  too noisy to gate on; a slope is not.
- Electron startup is out of scope v1 (the suite drives the browser build).

## 3. Paired runner (`tools/perf/paired.mjs`)

```
node tools/perf/paired.mjs --base <dir> --cand <dir> --suite core|app
     [--rounds N] [--only id,id] [--plant <id>=<factor>] --out <file>
```

- `<dir>` is a built checkout. The runner alternates base, cand, base, cand
  for N rounds (default core 10, app 6), running the suite's command in
  each dir, and collects each round's result file.
- `--only` limits to named ids; the confirmation pass and bisect use it.
- The same tool runs in CI and locally, so a bisect measures exactly what
  the nightly measured.

## 4. Detector (`tools/perf/compare.mjs`)

Per result id:

1. Round value = median of that round's samples.
2. Pair ratio `r_i = cand_i / base_i` for each round.
3. Estimate = median of `r_i`; 95% interval by bootstrap over the pairs,
   2000 resamples, seeded PRNG so the verdict is reproducible from the file.
4. REGRESSION when the interval's lower bound exceeds `1 + threshold`.
   Thresholds by family: `core` 0.10, `app` 0.15, `startup` 0.15.
   `heap` uses differences, not ratios, because a slope near zero makes a
   ratio meaningless: `d_i = cand_i - base_i`, bootstrap the median of
   `d_i`, and regress when the lower bound exceeds
   `max(0.25 * |median(base)|, 64 KiB)` per cycle.
5. IMPROVEMENT is the mirror, reported but never actioned.
6. An id present on one side only is reported as `added` / `removed`, not
   compared.

Output: a JSON verdict and a Markdown table (id, base median, cand median,
ratio, interval, verdict). Exit 0 clean, 1 regression, 2 malformed input.

Confirmation: the workflow re-runs the paired runner with `--only` on every
flagged id; an issue is filed only for ids that regress in BOTH passes.

## 5. Nightly workflow (`en-gen/hackbench-validation`, `perf-nightly.yml`)

- `cron: '0 9 */2 * *'`, plus `workflow_dispatch` with inputs
  `hackbench_ref`, `base_ref` and `plant`.
- Gate job: skip when develop's head already carries a `perf-nightly`
  status. Base = newest develop commit with a `perf-nightly` success status
  in the last 50; none found means an A/A run (head against itself), which
  also calibrates noise.
- Checks out hackbench at base and at candidate into two dirs, installs and
  builds both, pulls the ROM with `RCLONE_CONF` as the e2e job does.
- Runs core then app through `paired.mjs`, then `compare.mjs`, then the
  confirmation pass.
- Reports into hackbench with `HACKBENCH_REPORT_TOKEN`:
  - commit status `perf-nightly` on the candidate: success when nothing is
    confirmed, failure otherwise;
  - on failure, one issue labelled `perf-regression`, type Bug, project
    HackBench, with the table, base..cand compare link, the run link, and
    the exact local repro command. An open `perf-regression` issue already
    naming the same id gets a comment instead of a second issue.
- Commits the raw rounds and verdict to the `perf-data` branch of
  hackbench-validation as `runs/<date>-<sha7>.json`.

Because the base only advances on success, an unfixed regression keeps
failing each run instead of silently becoming the new normal.

### Accepting an intended cost

`tools/perf/accept.sh <sha> "<reason>"` posts a `perf-nightly` success
status on that commit, making it the new base. Only the owner runs it. The
fixing agent may PROPOSE it on the issue with its evidence; it never runs it.

## 6. Fixing agent (local scheduled task)

Daily at 07:00 local on the owner's machine. The session:

1. Lists open `perf-regression` issues whose board status is not In
   progress. None: exit quietly.
2. Moves the oldest to In progress and works as the orchestrator
   (`docs/agents/orchestrator.md`).
3. Bisects between the issue's base and candidate SHAs with
   `tools/perf/bisect.mjs --id <id>` (git worktrees, paired runs,
   `--only`), naming the first bad commit.
4. Classifies: accidental cost, fix it; intended cost of a feature, comment
   the evidence and propose `accept.sh`, then stop.
5. A fix ships as a normal PR: failing benchmark evidence before, paired
   run showing the recovery after, two reviews, normal merge rules.

## 7. Proving the gates can fail

Per the oracle rule, each verdict has a committed test that plants a defect:

- `compare.mjs` unit tests on synthetic rounds: a planted 20% slowdown is
  REGRESSION; A/A noise at 5% jitter is clean across 200 seeded trials with
  at most 2 false positives; one-sided ids, empty results and a result with
  no samples exit 2.
- `results.mjs` rejects an empty or sample-less file.
- `--plant <id>=<factor>` in the runner: for core it busy-waits inside the
  measured function; for app it sets CDP `Emulation.setCPUThrottlingRate`
  on the candidate, so the app's own marks genuinely slow. The workflow's
  `plant` input runs the whole pipeline red end to end, without filing an
  issue (a planted run reports to the step summary only).
- A heap unit test: a synthetic series with a planted slope regresses; a
  flat one with noise does not.

## Work breakdown

| PR | Repo | Contents | Size |
|---|---|---|---|
| 1 perf-core | hackbench | results.mjs, compare.mjs, paired.mjs, bisect.mjs, accept.sh, core benches, vitest perf config, npm scripts, unit tests | ~600 lines incl. tests |
| 2 perf-app | hackbench | perf-marks.ts, marks in widgets, app/startup/heap perf specs, perf Playwright config | ~450 lines |
| 3 perf-nightly | hackbench-validation | perf-nightly.yml, report script, perf-data branch | ~250 lines |
| 4 fixer | local | scheduled task prompt; docs/testing.md section | small |

PR 1 lands first; 2 and 3 follow in parallel.

## Future (not built)

Trend view over `perf-data`; slow-creep detection against a 14-day-old
base; instruction-count benchmarks for synthetic core cases; Electron
startup.
