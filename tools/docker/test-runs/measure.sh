#!/bin/bash
# usage: measure.sh [--no-lock] <label> <command...>  (owner from OWNER env, default the queued name)
# Holds one lock slot, samples host CPU every 5 s (mean/max) until the command ends, a stop file
# appears, or MAX_SECONDS (default 3600) passes, so the sampler cannot outlive the run (#978).
nolock=0; [ "$1" = --no-lock ] && { nolock=1; shift; }
label=$1; shift; owner=${OWNER:-"uniform docker-run-isolation-spike"}; L=C:/Projects/hackbench/tools/scripts/run-lock.mjs
out=${OUT:-./results}; mkdir -p "$out"; cpu="$out/$label.cpu.txt"; stop="$out/$label.stop"; rm -f "$stop"
n=$(( ${MAX_SECONDS:-3600} / 5 )); stopw=$(cygpath -w "$(cd "$out" && pwd)/$label.stop")
if [ $nolock = 0 ]; then node $L acquire --owner "$owner" --purpose "docker spike $label" || exit 1; fi
node $L status > "$out/$label.lock-start.txt"
powershell -NoProfile -Command "for(\$i=0;\$i -lt $n -and -not (Test-Path '$stopw');\$i++){ (Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 5 -MaxSamples 1).CounterSamples[0].CookedValue }" > "$cpu" 2>/dev/null &
sp=$!; echo "sampler pid $sp" > "$out/$label.sampler-pid.txt"; s=$(date +%s.%N)
"$@"; rc=$?
echo "WALL_SECONDS $(awk "BEGIN{print $(date +%s.%N) - $s}")" | tee "$out/$label.wall.txt"
touch "$stop"; wait $sp
awk '{s+=$1; if($1>m)m=$1; n++} END{printf "CPU mean %.1f max %.1f n=%d\n", s/n, m, n}' "$cpu" | tee -a "$out/$label.wall.txt"
node $L status > "$out/$label.lock-end.txt"
[ $nolock = 0 ] && node $L release --owner "$owner"; exit $rc
