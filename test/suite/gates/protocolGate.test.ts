import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pathToFileURL } from 'url'

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
let protocolsDir: string
const LOCAL_ID = 'local_774e2af5-aaaa-4bbb-8ccc-000000000001'

function runFull(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('node', [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HACKBENCH_STATE_DIR: stateDir, HACKBENCH_PROTOCOLS_DIR: protocolsDir },
  })
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }
}

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('node', [script, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, HACKBENCH_STATE_DIR: stateDir, HACKBENCH_PROTOCOLS_DIR: protocolsDir },
    })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

beforeEach(() => {
  protocolsDir = path.join(repoRoot, 'docs/protocols')
  stateDir = mk('protocol-state-')
})

describe('the protocol command', () => {
  it('refuses an unknown protocol', () => {
    const r = run(['bogus', 'on'])
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/unknown protocol "bogus"/)
  })

  it('enacts night-shift, lists registered sessions to nudge, and restores day-shift', () => {
    run(['register', LOCAL_ID, 'tech-lead', 'alpha'])
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
    expect(run(['register', 'nope', 'ba']).code).not.toBe(0)
    expect(fs.existsSync(path.join(stateDir, 'sessions.json'))).toBe(false)
  })

  it('accepts only owner, schedule or session:<desktop id> for --by', () => {
    expect(run(['night-shift', 'on', '--by', 'schedule']).code).toBe(0)
    expect(run(['night-shift', 'off', '--by', 'owner']).code).toBe(0)
    expect(run(['throttle', 'on', '--by', `session:${LOCAL_ID}`]).code).toBe(0)
    expect(run(['throttle', 'off', '--by', 'bogus']).out).toMatch(/--by must be/)
    expect(run(['throttle', 'off', '--by']).out).toMatch(/--by must be/)
    expect(run(['throttle', 'off']).out).toMatch(/--by must be/)
    // A change with no --by at all is refused with the usage line and writes nothing:
    // the log and the state file are byte-identical before and after.
    const logFile = path.join(stateDir, 'protocols.log')
    const stateFile = path.join(stateDir, 'protocols.json')
    const logBefore = fs.readFileSync(logFile, 'utf8')
    const stateBefore = fs.readFileSync(stateFile, 'utf8')
    const missing = run(['night-shift', 'on'])
    expect(missing.code).not.toBe(0)
    expect(missing.out).toMatch(/usage: protocol\.mjs/)
    expect(fs.readFileSync(logFile, 'utf8')).toBe(logBefore)
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(stateBefore)
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
    run(['register', LOCAL_ID, 'tech-lead', 'alpha'])
    run(['register', '00000000-0000-4000-8000-000000000003', LOCAL_ID, 'tech-lead', 'alpha'])
    const on = JSON.parse(run(['night-shift', 'on', '--by', 'owner']).out)
    expect(on.nudge).toEqual([{ desktopId: LOCAL_ID, role: 'tech-lead', team: 'alpha' }])
  })
})

// Eight processes call registerSession at the same instant (each sleeps
// to a shared start time), every one a read-modify-write of sessions.json.
// Evidence scope: with the lock bypassed, 3 runs on Windows 11, Node 22, local
// disk left 1, 2 and 1 of 8 entries (and 5 earlier runs with busy-waiting
// starts each left 1).
describe('parallel registers', () => {
  it('keep every entry', async () => {
    const mod = pathToFileURL(script).href
    const startAt = Date.now() + 1500
    const ids = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`)
    await Promise.all(
      ids.map(
        (id, i) =>
          new Promise<void>(resolve => {
            const code = `import { registerSession } from ${JSON.stringify(mod)}
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ${startAt} - Date.now()))
              registerSession(${JSON.stringify(stateDir)}, ${JSON.stringify('local_' + id)}, 'tech-lead', 'team${i}', 'x')`
            spawn('node', ['--input-type=module', '-e', code], { stdio: 'ignore' }).on(
              'close',
              () => resolve(),
            )
          }),
      ),
    )
    const sessions = JSON.parse(fs.readFileSync(path.join(stateDir, 'sessions.json'), 'utf8'))
    expect(Object.keys(sessions).sort()).toEqual(ids.map(id => 'local_' + id).sort())
  })
})

describe('the command takes the lock', () => {
  function holdLock(): string {
    const lock = path.join(stateDir, '.lock')
    fs.writeFileSync(lock, 'held-by-the-test')
    return lock
  }

  function runWith(args: string[], env: Record<string, string>) {
    const r = spawnSync('node', [script, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HACKBENCH_STATE_DIR: stateDir,
        HACKBENCH_PROTOCOLS_DIR: protocolsDir,
        ...env,
      },
    })
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
  }

  it('refuses a change while another process holds the lock, and writes nothing (L4)', () => {
    holdLock()
    const r = runWith(['night-shift', 'on', '--by', 'owner'], { HACKBENCH_LOCK_TIMEOUT_MS: '200' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/could not lock/)
    expect(fs.existsSync(path.join(stateDir, 'protocols.json'))).toBe(false)
    expect(fs.existsSync(path.join(stateDir, 'protocols.log'))).toBe(false)
  })

  it('refuses a register while another process holds the lock', () => {
    holdLock()
    const r = runWith(['register', LOCAL_ID, 'ba'], { HACKBENCH_LOCK_TIMEOUT_MS: '200' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/could not lock/)
  })

  it('takes over a stale lock when the stale limit says so', () => {
    const lock = holdLock()
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lock, old, old)
    const r = runWith(['night-shift', 'on', '--by', 'owner'], { HACKBENCH_LOCK_STALE_MS: '100' })
    expect(r.code).toBe(0)
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('unregisters a desktop id through the command', () => {
    run(['register', LOCAL_ID, 'tech-lead', 'alpha'])
    const r = JSON.parse(run(['unregister', LOCAL_ID]).out)
    expect(r.removed).toBe(1)
    expect(r.sessions).toEqual({})
    expect(run(['unregister', 'nope']).code).not.toBe(0)
  })
})

describe('a Blocked protocol is refused', () => {
  // Synthetic: no shipped protocol is Blocked now, so the refusal is proved on a copy.
  function runBlocked(args: string[]) {
    const dir = mk('blocked-protocols-')
    fs.cpSync(path.join(repoRoot, 'docs/protocols'), dir, { recursive: true })
    const night = path.join(dir, 'night-shift.md')
    fs.writeFileSync(
      night,
      fs
        .readFileSync(night, 'utf8')
        .replace(/## Activation\r?\n/, m => `${m}\nBlocked: planted for the test.\n`),
    )
    const r = spawnSync('node', [script, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HACKBENCH_STATE_DIR: stateDir, HACKBENCH_PROTOCOLS_DIR: dir },
    })
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
  }

  it('refuses on, writes nothing, and leaves status and day-shift alone', () => {
    const r = runBlocked(['night-shift', 'on', '--by', 'owner'])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/night-shift is blocked: planted for the test/)
    expect(fs.existsSync(path.join(stateDir, 'protocols.json'))).toBe(false)
    expect(fs.existsSync(path.join(stateDir, 'protocols.log'))).toBe(false)
    expect(JSON.parse(runBlocked(['status']).out).active).toEqual(['day-shift'])
  })

  it('the shipped night-shift enacts on the real protocols dir', () => {
    expect(run(['night-shift', 'on', '--by', 'owner']).code).toBe(0)
  })
})
