/**
 * Kept apart from BytePattern.ts because it needs Node's `crypto`, which the
 * reference extension's browser bundles cannot resolve.
 */
import { createHash } from 'crypto'

/** SHA-256 of `bytes`, or null for a failed read. For recognized code too
 *  long to commit literally. */
export function fingerprint(bytes: Uint8Array | null): string | null {
  return bytes ? createHash('sha256').update(bytes).digest('hex') : null
}
