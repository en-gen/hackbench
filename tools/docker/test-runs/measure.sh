#!/bin/bash
# usage: measure.sh <label> <command...>  Holds one lock slot, samples host CPU every 5 s (mean/max),
# records lock status at start and end, runs the command. Not started yet (#978).
label=$1; shift; owner="uniform vigilant-poitras-cb9d64"; L=C:/Projects/hackbench/tools/scripts/run-lock.mjs
out=${OUT:-./results}; mkdir -p "$out"; cpu="$out/$label.cpu.txt"
node $L acquire --owner "$owner" --purpose "docker spike $label" || exit 1
node $L status > "$out/$label.lock-start.txt"
powershell -NoProfile -Command 'while($true){ (Get-Counter "\Processor(_Total)\% Processor Time" -SampleInterval 5 -MaxSamples 1).CounterSamples[0].CookedValue }' > "$cpu" 2>/dev/null &
sp=$!; s=$(date +%s.%N)
"$@"; rc=$?
echo "WALL_SECONDS $(awk "BEGIN{print $(date +%s.%N) - $s}")" | tee "$out/$label.wall.txt"
kill $sp 2>/dev/null; taskkill //F //FI "WINDOWTITLE eq nothing" >/dev/null 2>&1
awk '{s+=$1; if($1>m)m=$1; n++} END{printf "CPU mean %.1f max %.1f n=%d\n", s/n, m, n}' "$cpu" | tee -a "$out/$label.wall.txt"
node $L status > "$out/$label.lock-end.txt"
node $L release --owner "$owner"; exit $rc
