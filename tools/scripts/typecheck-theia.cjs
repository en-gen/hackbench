#!/usr/bin/env node
// Type-check theia/extension with theia's own TypeScript (#669). A bare `tsc`
// resolves to the root's 6.x when theia/node_modules is absent, and 6.x
// rejects theia's `moduleResolution: node`. HB_THEIA_DIR is for the test only.
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const theia = process.env.HB_THEIA_DIR || path.resolve(__dirname, '../../theia')
const tsc = path.join(theia, 'node_modules', 'typescript', 'bin', 'tsc')

if (!fs.existsSync(tsc)) {
  console.error(
    'theia/node_modules/typescript not found; run: yarn --cwd theia install --ignore-scripts',
  )
  process.exit(1)
}

const r = spawnSync(process.execPath, [tsc, '-p', path.join(theia, 'extension'), '--noEmit'], {
  stdio: 'inherit',
})
process.exit(r.status === null ? 1 : r.status)
