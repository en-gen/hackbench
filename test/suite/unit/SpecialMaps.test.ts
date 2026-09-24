/**
 * findSpecialMaps across the six-cart corpus.
 *
 * The synthetic suite in SpecialMaps.synthetic.test.ts is the one that runs
 * in CI, where the corpus is absent by design. This file is the measurement
 * that backs the claims in the SpecialMaps header comment, and it exists
 * because the two roles degrade differently on edited carts: the new-game
 * loader survives every hack in the corpus, the title-screen loader does not.
 *
 * Gated with `describe.skipIf` rather than by generating cases from the
 * corpus listing. A `for (const rom of romFiles)` at file scope over an
 * empty array registers nothing at all, which reports green with a skip
 * count of zero - the cases do not skip, they cease to exist.
 *
 * Measured 2026-09-21 on this repo's six carts, one machine.
 */
import { describe, it, expect } from 'vitest'
import { findSpecialMaps } from '../../../src/rom/SpecialMaps'
import { MAGIC, freshRom, romsOnDisk } from '../support/corpus'

const romFiles = romsOnDisk()

/** The one cart in the corpus that carries a copier header. */
const HEADERED = MAGIC

const open = freshRom

describe.skipIf(romFiles.length === 0)('findSpecialMaps (corpus)', () => {
  it('reads the new-game slot as $0C5 at $00:9CB0 on every cart', () => {
    const perRom = romFiles.map(file => ({
      file,
      hit: findSpecialMaps(open(file)).maps.find(m => m.role === 'new-game'),
    }))

    expect(perRom.map(r => `${r.file}: ${r.hit?.index.toString(16)} @ ${r.hit?.foundAt}`)).toEqual(
      romFiles.map(file => `${file}: c5 @ $00:9CB0`),
    )
  })

  it('reads the title-screen slot as $0C7 at $00:96CB wherever its loader survives', () => {
    const found = romFiles
      .map(file => findSpecialMaps(open(file)).maps.find(m => m.role === 'title-screen'))
      .filter((m): m is NonNullable<typeof m> => m !== undefined)

    expect(found.map(m => `${m.index.toString(16)} @ ${m.foundAt}`)).toEqual(
      found.map(() => 'c7 @ $00:96CB'),
    )
  })

  it('declines the title screen on the two carts whose loader is replaced, with a note each', () => {
    const declined = romFiles.filter(file => {
      const found = findSpecialMaps(open(file))
      return (
        !found.maps.some(m => m.role === 'title-screen') &&
        found.notes.some(n => n.startsWith('Title screen:'))
      )
    })

    // Grand Poo World 2 and Invictus. Named by count rather than by filename
    // so the assertion still means something if the corpus is re-cut, but
    // pinned so a scanner that silently starts matching cannot pass.
    expect(declined).toHaveLength(2)
  })

  it('reads the headered cart to the same slots and citations as the unheadered vanilla', () => {
    const headered = romFiles.find(f => f === HEADERED)
    if (!headered) return expect.unreachable(`${HEADERED} missing from the corpus`)

    const rom = open(headered)
    expect(rom.hasHeader).toBe(true)

    // Cart-relative offsets, so the citation does not shift by $200.
    expect(findSpecialMaps(rom).maps).toEqual([
      { index: 0x0c7, role: 'title-screen', foundAt: '$00:96CB' },
      { index: 0x0c5, role: 'new-game', foundAt: '$00:9CB0' },
    ])
  })
})
