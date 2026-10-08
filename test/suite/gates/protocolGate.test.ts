import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const repoRoot = path.resolve(__dirname, '../../..')
const script = path.join(repoRoot, 'tools/scripts/protocol.mjs')
let stateDir: string

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('node', [script, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, HACKBENCH_STATE_DIR: stateDir },
    })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-state-'))
})

describe('the protocol command', () => {
  it('refuses an unknown protocol', () => {
    const r = run(['bogus', 'on'])
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/unknown protocol "bogus"/)
  })

  it('enacts night-shift, lists registered sessions to nudge, and restores day-shift', () => {
    run(['register', 'sess-1', 'tech-lead', 'alpha'])
    const on = JSON.parse(run(['night-shift', 'on', '--by', 'owner']).out)
    expect(on.active).toEqual(['night-shift'])
    expect(on.nudge).toEqual([{ sessionId: 'sess-1', role: 'tech-lead', team: 'alpha' }])
    const status = JSON.parse(run(['status']).out)
    expect(status.active).toEqual(['night-shift'])
    const off = JSON.parse(run(['night-shift', 'off', '--by', 'owner']).out)
    expect(off.active).toEqual(['day-shift'])
    const log = fs.readFileSync(path.join(stateDir, 'protocols.log'), 'utf8')
    expect(log).toMatch(/night-shift on by owner \(replaced day-shift\)/)
    expect(log).toMatch(/night-shift off by owner \(restored day-shift\)/)
  })

  it('reports defaults when no state exists', () => {
    expect(JSON.parse(run(['status']).out).active).toEqual(['day-shift'])
  })
})
