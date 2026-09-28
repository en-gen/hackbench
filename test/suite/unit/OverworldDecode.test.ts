/**
 * The Overworld view's decode (theia/extension/src/node/overworld-decode.ts)
 * and its route through GfxServiceImpl. Synthetic first: every gate and the
 * pixels themselves are proven without a ROM. The vanilla canvas is pinned
 * by hash, which is not ROM bytes.
 */
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { bgr555ToRgba } from '../../../src/rom/GraphicsDecoder'
import { ADDR_BACK_AREA, ADDR_FG_PAIR } from '../../../src/rom/PaletteLoader'
import { OW_ADDR, map16ByteOffset, tilemapByteOffset } from '../../../src/rom/OverworldLoader'
import { WorkingRom } from '../../../src/project/WorkingRom'
import { FULL_WORD_MASK } from '../../../src/rom/PaletteOp'
import { decodeOverworldL1 } from '../../../theia/extension/src/node/overworld-decode'
import { GfxServiceImpl } from '../../../theia/extension/src/node/gfx-server'
import { plantGfxHook } from '../support/syntheticGfxCart'
import { OW_L2_READER, readOverworldL2 } from '../../../src/rom/OverworldL2'
import {
  CHAR_DATA,
  L2_LO,
  L2_WORD,
  SYNTHETIC_FPS,
  TILE_DATA,
  TITLE_HEADER,
  TILESET_TABLE,
  l2Tilemap,
  plantL2,
  setL2Word,
  syntheticOverworldRom,
  tileAt,
} from '../support/syntheticOverworld'
import { VANILLA, freshRom, hasRom } from '../support/corpus'

// The server passes no fingerprint override, and stock CODE_00AD25 and
// CODE_04DABA bytes are not committable, so its decode recognizes the
// synthetic NOP spans here.
vi.mock('../../../theia/extension/src/node/overworld-decode', async importOriginal => {
  const real =
    await importOriginal<typeof import('../../../theia/extension/src/node/overworld-decode')>()
  const { SYNTHETIC_FPS: fps } = await import('../support/syntheticOverworld')
  return {
    decodeOverworldL1: (rom: SmwRom, f?: Parameters<typeof real.decodeOverworldL1>[1]) =>
      real.decodeOverworldL1(rom, f ?? fps),
  }
})

import * as pin from '../support/overworld-pin.cjs'
const VANILLA_CANVAS_SHA256: string = pin.VANILLA_OVERWORLD_CANVAS_SHA256

const decode = (rom: RomFile) => decodeOverworldL1(new SmwRom(rom), SYNTHETIC_FPS)
const pixels = (rom: RomFile): Buffer => {
  const dto = decode(rom)
  if (dto.status !== 'ok') throw new Error(dto.reason)
  expect([dto.width, dto.height, dto.l2Unavailable]).toEqual([1024, 512, undefined])
  return Buffer.from(dto.rgbaBase64, 'base64')
}
const reason = (rom: RomFile, fps = SYNTHETIC_FPS) => {
  const dto = decodeOverworldL1(new SmwRom(rom), fps)
  return dto.status === 'ok' ? 'drawn' : dto.reason
}

/**
 * What cell (row, col) paints at its top-left quadrant, from the synthetic
 * model: char (id*4) & $3F in tileset t's file t, solid color (t % 7) + 1,
 * CGRAM row 4 + (id & 3) of palette block DATA_00AD1E[(t & $0F) - 1].
 */
function expectedAt(
  row: number,
  col: number,
  tileset: number,
  block = (tileset & 0x0f) - 1,
): number[] {
  const id = tileAt(row, col)
  const v = (tileset % 7) + 1
  const k = (id & 3) * 7 + (v - 1)
  return [...bgr555ToRgba((block + 1) | ((k + 1) << 5))]
}
/** L2_WORD's color: CGRAM row 7 of the same block, color (t % 7) + 1. */
function l2ColorAt(tileset: number): number[] {
  const k = 3 * 7 + (tileset % 7)
  return [...bgr555ToRgba((tileset & 0x0f) | ((k + 1) << 5))]
}
/** 1024 wide: grid cell (row 0-31, col 0-63), 2 px into its top-left quadrant. */
const pixelAt = (px: Buffer, row: number, col: number): number[] => {
  const at = ((row * 16 + 2) * 1024 + col * 16 + 2) * 4
  return [...px.subarray(at, at + 4)]
}

