/**
 * Undo and redo through the working copy (#1237), with no ROM: the Objects cache keys on the bytes array the
 * working copy hands out, so it must be a NEW array after every change, undo and redo included. A WorkingRom whose
 * undo reverted the live array in place would be served the edited map's answer after the undo.
 */
import { describe, it, expect } from 'vitest'
import { WorkingRom, type Layer } from '../../../src/project/WorkingRom'
import { loromToOffset } from '../../../src/rom/addressing'
import { PerBytes } from '../../../theia/extension/src/node/map-objects'

const ADDR = 0x00b2ce
function rom(): Uint8Array {
  const out = new Uint8Array(0x4000)
  for (let i = 0; i < out.length; i++) out[i] = (i * 31) & 0xff
  const at = loromToOffset(ADDR, out.length, false) as number
  out[at] = 0x1f
  out[at + 1] = 0x39
  return out
}
const layer: Layer = {
  id: 'L1',
  label: 'L1',
  scope: 'edit',
  ops: [{ address: '$00B2CE', old: '$391F', new: '$03E0' }],
}
/** What a map's Objects would be: any function of the bytes will do for the cache's sake. */
const answerOf = (bytes: Uint8Array) => bytes[loromToOffset(ADDR, bytes.length, false) as number]

describe('the working copy hands out a new array for every change', () => {
  it('append, undo and redo each give a different array, with the right content', () => {
    const working = new WorkingRom(rom(), false)
    const before = working.bytes()
    working.append(layer)
    const edited = working.bytes()
    working.undo()
    const undone = working.bytes()
    working.redo()
    const redone = working.bytes()
    expect(new Set([before, edited, undone, redone]).size).toBe(4)
    expect([answerOf(before), answerOf(edited), answerOf(undone), answerOf(redone)]).toEqual([
      0x1f, 0xe0, 0x1f, 0xe0,
    ])
    // The array before the undo was not reverted in place.
    expect(answerOf(edited)).toBe(0xe0)
  })
})

describe('the Objects cache follows the working copy through an edit, undo and redo', () => {
  it('builds again for each new array and serves the old array its own answer', () => {
    const working = new WorkingRom(rom(), false)
    const cache = new PerBytes<number>()
    let built = 0
    const ask = (bytes: Uint8Array) => cache.get(bytes, 0x103, () => (built++, answerOf(bytes)))
    const before = working.bytes()
    expect(ask(before)).toBe(0x1f)
    expect(ask(before)).toBe(0x1f)
    expect(built).toBe(1)
    working.append(layer)
    expect(ask(working.bytes())).toBe(0xe0)
    working.undo()
    // Undo: the whole answer is back, not the edited one.
    expect(ask(working.bytes())).toBe(0x1f)
    working.redo()
    expect(ask(working.bytes())).toBe(0xe0)
    expect(built).toBe(4)
    // The first array still answers as it did, from the cache.
    expect(ask(before)).toBe(0x1f)
    expect(built).toBe(4)
  })

  it('keeps a few slots per array and drops the oldest', () => {
    const cache = new PerBytes<number>()
    const bytes = new Uint8Array(4)
    let built = 0
    for (let slot = 0; slot < 6; slot++) cache.get(bytes, slot, () => (built++, slot))
    cache.get(bytes, 5, () => (built++, 5))
    expect(built).toBe(6)
    cache.get(bytes, 0, () => (built++, 0))
    expect(built).toBe(7)
  })
})
