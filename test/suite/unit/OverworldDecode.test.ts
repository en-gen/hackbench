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
import { ADDR_FG_PAIR } from '../../../src/rom/PaletteLoader'
import { OW_ADDR, map16ByteOffset } from '../../../src/rom/OverworldLoader'
import { WorkingRom } from '../../../src/project/WorkingRom'
import { FULL_WORD_MASK } from '../../../src/rom/PaletteOp'
import { decodeOverworldL1 } from '../../../theia/extension/src/node/overworld-decode'
import { GfxServiceImpl } from '../../../theia/extension/src/node/gfx-server'
import { plantGfxHook } from '../support/syntheticGfxCart'
import {
  CHAR_DATA,
  SYNTHETIC_CGRAM_FINGERPRINT,
  TILE_DATA,
  TITLE_HEADER,
  TILESET_TABLE,
  syntheticOverworldRom,
  tileAt,
} from '../support/syntheticOverworld'
import { VANILLA, freshRom, hasRom } from '../support/corpus'

// The server passes no fingerprint override, and stock CODE_00AD25 bytes are
// not committable, so its decode recognizes the synthetic NOP span here.
vi.mock('../../../theia/extension/src/node/overworld-decode', async importOriginal => {
  const real =
    await importOriginal<typeof import('../../../theia/extension/src/node/overworld-decode')>()
  const { SYNTHETIC_CGRAM_FINGERPRINT: fps } = await import('../support/syntheticOverworld')
  return {
    decodeOverworldL1: (rom: SmwRom, f?: readonly string[]) =>
      real.decodeOverworldL1(rom, f ?? fps),
  }
})

import * as pin from '../support/overworld-pin.cjs'
const VANILLA_CANVAS_SHA256: string = pin.VANILLA_OVERWORLD_CANVAS_SHA256

const decode = (rom: RomFile) => decodeOverworldL1(new SmwRom(rom), SYNTHETIC_CGRAM_FINGERPRINT)
const pixels = (rom: RomFile): Buffer => {
  const dto = decode(rom)
  if (dto.status !== 'ok') throw new Error(dto.reason)
  expect([dto.width, dto.height]).toEqual([1024, 512])
  return Buffer.from(dto.rgbaBase64, 'base64')
}
const reason = (rom: RomFile, fps = SYNTHETIC_CGRAM_FINGERPRINT) => {
  const dto = decodeOverworldL1(new SmwRom(rom), fps)
  return dto.status === 'ok' ? 'drawn' : dto.reason
}

/**
 * What cell (row, col) paints at its top-left quadrant, from the synthetic
 * model: char (id*4) & $7F in tileset t's file t, solid color (t % 7) + 1,
 * CGRAM row 4 + (id & 3) of palette block DATA_00AD1E[(t & $0F) - 1].
 */
function expectedAt(row: number, col: number, tileset: number): number[] {
  const id = tileAt(row, col)
  const v = (tileset % 7) + 1
  const block = (tileset & 0x0f) - 1
  const k = (id & 3) * 7 + (v - 1)
  return [...bgr555ToRgba((block + 1) | ((k + 1) << 5))]
}
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

    expect(reason(syntheticOverworldRom(), [])).toMatch(/palette load is not stock: \$00AD25/)

    const call = syntheticOverworldRom()
    call.writeAt(0x00a14d, [0xea, 0xea, 0xea])
    expect(reason(call)).toMatch(/palette load is not stock: \$00A14D/)

    const hooked = syntheticOverworldRom()
    plantGfxHook(hooked, 0x0ff000, 0x00ba46, 'direct')
    hooked.writeAt(0x00aa6b, [0x22, 0x00, 0xf0, 0x0f])
    expect(reason(hooked)).toMatch(/Lunar Magic's list/)

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
    // Grid cell (row 1, col 55) draws opaque on vanilla; tile 0 draws nothing.
    edited.writeAt(0x0cf7df + map16ByteOffset(1, 1, 23), [0])
    expect(await sha(edited)).not.toBe(VANILLA_CANVAS_SHA256)
  })
})
