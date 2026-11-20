# Docker test runs spike

Status: spike report, partly measured. Written 2026-11-13 (Uniform team). Refs #978. C3, host-at-3 and the Playwright pair were not measured: no quiet window was available (section 8). The recommendation (section 9) is scoped to C1.

> **Bottom line**
>
> - One container on a 10-vCPU slice finished the full unit suite in 546, 641 and 566 s; the host run took 978, 1784 and 946 s. `[EST]` 3 runs each, one machine, other teams running, not a controlled A/B.
> - Load was not equal: host CPU averaged 64-78% during the container runs and 90-99% during the host runs. `[EST]` 5 s samples of total host CPU, same 6 runs.
> - Per-thread speed is not better in the container: SingleStep took 109-132 s there against 65-69 s on the two quieter host runs. `[EST]` one file, 3 container runs and 3 host runs.
> - The gain probably comes from Linux process and file-system costs plus the load difference, not from faster cores. `[INF]` from the SingleStep numbers above; no run isolated either cause.
> - DoorNoBlend.corpus timed out at 120 s in 6 of 6 runs, host and container, including at 64% CPU, so it is not a load problem (#1214). `[EST]` 6 runs, same code.
> - The container is a valid comparison only after four fixes (section 6): skipped counts now match the host (85 against 81-87) and a full collect matches within 3 of 13912 tests. `[EST]`
> - The image holds no ROM bytes: 0 hits over 37911 files, and the scan goes red on a planted file. `[EST]` one image, one day.
> - Recommendation: do not adopt yet. One isolated container run works and is ROM-free, but the spike's question (more than 3 parallel runs without timeouts) is unanswered until C3 runs. `[INF]` section 9.

## Provenance

| Source | Identifier | As of | Retrieved |
| --- | --- | --- | --- |
| Scripts and Dockerfile | `tools/docker/test-runs/`, branch `feature/docker-run-isolation-spike`, commit `18c15994` for the measured runs | 2026-11-13 | 2026-11-13 |
| Host runs | 3 x `npm run test:unit`, scratchpad `results/host*.json` | 2026-11-13 | 2026-11-13 |
| Container runs | 3 x C1, scratchpad `results3/` | 2026-11-13 | 2026-11-13 |
| ROM scan | `tools/docker/test-runs/scan-image.mjs` on image `hackbench-unit:spike` | 2026-11-13 | 2026-11-13 |

## 1. Question and owner direction

Can Docker Desktop (Linux containers, WSL2 backend) run more full unit-test runs in parallel on this machine than the host run lock allows, without the timeouts the lock exists to prevent (#485, #771)? The lock caps overlapping full runs at 3 ([../testing.md](../testing.md), Run lock). This is a spike under #978: measure, do not roll out. `[EST]` brief for this task.

## 2. Setup

- Machine: Ryzen 9 5950X (32 threads), 64 GB, Windows 11. `[EST]` brief.
- Docker 29.9.3. The WSL2 VM reports 32 CPUs and 33.6 GB (33590210560 bytes), about half the host RAM. That is the WSL default with no `.wslconfig`, and it is a limit on how many containers fit. `[EST]` `docker info`.
- Image: `node:22-bookworm` pinned by digest `sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb`; root dependencies baked in with `npm ci --ignore-scripts` at `/opt/deps`. The build context holds only `package.json` and `package-lock.json`. `[EST]`
- Mounts: the worktree read-only at `/src`; the whole tools folder (ROM corpus, captures, single-step data) read-only at `/hackbench-tools`; a per-run output folder at `/out`; the entrypoint script read-only at `/run-unit.sh`. Nothing from the tools folder is copied into the image or the container's writable copy. `[EST]`
- Env: `HACKBENCH_TOOLS=/hackbench-tools`, `HACKBENCH_ROMS=/hackbench-tools/roms`, `HACKBENCH_VITEST_WORKERS=5`. The captures and single-step locations follow from the tools root (`test/suite/support/corpus.cjs`). `[EST]`
- `--cpuset-cpus=0-9` for the one container. Git Bash rewrites `/corpus`-style values in `-e` into Windows paths, so `run-batch.sh` sets `MSYS_NO_PATHCONV=1` (section 6).

```mermaid
flowchart LR
  A[host driver] --> B[run lock slot]
  B --> C[docker run, detached, cpuset 0-9]
  C --> D[tar copy of /src into the container]
  D --> E[git snapshot of the copy]
  E --> F[vitest, 5 workers, JSON report]
  F --> G[results copied out, container removed, slot released]
```

## 3. C1 results

C1 is one container, cpuset 0-9, 5 workers. The host runs are `npm run test:unit` with its default 5 workers. All runs held one lock slot; runs went strictly one after another. Timeouts count failures whose message says it timed out. `[EST]` 3 runs per row group, one machine, other teams' runs as background load.

Host:

| Run | Wall (s) | Passed | Failed | Skipped | Timeouts | CPU mean / max (%) | SingleStep (s) | Other lock holders at start |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| host1 | 978 | 13922 | 4 | 81 | 4 | 90.6 / 100 | 69.0 | 2 |
| host2 | 1784 | 13913 | 7 | 87 | 7 | 99.4 / 100 | 142.9 | 2 |
| host3 | 946 | 13923 | 3 | 81 | 3 | 99.1 / 100 | 65.3 | 2 |

Container (commit `18c15994` environment):

| Run | Wall (s) | Copy / git (s) | Passed | Failed | Skipped | Timeouts | CPU mean / max (%) | SingleStep (s) | Other lock holders at start |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| c1_1 | 546 | 4.7 / 0.8 | 13907 | 1 | 85 | 1 | 63.7 / 88.9 | 108.7 | 2 |
| c1_2 | 641 | 5.5 / 0.8 | 13905 | 3 | 85 | 3 | 77.7 / 98.7 | 122.8 | 2 |
| c1_3 | 566 | 4.5 / 0.8 | 13907 | 1 | 85 | 1 | 64.4 / 90.4 | 131.6 | 2 |

Container wall is the whole `measure.sh` time, which includes docker run and teardown; vitest's own test time was 536, 631 and 556 s. Host wall was not split that way. `[EST]`

Failing tests:

- Host: DoorNoBlend (120000 ms) in all 3; LevelStart.rom (5000 ms) in all 3; RevealSearch (5000 ms) in 2; RecentProjects (5000 ms) in 1. Host 2 also failed contentGateRomWindows (120000 ms), CollisionShortcut.corpus (400000 ms), 2 SpriteReport tests (60000 and 30000 ms) and spriteGrade.captures (300000 ms).
- Container: DoorNoBlend (120000 ms) in all 3; run 2 also failed 2 LevelCatalog.synthetic tests (5000 ms each).

## 4. How to read it

- This is not a controlled A/B. The host runs and the container runs happened at different times with different neighbors. `[EST]`
- Load differed: host CPU 64-78% mean during the container runs against 90-99% during the host runs. A faster container could simply mean a quieter machine. `[EST]`
- Per-thread speed is not better: SingleStep took 109-132 s in the container, against 65-69 s on the two quieter host runs (host 2 took 143 s under full load). `[EST]`
- The gain probably comes from Linux process and file-system costs, plus the load difference. `[INF]` from SingleStep; not isolated by any run here. `[OPEN]` a host-versus-container pair run back to back with the same neighbors would resolve it.
- 3 runs each, one machine, other teams running. Treat all differences as indications.

## 5. Separate finding for #1214

DoorNoBlend.corpus ("door and lift pixels never meet color math on vanilla (#936)") timed out at 120000 ms in 6 of 6 runs, host and container, including container run 1 at 63.7% mean CPU. A test that times out on a half-idle machine is slow by itself, not starved. `[EST]` 6 runs, one machine, same commit family. `[INF]` that it is not a load problem.

## 6. Validity checks and what broke

- Git Bash rewrote `-e HACKBENCH_ROMS=/corpus` to a Windows path inside the container, so the corpus was not found and 3180 tests skipped. Fix: `MSYS_NO_PATHCONV=1`. That runs' numbers were discarded. `[EST]`
- Only the ROM folder was mounted, but tests also read captures and single-step data from the tools root. After the first fix 690 tests still skipped (SingleStep +514 alone). Fix: mount the whole tools folder read-only. `[EST]`
- The copy has no `.git`, so tests that call git failed (contentGate, perfConfigSeparation, nestedFoldersGate, protocol, runLock, 7 of the 9 failures in that run). Fix: `git init`, `git add -A` and one snapshot commit in the copy, 0.8 s. `[PROP]` as the way to do it; no git-dependent test failed after it in the six-file smoke or the three C1 runs. `[EST]`
- Full collect (`vitest list --no-staticParse`, no tests executed): host 13912, container 13909, 4 files differ by at most 2 (SpriteReport 69/67, RomReadBounds 67/69, SpriteMetadata 38/36, perfAccept 17/16). The list holds non-skipped tests only, so this is the skip comparison. `[EST]` one collect each. Cause of the 4 differences not investigated.
- Limit: skips decided inside a test body do not show in a collect. A grep of `test/suite` finds one `ctx.skip` (`contentGateRomWindows.test.ts:480`, a synthetic ACL case, not corpus-gated); early-return guards cannot be found by grep. `[OPEN]`
- The host full collect was run with a `--json` path that resolved onto `test/suite/unit/CaptureGate.corpus.test.ts` and overwrote it with the list output. The file was restored from git before the PR; nothing was committed from it. Use an absolute output path in the scratchpad. `[EST]`
- ROM proof: `docker history` of `hackbench-unit:spike` shows only the base, the package files and `npm ci`. `scan-image.mjs` scanned all 11 layers (37911 files) against SHA-256 of 740 ROM files (full and first 64 KB, plus file-name patterns) and found 0 hits. `[EST]` this image, this day.
- The scan can fail: against a random 512 KB file named `planted.sfc`, baked into a throwaway image labeled `hackbench.spike=uniform`, it reported all three checks (name, full SHA-256, first-64 KB) and exited 1. The random file, the image and its tar were deleted at once; no real ROM went into any image. `[EST]` The planted run is documented here, not committed as a test: `scan-image.mjs` is a spike tool with no red test in the suite. `[OPEN]` if the scan is kept, it needs one.

## 7. Overhead

- Cold image build (`--no-cache`, base image already pulled): 111 s. `[EST]` one build.
- Copy of 17 MB (about 1500 files) from the bind mount: 38.6 s on the first read (cold), 6-7 s on a repeat, 4.5-5.5 s in the three C1 runs. Nothing worth trimming: no build output or caches in the tree. `[EST]`
- Git snapshot: 0.8 s. `[EST]`
- Cold start (docker run to first test line, one file): 42.4 s with the cold copy; with the warm copy and git it would be about 6 s plus vitest start. `[INF]` not measured warm as one number.
- Docker Desktop start time: not recorded (restarted by hand after a failed first start).

## 8. Not measured (no quiet window)

The owner had no quiet window on 2026-11-13, so the runs below never happened. Each needs all 3 lock slots with no other team running tests, about 1 hour.

- C3: 3 containers at once on cpusets 0-9, 10-19 and 20-29, 5 workers each, 3 repeats. Not measured (no quiet window). `[OPEN]`
- Host-at-3: 3 host runs at once, the baseline C3 is compared with. Not measured (no quiet window). `[OPEN]`
- An N sweep past 3 containers. Not measured (no quiet window). `[OPEN]` The 33.6 GB WSL VM limit (section 2) may cap it before CPU does.
- Playwright pair: two containers each running `build:browser` and one spec on their own ports and app data, plus a planted cross-wire (one container pointed at the other's port or app data) that must go red. Not measured (no quiet window); no Playwright image was built. `[OPEN]`
- Mesen captures: out of scope for this spike.

## 9. Recommendation

**Do not adopt yet; unit-only is the candidate if C3 holds up.** `[INF]` from sections 3 to 7.

What the evidence supports:

- A unit run in a container can be made equivalent to a host run: same skips within a handful, same failures in kind, and git-dependent tests pass with a snapshot. `[EST]` 3 runs, one machine.
- The image carries no ROM bytes and the check proving it can fail. `[EST]` one image.
- Overhead per run is small once warm (about 6 s copy and git); the image is 2.02 GB and builds cold in 111 s. `[EST]`

What it does not support:

- That containers allow more than 3 parallel runs. Only one container ran at a time; C3 is the deciding measurement. `[OPEN]`
- That a container is faster. The C1 gain came with lower host load and slower per-thread time (section 4). `[EST]`
- Anything about Playwright isolation. `[OPEN]`

Next step if the owner wants an answer: one quiet hour for C3 and host-at-3 with the scripts on this branch (`spike-chain.sh` pattern, `run-batch.sh 3`). If C3 finishes 3 runs with no more timeouts than C1 and host-at-3 times out more, adopt for unit runs; otherwise don't.
