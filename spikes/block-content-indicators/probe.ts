import { writeFileSync } from 'node:fs'
import { png, stats, spriteTools } from './lib.ts'
// Usage: npx tsx spikes/block-content-indicators/probe.ts [out.json]  (default: assets.json beside this file)
const HERE = new URL('.', import.meta.url)
const R = new URL('../../', HERE).href
async function main() {
const { SmwRom } = await import(R + 'src/rom/SmwRom.ts')
const { buildL1Inputs } = await import(R + 'src/rom/model/L1Model.ts')
const { renderMap16Tile } = await import(R + 'src/rom/TileRenderer.ts')
const { romPath, VANILLA } = await import(R + 'test/suite/support/corpus.ts')

const rom = SmwRom.open(romPath(VANILLA))
const r = buildL1Inputs(rom, 0x105, { yellow: false, green: false, red: false, blue: false })
if (!r.ok) throw new Error(r.reason)
const L = r.inputs
const pal = { colors: L.colors }

const tile = (id: number) => renderMap16Tile(L.map16.tiles[id]!, L.vram, pal)

const { attrOf, powerTile, sprite16 } = await spriteTools(L, pal, romPath(VANILLA))

const items: { key: string; label: string; src: string; rgba: Uint8ClampedArray }[] = []
for (const [key, label, id] of [['mushroom', 'mushroom', 0x74], ['flower', 'fire flower', 0x75], ['feather', 'feather', 0x77], ['star', 'star', 0x76], ['oneup', '1-up', 0x78]] as const) {
  const t = powerTile(id), a = attrOf(id)
  items.push({ key, label, src: `sprite $${id.toString(16)} PowerUpTiles tile $${t.toString(16)}, OBJ attr $${a.toString(16)} = CGRAM row ${8 + ((a >> 1) & 7)}, page ${a & 1}`, rgba: sprite16(t, a) })
}
{ const a = attrOf(0x79); items.push({ key: 'vine', label: 'vine', src: `sprite $79 GrowingVine tile $AC (frame A), OBJ attr $${a.toString(16)} = row ${8 + ((a >> 1) & 7)}`, rgba: sprite16(0xac, a) }) }
items.push({ key: 'coin', label: 'coin', src: 'coin sprite (bank_02.asm:3432) tile $E8, attr $04 = row 10, page 0', rgba: sprite16(0xe8, 0x04) })
items.sort((a, b) => ['mushroom', 'flower', 'feather', 'star', 'oneup', 'vine', 'coin'].indexOf(a.key) - ['mushroom', 'flower', 'feather', 'star', 'oneup', 'vine', 'coin'].indexOf(b.key))
const tiles: Record<string, { rgba: Uint8ClampedArray; src: string }> = {
  q: { rgba: tile(0x11f), src: 'Map16 $11F, level $105 (objectTileset 7, sprite set 8)' },
  turn: { rgba: tile(0x117), src: 'Map16 $117' },
  grass: { rgba: tile(0x100), src: 'Map16 $100 (ground top)' },
  dirt: { rgba: tile(0x03f), src: 'Map16 $03F (ground fill)' },
}
for (const [k, v] of Object.entries(tiles)) stats(k, v.rgba, v.src)
for (const it of items) stats(it.key, it.rgba, it.src)
console.log('back area color', L.backArea)

const img: Record<string, string> = {}
for (const [k, v] of Object.entries(tiles)) img[k] = png(16, 16, v.rgba)
for (const it of items) img[it.key] = png(16, 16, it.rgba)
const [br, bg, bb] = L.backArea
const ITEMS = items.map(i => ({ key: i.key, label: i.label }))
writeFileSync(process.argv[2] ?? new URL('assets.json', HERE), JSON.stringify({ img, ITEMS, bg: `rgb(${br},${bg},${bb})` }))
}
main()
