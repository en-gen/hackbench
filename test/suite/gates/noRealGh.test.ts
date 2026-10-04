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

const REAL_TOKEN = /gh[opsu]_|github_pat_/
const isSentinel = (v: string | undefined) => v === SENTINEL

describe('guardEnv (pure)', () => {
  const real = Object.fromEntries(TOKEN_VARS.map(v => [v, 'ghp_realtoken']))
  const out = guardEnv({ ...real, GH_HOST: 'github.com', KEEP: '1' }, '/cfg')

  it('replaces all four tokens with the sentinel', () => {
    for (const v of TOKEN_VARS) expect(isSentinel(out[v])).toBe(true)
    expect(REAL_TOKEN.test(JSON.stringify(out))).toBe(false)
  })
  it('appends to an existing GIT_CONFIG_COUNT and does not stack on a second pass', () => {
    const o = guardEnv(
      { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' },
      '/cfg',
    )
    expect(o.GIT_CONFIG_COUNT).toBe('2')
    expect(o.GIT_CONFIG_KEY_0).toBe('a.b')
    expect(o.GIT_CONFIG_KEY_1).toBe('credential.helper')
    expect(o.GIT_CONFIG_VALUE_1).toBe('')
    expect(guardEnv(o, '/cfg').GIT_CONFIG_COUNT).toBe('2')
  })
  it('disables prompting and askpass', () => {
    const o = guardEnv({ GIT_ASKPASS: '/x', SSH_ASKPASS: '/y' }, '/cfg')
    expect(o.GIT_TERMINAL_PROMPT).toBe('0')
    expect(o.GIT_ASKPASS).toBe('')
    expect(o.SSH_ASKPASS).toBe('')
  })
  it('appends when an EARLIER entry is an empty helper and a later one is not', () => {
    const o = guardEnv(
      {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: 'manager',
      },
      '/cfg',
    )
    expect(o.GIT_CONFIG_COUNT).toBe('3')
    expect(o.GIT_CONFIG_VALUE_1).toBe('manager')
    expect(o.GIT_CONFIG_VALUE_2).toBe('')
  })
  it('keeps a parent safe.directory at 0 and adds the helper at 1', () => {
    const o = guardEnv(
      { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' },
      '/cfg',
    )
    expect(o.GIT_CONFIG_KEY_0).toBe('safe.directory')
    expect(o.GIT_CONFIG_VALUE_0).toBe('*')
    expect(o.GIT_CONFIG_KEY_1).toBe('credential.helper')
    expect(o.GIT_CONFIG_COUNT).toBe('2')
  })
  it('appends when the parent helper is manager', () => {
    const o = guardEnv(
      {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: 'manager',
      },
      '/cfg',
    )
    expect(o.GIT_CONFIG_COUNT).toBe('2')
    expect(o.GIT_CONFIG_VALUE_0).toBe('manager')
    expect(o.GIT_CONFIG_KEY_1).toBe('credential.helper')
    expect(o.GIT_CONFIG_VALUE_1).toBe('')
  })
  it.each(['-1', 'abc', '1000', '99999999999', '1.5', ''])('rejects GIT_CONFIG_COUNT=%j', c => {
    if (c === '')
      return expect(guardEnv({ GIT_CONFIG_COUNT: c }, '/cfg').GIT_CONFIG_COUNT).toBe('1')
    expect(() => guardEnv({ GIT_CONFIG_COUNT: c }, '/cfg')).toThrow(/GIT_CONFIG_COUNT/)
  })
  it('sets the config dir, keeps other variables, does not mutate its input', () => {
    expect(out.GH_CONFIG_DIR).toBe('/cfg')
    expect(out.GH_HOST).toBe('github.com')
    expect(out.KEEP).toBe('1')
    expect(real.GH_TOKEN).toBe('ghp_realtoken')
  })
})

describe('a reached gh is unauthenticated (no-shell spawn)', { timeout: 90000 }, () => {
  const token = (env: NodeJS.ProcessEnv) =>
    spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', env, timeout: 20000 })

  it('prints only the sentinel, or is the failing shim', () => {
    const r = token(process.env)
    const out = `${r.stdout}${r.stderr}`
    expect(REAL_TOKEN.test(out)).toBe(false) // boolean: a failure must not echo a token
    if (r.status === 0) expect(isSentinel(r.stdout.trim())).toBe(true)
  })

  it('holds with GH_HOST=github.com', () => {
    const r = token({ ...process.env, GH_HOST: 'github.com' })
    expect(REAL_TOKEN.test(`${r.stdout}${r.stderr}`)).toBe(false)
    if (r.status === 0) expect(isSentinel(r.stdout.trim())).toBe(true)
  })

  it('git credential fill finds no password even with a global helper that supplies one', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-home-'))
    try {
      fs.writeFileSync(
        path.join(home, '.gitconfig'),
        '[credential]\n\thelper = "!f() { echo password=fake-helper-pw; }; f"\n',
      )
      const r = spawnSync('git', ['credential', 'fill'], {
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8',
        timeout: 20000,
        env: { ...process.env, HOME: home, USERPROFILE: home },
      })
      expect(/^password=/m.test(r.stdout)).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('git credential fill gets no password from an askpass program', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-home-'))
    try {
      const ask = path.join(home, 'ask.sh').replaceAll(path.sep, '/')
      fs.writeFileSync(ask, '#!/bin/sh\necho fake-askpass-pw\n', { mode: 0o755 })
      const base = { ...process.env, HOME: home, USERPROFILE: home }
      const cases: Array<[NodeJS.ProcessEnv, string[]]> = [
        [{ ...base, GIT_ASKPASS: ask }, []],
        [{ ...base, SSH_ASKPASS: ask }, []],
        [{ ...base }, ['-c', `core.askPass=${ask}`]],
      ]
      for (const [e, cfg] of cases) {
        const r = spawnSync('git', [...cfg, 'credential', 'fill'], {
          input: 'protocol=https\nhost=github.com\n\n',
          encoding: 'utf8',
          timeout: 20000,
          env: { ...guardEnv(e, home), GCM_INTERACTIVE: 'never' },
        })
        expect(/^password=fake-askpass-pw/m.test(r.stdout)).toBe(false)
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
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
    if (pw !== undefined) expect(isSentinel(pw.trim())).toBe(true)
  })
})

describe('setup lifecycle', () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })

  it('reinstalls when HB_NO_REAL_GH_DIR is stale (missing on disk)', () => {
    const missing = path.join(os.tmpdir(), 'hb-nogh-stale-does-not-exist').replaceAll(path.sep, '/')
    process.env.HB_NO_REAL_GH_DIR = missing
    process.env.PATH = missing + path.delimiter + process.env.PATH // leads PATH, so only existsSync can reject it
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
    try {
      const teardown = setup()
      const dir = process.env.HB_NO_REAL_GH_DIR!
      expect(dir).not.toBe(d.replaceAll(path.sep, '/'))
      ;(teardown as () => void)()
    } finally {
      fs.rmSync(d, { recursive: true, force: true })
    }
  })

  it('is idempotent when installed and first on PATH', () => {
    expect(setup()).toBeUndefined()
  })

  it('re-applies the env on the early return (blank and deleted tokens)', () => {
    process.env.GH_TOKEN = ''
    delete process.env.GITHUB_TOKEN
    expect(setup()).toBeUndefined()
    for (const v of TOKEN_VARS) expect(isSentinel(process.env[v])).toBe(true)
  })
})
