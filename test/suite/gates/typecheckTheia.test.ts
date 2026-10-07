/**
 * #669: `npm run typecheck:theia` must use theia's own TypeScript (5.4.5),
 * never the root's 6.x, and must say how to fix a worktree that has none.
 * Every case runs the real script as a child process; the compiler is a
 * stub, so nothing here type-checks anything.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'module'

const script = path.resolve(__dirname, '../../../tools/scripts/typecheck-theia.cjs')
const dirs: string[] = []

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-tc-theia-'))
  dirs.push(d)
  return d
}

/** Writes a typescript package whose bin/tsc is `body`; returns the tsc path. */
function stubTsc(nodeModulesParent: string, body: string): string {
  const pkg = path.join(nodeModulesParent, 'node_modules', 'typescript')
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"typescript","version":"0.0.0"}')
  const tsc = path.join(pkg, 'bin', 'tsc')
  fs.writeFileSync(tsc, body)
  return tsc
}

function recorder(argvFile: string, extra = ''): string {
  return `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv));${extra}`
}

function run(theiaDir: string | null, args: string[] = [], scriptPath = script) {
  const env = { ...process.env }
  if (theiaDir === null) delete env.HB_THEIA_DIR
  else env.HB_THEIA_DIR = theiaDir
  return spawnSync(process.execPath, [scriptPath, ...args], { env, encoding: 'utf8' })
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('typecheck-theia.cjs', () => {
  it('exits 1 with the full install hint naming the resolved theia dir', () => {
    const theia = path.join(tmp(), 'theia')
    const r = run(theia)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(
      `typescript not found from ${path.join(theia, 'extension')}; run: yarn --cwd ${theia} install --frozen-lockfile --ignore-scripts`,
    )
  })

  it("runs theia's own tsc on theia/extension with --noEmit, passing extra args and output through", () => {
    const theia = path.join(tmp(), 'theia')
    const argvFile = path.join(theia, 'argv.json')
    fs.mkdirSync(path.join(theia, 'extension'), { recursive: true })
    const tsc = stubTsc(theia, recorder(argvFile, "console.log('SENTINEL-TSC-OUT')"))
    const r = run(theia, ['--listFiles'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('SENTINEL-TSC-OUT')
    expect(r.stderr).toContain('HB_THEIA_DIR')
    const argv: string[] = JSON.parse(fs.readFileSync(argvFile, 'utf8'))
    const p = argv.indexOf('-p')
    expect(p).toBeGreaterThan(-1)
    expect(path.normalize(argv[p + 1])).toBe(path.join(theia, 'extension'))
    expect(argv).toContain('--noEmit')
    expect(argv).toContain('--listFiles')
    expect(path.normalize(argv[1])).toBe(fs.realpathSync(tsc))
  })

  it("passes the compiler's exit status through", () => {
    const theia = path.join(tmp(), 'theia')
    fs.mkdirSync(path.join(theia, 'extension'), { recursive: true })
    stubTsc(theia, 'process.exit(2)')
    expect(run(theia).status).toBe(2)
  })

  it('maps a signal death (status null) to 1 and keeps a real status', () => {
    const { exitCodeOf } = createRequire(__filename)(script)
    expect(exitCodeOf({ status: null, signal: 'SIGKILL' })).toBe(1)
    expect(exitCodeOf({ status: 2 })).toBe(2)
  })

  it('fails when the compiler is killed by a signal', () => {
    const theia = path.join(tmp(), 'theia')
    fs.mkdirSync(path.join(theia, 'extension'), { recursive: true })
    stubTsc(theia, "process.kill(process.pid, 'SIGKILL')")
    expect(run(theia).status).not.toBe(0)
  })

  it("prefers the extension's own typescript over the hoisted one", () => {
    const theia = path.join(tmp(), 'theia')
    const ext = path.join(theia, 'extension')
    fs.mkdirSync(ext, { recursive: true })
    const hoisted = path.join(theia, 'hoisted.json')
    const own = path.join(theia, 'own.json')
    stubTsc(theia, recorder(hoisted))
    stubTsc(ext, recorder(own))
    expect(run(theia).status).toBe(0)
    expect(fs.existsSync(own)).toBe(true)
    expect(fs.existsSync(hoisted)).toBe(false)
  })

  it('finds ../../theia from the script location when HB_THEIA_DIR is unset', () => {
    const root = tmp()
    fs.mkdirSync(path.join(root, 'tools', 'scripts'), { recursive: true })
    const copy = path.join(root, 'tools', 'scripts', 'typecheck-theia.cjs')
    fs.copyFileSync(script, copy)
    const theia = path.join(root, 'theia')
    fs.mkdirSync(path.join(theia, 'extension'), { recursive: true })
    const argvFile = path.join(root, 'argv.json')
    stubTsc(theia, recorder(argvFile))
    const r = run(null, [], copy)
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('HB_THEIA_DIR')
    const argv: string[] = JSON.parse(fs.readFileSync(argvFile, 'utf8'))
    expect(path.normalize(argv[argv.indexOf('-p') + 1])).toBe(path.join(theia, 'extension'))
  })
})
