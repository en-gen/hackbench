import { describe, it, expect, afterEach } from 'vitest'
import { parseProtocolFile, HEADINGS, MAX_CHANGES_LINES } from '../../../tools/scripts/protocol.mjs'

function protocol(overrides: Partial<Record<string, string>> = {}, stem = 'alpha'): string {
  const s: Record<string, string> = {
    h1: `# ${stem}`,
    Purpose: 'One line.',
    Group: 'none',
    Activation: 'The owner.',
    Changes: '1. First.\n2. Second.',
    Unchanged: 'Everything else.',
    Exit: 'The owner turns it off.',
    ...overrides,
  }
  return [s.h1, ...HEADINGS.map((h: string) => `## ${h}\n\n${s[h]}`)].join('\n\n') + '\n'
}

describe('parseProtocolFile', () => {
  it('parses a well-formed file', () => {
    const def = parseProtocolFile(protocol(), 'alpha')
    expect(def).toEqual({
      name: 'alpha',
      group: null,
      isDefault: false,
      blocked: null,
      changes: ['1. First.', '2. Second.'],
    })
  })

  it('reads a group and its default marker', () => {
    expect(parseProtocolFile(protocol({ Group: 'shift' }), 'alpha').group).toBe('shift')
    const d = parseProtocolFile(protocol({ Group: 'shift (default)' }), 'alpha')
    expect(d.group).toBe('shift')
    expect(d.isDefault).toBe(true)
  })

  it('accepts Windows line endings', () => {
    const def = parseProtocolFile(protocol().replace(/\n/g, '\r\n'), 'alpha')
    expect(def.changes).toEqual(['1. First.', '2. Second.'])
  })

  it('rejects an H1 that is not the file stem', () => {
    expect(() => parseProtocolFile(protocol({ h1: '# beta' }), 'alpha')).toThrow(/alpha.*H1/)
  })

  it('rejects headings out of order', () => {
    const text = protocol().replace('## Group', '## Zzz').replace('## Exit', '## Group')
    expect(() => parseProtocolFile(text, 'alpha')).toThrow(/headings/)
  })

  it('rejects a missing heading', () => {
    const text = protocol().replace(/## Unchanged\n\n[^\n]*\n\n/, '')
    expect(() => parseProtocolFile(text, 'alpha')).toThrow(/headings/)
  })

  it('rejects a Changes list over the limit', () => {
    const lines = Array.from({ length: MAX_CHANGES_LINES + 1 }, (_, i) => `${i + 1}. Line.`).join(
      '\n',
    )
    expect(() => parseProtocolFile(protocol({ Changes: lines }), 'alpha')).toThrow(/Changes has 16/)
  })

  it('rejects an unnumbered Changes line', () => {
    expect(() =>
      parseProtocolFile(protocol({ Changes: '1. Ok.\n- not numbered' }), 'alpha'),
    ).toThrow(/numbered/)
  })

  it('rejects a malformed Group line', () => {
    expect(() => parseProtocolFile(protocol({ Group: 'Shift Group' }), 'alpha')).toThrow(
      /Group must be/,
    )
  })
})

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadProtocols, groupDefaults, defaultState } from '../../../tools/scripts/protocol.mjs'

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

function tempDir(prefix: string): string {
  return mk(prefix)
}

function writeProtocols(dir: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, `${name}.md`), body)
  }
}

