#!/bin/bash
# One lock slot for C1 container x3, strictly sequential; stops if a run skips >200 tests (host: 81-87) (#978).
cd "$(dirname "$0")"; export OUT=${OUT:?set OUT}; owner="uniform docker-run-isolation-spike"; export OWNER=$owner
L=C:/Projects/hackbench/tools/scripts/run-lock.mjs
node $L acquire --owner "$owner" --purpose "docker spike: C1 x3" || exit 75
trap 'node $L release --owner "$owner"' EXIT
for i in 1 2 3; do
  ./measure.sh --no-lock c1_$i ./run-batch.sh 1 c1_$i
  sk=$(sed -n 's/.*skipped \([0-9]*\).*/\1/p' "$OUT/c1_$i/summary.txt" | tail -1)
  [ "${sk:-9999}" -gt 200 ] && { echo "ABORT: run $i skipped=$sk"; exit 1; }
done
