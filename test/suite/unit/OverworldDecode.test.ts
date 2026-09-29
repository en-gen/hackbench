/**
 * The Overworld view's decode (theia/extension/src/node/overworld-decode.ts),
 * its route through GfxServiceImpl, and the browser's composition
 * (OverworldComposite). Synthetic first: every gate and the pixels are proven
 * without a ROM. The vanilla canvas is pinned by hash, which is not ROM bytes.
 */
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { bgr555ToRgba } from '../../../src/rom/GraphicsDecoder'
import { ADDR_FG_PAIR } from '../../../src/rom/PaletteLoader'
import { OW_ADDR, map16ByteOffset, tilemapByteOffset } from '../../../src/rom/OverworldLoader'
import { compositeOverworld } from '../../../src/rom/render/OverworldComposite'
import { WorkingRom } from '../../../src/project/WorkingRom'
import { decodeOverworld } from '../../../theia/extension/src/node/overworld-decode'
import type { OverworldDto } from '../../../theia/extension/src/common/gfx-protocol'
import { plantGfxHook } from '../support/syntheticGfxCart'
import {
  BACKDROP_BGR,
  CHAR_DATA,
  L2_FLIP_PROBES,
  L2_LO,
  L2_PROBES,
  L2_WORD,
  PRIO,
  SYNTHETIC_FPS,
  TILE_DATA,
  TITLE_HEADER,
  TILESET_TABLE,
  edit,
  l2Tilemap,
  plantL2,
  setL2Word,
  syntheticOverworldRom,
  tileAt,
} from '../support/syntheticOverworld'
import { VANILLA, freshRom, hasRom } from '../support/corpus'
import * as pin from '../support/overworld-pin.cjs'
import { existsSync } from 'fs'
import { resolve } from 'path'

/** GfxServiceImpl imports @theia/core, which CI's unit job does not install. */
const theiaInstalled = existsSync(
  resolve(__dirname, '../../../theia/node_modules/@theia/core/package.json'),
)

// The server passes no fingerprint override, and stock CODE_00AD25 and
// CODE_04DABA bytes are not committable, so its decode recognizes the
// synthetic NOP spans here.
vi.mock('../../../theia/extension/src/node/overworld-decode', async importOriginal => {
  const real =
    await importOriginal<typeof import('../../../theia/extension/src/node/overworld-decode')>()
  const { SYNTHETIC_FPS: fps } = await import('../support/syntheticOverworld')
  return {
    decodeOverworld: (rom: SmwRom, f?: Parameters<typeof real.decodeOverworld>[1]) =>
      real.decodeOverworld(rom, f ?? fps),
  }
})

const b64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'base64'))

/** The canvas the browser paints, with each layer shown or hidden. */
function compose(dto: OverworldDto, show = { l1: true, l2: true }): Buffer {
  if (dto.status !== 'ok') throw new Error(dto.reason)
  const layer = (l: { rgbaBase64: string; prioBase64: string } | undefined) =>
    l ? { rgba: new Uint8ClampedArray(b64(l.rgbaBase64)), prio: b64(l.prioBase64) } : null
  const px = compositeOverworld(
    dto.width,
    dto.height,
    dto.backdrop,
    show.l2 ? layer(dto.l2) : null,
    show.l1 ? layer(dto.l1) : null,
  )
  return Buffer.from(px)
}
const sha = (px: Buffer): string => createHash('sha256').update(px).digest('hex')

const decode = (rom: RomFile) => decodeOverworld(new SmwRom(rom), SYNTHETIC_FPS)
const pixels = (rom: RomFile, show?: { l1: boolean; l2: boolean }): Buffer => {
  const dto = decode(rom)
  if (dto.status !== 'ok') throw new Error(dto.reason)
  expect([dto.width, dto.height, dto.l2Unavailable]).toEqual([1024, 512, undefined])
  return compose(dto, show)
}
const reason = (rom: RomFile, fps = SYNTHETIC_FPS) => {
  const dto = decodeOverworld(new SmwRom(rom), fps)
  return dto.status === 'ok' ? 'drawn' : dto.reason
}

/**
 * A color from the synthetic model: CGRAM row `row` of palette block
 * DATA_00AD1E[(t & $0F) - 1], color index `index`.
 */
function color(row: number, index: number, tileset = 0x12, block = (tileset & 0x0f) - 1): number[] {
  const k = (row - 4) * 7 + (index - 1)
  return [...bgr555ToRgba((block + 1) | ((k + 1) << 5))]
}
/** What L1 cell (row, col) paints at its top-left quadrant: char (id*4) & $3F in
 *  tileset t's file t, solid color (t % 7) + 1, CGRAM row 4 + (id & 3). */
