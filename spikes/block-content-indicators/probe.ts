import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
// Usage: npx tsx spikes/block-content-indicators/probe.ts [out.json]  (default: assets.json beside this file)
const HERE = new URL('.', import.meta.url)
const R = new URL('../../', HERE).href
async function main() {
const { SmwRom } = await import(R + 'src/rom/SmwRom.ts')
const { buildL1Inputs } = await import(R + 'src/rom/model/L1Model.ts')
const { renderMap16Tile } = await import(R + 'src/rom/TileRenderer.ts')
const { getCharPixels } = await import(R + 'src/rom/GfxLoader.ts')
const { getPaletteColor } = await import(R + 'src/rom/PaletteLoader.ts')
const { romPath, VANILLA } = await import(R + 'test/suite/support/corpus.ts')

const rom = SmwRom.open(romPath(VANILLA))
const r = buildL1Inputs(rom, 0x105, { yellow: false, green: false, red: false, blue: false })
if (!r.ok) throw new Error(r.reason)
const L = r.inputs
const pal = { colors: L.colors }

// ---- PNG
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (t: string, d: Buffer) => { const o = Buffer.alloc(12 + d.length); o.writeUInt32BE(d.length, 0); o.write(t, 4, 'latin1'); d.copy(o, 8); o.writeUInt32BE(crc(o.subarray(4, 8 + d.length)), 8 + d.length); return o }
function png(w: number, h: number, rgba: Uint8ClampedArray | Uint8Array): string {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1) }
  const b = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  return 'data:image/png;base64,' + b.toString('base64')
}
function stats(name: string, rgba: Uint8ClampedArray, src: string) {
  let opaque = 0; const cols = new Set<number>()
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3]! > 0) { opaque++; cols.add((rgba[i]! << 16) | (rgba[i + 1]! << 8) | rgba[i + 2]!) }
  const ok = opaque > 0 && cols.size > 1
  console.log(`${ok ? 'OK ' : 'BAD'} ${name}: 16x16 opaque=${opaque} colors=${cols.size} | ${src}`)
  if (!ok) throw new Error('bad graphic ' + name)
}
const tile = (id: number) => renderMap16Tile(L.map16.tiles[id]!, L.vram, pal)

// ---- sprite tables from the ROM (SMWDisX labels), located by byte pattern
const bytes = readFileSync(romPath(VANILLA))
const pat = Buffer.from('0A0806040A080604 0A0A08080417 3204'.replace(/ /g, ''), 'hex')
const at = bytes.indexOf(pat)
if (at < 0 || bytes.indexOf(pat, at + 1) >= 0) throw new Error('Sprite166EVals not unique')
const attrOf = (id: number) => bytes[at + id]! & 0x0f // LoadSpriteTables: 166E low nibble -> SpriteOBJAttribute
// PowerUpTiles (bank_01.asm:9528) located the same way
const tp = bytes.indexOf(Buffer.from('242648 0E24000000 00E4E824EC'.replace(/ /g, ''), 'hex'))
if (tp < 0) throw new Error('PowerUpTiles not found')
const powerTile = (id: number) => bytes[tp + id - 0x74]!

function sprite16(tileNo: number, attr: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(16 * 16 * 4)
  const row = 8 + ((attr >> 1) & 7), page = attr & 1
  for (const [dx, dy, n] of [[0, 0, tileNo], [8, 0, tileNo + 1], [0, 8, tileNo + 16], [8, 8, tileNo + 17]] as const) {
    const px = getCharPixels(L.vram, 0x400 + page * 0x100 + n)
    if (!px) throw new Error(`char ${(0x400 + page * 0x100 + n).toString(16)} not loaded (tile ${tileNo.toString(16)})`)
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const v = px[y * 8 + x]!; if (!v) continue
      out.set(getPaletteColor(pal, row, v), ((dy + y) * 16 + dx + x) * 4)
    }
  }
  return out
}

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
