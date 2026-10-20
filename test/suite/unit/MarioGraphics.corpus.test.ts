/**
 * MarioGraphics (#980) against the hardware: the VRAM samples of the `layers_v5` captures hold what Mario's tile DMA
 * uploaded from the $7E:2000 buffer (SMWDisX bank_00.asm:4583-4605). Where a sample has its WRAM, the pointers it
 * used are known, so the chars at those slots must equal the buffer there. No sample has the Podoboo's pointers in
 * its WRAM, so for its pieces the witness is the chars themselves: a 128-byte match at slot 3 of both rows.
 * Vanilla ROM, 164 capture archives, one machine.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { unzip } from '../../../tools/scripts/capture_render'
import { decode4bpp } from '../../../src/rom/GraphicsDecoder'
import type { RomFile } from '../../../src/rom/RomFile'
import {
  charsFromUploads,
  MARIO_GFX_BASE,
  readMarioGraphics,
  STOCK_CALLS,
  STOCK_DMA,
  STOCK_NMI,
  type MarioBuffer,
} from '../../../src/rom/MarioGraphics'
import { parseLevelSprites } from '../../../src/rom/LevelParser'
import { SmwRom } from '../../../src/rom/SmwRom'
import { levelSeed } from '../../../src/rom/sprites/interp/LevelLoader'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { getPaletteColor } from '../../../src/rom/PaletteLoader'
import {
  interpDrawer,
  mapSprites,
  readStream,
  runWithUploads,
  type DrawPart,
} from '../../../theia/extension/src/node/map-sprites'
import { CAPTURE_DIR, freshRom, hasCaptures, hasRom, romPath, VANILLA } from '../support/corpus'
import { slow } from '../support/loadTimeout'

const NO_FLAGS = { yellow: false, green: false, red: false, blue: false }
const PTR = 0x0d85 // DynGfxTilePtr (rammap.asm:1321), row 2 at +$0A; PlayerGfxTileCount is the byte before it
/** The chars the Podoboo's own run points slot 3 of both rows at on map $11C, decoded from the buffer (what the map view draws). */
const podobooChars = (rom: RomFile) => {
  const m = runWithUploads(rom, 0x33, levelSeed(rom, 0x11c)) as ReturnType<typeof runWithUploads> & { uploads?: { slot: number; ptr: number }[][] } // prettier-ignore
  const up = m.chosen === undefined ? undefined : m.uploads?.[m.chosen]
  if (!up?.length) throw new Error('the Podoboo run pointed no slot at the buffer')
  const d = charsFromUploads(readMarioGraphics(rom), up)
  if (!d.ok) throw new Error(d.reason)
  return d.chars
}
const ZERO_TILE = '0'.repeat(64)
const CHARS = [0x406, 0x407, 0x416, 0x417]
/** Slot `i` (0-4 row 1, 5-9 row 2) of a VRAM sample: 64 bytes at word $6000 / $6100 + 32 per slot. */
const slot = (vram: Uint8Array, i: number) => {
  const word = (i < 5 ? 0x6000 : 0x6100) + 32 * (i % 5)
  return vram.subarray(word * 2, word * 2 + 64)
}

