import { writeFileSync } from 'node:fs'
import { png, stats, spriteTools } from '../block-content-indicators/lib.ts'
// Usage: npx tsx spikes/multi-coin-indicators/probe.ts [out.json]  (default: assets.json beside this file)
// Reads the block-content tables, finds the multiple-coin blocks, takes a real map that holds them, and
// composes the two candidate indicators (C4a, C4b: coin plus a "+" in its box corner) from the coin sprite.
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
const { sprite16 } = await spriteTools(L, pal, romPath(VANILLA))
const rd = (addr: number, n: number) => Array.from({ length: n }, (_, i) => rom.rom.readByte(addr + i) ?? 0)

// ---- the ROM rule, read from the tables (derivation in README)
// DATA_00F080 (bank_00.asm:12751) byte >> 1 = content. Content 6 = one coin, content 7 = multiple coins
// (bank_02.asm:1062-1067 starts MulticoinTimer; there is no count, the timer decides). Index = low byte - $11
// for page-1 ids $111-$12D (CODE_00F160, bank_00.asm:12827-12846).
const F080 = rd(0x00f080, 36), F100 = rd(0x00f100, 32), F05C = rd(0x00f05c, 36), F0C8 = rd(0x00f0c8, 36)
/** Page-1 ids whose DATA_00F080 byte has content `content` (byte >> 1); $80/$81 bytes take their content from DATA_00F100 by column and are skipped. */
function idsWithContent(f080: number[], content: number): number[] {
  const ids: number[] = []
  for (let i = 0; i < 0x1d; i++) if (!(f080[i]! & 0x80) && f080[i]! >> 1 === content) ids.push(0x111 + i)
  return ids
}
// The classifier must be able to fail: synthetic tables (no ROM) with one content byte planted wrong must give EXACT ids.
{
  type Cls = typeof idsWithContent
  const t = Array.from({ length: 36 }, () => 0); t[10] = 0x0e; t[11] = 0x0c
  const bad = [...t]; bad[10] = 0x0c // multi-coin byte misread as single: content 7 gives nothing, content 6 gives both
  const flag = [...t]; flag[10] = 0x8e // a column-dependent byte must not count
  const exact = (c: Cls) => c(t, 7).join() === '283' && c(t, 6).join() === '284' && c(bad, 7).join() === '' && c(bad, 6).join() === '283,284' && c(flag, 7).length === 0
  // a planted wrong-but-changed classifier (content 6 gives only '283' on the misread table) that the old "both lists changed" check accepted
  const wrong: Cls = (f, c) => (f === bad && c === 6 ? [283] : idsWithContent(f, c))
  const oldCheck = (c: Cls) => c(bad, 7).join() !== '283' && c(bad, 6).join() !== '284'
  if (!oldCheck(wrong) || exact(wrong) || !exact(idsWithContent)) throw new Error('F080 classifier self-test failed')
  console.log("F080 classifier self-test (synthetic table): planted wrong-but-changed result '283' for content 6 passed the old check, fails the exact one")
}
const multi = idsWithContent(F080, 7), single = idsWithContent(F080, 6)
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
// TileToGeneratePg1 (bank_00.asm:7425) maps index (tile - 9) to $1B/$23 on page 1. Read by address, no bytes
// in source: the label sits 15 bytes before CODE_00C0C1 (bank_00.asm:7429), so $00C0B2.
const TG1 = 0x00c0b2
for (const id of multi) {
  const gen = F0C8[id - 0x111]!, back = 0x100 + rd(TG1 + gen - 9, 1)[0]!
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
/** The "+" in 16x16 art: 5x5 white cross (arms 1px) with a 1px black edge, so 7x7 in all, as a 7x7 pixel grid. */
const plusPx = (): Px[][] => {
  const W: Px = [255, 255, 255, 255], K: Px = [0, 0, 0, 255]
  const cross = (x: number, y: number) => x >= 0 && x < 5 && y >= 0 && y < 5 && (x === 2 || y === 2)
  return Array.from({ length: 7 }, (_, y) => Array.from({ length: 7 }, (_, x): Px => {
    const px = x - 1, py = y - 1
    if (cross(px, py)) return W
    return [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => cross(px + dx!, py + dy!)) ? K : NONE
  }))
}
/** C4a: the coin unchanged (owner 1) with the "+" (edge 2, white 3) in the bottom-right corner of its 16x16 box; scales with the coin. */
function c4a(): Canvas {
  const c = blank()
  paint(c, Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x): Px => at(x, y))), 0, 0, 1)
  const p = plusPx()
  paint(c, p.map((r) => r.map((q): Px => (q[0] === 0 ? q : NONE))), 9, 9, 2) // black edge
  paint(c, p.map((r) => r.map((q): Px => (q[0] === 255 ? q : NONE))), 9, 9, 3) // white cross
  return c
}
/** C4b: the same coin; the "+" is a separate 7x7 screen-pixel overlay at the corner of the indicator box at every zoom. */
const plus7 = (): Uint8ClampedArray => { const a = new Uint8ClampedArray(7 * 7 * 4); plusPx().forEach((r, y) => r.forEach((q, x) => a.set(q, (y * 7 + x) * 4))); return a }
const CANDS: Record<string, { name: string; make: () => Canvas }> = {
  C4a: { name: 'coin plus "+" in the box corner, scales with the coin (5x5 in 16x16 art)', make: c4a },
  C4b: { name: 'coin plus "+" in the box corner, fixed 5x5 screen pixels at every zoom', make: () => { const c = blank(); paint(c, Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x): Px => at(x, y))), 0, 0, 1); return c } },
}

