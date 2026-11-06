/**
 * #1230: the slot the loader gives a sprite, read from the loader's tables (SlotPick.ts). Synthetic loader, no ROM: a
 * span of filler fingerprinted from the cart itself, so CI proves every branch and refusal. The corpus block holds the
 * vanilla loader to the issue's table: setting 1 odd 7 / even 5, settings 2-7 depending on the free slots.
 */
import { describe, expect, it } from 'vitest'
import { LOADER_PICK, slotWalk } from '../../../../src/rom/sprites/interp/SlotPick'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'
import { OTHER_RESERVED2, RESERVED1, ROWS, slotCart, SPECIAL } from '../../support/slotPickCart'

const { rom, spec } = slotCart()
const walk = (setting: number, id: number, along: number) => slotWalk(rom, setting, id, along, spec)

describe('slotWalk (synthetic loader)', () => {
  it('gives the special id the reserved top on an odd coordinate and the ordinary range on an even one', () => {
    expect(walk(1, SPECIAL, 0x10)).toEqual({ status: 'ok', long: 6, short: 6 })
    expect(walk(1, SPECIAL, 0x20)).toEqual({ status: 'ok', long: 4, short: 0 })
  })
  it('reads the parity from the coordinate bit the loader masks, nothing else', () => {
    for (const a of [0x10, 0x30, 0x110, 0x1f0])
      expect(walk(1, SPECIAL, a), `${a}`).toMatchObject({ long: 6 })
    for (const a of [0x00, 0x20, 0x100, 0x2f])
      expect(walk(1, SPECIAL, a), `${a}`).toMatchObject({ long: 4 })
  })
  it('a top slot the ordinary sprites share has a short case: every ordinary slot busy but the last the search reaches', () => {
    expect(walk(2, 0x01, 0)).toEqual({ status: 'ok', long: 6, short: 2 })
  })
  it('follows the first reserved list for its id, whatever the coordinate', () => {
    expect(walk(3, RESERVED1, 0x10)).toEqual({ status: 'ok', long: 2, short: 1 })
    expect(walk(3, RESERVED1, 0x00)).toMatchObject({ long: 2 })
    expect(walk(3, 0x01, 0)).toMatchObject({ long: 3 })
  })
  it('a reserved-2 id that is not the special one takes its reserved range on either coordinate', () => {
    for (const a of [0x00, 0x10])
      expect(walk(2, OTHER_RESERVED2, a)).toEqual({ status: 'ok', long: 5, short: 1 })
  })
  it('a high top slot is reported as it is: the length decision is the ROM draw, not this walk (setting 0 style)', () => {
    expect(walk(0, SPECIAL, 0x10)).toMatchObject({ status: 'ok', long: 10 })
  })
  it('refuses a setting past the tables, a loader that is not the fingerprinted one and a table it cannot read, each with a status', () => {
    expect(walk(4, SPECIAL, 0)).toMatchObject({ status: 'setting' })
    expect(walk(0xff, SPECIAL, 0)).toMatchObject({ status: 'setting' })
    expect(slotWalk(rom, 1, SPECIAL, 0, { ...spec, sha256: 'x' })).toMatchObject({
      status: 'unrecognized',
    })
    const same = slotCart(s => ((s[19] = s[4]), (s[20] = s[5])))
    expect(slotWalk(same.rom, 1, SPECIAL, 0, same.spec)).toMatchObject({ status: 'unrecognized' })
    // The three Max tables must lie the same distance apart: a span whose Max2 is out of step is not read.
    const skew = slotCart(s => ((s[44] = s[19] + 5), (s[45] = s[20])))
    expect(slotWalk(skew.rom, 1, SPECIAL, 0, skew.spec)).toMatchObject({ status: 'unrecognized' })
    // The operands name addresses below $8000, which hold no ROM, so no table can be read.
    const cut = slotCart(sp =>
      [4, 7, 14, 19, 22, 29, 44].forEach((o, i) => ((sp[o] = i * 4), (sp[o + 1] = 0x10))),
    )
    expect(slotWalk(cut.rom, 1, SPECIAL, 0, cut.spec)).toMatchObject({ status: 'unreadable', reason: 'the loader tables could not be read' }) // prettier-ignore
  })
  it('refuses a search that walks into a slot past the twelve, or a range whose far end wraps round', () => {
    for (const [max, start] of [
      [3, 13],
      [5, 5],
      [12, 0xff],
    ] as const) {
      const bad = slotCart(undefined, {
        ...ROWS,
        max: [max, 4, 6, 3],
        start: [start, 0xff, 1, 0xff],
      })
      expect(slotWalk(bad.rom, 0, 1, 0, bad.spec), `max ${max} start ${start}`).toMatchObject({ status: 'unreadable', reason: expect.stringMatching(/outside the sprite table/) }) // prettier-ignore
    }
  })
})

describe.skipIf(!hasRom(VANILLA))('slotWalk (vanilla loader, corpus)', () => {
  const v = () => freshRom()
  const w = (s: number, a: number) => slotWalk(v(), s, 0x64, a)
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

describe('the short slot always exists (case 2: no crash when every ordinary slot is busy)', () => {
  it('sweeps every setting, id kind and parity on the synthetic loader', () => {
    for (let s = 0; s < ROWS.max.length; s++)
      for (const id of [SPECIAL, RESERVED1, 0x01])
        for (const a of [0, 0x10]) {
          const r = walk(s, id, a)
          expect(r.status, `${s}/${id}/${a}`).toBe('ok')
          if (r.status === 'ok') expect(r.short).toBeLessThanOrEqual(r.long)
        }
  })
})
