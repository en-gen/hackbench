/**
 * GFX edits as staged op layers (#405): one layer per 8x8 character, and
 * consecutive gfx layers folded into one re-encode per file on replay.
 * docs/layer-previews.md ("Staged (gfx)") is the model.
 *
 * **Synthetic ROMs only** (test/suite/support/syntheticGfxCart.ts). The
 * expected bytes come from `planGfxSave`, a separate path from the fold, and
 * each rule's checker is also run against a planted defect.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { encode } from '../../../src/rom/LcLz2'
import { GFX_FILE_COUNT, readGfxFileTable } from '../../../src/rom/GfxArena'
import { GfxTable, planGfxSave } from '../../../src/rom/GfxTable'
import { setTilePixel } from '../../../src/rom/GraphicsDecoder'
import { RomFile } from '../../../src/rom/RomFile'
import { COPIER_HEADER_SIZE, loromToOffset } from '../../../src/rom/addressing'
import { GfxCharEdit, GfxRefusal, foldGfxRun, readGfxBase } from '../../../src/rom/GfxLayer'
import { GfxLayer, Layer, OpsLayer, WorkingRom } from '../../../src/project/WorkingRom'
import { appendLayer, loadLayers } from '../../../src/project/OpsStore'
import { ARENA_AT, TABLE_BANK, applyWrites, buildCart } from '../support/syntheticGfxCart'

/** 11 tiles at 3bpp: not a multiple of 16 or 32, so every file infers 3bpp. */
const BYTES = 11 * 24

function payload(i: number): Uint8Array {
  return Uint8Array.from({ length: BYTES }, (_, k) => (i * 13 + k * 5) & 0xff)
}

interface RomOptions {
  filler?: number
  entryBytes?: number[]
  files?: Record<number, Uint8Array>
  outliers?: Record<number, number>
  headered?: boolean
}

function streamsFor(files: Record<number, Uint8Array> = {}): Uint8Array[] {
  return Array.from({ length: GFX_FILE_COUNT }, (_, i) => encode(files[i] ?? payload(i)))
}

function romBytes(opts: RomOptions = {}): Uint8Array {
  const { rom } = buildCart({
    ...opts,
    streams: streamsFor(opts.files),
    filler: opts.filler ?? 4096,
  })
  return new Uint8Array(rom.buffer)
}

let seq = 0
function gfx(file: number, tile: number, pixels: [number, number, number][]): GfxLayer {
  return {
    id: `gfx-${seq++}`,
    label: `GFX ${file} char ${tile}`,
    kind: 'gfx',
    file,
    tile,
    pixels: pixels.map(([x, y, value]) => ({ x, y, value })),
  }
}
const asEdit = (l: GfxLayer): GfxCharEdit => ({ file: l.file, tile: l.tile, pixels: l.pixels })

/** A word write that changes nothing, at an address the synthetic ROM leaves zero:
 *  the smallest layer that still ends a gfx run. */
function noop(id = `p-${seq++}`): OpsLayer {
  return { id, label: id, ops: [{ address: '$00F000', old: '$0000', new: '$0000' }] }
}

function tableOf(bytes: Uint8Array): GfxTable {
  return GfxTable.load(new RomFile('working.sfc', Buffer.from(bytes)))
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0
}

/** An encoder that records which file each call re-encoded, identified by
 *  the base template it was handed. */
function countingEncoder(base: Uint8Array): { calls: number[]; encoder: typeof encode } {
  const { templates } = readGfxBase(base)
  const calls: number[] = []
  return {
    calls,
    encoder: (data, template) => {
      calls.push(templates.findIndex(t => template !== undefined && sameBytes(t, template)))
      return encode(data, template)
    },
  }
}

function build(
  base: Uint8Array,
  layers: readonly Layer[],
  encoder = encode,
  header = false,
): WorkingRom {
  const w = new WorkingRom(base, header, { gfxEncoder: encoder })
  for (const l of layers) w.append(l)
  return w
}

/**
 * The expected ROM, by a path that shares nothing with the fold: every edit
 * painted into one table decoded from the base, then `planGfxSave`.
 */
function oracle(base: Uint8Array, layers: readonly GfxLayer[]): Uint8Array {
  const rom = new RomFile('base.sfc', Buffer.from(base))
  const table = GfxTable.load(rom)
  for (const l of layers) {
    for (const p of l.pixels) table.setPixel({ kind: 'gfxPixel', file: l.file, tile: l.tile, ...p })
  }
  const plan = planGfxSave(rom, table)
  if (plan.status !== 'ok') throw new Error(`oracle: ${plan.status}`)
  return new Uint8Array(applyWrites(rom, plan.plan.writes).buffer)
}

