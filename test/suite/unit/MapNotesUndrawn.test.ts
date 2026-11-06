/** The map's note sums spawned children that did not draw across spawners (#1281): real $DE / $E0 drawers, then the sum itself. */
import { describe, expect, it } from 'vitest'
import { bytesAt } from '../../../src/rom/sprites/interp/Guards'
import { undrawnNote } from '../../../src/rom/sprites/interp/SpawnedChildren'
import { runOnce } from '../../../src/rom/sprites/interp/SpriteRunner'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'
import { interpDrawer, mapNotes, spriteLayer } from '../../../theia/extension/src/node/map-sprites'
import { buildSyntheticRom } from '../support/syntheticSpriteRom'
import { COLORS } from '../support/mapInputs'
import { EERIE_HANDLER, eeriesSeed, SYNTHETIC_EERIES_ROUTINES } from '../support/syntheticEeries'
import { platformCart, SYNTHETIC_PLATFORM_ROUTINES } from '../support/syntheticPlatforms'

/** Every VRAM slot holds a solid tile 128 times, so any char a cart draws has art (a missing one would make a marker). */
const sheet = Array.from({ length: 128 }, () => new Uint8Array(64).fill(1))
const model = { isVertical: false, screenCount: 16, vram: Object.fromEntries(['fg1', 'fg2', 'fg3', 'an1', 'sp1', 'sp2', 'sp3', 'sp4'].map(k => [k, sheet])), colors: COLORS } as never // prettier-ignore
/** Two entries at the same spot, so the same child is lost at each. */
const twice = (id: number, data: number) =>
  Uint8Array.from([0, data, 0x43, id, data, 0x43, id, 0xff])
const eeries = (room?: number, also = 0x68) => {
  const rom = buildSyntheticRom({ eeries: { room } })
  // The cart's Eerie handler returns before drawing for the one at X low byte $68 (the far one): one Eerie spawned, not drawn.
  rom.writeAt(EERIE_HANDLER, [0xb5, 0xe4, 0xc9, 0x68, 0xd0, 0x01, 0x60, 0xb5, 0xe4, 0xc9, also, 0xd0, 0x01, 0x60, ...bytesAt(rom, EERIE_HANDLER, 60)]) // prettier-ignore
  return spriteLayer(twice(0xde, 0x71), model, interpDrawer(rom, 0x21, model, runOnce, () => eeriesSeed(100), undefined, SYNTHETIC_EERIES_ROUTINES as never)) // prettier-ignore
}
const platforms = (room?: number) =>
  spriteLayer(twice(0xe0, 0x51), model, interpDrawer(platformCart({ room, skipDraw: 0x22 | 0x80 }), 0x21, model, runOnce, () => eeriesSeed(100), undefined, undefined, SYNTHETIC_PLATFORM_ROUTINES as never)) // prettier-ignore
const dto = (noun: 'Eerie' | 'platform', count: number, why: string, extra = ''): MapSpriteDto => ({ note: `${extra}${undrawnNote({ noun, count, why })}`, undrawn: { noun, count, why } }) as MapSpriteDto // prettier-ignore

describe('map note counts of undrawn children', () => {
  it('two $DE spawners that each lose one Eerie say 2', () => {
    expect(eeries().note).toMatch(/^2 Eeries did not draw: drew no OAM tile/)
  })
  it('room for 3 and two Eeries not drawn per spawner: the count is spawned minus drawn, 4 over two', () => {
    expect(eeries(3, 0x54).note).toMatch(/ 4 Eeries did not draw: /)
  })
  it('two $E0 spawners that each lose one platform say 2', () => {
    expect(platforms().note).toMatch(/^2 platforms did not draw: drew no OAM tile/)
  })
  it('a shortfall sentence stays once, beside the summed undrawn count', () => {
    expect(platforms(2).note).toMatch(/^Only 2 of the 3 platforms appear: [^.]*\. 2 platforms did not draw: drew no OAM tile/) // prettier-ignore
  })
  it('different numbers undrawn sum to the total; a single one reads singular', () => {
    expect(mapNotes([dto('Eerie', 1, 'r'), dto('Eerie', 2, 'r')])).toEqual(['3 Eeries did not draw: r']) // prettier-ignore
    expect(mapNotes([dto('Eerie', 1, 'r')])).toEqual(['1 Eerie did not draw: r'])
  })
  it('different reasons on one noun give one total, reasons joined; nouns stay apart', () => {
    expect(mapNotes([dto('platform', 1, 'a'), dto('Eerie', 1, 'x'), dto('platform', 1, 'b')])).toEqual(['2 platforms did not draw: a; b', '1 Eerie did not draw: x']) // prettier-ignore
  })
  it('a shortfall note beside undrawn keeps its own sentence and the same countless sentence shows once', () => {
    const lost = dto('Eerie', 1, 'r', 'Only 4 of the 5 Eeries appear. ')
    expect(mapNotes([lost, lost, { note: 'Same.' } as MapSpriteDto, { note: 'Same.' } as MapSpriteDto])).toEqual(['Only 4 of the 5 Eeries appear.', 'Same.', '2 Eeries did not draw: r']) // prettier-ignore
  })
})
