import { writeFileSync } from 'node:fs'
import { png, stats, spriteTools } from '../block-content-indicators/lib.ts'
// Usage: npx tsx spikes/progressive-powerup-indicators/probe.ts [out.json]  (default: assets.json beside this file)
// Finds the progressive-powerup blocks of map $003 from its level data and renders them with their two items.
const HERE = new URL('.', import.meta.url)
const R = new URL('../../', HERE).href
const MAP = 0x003
const ROWS = [17, 26] // window of the map to show (inclusive), around the blocks
async function main() {
const { SmwRom } = await import(R + 'src/rom/SmwRom.ts')
const { buildL1Inputs } = await import(R + 'src/rom/model/L1Model.ts')
const { renderMap16Tile } = await import(R + 'src/rom/TileRenderer.ts')
const { romPath, VANILLA } = await import(R + 'test/suite/support/corpus.ts')
const rom = SmwRom.open(romPath(VANILLA))
const r = buildL1Inputs(rom, MAP, { yellow: false, green: false, red: false, blue: false })
if (!r.ok) throw new Error(r.reason)
const L = r.inputs
const pal = { colors: L.colors }
const tile = (id: number) => renderMap16Tile(L.map16.tiles[id]!, L.vram, pal)
const { sprite16, attrOf, powerTile } = await spriteTools(L, pal, romPath(VANILLA))
const rd = (addr: number, n: number) => Array.from({ length: n }, (_, i) => rom.rom.readByte(addr + i) ?? 0)

// ---- the ROM rule, read from the tables (derivation in README)
// DATA_00F080 (bank_00.asm:12751) is indexed by acts-like low byte - $11 (CODE_00F160, bank_00.asm:12829).
// Byte >> 1 = content index into SpriteInBlock (bank_02.asm:1078); bit 0 = "progressive": with Mario
// small (Powerup = 0) the content becomes 1 (mushroom) (CODE_00F1BA, bank_00.asm:12877-12885).
// Bit 7 set = content comes from DATA_00F100 by block column (bank_00.asm:12868-12876).
const F080 = rd(0x00f080, 36), F100 = rd(0x00f100, 32), SPR_IN_BLOCK = rd(0x0288a3, 17)
const SPRITE_KEY: Record<number, string> = { 0x74: 'mushroom', 0x75: 'flower', 0x77: 'feather', 0x78: 'oneup', 0x76: 'star' }
const itemKey = (n: number) => (n === 6 ? 'coin' : SPRITE_KEY[SPR_IN_BLOCK[n]!] ?? null)
const ITEM_LABEL: Record<string, string> = { mushroom: 'Mushroom', flower: 'Fire Flower', feather: 'Feather', oneup: '1-Up', coin: 'Coin', star: 'Star' }
type Content = { prog: boolean; other: string | null; item: number; note?: string }
function decode(v: number): Content {
  const item = v >> 1, carry = v & 1
  // item 3 with the bit is the star block that pays a coin while Mario has a star: state variance, out of scope
  if (carry && item === 3) return { prog: false, other: 'star', item, note: 'star (coin if Mario has a star)' }
  return { prog: !!carry, other: itemKey(item), item }
}
/**
 * Table index the game uses for Map16 tile `id` (only page-1 tiles, $100-$1FF, reach the block-hit code:
 * bank_01.asm:2617-2623 skips a zero high byte). CODE_00F160 (bank_00.asm:12827-12846) takes index
 * low - $11 only below $1D ($111-$12D); above that only low $59/$5A reach indices $22/$23 ($159, $15A),
 * and only in a tileset whose DATA_00A625 entry has no bits 0-1. Indices $1D-$21 are never reached.
 */
const A625 = rd(0x00a625, 16)
function tableIndex(id: number): number | null {
  if (id < 0x111 || id > 0x1ff) return null
  const low = id & 0xff
  if (low - 0x11 < 0x1d) return low - 0x11
  if ((A625[L.header.objectTileset]! & 3) === 0 && (low === 0x59 || low === 0x5a)) return 0x22 + low - 0x59
  return null
}
/** Content of the block with Map16 id `id` in column `col` (the column picks the content for $80/$81 bytes). */
function contentOf(id: number, col: number): Content | null {
  const idx = tableIndex(id)
  if (idx === null) return null
  const b = F080[idx]!
  if (b === 0xff) return null // green star block: multi-coin, out of scope
  if (b & 0x80) return decode(F100[((b & 1) << 4) | (col & 15)]!) // X = bit0:(xlow >> 4), bank_00.asm:12869-12876
  return decode(b)
}
const REACHABLE = [...Array(0x100).keys()].map((i) => 0x100 + i).filter((id) => tableIndex(id) !== null)
for (const id of REACHABLE) {
  const b = F080[tableIndex(id)!]!
  const cs = (b & 0x80 ? [...Array(16).keys()] : [0]).map((c) => contentOf(id, c)).filter((c): c is Content => !!c)
  const desc = cs.length ? [...new Set(cs.map((c) => `${c.prog ? 'PROG ' : ''}${c.note ?? c.other ?? '#' + c.item}`))].join(' / ') : '-'
  console.log(`tile $${id.toString(16)} F080 byte $${b.toString(16).padStart(2, '0')} -> ${desc}`)
}

// ---- the map: its progressive blocks, found from the expanded level data
const blocks: { x: number; y: number; id: number; small: string; other: string; label: string }[] = []
L.grid.forEach((row: number[], y: number) => row.forEach((id: number, x: number) => {
  const c = contentOf(id, x)
  if (c?.prog && c.other) blocks.push({ x, y, id, small: 'mushroom', other: c.other, label: `$${id.toString(16)} at column ${x}, row ${y}` })
}))
console.log(`map $${MAP.toString(16)}: ${blocks.length} progressive blocks:`, blocks.map((b) => `${b.label} (${b.other})`).join('; '))
if (blocks.length === 0) throw new Error('no progressive blocks found: the probe is broken')
if (itemKey(1) !== 'mushroom') throw new Error('content 1 is not the mushroom: SpriteInBlock was misread')

// plain comparison blocks, drawn in free air cells of row 20 (not in the map): a 1-Up, a coin and a star,
// each with a block id whose content at that column is that item and not progressive
const plain: { x: number; y: number; id: number; key: string; label: string }[] = []
for (const [key, x] of [['oneup', 1], ['coin', 2], ['star', 14]] as const) {
  const fits = REACHABLE.filter((i) => { const c = contentOf(i, x); return c && !c.prog && !c.note && c.other === key })
  const id = fits.find((i) => !(F080[tableIndex(i)!]! & 0x80)) ?? fits[0] // prefer a block whose content does not depend on the column
  if (!id) throw new Error('no plain block for ' + key)
  plain.push({ x, y: 20, id, key, label: `$${id.toString(16)} at column ${x} (plain)` })
}

// ---- two-outcome blocks (#623): item depends on game state but Mario does not progress through a mushroom
// $11A at X column 0 of a screen (F080 $81 -> F100[16], star) and $122 (F080 $07): a star while Mario
// is invincible, else a coin (CODE_00F1C9, bank_00.asm:12887-12891). $12D (F080 $ff, green star block): 1-Up once
// the counter reaches zero, else coin (bank_00.asm:12861-12866). Set beside D4 coin $11C, $11F, C4a $11B.
const two = [0x11c, 0x11f, 0x11b, 0x11a, 0x122, 0x12d]
const star11a = contentOf(0x11a, 0), star122 = contentOf(0x122, 0)
if (star11a?.other !== 'star' || !star11a.note || star122?.other !== 'star' || !star122.note) throw new Error('$11A col 0 / $122 are not the conditional star')
if (F080[tableIndex(0x12d)!] !== 0xff) throw new Error('$12D is not the F080 $ff green star block')
if (F080[tableIndex(0x11b)!]! >> 1 !== 7 || itemKey(F080[tableIndex(0x11c)!]! >> 1) !== 'coin') throw new Error('$11B/$11C are not multi-coin/coin')

// ---- graphics
const img: Record<string, string> = {}
const [x0, x1] = [0, L.grid[0]!.length - 1]
const win: number[][] = []
for (let y = ROWS[0]!; y <= ROWS[1]!; y++) win.push(L.grid[y]!.slice(x0, x1 + 1))
for (const id of new Set<number>([...win.flat(), ...blocks.map((b) => b.id), ...plain.map((p) => p.id), ...two])) {
  const t = tile(id); if (id !== 0x25) stats('tile $' + id.toString(16), t, `Map16 $${id.toString(16)}, map $${MAP.toString(16)}`)
  img['t' + id] = png(16, 16, t)
}
const itemSrc = (key: string) => {
  if (key === 'coin') return sprite16(0xe8, 0x04)
  const id = { mushroom: 0x74, flower: 0x75, star: 0x76, feather: 0x77, oneup: 0x78 }[key]!
  return sprite16(powerTile(id), attrOf(id))
}
const keys = new Set<string>(['mushroom', 'flower', 'coin', 'star', 'oneup', ...blocks.map((b) => b.other), ...plain.map((p) => p.key)])
for (const k of keys) { const s = itemSrc(k); stats(k, s, 'sprite tables, as in block-content-indicators/probe.ts'); img[k] = png(16, 16, s) }
const [br, bg, bb] = L.backArea
writeFileSync(process.argv[2] ?? new URL('assets.json', HERE), JSON.stringify({ img, win, y0: ROWS[0], blocks, plain, two, labels: ITEM_LABEL, bg: `rgb(${br},${bg},${bb})`, map: '$' + MAP.toString(16).padStart(3, '0') }))
console.log('plain comparison blocks:', plain.map((p) => p.label).join('; '))
}
main()
