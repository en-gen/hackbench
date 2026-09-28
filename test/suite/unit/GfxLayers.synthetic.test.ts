/**
 * GFX edits as staged op layers (#405): one layer per 8x8 character, and
 * consecutive gfx layers folded into one re-encode per file on replay.
 * docs/layer-previews.md ("Staged (gfx)") is the model.
 *
 * **Synthetic cartridges only** (test/suite/support/syntheticGfxCart.ts).
 * Each rule's checker is run once against a planted defect built from the
 * same public pieces, so a checker that cannot fail shows up red here.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { encode } from '../../../src/rom/LcLz2'
import { GFX_FILE_COUNT } from '../../../src/rom/GfxArena'
import { GfxTable } from '../../../src/rom/GfxTable'
import { RomFile } from '../../../src/rom/RomFile'
import { GfxCharEdit, GfxRefusal, baseGfxTemplates, foldGfxRun } from '../../../src/rom/GfxLayer'
import { GfxLayer, Layer, WorkingRom } from '../../../src/project/WorkingRom'
import { appendLayer, loadLayers } from '../../../src/project/OpsStore'
import { buildCart } from '../support/syntheticGfxCart'

/** 11 tiles at 3bpp: not a multiple of 16 or 32, so every file infers 3bpp. */
const BYTES = 11 * 24

function payload(i: number): Uint8Array {
  return Uint8Array.from({ length: BYTES }, (_, k) => (i * 13 + k * 5) & 0xff)
}

function cartBytes(
  opts: { filler?: number; entryBytes?: number[]; files?: Record<number, Uint8Array> } = {},
): Uint8Array {
  const streams = Array.from({ length: GFX_FILE_COUNT }, (_, i) =>
    encode(opts.files?.[i] ?? payload(i)),
  )
  const { rom } = buildCart({ streams, filler: opts.filler ?? 4096, entryBytes: opts.entryBytes })
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

function tableOf(bytes: Uint8Array): GfxTable {
  return GfxTable.load(new RomFile('working.sfc', Buffer.from(bytes)))
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0
}

/** An encoder that records which file each call re-encoded, identified by
 *  the base template it was handed. */
function countingEncoder(base: Uint8Array): { calls: number[]; encoder: typeof encode } {
  const templates = baseGfxTemplates(base)
  const calls: number[] = []
  return {
    calls,
    encoder: (data, template) => {
      calls.push(templates.findIndex(t => template !== undefined && sameBytes(t, template)))
      return encode(data, template)
    },
  }
}

function build(base: Uint8Array, layers: readonly Layer[], encoder = encode): WorkingRom {
  const w = new WorkingRom(base, false, { gfxEncoder: encoder })
  for (const l of layers) w.append(l)
  return w
}

/** What a replay that does not fold would produce: each character on its own. */
function oneAtATime(base: Uint8Array, layers: readonly GfxLayer[], encoder = encode): Uint8Array {
  const out = new Uint8Array(base)
  const templates = baseGfxTemplates(base)
  for (const l of layers) foldGfxRun(out, false, templates, [asEdit(l)], encoder)
  return out
}

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

  it('two layers on one file re-encode that file exactly once', () => {
    const base = cartBytes()
    const { calls, encoder } = countingEncoder(base)
    const w = build(base, [A, B], encoder)
    calls.length = 0
    w.exportableBytes()
    expectEncodes(calls, [2])
  })

  it('layers on different files re-encode each file once, in stack order', () => {
    const base = cartBytes()
    const { calls, encoder } = countingEncoder(base)
    const w = build(base, [C, A, B], encoder)
    calls.length = 0
    w.exportableBytes()
    expectEncodes(calls, [9, 2])
  })

  it('the working copy equals applying the characters one at a time', () => {
    const base = cartBytes()
    const layers = [A, C, B, D]
    const folded = build(base, layers).bytes()
    expect(sameBytes(folded, oneAtATime(base, layers))).toBe(true)
    const t = tableOf(folded)
    expect(t.tile(2, 0)![0 * 8 + 1]).toBe(2) // D, the later layer, wins at (1,0)
    expect(t.tile(9, 3)![7 * 8 + 7]).toBe(2)
  })

  // Re-encoding against what an earlier layer left, instead of the base
  // stream, keeps that layer's literals after the pixel is painted back, so
  // the folded and one-at-a-time results would part.
  it('a pixel painted and painted back leaves the ROM byte-identical, folded or not', () => {
    const base = cartBytes({ files: { 0: new Uint8Array(BYTES) } })
    const layers = [gfx(0, 0, [[0, 0, 1]]), gfx(0, 0, [[0, 0, 0]])]
    expect(sameBytes(build(base, layers).bytes(), base)).toBe(true)
    expect(sameBytes(oneAtATime(base, layers), base)).toBe(true)
  })

  describe('planted defects turn each checker red', () => {
    it('a replay that re-encodes per layer', () => {
      const base = cartBytes()
      const { calls, encoder } = countingEncoder(base)
      oneAtATime(base, [A, B], encoder)
      expect(() => expectEncodes(calls, [2])).toThrow()
    })

    it('a replay that re-encodes in file order', () => {
      const base = cartBytes()
      const { calls, encoder } = countingEncoder(base)
      const sorted = [C, A].map(asEdit).sort((x, y) => x.file - y.file)
      foldGfxRun(new Uint8Array(base), false, baseGfxTemplates(base), sorted, encoder)
      expect(() => expectEncodes(calls, [9, 2])).toThrow()
    })

    it('a replay that applies the characters out of order', () => {
      const base = cartBytes()
      const folded = build(base, [A, C, B, D]).bytes()
      expect(sameBytes(folded, oneAtATime(base, [D, C, B, A]))).toBe(false)
    })
  })
})

