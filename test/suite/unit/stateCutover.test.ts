// #1202: the state folder moves from .hackbench-state to .overwatch. Every
// fixture is a temp dir; the real folder is never touched.
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import {
  cutoverState,
  readSessions,
  registerSession,
  stateDirFor,
} from '../../../tools/scripts/protocol.mjs'
import { resolveStateDir } from '../../../tools/scripts/state-dir.mjs'
import { acquire, release, status } from '../../../tools/scripts/run-lock.mjs'

const made: string[] = []
function tempMain(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-')))
  made.push(dir)
  return dir
}
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const DESKTOP = 'local_00000000-0000-0000-0000-000000000001'
const DESKTOP_2 = 'local_00000000-0000-0000-0000-000000000002'
const DESKTOP_3 = 'local_00000000-0000-0000-0000-000000000003'
const OLD = '.hackbench-state'
const NEW = '.overwatch'

/** A main checkout holding a live-looking old state folder. */
function withOldState() {
  const main = tempMain()
  const old = path.join(main, OLD)
  fs.mkdirSync(path.join(old, 'teams'), { recursive: true })
  fs.writeFileSync(path.join(old, 'ba.md'), 'handoff')
  registerSession(old, DESKTOP, 'ba', null, '2026-11-03T00:00:00Z')
  return { main, old, neu: path.join(main, NEW) }
}

describe('resolveStateDir', () => {
  it('HACKBENCH_STATE_DIR wins over both folders', () => {
    const { main } = withOldState()
    expect(resolveStateDir(main, { HACKBENCH_STATE_DIR: '/x' })).toBe('/x')
  })

  it('a fresh checkout gets .overwatch', () => {
    const main = tempMain()
    expect(resolveStateDir(main, {})).toBe(path.join(main, NEW))
  })

  it('an uncut checkout keeps answering .hackbench-state, so merging moves nothing live', () => {
    const { main, old } = withOldState()
    expect(resolveStateDir(main, {})).toBe(old)
  })

  it('.overwatch wins once it exists', () => {
    const { main, neu } = withOldState()
    fs.mkdirSync(neu)
    expect(resolveStateDir(main, {})).toBe(neu)
  })
})

describe('cutoverState', () => {
  it('renames the folder and leaves a link at the old name', () => {
    const { main, old, neu } = withOldState()
    const r = cutoverState(main)
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(path.join(neu, 'ba.md'), 'utf8')).toBe('handoff')
    expect(fs.lstatSync(neu).isDirectory()).toBe(true)
    expect(fs.lstatSync(old).isSymbolicLink()).toBe(true) // true for a junction too
    expect(fs.realpathSync(old)).toBe(fs.realpathSync(neu))
  })

  it('is idempotent: a second run reports done and changes nothing', () => {
    const { main, neu } = withOldState()
    cutoverState(main)
    const before = fs.readdirSync(neu).sort()
    const r = cutoverState(main)
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/already cut over/)
    expect(fs.readdirSync(neu).sort()).toEqual(before)
  })

  it('refuses while a run-lock slot is held, and moves nothing', () => {
    const { main, old } = withOldState()
    expect(acquire(old, { owner: 'alpha wt-a', purpose: 't', slots: 1 }).ok).toBe(true)
    const r = cutoverState(main)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/run-lock slot is held/)
    expect(fs.existsSync(path.join(main, NEW))).toBe(false)
    expect(fs.lstatSync(old).isDirectory()).toBe(true)
  })

  it('goes ahead once the slot is released', () => {
    const { main, old } = withOldState()
    acquire(old, { owner: 'alpha wt-a', purpose: 't', slots: 1 })
    release(old, { owner: 'alpha wt-a' })
    expect(cutoverState(main).ok).toBe(true)
  })

  it('refuses when .overwatch already exists as a real folder', () => {
    const { main, old, neu } = withOldState()
    fs.mkdirSync(neu)
    const r = cutoverState(main)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/already exists/)
    expect(fs.existsSync(path.join(old, 'ba.md'))).toBe(true)
  })

  it('says so when there is nothing to cut over', () => {
    const r = cutoverState(tempMain())
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/nothing to cut over/)
  })

  it('a failed rename leaves the original in place and says so', () => {
    const { main, old } = withOldState()
    const r = cutoverState(main, {
      rename: () => {
        throw new Error('EBUSY: resource busy')
      },
    })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/left in place.*EBUSY/)
    expect(fs.existsSync(path.join(old, 'ba.md'))).toBe(true)
    expect(fs.existsSync(path.join(main, NEW))).toBe(false)
  })

  it('a failed link undoes the rename', () => {
    const { main, old } = withOldState()
    const r = cutoverState(main, {
      link: () => {
        throw new Error('EPERM')
      },
    })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/rename undone/)
    expect(fs.lstatSync(old).isDirectory()).toBe(true)
    expect(fs.existsSync(path.join(main, NEW))).toBe(false)
  })
})

