import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Every temp directory a test makes is removed afterwards, like lintGate.test.ts.
// Windows can refuse a removal while a just-exited child process lets go, so
// retry once and then ignore: hygiene must never fail a run.
const made: string[] = []

function mk(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  made.push(dir)
  return dir
}

function removeAll(): void {
  for (const dir of made.splice(0)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
    }
  }
}

afterEach(removeAll)

const repoRoot = path.resolve(__dirname, '../../..')
const script = path.join(repoRoot, 'tools/scripts/protocol.mjs')
let stateDir: string
const CLI_ID = '2b245891-c391-4d73-9647-b5b41cea6c49'
const LOCAL_ID = 'local_774e2af5-aaaa-4bbb-8ccc-000000000001'

function runFull(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('node', [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HACKBENCH_STATE_DIR: stateDir },
  })
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }
}

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
  stateDir = mk('protocol-state-')
})

describe('the protocol command', () => {
  it('refuses an unknown protocol', () => {
    const r = run(['bogus', 'on'])
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/unknown protocol "bogus"/)
  })

  it('enacts night-shift, lists registered sessions to nudge, and restores day-shift', () => {
    run(['register', CLI_ID, LOCAL_ID, 'tech-lead', 'alpha'])
    const on = JSON.parse(run(['night-shift', 'on', '--by', 'owner']).out)
    expect(on.active).toEqual(['night-shift'])
    expect(on.nudge).toEqual([{ desktopId: LOCAL_ID, role: 'tech-lead', team: 'alpha' }])
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

describe('the protocol command, hardened', () => {
  it('refuses a malformed session id on register', () => {
    expect(run(['register', 'nope', LOCAL_ID, 'ba']).code).not.toBe(0)
    expect(run(['register', CLI_ID, 'nope', 'ba']).code).not.toBe(0)
    expect(fs.existsSync(path.join(stateDir, 'sessions.json'))).toBe(false)
  })

  it('accepts only owner, schedule or session:<desktop id> for --by', () => {
    expect(run(['night-shift', 'on', '--by', 'schedule']).code).toBe(0)
    expect(run(['night-shift', 'off', '--by', 'owner']).code).toBe(0)
    expect(run(['throttle', 'on', '--by', `session:${LOCAL_ID}`]).code).toBe(0)
    expect(run(['throttle', 'off', '--by', 'bogus']).out).toMatch(/--by must be/)
    expect(run(['throttle', 'off', '--by']).out).toMatch(/--by must be/)
    expect(run(['throttle', 'off']).out).toMatch(/--by must be/)
    // A change with no --by at all is refused with the usage line and writes nothing.
    const missing = run(['night-shift', 'on'])
    expect(missing.code).not.toBe(0)
    expect(missing.out).toMatch(/usage: protocol\.mjs/)
    expect(fs.existsSync(path.join(stateDir, 'protocols.log'))).toBe(true)
    expect(fs.readFileSync(path.join(stateDir, 'protocols.log'), 'utf8')).not.toMatch(/unknown/)
  })

  it('still enacts a change when the sessions file is corrupt', () => {
    fs.writeFileSync(path.join(stateDir, 'sessions.json'), '[1,2]')
    const on = JSON.parse(run(['night-shift', 'on', '--by', 'owner']).out)
    expect(on.nudge).toEqual([])
  })

  it('prints one warning line for an unreadable state file and applies the defaults', () => {
    fs.writeFileSync(path.join(stateDir, 'protocols.json'), '{bad')
    const r = runFull(['status'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).active).toEqual(['day-shift'])
    expect(r.stderr.trim()).toBe('protocols.json unreadable, defaults applied')
  })

  it('nudges a re-registered session once, not once per CLI id', () => {
    run(['register', CLI_ID, LOCAL_ID, 'tech-lead', 'alpha'])
    run(['register', '00000000-0000-4000-8000-000000000003', LOCAL_ID, 'tech-lead', 'alpha'])
    const on = JSON.parse(run(['night-shift', 'on', '--by', 'owner']).out)
    expect(on.nudge).toEqual([{ desktopId: LOCAL_ID, role: 'tech-lead', team: 'alpha' }])
  })
})
