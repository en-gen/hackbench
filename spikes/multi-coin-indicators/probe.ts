import { writeFileSync } from 'node:fs'
import { png, stats, spriteTools } from '../block-content-indicators/lib.ts'
// Usage: npx tsx spikes/multi-coin-indicators/probe.ts [out.json]  (default: assets.json beside this file)
// Reads the block-content tables, finds the multiple-coin blocks, takes a real map that holds them, and
// composes the three candidate indicators (C1 diagonal stack, C2 coin plus "+", C3 pile) from the coin sprite.
const HERE = new URL('.', import.meta.url)
const R = new URL('../../', HERE).href
const MAP = 0x123
const COLS = [70, 86], ROWS = [13, 23] // window of the map to show (inclusive)
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
const { bytes, sprite16 } = await spriteTools(L, pal, romPath(VANILLA))
const rd = (addr: number, n: number) => Array.from({ length: n }, (_, i) => rom.rom.readByte(addr + i) ?? 0)

// ---- the ROM rule, read from the tables (derivation in README)
// DATA_00F080 (bank_00.asm:12751) byte >> 1 = content. Content 6 = one coin, content 7 = multiple coins
// (bank_02.asm:1062-1067 starts MulticoinTimer; there is no count, the timer decides). Index = low byte - $11
// for page-1 ids $111-$12D (CODE_00F160, bank_00.asm:12827-12846).
const F080 = rd(0x00f080, 36), F100 = rd(0x00f100, 32), F05C = rd(0x00f05c, 36), F0C8 = rd(0x00f0c8, 36)
const idOf = (i: number) => 0x111 + i
const multi: number[] = [], single: number[] = []
for (let i = 0; i < 0x1d; i++) {
  const b = F080[i]!
  if (b & 0x80) continue // $80/$81 take the content from DATA_00F100 by column
  if (b >> 1 === 7) multi.push(idOf(i))
  if (b >> 1 === 6) single.push(idOf(i))
}
// the column-dependent bytes add no coin blocks if DATA_00F100 holds no content 6 or 7
if (F100.some((v) => v >> 1 === 6 || v >> 1 === 7)) throw new Error('DATA_00F100 holds a coin content: the $80/$81 rule needs a second look')
console.log('single-coin ids (content 6):', single.map((i) => '$' + i.toString(16)).join(' '))
console.log('multi-coin ids  (content 7):', multi.map((i) => '$' + i.toString(16)).join(' '))
for (const id of [...multi, ...single]) {
  const i = id - 0x111
  console.log(`  $${id.toString(16)}: F080 $${F080[i]!.toString(16).padStart(2, '0')} F05C (bounce sprite = value+1) $${F05C[i]!.toString(16).padStart(2, '0')} F0C8 (tile it becomes) $${F0C8[i]!.toString(16).padStart(2, '0')}`)
}
if (multi.join() !== '283,291' || single.join() !== '284,292') throw new Error('expected multi $11b,$123 and single $11c,$124 (vanilla table)')
// While the timer runs a multi-coin block regenerates as itself: F0C8 gives generate tiles $0A/$0B and
// TileToGeneratePg1 (bank_00.asm:7425, located by its bytes) maps index (tile - 9) to $1B/$23 on page 1.
const tg = bytes.indexOf(Buffer.from('521B231E32131516', 'hex'))
if (tg < 0 || bytes.indexOf(Buffer.from('521B231E32131516', 'hex'), tg + 1) >= 0) throw new Error('TileToGeneratePg1 not found uniquely')
for (const id of multi) {
  const gen = F0C8[id - 0x111]!, back = 0x100 + bytes[tg + gen - 9]!
  console.log(`  $${id.toString(16)} regenerates as generate-tile $${gen.toString(16)} -> $${back.toString(16)}`)
  if (back !== id) throw new Error('multi-coin block does not regenerate as itself')
}
const cells = (id: number) => { const t = L.map16.tiles[id]!; return [t.tl, t.tr, t.bl, t.br].map((c: any) => `${c.charNum}/${c.palette}`).join(',') }
for (const [a, b] of [[0x11b, 0x11c], [0x123, 0x124]] as const)
  console.log(`cells $${a.toString(16)} = ${cells(a)} | $${b.toString(16)} = ${cells(b)} | identical: ${cells(a) === cells(b)}`)

