import { describe, it, expect } from 'vitest'
import { deleteSprite, moveObjectX } from '../../../src/rom/LevelEdits'
import { applyPatches, build, invertLayer } from '../../../src/rom/PatchLayer'
import { parseLevelObjects, parseLevelSprites } from '../../../src/rom/LevelParser'

/**
 * A minimal Layer-1 buffer: 5-byte header, then 3-byte objects, then $FF.
 *
 * levelMode lives in header byte 1's low 5 bits and selects orientation
 * through VerticalTable (bank_05.asm:480-484). Mode 0 is horizontal, mode 3
 * is Layer-1 vertical, so the two are enough to exercise both byte layouts.
 */
function l1(levelMode: number, objects: number[][]): Uint8Array {
  return Uint8Array.from([0, levelMode, 0, 0, 0, ...objects.flat(), 0xff])
}

/** Place the L1 data inside a larger "ROM" so file offsets are exercised. */
const L1_AT = 0x300
function romWith(data: Uint8Array): Uint8Array {
  const rom = new Uint8Array(0x1000)
  rom.set(data, L1_AT)
  return rom
}

describe('moveObjectX, horizontal level', () => {
  // byte 0 = $00 (Y 0, no flags), byte 1 = $35 (object 3, X 5), byte 2 = settings
  const data = l1(0, [[0x00, 0x35, 0x01]])

  it('reads X from byte 1 and patches that byte', () => {
    const l = moveObjectX(data, L1_AT, 0, 2)
    expect(l.patches).toEqual([{ offset: L1_AT + 5 + 1, value: 0x37 }])
  })

  it('preserves the object number in the high nibble', () => {
    const [p] = moveObjectX(data, L1_AT, 0, -5).patches
    expect(p.value & 0xf0).toBe(0x30)
    expect(p.value & 0x0f).toBe(0)
  })

  it('actually moves the object when applied and re-parsed', () => {
    const moved = applyPatches(romWith(data), moveObjectX(data, L1_AT, 0, 3).patches)
    const reparsed = parseLevelObjects(moved.subarray(L1_AT, L1_AT + data.length))
    expect(parseLevelObjects(data).objects[0].x).toBe(5)
    expect(reparsed.objects[0].x).toBe(8)
  })
})

describe('moveObjectX, vertical level', () => {
  // Vertical swaps the nibbles' meaning: X is byte 0's low nibble.
  const data = l1(3, [[0x05, 0x30, 0x01]])

  it('reads X from byte 0 and patches that byte', () => {
    expect(parseLevelObjects(data).isVertical).toBe(true)
    expect(moveObjectX(data, L1_AT, 0, 2).patches).toEqual([{ offset: L1_AT + 5, value: 0x07 }])
  })
})

describe('moveObjectX refuses what a byte patch cannot express', () => {
  it.each([
    ['off the right edge', 0x0f, 1],
    ['off the left edge', 0x00, -1],
  ])('throws when the move leaves the screen: %s', (_why, x, dx) => {
    const data = l1(0, [[0x00, 0x30 | x, 0x01]])
    expect(() => moveObjectX(data, L1_AT, 0, dx)).toThrow(/leaves its screen/)
  })

  it('throws for an object index that does not exist', () => {
    expect(() => moveObjectX(l1(0, [[0, 0x35, 1]]), L1_AT, 7, 1)).toThrow(RangeError)
  })
})

describe('an edit is undoable as a layer', () => {
  const data = l1(0, [[0x00, 0x35, 0x01], [0x00, 0x48, 0x02]])

  it('drops back to the original bytes when inverted', () => {
    const rom = romWith(data)
    const edit = moveObjectX(data, L1_AT, 1, 4)
    expect(build(rom, [edit])).not.toEqual(rom)
    expect(build(rom, [edit, invertLayer(rom, edit)])).toEqual(rom)
  })

  it('stacks two edits, later one winning on the same byte', () => {
    const rom = romWith(data)
    const out = build(rom, [moveObjectX(data, L1_AT, 0, 1), moveObjectX(data, L1_AT, 0, 3)])
    expect(out[L1_AT + 6] & 0x0f).toBe(8) // 5 + 3, not 5 + 1 and not 5 + 4
  })
})

/**
 * Proof the tests above can go red. The dangerous defect is an edit that
 * locates the wrong byte: the ROM still boots, the level still renders, and
 * only a re-parse notices that nothing moved.
 */