describe('loadProtocols', () => {
  it('loads every protocol file except README.md, sorted', () => {
    const dir = tempDir('protocols-')
    writeProtocols(dir, {
      README: '# Protocols\n',
      night: protocol({ Group: 'shift' }, 'night'),
      day: protocol({ Group: 'shift (default)' }, 'day'),
      throttle: protocol({}, 'throttle'),
    })
    const defs = loadProtocols(dir)
    expect([...defs.keys()]).toEqual(['day', 'night', 'throttle'])
    expect(groupDefaults(defs)).toEqual(new Map([['shift', 'day']]))
    expect(defaultState(defs)).toEqual({ active: ['day'], changed: null, by: null })
  })

  it('rejects two defaults in one group', () => {
    const dir = tempDir('protocols-')
    writeProtocols(dir, {
      a: protocol({ Group: 'shift (default)' }, 'a'),
      b: protocol({ Group: 'shift (default)' }, 'b'),
    })
    expect(() => loadProtocols(dir)).toThrow(/group shift has two defaults/)
  })

  it('loads the real protocol files and finds day-shift as the shift default', () => {
    const repoRoot = path.resolve(__dirname, '../../..')
    const defs = loadProtocols(path.join(repoRoot, 'docs/protocols'))
    expect(groupDefaults(defs).get('shift')).toBe('day-shift')
    expect(defs.has('night-shift')).toBe(true)
    expect(defs.has('throttle')).toBe(true)
  })
})

import {
  readState,
  readStateChecked,
  applyChange,
  writeState,
} from '../../../tools/scripts/protocol.mjs'

function shiftDefs() {
  const dir = tempDir('protocols-')
  writeProtocols(dir, {
    day: protocol({ Group: 'shift (default)' }, 'day'),
    night: protocol({ Group: 'shift' }, 'night'),
    throttle: protocol({}, 'throttle'),
  })
  return loadProtocols(dir)
}
const NOW = '2026-10-07T21:00:00.000Z'

describe('readState', () => {
  it('returns the defaults when no state file exists', () => {
    expect(readState(tempDir('state-'), shiftDefs())).toEqual({
      active: ['day'],
      changed: null,
      by: null,
    })
  })

  it('drops an unknown name and restores a missing group default', () => {
    const dir = tempDir('state-')
    fs.writeFileSync(
      path.join(dir, 'protocols.json'),
      JSON.stringify({ active: ['ghost', 'throttle'], changed: NOW, by: 'x' }),
    )
    expect(readState(dir, shiftDefs()).active).toEqual(['day', 'throttle'])
  })
})

describe('applyChange', () => {
  it('refuses an unknown protocol', () => {
    const r = applyChange(defaultState(shiftDefs()), shiftDefs(), 'bogus', 'on', 'owner', NOW)
    expect(r).toEqual({
      error: expect.stringMatching(/unknown protocol "bogus"; known: day, night, throttle/),
    })
  })

  it('swaps the sibling out when a grouped protocol turns on', () => {
    const defs = shiftDefs()
    const r = applyChange(defaultState(defs), defs, 'night', 'on', 'owner', NOW)
    expect(r.state).toEqual({ active: ['night'], changed: NOW, by: 'owner' })
    expect(r.logLine).toBe(`${NOW} night on by owner (replaced day)`)
  })

  it('restores the group default when a grouped protocol turns off', () => {
    const defs = shiftDefs()
    const r = applyChange(
      { active: ['night'], changed: NOW, by: 'owner' },
      defs,
      'night',
      'off',
      'owner',
      NOW,
    )
    expect(r.state.active).toEqual(['day'])
    expect(r.logLine).toBe(`${NOW} night off by owner (restored day)`)
  })

  it('refuses to turn off a group default', () => {
    const defs = shiftDefs()
    const r = applyChange(defaultState(defs), defs, 'day', 'off', 'owner', NOW)
    expect(r).toEqual({
      error: expect.stringMatching(/day is the default of group shift; turn on night instead/),
    })
  })

  it('stacks an ungrouped protocol and removes it cleanly', () => {
    const defs = shiftDefs()
    const on = applyChange(defaultState(defs), defs, 'throttle', 'on', 'session:abc', NOW)
    expect(on.state.active).toEqual(['day', 'throttle'])
    expect(on.logLine).toBe(`${NOW} throttle on by session:abc`)
    const off = applyChange(on.state, defs, 'throttle', 'off', 'owner', NOW)
    expect(off.state.active).toEqual(['day'])
  })

  it('refuses to turn off something inactive and rejects a bad verb', () => {
    const defs = shiftDefs()
    expect(applyChange(defaultState(defs), defs, 'throttle', 'off', 'owner', NOW)).toEqual({
      error: 'throttle is not active',
    })
    expect(applyChange(defaultState(defs), defs, 'throttle', 'maybe', 'owner', NOW)).toEqual({
      error: 'verb must be on or off',
    })
  })
})

