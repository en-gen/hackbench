/**
 * Pull a BRR sample out of sound RAM through the driver's sample directory.
 *
 * DIR entries are four bytes, start then loop address (S-DSP sample
 * directory). BRR blocks are nine bytes, and the header's bit 0 marks the
 * last block, bit 1 whether playback loops back to the loop address.
 */
import type { SoundImage } from './SourceScan'

export interface BrrSample {
  srcn: number
  start: number
  bytes: Uint8Array
  /** Byte offset of the loop point from the start, or null if the sample does not loop. */
  loopOffset: number | null
}

const BLOCK = 9
const MAX_BLOCKS = 0x10000 / BLOCK

export function readSample(image: SoundImage, srcn: number): BrrSample | string {
  const entry = image.engine.dir + srcn * 4
  const { aram, written } = image
  if (!written[entry] || !written[entry + 3])
    return `sample ${srcn}: directory entry was never uploaded`
  const start = aram[entry] | (aram[entry + 1] << 8)
  const loop = aram[entry + 2] | (aram[entry + 3] << 8)

  let at = start
  for (let n = 0; n < MAX_BLOCKS; n++) {
    if (at + BLOCK > 0x10000 || !written[at] || !written[at + BLOCK - 1])
      return `sample ${srcn}: runs into memory that was never uploaded`
    const header = aram[at]
    at += BLOCK
    if (header & 1) {
      const bytes = aram.slice(start, at)
      const loops = (header & 2) !== 0
      const offset = loop - start
      const loopOffset =
        loops && offset >= 0 && offset < bytes.length && offset % BLOCK === 0 ? offset : null
      if (loops && loopOffset === null) return `sample ${srcn}: loop point is outside the sample`
      return { srcn, start, bytes, loopOffset }
    }
  }
  return `sample ${srcn}: no end block`
}

/** AddmusicK's .brr files carry a two-byte little-endian loop offset before the BRR data. */
export function toAmkBrr(sample: BrrSample): Uint8Array {
  const out = new Uint8Array(sample.bytes.length + 2)
  const loop = sample.loopOffset ?? 0
  out[0] = loop & 0xff
  out[1] = loop >> 8
  out.set(sample.bytes, 2)
  return out
}
