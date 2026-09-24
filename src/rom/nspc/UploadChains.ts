/**
 * Sound-RAM upload chains, located by what they contain.
 *
 * Every SNES game sends data to the sound CPU through the IPL boot ROM's
 * block protocol, and N-SPC games keep that data in ROM in the shape SMW
 * does: `[size lo, size hi, dest lo, dest hi, bytes...]` blocks ended by a
 * zero size whose dest is the jump address (SPC700UploadLoop, SMWDisX
 * bank_00.asm; SpcBuilder.ts reads SMW's).
 *
 * The format alone is too weak to scan for: arbitrary bytes parse as chains
 * often enough to swallow the real ones (vanilla SMW: 15 false chains, the
 * driver hidden inside one). Following the pointers the game's code hands
 * its uploader was tried next and found nothing on 510 of 729 US ROMs,
 * because every game builds that pointer its own way. So a chain is chosen
 * by CONTENT: the block that holds the driver's code, and the blocks that
 * write the addresses the located driver reads from. SourceScan then keeps
 * only candidates whose contents parse as songs or samples.
 *
 * Chains are contiguous in the file on LoROM and HiROM alike (the uploader
 * advances bank by bank), so this needs no address mapping.
 */

export interface UploadBlock {
  dest: number
  /** File offset of the block's first data byte. */
  fileOffset: number
  size: number
}

export interface UploadChain {
  /** File offset of the first block header. */
  fileOffset: number
  blocks: UploadBlock[]
  /** Dest of the zero-size terminator: where the IPL jumps when this chain is the boot upload. */
  entry: number
  payload: number
}

const ARAM_SIZE = 0x10000
/** $F0-$FF are the sound CPU's I/O registers; no real upload writes them. */
const IO_START = 0xf0
const IO_END = 0x100

function blockOk(size: number, dest: number): boolean {
  if (dest + size > ARAM_SIZE) return false
  return !(dest < IO_END && dest + size > IO_START)
}

export function parseChain(rom: Uint8Array, start: number): UploadChain | null {
  const blocks: UploadBlock[] = []
  let at = start
  let payload = 0
  for (;;) {
    if (at < 0 || at + 4 > rom.length) return null
    const size = rom[at] | (rom[at + 1] << 8)
    const dest = rom[at + 2] | (rom[at + 3] << 8)
    if (size === 0) {
      if (blocks.length === 0) return null
      return { fileOffset: start, blocks, entry: dest, payload }
    }
    if (!blockOk(size, dest) || at + 4 + size > rom.length) return null
    blocks.push({ dest, fileOffset: at + 4, size })
    payload += size
    at += 4 + size
  }
}

/**
 * Every file offset where a well-formed chain of at least one block starts,
 * computed back to front in one pass: a block is valid when the header after
 * it starts a valid chain or is a terminator.
 */
export function indexChainStarts(rom: Uint8Array): Uint8Array {
  // 1 = terminator, 2 = block starting a valid chain.
  const kind = new Uint8Array(rom.length)
  for (let at = rom.length - 4; at >= 0; at--) {
    const size = rom[at] | (rom[at + 1] << 8)
    if (size === 0) {
      kind[at] = 1
      continue
    }
    const dest = rom[at + 2] | (rom[at + 3] << 8)
    const next = at + 4 + size
    if (next + 4 <= rom.length && blockOk(size, dest) && kind[next] !== 0) kind[at] = 2
  }
  return kind
}

/** Chain starts whose FIRST block writes every address in [from, to). */
export function chainsWriting(
  rom: Uint8Array,
  starts: Uint8Array,
  from: number,
  to: number,
): number[] {
  const found: number[] = []
  for (let at = 0; at + 4 <= rom.length; at++) {
    if (starts[at] !== 2) continue
    const dest = rom[at + 2] | (rom[at + 3] << 8)
    const size = rom[at] | (rom[at + 1] << 8)
    if (dest <= from && to <= dest + size) found.push(at)
  }
  return found
}

/** Chain starts whose first block holds the file offset `inside`. */
export function chainsHolding(rom: Uint8Array, starts: Uint8Array, inside: number): number[] {
  const found: number[] = []
  for (let at = Math.max(0, inside - ARAM_SIZE - 4); at < inside; at++) {
    if (starts[at] !== 2) continue
    const size = rom[at] | (rom[at + 1] << 8)
    if (inside >= at + 4 && inside < at + 4 + size) found.push(at)
  }
  return found
}

/** Write a chain's blocks into a sound-RAM image. */
export function applyChain(rom: Uint8Array, chain: UploadChain, aram: Uint8Array): void {
  for (const b of chain.blocks) aram.set(rom.subarray(b.fileOffset, b.fileOffset + b.size), b.dest)
}
