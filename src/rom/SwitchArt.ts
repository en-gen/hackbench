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

/** The vote more than half of `votes` share (undefined is a vote for nothing), or why none does. */
export function majority<T>(
  votes: readonly (T | undefined)[],
  key: (v: T) => string,
): { pick: T; count: number } | { reason: string } {
  const tally = new Map<string, { pick: T; count: number }>()
  for (const v of votes) {
    if (v === undefined) continue
    const k = key(v)
    const t = tally.get(k) ?? { pick: v, count: 0 }
    t.count++
    tally.set(k, t)
  }
  const best = [...tally.values()].sort((a, b) => b.count - a.count)[0]
  if (best && best.count * 2 > votes.length) return best
  return { reason: `no picture is shared by more than half of the ${votes.length} tilesets` }
}

const cites = (d: Map16Tile) => [d.tl, d.tr, d.bl, d.br].map(q => q.palette)

export function palaceArt(rom: RomFile): Record<Palace, PalaceArt> {
  const unavailable = (reason: string) =>
    Object.fromEntries(PALACES.map(p => [p, { reason }])) as Record<Palace, PalaceArt>
  const col1 = readLevelCol1(rom)
  if ('reason' in col1) return unavailable(`Palette column 1 is unavailable: ${col1.reason}`)
  // Variant 0 colors rows 0-3 only; a block citing those rows is refused below.
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
    let why: string | undefined
    const votes = perTileset.map(ts => {
      const ids = ts && switchBlockTile(rom, ts.t, p)
      if (ids && 'reason' in ids) why ??= ids.reason
      if (!ts || !ids || 'reason' in ids) return undefined
      const defs = [ts.tiles[ids.uncleared], ts.tiles[ids.cleared]]
      if (defs.some(d => !d)) return undefined
      return defs.map(d => ({ def: d!, rgba: renderCell(d!, ts.vram, palette) }))
    })
    const won = majority(votes, v => v.map(x => Buffer.from(x.rgba).toString('base64')).join())
    if ('reason' in won) out[p] = { reason: `The ${p} block cannot be drawn: ${why ?? won.reason}` }
    else if (won.pick.some(x => cites(x.def).some(row => row < 4)))
      out[p] = { reason: `The ${p} block's colors depend on a level's palette variant` }
    else out[p] = { uncleared: won.pick[0]!.rgba, cleared: won.pick[1]!.rgba }
  }
  return out
}