describe('writeState', () => {
  it('creates the directory, writes the file and appends the log', () => {
    const dir = path.join(tempDir('state-'), 'nested')
    writeState(
      dir,
      { active: ['night'], changed: NOW, by: 'owner' },
      `${NOW} night on by owner (replaced day)`,
    )
    writeState(
      dir,
      { active: ['day'], changed: NOW, by: 'owner' },
      `${NOW} night off by owner (restored day)`,
    )
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'protocols.json'), 'utf8')).active).toEqual([
      'day',
    ])
    expect(
      fs.readFileSync(path.join(dir, 'protocols.log'), 'utf8').split('\n').filter(Boolean),
    ).toHaveLength(2)
  })
})

import { execFileSync, spawn } from 'child_process'
import { pathToFileURL } from 'url'
import {
  mainCheckoutDir,
  stateDirFor,
  protocolsDirFor,
  readSessions,
  registerSession,
  withStateLock,
  unregisterSession,
  LOCK_DEFAULTS,
} from '../../../tools/scripts/protocol.mjs'

describe('mainCheckoutDir', () => {
  it('resolves a worktree to the main checkout', () => {
    const main = tempDir('main-')
    execFileSync('git', ['init', '-q', main])
    execFileSync('git', ['-C', main, 'commit', '-q', '--allow-empty', '-m', 'root'], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    })
    const wt = path.join(tempDir('wt-'), 'w')
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', wt])
    expect(fs.realpathSync(mainCheckoutDir(wt))).toBe(fs.realpathSync(main))
    expect(fs.realpathSync(mainCheckoutDir(main))).toBe(fs.realpathSync(main))
  })

  it('falls back to cwd outside git', () => {
    const dir = tempDir('nogit-')
    expect(mainCheckoutDir(dir)).toBe(dir)
  })
})

describe('directory overrides', () => {
  it('honour the environment variables', () => {
    try {
      process.env.HACKBENCH_STATE_DIR = '/tmp/x'
      process.env.HACKBENCH_PROTOCOLS_DIR = '/tmp/y'
      expect(stateDirFor('.')).toBe('/tmp/x')
      expect(protocolsDirFor('.')).toBe('/tmp/y')
    } finally {
      delete process.env.HACKBENCH_STATE_DIR
      delete process.env.HACKBENCH_PROTOCOLS_DIR
    }
    expect(protocolsDirFor('/repo')).toBe(path.join('/repo', 'docs', 'protocols'))
  })
})

const CLI_ID = '2b245891-c391-4d73-9647-b5b41cea6c49'
const CLI_ID_2 = '774e2af5-0000-4000-8000-000000000002'
const LOCAL_ID = 'local_774e2af5-aaaa-4bbb-8ccc-000000000001'
const LOCAL_ID_2 = 'local_774e2af5-aaaa-4bbb-8ccc-000000000002'

