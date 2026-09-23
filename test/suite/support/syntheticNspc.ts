/**
 * A synthetic N-SPC sound-RAM image: the code patterns NspcEngine reads,
 * shaped like SMW's (Earlier dialect), with no bytes taken from any ROM.
 * Tests place song data and patch individual patterns to plant defects.
 */
import type { SoundImage } from '../../../src/rom/nspc/SourceScan'
import { locateEngine } from '../../../src/rom/nspc/NspcEngine'

export const SYN = {
  songTable: 0x1000,
  instrTable: 0x3000,
  percTable: 0x3100,
  dir: 0x4000,
  lens: 0x2800,
  entry: 0x0500,
}

/** Command lengths for $DA-$F2 as SMW's VCmdLens lists them. */
export const EARLIER_LENS = [
  2, 2, 3, 4, 4, 1, 2, 3, 2, 3, 2, 4, 1, 2, 3, 4, 2, 4, 4, 1, 2, 4, 1, 4, 4,
]

export interface Synthetic {
  aram: Uint8Array
  written: Uint8Array
  put(at: number, bytes: number[]): void
  image(): SoundImage
}

export function syntheticEarlier(): Synthetic {
  const aram = new Uint8Array(0x10000)
  const written = new Uint8Array(0x10000)
  const put = (at: number, bytes: number[]) => {
    aram.set(bytes, at)
    written.fill(1, at, at + bytes.length)
  }
  const lo = (n: number) => n & 0xff
  const hi = (n: number) => n >> 8
  let code = 0x0500

  const emit = (bytes: number[]) => {
    put(code, bytes)
    code += bytes.length + 4
  }
  // Section pointer read through dp $40.
  emit([0x8d, 0x00, 0xf7, 0x40, 0x3a, 0x40, 0x2d, 0xf7, 0x40, 0x3a, 0x40, 0xfd, 0xae])
  // Song start: table is read at songTable (the operand is table-2, command n at +2n).
  const op = SYN.songTable
  emit([0x1c, 0xfd, 0xf6, lo(op), hi(op), 0xc4, 0x40, 0xf6, lo(op + 1), hi(op + 1), 0xc4, 0x41])
  // Instrument load (falls into MUL) and percussion (CALLs), 5 and 6 wide.
  emit([0x8d, 0x05, 0x8f, lo(SYN.instrTable), 0x14, 0x8f, hi(SYN.instrTable), 0x15, 0xcf])
  emit([0x8d, 0x06, 0x8f, lo(SYN.percTable), 0x14, 0x8f, hi(SYN.percTable), 0x15, 0x3f, 0x00, 0x00])
  // Readahead: CMP #$DA; BCC; PUSH Y; MOV Y,A; POP A; CLRC; ADC lens-$DA+Y.
  const lensOp = SYN.lens - 0xda
  emit([0x68, 0xda, 0x90, 0x0a, 0x6d, 0xfd, 0xae, 0x60, 0x96, lo(lensOp), hi(lensOp)])
  // Note layout: CMP #$D0; BCS; CMP #$C6; BCC.
  emit([0x68, 0xd0, 0xb0, 0x08, 0x68, 0xc6, 0x90, 0x04])
  // DIR: MOV $F2,#$5D; MOV $F3,#hi.
  emit([0x8f, 0x5d, 0xf2, 0x8f, hi(SYN.dir), 0xf3])
  // Init CONTROL write that clears the ports.
  emit([0xe8, 0xf0, 0xc5, 0xf1, 0x00])
  put(SYN.lens, EARLIER_LENS)

  return {
    aram,
    written,
    put,
    image() {
      const located = locateEngine(aram)
      if (!located.ok) throw new Error(located.reason)
      return { aram, written, engine: located.engine, entry: SYN.entry, label: 'synthetic' }
    },
  }
}

export function putSection(s: Synthetic, at: number, tracks: (number | null)[]) {
  const words = Array.from({ length: 8 }, (_, i) => tracks[i] ?? 0)
  s.put(
    at,
    words.flatMap(w => [w & 0xff, w >> 8]),
  )
}
