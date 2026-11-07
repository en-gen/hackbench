/**
 * #1169: the neighbor rerun gets its own upload probe, so a sprite drawn alone never carries the graphics
 * uploads a placed neighbor wrote. Synthetic, no ROM: id 62 scans the slot tables for id 64 (draws its own
 * piece, then the companion), id 66 is id 62 after it uploads slot 2 itself, id 63 writes DynGfxTilePtr slot 0
 * in every MAIN, id 65 executes COP in its second MAIN (so the rerun refuses after pass 0 had uploaded),
 * id 64 draws nothing alone. Through the real `runWithUploads`; `neighbourRun` is the runner's own verdict.
 * Evidence scope: the fixture's own routines; vanilla is not swept here.
 */
import { describe, expect, it, vi } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { DYN_GFX_TILE_PTR } from '../../../../src/rom/MarioGraphics'
import { runOnce, runSprite } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { fingerprint } from '../../../../src/rom/Fingerprint'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { runWithUploads } from '../../../../theia/extension/src/node/map-sprites'
import { grinderShape } from '../../support/syntheticGrinder'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const SCANNER = 62
const WRITER = 63
const QUIET = 64
const REFUSER = 65
const OWNER = 66
const OWN = 0x2222
const TABLES = 0x02a7f6
const GRINDER = 103
const CAMERA_PTR = 0x18
const WRITTEN = 0x1234

/** The ROM described above; `grinder` also routes id 103's interact call to a scanner that uploads from the camera. */
function cart(grinder = false): RomFile {
  const bytes = new Uint8Array(
    buildSyntheticRom(grinder ? { grinderWideX: true, grinderInitShifts: true } : {}).buffer,
  )
  const off = (snes: number) => (snes >>> 16) * 0x8000 + ((snes & 0xffff) - 0x8000)
  const put = (snes: number, b: number[]) => {
    expect(bytes.subarray(off(snes), off(snes) + b.length).every(v => v === 0)).toBe(true)
    bytes.set(b, off(snes))
  }
  const main = (id: number, at: number) => {
    const o = off(0x018320 + 9 + id * 2)
    bytes[o] = at & 0xff
    bytes[o + 1] = at >> 8
  }
  // One instruction per row; the opcodes are the 65816's, the routines are written for this test.
  const asm = (...rows: number[][]) => rows.flat()
  const [JSR, LDY, LDA_ABY, EOR, BNE, BEQ, DEY, BPL, RTS] = [
    0x20, 0xa0, 0xb9, 0x49, 0xd0, 0xf0, 0x88, 0x10, 0x60,
  ]
  const [PHX, TYX, PLX, LDA_IMM, STA_ABS, LDA_ABX, INC_A, STA_ABX, CMP, COP] = [
    0xda, 0xbb, 0xfa, 0xa9, 0x8d, 0xbd, 0x1a, 0x9d, 0xc9, 0x02,
  ]
  const [LDA_ZP, RTL] = [0xa5, 0x6b]
  const ptr = (n: number) => DYN_GFX_TILE_PTR + n
  // Draw, then scan slots 9..0 for a status-8 sprite numbered QUIET and draw it too.
  put(
    0x01a400,
    asm(
      [JSR, 0x40, 0x86],
      [LDY, 9],
      [LDA_ABY, 0xc8, 0x14],
      [EOR, 8],
      [BNE, 7],
      [LDA_ABY, 0x9e, 0x00],
      [EOR, QUIET],
      [BEQ, 4],
      [DEY],
      [BPL, 0xef],
      [RTS],
      [PHX],
      [TYX],
      [JSR, 0x40, 0x86],
      [PLX],
      [RTS],
    ),
  )
  // Write WRITTEN into DynGfxTilePtr slot 0.
  put(
    0x01a500,
    asm(
      [LDA_IMM, WRITTEN & 0xff],
      [STA_ABS, ptr(0) & 0xff, ptr(0) >> 8],
      [LDA_IMM, WRITTEN >> 8],
      [STA_ABS, ptr(1) & 0xff, ptr(1) >> 8],
      [RTS],
    ),
  )
  // Count calls in $1570,X; execute COP on the second.
  put(
    0x01c600,
    asm([LDA_ABX, 0x70, 0x15], [INC_A], [STA_ABX, 0x70, 0x15], [CMP, 2], [BNE, 2], [COP, 0], [RTS]),
  )
  // Upload OWN into slot 2, then do what id 62 does.
  put(
    0x01c700,
    asm(
      [LDA_IMM, OWN & 0xff],
      [STA_ABS, ptr(4) & 0xff, ptr(4) >> 8],
      [LDA_IMM, OWN >> 8],
      [STA_ABS, ptr(5) & 0xff, ptr(5) >> 8],
      [JSR, 0x00, 0xa4],
      [RTS],
    ),
  )
  // Id 103's interact: store the camera's low byte as slot 0's pointer, then scan as id 62 does.
  put(
    0x01c800,
    asm([LDA_ZP, 0x1a], [STA_ABS, ptr(0) & 0xff, ptr(0) >> 8], [JSR, 0x00, 0xa4], [RTL]),
  )
  // The dispatch block's JSL operand (draw, then JSL interact) goes to that routine;
  // the loader tables are our own values.
  if (grinder) {
    bytes.set([0x00, 0xc8], off(0x019224))
    bytes.set([0xd8, 0, 0x10, 0xff, 0, 1], off(TABLES))
  }
  main(OWNER, 0xc700)
  main(SCANNER, 0xa400)
  main(WRITER, 0xa500)
  main(REFUSER, 0xc600)
  return RomFile.fromBytes('uploads.sfc', bytes)
}

