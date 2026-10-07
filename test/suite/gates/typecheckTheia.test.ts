/**
 * #669: `npm run typecheck:theia` must use theia's own TypeScript (5.4.5),
 * never the root's 6.x, and must say how to fix a worktree that has none.
 * Both paths run the real script as a child process; the compiler is a
 * stub, so nothing here type-checks anything.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const script = path.resolve(__dirname, '../../../tools/scripts/typecheck-theia.cjs')
const dirs: string[] = []

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-tc-theia-'))
  dirs.push(d)
  return d
}

function run(theiaDir: string) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, HB_THEIA_DIR: theiaDir },
    encoding: 'utf8',
  })
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('typecheck-theia.cjs', () => {
  it('exits 1 and names the fix when theia has no typescript', () => {
    const r = run(tmp())
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toContain('yarn --cwd theia install')
  })

  it("runs theia's own tsc on theia/extension with --noEmit", () => {
    const theia = path.join(tmp(), 'theia')
    const bin = path.join(theia, 'node_modules', 'typescript', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    const argvFile = path.join(theia, 'argv.json')
    fs.writeFileSync(
      path.join(bin, 'tsc'),
      `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv))`,
    )
    const r = run(theia)
    expect(r.status).toBe(0)
    const argv: string[] = JSON.parse(fs.readFileSync(argvFile, 'utf8'))
    const p = argv.indexOf('-p')
    expect(p).toBeGreaterThan(-1)
    expect(path.normalize(argv[p + 1])).toBe(path.join(theia, 'extension'))
    expect(argv).toContain('--noEmit')
    expect(path.normalize(argv[1])).toBe(path.join(bin, 'tsc'))
  })
})
