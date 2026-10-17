import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import {
  acquire,
  release,
  status,
  defaultStateDir,
  slotCount,
  vitestWorkers,
} from '../../../tools/scripts/run-lock.mjs'

// Synthetic: every lock lives in a temp state dir, never the real one.
const made: string[] = []
function mkState(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runlock-'))
  made.push(dir)
  return dir
}
// The slot count comes from the environment by default; a developer's own
// HACKBENCH_RUN_SLOTS must not change what these tests mean.
let savedSlots: string | undefined
beforeEach(() => {
  savedSlots = process.env.HACKBENCH_RUN_SLOTS
  delete process.env.HACKBENCH_RUN_SLOTS
})
afterEach(() => {
  if (savedSlots === undefined) delete process.env.HACKBENCH_RUN_SLOTS
  else process.env.HACKBENCH_RUN_SLOTS = savedSlots
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tools/scripts/run-lock.mjs',
)
const A = 'alpha C:/wt/a'
const B = 'bravo C:/wt/b'
const ownerFile = (s: string) => path.join(s, 'locks', 'run', 'owner.txt')

// The oracle: a release that lets a non-owner remove the lock must fail this.
function expectRefusesWrongOwner(releaseFn: (s: string, o: { owner: string }) => { ok: boolean }) {
  const s = mkState()
  acquire(s, { owner: A, purpose: 'unit run' })
  const before = fs.readFileSync(ownerFile(s), 'utf8')
  // Same team with another worktree, a prefix and a superstring of the holder.
  for (const wrong of [B, 'alpha C:/wt/other', 'alpha', `${A} extra`]) {
    const r = releaseFn(s, { owner: wrong })
    if (r.ok) throw new Error(`wrong-owner release reported ok for "${wrong}"`)
    if (!fs.existsSync(ownerFile(s))) throw new Error('lock removed by non-owner')
    if (fs.readFileSync(ownerFile(s), 'utf8') !== before) throw new Error('owner.txt changed')
  }
}

describe('run lock', () => {
  it('acquire writes owner.txt and a second owner is refused', () => {
    const s = mkState()
    const r = acquire(s, { owner: A, purpose: 'unit run' })
    expect(r.ok).toBe(true)
    const text = fs.readFileSync(ownerFile(s), 'utf8')
    expect(text).toContain(`owner: ${A}`)
    expect(text).toContain('purpose: unit run')
    expect(text).toMatch(/started: \d{4}-\d\d-\d\dT[\d:.]+Z/)
    const r2 = acquire(s, { owner: B, purpose: 'build', slots: 1 })
    expect(r2.ok).toBe(false)
    expect(fs.readFileSync(ownerFile(s), 'utf8')).toBe(text)
  })

  it('wrong-owner release refuses and leaves the lock', () => {
    expectRefusesWrongOwner(release)
  })

  it('missing owner line refuses release', () => {
    const s = mkState()
    fs.mkdirSync(path.join(s, 'locks', 'run'), { recursive: true })
    fs.writeFileSync(ownerFile(s), 'legacy text\n')
    expect(release(s, { owner: A }).ok).toBe(false)
    expect(fs.existsSync(ownerFile(s))).toBe(true)
  })

  it('right-owner release removes the dir and acquire works again', () => {
    const s = mkState()
    acquire(s, { owner: A, purpose: 'x' })
    expect(release(s, { owner: A }).ok).toBe(true)
    expect(fs.existsSync(path.join(s, 'locks', 'run'))).toBe(false)
    expect(acquire(s, { owner: B, purpose: 'y' }).ok).toBe(true)
  })

  it('planted release without an owner check is caught by the oracle', () => {
    const releaseNoCheck = (s: string) => {
      fs.rmSync(path.join(s, 'locks', 'run'), { recursive: true, force: true })
      return { ok: true }
    }
    expect(() => expectRefusesWrongOwner(releaseNoCheck)).toThrow()
  })

  it('next.txt naming another team blocks; naming this team allows and is deleted', () => {
    const s = mkState()
    fs.mkdirSync(path.join(s, 'locks'), { recursive: true })
    const next = path.join(s, 'locks', 'next.txt')
    fs.writeFileSync(next, 'Bravo is next\n')
    expect(acquire(s, { owner: A, purpose: 'x' }).ok).toBe(false)
    expect(fs.existsSync(path.join(s, 'locks', 'run'))).toBe(false)
    expect(acquire(s, { owner: B, purpose: 'y' }).ok).toBe(true)
    expect(fs.existsSync(next)).toBe(false)
  })

  it('status reports free, held with age, and stale without removing', () => {
    const s = mkState()
    expect(status(s).held).toBe(false)
    const t0 = new Date('2026-10-14T00:00:00Z')
    acquire(s, { owner: A, purpose: 'x', now: t0 })
    const fresh = status(s, { now: new Date(t0.getTime() + 30 * 60000) })
    expect(fresh.held).toBe(true)
    expect(fresh.ageMinutes).toBe(30)
    expect(fresh.stale).toBe(false)
    const old = status(s, { now: new Date(t0.getTime() + 121 * 60000) })
    expect(old.stale).toBe(true)
    expect(old.lines.join('\n')).toMatch(/STALE.*BA/)
    expect(fs.existsSync(ownerFile(s))).toBe(true)
  })

  it('CLI: acquire, status, wrong release 1, right release 0', () => {
    const s = mkState()
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: 'utf8',
        cwd: os.tmpdir(),
        env: { ...process.env, HACKBENCH_STATE_DIR: s, HACKBENCH_RUN_SLOTS: '1' },
      })
    expect(run('acquire', '--owner', A, '--purpose', 'cli').status).toBe(0)
    expect(run('acquire', '--owner', B, '--purpose', 'cli').status).toBe(1)
    const st = run('status')
    expect(st.status).toBe(0)
    expect(st.stdout).toContain(A)
    expect(run('release', '--owner', B).status).toBe(1)
    expect(fs.existsSync(ownerFile(s))).toBe(true)
    expect(run('release', '--owner', A).status).toBe(0)
    expect(run('acquire').status).toBe(1)
    expect(run('acquire', '--owner', '--purpose', 'p').status).toBe(1)
    expect(run('release', '--owner', A).status).toBe(1) // no lock held
    expect(fs.existsSync(path.join(s, 'locks', 'run'))).toBe(false)
  })
})