describe('decodeOverworldL1 on a synthetic ROM', () => {
  it('paints each cell from its tile, the ROM-read tileset and that tileset palette', () => {
    const px = pixels(syntheticOverworldRom(0x12))
    // Both sides of the half boundary, and the far corners.
    for (const [row, col] of [
      [0, 0],
      [0, 31],
      [0, 32],
      [17, 40],
      [31, 63],
    ] as const) {
      expect(pixelAt(px, row, col), `cell ${row},${col}`).toEqual(expectedAt(row, col, 0x12))
    }
  })

  it('area 0 tileset $13 loads its own GFX and DATA_00AD1E[2], not the submap entry', () => {
    const rom = syntheticOverworldRom(0x13)
    const px = pixels(rom)
    expect(pixelAt(px, 5, 9)).toEqual(expectedAt(5, 9, 0x13))
    expect(rom.readByte(OW_ADDR.PALETTE_INDEX_TABLE + 2)).toBe(2)
    expect(pixelAt(px, 5, 9)).not.toEqual(expectedAt(5, 9, 0x11))
  })

  it('finds the palette block through DATA_00ABDF, not a uniform $38 stride', () => {
    const rom = syntheticOverworldRom(0x12)
    // Palette index 1's offset points at the block the synthetic ROM lays at +$70.
    rom.writeAt(OW_ADDR.PALETTE_BLOCK_OFFSETS + 2, [0x70, 0x00])
    const px = pixels(rom)
    expect(pixelAt(px, 5, 9)).toEqual(expectedAt(5, 9, 0x12, 2))
    expect(pixelAt(px, 5, 9)).not.toEqual(expectedAt(5, 9, 0x12))
  })

  it('seeds the cells CODE_00AD25 leaves alone from the title screen map header', () => {
    const rom = syntheticOverworldRom()
    // ForegroundPalettes ($00B190) variant 1 is white; the title header names FG palette 1.
    rom.writeAt(
      ADDR_FG_PAIR + 0x18,
      Array.from({ length: 24 }, (_, i) => (i % 2 ? 0x7f : 0xff)),
    )
    rom.writeAt(TITLE_HEADER + 3, [0x01])
    // Cell (5, 9)'s top-left char draws in CGRAM row 2, which only the seed fills.
    rom.writeAt(CHAR_DATA + tileAt(5, 9) * 8 + 1, [2 << 2])
    expect(pixelAt(pixels(rom), 5, 9)).toEqual([...bgr555ToRgba(0x7fff)])
  })

  it('refuses the L1 reader, the palette load, its call and a hooked GFX loader, with reasons', () => {
    const reader = syntheticOverworldRom()
    reader.writeAt(0x04dc5a, [0x00])
    expect(reason(reader)).toMatch(/L1 reader is not stock: \$04DC57/)

    expect(reason(syntheticOverworldRom(), { ...SYNTHETIC_FPS, cgram: [] })).toMatch(
      /palette load is not stock: \$00AD25/,
    )

    const call = syntheticOverworldRom()
    call.writeAt(0x00a14d, [0xea, 0xea, 0xea])
    expect(reason(call)).toMatch(/palette load is not stock: \$00A14D/)

    const hooked = syntheticOverworldRom()
    plantGfxHook(hooked, 0x0ff000, 0x00ba46, 'direct')
    hooked.writeAt(0x00aa6b, [0x22, 0x00, 0xf0, 0x0f])
    expect(reason(hooked)).toMatch(/overworld's GFX files through Lunar Magic's ExGFX hook/)

    const decompressor = syntheticOverworldRom()
    decompressor.writeAt(0x00b8de, [0x00])
    expect(reason(decompressor)).toMatch(/^The overworld GFX cannot be read/)

    const noTile = syntheticOverworldRom()
    noTile.writeAt(TILESET_TABLE, [0x10])
    expect(reason(noTile)).toMatch(/names no overworld palette/)

    const noTitle = syntheticOverworldRom()
    noTitle.writeAt(0x0096cb, [0x00])
    expect(reason(noTitle)).toMatch(/^Title screen/)
  })

  it('orders L2 low, L1 low, L2 high, L1 high over the backdrop, in both halves', () => {
    const backdrop = 0x1234 // the title map's back area color (header bgColor 0)
    // Cells whose id & 3 = 0, so L1's row 4 color differs from L2's row 7: one per half.
    for (const [r, c] of [
      [5, 9],
      [5, 41],
    ] as const) {
      const id = tileAt(r, c)
      const l1 = expectedAt(r, c, 0x12)
      const l2 = l2ColorAt(0x12)
      expect(l1).not.toEqual(l2)
      const draw = (l2Word: number, l1Low: number, l1High: number): number[] => {
        const rom = syntheticOverworldRom(0x12)
        rom.writeAt(ADDR_BACK_AREA, [backdrop & 0xff, backdrop >> 8])
        const t = l2Tilemap()
        setL2Word(t, 2 * r, 2 * c, l2Word)
        plantL2(rom, t)
        rom.writeAt(CHAR_DATA + id * 8, [l1Low, l1High])
        return pixelAt(pixels(rom), r, c)
      }
      const l1Row = (4 + (id & 3)) << 2
      const opaque = (id * 4) & 0x3f
      const cell = `cell ${r},${c}: `
      expect(draw(L2_WORD, opaque, l1Row), cell + 'L1 low over L2 low').toEqual(l1)
      expect(draw(L2_WORD | 0x2000, opaque, l1Row), cell + 'L2 high over L1 low').toEqual(l2)
      expect(draw(L2_WORD | 0x2000, opaque, l1Row | 0x20), cell + 'L1 high over L2 high').toEqual(
        l1,
      )
      expect(draw(L2_WORD, 0x40, l1Row), cell + 'L2 low through a clear L1').toEqual(l2)
      expect(draw((L2_WORD & ~0x3ff) | 0x40, 0x40, l1Row), cell + 'the backdrop').toEqual([
        ...bgr555ToRgba(backdrop),
      ])
    }
  })

  it('reads L2 from the stream operands, refusing only L2 on any pinned byte', () => {
    const drawnL2 = (rom: RomFile): string => {
      const dto = decode(rom)
      if (dto.status !== 'ok') throw new Error(dto.reason)
      return dto.l2Unavailable ?? 'drawn'
    }
    const base = syntheticOverworldRom()
    expect(drawnL2(base)).toBe('drawn')
    // The sweep reads L2 alone on copies of one ROM; the whole decode is slow per ROM.
    let flips = 0
    for (const c of OW_L2_READER) {
      if (!('bytes' in c)) continue
      c.bytes.forEach((b, i) => {
        if (b < 0) return // WILD: a stream operand, read not pinned
        const rom = RomFile.fromBytes('flip.sfc', Buffer.from(base.buffer))
        rom.writeAt(c.addr + i, [b ^ (i === c.bankAt ? 0x7f : 0xff)])
        const r = readOverworldL2(rom, SYNTHETIC_FPS.l2)
        expect(r.ok ? 'read' : r.reason, `flip at $${(c.addr + i).toString(16)}`).toMatch(
          /^the L2 decompressor is not stock: \$[0-9A-F]{6} \(/,
        )
        flips++
      })
    }
    expect(flips).toBe(55)
    const span = decodeOverworldL1(new SmwRom(syntheticOverworldRom()), {
      ...SYNTHETIC_FPS,
      l2: [],
    })
    expect(span.status === 'ok' && span.l2Unavailable).toMatch(/\$04DABA/)
    const short = syntheticOverworldRom()
    short.writeAt(0x04dc72, [0xf0, 0xff]) // 16 bytes before the bank ends
    expect(drawnL2(short)).toMatch(/ends before \$4000 bytes/)
    const ram = syntheticOverworldRom()
    ram.writeAt(0x04dc72, [0x00, 0x10])
    expect(drawnL2(ram)).toMatch(/is not in the ROM/)
  })

  it('a working-copy edit to an L2 stream byte changes the pixels', () => {
    const [r, c] = [5, 9]
    const rom = syntheticOverworldRom(0x12)
    rom.writeAt(CHAR_DATA + tileAt(r, c) * 8, [0x40]) // clear L1 there, so L2 shows
    const working = new WorkingRom(Uint8Array.from(rom.buffer), false)
    const px = () => pixelAt(pixels(RomFile.fromBytes('w', Buffer.from(working.bytes()))), r, c)
    expect(px()).toEqual(l2ColorAt(0x12))
    // The low stream's byte for that word: literal runs of 128, one command byte each.
    const o = tilemapByteOffset(0, 2 * r, 2 * c)
    const at = L2_LO + Math.floor(o / 256) * 129 + 1 + (o % 256) / 2
    const hex = (w: number) => `$${w.toString(16).padStart(4, '0')}`
    const old = rom.readWord(at)!
    working.append({
      id: 'l2',
      label: 'L2 char',
      ops: [
        { address: hex(at), old: hex(old), new: hex((old & 0xff00) | 0x40), mask: FULL_WORD_MASK },
      ],
    })
    expect(px()).toEqual([0, 0, 0, 255])
  })

  it('reads the working copy through GfxServiceImpl: an edit redraws, undo restores', async () => {
    const rom = syntheticOverworldRom()
    const working = new WorkingRom(Uint8Array.from(rom.buffer), false)
    const svc = Object.assign(new GfxServiceImpl(), {
      workingRoms: { get: () => ({ status: 'ok', working, romPath: 's.sfc', project: {} }) },
    })
    const draw = async () => {
      const dto = await svc.overworldL1('p.hbproj')
      if (dto.status !== 'ok') throw new Error(dto.reason)
      return pixelAt(Buffer.from(dto.rgbaBase64, 'base64'), 2, 3)
    }
    const before = await draw()
    expect(before).toEqual(expectedAt(2, 3, 0x12))
    const at = TILE_DATA + map16ByteOffset(0, 2, 3)
    const hex = (w: number) => `$${w.toString(16).padStart(4, '0')}`
    const old = rom.readWord(at)!
    working.append({
      id: 'l1',
      label: 'L1 tile',
      ops: [{ address: hex(at), old: hex(old), new: hex(old ^ 1), mask: FULL_WORD_MASK }],
    })
    expect(await draw()).not.toEqual(before)
    working.pop()
    expect(await draw()).toEqual(before)
  })
})

describe.skipIf(!hasRom(VANILLA))('decodeOverworldL1 on vanilla', () => {
  it('draws the pinned canvas, and a one-tile edit differs from the pin', async () => {
    const sha = async (rom: RomFile) => {
      const real = await vi.importActual<
        typeof import('../../../theia/extension/src/node/overworld-decode')
      >('../../../theia/extension/src/node/overworld-decode')
      const dto = real.decodeOverworldL1(new SmwRom(rom))
      if (dto.status !== 'ok') throw new Error(dto.reason)
      return createHash('sha256').update(Buffer.from(dto.rgbaBase64, 'base64')).digest('hex')
    }
    expect(await sha(freshRom())).toBe(VANILLA_CANVAS_SHA256)
    const edited = freshRom()
    // Grid cell (row 1, col 55) draws an opaque L1 icon on vanilla; tile 0 draws nothing.
    edited.writeAt(0x0cf7df + map16ByteOffset(1, 1, 23), [0])
    expect(await sha(edited)).not.toBe(VANILLA_CANVAS_SHA256)
  })
})
