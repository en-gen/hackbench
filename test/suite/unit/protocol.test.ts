import { describe, it, expect } from 'vitest'
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

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
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

import { readState, applyChange, writeState } from '../../../tools/scripts/protocol.mjs'

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