const runDir = (s: string) => path.join(s, 'locks', 'run')
const nextTxt = (s: string) => path.join(s, 'locks', 'next.txt')
function writeNext(s: string, text: string) {
  fs.mkdirSync(path.join(s, 'locks'), { recursive: true })
  fs.writeFileSync(nextTxt(s), text)
}
function handLock(s: string, text: string, ageMin: number, now: Date) {
  fs.mkdirSync(runDir(s), { recursive: true })
  fs.writeFileSync(ownerFile(s), text)
  const t = new Date(now.getTime() - ageMin * 60000)
  fs.utimesSync(runDir(s), t, t)
}

describe('run lock hardening', () => {
  it('rejects blank, padded, CR and LF owners and purposes at acquire and release', () => {
    const s = mkState()
    for (const bad of ['', '   ', ' alpha x', 'alpha x ', 'alpha\nx', 'alpha\rx']) {
      expect(acquire(s, { owner: bad, purpose: 'p' }).ok).toBe(false)
      expect(fs.existsSync(runDir(s))).toBe(false)
    }
    expect(acquire(s, { owner: A, purpose: 'a\nowner: bravo' }).ok).toBe(false)
    expect(acquire(s, { owner: A, purpose: 'p' }).ok).toBe(true)
    for (const bad of ['', '   ', 'alpha\nx']) {
      expect(release(s, { owner: bad }).ok).toBe(false)
    }
    expect(release(s, {} as { owner: string }).ok).toBe(false)
    expect(fs.existsSync(ownerFile(s))).toBe(true)
  })

  it('owner with no leading letters is a validation error', () => {
    const s = mkState()
    expect(acquire(s, { owner: '909 C:/wt/x', purpose: 'p' }).ok).toBe(false)
    expect(fs.existsSync(runDir(s))).toBe(false)
  })

  it('release with no lock held refuses', () => {
    const r = release(mkState(), { owner: A })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('no lock held')
  })

  it('a failed owner.txt write removes the dir it made', () => {
    const s = mkState()
    const r = acquire(s, {
      owner: A,
      purpose: 'p',
      write: () => {
        throw new Error('disk full')
      },
    })
    expect(r.ok).toBe(false)
    expect(fs.existsSync(runDir(s))).toBe(false)
    expect(acquire(s, { owner: B, purpose: 'p' }).ok).toBe(true)
  })

  it('legacy owner.txt: status shows raw text, ages by dir mtime, STALE; release refuses', () => {
    const s = mkState()
    const now = new Date('2026-10-14T12:00:00Z')
    const raw = 'juliett-913, C:/wt/890-x, 2026-10-15T04:41:14Z'
    handLock(s, raw + '\n', 130, now)
    const st = status(s, { now })
    expect(st.held).toBe(true)
    expect(st.ageMinutes).toBe(130)
    expect(st.stale).toBe(true)
    const text = st.lines.join('\n')
    expect(text).toContain(raw)
    expect(text).toContain('legacy owner.txt, no owner line')
    const r = release(s, { owner: 'juliett-913' })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('removed by hand')
    expect(fs.existsSync(ownerFile(s))).toBe(true)
  })

  it('missing owner.txt: status says so and ages by mtime', () => {
    const s = mkState()
    const now = new Date('2026-10-14T12:00:00Z')
    fs.mkdirSync(runDir(s), { recursive: true })
    const t = new Date(now.getTime() - 200 * 60000)
    fs.utimesSync(runDir(s), t, t)
    const st = status(s, { now })
    expect(st.lines.join('\n')).toContain('owner.txt missing or unreadable')
    expect(st.stale).toBe(true)
  })

  it('owner line without a parseable started: ages by mtime', () => {
    const s = mkState()
    const now = new Date('2026-10-14T12:00:00Z')
    handLock(s, 'owner: alpha x\nstarted: garbage\n', 45, now)
    const st = status(s, { now })
    expect(st.ageMinutes).toBe(45)
    expect(st.stale).toBe(false)
  })

  it('STALE only when strictly over 120 minutes (119, 120, 121)', () => {
    const t0 = new Date('2026-10-14T00:00:00Z')
    for (const [min, stale] of [
      [119, false],
      [120, false],
      [121, true],
    ] as const) {
      const s = mkState()
      acquire(s, { owner: A, purpose: 'x', now: t0 })
      const st = status(s, { now: new Date(t0.getTime() + min * 60000) })
      expect(st.ageMinutes).toBe(min)
      expect(st.stale).toBe(stale)
    }
  })

  it('owner: is anchored to line start', () => {
    const s = mkState()
    fs.mkdirSync(runDir(s), { recursive: true })
    fs.writeFileSync(ownerFile(s), 'purpose: owner: bravo\n')
    expect(release(s, { owner: 'bravo' }).ok).toBe(false)
    expect(fs.existsSync(ownerFile(s))).toBe(true)
  })

  it('next.txt matches whole words by team', () => {
    const s = mkState()
    writeNext(s, 'bravo\n')
    expect(acquire(s, { owner: 'charlie x', purpose: 'p' }).ok).toBe(false)
    expect(acquire(s, { owner: 'Bravo x', purpose: 'p' }).ok).toBe(true)
    release(s, { owner: 'Bravo x' })
    writeNext(s, 'xray\n')
    expect(acquire(s, { owner: 'xray-909 C:/wt/x', purpose: 'p' }).ok).toBe(true)
    release(s, { owner: 'xray-909 C:/wt/x' })
    writeNext(s, 'charlie\n')
    expect(acquire(s, { owner: 'ch x', purpose: 'p' }).ok).toBe(false)
    expect(fs.existsSync(runDir(s))).toBe(false)
  })

  it('next.txt reserves by its FIRST word only', () => {
    const s = mkState()
    writeNext(s, 'bravo C:/wt/923-alpha-fix\n')
    expect(acquire(s, { owner: A, purpose: 'p' }).ok).toBe(false)
    writeNext(s, 'is bravo next\n')
    expect(acquire(s, { owner: B, purpose: 'p' }).ok).toBe(false)
    expect(fs.existsSync(runDir(s))).toBe(false)
    writeNext(s, 'bravo C:/wt/923-alpha-fix\n')
    expect(acquire(s, { owner: B, purpose: 'p' }).ok).toBe(true)
  })

  it('rejects U+2028 and U+2029 in owner and purpose', () => {
    const s = mkState()
    for (const ch of ['\u2028', '\u2029']) {
      expect(acquire(s, { owner: `alpha${ch}x`, purpose: 'p' }).ok).toBe(false)
      expect(acquire(s, { owner: A, purpose: `a${ch}owner: bravo` }).ok).toBe(false)
      expect(release(s, { owner: `alpha${ch}x` }).ok).toBe(false)
      expect(fs.existsSync(runDir(s))).toBe(false)
    }
  })

  it('a future started: falls back to the dir mtime', () => {
    const s = mkState()
    const now = new Date('2026-10-14T12:00:00Z')
    handLock(s, 'owner: alpha x\nstarted: 2027-01-01T00:00:00Z\n', 45, now)
    const st = status(s, { now })
    expect(st.ageMinutes).toBe(45)
    expect(st.stale).toBe(false)
  })

  it('a future started: sweeps the stale threshold on the mtime age', () => {
    const now = new Date('2026-10-14T12:00:00Z')
    const got = [119, 120, 121, 600].map(age => {
      const s = mkState()
      handLock(s, 'owner: alpha x\nstarted: 2027-01-01T00:00:00Z\n', age, now)
      return status(s, { now }).stale
    })
    expect(got).toEqual([false, false, true, true])
  })

  it('a still-negative age says unknown, never fresh', () => {
    const s = mkState()
    const now = new Date('2026-10-14T12:00:00Z')
    handLock(s, 'owner: alpha x\nstarted: 2027-01-01T00:00:00Z\n', -10, now)
    const st = status(s, { now })
    const text = st.lines.join('\n')
    expect(text).toContain('age unknown (clock skew), report to the BA')
    expect(text).not.toMatch(/age: -?\d+ min/)
    expect(st.held).toBe(true)
    expect(st.stale).toBe(false)
  })

  it('release on a dir with no owner.txt says it is missing, not taken by hand', () => {
    const s = mkState()
    fs.mkdirSync(runDir(s), { recursive: true })
    const r = release(s, { owner: A })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('owner.txt is missing or empty')
    expect(r.message).not.toContain('by hand')
    expect(fs.existsSync(runDir(s))).toBe(true)
  })

  it('an owner.txt of only whitespace refuses as missing or empty and the lock remains', () => {
    const s = mkState()
    fs.mkdirSync(runDir(s), { recursive: true })
    fs.writeFileSync(ownerFile(s), '  \n')
    const r = release(s, { owner: A })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('owner.txt is missing or empty (interrupted acquire)')
    expect(fs.existsSync(runDir(s))).toBe(true)
  })

  it('a blank hand-written owner line cannot be released with a blank owner', () => {
    const s = mkState()
    fs.mkdirSync(runDir(s), { recursive: true })
    fs.writeFileSync(ownerFile(s), 'owner: \n')
    expect(release(s, { owner: '' }).ok).toBe(false)
    expect(fs.existsSync(runDir(s))).toBe(true)
  })

  it('CLI: a purpose flag with no value is a usage error and takes no lock', () => {
    const s = mkState()
    const r = spawnSync(
      process.execPath,
      [SCRIPT, 'acquire', '--owner', 'alpha x', '--purpose', '--force'],
      { encoding: 'utf8', cwd: os.tmpdir(), env: { ...process.env, HACKBENCH_STATE_DIR: s } },
    )
    expect(r.status).toBe(1)
    expect(fs.existsSync(runDir(s))).toBe(false)
  })

  it('CLI launched through a junction still runs', () => {
    const s = mkState()
    const link = path.join(mkState(), 'scripts-link')
    fs.symlinkSync(path.dirname(SCRIPT), link, 'junction')
    const r = spawnSync(process.execPath, [path.join(link, 'run-lock.mjs'), 'status'], {
      encoding: 'utf8',
      cwd: os.tmpdir(),
      env: { ...process.env, HACKBENCH_STATE_DIR: s },
    })
    expect(r.stdout).toContain('free')
    expect(r.status).toBe(0)
  })

  it('blank next.txt is ignored', () => {
    const s = mkState()
    writeNext(s, '  \n\n')
    expect(acquire(s, { owner: A, purpose: 'p' }).ok).toBe(true)
  })

  it('status prints a non-blank next.txt, free or held', () => {
    const s = mkState()
    writeNext(s, 'bravo is next\n')
    expect(status(s).lines.join('\n')).toContain('bravo is next')
    acquire(s, { owner: B, purpose: 'p' })
    writeNext(s, 'charlie next\n')
    expect(status(s).lines.join('\n')).toContain('charlie next')
  })
})

