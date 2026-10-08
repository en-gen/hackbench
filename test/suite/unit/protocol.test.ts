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
