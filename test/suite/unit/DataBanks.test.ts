/**
 * Locating the layer 1 object code bank by following the loader's long jump
 * (#755), on synthetic carts only: every refusal has a control that differs
 * by one byte and succeeds.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { dataBanksOf, locateObjectCodeBank } from '../../../src/rom/DataBanks'
import {
  ENTRY,
  RTL,
  STOCK_PINS,
  hi,
  lo,
  loaderBytes,
  productionCart,
} from '../support/syntheticCart'

type Opts = NonNullable<Parameters<typeof productionCart>[1]>
const withPins = (o: Opts = {}): RomFile => productionCart([RTL], o)
const jsl = (bank: number, low = ENTRY): number[] => loaderBytes([lo(low), hi(low), bank])

describe('locateObjectCodeBank', () => {
  it('reads $0D from vanilla-shaped bytes', () => {
    expect(locateObjectCodeBank(withPins())).toEqual({ bank: 0x0d })
  })

  it.each([0x8d, 0x2d, 0x0e, 0xff, 0x00])('records the JSL operand bank %i', bank => {
    expect(locateObjectCodeBank(withPins({ loader: jsl(bank) }))).toEqual({ bank })
  })

  it('records not found, with the site named, for each broken check', () => {
    const cases: [string, Opts, RegExp][] = [
      ['branch', { branch: [0xa5, 0x5a, 0xd0, 0x07] }, /branch .* is not LDA \$5A, BNE \+6/],
      ['call', { call: [0x22, 0xea, 0x86] }, /call at .* is not JSR/],
      ['SEP', { loader: [0xc2, ...STOCK_PINS.loader.slice(1)] }, /is not SEP, JSL, RTS/],
      [
        'JSL',
        { loader: [0xe2, 0x30, 0x5c, ...STOCK_PINS.loader.slice(3)] },
        /is not SEP, JSL, RTS/,
      ],
      ['RTS', { loader: [...STOCK_PINS.loader.slice(0, 6), 0x6b] }, /is not SEP, JSL, RTS/],
      ['offset low', { loader: jsl(0x0d, ENTRY ^ 1) }, /not offset \$A40F/],
      ['offset high', { loader: jsl(0x0d, ENTRY ^ 0x100) }, /not offset \$A40F/],
    ]
    for (const [name, o, why] of cases) {
      const r = locateObjectCodeBank(withPins(o))
      expect(r, name).toHaveProperty('notFound')
      expect((r as { notFound: string }).notFound, name).toMatch(why)
    }
  })

  it('records not found on a bare cart and on one too short to hold the loader', () => {
    expect(locateObjectCodeBank(withPins({ pins: false }))).toHaveProperty('notFound')
    expect(locateObjectCodeBank(RomFile.fromBytes('tiny', new Uint8Array(0x100)))).toHaveProperty(
      'notFound',
    )
  })
})

describe('dataBanksOf', () => {
  it('detects from the ROM own bytes when no banks were attached, once per instance', () => {
    const rom = withPins({ loader: jsl(0x8d) })
    const a = dataBanksOf(rom)
    expect(a.objectCode).toEqual({ bank: 0x8d })
    expect(dataBanksOf(rom)).toBe(a)
  })

  it('prefers the banks attached to the RomFile over its bytes', () => {
    const rom = RomFile.fromBytes('x', withPins().buffer, { objectCode: { bank: 0x2d } })
    expect(dataBanksOf(rom).objectCode).toEqual({ bank: 0x2d })
  })
})