describe('sessions', () => {
  it('registers both ids and reads back', () => {
    const dir = tempDir('state-')
    expect(readSessions(dir)).toEqual({})
    registerSession(dir, CLI_ID, LOCAL_ID, 'tech-lead', 'alpha', NOW)
    const all = registerSession(dir, CLI_ID_2, LOCAL_ID_2, 'ba', null, NOW)
    expect(all).toEqual({
      [CLI_ID]: { desktopId: LOCAL_ID, role: 'tech-lead', team: 'alpha', registered: NOW },
      [CLI_ID_2]: { desktopId: LOCAL_ID_2, role: 'ba', team: null, registered: NOW },
    })
    expect(readSessions(dir)).toEqual(all)
  })

  it('rejects an unknown role and a tech lead without a team', () => {
    const dir = tempDir('state-')
    expect(() => registerSession(dir, CLI_ID, LOCAL_ID, 'pm', null, NOW)).toThrow(
      /role must be ba, tech-lead or both/,
    )
    expect(() => registerSession(dir, CLI_ID, LOCAL_ID, 'tech-lead', null, NOW)).toThrow(
      /needs a team/,
    )
  })

  it('rejects a malformed CLI id, desktop id or team name', () => {
    const dir = tempDir('state-')
    expect(() => registerSession(dir, 'nope', LOCAL_ID, 'ba', null, NOW)).toThrow(/CLI session id/)
    expect(() => registerSession(dir, CLI_ID, CLI_ID, 'ba', null, NOW)).toThrow(/desktop id/)
    expect(() => registerSession(dir, CLI_ID, LOCAL_ID, 'tech-lead', 'Alpha Team', NOW)).toThrow(
      /team name/,
    )
  })

  it('never creates or touches a state file', () => {
    const dir = tempDir('state-')
    registerSession(dir, CLI_ID, LOCAL_ID, 'tech-lead', 'alpha', NOW)
    expect(fs.readdirSync(dir)).toEqual(['sessions.json'])
  })

  it('reads anything that is not a plain object as no sessions', () => {
    const dir = tempDir('state-')
    for (const body of ['[]', 'null', '"x"', '{bad', '﻿[1]']) {
      fs.writeFileSync(path.join(dir, 'sessions.json'), body)
      expect(readSessions(dir)).toEqual({})
    }
  })

  it('reads a sessions file that starts with a BOM', () => {
    const dir = tempDir('state-')
    const body = { [CLI_ID]: { desktopId: LOCAL_ID, role: 'ba', team: null, registered: NOW } }
    fs.writeFileSync(path.join(dir, 'sessions.json'), '﻿' + JSON.stringify(body))
    expect(readSessions(dir)).toEqual(body)
  })
})

describe('state hardening', () => {
  it('applyChange sorts the active set even from an unsorted state', () => {
    const defs = shiftDefs()
    const r = applyChange(
      { active: ['throttle', 'day'], changed: null, by: null },
      defs,
      'night',
      'on',
      'owner',
      NOW,
    )
    expect(r.state.active).toEqual(['night', 'throttle'])
  })

  it('keeps the first non-default member when two group members are active', () => {
    const dir = tempDir('state-')
    fs.writeFileSync(
      path.join(dir, 'protocols.json'),
      JSON.stringify({ active: ['night', 'day'], changed: NOW, by: 'x' }),
    )
    expect(readState(dir, shiftDefs()).active).toEqual(['night'])
    const defs = shiftDefs()
    const two = mk('state-')
    fs.writeFileSync(
      path.join(two, 'protocols.json'),
      JSON.stringify({ active: ['day', 'night'], changed: NOW, by: 'x' }),
    )
    expect(readState(two, defs).active).toEqual(['night'])
  })

  it('reads a state file that starts with a BOM', () => {
    const dir = tempDir('state-')
    fs.writeFileSync(
      path.join(dir, 'protocols.json'),
      '﻿' + JSON.stringify({ active: ['night'], changed: NOW, by: 'x' }),
    )
    const r = readStateChecked(dir, shiftDefs())
    expect(r.state.active).toEqual(['night'])
    expect(r.warning).toBeNull()
  })

  it('warns when the state file is unreadable and applies the defaults', () => {
    const dir = tempDir('state-')
    fs.writeFileSync(path.join(dir, 'protocols.json'), '{bad')
    const r = readStateChecked(dir, shiftDefs())
    expect(r.state.active).toEqual(['day'])
    expect(r.warning).toBe('protocols.json unreadable, defaults applied')
  })

  it('does not warn when there is no state file', () => {
    expect(readStateChecked(tempDir('state-'), shiftDefs()).warning).toBeNull()
  })

  it('writes the state through a temp file and leaves no stray files', () => {
    const dir = tempDir('state-')
    writeState(dir, { active: ['day'], changed: NOW, by: 'owner' }, `${NOW} x`)
    expect(fs.readdirSync(dir).sort()).toEqual(['protocols.json', 'protocols.log'])
  })

  it('loads a protocol file that starts with a BOM', () => {
    const dir = tempDir('protocols-')
    writeProtocols(dir, { day: '﻿' + protocol({ Group: 'shift (default)' }, 'day') })
    expect(loadProtocols(dir).get('day')?.isDefault).toBe(true)
  })
})