// ---- the map: real multi-coin and single-coin blocks in the window
type Blk = { x: number; y: number; id: number; kind: 'multi' | 'single'; label: string }
const blocks: Blk[] = [], added: Blk[] = []
L.grid.forEach((row: number[], y: number) => row.forEach((id: number, x: number) => {
  if (x < COLS[0]! || x > COLS[1]! || y < ROWS[0]! || y > ROWS[1]!) return
  const kind = multi.includes(id) ? 'multi' : single.includes(id) ? 'single' : null
  if (kind) blocks.push({ x, y, id, kind, label: `$${id.toString(16)} at column ${x}, row ${y}` })
}))
console.log(`map $${MAP.toString(16)} window: ${blocks.map((b) => `${b.label} (${b.kind})`).join('; ')}`)
if (!blocks.some((b) => b.kind === 'multi') || !blocks.some((b) => b.kind === 'single')) throw new Error('window lacks a multi or single block')
// the question-class pair has no instance in this window: add one each in free air cells of row 20
for (const [id, x, kind] of [[0x123, 82, 'multi'], [0x124, 84, 'single']] as const) {
  if (L.grid[20]![x] !== 0x25) throw new Error(`cell (${x},20) is not free air`)
  added.push({ x, y: 20, id, kind, label: `$${id.toString(16)} at column ${x}, row 20 (added)` })
}

// ---- candidate graphics, composed from the coin sprite (sprite tables, as in block-content-indicators/probe.ts)
type Px = [number, number, number, number]
const NONE: Px = [0, 0, 0, 0]
const coin16 = sprite16(0xe8, 0x04)
const at = (x: number, y: number): Px => { const i = (y * 16 + x) * 4; return [coin16[i]!, coin16[i + 1]!, coin16[i + 2]!, coin16[i + 3]!] }
// opaque bounding box of the coin, so a scaled coin fills its slot
let bx0 = 16, by0 = 16, bx1 = -1, by1 = -1
for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (at(x, y)[3]) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y) }
const coinW = bx1 - bx0 + 1, coinH = by1 - by0 + 1
/** The coin scaled to w x h: each target pixel takes the most common opaque colour of its source box, opaque if half the box is. */
function scaleCoin(w: number, h: number): Px[][] {
  return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x): Px => {
    const sx0 = bx0 + Math.floor((x * coinW) / w), sx1 = bx0 + Math.max(Math.floor(((x + 1) * coinW) / w), Math.floor((x * coinW) / w) + 1)
    const sy0 = by0 + Math.floor((y * coinH) / h), sy1 = by0 + Math.max(Math.floor(((y + 1) * coinH) / h), Math.floor((y * coinH) / h) + 1)
    const votes = new Map<string, { p: Px; n: number }>(); let total = 0, opaque = 0
    for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
      total++; const p = at(sx, sy); if (!p[3]) continue
      opaque++; const k = p.join(); const v = votes.get(k) ?? { p, n: 0 }; v.n++; votes.set(k, v)
    }
    return opaque * 2 >= total ? [...votes.values()].sort((a, b) => b.n - a.n)[0]!.p : NONE
  }))
}
type Canvas = { rgba: Uint8ClampedArray; owner: Uint8Array } // owner: which element painted the pixel last (0 = none)
const blank = (): Canvas => ({ rgba: new Uint8ClampedArray(16 * 16 * 4), owner: new Uint8Array(256) })
function paint(c: Canvas, src: Px[][], ox: number, oy: number, id: number) {
  src.forEach((row, y) => row.forEach((p, x) => {
    if (!p[3]) return
    const px = ox + x, py = oy + y
    if (px < 0 || py < 0 || px > 15 || py > 15) throw new Error('element leaves the 16x16 canvas')
    c.rgba.set(p, (py * 16 + px) * 4); c.owner[py * 16 + px] = id
  }))
}
/** C1: three coins stacked on a diagonal, bottom-left in front. */
function c1(): Canvas {
  const c = blank(), s = scaleCoin(6, 10)
  paint(c, s, 10, 0, 1); paint(c, s, 5, 3, 2); paint(c, s, 0, 6, 3)
  return c
}
/** C2: one coin on the left and a small white "+" with a 1px black edge, top right. */
function c2(): Canvas {
  const c = blank()
  paint(c, scaleCoin(8, 13), 0, 3, 1)
  const W: Px = [255, 255, 255, 255], K: Px = [0, 0, 0, 255]
  const plus = (x: number, y: number) => x >= 0 && x < 6 && y >= 0 && y < 6 && (x === 2 || x === 3 || y === 2 || y === 3)
  const edge = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x): Px => {
    const px = x - 1, py = y - 1
    return !plus(px, py) && [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => plus(px + dx!, py + dy!)) ? K : NONE
  }))
  paint(c, edge, 8, 0, 2)
  paint(c, Array.from({ length: 6 }, (_, y) => Array.from({ length: 6 }, (_, x): Px => (plus(x, y) ? W : NONE))), 9, 1, 3)
  return c
}
/** C3: a small pile, two coins at the base and one on top, overlapping. */
function c3(): Canvas {
  const c = blank(), s = scaleCoin(6, 10)
  paint(c, s, 1, 6, 1); paint(c, s, 9, 6, 2); paint(c, s, 5, 0, 3)
  return c
}
// elements: C1/C3 three coins; C2 owner 1 coin, 2 black edge, 3 white plus
const CANDS: Record<string, { name: string; make: () => Canvas }> = {
  C1: { name: 'three coins stacked diagonally', make: c1 },
  C2: { name: 'one coin plus a small "+"', make: c2 },
  C3: { name: 'a pile of three coins', make: c3 },
}

