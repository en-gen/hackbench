#!/usr/bin/env node
// Type-check theia/extension with theia's own TypeScript (#669). A bare `tsc`
// resolves to the root's 6.x when theia/node_modules is absent, and 6.x
// rejects theia's `moduleResolution: node`. The compiler is looked up in
// theia/extension, then theia, as yarn lays it out, matching `yarn --cwd theia/extension
// typecheck` in CI. HB_THEIA_DIR is for the test only.
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

// A spawned child that dies by signal reports status null on POSIX; exit 1 then.
function exitCodeOf(r) {
  return r.status ?? 1
}

function main() {
  const override = process.env.HB_THEIA_DIR
  const theia = override || path.resolve(__dirname, '../../theia')
  const extension = path.join(theia, 'extension')
  if (override) console.error(`typecheck-theia: HB_THEIA_DIR is set, using ${theia}`)

  // The two places yarn puts it, in its order; no ancestor walk, so the root
  // checkout's TypeScript 6 can never match and a junctioned node_modules works.
  const pkgDir = [extension, theia]
    .map(d => path.join(d, 'node_modules', 'typescript'))
    .find(d => fs.existsSync(path.join(d, 'package.json')))
  if (!pkgDir) {
    console.error(
      `typescript not found under ${extension} or ${theia}; run: yarn --cwd ${theia} install --frozen-lockfile --ignore-scripts`,
    )
    process.exit(1)
  }
  const tsc = path.join(pkgDir, 'bin', 'tsc')

  const r = spawnSync(
    process.execPath,
    [tsc, '-p', extension, '--noEmit', ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
  process.exit(exitCodeOf(r))
}

module.exports = { exitCodeOf }
if (require.main === module) main()
