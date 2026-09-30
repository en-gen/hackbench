// Records the source sha a browser bundle was built from, so a perf run can
// refuse a stale build (tools/perf/run-app.mjs).
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
  windowsHide: true,
}).trim()
fs.mkdirSync(path.join(__dirname, 'lib'), { recursive: true })
fs.writeFileSync(path.join(__dirname, 'lib', 'hb-build-stamp.json'), JSON.stringify({ sha }))
