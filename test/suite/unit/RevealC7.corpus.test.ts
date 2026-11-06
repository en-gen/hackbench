/**
 * Every invisible mushroom ($C7) on the vanilla ROM is found hidden and drawn (#1132 acceptance 1), on all 12 maps that
 * place one. The map list is written out, not read from the corpus, so a ROM that lost one still fails the case
 * for it instead of registering fewer cases (docs/testing.md, "Gate with skipIf, never by discovery"). One machine,
 * one vanilla ROM; skipped without it.
 */
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { revealRows } from '../../../tools/scripts/spriteReportRun'
import { hasRom, romPath, VANILLA } from '../support/corpus'

/** The maps with a $C7 in their sprite list: counted from the vanilla sprite pointer table. */
const C7_MAPS = [
  0x15, 0x16, 0x17, 0x22, 0xd0, 0xd1, 0xf5, 0xf6, 0x105, 0x11a, 0x1c4, 0x1c5,
] as const

describe.skipIf(!hasRom(VANILLA))('the invisible mushroom on the vanilla ROM', () => {
  const rom = () => readFileSync(romPath(VANILLA))
  it.each(C7_MAPS)(
    'map $%s: every $C7 is blank at rest, hidden, revealed, and not a marker',
    map => {
      const c7 = revealRows(rom(), romPath(VANILLA), map).filter(r => r.id === 0xc7)
      expect(c7.length, `$C7 sprites on map $${map.toString(16)}`).toBeGreaterThan(0)
      for (const r of c7) {
        expect(r, `map $${map.toString(16)} #${r.index}`).toMatchObject({
          rest: 'blank',
          hidden: true,
        })
        expect(r.condition, 'a condition, not none-found').toBeTruthy()
        expect(r.condition).not.toBe('none-found')
        expect(r.marker).toBeUndefined()
      }
    },
  )

  it('control: the same audit sees a placed mushroom ($74) as visible on map $00E, the picture $C7 gets', () => {
    const placed = revealRows(rom(), romPath(VANILLA), 0xe).filter(r => r.id === 0x74)
    expect(placed.length).toBeGreaterThan(0)
    for (const r of placed) expect(r).toMatchObject({ rest: 'drew', hidden: false })
  })
})
