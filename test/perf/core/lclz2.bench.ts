import { describe, it } from 'vitest'
import { encode, decompress } from '../../../src/rom/LcLz2'
import { perfCase } from '../support/perfCase'

// Synthetic content only (docs/testing.md, content gate): a deterministic
// pseudo-random byte pattern, encoded once with this repo's own encoder so
// decompress() has a realistic mix of literal runs and back-references.
function syntheticBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 7 + (i >> 8)) & 0xff
  return bytes
}

describe('core.lclz2.decompress', () => {
  it('synthetic-4k', async () => {
    const compressed = encode(syntheticBytes(4 * 1024))
    await perfCase('core.lclz2.decompress.synthetic-4k', 'ms', 'lower', () => {
      decompress(compressed)
    })
  })

  it('synthetic-64k', async () => {
    const compressed = encode(syntheticBytes(64 * 1024))
    await perfCase('core.lclz2.decompress.synthetic-64k', 'ms', 'lower', () => {
      decompress(compressed)
    })
  })
})
