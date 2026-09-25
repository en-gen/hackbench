/**
 * The capture viewer's gates (tools/scripts/capture_render.ts): every reason
 * a map must not be compared goes to "unavailable" or "incomplete", the exit
 * code follows the worst verdict, and a stale page cannot outlive its
 * capture. Synthetic captures only: CI has no ROM and no Mesen captures.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs' // prettier-ignore
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { runInNewContext } from 'vm'
import { afterAll, describe, expect, it } from 'vitest'
import { deflateRawSync, deflateSync } from 'zlib'
import * as D from '../../../tools/scripts/capture_decode'
import * as Draw from '../../../tools/scripts/capture_draw'
import {
  REPO,
  cliFolders,
  crc32,
  crc32Js,
  exitCode,
  folderProblem,
  loadLevel,
  page,
  pipeAt,
  pipeInfo,
  pngRgba,
  runCapture,
  spriteFrame,
} from '../../../tools/scripts/capture_render'
import { addr64, captureFiles, idAt, NAMES, POS } from './fixtures/captureFixture'

type Files = Record<string, Buffer>
type Obj = Record<string, unknown>
const json = (b: Buffer) => JSON.parse(b.toString('utf8'))
const j = (o: unknown) => Buffer.from(JSON.stringify(o))
const run = (files: Files, windows: string[] = []) => loadLevel(n => files[n] ?? null, '$10A', windows) // prettier-ignore
/** One temp folder for every test that writes files, removed at the end. */
const TMP = mkdtempSync(join(tmpdir(), 'hb-capture-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))
/** Edit one JSON file of `files` in place. */
function patch(files: Files, name: string, change: (o: Obj) => void) {
  const o = json(files[name])
  change(o)
  files[name] = j(o)
  return files
}
const edit = (name: string, change: (o: Obj) => void, vertical = false) =>
  patch(captureFiles(vertical), name, change)
/** Window `w`'s layer `name` picture, with its BG1 picture's VRAM and registers. */
function picture(files: Files, w: string, name: string, pic: Buffer, side?: unknown) {
  const d = `windows/${w}/`
  files[`${d}layer_${name}.png`] = pic
  files[`${d}layer_${name}_vram.bin`] = files[d + 'layer_bg1_vram.bin']
  files[`${d}layer_${name}_data.json`] = files[d + 'layer_bg1_data.json']
  if (side) files[`${d}layer_${name}.json`] = j(side)
}
const SENTINEL = { transparentSentinelBgr555: 0x7c1f }
/**
 * Pictures of BG1-BG3 in window `w` that agree with our drawing of that
 * window, transparent where it draws nothing: the SNES check's pass state,
 * so a test about something else is not left incomplete. It calls
 * D.windowLayer only to build that state; the tests that the comparison
 * can fail plant their own pictures.
 */
function agreeing(files: Files, w: string) {
  const d = `windows/${w}/`
  const data = json(files[d + 'layer_bg1_data.json'])
  const regs = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v && typeof v === 'object' ? (v as Obj).byte : v])) as Record<string, number> // prettier-ignore
  const scroll = [['BG1HOFS_210D', 'BG1VOFS_210E'], ['BG2HOFS_210F', 'BG2VOFS_2110'], ['BG3HOFS_2111', 'BG3VOFS_2112']].map(q => q.map(k => regs[k])) // prettier-ignore
  const pal = D.palette(files['frame_0000_cgram.bin'])
  for (const name of ['bg1', 'bg2', 'bg3']) {
    const l = D.windowLayer(name, { vram: files[d + 'layer_bg1_vram.bin'], pal, oam: null, regs, scroll, player: [] }) // prettier-ignore
    const pic = png(256, 224, (x, y) => (l.opaque[y * 256 + x] ? [...l.rgba.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 3)] : [255, 0, 255])) // prettier-ignore
    picture(files, w, name, pic, SENTINEL)
  }
  return files
}
/** A map with one window at strip 8 whose pictures agree: every check passes (or is weak). */
const passing = (ids?: () => number) => agreeing(captureFiles(false, ids, [8]), 'screen_00')
const runW = (files: Files) => run(files, ['screen_00'])
function writeTree(dir: string, files: Files) {
  for (const [n, b] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, n)), { recursive: true })
    writeFileSync(join(dir, n), b)
  }
}
const under = (prefix: string, f: Files) => Object.fromEntries(Object.entries(f).map(([n, b]) => [prefix + n, b])) // prettier-ignore

/** A w x h RGB PNG whose pixel (x, y) is rgb(x, y); `rows` overrides the raw scanlines. */
function png(
  w: number,
  h: number,
  rgb: (x: number, y: number) => number[],
  opts: { interlace?: number; rows?: Buffer; plte?: Buffer } = {},
) {
  // prettier-ignore
  const chunk = (t: string, d: Buffer) => {
    const b = Buffer.alloc(12 + d.length)
    b.writeUInt32BE(d.length, 0)
    b.write(t, 4, 'ascii')
    d.copy(b, 8)
    return b
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, opts.plte ? 3 : 2, 0, 0, opts.interlace ?? 0], 8)
  const rows: number[] = []
  for (let y = 0; y < h; y++) {
    rows.push(0)
    for (let x = 0; x < w; x++) rows.push(...rgb(x, y))
  }
  const idat = deflateSync(opts.rows ?? Buffer.from(rows))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...(opts.plte ? [chunk('PLTE', opts.plte)] : []), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]) // prettier-ignore
}
const onePixelPng = (rgb: number[]) => png(1, 1, () => rgb)

