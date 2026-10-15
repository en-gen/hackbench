import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
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

const A = 'alpha C:/wt/a'
const B = 'bravo C:/wt/b'
const ownerFile = (s: string) => path.join(s, 'locks', 'run', 'owner.txt')

// The oracle: a release that lets a non-owner remove the lock must fail this.
function expectRefusesWrongOwner(releaseFn: (s: string, o: { owner: string }) => { ok: boolean }) {
  const s = mkState()
  acquire(s, { owner: A, purpose: 'unit run' })
  const before = fs.readFileSync(ownerFile(s), 'utf8')
  const r = releaseFn(s, { owner: B })
  if (r.ok) throw new Error('wrong-owner release reported ok')
  if (!fs.existsSync(ownerFile(s))) throw new Error('lock removed by non-owner')
  if (fs.readFileSync(ownerFile(s), 'utf8') !== before) throw new Error('owner.txt changed')
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
      spawnSync(process.execPath, ['tools/scripts/run-lock.mjs', ...args], {
        encoding: 'utf8',
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
  })
})
