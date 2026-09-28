import { describe } from 'vitest'
import { decode4bpp, decodeTilesBatch, bytesPerTile } from '../../../src/rom/GraphicsDecoder'
import { perfCase } from '../support/perfCase'

function syntheticTileBytes(tiles: number): Uint8Array {
  const bytes = new Uint8Array(bytesPerTile(4) * tiles)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13) & 0xff
  return bytes
}

describe('core.gfx.decode4bpp', () => {
  const oneTile = syntheticTileBytes(1)
  perfCase('core.gfx.decode4bpp.synthetic-tile', () => decode4bpp(oneTile, 0))

  // A full 16x16-tile GFX sheet, the unit GfxLoader decodes per file.
  const sheet = syntheticTileBytes(256)
  perfCase('core.gfx.decode4bpp.synthetic-sheet', () => decodeTilesBatch(sheet, 4))
})
