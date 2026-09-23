/**
 * Find the sound-RAM uploads a ROM's code actually performs.
 *
 * Every SNES game sends data to the sound CPU through the IPL boot ROM's
 * block protocol, and N-SPC games keep that data in ROM in the shape SMW
 * does: `[size lo, size hi, dest lo, dest hi, bytes...]` blocks ended by a
 * zero size whose dest is the jump address (SPC700UploadLoop, SMWDisX
 * bank_00.asm; SpcBuilder.ts reads SMW's).
 *
 * The block format alone is too weak to scan for: arbitrary bytes parse as
 * chains often enough to swallow the real ones (measured on vanilla SMW:
 * 15 false chains, the driver at file $070000 hidden inside one). So a
 * chain counts only if its start address is LOADED by code: the three
 * immediate loads the caller uses to hand the uploader a 24-bit pointer
 * (SMW UploadSPCEngine, bank_00.asm, `LDA #lo : STA $00 : LDA #hi :
 * STA $01 : LDA #bank : STA $02`), or the 16-bit form of the same.
 */
import type { RomLayout } from './RomHeader'

export interface UploadBlock {
  dest: number
  /** File offset of the block's first data byte. */
  fileOffset: number
  size: number
}

export interface UploadChain {
  /** File offset of the first block header. */
  fileOffset: number
  /** The SNES address the code loads, as it appears in the operands. */
  snesAddress: number
  /** File offsets of the code that loads it. */
  referencedFrom: number[]
  blocks: UploadBlock[]
  /** Dest of the zero-size terminator: where the IPL jumps when this chain is the boot upload. */
  entry: number
  payload: number
}

const ARAM_SIZE = 0x10000
/** $F0-$FF are the sound CPU's I/O registers; no real upload writes them. */
const IO_START = 0xf0
const IO_END = 0x100

const LDA_IMM = 0xa9
const STA_DP = 0x85
const STA_ABS = 0x8d

export function parseChain(
  rom: Uint8Array,
  start: number,
): Omit<UploadChain, 'snesAddress' | 'referencedFrom'> | null {
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
    if (dest + size > ARAM_SIZE) return null
    if (dest < IO_END && dest + size > IO_START) return null
    if (at + 4 + size > rom.length) return null
    blocks.push({ dest, fileOffset: at + 4, size })
    payload += size
    at += 4 + size
  }
}

export function snesToFile(layout: RomLayout, snes: number): number | null {
  const bank = snes >> 16
  const addr = snes & 0xffff
  if (layout === 'lorom') {
    if (addr < 0x8000 || (bank & 0x7f) >= 0x7e) return null
    return (bank & 0x7f) * 0x8000 + (addr - 0x8000)
  }
  if (layout === 'hirom') {
    if (bank >= 0x7e && bank <= 0x7f) return null
    if ((bank & 0x7f) < 0x40 && addr < 0x8000) return null
    return (bank & 0x3f) * 0x10000 + addr
  }
  return null
}

/** A store of A to a direct-page or absolute address; returns [target, instruction length]. */
function storeAt(rom: Uint8Array, at: number): [number, number] | null {
  if (rom[at] === STA_DP) return [rom[at + 1], 2]
  if (rom[at] === STA_ABS) return [rom[at + 1] | (rom[at + 2] << 8), 3]
  return null
}

/**
 * Every 24-bit address handed over as `LDA #imm : STA x` for x, x+1, x+2
 * (8-bit A), or `LDA #imm16 : STA x` then `LDA #bank : STA x+2`, with at
 * most a few bytes of other code between the stores.
 */
export function findPointerLoads(rom: Uint8Array): Map<number, number[]> {
  const found = new Map<number, number[]>()
  const add = (snes: number, at: number) => {
    const list = found.get(snes) ?? []
    list.push(at)
    found.set(snes, list)
  }
  /** Next `LDA #imm : STA target` within `window` bytes of `from`, 8-bit immediate. */
  const nextLoad = (from: number, target: number, window: number): [number, number] | null => {
    for (let at = from; at < from + window && at + 4 < rom.length; at++) {
      if (rom[at] !== LDA_IMM) continue
      const s = storeAt(rom, at + 2)
      if (s && s[0] === target) return [rom[at + 1], at + 2 + s[1]]
    }
    return null
  }

  for (let at = 0; at + 6 < rom.length; at++) {
    if (rom[at] !== LDA_IMM) continue
    // 8-bit form.
    const s8 = storeAt(rom, at + 2)
    if (s8) {
      const hi = nextLoad(at + 2 + s8[1], s8[0] + 1, 8)
      const bank = hi && nextLoad(hi[1], s8[0] + 2, 8)
      if (hi && bank) add((bank[0] << 16) | (hi[0] << 8) | rom[at + 1], at)
    }
    // 16-bit form: the store follows a two-byte immediate.
    const s16 = storeAt(rom, at + 3)
    if (s16) {
      const bank = nextLoad(at + 3 + s16[1], s16[0] + 2, 8)
      if (bank) add((bank[0] << 16) | rom[at + 1] | (rom[at + 2] << 8), at)
    }
  }
  return found
}

export function findUploadChains(rom: Uint8Array, layout: RomLayout): UploadChain[] {
  const chains: UploadChain[] = []
  const byOffset = new Set<number>()
  for (const [snes, refs] of findPointerLoads(rom)) {
    const off = snesToFile(layout, snes)
    if (off === null || byOffset.has(off)) continue
    const chain = parseChain(rom, off)
    if (!chain) continue
    byOffset.add(off)
    chains.push({ ...chain, snesAddress: snes, referencedFrom: refs })
  }
  return chains.sort((a, b) => a.fileOffset - b.fileOffset)
}

/** Write a chain's blocks into a sound-RAM image. */
export function applyChain(rom: Uint8Array, chain: UploadChain, aram: Uint8Array): void {
  for (const b of chain.blocks) aram.set(rom.subarray(b.fileOffset, b.fileOffset + b.size), b.dest)
}

export function chainsOverlap(a: UploadChain, b: UploadChain): boolean {
  return a.blocks.some(x =>
    b.blocks.some(y => x.dest < y.dest + y.size && y.dest < x.dest + x.size),
  )
}