describe('defaultStateDir', () => {
  const scriptsDir = path.dirname(SCRIPT)
  const expectedMain = () => {
    const out = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: scriptsDir,
      encoding: 'utf8',
    }).stdout.trim()
    return path.join(path.dirname(path.resolve(scriptsDir, out)), '.hackbench-state')
  }
  const noEnv = () => {
    const env = { ...process.env }
    delete env.HACKBENCH_STATE_DIR
    return env
  }

  it('HACKBENCH_STATE_DIR wins', () => {
    expect(defaultStateDir(scriptsDir, { HACKBENCH_STATE_DIR: 'C:/x/state' })).toBe('C:/x/state')
  })

  it('without the env var it is <main checkout>/.hackbench-state', () => {
    expect(defaultStateDir(scriptsDir, {})).toBe(expectedMain())
  })

  it('the result sits beside a real .git directory (main checkout, not a worktree)', () => {
    const result = defaultStateDir(scriptsDir, {})
    expect(fs.statSync(path.join(path.dirname(result), '.git')).isDirectory()).toBe(true)
  })

  it('does not depend on the cwd (fresh process started outside the repo)', () => {
    const code =
      `import(${JSON.stringify(pathToFileURL(SCRIPT).href)}).then(m => ` +
      'console.log(m.defaultStateDir(undefined, {})))'
    const r = spawnSync(process.execPath, ['-e', code], {
      encoding: 'utf8',
      cwd: os.tmpdir(),
      env: noEnv(),
    })
    expect(r.stdout.trim()).toBe(expectedMain())
  })

  it('throws when git cannot resolve the main checkout', () => {
    expect(() => defaultStateDir(mkState(), {})).toThrow(/HACKBENCH_STATE_DIR/)
  })

  it('CLI exits 1 with the error instead of failing open', () => {
    const copy = mkState()
    for (const f of ['run-lock.mjs', 'protocol.mjs', 'run-slots.mjs'])
      fs.copyFileSync(path.join(scriptsDir, f), path.join(copy, f))
    const r = spawnSync(process.execPath, [path.join(copy, 'run-lock.mjs'), 'status'], {
      encoding: 'utf8',
      cwd: copy,
      env: noEnv(),
    })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('HACKBENCH_STATE_DIR')
  })
})

