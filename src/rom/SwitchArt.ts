/**
 * Each switch palace's block as the ROM draws it in a normal map, per ROM,
 * not per map: a switch-palace map's own tileset (4 on vanilla) redefines
 * the cleared blocks as the palace's letters. Every tileset is asked which
 * tiles its own dispatch draws for the block (`switchBlockTile`) and renders
 * them from its own Map16 and GFX; the picture more than half the tilesets
 * agree on is the block. No clear majority is unavailable, never tileset 0.
 */
import type { RomFile } from './RomFile'
import { loadMap16WithPipeVariants, TILESET_COUNT, type Map16Tile } from './Map16'
import { loadVram } from './GfxLoader'
import { buildLevelCgram, loadRomPalettes } from './PaletteLoader'
import { readLevelCol1 } from './PaletteStockTables'
import { PALACES, switchBlockTile, type Palace } from './SwitchBlockTiles'
import { renderCell } from './render/CellRenderer'

export type PalaceArt = { uncleared: Uint8ClampedArray; cleared: Uint8ClampedArray } | { reason: string } // prettier-ignore

/** The most shared vote and its count; `pick` only when more than half of `votes` (absent ones included) share it. */
export function majority<T>(
  votes: readonly (T | undefined)[],
  key: (v: T) => string,
): { pick?: T; count: number } {
  const tally = new Map<string, { pick: T; count: number }>()
  for (const v of votes) {
    if (v === undefined) continue
    const t = tally.get(key(v)) ?? { pick: v, count: 0 }
    t.count++
    tally.set(key(v), t)
  }
  const best = [...tally.values()].sort((a, b) => b.count - a.count)[0]
  if (best && best.count * 2 > votes.length) return best
  return { count: best?.count ?? 0 }
}

type Vote = { def: Map16Tile; rgba: Uint8ClampedArray }[]

const cites = (d: Map16Tile) => [d.tl, d.tr, d.bl, d.br].map(q => q.palette)

/** One palace's art from each tileset's [uncleared, cleared] vote; `absentWhy` when no tileset could vote. */
export function choosePalaceArt(
  palace: Palace,
  votes: readonly (Vote | undefined)[],
  absentWhy?: string,
): PalaceArt {
  const why = (reason: string) => ({ reason: `The ${palace} block cannot be drawn: ${reason}` })
  if (votes.every(v => v === undefined)) return why(absentWhy ?? 'no tileset draws it')
  const won = majority(votes, v => v.map(x => Buffer.from(x.rgba).toString('base64')).join())
  if (!won.pick) return why(`${won.count} of ${votes.length} tilesets agree; no majority`)
  // Palette variant 0 colors rows 0-3 only; a block citing those is not the ROM's own art.
  if (won.pick.some(x => cites(x.def).some(row => row < 4)))
    return why("its colors depend on a level's palette variant")
  return { uncleared: won.pick[0]!.rgba, cleared: won.pick[1]!.rgba }
}

export function palaceArt(rom: RomFile): Record<Palace, PalaceArt> {
  const unavailable = (reason: string) =>
    Object.fromEntries(PALACES.map(p => [p, { reason }])) as Record<Palace, PalaceArt>
  const col1 = readLevelCol1(rom)
  if ('reason' in col1) return unavailable(`Palette column 1 is unavailable: ${col1.reason}`)
  const palette = buildLevelCgram(loadRomPalettes(rom), 0, 0, 0, col1)
  const perTileset = Array.from({ length: TILESET_COUNT }, (_, t) => {
    try {
      return { t, tiles: loadMap16WithPipeVariants(rom, t).tiles, vram: loadVram(rom, t) }
    } catch {
      return undefined
    }
  })
  const out = {} as Record<Palace, PalaceArt>
  for (const p of PALACES) {
    let absentWhy: string | undefined
    const votes = perTileset.map(ts => {
      const ids = ts && switchBlockTile(rom, ts.t, p)
      if (ids && 'reason' in ids) absentWhy ??= ids.reason
      if (!ts || !ids || 'reason' in ids) return undefined
      const defs = [ts.tiles[ids.uncleared], ts.tiles[ids.cleared]]
      if (defs.some(d => !d)) return undefined
      return defs.map(d => ({ def: d!, rgba: renderCell(d!, ts.vram, palette) }))
    })
    out[p] = choosePalaceArt(p, votes, absentWhy)
  }
  return out
}