/** Each layer as its own run: a no-op word write between every pair. */
const split = (layers: readonly GfxLayer[]): Layer[] => layers.flatMap(l => [l, noop()])

const A = gfx(2, 0, [
  [0, 0, 7],
  [1, 0, 6],
  [2, 3, 1],
])
const B = gfx(2, 1, [[4, 4, 5]])
const C = gfx(9, 3, [
  [7, 7, 2],
  [0, 5, 3],
])
const D = gfx(2, 0, [[1, 0, 2]]) // overlaps A's (1,0)

describe('replay folds consecutive gfx layers', () => {
  const expectEncodes = (calls: number[], files: number[]): void => {
    expect(calls).toEqual(files)
  }
  function replayed(base: Uint8Array, layers: readonly Layer[]): number[] {
    const { calls, encoder } = countingEncoder(base)
    new WorkingRom(base, false, { gfxEncoder: encoder }).restore(layers)
    return calls
  }

  it('two layers on one file re-encode that file exactly once', () => {
    expectEncodes(replayed(romBytes(), [A, B]), [2])
  })

  it('layers on different files re-encode each file once, in stack order', () => {
    expectEncodes(replayed(romBytes(), [C, A, B]), [9, 2])
  })

  it('a word write between gfx layers ends the run', () => {
    const base = romBytes()
    expectEncodes(replayed(base, [A, noop(), B]), [2, 2])
    expect(sameBytes(build(base, [A, noop(), B]).bytes(), oracle(base, [A, B]))).toBe(true)
  })

  it('the working copy equals the independent oracle, folded or one at a time', () => {
    const base = romBytes()
    const layers = [A, C, B, D]
    const expected = oracle(base, layers)
    expect(sameBytes(build(base, layers).bytes(), expected)).toBe(true)
    expect(sameBytes(build(base, split(layers)).bytes(), expected)).toBe(true)
    const t = tableOf(expected)
    expect(t.tile(2, 0)![0 * 8 + 1]).toBe(2) // D, the later layer, wins at (1,0)
    expect(t.tile(9, 3)![7 * 8 + 7]).toBe(2)
  })

  it('a headered ROM gets the same bytes behind its header', () => {
    const layers = [A, C, B, D]
    const bare = build(romBytes(), layers).bytes()
    const headered = build(romBytes({ headered: true }), layers, encode, true).bytes()
    expect(sameBytes(headered.subarray(COPIER_HEADER_SIZE), bare)).toBe(true)
    expect(headered.subarray(0, COPIER_HEADER_SIZE).every(b => b === 0x5a)).toBe(true)
  })

  // Re-encoding against what an earlier layer left, instead of the base
  // stream, keeps that layer's literals after the pixel is painted back.
  it('a pixel painted and painted back leaves the ROM byte-identical, folded or not', () => {
    const base = romBytes({ files: { 0: new Uint8Array(BYTES) } })
    const layers = [gfx(0, 0, [[0, 0, 1]]), gfx(0, 0, [[0, 0, 0]])]
    expect(sameBytes(build(base, layers).bytes(), base)).toBe(true)
    expect(sameBytes(build(base, split(layers)).bytes(), base)).toBe(true)
  })

  // Region structure read from the working copy instead of the base: L1 grows
  // file 3 by exactly the 18 filler bytes, so its region then abuts file 49,
  // merges with it, and L2's shrink drags file 49 back.
  it('a region grown to touch an outlier keeps the base layout, folded or not', () => {
    const streams = streamsFor({ 3: new Uint8Array(BYTES) })
    const arenaEnd = ARENA_AT + streams.slice(0, 49).reduce((n, s) => n + s.length, 0)
    const base = romBytes({
      files: { 3: new Uint8Array(BYTES) },
      filler: 18,
      outliers: { 49: arenaEnd + 18 },
    })
    const grow: [number, number, number][] = []
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) grow.push([x, y, 1 + ((x + y) % 7)])
    const L1 = gfx(3, 0, grow.slice(0, 17))
    const L2 = gfx(3, 0, [[grow[16]![0], grow[16]![1], 0]])
    const expected = oracle(base, [L1, L2])
    expect(readGfxFileTable(new RomFile('x.sfc', Buffer.from(expected)))[49]!.offset).toBe(
      arenaEnd + 18,
    )
    expect(sameBytes(build(base, [L1, L2]).bytes(), expected)).toBe(true)
    expect(sameBytes(build(base, [L1, noop(), L2]).bytes(), expected)).toBe(true)
  })

  // Bit 7 of a bank byte is the FastROM mirror. The ROM reads the same data
  // either way, so a save that drops it rewrites every bank byte for nothing.
  it('keeps the FastROM bit of every bank byte it rewrites', () => {
    const base = romBytes()
    for (let i = 0; i < GFX_FILE_COUNT; i++) base[(TABLE_BANK & 0x7fff) + i]! |= 0x80
    const after = build(base, [gfx(2, 0, [])]).bytes()
    const at = loromToOffset(TABLE_BANK, base.length)!
    expect([...after.subarray(at, at + GFX_FILE_COUNT)]).toEqual([
      ...base.subarray(at, at + GFX_FILE_COUNT),
    ])
  })

  describe('planted defects turn each checker red', () => {
    it('a replay that re-encodes per layer', () => {
      expect(() => expectEncodes(replayed(romBytes(), split([A, B])), [2])).toThrow()
    })

    it('a replay that re-encodes in file order', () => {
      const base = romBytes()
      const { calls, encoder } = countingEncoder(base)
      const sorted = [C, A].map(asEdit).sort((x, y) => x.file - y.file)
      foldGfxRun(new Uint8Array(base), false, readGfxBase(base), sorted, encoder)
      expect(() => expectEncodes(calls, [9, 2])).toThrow()
    })

    it('a replay that applies the characters out of order', () => {
      const base = romBytes()
      expect(sameBytes(build(base, [A, C, B, D]).bytes(), oracle(base, [D, C, B, A]))).toBe(false)
    })
  })
})