describe('parser hardening', () => {
  it('accepts a Changes list of exactly the limit', () => {
    const lines = Array.from({ length: MAX_CHANGES_LINES }, (_, i) => `${i + 1}. Line.`).join('\n')
    expect(parseProtocolFile(protocol({ Changes: lines }), 'alpha').changes).toHaveLength(
      MAX_CHANGES_LINES,
    )
  })

  it('rejects a duplicated heading', () => {
    const text = protocol().replace('## Exit', '## Group\n\nshift\n\n## Exit')
    expect(() => parseProtocolFile(text, 'alpha')).toThrow(/headings/)
  })

  it('rejects "none (default)"', () => {
    expect(() => parseProtocolFile(protocol({ Group: 'none (default)' }), 'alpha')).toThrow(
      /Group must be/,
    )
  })

  it('rejects an empty Changes section', () => {
    expect(() => parseProtocolFile(protocol({ Changes: '' }), 'alpha')).toThrow(/Changes is empty/)
  })

  it('rejects a Changes line over 200 characters', () => {
    const long = `1. ${'x'.repeat(199)}`
    expect(() => parseProtocolFile(protocol({ Changes: long }), 'alpha')).toThrow(/over 200/)
    expect(
      parseProtocolFile(protocol({ Changes: `1. ${'x'.repeat(197)}` }), 'alpha').changes,
    ).toHaveLength(1)
  })
})

describe('atomic writes survive a concurrent reader on Windows', () => {
  const STATE = { active: ['day'], changed: NOW, by: 'owner' }

  function errno(code: string): Error {
    return Object.assign(new Error(`${code}: operation not permitted, rename`), { code })
  }

  function tmpFiles(dir: string): string[] {
    return fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))
  }

  it('writes through a temp file and renames it over the target', () => {
    const dir = tempDir('state-')
    const calls: string[][] = []
    const rename = (from: string, to: string) => {
      calls.push([from, to])
      fs.renameSync(from, to)
    }
    writeState(dir, STATE, `${NOW} x`, { rename })
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toMatch(/\.tmp$/)
    expect(path.basename(calls[0][1])).toBe('protocols.json')
  })

  it('writes the sessions file through a temp file too', () => {
    const dir = tempDir('state-')
    const calls: string[][] = []
    const rename = (from: string, to: string) => {
      calls.push([from, to])
      fs.renameSync(from, to)
    }
    registerSession(dir, CLI_ID, LOCAL_ID, 'ba', null, NOW, { rename })
    expect(calls[0][0]).toMatch(/\.tmp$/)
    expect(path.basename(calls[0][1])).toBe('sessions.json')
  })

  it('retries EPERM and EBUSY, then succeeds and leaves no temp file', () => {
    const dir = tempDir('state-')
    let n = 0
    const rename = (from: string, to: string) => {
      n += 1
      if (n === 1) throw errno('EPERM')
      if (n === 2) throw errno('EBUSY')
      fs.renameSync(from, to)
    }
    writeState(dir, STATE, `${NOW} x`, { rename })
    expect(n).toBe(3)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'protocols.json'), 'utf8')).active).toEqual([
      'day',
    ])
    expect(tmpFiles(dir)).toEqual([])
    expect(fs.readFileSync(path.join(dir, 'protocols.log'), 'utf8')).toContain(`${NOW} x`)
  })

  it('gives up after 20 attempts, throws the original error and removes the temp file', () => {
    const dir = tempDir('state-')
    let n = 0
    const rename = () => {
      n += 1
      throw errno('EPERM')
    }
    expect(() => writeState(dir, STATE, `${NOW} x`, { rename })).toThrow(/EPERM/)
    expect(n).toBe(20)
    expect(tmpFiles(dir)).toEqual([])
    expect(fs.existsSync(path.join(dir, 'protocols.log'))).toBe(false)
  })

  it('does not retry an error that is not EPERM or EBUSY', () => {
    const dir = tempDir('state-')
    let n = 0
    const rename = () => {
      n += 1
      throw errno('ENOENT')
    }
    expect(() => writeState(dir, STATE, `${NOW} x`, { rename })).toThrow(/ENOENT/)
    expect(n).toBe(1)
    expect(tmpFiles(dir)).toEqual([])
  })
})

