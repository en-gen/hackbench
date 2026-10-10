/**
 * Proves the suite-wide guard (test/suite/support/noRealGh.ts) leaves no
 * AUTHENTICATED gh reachable (issue #486). Offline only: with the sentinel
 * token set, gh and git-credential never reach the network for these calls.
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import setup, { assertGuardActive, guardEnv, SENTINEL, TOKEN_VARS } from '../support/noRealGh'
import { expectGhReachedOrAbsent } from '../support/ghSpawnReached'

// Hardcoded on purpose: importing TOKEN_VARS would let a dropped name pass unseen.
const FOUR_TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']
const LEAK_HELPER = '!f() { echo username=u; echo password=LEAK; }; f'
const REAL_TOKEN = /gh[opsu]_|github_pat_/
const isSentinel = (v: string | undefined) => v === SENTINEL
const credFill = (env: NodeJS.ProcessEnv, args: string[] = []) =>
  spawnSync('git', [...args, 'credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    timeout: 20000,
    env,
  })

describe('guardEnv (pure)', () => {
  const real = Object.fromEntries(TOKEN_VARS.map(v => [v, 'ghp_realtoken']))
  const out = guardEnv({ ...real, GH_HOST: 'github.com', KEEP: '1' }, '/cfg')

  it('replaces all four tokens with the sentinel', () => {
    for (const v of TOKEN_VARS) expect(isSentinel(out[v])).toBe(true)
    expect(REAL_TOKEN.test(JSON.stringify(out))).toBe(false)
  })
  it('sets all four hardcoded token names to the sentinel', () => {
    const o = guardEnv({}, '/cfg')
    for (const v of FOUR_TOKENS) expect(isSentinel(o[v])).toBe(true)
  })
  it('appends the reset to GIT_CONFIG_PARAMETERS, keeping entries, once', () => {
    const o = guardEnv({ GIT_CONFIG_PARAMETERS: "'a.b'='c'" }, '/cfg')
    expect(o.GIT_CONFIG_PARAMETERS).toBe("'a.b'='c' 'credential.helper'=''")
    expect(guardEnv(o, '/cfg').GIT_CONFIG_PARAMETERS).toBe(o.GIT_CONFIG_PARAMETERS)
    expect(guardEnv({}, '/cfg').GIT_CONFIG_PARAMETERS).toBe("'credential.helper'=''")
  })
  it.each(['Credential.Helper', 'credential.HELPER', 'credential.https://github.com.helper'])(
    'last entry %j with an empty value: appends only when URL-scoped',
    key => {
      const o = guardEnv(
        { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: '' },
        '/cfg',
      )
      // Case spellings are the same variable to git, so only the URL-scoped one must append.
      expect(o.GIT_CONFIG_COUNT).toBe(key.includes('://') ? '2' : '1')
    },
  )
  it('skips the append only for an exact empty credential.helper as the last entry', () => {
    const o = guardEnv(
      { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' },
      '/cfg',
    )
    expect(o.GIT_CONFIG_COUNT).toBe('1')
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
  it.each(['-1', 'abc', '1000', '99999999999', '1.5'])('rejects GIT_CONFIG_COUNT=%j', c => {
    expect(() => guardEnv({ GIT_CONFIG_COUNT: c }, '/cfg')).toThrow(/GIT_CONFIG_COUNT/)
  })
  it('treats an empty GIT_CONFIG_COUNT as zero', () => {
    expect(guardEnv({ GIT_CONFIG_COUNT: '' }, '/cfg').GIT_CONFIG_COUNT).toBe('1')
  })
  it('sets the config dir, keeps other variables, does not mutate its input', () => {
    expect(out.GH_CONFIG_DIR).toBe('/cfg')
    expect(out.GH_HOST).toBe('github.com')
    expect(out.KEEP).toBe('1')
    expect(real.GH_TOKEN).toBe('ghp_realtoken')
  })
})

describe('a reached gh is unauthenticated (no-shell spawn)', { timeout: 90000 }, () => {
  // The 20 s kill fired in 2 of 10 loaded runs (186 ms idle), and a killed spawn
  // has no output and a null status, which passed every check below vacuously.
  const token = (env: NodeJS.ProcessEnv) => {
    const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', env, timeout: 60_000 })
    expectGhReachedOrAbsent(r)
    return r
  }

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
      fs.writeFileSync(path.join(home, '.gitconfig'), `[credential]\n\thelper = "${LEAK_HELPER}"\n`)
      const r = credFill({ ...process.env, HOME: home, USERPROFILE: home })
      expect(/^password=/m.test(r.stdout)).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it.each([
    [
      'GIT_CONFIG_PARAMETERS (git -c exports this)',
      { GIT_CONFIG_PARAMETERS: `'credential.helper'='${LEAK_HELPER}'` },
    ],
    [
      'a URL-scoped helper as the last GIT_CONFIG entry',
      {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
        GIT_CONFIG_VALUE_0: LEAK_HELPER,
      },
    ],
    [
      'a mixed-case helper key as the last GIT_CONFIG entry',
      {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'Credential.Helper',
        GIT_CONFIG_VALUE_0: LEAK_HELPER,
      },
    ],
  ])('git credential fill gets no password from %s', (_n, extra) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-home-'))
    try {
      const e = guardEnv({ ...process.env, HOME: home, USERPROFILE: home, ...extra }, home)
      const r = credFill({ ...e, GCM_INTERACTIVE: 'never' })
      expect(/^password=LEAK/m.test(r.stdout)).toBe(false)
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
        const r = credFill({ ...guardEnv(e, home), GCM_INTERACTIVE: 'never' }, cfg)
        expect(/^password=fake-askpass-pw/m.test(r.stdout)).toBe(false)
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('git credential fill for github.com yields the sentinel or nothing', () => {
    const r = credFill({ ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' })
    expect(REAL_TOKEN.test(`${r.stdout}${r.stderr}`)).toBe(false)
    const pw = /^password=(.*)$/m.exec(r.stdout)?.[1]
    if (pw !== undefined) expect(isSentinel(pw.trim())).toBe(true)
  })
})

describe('setup lifecycle', () => {
  const saved = { ...process.env }
  // A failed assertion before an explicit teardown used to strand the shim dir.
  const made: string[] = []
  const install = () => {
    const t = setup()
    if (t) made.push(process.env.HB_NO_REAL_GH_DIR!)
    return t
  }
  afterEach(() => {
    for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })

  it('reinstalls when HB_NO_REAL_GH_DIR is stale (missing on disk)', () => {
    const missing = path.join(os.tmpdir(), 'hb-nogh-stale-does-not-exist').replaceAll(path.sep, '/')
    process.env.HB_NO_REAL_GH_DIR = missing
    process.env.PATH = missing + path.delimiter + process.env.PATH // leads PATH, so only existsSync can reject it
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sibling-'))
    made.push(sibling)
    const teardown = install()
    expect(teardown).toBeTypeOf('function')
    const dir = process.env.HB_NO_REAL_GH_DIR!
    expect(dir).not.toContain('stale-does-not-exist')
    expect(fs.existsSync(dir)).toBe(true)
    expect(process.env.PATH!.startsWith(dir + path.delimiter)).toBe(true)
    ;(teardown as () => void)()
    expect(fs.existsSync(dir)).toBe(false)
    expect(process.env.HB_NO_REAL_GH_DIR).toBeUndefined()
    expect(fs.existsSync(sibling)).toBe(true) // teardown removes only the dir it made
  })

  it('reinstalls when the dir exists but is not first on PATH', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-nogh-notfirst-'))
    process.env.HB_NO_REAL_GH_DIR = d.replaceAll(path.sep, '/')
    try {
      const teardown = install()
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

  it.each([
    ['changed', '/elsewhere'],
    ['deleted', undefined],
  ])('restores the guard-owned config dir on reuse when GH_CONFIG_DIR is %s', (_n, v) => {
    const dir = process.env.HB_NO_REAL_GH_DIR!
    if (v === undefined) delete process.env.GH_CONFIG_DIR
    else process.env.GH_CONFIG_DIR = v
    expect(setup()).toBeUndefined()
    const cfg = process.env.GH_CONFIG_DIR!.replaceAll(path.sep, '/')
    expect(path.dirname(cfg)).toBe(dir)
    expect(path.basename(cfg).startsWith('config-')).toBe(true)
    expect(fs.readdirSync(cfg)).toEqual([]) // empty, so gh finds no stored login
  })

  it('re-applies the env on the early return (blank and deleted tokens)', () => {
    process.env.GH_TOKEN = ''
    delete process.env.GITHUB_TOKEN
    expect(setup()).toBeUndefined()
    for (const v of TOKEN_VARS) expect(isSentinel(process.env[v])).toBe(true)
  })
})

describe('assertGuardActive (pure, fake dirs only)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ag-')).replaceAll(path.sep, '/')
  fs.writeFileSync(path.join(dir, 'gh'), '')
  fs.writeFileSync(path.join(dir, 'gh.cmd'), '')
  const good: NodeJS.ProcessEnv = {
    HB_NO_REAL_GH_DIR: dir,
    PATH: dir + path.delimiter + '/usr/bin',
    GH_TOKEN: SENTINEL,
  }
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('accepts a real guard environment', () => {
    expect(() => assertGuardActive(good)).not.toThrow()
  })
  it.each([
    ['missing marker var', { ...good, HB_NO_REAL_GH_DIR: undefined }],
    ['dir not first on PATH', { ...good, PATH: '/usr/bin' + path.delimiter + dir }],
    [
      'forged dir that does not exist',
      { ...good, HB_NO_REAL_GH_DIR: '/forged', PATH: '/forged' + path.delimiter + '/usr/bin' },
    ],
    ['absent token', { ...good, GH_TOKEN: undefined }],
    ['wrong token', { ...good, GH_TOKEN: 'something-else' }],
  ])('throws for %s', (_n, env) => {
    expect(() => assertGuardActive(env)).toThrow(/guard inactive/)
  })
  it.each([[[]], [['gh']], [['gh.cmd']]])('throws when the dir holds only %j', shims => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ag2-')).replaceAll(path.sep, '/')
    try {
      for (const f of shims) fs.writeFileSync(path.join(d, f), '')
      const env = { ...good, HB_NO_REAL_GH_DIR: d, PATH: d + path.delimiter + 'x' }
      expect(() => assertGuardActive(env)).toThrow(/guard inactive/)
    } finally {
      fs.rmSync(d, { recursive: true, force: true })
    }
  })
})
