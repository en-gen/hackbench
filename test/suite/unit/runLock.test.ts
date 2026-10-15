import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { acquire, release, status } from '../../../tools/scripts/run-lock.mjs'

// Synthetic: every lock lives in a temp state dir, never the real one.
const made: string[] = []
function mkState(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runlock-'))
  made.push(dir)
  return dir
}
afterEach(() => {
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
    const r2 = acquire(s, { owner: B, purpose: 'build' })
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
        env: { ...process.env, HACKBENCH_STATE_DIR: s },
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
