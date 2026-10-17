/**
 * MarioGraphics (#980) against the hardware: the VRAM samples of the `layers_v5` captures hold what Mario's tile DMA
 * uploaded from the $7E:2000 buffer (SMWDisX bank_00.asm:4583-4605). Where a sample has its WRAM, the pointers it
 * used are known, so the chars at those slots must equal the buffer there. No sample has the Podoboo's pointers in
 * its WRAM, so for its pieces the witness is the chars themselves: a 128-byte match at slot 3 of both rows.
 * Vanilla ROM, 164 capture archives, one machine.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unzip } from '../../../tools/scripts/capture_render'
import { decode4bpp } from '../../../src/rom/GraphicsDecoder'
import type { RomFile } from '../../../src/rom/RomFile'
import {
  charsFromUploads,
  MARIO_GFX_BASE,
  readMarioGraphics,
  type MarioBuffer,
} from '../../../src/rom/MarioGraphics'
import { levelSeed } from '../../../src/rom/sprites/interp/LevelLoader'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { mapSprites, runWithUploads } from '../../../theia/extension/src/node/map-sprites'
import { CAPTURE_DIR, freshRom, hasCaptures, hasRom, romPath, VANILLA } from '../support/corpus'
import { slow } from '../support/loadTimeout'

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

    it('reads the buffer from the cart', () => {
      rom = freshRom()
      built = readMarioGraphics(rom)
      buffer = built.ok ? built.bytes : buffer
      tiles = Array.from({ length: 384 }, (_, t) => Buffer.from(buffer.subarray(0x5d00 + t * 32, 0x5d00 + t * 32 + 32)).toString('hex')) // prettier-ignore
      index = new Map(tiles.map((h, t) => [h, t] as const))
      expect(built).toMatchObject({ ok: true })
    })

    it('sweeps every capture sample', slow(600_000), () => {
      const chars = podobooChars(rom)
      for (const f of readdirSync(CAPTURE_DIR).sort()) {
        if (!f.endsWith('.zip')) continue
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
    })

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

describe.skipIf(!hasCaptures() || !hasRom(VANILLA))('Podoboo pixels on map $11C (#980)', () => {
  it(
    'draws as many pixels as the hardware chars hold, not what the level-start SP1 chars would',
    slow(120_000),
    () => {
      const r = mapSprites(new L1ModelCache(), new Uint8Array(readFileSync(romPath(VANILLA))), romPath(VANILLA), 0x11c) // prettier-ignore
      if (r.status !== 'ok') throw new Error(r.status)
      const pods = r.sprites.filter(s => s.id === 0x33 && s.status === 'drawn')
      expect(pods.length).toBeGreaterThan(0)
      // Hardware: the nonzero pixels of the four chars in the first $11C VRAM sample whose slot 3 holds the Podoboo's first char.
      const chars = podobooChars(freshRom())
      const files = unzip(readFileSync(join(CAPTURE_DIR, '11c.zip')))
      let hw = -1
      for (const name of [...files.keys()]
        .filter(k => /vram\.bin$/.test(k) && !/l3_vram/.test(k))
        .sort()) {
        const v = files.get(name)!()
        if (Buffer.compare(decode4bpp(slot(v, 3)), chars.get(0x406)!) !== 0) continue
        // Per pixel, per char: all four decoded chars equal the hardware's before any count is taken.
        const hwChars = [slot(v, 3), slot(v, 8)].flatMap(c => [c.subarray(0, 32), c.subarray(32)]).map(c => decode4bpp(c)) // prettier-ignore
        CHARS.forEach((c, i) => expect([...chars.get(c)!]).toEqual([...hwChars[i]!]))
        hw = [slot(v, 3), slot(v, 8)].reduce((n, c) => n + [0, 32].flatMap(o => [...decode4bpp(c, o)]).filter(p => p !== 0).length, 0) // prettier-ignore
        break
      }
      expect(hw).toBeGreaterThan(0)
      for (const p of pods) {
        const rgba = Buffer.from(p.rgba, 'base64')
        let opaque = 0
        for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) opaque++
        expect(opaque).toBe(hw)
      }
    },
  )
})
