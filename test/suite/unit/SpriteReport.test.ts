/**
 * The sprite report (#828) on synthetic grades: CI has no ROM and no captures.
 * Page counts, refusals, the commit and the contact sheet; the grader itself is
 * covered by spriteGrade.captures.test.ts.
 */
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  VERDICTS,
  buildReport,
  contactSheet,
  encodePng,
  isInside,
  renderPieces,
  type ReportRow,
  type ReportVerdict,
} from '../../../tools/scripts/spriteReport'
import { closestFrame, run, type Graded, type Io } from '../../../tools/scripts/spriteReportRun'

const tmp = mkdtempSync(join(tmpdir(), 'sprite-report-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })

const COUNTS: Record<ReportVerdict, number> = {
  exact: 4,
  shape: 3,
  close: 2,
  wrong: 1,
  empty: 2,
  refused: 1,
}
const rows = (): ReportRow[] =>
  VERDICTS.flatMap((v, vi) =>
    Array.from({ length: COUNTS[v] }, (_, i) => ({
      map: '00' + vi,
      id: vi * 16 + i,
      slot: i,
      verdict: v,
      ours: `img/${v}${i}.png`,
    })),
  )
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length

describe('buildReport', () => {
  const files = buildReport(rows(), { sha: 'abc', dirty: false })
  it('has one page per verdict whose row count equals the input count', () => {
    for (const v of VERDICTS) {
      expect(count(files.get(`${v}.md`)!, /^### Sprite/gm)).toBe(COUNTS[v])
      expect(count(files.get(`${v}.md`)!, /^- \[ \] corrupted$/gm)).toBe(COUNTS[v])
    }
  })
  it('puts every sprite on exactly one verdict page and lists every one in the index', () => {
    const total = rows().length
    const ids = [...files]
      .filter(([k]) => k !== 'index.md')
      .flatMap(([, t]) => [...t.matchAll(/<a id="([^"]+)">/g)].map(m => m[1]))
    expect(ids).toHaveLength(total)
    expect(new Set(ids).size).toBe(total)
    const index = files.get('index.md')!
    for (const id of ids) expect(index).toContain(`#${id})`)
    expect(count(index, /^- [0-9A-F]{2} map/gm)).toBe(total)
  })
  it('links ours and hardware images, and says so when one is absent', () => {
    const page = buildReport(
      [
        { map: '001', id: 1, slot: 0, verdict: 'exact', ours: 'img/a.png', hardware: 'img/b.png' },
        { map: '001', id: 2, slot: 0, verdict: 'empty' },
      ],
      { sha: 'x', dirty: false },
    )
    expect(page.get('exact.md')).toContain('![ours](img/a.png) | ![hardware](img/b.png)')
    expect(page.get('empty.md')).toContain('none drawn')
  })
})

describe('isInside', () => {
  it('is true for the root and below, false for siblings and parents', () => {
    expect(isInside(join(tmp, 'a', 'b'), tmp)).toBe(true)
    expect(isInside(tmp, tmp)).toBe(true)
    expect(isInside(tmp + '-other', tmp)).toBe(false)
    expect(isInside(join(tmp, '..'), tmp)).toBe(false)
  })
})

const img = (n: number): Graded['oursImg'] => ({ w: 2, h: 2, px: new Uint8Array(16).fill(n) })
const graded = (): Graded[] => rows().map(r => ({ ...r, oursImg: img(100), hardwareImg: img(200) }))
const mkRepo = (name: string): string => {
  const d = join(tmp, name)
  mkdirSync(d)
  git(d, 'init', '-q')
  git(d, 'config', 'user.email', 't@example.com')
  git(d, 'config', 'user.name', 't')
  git(d, 'commit', '-q', '--allow-empty', '-m', 'init')
  return d
}
const io = (over: Partial<Io> = {}): Io & { out: string[] } => {
  const out: string[] = []
  return {
    repoRoot: join(tmp, 'hb'),
    rom: join(tmp, 'vanilla.sfc'),
    captures: join(tmp, 'caps'),
    exists: () => true,
    sha: () => ({ sha: 'deadbeef', dirty: false }),
    grade: () => graded(),
    env: {},
    log: s => out.push(s),
    out,
    ...over,
  }
}

describe('run', () => {
  it('names a missing ROM, exits non-zero, writes nothing', () => {
    const v = mkRepo('v1')
    const c = io({ exists: p => p !== join(tmp, 'vanilla.sfc') })
    expect(run(['--validation', v], c)).toBe(1)
    expect(c.out.join()).toContain('vanilla ROM')
    expect(existsSync(join(v, 'reports'))).toBe(false)
    expect(git(v, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
  })
  it('names missing captures', () => {
    const c = io({ exists: p => p !== join(tmp, 'caps') })
    expect(run(['--out', join(tmp, 'o1'), '--no-commit'], c)).toBe(1)
    expect(c.out.join()).toContain('layers_v5 captures')
    expect(existsSync(join(tmp, 'o1'))).toBe(false)
  })
  it('commits reports/sprites/<sha>/ and latest/ in the validation repo, and nothing else', () => {
    const v = mkRepo('v2')
    expect(run(['--validation', v], io())).toBe(0)
    expect(git(v, 'rev-list', '--count', 'HEAD').trim()).toBe('2')
    const changed = git(v, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)
    expect(changed.filter(f => f.startsWith('reports/sprites/deadbeef/index.md'))).toHaveLength(1)
    expect(changed.filter(f => f.startsWith('reports/sprites/latest/index.md'))).toHaveLength(1)
    expect(changed.every(f => /^reports\/sprites\/(deadbeef|latest)\//.test(f))).toBe(true)
    expect(changed.filter(f => f.endsWith('-ours.png'))).toHaveLength(rows().length * 2)
    expect(git(v, 'status', '--porcelain')).toBe('')
  })
  it('replaces latest/ on a second run', () => {
    const v = mkRepo('v3')
    run(['--validation', v], io())
    run(
      ['--validation', v],
      io({ sha: () => ({ sha: 'cafe', dirty: false }), grade: () => graded().slice(0, 1) }),
    )
    expect(readdirSync(join(v, 'reports', 'sprites', 'latest', 'img'))).toHaveLength(2)
    expect(existsSync(join(v, 'reports', 'sprites', 'deadbeef'))).toBe(true)
  })
  it('refuses an output inside the hackbench checkout, for the report and the sheet', () => {
    const c = io()
    expect(run(['--out', join(tmp, 'hb', 'x'), '--no-commit'], c)).toBe(2)
    expect(run(['--sheet', '--map', '1', '--out', join(tmp, 'hb')], c)).toBe(2)
    expect(run(['--validation', join(tmp, 'hb', 'v')], c)).toBe(2)
    expect(existsSync(join(tmp, 'hb'))).toBe(false)
  })
  it('--no-commit writes the same tree to --out; a sheet inside the validation repo is refused', () => {
    const o = join(tmp, 'o2')
    expect(run(['--out', o, '--no-commit'], io())).toBe(0)
    expect(existsSync(join(o, 'reports', 'sprites', 'latest', 'index.md'))).toBe(true)
    const v = mkRepo('v4')
    expect(
      run(['--sheet', '--sprite', '1', '--validation', v, '--out', join(v, 'sheets')], io()),
    ).toBe(2)
  })
  it('a sheet writes exactly one PNG and commits nothing', () => {
    const v = mkRepo('v5')
    const o = join(tmp, 'sheets')
    expect(run(['--sheet', '--map', '1', '--validation', v, '--out', o], io())).toBe(0)
    const files = readdirSync(o)
    expect(files).toEqual(['sprite-sheet-map-1.png'])
    expect(readFileSync(join(o, files[0])).subarray(1, 4).toString()).toBe('PNG')
    expect(git(v, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
  })
  it('rejects --sheet with neither or both filters, and --out without --no-commit', () => {
    expect(run(['--sheet', '--out', tmp], io())).toBe(2)
    expect(run(['--sheet', '--map', '1', '--sprite', '2', '--out', tmp], io())).toBe(2)
    expect(run(['--out', tmp], io())).toBe(2)
  })
})

describe('frames and sheet', () => {
  const vram = new Uint8Array(0x10000)
  vram.fill(0xff, 0, 32) // tile 0 of the first name table: every plane set, colour index 15
  const pal = new Uint8Array(768)
  pal.set([10, 20, 30], (128 + 15) * 3)
  const src = { vram, pal, obsel: 0 }
  it('renders an 8x8 piece with the palette colour, scaled 2x on a backdrop', () => {
    const r = renderPieces([{ dx: 0, dy: 0, tile: 0, attr: 0, large: false }], src)!
    expect([r.w, r.h]).toEqual([16, 16])
    expect([...r.px.subarray(0, 4)]).toEqual([10, 20, 30, 255])
    expect(renderPieces([], src)).toBeNull()
  })
  it('encodes a PNG with the right signature and width', () => {
    const png = encodePng({ w: 1, h: 1, px: Uint8Array.from([1, 2, 3, 255]) })
    expect(png.readUInt32BE(16)).toBe(1)
    expect(png.subarray(1, 4).toString()).toBe('PNG')
  })
  it('lays out one cell per sprite', () => {
    const cell = { verdict: 'exact' as const, ours: img(1), hardware: img(2) }
    const one = contactSheet([cell])
    const many = contactSheet([cell, cell, cell], 2)
    expect(many.h).toBe(one.h * 2)
    expect(many.w).toBe(one.w * 2)
  })
})

describe('closestFrame', () => {
  const a = [{ dx: 0, dy: 0, tile: 1, attr: 0, large: false }]
  const b = [{ dx: 0, dy: 0, tile: 2, attr: 0x10, large: false }]
  it('picks the recorded frame equal to ours, ignoring priority bits, else the first', () => {
    expect(closestFrame([a, b], [{ ...b[0], attr: 0 }])).toBe(b)
    expect(closestFrame([a, b], [{ ...a[0], tile: 9 }])).toBe(a)
  })
})