/** A zip of `entries`, each stored (0), deflated (8) or labelled with another method. */
function zip(entries: [string, Buffer][] | Files, method = 8) {
  const [parts, central] = [[] as Buffer[], [] as Buffer[]]
  let offset = 0
  for (const [name, data] of Array.isArray(entries) ? entries : Object.entries(entries)) {
    const [body, n] = [method === 8 ? deflateRawSync(data) : data, Buffer.from(name)]
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(n.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(method, 10)
    c.writeUInt32LE(crc32(data), 16)
    c.writeUInt32LE(body.length, 20)
    c.writeUInt32LE(data.length, 24)
    c.writeUInt16LE(n.length, 28)
    c.writeUInt32LE(offset, 42)
    parts.push(local, n, body)
    central.push(c, n)
    offset += 30 + n.length + body.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(central.length / 2, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, end])
}
/** The byte offset of the first central directory entry of a zip. */
const firstEntry = (z: Buffer) => z.readUInt32LE(z.length - 6)

describe('capture map gates', () => {
  it('passes the synthetic capture, reading the last sample', () => {
    const l = runW(passing())
    expect(l.verdict).toBe('pass')
    expect(l.detail).toContain('shift and stride errors would fail')
    expect(l.data?.cols).toBe(48)
    expect(l.data?.backdrop).toEqual([0, 99, 189]) // CGRAM 0 is black; COLDATA $5D80 added
    expect(l.detail).toContain('CGWSEL $2 from WRAM ColorAddition (the PPU byte is not recorded)')
  })

  it('tests the vertical half-screen term on a vertical capture', () => {
    const l = run(captureFiles(true))
    expect(l.mapCheck).toBe('pass')
    expect(l.detail).toContain('half-screen term tested')
  })

  it('marks a map weak when a misplaced grid would also have passed', () => {
    const l = run(
      agreeing(
        captureFiles(false, () => 7, [8]),
        'screen_00',
      ),
      ['screen_00'],
    )
    expect(l.verdict).toBe('weak')
    expect(l.detail).toContain('would also pass x+16')
  })

  const pipes = 'map16_pipe_writes.json'
  const unavailable: [string, () => Files][] = [
    ['an aborted capture (no summary)', () => {
      const f = captureFiles()
      delete f['capture_summary.json']
      return f
    }],
    ['a failed identity gate', () => edit('capture_summary.json', o => (o.identityGate = 'fail'))],
    ['an empty Layer 1', () => edit('capture_summary.json', o => (o.layer1 = 'empty stream, not loaded'))],
    ['a missing artifact', () => {
      const f = captureFiles()
      delete f['vram.bin']
      return f
    }],
    ['mode 3', () => edit('ppu.json', o => (o.BGMODE_2105 = { byte: 0x03 }))],
    ['16x16 BG1 chars', () => edit('ppu.json', o => (o.BGMODE_2105 = { byte: 0x19 }))],
    ['16x16 BG2 chars', () => edit('ppu.json', o => (o.BGMODE_2105 = { byte: 0x29 }))],
    ['16x16 BG3 chars', () => edit('ppu.json', o => (o.BGMODE_2105 = { byte: 0x49 }))],
    ['a missing register', () => edit('ppu.json', o => delete o.OBSEL_2101)],
    ['no camera', () => edit('ppu.json', o => delete o.camera)],
    ['another tile-id rule', () => edit('map16_grid.json', o => (o.tileId = '(high & 3) * 256 + low'))],
    ['another vertical layout', () => edit('map16_grid.json', o => (o.inScreen = { vertical: 'row*$20 + col' }), true)],
    ['sidecar dimensions that disagree with the stride', () =>
      edit('map16_grid.json', o => ((o.layer1 as Obj).cols = 64))],
    ['unnamed word order', () => edit('map16_defs.json', o => delete o.wordOrder)],
    ['defs marked unavailable', () => edit('map16_defs.json', o => (o.available = false))],
    ['no stated pipe range', () => edit(pipes, o => delete o.entryPointers)],
    ['no pipe word order', () => edit(pipes, o => delete o.defsWordOrder)],
    ['no pipe defs', () => edit(pipes, o => delete o.defs)],
    ['no strip builds', () => edit(pipes, o => delete o.stripBuilds)],
    ['strip build pointers that are not a list', () => edit(pipes, o => (o.stripBuilds = [{ strip: 1, frame: 5, pointers: '$A' }]))],
    ['a sidecar that is not a JSON object', () => ({ ...captureFiles(), 'ppu.json': Buffer.from('null') })],
    ['sprite list entries that are not a list', () => ({ ...captureFiles(), 'sprites.json': j({ entries: 5 }) })],
  ] // prettier-ignore
  it.each(unavailable)('refuses %s', (_, files) => {
    const l = run(files())
    expect(l.verdict).toBe('unavailable')
    expect(l.data).toBeUndefined()
  })

  it('fails a map whose VRAM disagrees, and prints a missing def as "no def"', () => {
    const f = captureFiles()
    f['vram.bin'][0x2000 * 2 + 40] ^= 1
    expect(run(f).verdict).toBe('fail')
    expect(D.hexWord(-1)).toBe('no def')
    expect(D.hexWord(0x1420)).toBe('$1420')
  })
})

describe('verdict and exit code', () => {
  it("fails the map, exit 1, when Mesen's Background picture differs from our drawing", () => {
    const files = passing()
    expect(runW(files).verdict).toBe('pass')
    // Our BG2 draws nothing at (0, 0) here; this SNES picture is opaque there.
    files['windows/screen_00/layer_bg2.png'] = onePixelPng([8, 8, 8])
    const l = runW(files)
    expect(l.snes!.bg2).toEqual([1])
    expect(l.mapCheck).toBe('pass') // the map data still matches
    expect(l.checks!.rows[1].result).toBe('fail')
    expect(l.verdict).toBe('fail')
    expect(exitCode([l.verdict])).toBe(1)
  })

  it('lets Effects alone decide the map when Foreground and Background pass', () => {
    const files = passing()
    expect(runW(files).verdict).toBe('pass')
    // Our BG3 draws nothing at (0, 0); this SNES picture is opaque there.
    files['windows/screen_00/layer_bg3.png'] = onePixelPng([8, 8, 8])
    const failing = runW(files)
    expect(failing.checks!.rows.map(r => r.result)).toEqual(['pass', 'pass', 'fail', 'informational']) // prettier-ignore
    expect(failing.verdict).toBe('fail')
    // A band covering every line compares no Effects pixel: not compared.
    patch(files, 'windows/screen_00/layer_bg3_data.json', o => (o.statusBar = { irqLine: 300 }))
    const blind = runW(files)
    expect(blind.checks!.rows.map(r => r.result)).toEqual(['pass', 'pass', 'not compared', 'informational']) // prettier-ignore
    expect(blind.verdict).toBe('incomplete')
    expect(exitCode([blind.verdict])).toBe(2)
  })

  it('ranks not compared above weak: a weak map with a layer not compared is incomplete', () => {
    const files = passing(() => 7)
    expect(runW(files).verdict).toBe('weak')
    patch(files, 'windows/screen_00/layer_bg3_data.json', o => (o.statusBar = { irqLine: 300 }))
    const l = runW(files)
    expect(l.mapCheck).toBe('weak')
    expect(l.verdict).toBe('incomplete')
    expect(exitCode([l.verdict])).toBe(2)
  })

  it('keeps the Sprites comparison informational', () => {
    const files = passing()
    const oam = Buffer.alloc(544)
    for (let i = 0; i < 128; i++) oam[i * 4 + 1] = 0xf0
    picture(files, 'screen_00', 'obj', onePixelPng([8, 8, 8]), SENTINEL)
    files['windows/screen_00/layer_obj_oam.bin'] = oam
    const l = runW(files)
    expect(l.snes!.obj).toEqual([1])
    expect(l.checks!.rows[3].result).toBe('informational')
    expect(l.verdict).toBe('pass')
  })

  it('is incomplete, exit 2, when a deciding layer has no picture to compare', () => {
    const l = run(captureFiles())
    expect(l.mapCheck).toBe('pass')
    expect(l.checks!.rows.slice(0, 3).map(r => r.result)).toEqual(['not compared', 'not compared', 'not compared']) // prettier-ignore
    expect(l.verdict).toBe('incomplete')
    expect(exitCode([l.verdict])).toBe(2)
    expect(exitCode(['pass', 'weak'])).toBe(0)
    expect(exitCode(['pass', 'fail', 'incomplete'])).toBe(1)
    expect(exitCode(['pass', 'unavailable'])).toBe(2)
    expect(exitCode([])).toBe(2)
  })

  it('counts a window whose Foreground check compared nothing as blind, so the map stays weak', () => {
    const files = agreeing(
      captureFiles(false, () => 7, [8]),
      'screen_00',
    )
    expect(runW(files).mapCheck).toBe('weak')
    patch(files, 'windows/screen_00/layer_bg1_data.json', o => ((o.camera as Obj).layer1X = 5000))
    const l = runW(files)
    expect(l.mapCheck).toBe('weak')
    expect(l.detail).toMatch(/Foreground cells compared per camera position: [\d,]+, 0/)
  })
})

describe('pipe variants', () => {
  // defs list words top-left, bottom-left, top-right, bottom-right.
  const base = {
    entryPointers: 'Map16Pointers[$133..$134] in order',
    defsWordOrder: ['top-left', 'bottom-left', 'top-right', 'bottom-right'],
    defs: { $A: [1, 2, 3, 4], $B: [5, 6, 7, 8] },
  }
  const [A, B] = [
    [1, 3, 2, 4],
    [5, 7, 6, 8],
  ]

  it('takes each strip from its builds, reordering the defs words', () => {
    const builds = [{ strip: 1, frame: 90, pointers: ['$B', '$B'] }, { strip: 7, frame: 95, pointers: ['$A', '$B'] }, { strip: -8, frame: 96, pointers: ['$A', '$A'] }] // prettier-ignore
    expect(pipeInfo({ ...base, stripBuilds: builds })!.strips).toEqual({ 1: [...B, ...B], 7: [...A, ...B] }) // prettier-ignore
    expect(pipeInfo({ ...base, stripBuilds: [] })!.strips).toEqual({})
    // A build naming a pointer the defs lack colors nothing.
    expect(pipeInfo({ ...base, stripBuilds: [{ strip: 1, frame: 90, pointers: ['$A', '$C'] }] })!.strips).toEqual({}) // prettier-ignore
  })

  it('refuses a sidecar without the range, word order, defs or builds', () => {
    const all = { ...base, stripBuilds: [] }
    expect(pipeInfo(all)).not.toBeNull()
    for (const k of Object.keys(all)) {
      const part: Obj = { ...all }
      delete part[k]
      expect(pipeInfo(part)).toBeNull()
    }
    expect(pipeInfo(undefined)).toBeNull()
  })

  it('keeps every build of a strip: the first for the map, the latest by a frame for a picture', () => {
    const writes = {
      ...base,
      stripBuilds: [{ strip: 4, frame: 100, pointers: ['$A', '$A'] }, { strip: 4, frame: 300, pointers: ['$B', '$B'] }, { strip: 5, frame: 200, pointers: ['$B', '$A'] }], // prettier-ignore
    }
    const p = pipeInfo(writes)!
    expect(p.strips[4]).toEqual([...A, ...A]) // first build, the map as first seen
    expect(pipeAt(p, 150).strips).toEqual({ 4: [...A, ...A] }) // strip 5 not built yet
    expect(pipeAt(p, 250).strips).toEqual({ 4: [...A, ...A], 5: [...B, ...A] })
    expect(pipeAt(p, 300).strips[4]).toEqual([...B, ...B]) // at or before
    // A build before the map's own load (a castle's entrance room) is another
    // map: ignored for the map view and for every picture.
    const early = { ...writes, stripBuilds: [{ strip: 4, frame: 60, pointers: ['$B', '$A'] }, ...writes.stripBuilds] } // prettier-ignore
    const since = pipeInfo(early, 80)!
    expect(since.strips[4]).toEqual([...A, ...A])
    expect(pipeAt(since, 90).strips[4]).toBeUndefined()
    expect(pipeInfo(early)!.strips[4]).toEqual([...B, ...A]) // without a load frame, all count
    // A build on the load frame itself belongs to the map.
    expect(pipeInfo(early, 60)!.strips[4]).toEqual([...B, ...A])
    // Listed out of frame order, the frames still decide.
    const shuffled = pipeInfo({ ...writes, stripBuilds: [...writes.stripBuilds].reverse() })!
    expect(shuffled.strips[4]).toEqual([...A, ...A])
    expect(pipeAt(shuffled, 400).strips[4]).toEqual([...B, ...B])
  })

  it('checks each picture against the pipe set of the build before its frame', () => {
    // Pipe range $133..$13A with two sets: A (the words the fixture's VRAM holds)
    // and B (palette bit 10 flipped). Every strip is built with A at frame 120;
    // one strip holding a pipe cell is rebuilt with B at frame 700, and the
    // window (frame 800) holds B there while the load sample (frame 100) holds A.
    const files = captureFiles(false, undefined, [8])
    const grid = files['map16_grid.bin']
    const defsBin = files['map16_defs.bin']
    const word = (id: number, k: number) =>
      defsBin[id * 8 + k * 2] | (defsBin[id * 8 + k * 2 + 1] << 8)
    const ptr = (set: string, i: number) => `$${set}${i}`
    const defsJ: Record<string, string[]> = {}
    for (let i = 0; i < 8; i++)
      for (const [set, x] of [
        ['A', 0],
        ['B', 0x400],
      ] as [string, number][])
        defsJ[ptr(set, i)] = [0, 1, 2, 3].map(k => '$' + (word(0x133 + i, k) ^ x).toString(16))
    let S = -1
    for (let c = 1; c <= 30 && S < 0; c++) for (let r = 0; r < 27; r++) if (idAt(grid, c, r) >= 0x133 && idAt(grid, c, r) <= 0x13a) S = c // prettier-ignore
    expect(S).toBeGreaterThan(0)
    const set = (n: string) => Array.from({ length: 8 }, (_, i) => ptr(n, i))
    // Frame 60 is before the map's own load (levelLoadFrame 90): an entrance room's build, ignored.
    const summary = json(files['capture_summary.json'])
    files['capture_summary.json'] = j({ ...summary, levelLoadFrame: 90 })
    const builds = [{ strip: S, frame: 60, pointers: set('B') }, ...Array.from({ length: 48 }, (_, c) => ({ strip: c, frame: 120, pointers: set('A') })), { strip: S, frame: 700, pointers: set('B') }] // prettier-ignore
    files['map16_pipe_writes.json'] = j({ entryPointers: 'Map16Pointers[$133..$13A] in order', defsWordOrder: NAMES, defs: defsJ, stripBuilds: builds }) // prettier-ignore
    const d = 'windows/screen_00/'
    const vram = Buffer.from(files[d + 'layer_bg1_vram.bin'])
    for (let r = 0; r < 27; r++) {
      const id = idAt(grid, S, r)
      if (id < 0x133 || id > 0x13a) continue
      for (let q = 0; q < 4; q++)
        vram[addr64(S * 2 + (q % 2), r * 2 + Math.floor(q / 2)) * 2 + 1] ^= 0x04 // bit 10 of the word
    }
    files[d + 'layer_bg1_vram.bin'] = vram
    patch(files, d + 'layer_bg1_data.json', o => (o.frame = 800))
    const l = runW(files)
    expect(l.mapCheck).toBe('pass')
    expect(l.data!.draw.pipe.strips[S]).toEqual(
      Array.from({ length: 8 }, (_, i) => [0, 1, 2, 3].map(q => word(0x133 + i, POS[q]))).flat(),
    ) // set A, the first build
    expect(l.detail).toContain(
      'pipe set from its first build (stripBuilds), as the map is first seen',
    )
    expect(l.detail).not.toContain('load boundary not recorded')
    // Without levelLoadFrame every build counts, the entrance room's too, and Coverage says so.
    files['capture_summary.json'] = j(summary)
    const open = runW(files)
    expect(open.detail).toContain('load boundary not recorded')
    expect(open.data!.draw.pipe.strips[S]).toEqual(l.data!.draw.pipe.strips[S].map(w => w ^ 0x400)) // set B, the frame-60 build
    files['capture_summary.json'] = j({ ...summary, levelLoadFrame: 90 })
    // The window taken before the rebuild would show A: frame 600 now mismatches.
    patch(files, d + 'layer_bg1_data.json', o => (o.frame = 600))
    expect(runW(files).verdict).toBe('fail')
  })
})

describe('scroll-pass windows', () => {
  it('checks every window against its own VRAM and counts its SNES pictures', () => {
    const files = captureFiles(false, undefined, [8, 25])
    files['windows/screen_01/layer_bg1.png'] = Buffer.from('png')
    const l = run(files, ['screen_00', 'screen_01'])
    expect(l.mapCheck).toBe('pass')
    expect(l.detail).toContain('SNES pictures for 1 screen')
    expect(l.detail).toContain('Foreground checked at 3 camera positions')
    expect(l.detail).toContain('strips 1..47')
    expect(l.detail).toContain('SNES transparency unverified')
    files['windows/screen_01/layer_bg1.json'] = j(SENTINEL)
    const s = run(files, ['screen_00', 'screen_01'])
    expect(s.detail).not.toContain('transparency unverified')
    expect(s.refs![0].sentinel).toEqual([255, 0, 255])
  })

  it('fails when a window holds a tilemap the grid does not give', () => {
    const files = captureFiles(false, undefined, [25])
    files['windows/screen_00/layer_bg1_vram.bin'] = captureFiles()['vram.bin'] // the sample's, at strip 8
    expect(runW(files).verdict).toBe('fail')
  })

  it("compares Effects only below each picture's status-bar interrupt line, and BG3 only", () => {
    const files = captureFiles(false, undefined, [8])
    // Our BG2 and BG3 draw nothing here; the SNES pictures are opaque on
    // lines 0..37 (the bar's band plus one) and on line 40, transparent (the
    // sentinel) elsewhere.
    const banded = png(8, 48, (_, y) => (y <= 37 || y === 40 ? [8, 8, 8] : [255, 0, 255]))
    picture(files, 'screen_00', 'bg3', banded, SENTINEL)
    picture(files, 'screen_00', 'bg2', banded, SENTINEL)
    const data = json(files['windows/screen_00/layer_bg1_data.json'])
    const at = (irqLine?: number) => {
      const withLine = j({ ...data, ...(irqLine === undefined ? {} : { statusBar: { irqLine } }) })
      files['windows/screen_00/layer_bg3_data.json'] = withLine
      files['windows/screen_00/layer_bg2_data.json'] = withLine
      return runW(files)
    }
    const all = at()
    expect(all.snes!.bg3).toEqual([38 * 8 + 8])
    expect(all.detail).toContain('Effects compared on every line where a picture has no status-bar interrupt line') // prettier-ignore
    const below = at(36)
    expect(below.snes!.bg3).toEqual([16]) // lines 37 and 40: line 36 is the last one left out
    expect(below.snes!.bg2).toEqual([38 * 8 + 8]) // the band is BG3's alone
    expect(below.detail).toContain("Effects compared below each picture's status-bar interrupt line (36)") // prettier-ignore
    expect(at(40).snes!.bg3).toEqual([0]) // line 40 now inside the band
    expect(at(-1).snes!.bg3).toEqual([38 * 8 + 8]) // -1: no interrupt seen on that frame
    // A band covering every line compares nothing: not compared, never a pass.
    const covered = at(300)
    expect(covered.snes!.bg3).toBeNull()
    expect(covered.checks!.rows[2].result).toBe('not compared')
    expect(covered.verdict).not.toBe('pass')
  })

  it('checks a cell the game generated before a window against its generated tile, not as a failure', () => {
    const files = captureFiles(false, undefined, [25])
    const d = 'windows/screen_00/'
    patch(files, d + 'layer_bg1_data.json', o => (o.frame = 800))
    // The window's VRAM shows cell (30, 5) as id 3 where the load grid holds another id.
    const vram = Buffer.from(files[d + 'layer_bg1_vram.bin'])
    const defs = files['map16_defs.bin']
    for (let q = 0; q < 4; q++) {
      const a = addr64(60 + (q % 2), 10 + Math.floor(q / 2)) * 2
      vram[a] = defs[3 * 8 + POS[q] * 2]
      vram[a + 1] = defs[3 * 8 + POS[q] * 2 + 1]
    }
    files[d + 'layer_bg1_vram.bin'] = vram
    const call = (frame: number, cells: [number, number, string][], layer = 1, id = '$49') => ({ frame, layer, tile: 2, cells: cells.map(([col, row, after]) => ({ col, row, after })), sprite: { id } }) // prettier-ignore
    const calls = (...cs: unknown[]) => {
      files['scroll_pass.json'] = j({ generateTileCalls: cs })
      return runW(files)
    }
    expect(calls().mapCheck).toBe('fail') // unexplained
    const one = calls(call(700, [[30, 5, '$003']], 1, '$4E'))
    expect(one.mapCheck).toBe('pass')
    expect(one.detail).toContain('1 Foreground cell changed at runtime (1 by sprite $4E), checked against the generated tile') // prettier-ignore
    // Listed out of frame order, the later call decides.
    expect(calls(call(750, [[30, 5, '$003']]), call(720, [[30, 5, '$000']])).mapCheck).toBe('pass')
    expect(calls(call(750, [[30, 5, '$000']]), call(720, [[30, 5, '$003']])).mapCheck).toBe('fail')
    // Layer 2 calls do not touch the Foreground.
    expect(calls(call(700, [[30, 5, '$003']]), call(710, [[30, 5, '$000']], 2)).mapCheck).toBe('pass') // prettier-ignore
    // A call that wrote a group names each cell it left: (31, 5) is now $000
    // where the window shows the load id.
    expect(
      calls(
        call(700, [
          [30, 5, '$003'],
          [31, 5, '$000'],
        ]),
      ).mapCheck,
    ).toBe('fail')
    // A call stamped with the window's own frame is not in its VRAM yet, nor is a later one.
    expect(calls(call(800, [[30, 5, '$003']])).mapCheck).toBe('fail')
    expect(calls(call(900, [[30, 5, '$003']])).mapCheck).toBe('fail')
    // A Layer 1 call that does not name the cells it left is refused, not guessed at.
    const blind = calls({ frame: 700, layer: 1, col: 30, row: 5, tile: 2, sprite: null })
    expect(blind.verdict).toBe('unavailable')
    expect(blind.detail).toContain('GenerateTile call at frame 700 does not name the cells it left')
    // A call that names no layer is refused, never taken for Layer 1.
    const { layer, ...unnamed } = call(700, [[30, 5, '$003']])
    expect(layer).toBe(1)
    const noLayer = calls(unnamed)
    expect(noLayer.verdict).toBe('unavailable')
    expect(noLayer.detail).toContain('a GenerateTile call at frame 700 names no layer')
  })

  it('counts a list entry seen only when its index is a live slot in some window', () => {
    const files = captureFiles(false, undefined, [8, 25])
    files['sprites.json'] = j({
      entries: [
        { index: 0, id: '$BD', x: 208, y: 272 },
        { index: 1, id: '$DB', x: 496, y: 304 }, // runs as $05: the id must not be the key
        { index: 2, id: '$05', x: 600, y: 300 },
      ],
    })
    files['windows/screen_00/layer_obj_data.json'] = j({ slots: [{ slot: 7, id: '$BD', listIndex: 0 }] }) // prettier-ignore
    files['windows/screen_01/layer_obj_data.json'] = j({
      slots: [
        { slot: 3, id: '$05', listIndex: 1 },
        { slot: 4, id: '$05', listIndex: 255 }, // not from the list
      ],
    })
    const l = run(files, ['screen_00', 'screen_01'])
    expect(l.detail).toContain('sprite list: 2 of 3 entries seen alive in a window')
    expect(l.data?.spriteList.map(e => e.alive)).toEqual([['screen_00'], ['screen_01'], []])
    expect(l.data?.spriteList[1]).toMatchObject({ id: 0xdb, x: 496, y: 304 })
    files['windows/screen_01/layer_obj_data.json'] = j({ slots: 3 })
    expect(run(files, ['screen_00', 'screen_01']).verdict).toBe('unavailable') // slots not a list
    delete files['windows/screen_00/layer_obj_data.json']
    delete files['windows/screen_01/layer_obj_data.json']
    expect(run(files, ['screen_00', 'screen_01']).detail).toContain('3 entries, liveness not recorded') // prettier-ignore
  })

  it("places each picture at its own frame's camera and reads live slots from its data", () => {
    const files = captureFiles(false, undefined, [25])
    const d = 'windows/screen_00/'
    const data = json(files[d + 'layer_bg1_data.json'])
    for (const n of ['bg1', 'obj']) {
      files[`${d}layer_${n}.png`] = Buffer.from('png')
      files[`${d}layer_${n}_vram.bin`] = files[d + 'layer_bg1_vram.bin']
      files[`${d}layer_${n}_data.json`] = j({ ...data, frame: 700, camera: { ...data.camera, layer1X: n === 'bg1' ? 408 : 416 } }) // prettier-ignore
    }
    files[`${d}layer_obj_oam.bin`] = Buffer.alloc(544, 0xf0)
    files['sprites.json'] = j({ entries: [{ index: 0, id: '$BD', x: 208, y: 272 }] })
    const slots = [{ slot: 7, id: '$BD', listIndex: 0 }]
    patch(files, `${d}layer_obj_data.json`, o => (o.slots = slots))
    const l = runW(files)
    expect(l.verdict).not.toBe('unavailable')
    expect(l.detail).toContain('Foreground checked at 2 camera positions')
    const [bg1, obj] = ['bg1', 'obj'].map(n => l.refs!.find(r => r.name === n)!)
    expect(bg1.x).toBe(408) // placed at the picture's own camera
    expect(obj.x).toBe(416) // its own frame's camera, not BG1's
    expect(obj.own?.oam).toBeTruthy()
    expect(bg1.sentinel).toBeNull() // no sidecar states one
    expect(l.detail).toContain('SNES pictures for 2 screens')
    expect(l.detail).toContain('sprite list: 1 of 1 entries seen alive') // live slots from the picture data
    // Two pictures of one window both list the slot: the window is named once.
    patch(files, `${d}layer_bg1_data.json`, o => (o.slots = slots))
    expect(runW(files).data!.spriteList[0].alive).toEqual(['screen_00'])
  })

  it('draws a picture at the scroll registers read on its own frame, shake and all, not the camera', () => {
    const files = captureFiles(false, undefined, [25])
    const d = 'windows/screen_00/'
    const data = json(files[d + 'layer_bg1_data.json'])
    picture(files, 'screen_00', 'bg2', Buffer.from('png'))
    // The camera has moved on (Layer 2 rising); the registers hold what was drawn,
    // Layer 1 Y with a 2 px screen shake.
    const regs = { BG1HOFS_210D: 400, BG1VOFS_210E: 18, BG2HOFS_210F: 200, BG2VOFS_2110: 180, BG3HOFS_2111: 0, BG3VOFS_2112: 208 } // prettier-ignore
    const camera = { ...data.camera, layer1X: 400, layer1Y: 16, layer2X: 200, layer2Y: 176 }
    files[`${d}layer_bg2_data.json`] = j({ ...data, ...regs, frame: 700, camera })
    const own = () => runW(files).refs!.find(r => r.name === 'bg2')!.own
    expect(own()!.scroll).toEqual([[400, 18], [200, 180], [0, 208]]) // prettier-ignore
    // Without the registers of its frame the picture is not compared.
    patch(files, `${d}layer_bg2_data.json`, o => delete o.BG2HOFS_210F)
    expect(own()).toBeUndefined()
  })

  it('makes a map with a malformed sidecar unavailable instead of stopping the run', () => {
    const files = captureFiles()
    files['map16_pipe_writes.json'] = Buffer.from('{"defs":{{"strip":-8}}')
    const l = run(files)
    expect(l.verdict).toBe('unavailable')
    expect(l.detail).toMatch(/^map16_pipe_writes\.json is not valid JSON/)
  })

  it('refuses a window without its VRAM or its frame', () => {
    const files = captureFiles(false, undefined, [25])
    expect(runW(files).verdict).not.toBe('unavailable')
    const noFrame = patch(
      { ...files },
      'windows/screen_00/layer_bg1_data.json',
      o => delete o.frame,
    )
    expect(runW(noFrame).detail).toMatch(/window screen_00 lacks .*frame/)
    delete files['windows/screen_00/layer_bg1_vram.bin']
    expect(runW(files).verdict).toBe('unavailable')
  })
})

describe('page', () => {
  it('puts only the map id, its badge and the controls above the map, and the checks below it', () => {
    const files = passing()
    // One list entry the capture recorded no spawn for: a guess whose reason has a comma in it.
    files['sprites.json'] = j({ entries: [{ index: 0, id: '$BD', x: 208, y: 272 }] })
    files['sprite_spawns.json'] = j({ playerOamEntries: [], spawns: [] })
    const l = runW(files)
    const html = page(l)
    const canvas = html.indexOf('<canvas id=cv>')
    const above = html
      .slice(0, canvas)
      .replace(/<style>[\s\S]*?<\/style>/, '')
      .replace(/<title>[^<]*<\/title>/, '')
      .replace(/<option[^>]*>[^<]*<\/option>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
    const controls = ['Foreground', 'Background', 'Effects', 'Sprites', 'Backdrop', 'zoom', 'screens', 'Mismatches', 'Show', 'guesses', 'Sprite', 'list'] // prettier-ignore
    expect(above.filter(w => !controls.includes(w))).toEqual(['index', 'map', '$10A', l.verdict])
    expect(html).toContain(`<span class="badge ${l.verdict}">${l.verdict}</span>`)
    const checks = html.indexOf('<section id=checks>')
    expect(checks).toBeGreaterThan(canvas)
    expect(checks).toBeLessThan(html.indexOf('<details><summary>How to read this page</summary>'))
    // One idea per line: no list item chains clauses with semicolons.
    const section = html.slice(checks, html.indexOf('</section>', checks))
    for (const item of section.match(/<li>[^<]*/g) ?? []) expect(item).not.toContain(';')
    expect(section).toMatch(
      /<tr><td>Foreground<td class="pass">pass<td>0 of [\d,]+ cells differ<td>0 px on 1 screen/,
    )
    for (const layer of ['Background', 'Effects', 'Sprites'])
      expect(section).toContain(`<tr><td>${layer}<td`)
    expect(section).toContain('<h4>Drawn from load-time data</h4>')
    expect(section).toContain('<h4>Backdrop</h4>')
    // A reason stays whole on its line: never split at its own comma.
    expect(section).toContain('<li>1 sprites: not drawn, their spawn not recorded')
  })

  it('runs the page script, viewer and hover included, with only what the page ships', () => {
    // A document just big enough for viewer(): every element records what the
    // page writes, the canvas takes pixels, and listeners are kept to call.
    const listeners: Record<string, (e: Obj) => void> = {}
    const els: Record<string, Obj> = {}
    const el = (): Obj => ({ checked: true, value: '2', style: {}, innerHTML: '', textContent: '', appendChild: (c: Obj) => c, getBoundingClientRect: () => ({ left: 0, top: 0 }), addEventListener: (t: string, f: (e: Obj) => void) => (listeners[t] = f), getContext: () => ({ createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => {} }) }) // prettier-ignore
    const document = { getElementById: (id: string) => (els[id] ??= el()), createElement: el, querySelectorAll: () => [] } // prettier-ignore
    const l = runW(passing())
    const script = /<script>([\s\S]*)<\/script>/.exec(page(l))![1]
    const ctx: Obj = { atob, document }
    runInNewContext(script, ctx)
    listeners.mousemove({ clientX: 40, clientY: 300 })
    expect(els.hc.textContent).toMatch(/^px 20,150 +tile \$001,\$09 +Map16 \$[0-9A-F]{3}\nTL \$/)
    expect(els.cv).toMatchObject({ width: l.data!.cols * 16, height: l.data!.rows * 16 })
    // The page draws with the page's copies alone, and draws what Node draws.
    ctx.input = l.data!.draw
    const drawn = runInNewContext('renderLevel(input)', ctx)
    const node = D.renderLevel(l.data!.draw)
    expect([drawn.W, drawn.H]).toEqual([node.W, node.H])
    for (let k = 0; k < 4; k++) expect(Buffer.from(drawn.layers[k].idx).equals(Buffer.from(node.layers[k].idx))).toBe(true) // prettier-ignore
    // Every export of the drawing half is in the page, constants included; the checks are not.
    for (const [k, v] of Object.entries(Draw)) expect(ctx[k], k).toEqual(typeof v === 'function' ? expect.any(Function) : v) // prettier-ignore
    expect(ctx.checkBg1).toBeUndefined()
  })

  it('keeps the hover readout out of the page flow, at a fixed size, in two columns', () => {
    // The canvas cannot move when the readout's text changes: the readout is
    // fixed-position (out of flow) with a fixed height, and both columns
    // always exist. Measured live in the browser pane as well; CI has no
    // layout engine, so this pins the rules that make it hold.
    const html = page(run(captureFiles()))
    const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
    const rule = /#hover\{([^}]*)\}/.exec(css)![1]
    expect(rule).toContain('position:fixed')
    expect(rule).toMatch(/(^|;)height:[\d.]+em/)
    expect(rule).toContain('grid-template-columns:1fr 1fr')
    expect(/#hover>div\{([^}]*)\}/.exec(css)![1]).toContain('overflow:hidden')
    expect(html).toContain('<div id=hover><div id=hc></div><div id=hs></div></div>')
    expect(html.indexOf('<div id=hover>')).toBeGreaterThan(html.indexOf('<canvas id=cv>'))
    // The handler writes the two columns only, never the panel itself.
    expect(html).toMatch(/\$\(["']hc["']\)\.textContent/)
    expect(html).toMatch(/\$\(["']hs["']\)\.textContent/)
    expect(html).not.toMatch(/\$\(["']hover["']\)\.(textContent|innerHTML)/)
  })

  it('says map, not level, on the page and the index (glossary: a level is made of maps)', () => {
    // A player's level is an entry map plus its sub areas; what one page shows
    // is a map. "levelLoadFrame" is the capture's own field name, allowed.
    const allowed = ['levelLoadFrame']
    const userText = (html: string) =>
      html
        .replace(/<script>[\s\S]*?<\/script>/g, '')
        .replace(/<style>[\s\S]*?<\/style>/g, '')
        .replace(new RegExp(allowed.join('|'), 'g'), '')
    const files = captureFiles(true, undefined, [8])
    files['sprites.json'] = j({ entries: [{ index: 0, id: '$BD', x: 208, y: 272 }] })
    files['sprite_spawns.json'] = j({ playerOamEntries: [], spawns: [] })
    files['l2_tilemap.json'] = j({ l2Source: 'objects' }) // refused: no layout stated
    const html = userText(page(runW(files)))
    expect(html.match(/level/gi) ?? []).toEqual([])
    expect(html).toContain('map $10A')
    const root = join(TMP, 'words')
    writeTree(join(root, 'in', '10a'), files)
    const log: string[] = []
    runCapture(join(root, 'in'), join(root, 'out'), l => log.push(l))
    const index = userText(readFileSync(join(root, 'out', 'index.html'), 'utf8'))
    expect(index.match(/level/gi) ?? []).toEqual([])
    expect(log.join('\n')).toMatch(/1 map\(s\): /)
  })

  it('labels every checkbox and ends with the help panel, collapsed', () => {
    const files = captureFiles()
    files['layer_bg1.png'] = Buffer.from('png')
    const html = page(run(files))
    for (const id of html.match(/type=checkbox id=\w+/g)!.map(m => m.split('id=')[1])) {
      expect(html).toContain(`<label for=${id}`)
    }
    expect(html).toContain('Show guesses')
    const help = html.indexOf('<details><summary>How to read this page</summary>')
    expect(help).toBeGreaterThan(html.indexOf('<canvas id=cv>'))
  })

  it('has no SNES overlay controls; the same-moment counts are in Checks', () => {
    const files = captureFiles(false, undefined, [8])
    // A 1x1 PNG, transparent to the sentinel.
    for (const n of ['bg1', 'bg2', 'bg3', 'obj']) picture(files, 'screen_00', n, onePixelPng([255, 0, 255]), SENTINEL) // prettier-ignore
    const l = runW(files)
    const html = page(l)
    for (const gone of ['id=refsel', 'id=op', 'id=diff', 'refnote', 'snestotal', 'data:image/png'])
      expect(html).not.toContain(gone)
    expect(l.snes).toMatchObject({ bg1: [expect.any(Number)], bg2: [expect.any(Number)], bg3: [expect.any(Number)] }) // prettier-ignore
    expect(l.checks!.rows.map(r => r.snes)).toEqual(Array(4).fill(expect.stringMatching(/^\d+ px on 1 screen$/))) // prettier-ignore
    // Every layer is on by default, Effects and Sprites included.
    for (const id of ['l0', 'l1', 'l2', 'l3'])
      expect(html).toContain(`<input type=checkbox id=${id} checked><label for=${id}`)
  })

  it('leaves the status bar cells the capture names out of Effects and its comparison', () => {
    const files = captureFiles(false, undefined, [8])
    picture(files, 'screen_00', 'bg3', onePixelPng([255, 0, 255]), SENTINEL)
    // BG3SC $53: map at word $5000, 64x64. $5420 is the right-hand screen, row 1, column 0.
    files['status_bar_cells.json'] = j({ available: true, reason: null, tilemapWordAddrs: [0x5000, 0x5001, 0x5420] }) // prettier-ignore
    const l = runW(files)
    expect(l.data!.draw.hideBg3).toEqual([0, 1, 1 * 64 + 32])
    expect(l.checks!.rows[2].note).toMatch(/^status bar excluded\./)
    files['status_bar_cells.json'] = j({ available: false, reason: 'DrawStatusBar opening bytes differ', tilemapWordAddrs: [0x5000] }) // prettier-ignore
    const off = runW(files)
    expect(off.data!.draw.hideBg3).toBeUndefined()
    expect(off.checks!.rows[2].note).toMatch(
      /^status bar included: not identified \(DrawStatusBar opening bytes differ\)\./,
    )
  })
})

describe('sprite spawns', () => {
  it('places each spawn by its entries relative to itself, the same frame, at its list position', () => {
    const files = captureFiles()
    files['sprites.json'] = j({ entries: [{ index: 0, id: '$BD', x: 208, y: 272 }, { index: 1, id: '$C7', x: 500, y: 300 }, { index: 2, id: '$AB', x: 600, y: 300 }] }) // prettier-ignore
    files['sprite_spawns.json'] = j({
      playerOamEntries: [66, 67],
      spawns: [
        // Just off the right edge: screen x 264, so the entries' X needs bit 8.
        { listIndex: 0, id: '$BD', x: 1264, y: 300, cameraX: 1000, cameraY: 200, listX: 1266, listY: 302, entries: [
          { entry: 5, x: 8, y: 100, tile: 1, attr: 2, sizeXHigh: 3 },
          { entry: 6, x: 0, y: 92, tile: 2, attr: 2, sizeXHigh: 3 },
          { entry: 7, x: 0, y: 240, tile: 3, attr: 2, sizeXHigh: 0 }, // parked below the screen
        ] },
        { listIndex: 2, id: '$AB', x: 600, y: 300, listX: 600, listY: 300, entries: [{ entry: 9, x: 0, y: 0, tile: 1, attr: 0, sizeXHigh: 0 }] }, // no camera
      ],
      unrecorded: [{ listIndex: 1, id: '$C7', reason: 'never drew a visible OAM entry' }],
    }) // prettier-ignore
    const l = run(files)
    const [a, b, c] = l.data!.draw.spawns
    expect(a).toMatchObject({ x: 1266, y: 302, reason: '' })
    expect(a.pieces!.map(p => [p.i, p.dx, p.dy, p.large])).toEqual([
      [5, 0, 0, 1],
      [6, -8, -8, 1],
    ])
    expect(b).toMatchObject({ pieces: null, reason: 'Its spawn was not recorded: never drew a visible OAM entry' }) // prettier-ignore
    expect(c.pieces).toBeNull()
    expect(c.reason).toMatch(/lacks the sprite position, camera or OAM entries/)
    expect(l.detail).toContain('2 sprites: not drawn, their spawn not recorded')
  })
})

describe('sprite animation frame', () => {
  // Frame n has one entry whose tile is 10 + n, so the drawn frame is visible in its tile.
  const frame = (frameIndex: number | null, n: number) => ({
    frameIndex,
    entries: [{ entry: 5, dx: n, dy: 0, tile: 10 + n, attr: 0, sizeXHigh: 2 }],
  })
  const rec = (first: number | null, frames: ReturnType<typeof frame>[]) => ({ firstFrameIndex: first, frames }) // prettier-ignore
  const tileOf = (r: ReturnType<typeof spriteFrame>) => r.pieces?.[0].tile

  it('draws the frame whose index is firstFrameIndex, not a guess', () => {
    const r = spriteFrame(rec(0, [frame(2, 2), frame(0, 0), frame(1, 1)]), 0)
    expect(tileOf(r)).toBe(10)
    expect(r.reason).toBe('')
    expect(r.frames).toBe('frame 0 drawn; recorded frames 2, 0, 1')
  })

  it('falls back to the earliest recorded frame, as a guess, when frame 0 was not observed', () => {
    const r = spriteFrame(rec(0, [frame(2, 2), frame(1, 1)]), 0)
    expect(tileOf(r)).toBe(12)
    expect(r.reason).toBe('First animation frame not observed; the earliest recorded frame is drawn') // prettier-ignore
  })

  it('falls back to the earliest recorded frame, as a guess, when the sprite has no frame index', () => {
    const r = spriteFrame(rec(null, [frame(null, 3), frame(null, 4)]), 0)
    expect(tileOf(r)).toBe(13)
    expect(r.reason).toBe('No frame index; the earliest recorded frame is drawn')
    expect(r.frames).toBe('frame (no index) drawn; recorded frames ?, ?')
  })

  it('draws a record with no recorded frames from its single recorded OAM', () => {
    const single = { x: 100, y: 50, cameraX: 0, cameraY: 0, frames: [], entries: [{ entry: 5, x: 100, y: 50, tile: 7, attr: 0, sizeXHigh: 2 }] } // prettier-ignore
    const r = spriteFrame(single, 0)
    expect(r.pieces).toEqual([{ i: 5, dx: 0, dy: 0, tile: 7, attr: 0, large: 1 }])
    expect(r.reason).toBe('')
  })
})

describe('map sprites against their recorded frames', () => {
  // List entry 0 recorded with one 16x16 tile; a window shows it later with another flip.
  function capture(recordAttr: number, windowAttr: number) {
    const files = captureFiles(false, undefined, [25])
    files['sprites.json'] = j({ entries: [{ index: 0, id: '$BD', x: 208, y: 272 }] })
    files['sprite_spawns.json'] = j({
      playerOamEntries: [],
      spawns: [{ listIndex: 0, id: '$BD', listX: 208, listY: 272, firstFrameIndex: 0, frames: [{ frameIndex: 0, tiles: [{ dx: 0, dy: 0, tile: 134, attr: recordAttr, large: true }] }] }], // prettier-ignore
    })
    const oam = Buffer.alloc(544)
    for (let i = 0; i < 128; i++) oam[i * 4 + 1] = 0xf0
    oam.set([2, 84, 134, windowAttr], 20)
    oam[513] = 2 << 2
    picture(files, 'screen_00', 'obj', Buffer.from('png'))
    files['windows/screen_00/layer_obj_oam.bin'] = oam
    patch(files, 'windows/screen_00/layer_obj_data.json', o => (o.slots = [{ slot: 7, id: '$BD', listIndex: 0, x: 400, y: 100 }])) // prettier-ignore
    return runW(files)
  }
  it('passes a sprite drawn as its recorded first real frame, whatever a window shows later', () => {
    for (const windowAttr of [0x66, 0x26]) {
      const l = capture(0x66, windowAttr) // recorded facing right; later the SNES may turn it
      expect(l.checks!.rows[3].map).toBe('0 of 1 drawn sprites differ from their recorded frames')
      expect(l.data!.spriteMismatches).toEqual([])
      expect(l.mapCheck).toBe('pass')
    }
  })
  it('says every layer is load-time data, sprites as coded on their first real frame', () => {
    const l = capture(0x66, 0x66)
    expect(l.detail).toContain('Foreground: the Map16 grid and defs at load')
    expect(l.detail).toContain("Sprites: the map's sprite list, each as coded, on the sprite's first real frame, with Mario at the map's start") // prettier-ignore
    expect(page(l)).toContain(
      'This checks our drawing code; it does\nnot decide what the map contains',
    )
    // The page lists each source on its own line, under the Checks section.
    expect(page(l)).toContain("<li>Sprites: the map's sprite list, each as coded")
  })
  it('compares drawn and recorded shapes by tiles and offsets, not priority or order', () => {
    const drawnShape = [{ i: 0, dx: 0, dy: 0, tile: 134, attr: 0x66, large: 1 }]
    expect(D.sameShape(drawnShape, [{ ...drawnShape[0], attr: 0x26 }])).toBe(false) // flip differs
    expect(D.sameShape(drawnShape, [{ ...drawnShape[0], i: 9, attr: 0x76 }])).toBe(true)
    expect(D.sameShape(drawnShape, [{ ...drawnShape[0], dx: 4 }])).toBe(true) // same shape, moved
  })
  it('counts a single-frame record as its recorded frame', () => {
    const files = captureFiles(false, undefined, [25])
    files['sprites.json'] = j({ entries: [{ index: 0, id: '$BD', x: 208, y: 272 }] })
    files['sprite_spawns.json'] = j({ playerOamEntries: [], spawns: [{ listIndex: 0, id: '$BD', listX: 208, listY: 272, x: 100, y: 50, cameraX: 0, cameraY: 0, frames: [], entries: [{ entry: 5, x: 100, y: 50, tile: 134, attr: 0x26, sizeXHigh: 2 }] }] }) // prettier-ignore
    const l = runW(files)
    expect(l.data!.spriteMismatches).toEqual([])
    expect(l.mapCheck).toBe('pass')
  })
})

describe('object Layer 2', () => {
  it('refuses a layout the capture does not state: the map is incomplete, exit 2', () => {
    const files = captureFiles()
    files['l2_tilemap.json'] = j({ l2Source: 'objects' })
    const l = run(files)
    expect(l.refused).toEqual([
      'Background refused (rule l2-layout): map16_grid.json states no layer2 layout',
    ])
    expect(l.data!.draw.background).toBe('refused')
    expect(l.checks!.rows[1].result).toBe('not compared')
    expect(l.verdict).toBe('incomplete')
    expect(exitCode([l.verdict])).toBe(2)
  })

  /**
   * Layer 1 as the fixture has it; Layer 2 objects in the same buffer after
   * it, 3 screens (48 columns) at their own stride ($1C0, 28 rows), and BG2
   * VRAM at word $3000 holding, OR'd with `or`, only the 32 strips the game
   * would hold with Layer 2's camera at strip `s`: s-8..s+23. A window at
   * Layer 2 strip `w` holds its own 32. Layer 1's camera stays at strip 8.
   */
  function objectL2(or: number, s = 8, w: number | null = null) {
    const files = captureFiles(false, undefined, w === null ? [] : [8])
    const gridJ = json(files['map16_grid.json'])
    const [l1Bytes, S2, screens2] = [3 * 0x1b0, 0x1c0, 3]
    const half = l1Bytes + screens2 * S2
    const old = files['map16_grid.bin']
    const grid = Buffer.alloc(half * 2)
    old.copy(grid, 0, 0, l1Bytes)
    old.copy(grid, half, gridJ.highOffset, gridJ.highOffset + l1Bytes)
    const at2 = (c: number, r: number) => l1Bytes + Math.floor(c / 16) * S2 + r * 16 + (c % 16)
    for (let r = 0; r < 28; r++) for (let c = 0; c < 48; c++) grid[at2(c, r)] = (c * 7 + r) % 200 // prettier-ignore
    files['map16_grid.bin'] = grid
    const layout = (stride: string, rows: number) => j({ ...gridJ, highOffset: half, layer2: { base: '$' + l1Bytes.toString(16), stride, orientation: 'horizontal', screens: 3, cols: 48, rows } }) // prettier-ignore
    files['map16_grid.json'] = layout('$1c0', 28)
    files['l2_tilemap.json'] = j({ l2Source: 'objects' })
    const defs = files['map16_defs.bin']
    const hold = (vram: Buffer, strip: number) => {
      for (let c = Math.max(0, strip - 8); c <= Math.min(47, strip + 23); c++)
        for (let r = 0; r < 28; r++)
          for (let q = 0; q < 4; q++) {
            const a = addr64(c * 2 + (q % 2), r * 2 + Math.floor(q / 2), 0x3000) * 2
            const id = grid[at2(c, r)]
            const word = defs[id * 8 + POS[q] * 2] | (defs[id * 8 + POS[q] * 2 + 1] << 8) | or
            ;[vram[a], vram[a + 1]] = [word & 255, word >> 8]
          }
      return vram
    }
    files['vram.bin'] = hold(Buffer.from(files['vram.bin']), s)
    patch(files, 'ppu.json', o => ((o.camera as Obj).layer2X = s * 16))
    if (w !== null) {
      const d = 'windows/screen_00/'
      files[d + 'layer_bg1_vram.bin'] = hold(Buffer.from(files[d + 'layer_bg1_vram.bin']), w)
      patch(files, d + 'layer_bg1_data.json', o => ((o.camera as Obj).layer2X = w * 16))
    }
    return { files, layout }
  }

  it('draws and checks object Layer 2 from its own base and stride', () => {
    const { files, layout } = objectL2(0)
    const l = run(files)
    expect(l.refused).toEqual([])
    expect(l.data!.draw.background).toBe('objects')
    expect(l.l2).toMatchObject({ verdict: 'pass', differ: 0 })
    expect(l.l2!.compared).toBeGreaterThan(0)
    expect(l.detail).toContain('Layer 2 palette OR not recorded')
    // Read with Layer 1's stride instead, the check goes red.
    files['map16_grid.json'] = layout('$1b0', 27)
    const wrong = run(files)
    expect(wrong.l2!.verdict).toBe('fail')
    expect(wrong.verdict).toBe('fail')
  })

  it.each([
    [25, 30],
    [30, 5],
  ])('checks Layer 2 at its own camera, sample strip %i and window strip %i', (s, w) => {
    const { files } = objectL2(0, s, w)
    const l = runW(files)
    expect(l.l2).toMatchObject({ verdict: 'pass', differ: 0 })
    // Either camera moved to Layer 1's strip 8 reads strips the VRAM does not hold.
    const moved = (name: string) => {
      const f = patch({ ...files }, name, o => ((o.camera as Obj).layer2X = 8 * 16))
      return runW(f).l2!.verdict
    }
    expect(moved('ppu.json')).toBe('fail')
    expect(moved('windows/screen_00/layer_bg1_data.json')).toBe('fail')
  })

  it('refuses a missing Layer 2 camera or window BG2SC instead of assuming 0', () => {
    const { files } = objectL2(0, 8, 8)
    expect(runW(files).l2!.verdict).toBe('pass')
    const noCam = patch({ ...files }, 'ppu.json', o => delete (o.camera as Obj).layer2X)
    expect(runW(noCam).refused).toEqual(['Background refused (rule l2-layout): ppu.json has no camera.layer2X/Y']) // prettier-ignore
    const noSc = patch({ ...files }, 'windows/screen_00/layer_bg1_data.json', o => delete o.BG2SC_2108) // prettier-ignore
    const l = runW(noSc)
    expect(l.refused![0]).toContain('window screen_00 has no camera.layer2X/Y or BG2SC_2108')
    expect(l.verdict).toBe('incomplete')
  })

  it('reads a Layer 2 check that compared no cell as not compared, never a pass', () => {
    // Every other check agrees, so only the empty Layer 2 check can leave the map incomplete.
    const { files } = objectL2(0, 8, 8)
    agreeing(files, 'screen_00')
    expect(runW(files).verdict).toBe('pass')
    patch(files, 'ppu.json', o => ((o.camera as Obj).layer2X = 5000))
    patch(files, 'windows/screen_00/layer_bg1_data.json', o => ((o.camera as Obj).layer2X = 5000))
    const l = runW(files)
    expect(l.l2).toMatchObject({ verdict: 'not compared', compared: 0 })
    expect(l.checks!.rows[1].result).toBe('not compared')
    expect(l.verdict).toBe('incomplete')
  })

  it('applies exactly the Layer 2 palette OR the capture recorded, and guesses none', () => {
    const { files } = objectL2(0x1000)
    // Not recorded: drawn as the defs give it, and the check sees the difference.
    const bare = run(files)
    expect(bare.l2!.verdict).toBe('fail')
    expect(bare.detail).toContain('Layer 2 palette OR not recorded')
    expect(bare.data!.draw.l2!.wordOr).toBeUndefined()
    const rec = (objectTileset: string, applied: string) => j({ l2Source: 'objects', paletteOrApplied: { objectTileset, compareTileset: '$03', orMask: '$1000', defaultMask: '$0000', applied, sites: ['$058B8D', '$058C71'] } }) // prettier-ignore
    files['l2_tilemap.json'] = rec('$03', '$1000')
    const l = run(files)
    expect(l.l2).toMatchObject({ verdict: 'pass', differ: 0 })
    expect(l.data!.draw.l2!.wordOr).toBe(0x1000)
    expect(l.detail).toContain('Layer 2 palette OR $1000 as recorded (object tileset $03, OR $1000 when tileset $03, else $0000)') // prettier-ignore
    // The applied mask decides, not the OR the compare would pick: here the default.
    files['l2_tilemap.json'] = rec('$01', '$0000')
    const dflt = run(files)
    expect(dflt.data!.draw.l2!.wordOr).toBeUndefined()
    expect(dflt.l2!.verdict).toBe('fail') // this VRAM holds the OR'd words
    // Recorded as unavailable: nothing applied, and the reason is given.
    files['l2_tilemap.json'] = j({ l2Source: 'objects', paletteOrApplied: null, paletteOrReason: 'upload routine replaced' }) // prettier-ignore
    const none = run(files)
    expect(none.l2!.verdict).toBe('fail')
    expect(none.detail).toContain('Layer 2 palette OR unavailable: upload routine replaced')
  })
})

describe('PNG decode', () => {
  it('decodes the PNGs it compares, and returns null for the kinds it does not read', () => {
    const two = png(2, 1, x => (x ? [15, 25, 35] : [10, 20, 30]))
    expect([...pngRgba(two)!.px]).toEqual([10, 20, 30, 255, 15, 25, 35, 255])
    const sub = png(2, 1, () => [], { rows: Buffer.from([1, 10, 20, 30, 5, 5, 5]) }) // filter Sub
    expect([...pngRgba(sub)!.px]).toEqual([10, 20, 30, 255, 15, 25, 35, 255])
    expect(pngRgba(png(2, 1, () => [0, 0, 0], { interlace: 1 }))).toBeNull()
    // Up, Average and Paeth rows, each against its predictor worked by hand.
    const filters = Buffer.from([0, 10, 20, 30, 40, 50, 60, 4, 1, 1, 1, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 3, 2, 2, 2, 3, 3, 3]) // prettier-ignore
    expect([...pngRgba(png(2, 4, () => [], { rows: filters }))!.px]).toEqual([
      10, 20, 30, 255, 40, 50, 60, 255, // None
      11, 21, 31, 255, 42, 52, 62, 255, // Paeth: up, then up (41 is nearest 40)
      12, 22, 32, 255, 43, 53, 63, 255, // Up
      8, 13, 18, 255, 28, 36, 43, 255, // Average: (left + up) >> 1
    ]) // prettier-ignore
    // A palette PNG reads each index through PLTE.
    const plte = Buffer.from([1, 2, 3, 4, 5, 6])
    expect([...pngRgba(png(2, 1, () => [], { rows: Buffer.from([0, 1, 0]), plte }))!.px]).toEqual([4, 5, 6, 255, 1, 2, 3, 255]) // prettier-ignore
  })

  it('makes a damaged PNG a capture error: that map unavailable, the run goes on', () => {
    const short = png(2, 2, () => [0, 0, 0], { rows: Buffer.from([0, 1, 2, 3, 4, 5, 6]) }) // one row of two
    expect(() => pngRgba(short)).toThrow('inflates to 7 bytes, not 14')
    const badFilter = png(1, 1, () => [], { rows: Buffer.from([9, 1, 2, 3]) })
    expect(() => pngRgba(badFilter)).toThrow('filter 9')
    const garbled = png(1, 1, () => [1, 2, 3])
    garbled.fill(0xff, 41, 47) // inside the IDAT stream
    expect(() => pngRgba(garbled)).toThrow('does not inflate')
    const root = join(TMP, 'png')
    const files = captureFiles(false, undefined, [8])
    picture(files, 'screen_00', 'bg2', short, SENTINEL)
    writeTree(join(root, 'in', '10a'), files)
    picture(files, 'screen_00', 'bg2', garbled, SENTINEL)
    writeTree(join(root, 'in', '10b'), files)
    writeTree(join(root, 'in', '105'), captureFiles())
    const lines: string[] = []
    expect(runCapture(join(root, 'in'), join(root, 'out'), l => lines.push(l))).toBe(2)
    expect(lines.join('\n')).toMatch(/\$10A +unavailable a 2x2 PNG inflates to 7 bytes/)
    expect(lines.join('\n')).toMatch(/\$10B +unavailable a PNG does not inflate/)
    expect(existsSync(join(root, 'out', '105', 'viewer.html'))).toBe(true)
  })
})

describe('map-wide render', () => {
  it('takes no window data: same input and same pixels with the windows gone', () => {
    const files = captureFiles(false, undefined, [8, 25])
    for (const n of ['bg1', 'bg2', 'bg3', 'obj']) picture(files, 'screen_01', n, Buffer.from('png'))
    const withWinsLevel = run(files, ['screen_00', 'screen_01'])
    const withWins = withWinsLevel.data!
    const without = run(files).data!
    expect(D.renderLevel.length).toBe(1)
    expect(Object.keys(withWins.draw).sort()).toEqual(['background', 'defs', 'grid', 'meta', 'order', 'pipe', 'regs', 'spawns', 'vram']) // prettier-ignore
    expect(withWins.draw).toEqual(without.draw)
    const [x, y] = [D.renderLevel(withWins.draw), D.renderLevel(without.draw)]
    expect(x.layers.map(l => [...l.idx])).toEqual(y.layers.map(l => [...l.idx]))
    expect(withWinsLevel.refs!.length).toBe(4) // the windows only reach the SNES comparison
  })
})

describe('capture run', () => {
  const root = join(TMP, 'run')
  const files = captureFiles(false, undefined, [8, 25])

  it('writes a page per compared map to the output folder, never to the input, and deletes a stale page', () => {
    const [input, out] = [join(root, 'run-in'), join(root, 'run-out')]
    writeTree(join(input, '105'), captureFiles())
    const aborted = captureFiles()
    delete aborted['capture_summary.json']
    writeTree(join(input, '0c4'), aborted)
    writeTree(join(out, '0c4'), { 'viewer.html': Buffer.from('stale') })
    const before = readdirSync(input, { recursive: true }).sort()
    const lines: string[] = []
    expect(runCapture(input, out, l => lines.push(l))).toBe(2)
    expect(existsSync(join(out, '105', 'viewer.html'))).toBe(true)
    expect(existsSync(join(out, 'index.html'))).toBe(true)
    expect(existsSync(join(out, '0c4', 'viewer.html'))).toBe(false)
    expect(readdirSync(input, { recursive: true }).sort()).toEqual(before)
    expect(lines.join('\n')).toMatch(/\$0C4 +unavailable no capture_summary/)
  })

  it('lists failures first on the index, with a column per deciding layer', () => {
    const bad = captureFiles()
    bad['vram.bin'][0x2000 * 2 + 40] ^= 1
    const input = join(root, 'index-in')
    writeTree(join(input, '105'), captureFiles())
    writeTree(join(input, '106'), bad)
    expect(runCapture(input, input + '-out', () => {})).toBe(1)
    const html = readFileSync(join(input + '-out', 'index.html'), 'utf8')
    expect(html).toContain('<th>map<th>result<th>Foreground<th>Background<th>Effects<th>orientation<th>screens<th>reason') // prettier-ignore
    expect(html.indexOf('$106')).toBeLessThan(html.indexOf('$105'))
    expect(html).toMatch(/\$105<\/a><td class=incomplete>incomplete<td class="nc">not compared/)
  })

  it('refuses an output folder that overlaps the captures or lies inside the repo, writing nothing', () => {
    const input = join(root, 'caps')
    writeTree(join(input, '105'), captureFiles())
    expect(folderProblem(input, join(root, 'pages'))).toBe('')
    expect(folderProblem(input, input)).toMatch(/is the captures folder or inside it/)
    expect(folderProblem(input, join(input, 'pages'))).toMatch(
      /is the captures folder or inside it/,
    )
    expect(folderProblem(input, root)).toMatch(/contains the captures folder/)
    expect(folderProblem(input, join(REPO, 'pages'))).toMatch(/inside the repo/)
    expect(folderProblem(input, input + '-sibling')).toBe('') // a shared name prefix is not inside
    expect(REPO).toBe(resolve(__dirname, '..', '..', '..'))
    const lines: string[] = []
    const inRepo = mkdtempSync(join(REPO, '.capture-test-'))
    try {
      expect(runCapture(input, join(inRepo, 'pages'), l => lines.push(l))).toBe(2)
      expect(readdirSync(inRepo)).toEqual([])
    } finally {
      rmSync(inRepo, { recursive: true, force: true })
    }
    expect(runCapture(input, join(input, 'pages'), l => lines.push(l))).toBe(2)
    expect(existsSync(join(input, 'pages'))).toBe(false)
    expect(lines).toHaveLength(2)
  })

  it('follows junctions and symlinks before deciding whether folders overlap', () => {
    const input = join(root, 'linked-caps')
    writeTree(join(input, '105'), captureFiles())
    const toInput = join(root, 'to-caps')
    symlinkSync(input, toInput, 'junction') // a directory symlink where junctions do not exist
    expect(folderProblem(input, join(toInput, 'pages'))).toMatch(
      /is the captures folder or inside it/,
    )
    expect(folderProblem(toInput, join(input, 'pages'))).toMatch(
      /is the captures folder or inside it/,
    )
    const inRepo = mkdtempSync(join(REPO, '.capture-test-'))
    const toRepo = join(root, 'to-repo')
    try {
      symlinkSync(inRepo, toRepo, 'junction')
      expect(folderProblem(input, join(toRepo, 'pages'))).toMatch(/inside the repo/)
    } finally {
      rmSync(toRepo, { force: true, recursive: true })
      rmSync(inRepo, { recursive: true, force: true })
    }
    expect(existsSync(input)).toBe(true) // removing a link leaves its target
  })

  it('takes relative folders from INIT_CWD, where npm was run, not the working directory', () => {
    const [npmDir, cwd] = [join(root, 'where-npm-ran'), join(root, 'repo-root')]
    expect(cliFolders(['caps', 'out'], { INIT_CWD: npmDir }, cwd)).toEqual([join(npmDir, 'caps'), join(npmDir, 'out')]) // prettier-ignore
    expect(cliFolders(['caps', 'out'], {}, cwd)).toEqual([join(cwd, 'caps'), join(cwd, 'out')]) // run without npm
    expect(cliFolders([join(root, 'a'), 'b'], { INIT_CWD: npmDir }, cwd)).toEqual([join(root, 'a'), join(npmDir, 'b')]) // prettier-ignore
    expect(cliFolders(['caps'], {}, cwd)).toBeNull()
    expect(cliFolders([], {}, cwd)).toBeNull()
    // By default it reads this process's own INIT_CWD, as the command line does.
    const saved = process.env.INIT_CWD
    try {
      process.env.INIT_CWD = npmDir
      expect(cliFolders(['caps', 'out'])![0]).toBe(join(npmDir, 'caps'))
    } finally {
      if (saved === undefined) delete process.env.INIT_CWD
      else process.env.INIT_CWD = saved
    }
  })

  it('renders a map from its zip exactly as from its folder, nested under its id or at the root', () => {
    const [dir, nested, flat, back] = ['dir', 'nested', 'flat', 'back'].map(n => join(root, n))
    writeTree(join(dir, '10a'), files)
    writeTree(nested, { '10a.zip': zip(under('10a/', files)) })
    writeTree(flat, { '10a.zip': zip(files, 0) }) // stored, entries at the root
    writeTree(back, { '10a.zip': zip(Object.entries(under('10a/', files)).map(([n, b]) => [n.replace(/\//g, '\\'), b])) }) // prettier-ignore
    const pageOf = (input: string) => {
      runCapture(input, input + '-out', () => {})
      return readFileSync(join(input + '-out', '10a', 'viewer.html'), 'utf8')
    }
    const want = pageOf(dir)
    expect(want).toContain('<canvas id=cv>')
    expect(pageOf(nested)).toBe(want)
    expect(pageOf(flat)).toBe(want)
    expect(pageOf(back)).toBe(want) // `\` in entry names read as `/`
  })

  it('computes the zip CRC-32 of the standard check value, in zlib and in JS alike', () => {
    for (const f of [crc32, crc32Js]) expect(f(Buffer.from('123456789'))).toBe(0xcbf43926)
    const big = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 37) & 255))
    expect(crc32Js(big)).toBe(crc32(big))
  })

  it('makes an unreadable zip unavailable, says why, and renders the rest', () => {
    const input = join(root, 'bad')
    const good = zip(under('10a/', files))
    const resize = (z: Buffer, by: number) => {
      z.writeUInt32LE(z.readUInt32LE(firstEntry(z) + 24) + by, firstEntry(z) + 24)
      return z
    }
    const crc = zip(under('10f/', files), 0)
    crc[30 + '10f/capture_summary.json'.length] ^= 1 // first stored byte
    const summary = files['capture_summary.json']
    writeTree(input, {
      '10a.zip': good.subarray(0, good.length - 30), // truncated: no end record
      '10b.zip': zip(under('10b/', files), 12),
      '10c.zip': resize(zip(under('10c/', files)), -1), // inflates past its stated size
      '10d.zip': resize(zip(under('10d/', files)), 1), // stated size one byte long
      '10e.zip': good, // also a folder: the folder is read
      '10f.zip': crc,
      '110.zip': zip([['110/capture_summary.json', summary], ['110/capture_summary.json', summary]]), // prettier-ignore
      ...under('10e/', files),
      ...under('105/', files),
    })
    const lines: string[] = []
    expect(runCapture(input, input + '-out', l => lines.push(l))).toBe(2)
    const log = lines.join('\n')
    expect(log).toMatch(/\$10A +unavailable not a readable zip: no end of central directory/)
    expect(log).toMatch(/\$10B +unavailable not a readable zip: 10b\/capture_summary\.json uses compression method 12/) // prettier-ignore
    expect(log).toMatch(/\$10C +unavailable not a readable zip: 10c\/capture_summary\.json: /)
    expect(log).toMatch(/\$10D +unavailable not a readable zip: 10d\/capture_summary\.json is \d+ bytes, its header says \d+/) // prettier-ignore
    expect(log).toMatch(/\$10F +unavailable not a readable zip: 10f\/capture_summary\.json fails its CRC/) // prettier-ignore
    expect(log).toMatch(/\$110 +unavailable not a readable zip: 110\/capture_summary\.json appears twice/) // prettier-ignore
    expect(log).toContain('10e: both a folder and a zip; the folder is read')
    expect(log).toMatch(/\$10E +incomplete/)
    expect(log).toMatch(/\$105 +incomplete/)
  })
})