const expectedAt = (row: number, col: number, tileset: number, block?: number): number[] =>
  color(4 + (tileAt(row, col) & 3), (tileset % 7) + 1, tileset, block)
/** L2_WORD's color: row 7, solid. */
const l2Color = (tileset = 0x12): number[] => color(7, (tileset % 7) + 1, tileset)
const BACKDROP = [...bgr555ToRgba(BACKDROP_BGR)]

const at = (px: Buffer, x: number, y: number): number[] => {
  const i = (y * 1024 + x) * 4
  return [...px.subarray(i, i + 4)]
}
/** 1024 wide: L1 grid cell (row 0-31, col 0-63), 2 px into its top-left quadrant. */
const pixelAt = (px: Buffer, row: number, col: number): number[] =>
  at(px, col * 16 + 2, row * 16 + 2)
/** Clears L1 cell (row, col)'s top-left char (index 0), so what is under it shows. */
const clearL1 = (rom: RomFile, row: number, col: number): void =>
  rom.writeAt(CHAR_DATA + tileAt(row, col) * 8, [0x40])

describe('decodeOverworld on a synthetic ROM', () => {
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
    const px = pixels(syntheticOverworldRom(0x13))
    expect(pixelAt(px, 5, 9)).toEqual(expectedAt(5, 9, 0x13))
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

  it('orders L2 low, L1 low, L2 high, L1 high over the backdrop, in both halves', () => {
    // Cells whose id & 3 = 0, so L1's row 4 color differs from L2's row 7: one per half.
    for (const [r, c] of [
      [5, 9],
      [5, 41],
    ] as const) {
      const id = tileAt(r, c)
      const l1 = expectedAt(r, c, 0x12)
      const l2 = l2Color()
      expect(l1).not.toEqual(l2)
      const draw = (l2Word: number, l1Low: number, l1High: number): number[] => {
        const rom = syntheticOverworldRom(0x12)
        const t = l2Tilemap()
        setL2Word(t, 2 * r, 2 * c, l2Word)
        plantL2(rom, t)
        rom.writeAt(CHAR_DATA + id * 8, [l1Low, l1High])
        return pixelAt(pixels(rom), r, c)
      }
      const l1Row = (4 + (id & 3)) << 2
      const solid = (id * 4) & 0x3f
      const cell = `cell ${r},${c}: `
      expect(draw(L2_WORD, solid, l1Row), cell + 'L1 low over L2 low').toEqual(l1)
      expect(draw(L2_WORD | PRIO, solid, l1Row), cell + 'L2 high over L1 low').toEqual(l2)
      expect(draw(L2_WORD | PRIO, solid, l1Row | 0x20), cell + 'L1 high over L2 high').toEqual(l1)
      expect(draw(L2_WORD, 0x40, l1Row), cell + 'L2 low through a clear L1').toEqual(l2)
      expect(draw((L2_WORD & ~0x3ff) | 0x40, 0x40, l1Row), cell + 'the backdrop').toEqual(BACKDROP)
    }
  })

  it('places L2 in every quadrant of both layouts, and honors its flips', () => {
    const px = pixels(syntheticOverworldRom(0x12))
    for (const p of L2_PROBES) {
      const index = p.char === 0x3f ? (0x12 % 7) + 1 : 1
      expect(at(px, p.x * 8 + 2, p.y * 8 + 2), `probe ${p.y},${p.x}`).toEqual(color(p.row, index))
    }
    for (const p of L2_FLIP_PROBES) {
      const [dx, dy] = p.at as [number, number]
      expect(at(px, p.x * 8 + dx, p.y * 8 + dy), `flip ${p.flip}`).toEqual(color(6, 7))
      expect(at(px, p.x * 8 + 7 - dx, p.y * 8 + 7 - dy), `flip ${p.flip}`).toEqual(color(6, 1))
    }
  })

  it('draws L1 alone when L2 is refused: L1 exact, the backdrop where L2 would show', () => {
    const rom = syntheticOverworldRom(0x12)
    clearL1(rom, 5, 9)
    const dto = decodeOverworld(new SmwRom(rom), { ...SYNTHETIC_FPS, l2: [] })
    if (dto.status !== 'ok') throw new Error(dto.reason)
    expect([dto.l2, dto.l2Unavailable]).toEqual([undefined, expect.stringMatching(/\$04DABA/)])
    const px = compose(dto)
    expect(pixelAt(px, 17, 40)).toEqual(expectedAt(17, 40, 0x12))
    expect(pixelAt(px, 5, 9)).toEqual(BACKDROP)
    // Where an L2 probe sat over L1, L1 shows.
    const p = L2_PROBES[0]!
    expect(at(px, p.x * 8 + 2, p.y * 8 + 2)).toEqual(expectedAt(p.y >> 1, p.x >> 1, 0x12))
  })

  it('each layer toggle re-composes without the other layer', () => {
    const rom = syntheticOverworldRom(0x12)
    clearL1(rom, 5, 9)
    const p = L2_PROBES[0]! // L2 high over L1 low
    const [x, y] = [p.x * 8 + 2, p.y * 8 + 2]
    const noL2 = pixels(rom, { l1: true, l2: false })
    const noL1 = pixels(rom, { l1: false, l2: true })
    expect(at(pixels(rom), x, y)).toEqual(color(p.row, (0x12 % 7) + 1))
    expect(at(noL2, x, y)).toEqual(expectedAt(p.y >> 1, p.x >> 1, 0x12))
    expect(pixelAt(noL2, 5, 9)).toEqual(BACKDROP)
    expect(pixelAt(noL1, 17, 40)).toEqual(l2Color())
    expect(pixelAt(pixels(rom, { l1: false, l2: false }), 17, 40)).toEqual(BACKDROP)
  })

  it('refuses the L1 reader, the palette load, its call and a hooked GFX loader, with reasons', () => {
    const reader = syntheticOverworldRom()
    reader.writeAt(0x04dc5a, [0x00])
    expect(reason(reader)).toMatch(/L1 reader is not stock: \$04DC4C/)

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

  it('a working-copy edit to an L2 stream byte changes the pixels', () => {
    const [r, c] = [5, 9]
    const rom = syntheticOverworldRom(0x12)
    clearL1(rom, r, c)
    const working = new WorkingRom(Uint8Array.from(rom.buffer), false)
    const px = () => pixelAt(pixels(RomFile.fromBytes('w', Buffer.from(working.bytes()))), r, c)
    expect(px()).toEqual(l2Color())
    // The low stream's byte for that word: literal runs of 128, one command byte each.
    const o = tilemapByteOffset(0, 2 * r, 2 * c)
    edit(working, L2_LO + Math.floor(o / 256) * 129 + 1 + (o % 256) / 2, w => (w & 0xff00) | 0x40)
    expect(px()).toEqual(BACKDROP)
  })

  it.skipIf(!theiaInstalled)(
    'reads the working copy through GfxServiceImpl: an edit redraws, undo restores',
    async () => {
      const { GfxServiceImpl } = await import('../../../theia/extension/src/node/gfx-server')
      const rom = syntheticOverworldRom()
      const working = new WorkingRom(Uint8Array.from(rom.buffer), false)
      const svc = Object.assign(new GfxServiceImpl(), {
        workingRoms: { get: () => ({ status: 'ok', working, romPath: 's.sfc', project: {} }) },
      })
      const draw = async () => pixelAt(compose(await svc.overworld('p.hbproj')), 2, 3)
      const before = await draw()
      expect(before).toEqual(expectedAt(2, 3, 0x12))
      edit(working, TILE_DATA + map16ByteOffset(0, 2, 3), w => w ^ 1)
      expect(await draw()).not.toEqual(before)
      working.pop()
      expect(await draw()).toEqual(before)
    },
  )
})

describe.skipIf(!hasRom(VANILLA))('decodeOverworld on vanilla', () => {
  const vanilla = async (rom: RomFile) => {
    const real = await vi.importActual<
      typeof import('../../../theia/extension/src/node/overworld-decode')
    >('../../../theia/extension/src/node/overworld-decode')
    return real.decodeOverworld(new SmwRom(rom))
  }

  it('draws the pinned canvas; each layer alone is its own pin, and an L1 edit differs', async () => {
    const dto = await vanilla(freshRom())
    expect(sha(compose(dto))).toBe(pin.VANILLA_OVERWORLD_CANVAS_SHA256)
    expect(sha(compose(dto, { l1: true, l2: false }))).toBe(pin.VANILLA_OVERWORLD_L1_SHA256)
    expect(sha(compose(dto, { l1: false, l2: true }))).toBe(pin.VANILLA_OVERWORLD_L2_SHA256)
    const edited = freshRom()
    // Grid cell (row 1, col 55) draws an opaque L1 icon on vanilla; tile 0 draws nothing.
    edited.writeAt(0x0cf7df + map16ByteOffset(1, 1, 23), [0])
    expect(sha(compose(await vanilla(edited)))).not.toBe(pin.VANILLA_OVERWORLD_CANVAS_SHA256)
  })

  it('an L2 it refuses leaves exactly the L1-alone canvas', async () => {
    const rom = freshRom()
    rom.writeAt(0x04dc99, [0x00]) // JSR CODE_04DABA for the high stream
    const dto = await vanilla(rom)
    expect(dto.status === 'ok' && dto.l2Unavailable).toMatch(/\$04DC91/)
    expect(sha(compose(dto))).toBe(pin.VANILLA_OVERWORLD_L1_SHA256)
  })
})
