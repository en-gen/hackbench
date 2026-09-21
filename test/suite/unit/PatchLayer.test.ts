import { describe, it, expect } from 'vitest'
import {
  Patch,
  PatchLayer,
  flatten,
  applyPatches,
  build,
  invertLayer,
  upTo,
  squash,
} from '../../../src/rom/PatchLayer'

const layer = (id: string, patches: Patch[]): PatchLayer => ({ id, label: id, patches })

/** A base with distinct bytes, so a wrong offset shows up as a wrong value. */
const base = (): Uint8Array => Uint8Array.from({ length: 16 }, (_, i) => (i * 0x11) & 0xff)

describe('flatten', () => {
  it('lets a later layer win where two overlap', () => {
    const out = flatten([
      layer('a', [{ offset: 4, value: 0xaa }]),
      layer('b', [{ offset: 4, value: 0xbb }]),
    ])
    expect(out).toEqual([{ offset: 4, value: 0xbb }])
  })

  it('keeps writes from layers that do not overlap', () => {
    const out = flatten([
      layer('a', [{ offset: 1, value: 0xaa }]),
      layer('b', [{ offset: 9, value: 0xbb }]),
    ])
    expect(out).toEqual([
      { offset: 1, value: 0xaa },
      { offset: 9, value: 0xbb },
    ])
  })

  it('orders by offset, so equivalent stacks flatten identically', () => {
    const a = flatten([
      layer('x', [
        { offset: 9, value: 1 },
        { offset: 2, value: 2 },
      ]),
    ])
    const b = flatten([
      layer('y', [{ offset: 2, value: 2 }]),
      layer('z', [{ offset: 9, value: 1 }]),
    ])
    expect(a).toEqual(b)
  })

  it('is empty for no layers', () => {
    expect(flatten([])).toEqual([])
  })
})

describe('applyPatches', () => {
  it('does not touch the base', () => {
    const rom = base()
    const before = Uint8Array.from(rom)
    applyPatches(rom, [{ offset: 3, value: 0xff }])
    expect(rom).toEqual(before)
  })

  it('writes the patched byte and leaves its neighbours alone', () => {
    const out = applyPatches(base(), [{ offset: 3, value: 0xff }])
    expect(out[3]).toBe(0xff)
    expect(out[2]).toBe(base()[2])
    expect(out[4]).toBe(base()[4])
  })

  // A patch that lands nowhere is the dangerous failure: the preview would
  // render the UNEDITED level and look perfectly correct.
  it.each([-1, 16, 1.5])('throws on out-of-range offset %s', off => {
    expect(() => applyPatches(base(), [{ offset: off, value: 1 }])).toThrow(RangeError)
  })

  it.each([-1, 256, 1.5])('throws on non-byte value %s', v => {
    expect(() => applyPatches(base(), [{ offset: 0, value: v }])).toThrow(RangeError)
  })
})

describe('invertLayer', () => {
  it('round-trips a single layer back to the base', () => {
    const rom = base()
    const edit = layer('edit', [
      { offset: 2, value: 0x77 },
      { offset: 5, value: 0x88 },
    ])
    const edited = build(rom, [edit])
    expect(edited).not.toEqual(rom)
    expect(build(rom, [edit, invertLayer(rom, edit)])).toEqual(rom)
  })

  it('captures the byte that was under it, not the one being written', () => {
    const rom = base()
    const undo = invertLayer(rom, layer('e', [{ offset: 7, value: 0x99 }]))
    expect(undo.patches).toEqual([{ offset: 7, value: rom[7] }])
  })

  it('refuses to invert a patch outside the ROM', () => {
    expect(() => invertLayer(base(), layer('e', [{ offset: 99, value: 1 }]))).toThrow(RangeError)
  })
})

describe('upTo', () => {
  const stack = [
    layer('one', [{ offset: 0, value: 1 }]),
    layer('two', [{ offset: 1, value: 2 }]),
    layer('three', [{ offset: 2, value: 3 }]),
  ]

  it('rebuilds the ROM as it stood at an earlier edit', () => {
    const rom = base()
    const at2 = build(rom, upTo(stack, 'two'))
    expect(at2[0]).toBe(1)
    expect(at2[1]).toBe(2)
    expect(at2[2]).toBe(rom[2]) // the third edit had not happened yet
  })

  it('includes the named layer itself', () => {
    expect(upTo(stack, 'two').map(l => l.id)).toEqual(['one', 'two'])
  })

  // Returning the whole stack would silently mean "no time travel happened".
  it('throws on an unknown id rather than returning everything', () => {
    expect(() => upTo(stack, 'nope')).toThrow(/no layer with id/)
  })
})

describe('squash', () => {
  it('produces a ROM identical to the run it replaces', () => {
    const rom = base()
    const run = [
      layer('a', [
        { offset: 1, value: 0x10 },
        { offset: 2, value: 0x20 },
      ]),
      layer('b', [
        { offset: 2, value: 0x30 },
        { offset: 8, value: 0x40 },
      ]),
    ]
    expect(build(rom, [squash(run, 'c', 'committed')])).toEqual(build(rom, run))
  })
})

/**
 * Proof the suite above can actually go red.
 *
 * Every assertion here would still pass against a broken flatten that ignored
 * layer order, or a broken applyPatches that wrote nothing, unless something
 * checks the checks. These plant exactly those defects and require the
 * distinguishing property to fail.
 */
describe('the oracle can fail', () => {
  it('a flatten that ignored order would break the last-writer-wins test', () => {
    const firstWins = (layers: readonly PatchLayer[]): Patch[] => {
      const seen = new Map<number, number>()
      for (const l of layers)
        for (const p of l.patches) if (!seen.has(p.offset)) seen.set(p.offset, p.value)
      return [...seen.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([offset, value]) => ({ offset, value }))
    }
    const stack = [
      layer('a', [{ offset: 4, value: 0xaa }]),
      layer('b', [{ offset: 4, value: 0xbb }]),
    ]
    expect(firstWins(stack)).not.toEqual(flatten(stack))
  })

  it('an applyPatches that dropped writes would break the round-trip test', () => {
    const noop = (rom: Uint8Array): Uint8Array => new Uint8Array(rom)
    const rom = base()
    expect(noop(rom)).not.toEqual(applyPatches(rom, [{ offset: 3, value: 0xff }]))
  })

  it('an invert that echoed the new value would not restore the base', () => {
    const rom = base()
    const edit = layer('e', [{ offset: 2, value: 0x77 }])
    const wrongUndo: PatchLayer = { id: 'w', label: 'w', patches: edit.patches }
    expect(build(rom, [edit, wrongUndo])).not.toEqual(rom)
    expect(build(rom, [edit, invertLayer(rom, edit)])).toEqual(rom)
  })
})
