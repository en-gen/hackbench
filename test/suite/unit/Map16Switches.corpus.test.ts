/**
 * #574 on the real ROMs, tileset 0, from #573's research comment: $02B/$02C,
 * $027-$02A and $132 follow the blue P-switch; $12F silver; $112 ON/OFF.
 * $027-$02A are hidden, blank until switched on.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import { loadAnimationData, switchesForChars } from '../../../src/rom/AnimationLoader'
import { decodeMap16Sheet } from '../../../theia/extension/src/node/map16-decode'
import type { Map16SheetDto } from '../../../theia/extension/src/common/map16-protocol'
import { CORPUS, VANILLA, hasRom, romPath } from '../support/corpus'

const GPW2 = CORPUS[2]!
// Tileset 0's $000 cites animated chars no switch touches.
const ANIMATED_UNSWITCHED = 0x000
const hex = (id: number): string => id.toString(16).toUpperCase().padStart(3, '0')

function decode(name: string): Map16SheetDto {
  const result = decodeMap16Sheet(SmwRom.open(romPath(name)), 0, 'fg', { bg: 0, fg: 0 })
  if (result.status !== 'ok') throw new Error(result.reason)
  return result.sheet
}

describe.skipIf(!hasRom(VANILLA))('map16 switches (vanilla corpus, tileset 0)', () => {
  let sheet: Map16SheetDto
  beforeAll(() => {
    sheet = decode(VANILLA)
  })
  const singles = (id: number) =>
    (sheet.tiles[id]!.alternates ?? []).map(a => ({ kinds: a.kinds, hidden: a.hidden }))

  it.each([
    ['02B', 'blue', false],
    ['02C', 'blue', false],
    ['027', 'blue', true],
    ['028', 'blue', true],
    ['029', 'blue', true],
    ['02A', 'blue', true],
    ['132', 'blue', false],
    ['12F', 'silver', false],
    ['112', 'onOff', false],
  ] as const)('$%s follows %s, hidden %s', (hexId, kind, hidden) => {
    const id = parseInt(hexId, 16)
    expect(singles(id)).toEqual([{ kinds: [kind], hidden }])
  })

  it('a tile no switch affects ($025) carries no alternates', () => {
    expect(sheet.tiles[0x025]!.alternates).toBeUndefined()
  })

  it('reads every switch and every button cleanly', () => {
    expect(sheet.switchUnavailable).toBeUndefined()
    expect(sheet.switchButtonUnavailable).toEqual({})
    const art = sheet.switchButtonArt!
    for (const kind of ['blue', 'silver', 'onOff'] as const)
      expect(art[kind]!.offRgba).not.toBe(art[kind]!.onRgba)
    expect(art.blue!.offRgba).not.toBe(art.silver!.offRgba)
  })
})

// A toggle is dropped when its switch leaves the tile's picture unchanged. Measured
// 2026-09-26: on vanilla no tile in any L1 (foreground) or L2 (background) tileset loses
// one, so every switch a vanilla tile's chars follow changes that tile.
describe.skipIf(!hasRom(VANILLA))('map16 switches: toggles dropped as no-ops (vanilla)', () => {
  it('drops none, in every tileset of both layers', () => {
    const rom = SmwRom.open(romPath(VANILLA))
    const lost: string[] = []
    for (const layer of ['fg', 'bg'] as const)
      for (let ts = 0; ts < 15; ts++) {
        const result = decodeMap16Sheet(rom, ts, layer, { bg: 0, fg: 0 })
        const data = loadAnimationData(rom.rom, ts)
        if (result.status !== 'ok' || !data)
          throw new Error(`${layer} tileset ${ts} did not decode`)
        for (const t of result.sheet.tiles) {
          const cited = switchesForChars(
            data,
            [t.tl, t.tr, t.bl, t.br].map(q => q.charNum),
          )
          const shown = (t.alternates ?? []).flatMap(a => (a.kinds.length === 1 ? a.kinds : []))
          for (const k of cited)
            if (!shown.includes(k)) lost.push(`${layer} ${ts} ${t.id.toString(16)} ${k}`)
        }
      }
    expect(lost).toEqual([])
  })
})

// GPW2's level JSL skips CODE_05BB39, so no switch resolves. A tile citing a switched char
// must say so; one citing only animated, unswitched chars must not.
describe.skipIf(!hasRom(GPW2))('map16 switches (GPW2, redirected animation JSL)', () => {
  let sheet: Map16SheetDto
  beforeAll(() => {
    sheet = decode(GPW2)
  })

  it('$02B reports why its switch is unavailable, with the redirect in the reason', () => {
    expect(sheet.switchUnavailable).toContain('not CODE_05BB39')
    expect(sheet.tiles[0x02b]!.alternates).toBeUndefined()
    expect(sheet.tiles[0x02b]!.switchesUnavailable).toContain('not CODE_05BB39')
  })

  it.each([0x025, ANIMATED_UNSWITCHED].map(id => [hex(id), id] as const))(
    '$%s carries no unavailable note',
    (_, id) => {
      expect(sheet.tiles[id]!.switchesUnavailable).toBeUndefined()
    },
  )

  it('has no P-switch button art, and says CallSpriteInit is why', () => {
    expect(sheet.switchButtonArt?.blue).toBeUndefined()
    expect(sheet.switchButtonUnavailable?.blue).toContain('CallSpriteInit')
  })
})
