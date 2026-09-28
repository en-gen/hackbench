import { describe } from 'vitest'
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
  const c4k = encode(syntheticBytes(4 * 1024))
  perfCase('core.lclz2.decompress.synthetic-4k', () => decompress(c4k))

  const c64k = encode(syntheticBytes(64 * 1024))
  perfCase('core.lclz2.decompress.synthetic-64k', () => decompress(c64k))
})
