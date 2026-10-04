/**
 * Vitest setup file: puts a `gh` that always fails first on PATH, so no unit
 * test can reach the real, authenticated GitHub CLI (issue #486: a test ran
 * accept.sh and posted real perf-nightly statuses). A test that needs a `gh`
 * builds its own and prepends its own directory, which wins over this one.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-nogh-'))
fs.writeFileSync(
  path.join(dir, 'gh'),
  '#!/usr/bin/env bash\necho "gh blocked: unit tests must not reach the real gh (#486); put a fake gh first on PATH" >&2\nexit 99\n',
  { mode: 0o755 },
)
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))

const sep = process.platform === 'win32' ? ';' : ':'
process.env.HB_NO_REAL_GH_DIR = dir.replaceAll(path.sep, '/')
process.env.PATH = process.env.HB_NO_REAL_GH_DIR + sep + (process.env.PATH ?? '')
