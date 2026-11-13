#!/bin/bash
# Copies /src (read-only) into the container, then runs vitest as `npm run test:unit` does.
set -u
t0=$(date +%s.%N)
mkdir -p /work && cd /work
tar -C /src --exclude=node_modules --exclude=.git --exclude=theia/node_modules -cf - . | tar -xf -
ln -s /opt/deps/node_modules node_modules
tc=$(date +%s.%N)
git init -q && git add -A && git -c user.email=spike@local -c user.name=spike commit -qm snapshot
t1=$(date +%s.%N)
echo "GIT_SECONDS $(awk "BEGIN{print $t1 - $tc}")"
echo "COPY_SECONDS $(awk "BEGIN{print $tc - $t0}")"
if [ "${1:-}" = list ]; then shift; npx vitest list --no-staticParse --json=/out/list.json "$@"; exit $?; fi
npx vitest run --reporter=default --reporter=json --outputFile.json=/out/report.json "$@"
rc=$?
t2=$(date +%s.%N)
echo "TEST_SECONDS $(awk "BEGIN{print $t2 - $t1}")"
exit $rc
