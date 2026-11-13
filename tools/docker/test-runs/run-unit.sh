#!/bin/bash
# Copies /src (read-only) into the container, then runs vitest as `npm run test:unit` does.
set -u
t0=$(date +%s.%N)
mkdir -p /work && cd /work
tar -C /src --exclude=node_modules --exclude=.git --exclude=theia/node_modules -cf - . | tar -xf -
ln -s /opt/deps/node_modules node_modules
t1=$(date +%s.%N)
echo "COPY_SECONDS $(awk "BEGIN{print $t1 - $t0}")"
npx vitest run --reporter=default --reporter=json --outputFile.json=/out/report.json "$@"
rc=$?
t2=$(date +%s.%N)
echo "TEST_SECONDS $(awk "BEGIN{print $t2 - $t1}")"
exit $rc