describe('what an edit costs', () => {
  const palette = (i: number): OpsLayer => ({
    id: `p${i}`,
    label: `p${i}`,
    ops: [{ address: '$00F000', old: `$${i.toString(16)}`, new: `$${(i + 1).toString(16)}` }],
  })
  /** 40 gfx layers, each its own run, interleaved with 40 word writes. */
  const mixed = (): Layer[] =>
    Array.from({ length: 40 }, (_, i) => [gfx(i, 0, [[i % 8, 0, 1 + (i % 7)]]), palette(i)]).flat()

  it('reopening 40 gfx and 40 word layers re-encodes 40 times, once per run', () => {
    const base = romBytes()
    const { calls, encoder } = countingEncoder(base)
    const w = new WorkingRom(base, false, { gfxEncoder: encoder })
    w.restore(mixed())
    w.bytes()
    expect(calls).toHaveLength(40)
    expect(sameBytes(w.bytes(), build(base, mixed()).bytes())).toBe(true)
  })

  it('an edit re-encodes its own file once, and undo re-encodes nothing', () => {
    const base = romBytes()
    const { calls, encoder } = countingEncoder(base)
    const w = new WorkingRom(base, false, { gfxEncoder: encoder })
    w.restore(mixed())
    calls.length = 0
    w.append(palette(40))
    expect(calls).toHaveLength(0)
    w.append(gfx(45, 1, [[0, 0, 1]]))
    expect(calls).toEqual([45])
    calls.length = 0
    // Down through the new gfx layer, both word writes, and a restored gfx
    // layer: each lands on a snapshot or reverts its own writes.
    for (let i = 0; i < 4; i++) {
      w.undo()
      w.bytes()
    }
    expect(calls).toEqual([])
    expect(sameBytes(w.bytes(), build(base, mixed().slice(0, 78)).bytes())).toBe(true)
  })

  it('refuses a restore onto a stack that already holds layers', () => {
    const w = build(romBytes(), [A])
    expect(() => w.restore([C])).toThrow()
  })
})

describe('undo and redo', () => {
  it("undoing a gfx layer restores the file's bytes to what they were before it", () => {
    const base = romBytes()
    const w = build(base, [A, C])
    const withC = new Uint8Array(w.bytes())
    w.undo()
    expect(sameBytes(tableOf(w.bytes()).files[9]!.bytes, tableOf(base).files[9]!.bytes)).toBe(true)
    expect(sameBytes(w.bytes(), build(base, [A]).bytes())).toBe(true)
    w.undo()
    expect(sameBytes(w.bytes(), base)).toBe(true)
    w.redo()
    w.redo()
    expect(sameBytes(w.bytes(), withC)).toBe(true)
  })

  it('planted: the checker sees an undo that restored nothing', () => {
    const base = romBytes()
    const before = build(base, [A, C]).bytes()
    expect(sameBytes(tableOf(before).files[9]!.bytes, tableOf(base).files[9]!.bytes)).toBe(false)
  })
})

