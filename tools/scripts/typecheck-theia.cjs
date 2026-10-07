#!/usr/bin/env node
// Type-check theia/extension with theia's own TypeScript (#669). A bare `tsc`
// resolves to the root's 6.x when theia/node_modules is absent, and 6.x
// rejects theia's `moduleResolution: node`. The compiler is resolved from
// theia/extension the way Node would, matching `yarn --cwd theia/extension
// typecheck` in CI. HB_THEIA_DIR is for the test only.
const { spawnSync } = require('child_process')
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

  let tsc
  try {
    const pkg = require.resolve('typescript/package.json', { paths: [extension] })
    // Node walks up past theia to the root checkout's TypeScript 6; refuse it.
    const inside = path.resolve(pkg).startsWith(path.resolve(theia) + path.sep)
    if (!inside) throw new Error('typescript resolved outside theia')
    tsc = path.join(path.dirname(pkg), 'bin', 'tsc')
  } catch {
    console.error(
      `typescript not found from ${extension}; run: yarn --cwd ${theia} install --frozen-lockfile --ignore-scripts`,
    )
    process.exit(1)
  }

  const r = spawnSync(
    process.execPath,
    [tsc, '-p', extension, '--noEmit', ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
  process.exit(exitCodeOf(r))
}

module.exports = { exitCodeOf }
if (require.main === module) main()
