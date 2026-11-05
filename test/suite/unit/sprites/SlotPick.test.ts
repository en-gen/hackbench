/**
 * #1230: the slot the loader gives a sprite, read from the loader's tables (SlotPick.ts). Synthetic loader, no ROM: a
 * span of filler fingerprinted from the cart itself, so CI proves every branch and refusal. The corpus block holds the
 * vanilla loader to the issue's table: setting 1 odd 7 / even 5, settings 2-7 depending on the free slots.
 */
import { describe, expect, it } from 'vitest'
import { LOADER_PICK, slotWalk } from '../../../../src/rom/sprites/interp/SlotPick'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'
import { RESERVED1, ROWS, slotCart, SPECIAL } from '../../support/slotPickCart'

const { rom, spec } = slotCart()
const walk = (setting: number, id: number, along: number) => slotWalk(rom, setting, id, along, spec)

describe('slotWalk (synthetic loader)', () => {
  it('gives the special id the reserved top on an odd coordinate and the ordinary range on an even one', () => {
    expect(walk(1, SPECIAL, 0x10)).toEqual({ status: 'ok', long: 7, short: 7 })
    expect(walk(1, SPECIAL, 0x20)).toEqual({ status: 'ok', long: 5, short: 0 })
  })
  it('reads the parity from the coordinate bit the loader masks, nothing else', () => {
    for (const a of [0x10, 0x30, 0x110, 0x1f0]) expect(walk(1, SPECIAL, a), `${a}`).toMatchObject({ long: 7 })
    for (const a of [0x00, 0x20, 0x100, 0x2f]) expect(walk(1, SPECIAL, a), `${a}`).toMatchObject({ long: 5 })
  })
  it('a slot the ordinary sprites share has a short case: every ordinary slot busy but the last the search reaches', () => {
    expect(walk(2, 0x01, 0)).toEqual({ status: 'ok', long: 7, short: 1 })
  })
  it('follows the first reserved list for its id, whatever the coordinate', () => {
    expect(walk(3, RESERVED1, 0x10)).toMatchObject({ long: 3 })
    expect(walk(3, RESERVED1, 0x00)).toMatchObject({ long: 3 })
    expect(walk(3, 0x01, 0)).toMatchObject({ long: 4 })
  })
  it('a high top slot is reported as it is: the length decision is the ROM draw, not this walk (setting 0 style)', () => {
    expect(walk(0, SPECIAL, 0x10)).toMatchObject({ status: 'ok', long: 9 })
  })
  it('refuses a setting past the tables, a loader that is not the fingerprinted one and unreadable bytes, each with a status', () => {
    expect(walk(4, SPECIAL, 0)).toMatchObject({ status: 'setting' })
    expect(walk(0xff, SPECIAL, 0)).toMatchObject({ status: 'setting' })
    expect(slotWalk(rom, 1, SPECIAL, 0, { ...spec, sha256: 'x' })).toMatchObject({ status: 'unrecognized' })
    const bad = slotCart(s => ((s[19] = s[4]), (s[20] = s[5])))
    expect(slotWalk(bad.rom, 1, SPECIAL, 0, bad.spec)).toMatchObject({ status: 'unrecognized' })
    const big = slotCart(s => { s[4] = 0; s[5] = 0 }) // prettier-ignore
    expect(slotWalk(big.rom, 1, SPECIAL, 0, big.spec).status).not.toBe('ok')
  })
  it('a top slot past the twelve sprite slots is refused', () => {
    const high = slotCart(undefined, { ...ROWS, max: [12, 5, 7, 4] })
    expect(slotWalk(high.rom, 0, 1, 0, high.spec)).toMatchObject({ status: 'unreadable' })
  })
})

describe.skipIf(!hasRom(VANILLA))('slotWalk (vanilla loader, corpus)', () => {
  const v = freshRom()
  const w = (s: number, a: number) => slotWalk(v, s, 0x64, a)
  it('is the fingerprinted loader', () => expect(LOADER_PICK.length).toBe(62))
  it('setting 1: odd coordinate slot 7 (fixed); even slot 5, or 0 when the ordinary slots are busy (both short)', () => {
    expect(w(1, 0x10)).toEqual({ status: 'ok', long: 7, short: 7 })
    expect(w(1, 0x00)).toEqual({ status: 'ok', long: 5, short: 0 })
  })
  it('settings 2-7: the top slot is shared with ordinary sprites, so there is a lower short slot', () => {
    for (const s of [2, 3, 4, 5, 6, 7]) {
      const r = w(s, 0x10)
      expect(r.status, `${s}`).toBe('ok')
      if (r.status === 'ok') expect(r.short, `${s}`).toBeLessThan(r.long)
    }
  })
  it('refuses setting 19 and above', () => {
    expect(w(19, 0)).toMatchObject({ status: 'setting' })
    expect(w(63, 0)).toMatchObject({ status: 'setting' })
  })
})
