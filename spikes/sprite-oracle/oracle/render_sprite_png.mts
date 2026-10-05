/**
 * Renders what the PPU drew for each sprite slot, from a fixture's dumps, as
 * a PNG strip (one cell per recorded frame, left to right):
 *   tsx render_sprite_png.mts <fixture dir>...   -> <dir>/png/slot<S>_id<ID>.png
 * Inputs: oam.bin (544 B/frame), vram.bin (16 KB/frame: OBJ table 1 then 2),
 * cgram_rows8_15.bin (256 B/frame), frames.json (per-entry owner = the call
 * that wrote it, last writer in that frame; the PPU shows the buffer of the
 * frame before, so frame f+1's OAM is drawn against frame f's owners).
 * Nothing here is graded; it is for people. Colour 0 of each row is transparent.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
function collect(root: string): string[] {
  if (existsSync(join(root, 'calls.json'))) return [root]
  return readdirSync(root).map(n => join(root, n)).filter(p => statSync(p).isDirectory() && existsSync(join(p, 'calls.json'))).sort()
}

function crc32(buf: Uint8Array): number {
  let c, crc = ~0
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return ~crc >>> 0
}
function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1) }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function renderDir(dir: string): number {
  const calls = JSON.parse(readFileSync(join(dir, 'calls.json'), 'utf8')) as { i: number; slot: number; id: number; frame: number }[]
  const frames = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8')) as { owners: number[]; ppu: Record<string, number> }[]
  const oam = readFileSync(join(dir, 'oam.bin')), vram = readFileSync(join(dir, 'vram.bin')), cg = readFileSync(join(dir, 'cgram_rows8_15.bin'))
  const bySlot = new Map<string, number[]>()
  for (const c of calls) bySlot.set(`${c.slot}:${c.id}`, [...(bySlot.get(`${c.slot}:${c.id}`) ?? []), c.i])
  mkdirSync(join(dir, 'png'), { recursive: true })
  let written = 0
  const nF = frames.length - 1                      // the last frame only supplies PPU OAM
  for (const [key, ids] of bySlot) {
    const own = new Set(ids), [slot, id] = key.split(':').map(Number)
    const CELL = 64, W = CELL * Math.max(1, nF), H = CELL
    const img = new Uint8Array(W * H * 4)
    for (let f = 0; f < nF; f++) {
      const o = oam.subarray((f + 1) * 544, (f + 2) * 544), v = vram.subarray((f + 1) * 0x4000, (f + 2) * 0x4000), pal = cg.subarray((f + 1) * 256, (f + 2) * 256)
      const large = 16 // OBSEL size mode 0 (SMW, ppu.oamMode = 0): 8x8 small / 16x16 large
      const owned = frames[f].owners.map((c, idx) => (own.has(c) ? idx : -1)).filter(x => x >= 0)
      const ents = owned.map(idx => {
        const hi = o[512 + (idx >> 2)] >> ((idx & 3) * 2)
        let x = o[idx * 4] | ((hi & 1) << 8); if (x >= 256) x -= 512
        return { x, y: o[idx * 4 + 1], tile: o[idx * 4 + 2] | ((o[idx * 4 + 3] & 1) << 8), attr: o[idx * 4 + 3], size: (hi >> 1) & 1 ? large : 8 }
      })
      if (ents.length === 0) continue
      const x0 = Math.min(...ents.map(e => e.x)), y0 = Math.min(...ents.map(e => e.y))
      for (const e of ents) {
        for (let py = 0; py < e.size; py++) for (let px = 0; px < e.size; px++) {
          const sx = e.attr & 0x40 ? e.size - 1 - px : px, sy = e.attr & 0x80 ? e.size - 1 - py : py
          const ch = (e.tile + (sy >> 3) * 16 + (sx >> 3)) & 0x1ff
          const base = ch * 32   // table 2 follows table 1 at +$2000 = char 256
          const r = sy & 7, b = 7 - (sx & 7)
          const col = ((v[base + r * 2] >> b) & 1) | (((v[base + r * 2 + 1] >> b) & 1) << 1) | (((v[base + 16 + r * 2] >> b) & 1) << 2) | (((v[base + 17 + r * 2] >> b) & 1) << 3)
          if (col === 0) continue
          const row = (e.attr >> 1) & 7, bgr = pal[(row * 16 + col) * 2] | (pal[(row * 16 + col) * 2 + 1] << 8)
          const X = f * CELL + 4 + (e.x - x0) + px, Y = 4 + (e.y - y0) + py
          if (X < f * CELL || X >= (f + 1) * CELL || Y < 0 || Y >= H) continue
          const p = (Y * W + X) * 4
          img[p] = ((bgr & 31) * 255) / 31; img[p + 1] = (((bgr >> 5) & 31) * 255) / 31; img[p + 2] = (((bgr >> 10) & 31) * 255) / 31; img[p + 3] = 255
        }
      }
    }
    writeFileSync(join(dir, 'png', `slot${slot}_id${id.toString(16).padStart(2, '0')}.png`), png(W, H, img))
    written++
  }
  return written
}

const dirs = process.argv.slice(2).flatMap(a => collect(resolve(a)))
let n = 0
for (const d of dirs) if (existsSync(join(d, 'oam.bin'))) n += renderDir(d)
console.log(`wrote ${n} PNG strip(s) for ${dirs.length} fixture dir(s)`)
