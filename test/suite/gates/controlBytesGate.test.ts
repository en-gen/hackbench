/**
 * Source files hold no raw control bytes. One NUL makes git, ripgrep and the
 * content gate treat a whole file as binary, so its diffs stop being
 * reviewable and its lines stop being scanned (#496). Write `\x00`, not the byte.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../../..')
const SCANNED = ['src', 'theia/extension/src', 'test', 'tools']

// Tab, LF and CR are ordinary text; everything else below 0x20, and DEL, is not.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(p)
    return /\.(ts|tsx|js|cjs|mjs)$/.test(e.name) ? [p] : []
  })
}

function hasControlByte(text: string): boolean {
  return CONTROL.test(text)
}

describe('control bytes gate', () => {
  it('no source file contains a raw control byte', () => {
    const files = SCANNED.flatMap(d => sourceFiles(path.join(ROOT, d)))
    // Tripwire: a moved directory must not pass by scanning nothing.
    expect(files.length).toBeGreaterThan(100)
    const offenders = files
      .filter(f => hasControlByte(fs.readFileSync(f, 'latin1')))
      .map(f => path.relative(ROOT, f))
    expect(offenders).toEqual([])
  })

  it('flags a planted NUL, unit separator or DEL, and passes tab, LF and CR', () => {
    for (const planted of ['\x00', '\x1f', '\x7f', '\x0b']) {
      expect(hasControlByte(`const re = /[${planted}]/`)).toBe(true)
    }
    expect(hasControlByte('a\tb\r\nc\n')).toBe(false)
  })
})
