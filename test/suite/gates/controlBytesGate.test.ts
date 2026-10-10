/**
 * Source files hold no raw control bytes. One NUL makes git, ripgrep and the
 * content gate treat a whole file as binary, so its diffs stop being
 * reviewable and its lines stop being scanned (#496). Write `\x00`, not the byte.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../../..')
const SCANNED = ['src', 'theia/extension/src', 'test', 'tools']

// Tab, LF and CR are ordinary text; everything else below 0x20, and DEL, is not.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/

// lintGate.test.ts creates and deletes files under __fixtures__ while this walk runs
// (#754: ENOENT on readFileSync). Skipping the directory is deterministic; an
// ENOENT catch would also hide a real missing file.
const SKIPPED_DIRS = new Set(['node_modules', '__fixtures__'])

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return SKIPPED_DIRS.has(e.name) ? [] : sourceFiles(p)
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

  it('does not walk __fixtures__, where lintGate churns files (#754)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrlbytes-'))
    try {
      fs.mkdirSync(path.join(d, '__fixtures__', 'run-1'), { recursive: true })
      fs.writeFileSync(path.join(d, '__fixtures__', 'run-1', 'a.ts'), 'x')
      fs.writeFileSync(path.join(d, 'real.ts'), 'x')
      expect(sourceFiles(d).map(f => path.relative(d, f))).toEqual(['real.ts'])
    } finally {
      fs.rmSync(d, { recursive: true, force: true })
    }
  })
})