describe('scope line', () => {
  const diff = (a: Uint8Array, b: Uint8Array): number =>
    a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0)

  it('reports how many bytes that layer moved, against the snapshot below it', () => {
    const base = romBytes()
    const w = build(base, [A, B])
    const expected = diff(build(base, [A]).bytes(), w.bytes())
    expect(expected).toBeGreaterThan(0)
    expect(w.bytesChangedBy(1)).toBe(expected)
    expect(w.scopeLine(1)).toContain(`${expected} bytes`)
    // planted: counting against the base instead of the layer below differs
    expect(diff(base, w.bytes())).not.toBe(expected)
  })

  it('a palette layer has no scope line', () => {
    const base = romBytes()
    const w = build(base, [
      { id: 'p', label: 'p', ops: [{ address: '$008000', old: '$0000', new: '$0001' }] },
    ])
    expect(w.scopeLine(0)).toBeNull()
  })
})

describe('refusals leave the stack and the cache untouched', () => {
  function refused(base: Uint8Array, layer: GfxLayer, below: Layer[] = []): GfxRefusal {
    const w = build(base, below)
    const before = w.bytes()
    const snapshot = new Uint8Array(before)
    try {
      w.append(layer)
    } catch (err) {
      expect(w.stack).toHaveLength(below.length)
      expect(w.bytes()).toBe(before)
      expect(sameBytes(before, snapshot)).toBe(true)
      expect(err).toBeInstanceOf(GfxRefusal)
      return err as GfxRefusal
    }
    throw new Error('append was accepted')
  }
  const noisyPixels: [number, number, number][] = [
    [0, 0, 1],
    [2, 1, 5],
    [4, 2, 3],
    [6, 3, 7],
    [1, 5, 6],
  ]
  const noisy = gfx(0, 0, noisyPixels)
  const flat = { 0: new Uint8Array(BYTES) }

  it('an arena that would overflow, with the exact overage', () => {
    const painted = new Uint8Array(BYTES)
    for (const [x, y, v] of noisyPixels) setTilePixel(painted, 0, 3, x, y, v)
    const template = encode(new Uint8Array(BYTES))
    const growth = encode(painted, template).length - template.length
    expect(growth).toBeGreaterThan(0)

    const e = refused(romBytes({ filler: 0, files: flat }), noisy, [C, noop()])
    expect(e.overage).toBe(growth)
    expect(e.message).toMatch(/#218/)
  })

  it('a replaced decompressor entry', () => {
    const entryBytes = [0x22, 0x00, 0x00, 0x20, 0xea, 0x22, 0x00, 0x00, 0x20, 0x60]
    expect(refused(romBytes({ entryBytes }), A).message).toMatch(
      /replaced the LC_LZ2 decompressor at \$00B8DE/,
    )
  })

  it('a file whose bit depth is unknown', () => {
    const e = refused(
      romBytes({ files: { 5: new Uint8Array(BYTES + 1) } }),
      gfx(5, 0, [[0, 0, 1]]),
      [A],
    )
    expect(e.message).toMatch(/depth/)
  })

  it('foldGfxRun leaves its buffer untouched when it refuses', () => {
    const base = romBytes({ filler: 0, files: flat })
    const out = new Uint8Array(base)
    expect(() => foldGfxRun(out, false, readGfxBase(base), [asEdit(noisy)])).toThrow(GfxRefusal)
    expect(sameBytes(out, base)).toBe(true)
  })

  it('planted: each refusal fixture is accepted once its one defect is removed', () => {
    for (const [base, layer] of [
      [romBytes({ files: flat }), noisy],
      [romBytes(), A],
      [romBytes(), gfx(5, 0, [[0, 0, 1]])],
    ] as const) {
      const w = new WorkingRom(base, false)
      w.append(layer)
      expect(w.stack).toHaveLength(1)
    }
  })
})

describe('OpsStore persists a gfx layer', () => {
  it('round trips, one pixel per line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-gfxops-'))
    try {
      appendLayer(dir, A)
      const text = fs.readFileSync(path.join(dir, 'ops', '0000.json'), 'utf8')
      expect(text).toContain('\n    {"x":1,"y":0,"value":6},\n')
      expect(loadLayers(dir)).toEqual([A])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ['a fractional pixel coordinate', (t: string) => t.replace('"x":1,', '"x":1.5,')],
    ['a fractional file number', (t: string) => t.replace(/"file": \d+/, '"file": 2.5')],
    ['a missing character number', (t: string) => t.replace(/ {2}"tile": \d+,\n/, '')],
    ['pixels that are not a list', (t: string) => t.replace(/"pixels": \[[^\]]*\]/, '"pixels": 3')],
  ])('refuses a layer file with %s', (_name, damage) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-gfxops-'))
    try {
      appendLayer(dir, A)
      const file = path.join(dir, 'ops', '0000.json')
      const damaged = damage(fs.readFileSync(file, 'utf8'))
      expect(damaged).not.toBe(fs.readFileSync(file, 'utf8')) // the plant landed
      fs.writeFileSync(file, damaged)
      expect(() => loadLayers(dir)).toThrow(/gfx layer/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