// Acceptance 4: a session still running old-path code (it reads .hackbench-state)
// and one running new code (it reads whatever the resolver says) share files.
describe('after cutover, the old path and the new path are one folder', () => {
  it('a session registered through either name is read through the other', () => {
    const { main, old, neu } = withOldState()
    cutoverState(main)
    registerSession(neu, DESKTOP_2, 'tech-lead', 'x', 'n')
    registerSession(old, DESKTOP_3, 'tech-lead', 'y', 'n')
    for (const dir of [old, neu]) {
      expect(Object.keys(readSessions(dir)).sort()).toEqual([DESKTOP, DESKTOP_2, DESKTOP_3])
    }
    expect(resolveStateDir(main, {})).toBe(neu)
  })

  it('a run-lock slot taken through the old name refuses the new name, and the reverse', () => {
    const { main, old, neu } = withOldState()
    cutoverState(main)
    expect(acquire(old, { owner: 'alpha wt-a', purpose: 'old', slots: 1 }).ok).toBe(true)
    expect(acquire(neu, { owner: 'bravo wt-b', purpose: 'new', slots: 1 }).ok).toBe(false)
    expect(status(neu, { slots: 1 }).held).toBe(true)
    expect(release(neu, { owner: 'alpha wt-a' }).ok).toBe(true) // released through the other name
    expect(status(old, { slots: 1 }).held).toBe(false)
    expect(acquire(neu, { owner: 'bravo wt-b', purpose: 'new', slots: 1 }).ok).toBe(true)
    expect(acquire(old, { owner: 'alpha wt-a', purpose: 'old', slots: 1 }).ok).toBe(false)
  })
})

describe('protocol.mjs cutover-state (CLI)', () => {
  const script = path.resolve(__dirname, '../../../tools/scripts/protocol.mjs')
  const run = (cwd: string, extra: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HACKBENCH_PROTOCOLS_DIR: path.resolve(__dirname, '../../../docs/protocols'),
    }
    delete env.HACKBENCH_STATE_DIR
    return spawnSync('node', [script, 'cutover-state'], {
      cwd,
      encoding: 'utf8',
      env: { ...env, ...extra },
    })
  }

  it('moves the folder, then reports done on a re-run', () => {
    const { main, neu } = withOldState()
    const first = run(main)
    expect(first.status).toBe(0)
    expect(first.stdout).toMatch(/moved/)
    expect(fs.existsSync(path.join(neu, 'sessions.json'))).toBe(true)
    const again = run(main)
    expect(again.status).toBe(0)
    expect(again.stdout).toMatch(/already cut over/)
  })

  it('refuses with HACKBENCH_STATE_DIR set', () => {
    const { main, old } = withOldState()
    const r = run(main, { HACKBENCH_STATE_DIR: path.join(main, 'elsewhere') })
    expect(r.status).toBe(1)
    expect(fs.lstatSync(old).isDirectory()).toBe(true)
  })

  it('refuses from a worktree and names the main checkout', () => {
    const { main, old } = withOldState()
    const git = (...a: string[]) =>
      execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
        stdio: 'pipe',
      })
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'root')
    const wt = path.join(main, '.worktrees', 'task')
    git('worktree', 'add', '-q', wt, '-b', 'feature/x')
    const r = run(wt)
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/main checkout/)
    expect(fs.lstatSync(old).isDirectory()).toBe(true)
    // A worktree resolves to the main checkout's folder, not its own.
    const saved = process.env.HACKBENCH_STATE_DIR
    delete process.env.HACKBENCH_STATE_DIR
    try {
      expect(fs.realpathSync(stateDirFor(wt))).toBe(fs.realpathSync(old))
    } finally {
      if (saved !== undefined) process.env.HACKBENCH_STATE_DIR = saved
    }
  }, 30000)
})
