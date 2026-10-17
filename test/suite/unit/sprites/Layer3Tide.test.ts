/**
 * #845 (folded into #842): the Layer 3 tide sets bit 7 of $5B (Layer 2 interaction) and clears the
 * interaction buffer through the game's own CODE_009FB8 (SMWDisX bank_00.asm:4870) and CODE_00A045
 * (bank_00.asm:4219-4238), which the sprite level loader runs after the level data unless
 * IRQNMICommand ($0D9B) bit 7 is set (bank_00.asm:4861-4864). The synthetic half needs no ROM; the
 * corpus half pins the vanilla map list. The skip itself is in layer3Setup.test.ts; the last
 * synthetic block here pins it against a handler that does real tide work.
 *
 * Evidence scope: vanilla (SHA-1 6b47bb75), all 512 slots, one machine, 2026-10-16.
 */
import { describe, expect, it } from 'vitest'
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'
import { BUFFER_FIRST, BUFFER_LAST, long, putLayer3 } from '../../support/syntheticLayer3'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'

const PTR = 0x05d8c9 // the synthetic pointer loader's LDA #irqCommand (before its STA $0D9B, PLB, RTL)
const wramOf = (a: number) => a & 0x1ffff

/**
 * A synthetic cart whose pointer loader leaves tileset `ts`, Layer3Setting `l3` and a marker in both ends of
 * the buffer, with the table-driven handler and tide helper over the cart's bare stand-in. `irq` is the
 * IRQNMICommand the loader leaves in $0D9B (the 22-byte patch replaces the stand-in's own store, so it
 * stores it again).
 */
function cart(ts: number, l3: number, irq = 0) {
  const rom = buildSyntheticRom()
  rom.writeAt(PTR, [
    ...[0xa9, ts, 0x8d, 0x31, 0x19], // LDA #ts, STA $1931
    ...[0xa9, l3, 0x8d, 0xe3, 0x1b], // LDA #l3, STA $1BE3
    ...[0xa9, 0xff, 0x8f, ...long(BUFFER_FIRST), 0x8f, ...long(BUFFER_LAST)], // marker in both buffer ends
    ...[0xa9, irq, 0x8d, 0x9b, 0x0d, 0xab, 0x6b], // LDA #irq, STA $0D9B, PLB, RTL
  ])
  putLayer3((at, bytes) => rom.writeAt(at, bytes))
  return rom
}

describe('the tide in the level loader (synthetic cart)', () => {
  it.each([
    ['tileset 0, setting 1 (up and down)', 0, 1],
    ['tileset 0, setting 2 (stationary)', 0, 2],
    ['tileset 1, setting 1', 1, 1],
  ])('%s sets $5B bit 7 and zeroes the buffer', (_n, ts, l3) => {
    const l = loadLevelState(cart(ts, l3), 0x105)
    expect(l.ok).toBe(true)
    if (!l.ok) return
    expect(l.wram[0x5b] & 0x80).toBe(0x80)
    expect(l.wram[wramOf(BUFFER_FIRST)]).toBe(0)
    expect(l.wram[wramOf(BUFFER_LAST)]).toBe(0)
  })
  it.each([
    ['no Layer 3', 0, 0],
    ['tileset 0, setting 3 (non-tide background)', 0, 3],
    ['tileset 1, setting 2 (non-tide)', 1, 2],
    ['tileset 1, setting 3 (non-tide)', 1, 3],
  ])('%s leaves $5B and the buffer alone', (_n, ts, l3) => {
    const l = loadLevelState(cart(ts, l3), 0x105)
    expect(l.ok).toBe(true)
    if (!l.ok) return
    expect(l.wram[0x5b]).toBe(0)
    expect(l.wram[wramOf(BUFFER_FIRST)]).toBe(0xff)
    expect(l.wram[wramOf(BUFFER_LAST)]).toBe(0xff)
  })
  it('skips the handler and its buffer clear when IRQNMICommand bit 7 is set, even on a tide', () => {
    // bank_00.asm:4861-4864. Same tide cart as above; only $0D9B differs.
    const skipped = loadLevelState(cart(0, 1, 0x80), 0x105)
    expect(skipped.ok).toBe(true)
    if (!skipped.ok) return
    expect(skipped.wram[0x5b]).toBe(0)
    expect(skipped.wram[wramOf(BUFFER_FIRST)]).toBe(0xff)
    expect(skipped.wram[wramOf(BUFFER_LAST)]).toBe(0xff)
    const ran = loadLevelState(cart(0, 1, 0x7f), 0x105)
    expect(ran.ok && ran.wram[0x5b]).toBe(0x80)
    expect(ran.ok && ran.wram[wramOf(BUFFER_FIRST)]).toBe(0)
  })
})

describe.skipIf(!hasRom(VANILLA))('the tide on vanilla (corpus)', () => {
  it('exactly maps 002, 0BE, 0C1, 102 and 127 set the bit from the tide, over all 512 slots', () => {
    const rom = freshRom(VANILLA)
    const tides: number[] = []
    for (let lv = 0; lv < 512; lv++) {
      const l = loadLevelState(rom, lv)
      expect(l.ok).toBe(true)
      if (!l.ok) continue
      // Layer3TideSetting is stored only on the tide path (bank_00.asm:4153), and a tide has table value 1 or 2.
      if (l.wram[0x1403] !== 0) {
        tides.push(lv)
        expect(l.wram[0x5b] & 0x80).toBe(0x80)
      }
    }
    expect(tides).toEqual([0x002, 0x0be, 0x0c1, 0x102, 0x127])
  }, 120_000)
})
