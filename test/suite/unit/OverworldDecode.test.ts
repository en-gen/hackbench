/**
 * The Overworld view's decode (theia/extension/src/node/overworld-decode.ts).
 * Refusals run without a ROM; the drawn result needs vanilla.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { OW_L1_READER_PINS } from '../../../src/rom/OverworldL1'
import { map16ByteOffset } from '../../../src/rom/OverworldLoader'
import { WorkingRom } from '../../../src/project/WorkingRom'
import { FULL_WORD_MASK } from '../../../src/rom/PaletteOp'
import { decodeOverworldL1 } from '../../../theia/extension/src/node/overworld-decode'
import { VANILLA, freshRom, hasRom } from '../support/corpus'

const blank = (): RomFile => {
  const buf = Buffer.alloc(0x80000, 0)
  buf[0x7fd5] = 0x20
  return new RomFile('blank.sfc', buf)
}

describe('decodeOverworldL1 refusals', () => {
  it('a ROM without the stock L1 reader is refused with a reason and no pixels', () => {
    const dto = decodeOverworldL1(new SmwRom(blank()))
    expect(dto).toEqual({
      status: 'unavailable',
      reason: expect.stringMatching(/not stock at \$00A126/),
    })
  })

  it('a readable L1 with no title screen map to seed the palette is refused too', () => {
    const rom = blank()
    for (const pin of OW_L1_READER_PINS) rom.writeAt(pin.addr, [...pin.bytes])
    rom.writeAt(0x04dc16, [0x00, 0xe0, 0x04])
    rom.writeAt(0x04dc3b, [0x00, 0x80])
    rom.writeAt(0x04dc5b, [0x00, 0x90])
    rom.writeAt(0x04dc62, [0x0d])
    rom.writeAt(
      0x058a3c,
      [0xa0, 0x0e, 0xad, 0x31, 0x19, 0xc9, 0x10, 0x30, 0x02, 0xa0, 0x0e, 0x84, 0x0c],
    )
    const dto = decodeOverworldL1(new SmwRom(rom))
    expect(dto).toEqual({ status: 'unavailable', reason: expect.stringMatching(/^Title screen/) })
  })
})

const sha = (dto: ReturnType<typeof decodeOverworldL1>): string => {
  if (dto.status !== 'ok') throw new Error(dto.reason)
  return createHash('sha256').update(Buffer.from(dto.rgbaBase64, 'base64')).digest('hex')
}

describe.skipIf(!hasRom(VANILLA))('decodeOverworldL1 on vanilla', () => {
  it('draws the whole grid at 1024x512 with real, varied pixels', () => {
    const dto = decodeOverworldL1(new SmwRom(freshRom()))
    if (dto.status !== 'ok') throw new Error(dto.reason)
    expect([dto.width, dto.height, dto.objectTileset]).toEqual([1024, 512, 0x11])
    const px = Buffer.from(dto.rgbaBase64, 'base64')
    expect(px.length).toBe(1024 * 512 * 4)
    const colors = new Set<number>()
    let magenta = 0
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue
      colors.add(px.readUInt32BE(i))
      if (px[i] === 255 && px[i + 1] === 0 && px[i + 2] === 255) magenta++
    }
    expect(colors.size).toBeGreaterThan(16)
    expect(magenta).toBe(0) // every char resolved in VRAM
  })

  it('a working-copy edit to the L1 tile data changes the pixels; undoing it restores them', () => {
    const rom = freshRom()
    const working = new WorkingRom(Uint8Array.from(rom.buffer), rom.hasHeader)
    const draw = () =>
      sha(decodeOverworldL1(new SmwRom(RomFile.fromBytes('w', Buffer.from(working.bytes())))))
    const before = draw()
    // Grid cell (row 1, col 55) draws fully opaque on vanilla; tile 0 draws nothing.
    const at = 0x0cf7df + map16ByteOffset(1, 1, 55 - 32)
    const old = rom.readWord(at)!
    expect(old & 0xff).not.toBe(0)
    const hex = (w: number) => `$${w.toString(16).padStart(4, '0')}`
    working.append({
      id: 'l1',
      label: 'L1',
      ops: [{ address: hex(at), old: hex(old), new: hex(old & 0xff00), mask: FULL_WORD_MASK }],
    })
    expect(draw()).not.toBe(before)
    working.pop()
    expect(draw()).toBe(before)
  })

  it('flipping the MVN source-bank operand refuses rather than drawing vanilla', () => {
    const rom = freshRom()
    rom.writeAt(0x04dc62, [0x7e])
    expect(decodeOverworldL1(new SmwRom(rom))).toMatchObject({ status: 'unavailable' })
  })
})
