#!/bin/bash
# One lock slot for: host test:unit x3, then C1 container x3, strictly sequential (#978).
cd "$(dirname "$0")"; export OUT=${OUT:?set OUT}; owner="uniform docker-run-isolation-spike"; export OWNER=$owner
L=C:/Projects/hackbench/tools/scripts/run-lock.mjs; root=$(cd ../../.. && pwd)
node $L acquire --owner "$owner" --purpose "docker spike: host x3 + C1 x3" || exit 75
trap 'node $L release --owner "$owner"' EXIT
for i in 1 2 3; do
  ./measure.sh --no-lock host$i bash -c "cd '$root' && npm run test:unit -- --reporter=default --reporter=json --outputFile.json='$OUT/host$i.json' > '$OUT/host$i.log' 2>&1"
done
for i in 1 2 3; do ./measure.sh --no-lock c1_$i ./run-batch.sh 1 c1_$i; done