const seed = (neighbours?: { id: number; x: number; y: number }[]) =>
  withSeed({ sprite: { x: 0x80, y: 0x80 }, ...(neighbours ? { neighbours } : {}) })
const at = (id: number, x: number) => ({ id, x, y: 0x70 })

describe('the neighbor rerun and the graphics uploads (#1169)', () => {
  const rom = cart()

  // The sprite's own uploads stay and the neighbor's (slot 0) stay out, whichever way the rerun ends.
  it.each([
    ['same', SCANNER, [at(WRITER, 0x90)], []],
    ['refused', SCANNER, [at(WRITER, 0x90), at(REFUSER, 0xa0)], []],
    ['same', OWNER, [at(WRITER, 0x90)], [{ slot: 2, ptr: OWN }]],
    ['refused', OWNER, [at(WRITER, 0x90), at(REFUSER, 0xa0)], [{ slot: 2, ptr: OWN }]],
  ])('%s: id %i keeps its own uploads and none of the neighbor uploads', (run, id, near, own) => {
    const m = runWithUploads(rom, id as number, seed(near as ReturnType<typeof at>[]))
    expect(m.neighbourRun).toBe(run)
    expect(m.uploads!.length).toBeGreaterThan(0)
    for (const u of m.uploads!) expect(u).toEqual(own)
  })

  it("adopted: the model holds the neighbor run's own uploads", () => {
    const m = runWithUploads(rom, SCANNER, seed([at(WRITER, 0x90), at(QUIET, 0xa0)]))
    expect(m.neighbourRun).toBe('adopted')
    expect(m.uploads!.length).toBeGreaterThan(0)
    for (const u of m.uploads!) expect(u).toEqual([{ slot: 0, ptr: WRITTEN }])
  })

  // The nested runs (the mirrored Mario) are not the rerun: the outer rerun's probe never hears them.
  it('the mirror run never calls the rerun probe', () => {
    const s = seed([at(WRITER, 0x90), at(QUIET, 0xa0)])
    const calls = (go: (neighbourProbe: () => void) => unknown) => {
      const spy = vi.fn()
      go(spy)
      return spy.mock.calls.length
    }
    const alone = calls(np => runOnce(rom, SCANNER, s, { neighbourProbe: np }))
    expect(alone).toBeGreaterThan(0)
    expect(calls(np => runSprite(rom, SCANNER, s, { neighbourProbe: np }))).toBe(alone)
  })

  // A line-guided sprite's spawn-camera runs happen inside the run whose record is returned (D156); none of them
  // may write it. Each camera stores a different pointer, so a leak shows as a pointer that is not the placed camera's.
  it.each([
    ['adopted', QUIET],
    ['same', 5],
  ])('%s: spawn-camera runs leave the returned uploads alone', (run, near) => {
    const grinder = cart(true)
    const loader = { at: TABLES, len: 6, sha: fingerprint(grinder.readAt(TABLES, 6))! }
    const opts = { grinderDispatch: grinderShape(grinder), loader } as never
    const sprite = { x: 0x1090, y: 0x1090 }
    const camera = { x: 0x1010 }
    const neighbours = [{ id: near, x: 0x10a0, y: 0x1090 }]
    const at3 = withSeed({ slot: 3, sprite, camera, neighbours }, SPRITE_SEED)
    const m = runWithUploads(grinder, GRINDER, at3, opts)
    expect(m.neighbourRun).toBe(run)
    expect(m.uploads!.length).toBeGreaterThan(0)
    for (const u of m.uploads!) expect(u).toEqual([{ slot: 0, ptr: CAMERA_PTR }])
  })
})
