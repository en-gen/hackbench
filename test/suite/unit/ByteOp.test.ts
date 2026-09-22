/**
 * The raw-byte op, and why a palette op could not have done the job.
 *
 * Synthetic buffers only; nothing here is cartridge-derived.
 */
import { describe, it, expect } from 'vitest'
import {
  applyByteRun,
  byteRunFileOffset,
  formatHexBytes,
  isByteRunOp,
  parseHexBytes,
} from '../../../src/rom/ByteOp'
import { applyOp } from '../../../src/rom/PaletteOp'
import { WorkingRom } from '../../../src/project/WorkingRom'
import { COPIER_HEADER_SIZE } from '../../../src/rom/addressing'

const ROM_SIZE = 0x10000
/** Bank 1, $8000: file offset $8000, comfortably inside the buffer. */
const ADDR = '$018000'
const OFFSET = 0x8000

function cart(fill = 0x00): Uint8Array {
  return new Uint8Array(ROM_SIZE).fill(fill)
}

describe('parseHexBytes and formatHexBytes', () => {
  it('round trip', () => {
    const bytes = Uint8Array.from([0x00, 0x7f, 0x80, 0xff, 0xa5])
    expect(parseHexBytes(formatHexBytes(bytes))).toEqual(bytes)
  })

  it('refuses an odd-length or non-hex run rather than guessing', () => {
    expect(() => parseHexBytes('A0F')).toThrow(/hex byte run/)
    expect(() => parseHexBytes('ZZ')).toThrow(/hex byte run/)
  })

  it('formats upper case and zero padded, so two equal runs compare equal', () => {
    expect(formatHexBytes(Uint8Array.from([0x0a, 0xbc]))).toBe('0ABC')
  })
})

describe('applyByteRun', () => {
  it('writes every byte, high bit included', () => {
    // The whole reason this op exists: PaletteOp masks bit 15 off a word,
    // because a CGRAM entry has none. Compressed graphics do.
    const out = cart()
    applyByteRun(out, { address: ADDR, oldBytes: '0000', newBytes: '80FF' }, ROM_SIZE, false)
    expect([out[OFFSET], out[OFFSET + 1]]).toEqual([0x80, 0xff])
  })

  it('and a palette op in its place would lose that bit, which is the defect', () => {
    const out = cart()
    applyOp(out, { address: ADDR, old: '$0000', new: '$FF80' }, ROM_SIZE, false)
    expect([out[OFFSET], out[OFFSET + 1]]).toEqual([0x80, 0x7f])
  })

  it('refuses a run that changes length', () => {
    expect(() =>
      applyByteRun(cart(), { address: ADDR, oldBytes: '00', newBytes: '8010' }, ROM_SIZE, false),
    ).toThrow(/changes length/)
  })

  it('refuses a run whose tail falls off the end of the cart', () => {
    const at = `$01${(0xffff - 1).toString(16).toUpperCase()}`
    const op = { address: at, oldBytes: '000000', newBytes: 'AABBCC' }
    expect(byteRunFileOffset(op, ROM_SIZE, false)).toBeNull()
    expect(() => applyByteRun(cart(), op, ROM_SIZE, false)).toThrow(/does not fit/)
  })

  it('accounts for a copier header in the offset it resolves', () => {
    expect(
      byteRunFileOffset({ address: ADDR, oldBytes: '00', newBytes: '01' }, ROM_SIZE, true),
    ).toBe(OFFSET + COPIER_HEADER_SIZE)
  })

  it('tells the two op shapes apart', () => {
    expect(isByteRunOp({ address: ADDR, oldBytes: '00', newBytes: '01' })).toBe(true)
    expect(isByteRunOp({ address: ADDR, old: '$0000', new: '$0001' })).toBe(false)
  })
})

describe('WorkingRom carries both op shapes', () => {
  const layer = (id: string, newBytes: string, oldBytes = '0000') => ({
    id,
    label: id,
    ops: [{ address: ADDR, oldBytes, newBytes }],
  })

  it('applies a byte run and reflects it in bytes()', () => {
    const w = new WorkingRom(cart(), false)
    w.append(layer('a', '80FF'))
    expect([w.bytes()[OFFSET], w.bytes()[OFFSET + 1]]).toEqual([0x80, 0xff])
  })

  it('refuses a stale byte run instead of writing over something else', () => {
    const w = new WorkingRom(cart(), false)
    expect(() => w.append(layer('a', '80FF', 'BEEF'))).toThrow(/stale byte run/)
    expect(w.stack.length).toBe(0)
  })

  it('removeById takes a layer out from under a later one', () => {
    // The GFX arena layer stops being the top layer as soon as another view
    // writes through the same working copy; popping would take the wrong one.
    const w = new WorkingRom(cart(), false)
    w.append(layer('gfx-arena', '80FF'))
    w.append({
      id: 'palette',
      label: 'palette',
      ops: [{ address: '$018100', old: '$0000', new: '$03E0' }],
    })

    expect(w.removeById('gfx-arena')).toBe(true)
    expect(w.stack.map(l => l.id)).toEqual(['palette'])
    expect([w.bytes()[OFFSET], w.bytes()[OFFSET + 1]]).toEqual([0x00, 0x00])
    expect(w.bytes()[0x8100]).toBe(0xe0) // the later layer still applies
  })

  it('removeById says so when there was nothing to remove', () => {
    expect(new WorkingRom(cart(), false).removeById('gfx-arena')).toBe(false)
  })

  it('a removed layer is not offered back by redo', () => {
    // It was derived, not a user action, so putting it on the redo stack
    // would put a layer nobody made one keystroke from reappearing.
    const w = new WorkingRom(cart(), false)
    w.append(layer('gfx-arena', '80FF'))
    w.removeById('gfx-arena')
    expect(w.redoStack.length).toBe(0)
    expect(w.redo()).toBeUndefined()
  })

  it('exportableBytes carries a derived edit layer, because an export must', () => {
    const w = new WorkingRom(cart(), false)
    w.append(layer('gfx-arena', '80FF'))
    expect(w.exportableBytes()[OFFSET]).toBe(0x80)
  })
})