describe.skipIf(!hasCaptures() || !hasRom(VANILLA))(
  'Mario graphics buffer vs hardware VRAM (#980)',
  () => {
    // Loaded when the suite runs, not when it is collected: a skipped suite's body still executes.
    let rom: RomFile
    let built: MarioBuffer
    let buffer = new Uint8Array()
    let tiles: string[] = []
    let index = new Map<string, number>()
    const tally = {
      pose: [0, 0],
      podoboo: [0, 0],
      seen: new Set<number>(),
      vrams: 0,
      maps: new Set<string>(),
    }

    // The buffer and the sweep are built once here, so no verdict below can run on a tally another case was to fill.
    beforeAll(() => {
      rom = freshRom()
      built = readMarioGraphics(rom)
      buffer = built.ok ? built.bytes : buffer
      tiles = Array.from({ length: 384 }, (_, t) => Buffer.from(buffer.subarray(0x5d00 + t * 32, 0x5d00 + t * 32 + 32)).toString('hex')) // prettier-ignore
      index = new Map(tiles.map((h, t) => [h, t] as const))
      expect(built).toMatchObject({ ok: true })
      const captures = readdirSync(CAPTURE_DIR).filter(f => f.endsWith('.zip')).sort() // prettier-ignore
      expect(captures.length, 'capture archives listed').toBeGreaterThan(0)
      const chars = podobooChars(rom)
      for (const f of captures) {
        const files = unzip(readFileSync(join(CAPTURE_DIR, f)))
        for (const name of files.keys()) {
          if (!/vram\.bin$/.test(name) || /l3_vram/.test(name)) continue
          const vram = files.get(name)!()
          tally.vrams++
          for (let o = 0; o + 32 <= vram.length; o += 32) {
            const t = index.get(vram.subarray(o, o + 32).toString('hex'))
            if (t !== undefined && tiles[t] !== ZERO_TILE) tally.seen.add(t)
          }
          const hw = [slot(vram, 3), slot(vram, 8)].flatMap(c => [c.subarray(0, 32), c.subarray(32)]).map(c => decode4bpp(c)) // prettier-ignore
          const same = CHARS.map((c, i) => Buffer.compare(hw[i]!, chars.get(c)!) === 0)
          if (same[0]) tally.podoboo[1]!++ // the first char: the other three must then agree
          if (same.every(Boolean)) tally.podoboo[0]!++
          if (same[0]) tally.maps.add(name.split('/')[0]!)
          const w = files.get(name.replace('vram', 'wram'))?.()
          if (!w) continue
          for (let i = 0; i < 10; i++) {
            const p = w[PTR + 2 * i]! | (w[PTR + 2 * i + 1]! << 8)
            // The poses of GFX32 ($2000-$7CFF); a slot the pose does not use points at zero.
            if (i % 5 >= w[PTR - 1]! / 2 || p < MARIO_GFX_BASE || p + 0x40 > 0x7d00) continue
            tally.pose[1]!++
            if (Buffer.compare(slot(vram, i), buffer.subarray(p - MARIO_GFX_BASE, p - MARIO_GFX_BASE + 0x40)) === 0) tally.pose[0]!++ // prettier-ignore
          }
        }
      }
    }, 600_000)

    it("equals the chars hardware holds at Mario's own pose pointers (GFX32), but for samples taken between a pose change and its upload", () => {
      expect(tally.pose[1]).toBeGreaterThan(3000)
      expect(tally.pose[0] / tally.pose[1]).toBeGreaterThan(0.95)
    })

    it('equals the four chars hardware holds at slot 3 of both rows wherever the first one is the Podoboo, in 8 maps', () => {
      expect(tally.podoboo[1]).toBeGreaterThan(200)
      expect(tally.podoboo[0]).toBe(tally.podoboo[1])
      expect(tally.maps.size).toBeGreaterThanOrEqual(8)
    })

    it('expands GFX33 into tiles that occur verbatim in the hardware VRAM, plane 2 included', () => {
      expect(tally.vrams).toBeGreaterThan(5000)
      const plane2 = [...tally.seen].filter(t => [...Array(8)].some((_, r) => tiles[t]!.slice(32 + r * 4, 34 + r * 4) !== '00')) // prettier-ignore
      expect(tally.seen.size).toBeGreaterThan(250)
      expect(plane2.length).toBeGreaterThan(240)
    })
  },
)

/** The sprite's palette indices (`w` x `h`) with `parts` laid out as drawSprites does (last part wins), the chars being hardware's (`chars`, by hackbench char number). */
const lay = (parts: readonly DrawPart[], chars: Map<number, Uint8Array>) => {
  const [x0, y0] = [Math.min(...parts.map(p => p.dx)), Math.min(...parts.map(p => p.dy))]
  const [w, h] = [
    Math.max(...parts.map(p => p.dx)) + 8 - x0,
    Math.max(...parts.map(p => p.dy)) + 8 - y0,
  ]
  const [out, pal] = [new Array<number>(w * h).fill(0), new Array<number>(w * h).fill(0)]
  for (const p of parts)
    for (let ty = 0; ty < 8; ty++)
      for (let tx = 0; tx < 8; tx++) {
        const v = chars.get(p.charNum)![(p.flipY ? 7 - ty : ty) * 8 + (p.flipX ? 7 - tx : tx)]!
        if (!v) continue
        out[(p.dy - y0 + ty) * w + p.dx - x0 + tx] = v
        pal[(p.dy - y0 + ty) * w + p.dx - x0 + tx] = p.palette
      }
  return { w, h, out, pal }
}