// Counting semaphore (3 slots): slot 1 is the legacy locks/run, then run-2, run-3.
describe('run lock slots', () => {
  const C = 'charlie C:/wt/c'
  const D = 'delta C:/wt/d'
  const slotDir = (s: string, n: number) => path.join(s, 'locks', n === 1 ? 'run' : `run-${n}`)
  const holder = (s: string, n: number) =>
    fs.readFileSync(path.join(slotDir(s, n), 'owner.txt'), 'utf8')

  it('three teams hold distinct slots, a fourth is refused', () => {
    const s = mkState()
    const got = [A, B, C].map(owner => acquire(s, { owner, purpose: 'p' }))
    expect(got.map(r => r.ok)).toEqual([true, true, true])
    expect(got.map(r => r.slot)).toEqual([1, 2, 3])
    expect(holder(s, 2)).toContain(`owner: ${B}`)
    const r = acquire(s, { owner: D, purpose: 'p' })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('all 3 lock slots held')
    expect(r.message).toContain(A)
  })

  it('one slot per team: same team or exact same owner is refused, other teams are not', () => {
    const s = mkState()
    acquire(s, { owner: A })
    expect(acquire(s, { owner: A }).ok).toBe(false)
    expect(acquire(s, { owner: 'alpha C:/wt/other' }).ok).toBe(false)
    expect(acquire(s, { owner: 'alpha-7 C:/wt/x' }).ok).toBe(false)
    expect(fs.existsSync(slotDir(s, 2))).toBe(false)
    expect(acquire(s, { owner: 'alphabet C:/wt/x' }).ok).toBe(true)
  })

  it('release frees exactly the matching slot and the freed slot is reused', () => {
    const s = mkState()
    for (const owner of [A, B, C]) acquire(s, { owner })
    expect(release(s, { owner: B }).ok).toBe(true)
    expect(fs.existsSync(slotDir(s, 1))).toBe(true)
    expect(fs.existsSync(slotDir(s, 2))).toBe(false)
    expect(fs.existsSync(slotDir(s, 3))).toBe(true)
    expect(release(s, { owner: 'bravo C:/wt/b' }).ok).toBe(false)
    const r = acquire(s, { owner: D })
    expect(r.slot).toBe(2)
  })

  it('wrong-owner release leaves every slot', () => {
    const s = mkState()
    for (const owner of [A, B]) acquire(s, { owner })
    for (const wrong of [C, 'alpha', `${A} extra`]) {
      expect(release(s, { owner: wrong }).ok).toBe(false)
    }
    expect(fs.existsSync(slotDir(s, 1)) && fs.existsSync(slotDir(s, 2))).toBe(true)
  })

  it('next.txt blocks other teams on free slots and admits its team into any free slot', () => {
    const s = mkState()
    acquire(s, { owner: A })
    const next = path.join(s, 'locks', 'next.txt')
    fs.writeFileSync(next, 'delta is next\n')
    expect(acquire(s, { owner: B }).ok).toBe(false)
    expect(acquire(s, { owner: C }).ok).toBe(false)
    expect(fs.existsSync(slotDir(s, 2))).toBe(false)
    expect(fs.existsSync(next)).toBe(true)
    const r = acquire(s, { owner: D })
    expect(r.ok && r.slot).toBe(2)
    expect(fs.existsSync(next)).toBe(false)
  })

  it('a legacy single-dir lock is slot 1', () => {
    const s = mkState()
    fs.mkdirSync(slotDir(s, 1), { recursive: true })
    fs.writeFileSync(
      path.join(slotDir(s, 1), 'owner.txt'),
      `owner: ${A}
purpose: old
started: 2026-10-14T00:00:00.000Z
`,
    )
    expect(acquire(s, { owner: A }).ok).toBe(false) // one per team
    expect(acquire(s, { owner: B }).slot).toBe(2)
    expect(status(s, { now: new Date('2026-10-14T00:10:00Z') }).lines.join('\n')).toContain(
      `owner: ${A}`,
    )
    expect(release(s, { owner: A }).ok).toBe(true)
    expect(fs.existsSync(slotDir(s, 1))).toBe(false)
  })

  it('status lists every slot, free or held, with age and next.txt', () => {
    const s = mkState()
    const t0 = new Date('2026-10-14T00:00:00Z')
    acquire(s, { owner: B, purpose: 'build', now: t0 })
    acquire(s, { owner: A, purpose: 'unit', now: t0 })
    fs.writeFileSync(path.join(s, 'locks', 'next.txt'), 'charlie\n')
    const st = status(s, { now: new Date(t0.getTime() + 125 * 60000) })
    const text = st.lines.join('\n')
    expect(text).toMatch(/slot 1:\s+owner: bravo/)
    expect(text).toMatch(/slot 2:\s+owner: alpha/)
    expect(text).toContain('slot 3: free')
    expect(text).toContain('next.txt: charlie')
    expect(text).toContain('age: 125 min')
    expect(st.held).toBe(true)
    expect(st.stale).toBe(true)
  })

  it('HACKBENCH_RUN_SLOTS sets the count; invalid values fall back to 3', () => {
    expect(slotCount({ HACKBENCH_RUN_SLOTS: '1' })).toBe(1)
    expect(slotCount({ HACKBENCH_RUN_SLOTS: '2' })).toBe(2)
    expect(slotCount({})).toBe(3)
    for (const bad of ['0', '-1', '2.5', 'abc', '', '3x', ' 2']) {
      expect(slotCount({ HACKBENCH_RUN_SLOTS: bad })).toBe(3)
    }
    const s = mkState()
    expect(acquire(s, { owner: A, slots: 2 }).ok).toBe(true)
    expect(acquire(s, { owner: B, slots: 2 }).ok).toBe(true)
    expect(acquire(s, { owner: C, slots: 2 }).ok).toBe(false)
    expect(fs.existsSync(slotDir(s, 3))).toBe(false)
  })

  it('vitest workers: cores / 2 / slots with floor 1, override wins, invalid override ignored', () => {
    expect(vitestWorkers(32, {})).toBe(5)
    expect(vitestWorkers(32, { HACKBENCH_RUN_SLOTS: '1' })).toBe(16)
    expect(vitestWorkers(2, {})).toBe(1)
    expect(vitestWorkers(32, { HACKBENCH_VITEST_WORKERS: '7' })).toBe(7)
    expect(vitestWorkers(32, { HACKBENCH_VITEST_WORKERS: '0' })).toBe(5)
    // CI keeps the old formula and its floor of 2, whatever the slot count.
    expect(vitestWorkers(32, { CI: 'true' })).toBe(16)
    expect(vitestWorkers(2, { CI: 'true' })).toBe(2)
  })

  it('next.txt naming a team that already holds a slot is ignored and says so', () => {
    const s = mkState()
    acquire(s, { owner: A })
    const next = path.join(s, 'locks', 'next.txt')
    fs.writeFileSync(next, 'alpha is next\n')
    const r = acquire(s, { owner: B })
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/next\.txt names alpha.*ignored/)
    expect(fs.existsSync(next)).toBe(true) // only the named team deletes it
  })

  it('slots on disk beyond the caller count are still seen by status, release and the team scan', () => {
    const s = mkState()
    for (const owner of [A, B, C]) acquire(s, { owner })
    expect(acquire(s, { owner: 'charlie C:/wt/other', slots: 1 }).ok).toBe(false)
    expect(status(s, { slots: 1 }).lines.join('\n')).toContain(C)
    expect(release(s, { owner: C }).ok).toBe(true)
    expect(fs.existsSync(slotDir(s, 3))).toBe(false)
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: 'utf8',
        cwd: os.tmpdir(),
        env: { ...process.env, HACKBENCH_STATE_DIR: s, HACKBENCH_RUN_SLOTS: '1' },
      })
    expect(run('status').stdout).toContain(B)
    expect(run('release', '--owner', B).status).toBe(0)
    expect(fs.existsSync(slotDir(s, 2))).toBe(false)
  })

  it('a same-team tie after the write backs out only our own slot', () => {
    const s = mkState()
    // Simulates the rival acquire landing in slot 2 between our scan and our write.
    const write = (file: string, text: string) => {
      fs.writeFileSync(file, text)
      fs.mkdirSync(slotDir(s, 2))
      fs.writeFileSync(
        path.join(slotDir(s, 2), 'owner.txt'),
        'owner: alpha C:/wt/rival\npurpose: p\nstarted: 2026-10-14T00:00:00.000Z\n',
      )
    }
    const r = acquire(s, { owner: A, write })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('retry')
    expect(fs.existsSync(slotDir(s, 1))).toBe(false)
    expect(holder(s, 2)).toContain('rival')
  })

  it('release by a team with no slot says so and lists the holders', () => {
    const s = mkState()
    acquire(s, { owner: A })
    const r = release(s, { owner: D })
    expect(r.ok).toBe(false)
    expect(r.message).toContain(`${D} holds no lock slot`)
    expect(r.message).toContain(A)
    // A same-team wrong id keeps the plain not-the-owner answer.
    expect(release(s, { owner: 'alpha C:/wt/other' }).message).toContain('not the owner')
  })

  it('status.stale is true when any slot is stale, even if another is fresh', () => {
    const s = mkState()
    const t0 = new Date('2026-10-14T00:00:00Z')
    acquire(s, { owner: A, now: t0 })
    acquire(s, { owner: B, now: new Date(t0.getTime() + 100 * 60000) })
    const st = status(s, { now: new Date(t0.getTime() + 125 * 60000) })
    expect(st.stale).toBe(true)
    expect(st.slots.map(p => p.stale)).toEqual([true, false, undefined])
  })

  it('a hand-made lock with no owner line blocks its slot but not any team', () => {
    const s = mkState()
    fs.mkdirSync(slotDir(s, 1), { recursive: true })
    fs.writeFileSync(path.join(slotDir(s, 1), 'owner.txt'), 'taken by hand\n')
    const r = acquire(s, { owner: A })
    expect(r.ok && r.slot).toBe(2)
    expect(acquire(s, { owner: B }).slot).toBe(3)
  })

  it('CLI honours HACKBENCH_RUN_SLOTS and per process', () => {
    const s = mkState()
    const run = (slots: string, ...args: string[]) =>
      spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: 'utf8',
        cwd: os.tmpdir(),
        env: { ...process.env, HACKBENCH_STATE_DIR: s, HACKBENCH_RUN_SLOTS: slots },
      })
    expect(run('2', 'acquire', '--owner', A).status).toBe(0)
    const b = run('2', 'acquire', '--owner', B)
    expect(b.status).toBe(0)
    expect(b.stdout).toContain('acquired slot 2')
    expect(run('2', 'acquire', '--owner', C).status).toBe(1)
    expect(run('2', 'release', '--owner', B).status).toBe(0)
  })
})