// ---- number checks: the only check a no-eyes pipeline has (see README)
function check(name: string, c: Canvas, minOwn: number) {
  let opaque = 0, x0 = 16, y0 = 16, x1 = -1, y1 = -1; const cols = new Set<number>(); const own = [0, 0, 0, 0]
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const i = (y * 16 + x) * 4; if (!c.rgba[i + 3]) continue
    opaque++; cols.add((c.rgba[i]! << 16) | (c.rgba[i + 1]! << 8) | c.rgba[i + 2]!)
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); own[c.owner[y * 16 + x]!]!++
  }
  // the rest state draws the whole 16x16 canvas into the bottom-right 8x8 box (CSS), so "inside the quadrant" is: opaque within the canvas
  const inside = opaque > 0 && x0 >= 0 && y0 >= 0 && x1 <= 15 && y1 <= 15
  // every element must keep at least minOwn visible pixels, or the others hide it
  const ok = opaque > 0 && cols.size > 1 && inside && Math.min(own[1]!, own[2]!, own[3]!) >= minOwn
  console.log(`${ok ? 'OK ' : 'BAD'} ${name}: 16x16 opaque=${opaque} colors=${cols.size} bbox=(${x0},${y0})-(${x1},${y1}) visible-per-element=[${own.slice(1)}] inside-quadrant=${inside}`)
  if (!ok) throw new Error('bad candidate ' + name)
  return opaque
}
// the check must be able to fail: a blank canvas and a hidden element are both rejected
{
  const hidden = c1(); for (let i = 0; i < 256; i++) if (hidden.owner[i] === 2) { hidden.rgba[i * 4 + 3] = 0; hidden.owner[i] = 0 }
  for (const [n, c] of [['blank', blank()], ['hidden-element', hidden]] as const) {
    let threw = false; try { check('planted ' + n, c, 8) } catch { threw = true }
    if (!threw) throw new Error('check did not fail on planted defect: ' + n)
  }
  console.log('planted defects (blank canvas, hidden element): both rejected')
}
stats('coin', coin16, 'coin sprite (bank_02.asm:3432) tile $E8, attr $04, as in block-content-indicators/probe.ts')
const img: Record<string, string> = { coin: png(16, 16, coin16) }
const counts: Record<string, number> = {}, gfx: Record<string, Uint8ClampedArray> = {}
for (const [k, c] of Object.entries(CANDS)) {
  const cv = c.make(); counts[k] = check(k, cv, k === 'C2' ? 8 : 12); gfx[k] = cv.rgba; img[k] = png(16, 16, cv.rgba)
}
// the candidates must differ from each other and from the single coin, or two mockup columns would show one design
const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i + 3] !== b[i + 3] || (a[i + 3] && (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]))) n++; return n }
const names = ['coin', ...Object.keys(CANDS)], arr = [coin16, ...Object.keys(CANDS).map((k) => gfx[k]!)]
for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
  const d = diff(arr[i]!, arr[j]!); console.log(`differs ${names[i]} vs ${names[j]}: ${d} pixels`)
  if (d < 20) throw new Error(`${names[i]} and ${names[j]} are nearly identical`)
}

// ---- tiles
const win: number[][] = []
for (let y = ROWS[0]!; y <= ROWS[1]!; y++) win.push(L.grid[y]!.slice(COLS[0], COLS[1]! + 1))
for (const id of new Set<number>([...win.flat(), ...blocks.map((b) => b.id), ...added.map((b) => b.id)])) {
  const t = tile(id); if (multi.includes(id) || single.includes(id)) stats('tile $' + id.toString(16), t, `Map16 $${id.toString(16)}, map $${MAP.toString(16)}`)
  img['t' + id] = png(16, 16, t)
}
const [br, bg, bb] = L.backArea
writeFileSync(process.argv[2] ?? new URL('assets.json', HERE), JSON.stringify({ img, win, x0: COLS[0], y0: ROWS[0], blocks, added, cands: Object.fromEntries(Object.entries(CANDS).map(([k, c]) => [k, c.name])), counts, bg: `rgb(${br},${bg},${bb})`, map: '$' + MAP.toString(16).padStart(3, '0'), mapName: rom.getLevelName(MAP) }))
}
main()