describe('re-registering after a clear', () => {
  it('drops every other entry with the same desktop id', () => {
    const dir = tempDir('state-')
    registerSession(dir, CLI_ID, LOCAL_ID, 'tech-lead', 'alpha', NOW)
    registerSession(dir, CLI_ID_2, LOCAL_ID_2, 'ba', null, NOW)
    const all = registerSession(
      dir,
      '00000000-0000-4000-8000-000000000003',
      LOCAL_ID,
      'tech-lead',
      'alpha',
      NOW,
    )
    expect(Object.keys(all).sort()).toEqual(
      [CLI_ID_2, '00000000-0000-4000-8000-000000000003'].sort(),
    )
  })
})

describe('withStateLock', () => {
  const protocolModule = path.resolve(__dirname, '../../../tools/scripts/protocol.mjs')

  it('runs the function, returns its value and removes the lock file', () => {
    const dir = tempDir('state-')
    expect(withStateLock(dir, () => 42)).toBe(42)
    expect(fs.existsSync(path.join(dir, '.lock'))).toBe(false)
  })

  it('removes the lock file when the function throws', () => {
    const dir = tempDir('state-')
    expect(() =>
      withStateLock(dir, () => {
        throw new Error('boom')
      }),
    ).toThrow(/boom/)
    expect(fs.existsSync(path.join(dir, '.lock'))).toBe(false)
  })

  it('gives up with a clear error while another holder keeps the lock', () => {
    const dir = tempDir('state-')
    expect(() => withStateLock(dir, () => withStateLock(dir, () => 1, { timeoutMs: 100 }))).toThrow(
      /could not lock/,
    )
  })

  it('waits until another process releases the lock', () => {
    const dir = tempDir('state-')
    const holder = spawn(
      'node',
      [
        '--input-type=module',
        '-e',
        `import { withStateLock } from ${JSON.stringify(pathToFileURL(protocolModule).href)}
         withStateLock(${JSON.stringify(dir)}, () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400))`,
      ],
      { stdio: 'ignore' },
    )
    const wait = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    for (let i = 0; i < 200 && !fs.existsSync(path.join(dir, '.lock')); i++) wait(10)
    expect(fs.existsSync(path.join(dir, '.lock'))).toBe(true)
    const started = Date.now()
    expect(withStateLock(dir, () => 'got it', { timeoutMs: 5000 })).toBe('got it')
    expect(Date.now() - started).toBeGreaterThan(150)
    holder.kill()
  })

  it('takes over a stale lock', () => {
    const dir = tempDir('state-')
    const lock = path.join(dir, '.lock')
    fs.writeFileSync(lock, '')
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lock, old, old)
    expect(withStateLock(dir, () => 'got it', { timeoutMs: 500 })).toBe('got it')
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('does not take over a fresh lock', () => {
    const dir = tempDir('state-')
    fs.writeFileSync(path.join(dir, '.lock'), '')
    expect(() => withStateLock(dir, () => 'x', { timeoutMs: 100 })).toThrow(/could not lock/)
  })
})

describe('withStateLock safety', () => {
  const lockPath = (dir: string) => path.join(dir, '.lock')
  const OLD = new Date(Date.now() - 60_000)

  function staleLock(dir: string, token = 'old-holder'): void {
    fs.writeFileSync(lockPath(dir), token)
    fs.utimesSync(lockPath(dir), OLD, OLD)
  }

  it('writes a token into the lock file while held', () => {
    const dir = tempDir('state-')
    withStateLock(dir, () => {
      expect(fs.readFileSync(lockPath(dir), 'utf8')).toMatch(/^\d+-[0-9a-f]{16}$/)
    })
  })

  it('lets only one of two waiters take over the same stale lock', () => {
    const dir = tempDir('state-')
    staleLock(dir)
    let ran = false
    let delayed = false
    // The first waiter has judged the lock stale; before it acts, another
    // process completes its own takeover and now holds a fresh lock.
    const afterStaleCheck = () => {
      if (delayed) return
      delayed = true
      fs.rmSync(lockPath(dir))
      fs.writeFileSync(lockPath(dir), 'taker-token')
    }
    expect(() =>
      withStateLock(
        dir,
        () => {
          ran = true
        },
        { timeoutMs: 300, staleMs: 30_000, afterStaleCheck },
      ),
    ).toThrow(/could not lock/)
    expect(ran).toBe(false)
    expect(fs.readFileSync(lockPath(dir), 'utf8')).toBe('taker-token')
  })

  it('leaves a lock alone that another holder took over, when the slow holder finishes', () => {
    const dir = tempDir('state-')
    withStateLock(dir, () => {
      fs.writeFileSync(lockPath(dir), 'new-holder')
    })
    expect(fs.readFileSync(lockPath(dir), 'utf8')).toBe('new-holder')
  })

  it('refuses to write once the lock was taken over', () => {
    const dir = tempDir('state-')
    expect(() =>
      withStateLock(dir, (assertHeld: () => void) => {
        assertHeld()
        fs.writeFileSync(lockPath(dir), 'new-holder')
        assertHeld()
      }),
    ).toThrow(/lock lost/)
  })

  it('registerSession writes nothing when its lock was taken over', () => {
    const dir = tempDir('state-')
    const afterAcquire = () => fs.writeFileSync(lockPath(dir), 'new-holder')
    expect(() =>
      registerSession(dir, CLI_ID, LOCAL_ID, 'ba', null, NOW, { lock: { afterAcquire } }),
    ).toThrow(/lock lost/)
    expect(fs.existsSync(path.join(dir, 'sessions.json'))).toBe(false)
  })

  it('registerSession renames while still holding the lock (L6)', () => {
    const dir = tempDir('state-')
    let held = false
    const rename = (from: string, to: string) => {
      held = fs.existsSync(lockPath(dir))
      fs.renameSync(from, to)
    }
    registerSession(dir, CLI_ID, LOCAL_ID, 'ba', null, NOW, { rename })
    expect(held).toBe(true)
  })

  it('outwaits a crashed lock and takes it over', () => {
    const dir = tempDir('state-')
    fs.writeFileSync(lockPath(dir), 'crashed') // mtime now, so only waiting makes it stale
    const started = Date.now()
    expect(withStateLock(dir, () => 'ok', { staleMs: 300, timeoutMs: 1000 })).toBe('ok')
    expect(Date.now() - started).toBeGreaterThan(250)
  })

  it('defaults to a timeout longer than the stale limit', () => {
    expect(LOCK_DEFAULTS.timeoutMs).toBeGreaterThan(LOCK_DEFAULTS.staleMs)
    expect(LOCK_DEFAULTS).toEqual({ timeoutMs: 15000, staleMs: 10000 })
  })

  it('treats a lock with a future mtime as stale once it is far enough off', () => {
    const dir = tempDir('state-')
    fs.writeFileSync(lockPath(dir), 'from-the-future')
    const ahead = new Date(Date.now() + 3_600_000)
    fs.utimesSync(lockPath(dir), ahead, ahead)
    expect(withStateLock(dir, () => 'ok', { staleMs: 300, timeoutMs: 1000 })).toBe('ok')
  })

  it('reads its limits from the environment when no option is given', () => {
    const dir = tempDir('state-')
    fs.writeFileSync(lockPath(dir), 'held')
    try {
      process.env.HACKBENCH_LOCK_TIMEOUT_MS = '150'
      expect(() => withStateLock(dir, () => 1)).toThrow(/within 150 ms/)
      process.env.HACKBENCH_LOCK_STALE_MS = '50'
      expect(withStateLock(dir, () => 'ok')).toBe('ok')
    } finally {
      delete process.env.HACKBENCH_LOCK_TIMEOUT_MS
      delete process.env.HACKBENCH_LOCK_STALE_MS
    }
  })
})

describe('unregisterSession', () => {
  it('removes every entry for a desktop id and keeps the others', () => {
    const dir = tempDir('state-')
    registerSession(dir, CLI_ID, LOCAL_ID, 'tech-lead', 'alpha', NOW)
    registerSession(dir, CLI_ID_2, LOCAL_ID_2, 'ba', null, NOW)
    const r = unregisterSession(dir, LOCAL_ID)
    expect(r.removed).toBe(1)
    expect(Object.keys(r.sessions)).toEqual([CLI_ID_2])
    expect(Object.keys(readSessions(dir))).toEqual([CLI_ID_2])
  })

  it('reports zero removed for an unknown desktop id and rejects a malformed one', () => {
    const dir = tempDir('state-')
    registerSession(dir, CLI_ID, LOCAL_ID, 'ba', null, NOW)
    expect(unregisterSession(dir, LOCAL_ID_2).removed).toBe(0)
    expect(() => unregisterSession(dir, 'nope')).toThrow(/desktop id/)
  })

  it('writes under the lock', () => {
    const dir = tempDir('state-')
    registerSession(dir, CLI_ID, LOCAL_ID, 'ba', null, NOW)
    let held = false
    const rename = (from: string, to: string) => {
      held = fs.existsSync(path.join(dir, '.lock'))
      fs.renameSync(from, to)
    }
    unregisterSession(dir, LOCAL_ID, { rename })
    expect(held).toBe(true)
  })
})

describe('a blocked protocol', () => {
  const BLOCKED = 'Blocked: until the round trip is recorded.' + '\n\n' + 'The owner.'

  it('is read from the first line of Activation', () => {
    expect(parseProtocolFile(protocol({ Activation: BLOCKED }), 'alpha').blocked).toBe(
      'until the round trip is recorded.',
    )
  })

  it('is not blocked by a Blocked line that is not first', () => {
    const text = protocol({ Activation: 'The owner.' + '\n\n' + 'Blocked: later.' })
    expect(parseProtocolFile(text, 'alpha').blocked).toBeNull()
  })

  it('rejects a Blocked line with no reason', () => {
    expect(() => parseProtocolFile(protocol({ Activation: 'Blocked:' }), 'alpha')).toThrow(
      /Blocked needs a reason/,
    )
  })

  function blockedDefs() {
    const dir = tempDir('protocols-')
    writeProtocols(dir, {
      day: protocol({ Group: 'shift (default)' }, 'day'),
      night: protocol({ Group: 'shift', Activation: BLOCKED }, 'night'),
    })
    return loadProtocols(dir)
  }

  it('is refused by on with the reason, changing nothing', () => {
    const defs = blockedDefs()
    const r = applyChange(defaultState(defs), defs, 'night', 'on', 'owner', NOW)
    expect(r).toEqual({ error: 'night is blocked: until the round trip is recorded.' })
  })

  it('can still be turned off, and does not affect the other protocols', () => {
    const defs = blockedDefs()
    const off = applyChange(
      { active: ['night'], changed: null, by: null },
      defs,
      'night',
      'off',
      'owner',
      NOW,
    )
    expect(off.state?.active).toEqual(['day'])
    expect(applyChange(defaultState(defs), defs, 'day', 'on', 'owner', NOW).state?.active).toEqual([
      'day',
    ])
  })

  it('is how the real night-shift file is written until the round trip is recorded', () => {
    const repoRoot = path.resolve(__dirname, '../../..')
    const defs = loadProtocols(path.join(repoRoot, 'docs/protocols'))
    expect(defs.get('night-shift')?.blocked).toMatch(/self-clear round trip/)
    expect(defs.get('day-shift')?.blocked).toBeNull()
    expect(defs.get('throttle')?.blocked).toBeNull()
  })
})