// ---- number checks: the only check a no-eyes pipeline has (see README)
function check(name: string, c: Canvas, plusWhite: number, plusEdge = 0) {
  let opaque = 0, x0 = 16, y0 = 16, x1 = -1, y1 = -1; const cols = new Set<number>(); const own = [0, 0, 0, 0]
  let px0 = 16, py0 = 16, px1 = -1, py1 = -1
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const i = (y * 16 + x) * 4; if (!c.rgba[i + 3]) continue
    opaque++; cols.add((c.rgba[i]! << 16) | (c.rgba[i + 1]! << 8) | c.rgba[i + 2]!)
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); own[c.owner[y * 16 + x]!]!++
    if (c.owner[y * 16 + x]! >= 2) { px0 = Math.min(px0, x); px1 = Math.max(px1, x); py0 = Math.min(py0, y); py1 = Math.max(py1, y) }
  }
  // the rest state draws the whole 16x16 canvas into the bottom-right 8x8 box (CSS), so "inside the quadrant" is: opaque within the canvas
  const inside = opaque > 0 && x0 >= 0 && y0 >= 0 && x1 <= 15 && y1 <= 15
  // the "+" must be fully visible (white cross not hidden by the coin) and sit in the bottom-right corner of the box
  const corner = plusWhite === 0 || (px1 === 15 && py1 === 15 && px0 >= 8 && py0 >= 8)
  const ok = opaque > 0 && cols.size > 1 && inside && own[1]! >= 100 && corner && (plusWhite === 0 || (own[3]! === plusWhite && own[2]! === plusEdge))
  console.log(`${ok ? 'OK ' : 'BAD'} ${name}: 16x16 opaque=${opaque} colors=${cols.size} bbox=(${x0},${y0})-(${x1},${y1}) coin=${own[1]} edge=${own[2]} white-plus=${own[3]} (want ${plusWhite}) edge (want ${plusEdge}) plus-bbox=(${px0},${py0})-(${px1},${py1}) inside-quadrant=${inside}`)
  if (!ok) throw new Error('bad candidate ' + name)
  return opaque
}
// the check must be able to fail: a blank canvas and a candidate with the "+" hidden are both rejected
{
  const hidden = c4a(); for (let i = 0; i < 256; i++) if (hidden.owner[i]! >= 2) { hidden.rgba[i * 4 + 3] = 0; hidden.owner[i] = 0 }
  const half = c4a(); let n = 0; for (let i = 0; i < 256; i++) if (half.owner[i] === 3 && n++ < 3) { half.rgba[i * 4 + 3] = 0; half.owner[i] = 0 }
  const edge1 = c4a(); for (let i = 0; i < 256; i++) if (edge1.owner[i] === 2) { edge1.rgba[i * 4 + 3] = 0; edge1.owner[i] = 0; break } // one black-edge pixel
  for (const [n, c] of [['blank', blank()], ['plus-hidden', hidden], ['plus-partly-hidden', half], ['one-edge-pixel-hidden', edge1]] as const) {
    let threw = false; try { check('planted ' + n, c, 9, 16) } catch { threw = true }
    if (!threw) throw new Error('check did not fail on planted defect: ' + n)
  }
  console.log('planted defects (blank canvas, "+" hidden, "+" partly hidden, one edge pixel hidden): all rejected')
}
stats('coin', coin16, 'coin sprite (bank_02.asm:3432) tile $E8, attr $04, as in block-content-indicators/probe.ts')
const img: Record<string, string> = { coin: png(16, 16, coin16) }
const counts: Record<string, number> = {}, gfx: Record<string, Uint8ClampedArray> = {}
for (const [k, c] of Object.entries(CANDS)) {
  const cv = c.make(); counts[k] = check(k, cv, k === 'C4a' ? 9 : 0, 16); gfx[k] = cv.rgba; img[k] = png(16, 16, cv.rgba)
}
// C4b's "+" is its own 7x7 graphic: 9 white + 16 edge pixels, nothing else, and it must fit the 8x8 rest quadrant at 1x
{
  const p = plus7(); let white = 0, edge = 0
  for (let i = 0; i < p.length; i += 4) if (p[i + 3]) { if (p[i] === 255) white++; else edge++ }
  console.log(`${white === 9 && edge === 16 ? 'OK ' : 'BAD'} plus7: 7x7 white=${white} edge=${edge}`)
  if (white !== 9 || edge !== 16) throw new Error('bad plus7')
  img.plus7 = png(7, 7, p)
}
// C4a must differ from the plain coin by the "+" only (white 9 + edge 16 = 25 pixels at most)
const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i + 3] !== b[i + 3] || (a[i + 3] && (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]))) n++; return n }
const d4 = diff(coin16, gfx.C4a!); console.log(`differs coin vs C4a: ${d4} pixels`)
if (d4 < 15 || d4 > 25) throw new Error('C4a is not the coin plus the plus mark')
if (diff(coin16, gfx.C4b!) !== 0) throw new Error('C4b base is not the unchanged coin')
// The coin must sit exactly where the D4 single coin does: 0 differing pixels outside the "+" footprint (7x7 at 9,9).
const coinDiff = (g: Uint8ClampedArray) => { let n = 0; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { if (x >= 9 && y >= 9) continue; const i = (y * 16 + x) * 4; for (let k = 0; k < 4; k++) if (g[i + k] !== coin16[i + k]) { n++; break } } return n }
{
  const shifted = new Uint8ClampedArray(coin16.length) // the coin moved 1px right, as a planted defect
  for (let y = 0; y < 16; y++) for (let x = 0; x < 15; x++) shifted.set(coin16.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4), (y * 16 + x + 1) * 4)
  if (coinDiff(shifted) === 0) throw new Error('coin-position check did not fail on a 1px offset')
  console.log(`planted 1px coin offset: ${coinDiff(shifted)} differing pixels outside the footprint, rejected`)
}
for (const k of ['C4a', 'C4b']) { const n = coinDiff(gfx[k]!); console.log(`${n === 0 ? 'OK ' : 'BAD'} ${k}: coin pixels differing from the D4 single coin outside the "+" footprint: ${n}`); if (n) throw new Error(k + ' coin moved') }

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
