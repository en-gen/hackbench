/**
 * Proves the suite-wide guard (test/suite/support/noRealGh.ts) leaves no
 * AUTHENTICATED gh reachable (issue #486). Offline only: with the sentinel
 * token set, gh and git-credential never reach the network for these calls.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import setup, { guardEnv, SENTINEL, TOKEN_VARS } from '../support/noRealGh'

const REAL_TOKEN = /gh[opsu]_/

describe('guardEnv (pure)', () => {
  const real = Object.fromEntries(TOKEN_VARS.map(v => [v, 'ghp_realtoken']))
  const out = guardEnv({ ...real, GH_HOST: 'github.com', KEEP: '1' }, '/cfg')

  it('replaces all four tokens with the sentinel', () => {
    for (const v of TOKEN_VARS) expect(out[v]).toBe(SENTINEL)
    expect(REAL_TOKEN.test(JSON.stringify(out))).toBe(false)
  })
  it('sets the config dir, keeps other variables, does not mutate its input', () => {
    expect(out.GH_CONFIG_DIR).toBe('/cfg')
    expect(out.GH_HOST).toBe('github.com')
    expect(out.KEEP).toBe('1')
    expect(real.GH_TOKEN).toBe('ghp_realtoken')
  })
})

describe('a reached gh is unauthenticated (no-shell spawn)', () => {
  const token = (env: NodeJS.ProcessEnv) =>
    spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', env, timeout: 20000 })

  it('prints only the sentinel, or is the failing shim', () => {
    const r = token(process.env)
    const out = `${r.stdout}${r.stderr}`
    expect(REAL_TOKEN.test(out)).toBe(false) // boolean: a failure must not echo a token
    if (r.status === 0) expect(r.stdout.trim()).toBe(SENTINEL)
  })

  it('holds with GH_HOST=github.com', () => {
    const r = token({ ...process.env, GH_HOST: 'github.com' })
    expect(REAL_TOKEN.test(`${r.stdout}${r.stderr}`)).toBe(false)
    if (r.status === 0) expect(r.stdout.trim()).toBe(SENTINEL)
  })

  it('git credential fill for github.com yields the sentinel or nothing', () => {
    const r = spawnSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    })
    expect(REAL_TOKEN.test(`${r.stdout}${r.stderr}`)).toBe(false)
    const pw = /^password=(.*)$/m.exec(r.stdout)?.[1]
    if (pw !== undefined) expect(pw.trim()).toBe(SENTINEL)
  })
})

describe('setup lifecycle', () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })

  it('reinstalls when HB_NO_REAL_GH_DIR is stale (missing on disk)', () => {
    process.env.HB_NO_REAL_GH_DIR = path.join(os.tmpdir(), 'hb-nogh-stale-does-not-exist')
    const teardown = setup()
    expect(teardown).toBeTypeOf('function')
    const dir = process.env.HB_NO_REAL_GH_DIR!
    expect(dir).not.toContain('stale-does-not-exist')
    expect(fs.existsSync(dir)).toBe(true)
    expect(process.env.PATH!.startsWith(dir + path.delimiter)).toBe(true)
    ;(teardown as () => void)()
    expect(fs.existsSync(dir)).toBe(false)
    expect(process.env.HB_NO_REAL_GH_DIR).toBeUndefined()
  })

  it('reinstalls when the dir exists but is not first on PATH', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-nogh-notfirst-'))
    process.env.HB_NO_REAL_GH_DIR = d.replaceAll(path.sep, '/')
    const teardown = setup()
    const dir = process.env.HB_NO_REAL_GH_DIR!
    expect(dir).not.toBe(d.replaceAll(path.sep, '/'))
    ;(teardown as () => void)()
    fs.rmSync(d, { recursive: true, force: true })
  })

  it('is idempotent when installed and first on PATH', () => {
    expect(setup()).toBeUndefined()
  })
})
