import { describe, it } from 'vitest'
import { decode4bpp, decodeTilesBatch, bytesPerTile } from '../../../src/rom/GraphicsDecoder'
import { perfCase } from '../support/perfCase'

function syntheticTileBytes(tiles: number): Uint8Array {
  const bytes = new Uint8Array(bytesPerTile(4) * tiles)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13) & 0xff
  return bytes
}

describe('core.gfx.decode4bpp', () => {
  it('synthetic-tile', async () => {
    const data = syntheticTileBytes(1)
    await perfCase('core.gfx.decode4bpp.synthetic-tile', 'ms', 'lower', () => {
      decode4bpp(data, 0)
    })
  })

  it('synthetic-sheet', async () => {
    // A full 16x16-tile GFX sheet, the unit GfxLoader decodes per file.
    const data = syntheticTileBytes(256)
    await perfCase('core.gfx.decode4bpp.synthetic-sheet', 'ms', 'lower', () => {
      decodeTilesBatch(data, 4)
    })
  })
})
