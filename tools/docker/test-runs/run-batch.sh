#!/bin/bash
# usage: run-batch.sh <n> <label> ; starts n detached containers on disjoint 10-vCPU ranges.
export MSYS_NO_PATHCONV=1  # Git Bash otherwise rewrites -e HACKBENCH_ROMS=/corpus into C:/Program Files/Git/corpus
n=${1:-1}; label=${2:-batch}; wt=$(cd ../../.. && pwd -W 2>/dev/null || pwd)
out=${OUT:-./results}/$label; mkdir -p "$out"
for i in $(seq 0 $((n-1))); do
  lo=$((i*10)); hi=$((lo+9)); mkdir -p "$out/run$i"
  docker run -d --label hackbench.spike=uniform --name "uniform-$label-$i" \
    --cpuset-cpus=$lo-$hi -e HACKBENCH_VITEST_WORKERS=5 -e HACKBENCH_ROMS=/corpus \
    -v "$wt:/src:ro" -v "C:/Projects/hackbench-tools/roms:/corpus:ro" -v "$(cd "$out/run$i" && pwd -W 2>/dev/null || pwd):/out" -v "$wt/tools/docker/test-runs/run-unit.sh:/run-unit.sh:ro" \
    hackbench-unit:spike "${@:3}" >/dev/null
done
for i in $(seq 0 $((n-1))); do
  docker wait "uniform-$label-$i" >/dev/null
  docker logs "uniform-$label-$i" > "$out/run$i/log.txt" 2>&1
  s=$(docker inspect -f '{{.State.StartedAt}}' "uniform-$label-$i"); f=$(docker inspect -f '{{.State.FinishedAt}}' "uniform-$label-$i")
  echo "run$i start=$s finish=$f" >> "$out/summary.txt"
  node -e '
    const r=require(process.argv[1]);let t=0;
    for(const f of r.testResults)for(const a of f.assertionResults)if(a.status==="failed"&&/timed out|timeout/i.test((a.failureMessages||[]).join()))t++;
    console.log("passed",r.numPassedTests,"failed",r.numFailedTests,"skipped",r.numPendingTests,"timeouts",t)' "$(cygpath -m "$out/run$i/report.json")" >> "$out/summary.txt"
  docker rm "uniform-$label-$i" >/dev/null
done
cat "$out/summary.txt"