describe.skipIf(!hasCaptures() || !hasRom(VANILLA))(
  'Podoboo pixels, every vanilla map that has one (#980)',
  () => {
    it(
      'equal the hardware chars laid out by the part offsets, pixel for pixel, in each Podoboo of each map',
      slow(900_000),
      () => {
        const rom = freshRom()
        const bytes = new Uint8Array(rom.buffer)
        // The layout is the Podoboo's own drawn parts on $11C (one picture on every map); the chars in it are hardware's, per map.
        const built11c = new L1ModelCache().get(bytes, romPath(VANILLA), 0x11c, NO_FLAGS)
        if (!built11c.ok) throw new Error(built11c.reason)
        const listed = parseLevelSprites(readStream(rom, new SmwRom(rom).getLevelSpritePointer(0x11c)!)!, built11c.inputs.isVertical).find(s => s.spriteId === 0x33)! // prettier-ignore
        const res = interpDrawer(rom, 0x11c, built11c.inputs, runWithUploads, () =>
          levelSeed(rom, 0x11c),
        )(listed)
        if (!res.ok) throw new Error('the $11C Podoboo drew nothing')
        const parts = res.parts
        const first = podobooChars(rom).get(0x406)!
        const runChars = podobooChars(rom)
        const tally = { maps: 0, pods: 0, viaRun: 0 }
        for (let index = 0; index < 0x200; index++) {
          const f = `${index.toString(16).padStart(3, '0')}.zip`
          const zip = join(CAPTURE_DIR, f)
          const files = existsSync(zip) ? unzip(readFileSync(zip)) : new Map<string, () => Buffer>()
          let hw: Map<number, Uint8Array> | undefined
          for (const name of [...files.keys()]
            .filter(k => /vram\.bin$/.test(k) && !/l3_vram/.test(k))
            .sort()) {
            const v = files.get(name)!()
            if (Buffer.compare(decode4bpp(slot(v, 3)), first) !== 0) continue
            const d = [slot(v, 3), slot(v, 8)].flatMap(c => [c.subarray(0, 32), c.subarray(32)]).map(c => decode4bpp(c)) // prettier-ignore
            hw = new Map(CHARS.map((c, i) => [c, d[i]!]))
            break
          }
          const ptr = new SmwRom(rom).getLevelSpritePointer(index)
          const data = ptr === null ? null : readStream(rom, ptr)
          if (!data || !parseLevelSprites(data, false).some(s => s.spriteId === 0x33) && !parseLevelSprites(data, true).some(s => s.spriteId === 0x33)) continue // prettier-ignore
          // No sample caught the Podoboo's frame on this map: the chars its own run points at, which the maps above prove equal hardware's.
          const witnessed = !!hw
          hw ??= new Map(CHARS.map(c => [c, runChars.get(c)!]))
          const cache = new L1ModelCache()
          const built = cache.get(bytes, romPath(VANILLA), index, NO_FLAGS)
          if (!built.ok) continue
          const r = mapSprites(cache, bytes, romPath(VANILLA), index)
          if (r.status !== 'ok') continue // a slot with no level of its own
          const pods = r.sprites.filter(s => s.id === 0x33 && s.status === 'drawn')
          if (!pods.length) continue
          const want = lay(parts, hw)
          tally.maps++
          if (!witnessed) tally.viaRun++
          for (const p of pods) {
            tally.pods++
            const rgba = Buffer.from(p.rgba, 'base64')
            const where = `${index.toString(16)} index ${p.index}`
            expect([p.box.x1 - p.box.x0, p.box.y1 - p.box.y0], where).toEqual([want.w, want.h])
            // Opaque exactly where hardware's index is nonzero, in the map's own palette color for that index: a char
            // swapped for its twin (same shape, other colors) differs here, and a shape check alone would not see it.
            want.out.forEach((idx, i) => {
              expect(rgba[i * 4 + 3] !== 0, `${where} pixel ${i} opaque`).toBe(idx !== 0)
              if (idx) expect([...rgba.subarray(i * 4, i * 4 + 4)], `${where} pixel ${i} index ${idx}`).toEqual(getPaletteColor(built.inputs, want.pal[i]!, idx)) // prettier-ignore
            })
          }
        }
        expect(tally.maps).toBe(12)
        expect(tally.maps - tally.viaRun, 'maps checked against hardware VRAM').toBe(8)
        expect(tally.pods).toBe(72)
      },
    )
  },
)

describe.skipIf(!hasRom(VANILLA))(
  'the pinned MarioGFXDMA and NMI records, vanilla ROM (#980)',
  () => {
    const read = (at: number, n: number) => freshRom().readAtFileOffset(at, n)!
    it('STOCK_DMA starts at the entry every stock caller targets, REP #$20, and ends on SEP #$20 RTS', () => {
      expect([...read(STOCK_DMA.at, 2)]).toEqual([0xc2, 0x20])
      expect([...read(STOCK_DMA.at + STOCK_DMA.length - 3, 3)]).toEqual([0xe2, 0x20, 0x60])
      for (const c of STOCK_CALLS.filter(s => s.to === 'dma')) {
        const jsr = freshRom().readAt(c.from, 3)!
        expect((jsr[1]! | (jsr[2]! << 8)) - 0x8000).toBe(STOCK_DMA.at)
      }
    })
    it('the NMI vector reaches the pinned handler, which holds the three MarioGFXDMA calls', () => {
      const v = freshRom().readAt(STOCK_NMI.vector, 2)!
      expect((v[0]! | (v[1]! << 8)) - 0x8000).toBe(STOCK_NMI.routine.at)
      expect(readMarioGraphics(freshRom()).ok).toBe(true)
    })
  },
)