describe('undo and redo', () => {
  it("undoing a gfx layer restores the file's bytes to what they were before it", () => {
    const base = cartBytes()
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
    const base = cartBytes()
    const before = build(base, [A, C]).bytes()
    expect(sameBytes(tableOf(before).files[9]!.bytes, tableOf(base).files[9]!.bytes)).toBe(false)
  })
})

describe('scope line', () => {
  const diff = (a: Uint8Array, b: Uint8Array): number =>
    a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0)

  it('reports how many bytes that layer moved, against the snapshot below it', () => {
    const base = cartBytes()
    const w = build(base, [A, B])
    const expected = diff(build(base, [A]).bytes(), w.bytes())
    expect(expected).toBeGreaterThan(0)
    expect(w.bytesChangedBy(1)).toBe(expected)
    expect(w.scopeLine(1)).toContain(`${expected} bytes`)
    // planted: counting against the base instead of the layer below differs
    expect(diff(base, w.bytes())).not.toBe(expected)
  })

  it('a palette layer has no scope line', () => {
    const base = cartBytes()
    const w = build(base, [
      { id: 'p', label: 'p', ops: [{ address: '$008000', old: '$0000', new: '$0001' }] },
    ])
    expect(w.scopeLine(0)).toBeNull()
  })
})

describe('refusals leave the stack untouched', () => {
  function refused(base: Uint8Array, layer: GfxLayer): GfxRefusal {
    const w = new WorkingRom(base, false)
    try {
      w.append(layer)
    } catch (err) {
      expect(w.stack).toHaveLength(0)
      expect(sameBytes(w.bytes(), base)).toBe(true)
      expect(err).toBeInstanceOf(GfxRefusal)
      return err as GfxRefusal
    }
    throw new Error('append was accepted')
  }
  const noisy = gfx(0, 0, [
    [0, 0, 1],
    [2, 1, 5],
    [4, 2, 3],
    [6, 3, 7],
    [1, 5, 6],
  ])
  const flat = { 0: new Uint8Array(BYTES) }

  it('an arena that would overflow, with the exact overage', () => {
    const e = refused(cartBytes({ filler: 0, files: flat }), noisy)
    expect(e.overage).toBeGreaterThan(0)
    expect(e.message).toMatch(/#218/)
  })

  it('a replaced decompressor entry', () => {
    const entryBytes = [0x22, 0x00, 0x00, 0x20, 0xea, 0x22, 0x00, 0x00, 0x20, 0x60]
    expect(refused(cartBytes({ entryBytes }), A).message).toMatch(/\$00B8DE|decompress/i)
  })

  it('a file whose bit depth is unknown', () => {
    const e = refused(
      cartBytes({ files: { 5: new Uint8Array(BYTES + 1) } }),
      gfx(5, 0, [[0, 0, 1]]),
    )
    expect(e.message).toMatch(/depth/)
  })

  it('planted: each refusal fixture is accepted once its one defect is removed', () => {
    for (const [base, layer] of [
      [cartBytes({ files: flat }), noisy],
      [cartBytes(), A],
      [cartBytes(), gfx(5, 0, [[0, 0, 1]])],
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