describe('the oracle can fail', () => {
  it('patching the object-number nibble instead of X would not move it', () => {
    const data = l1(0, [[0x00, 0x35, 0x01]])
    const wrong = [{ offset: L1_AT + 5 + 1, value: (0x35 & 0x0f) | 0x70 }]
    const moved = applyPatches(romWith(data), wrong)
    const reparsed = parseLevelObjects(moved.subarray(L1_AT, L1_AT + data.length))
    expect(reparsed.objects[0].x).toBe(5) // unmoved, so the round-trip test would fail
    expect(reparsed.objects[0].objectNumber).not.toBe(3) // and it corrupted the object
  })

  it('assuming 3 bytes per object would mislocate anything after a screen exit', () => {
    // A screen exit is an extended object (objectNumber 0) with settings 0,
    // and it consumes a FOURTH byte (bank_0D.asm:1416). An index-times-three
    // guess puts the next object's patch one byte early.
    const data = l1(0, [[0x00, 0x00, 0x00, 0x05], [0x00, 0x35, 0x01]])
    const { objects } = parseLevelObjects(data)
    expect(objects[1].streamOffset).toBe(5 + 4)
    expect(objects[1].streamOffset).not.toBe(5 + 3)
    expect(moveObjectX(data, L1_AT, 1, 1).patches[0].offset).toBe(L1_AT + 5 + 4 + 1)
  })
})

/**
 * Sprite stream: one header byte, then 3-byte entries, then $FF.
 * Byte 1's high nibble is X, low nibble the screen; byte 2 is the id.
 */
function spriteStream(entries: number[][]): Uint8Array {
  return Uint8Array.from([0x00, ...entries.flat(), 0xff])
}
const SPR_AT = 0x500
function romWithSprites(data: Uint8Array): Uint8Array {
  const rom = new Uint8Array(0x1000)
  rom.set(data, SPR_AT)
  return rom
}

describe('deleteSprite', () => {
  // three sprites, ids $0A $0B $0C, all on screen 0 at x 1, 2, 3
  const data = spriteStream([[0x00, 0x10, 0x0a], [0x00, 0x20, 0x0b], [0x00, 0x30, 0x0c]])

  it('removes the named sprite and keeps the rest in order', () => {
    const out = applyPatches(romWithSprites(data), deleteSprite(data, SPR_AT, 1).patches)
    const left = parseLevelSprites(out.subarray(SPR_AT, SPR_AT + data.length))
    expect(left.map(s => s.spriteId)).toEqual([0x0a, 0x0c])
  })

  it('shifts the tail down rather than blanking the entry', () => {
    const out = applyPatches(romWithSprites(data), deleteSprite(data, SPR_AT, 0).patches)
    const left = parseLevelSprites(out.subarray(SPR_AT, SPR_AT + data.length))
    expect(left.map(s => s.spriteId)).toEqual([0x0b, 0x0c])
    expect(left[0].x).toBe(2) // $0B kept its own position, it did not inherit $0A's
  })

  it('deleting the last one leaves the others untouched', () => {
    const out = applyPatches(romWithSprites(data), deleteSprite(data, SPR_AT, 2).patches)
    expect(parseLevelSprites(out.subarray(SPR_AT, SPR_AT + data.length)).map(s => s.spriteId))
      .toEqual([0x0a, 0x0b])
  })

  it('deleting the only sprite leaves an empty stream', () => {
    const one = spriteStream([[0x00, 0x10, 0x0a]])
    const out = applyPatches(romWithSprites(one), deleteSprite(one, SPR_AT, 0).patches)
    expect(parseLevelSprites(out.subarray(SPR_AT, SPR_AT + one.length))).toEqual([])
  })

  it('throws for a sprite that does not exist', () => {
    expect(() => deleteSprite(data, SPR_AT, 9)).toThrow(RangeError)
  })

  it('is undoable as a layer', () => {
    const rom = romWithSprites(data)
    const del = deleteSprite(data, SPR_AT, 1)
    expect(build(rom, [del])).not.toEqual(rom)
    expect(build(rom, [del, invertLayer(rom, del)])).toEqual(rom)
  })

  // The dangerous defect: writing $FF over the entry instead of shifting.
  // The stream terminates THERE, so every later sprite silently vanishes too.
  it('a terminator-in-place delete would drop the later sprites as well', () => {
    const wrong = [{ offset: SPR_AT + 1 + 3, value: 0xff }]
    const out = applyPatches(romWithSprites(data), wrong)
    const left = parseLevelSprites(out.subarray(SPR_AT, SPR_AT + data.length))
    expect(left.map(s => s.spriteId)).toEqual([0x0a])       // $0C lost
    expect(left.map(s => s.spriteId)).not.toEqual([0x0a, 0x0c])
  })
})
