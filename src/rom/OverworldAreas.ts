/**
 * The overworld areas the ROM can reach: a BFS from the new-game entry area
 * over the path transitions and the warps (en-gen/hackbench#364). Every
 * routine read is opcode-gated; a failed gate refuses with its address and
 * nothing falls back to the vanilla seven.
 */
import type { RomFile } from './RomFile'
import { WILD, findExactlyOneSite, type BytePattern } from './BytePattern'

export type OverworldAreaSet = { entry: number; areas: number[] } | { unavailable: string }

const A: BytePattern = [WILD, WILD]

/** PSwitch: CMP #area / STA OWPlayerSubmap / STA SaveDataBufferSubmap (bank_01.asm:13940-13946). */
// prettier-ignore
const PSWITCH: BytePattern = [
  0xbd, 0x64, 0x15, 0xc9, WILD, 0xd0, 0x0c, 0x8d, 0x11, 0x1f, 0x8d, 0xb8, 0x1f,
  0x9e, 0xc8, 0x14, 0xee, 0x26, 0x14, 0x60,
]

/** CODE_049A24 to the end of its loop (bank_04.asm:2835-2897); A = a table operand. */
// prettier-ignore
const PATH: BytePattern = [
  0xc2, 0x20, 0xad, 0xd6, 0x0d, 0x4a, 0x4a, 0xaa, 0xbd, 0x11, 0x1f, 0x29, 0xff, 0x00,
  0x8d, 0xc3, 0x13, 0xa9, WILD, 0x00, 0x85, 0x02, 0xa0, WILD,             // 18 counter, 23 LDY
  0xae, 0xd6, 0x0d, 0xbd, 0x19, 0x1f, 0xd9, ...A, 0xd0, 0x3e,
  0xbd, 0x17, 0x1f, 0xd9, ...A, 0xd0, 0x36,
  0xb9, ...A, 0x29, 0xff, 0x00, 0xcd, 0xc3, 0x13, 0xd0, 0x2b,             // 44 source area
  0xb9, ...A, 0x9d, 0x19, 0x1f, 0xb9, ...A, 0x9d, 0x17, 0x1f,
  0xb9, ...A, 0x29, 0xff, 0x00, 0x8d, 0xc3, 0x13,                         // 67 destination area
  0xa4, 0x02, 0xb9, ...A, 0x29, 0xff, 0x00, 0x9d, 0x21, 0x1f,
  0xb9, ...A, 0x29, 0xff, 0x00, 0x9d, 0x1f, 0x1f, 0x80, 0x0b,
  0xc6, 0x02, 0xc6, 0x02, 0x88, 0x88, 0x88, 0x88, 0x88, 0x10, 0xaf, 0xe2, 0x20,
]
const PATH_COUNTER = 18
const PATH_LDY = 23
const PATH_SRC_AREA = 44
const PATH_DST_AREA = 67
const PATH_STRIDE = 5

/** CODE_048509's scan of DATA_048431 (bank_04.asm:509-535), ending at STY StarWarpIndex. */
// prettier-ignore
const WARP_SCAN: BytePattern = [
  0xac, 0xb3, 0x0d, 0xb9, 0x11, 0x1f, 0x85, 0x01, 0x64, 0x00, 0xc2, 0x20, 0xae, 0xd6, 0x0d,
  0xa0, WILD,                                                             // 16 LDY
  0xb9, ...A, 0x45, 0x00, 0xc9, 0x00, 0x02, 0xb0, 0x0d, 0xdd, 0x1f, 0x1f, // 18 source word
  0xd0, 0x08, 0xbd, 0x21, 0x1f, 0xd9, ...A, 0xf0, 0x04, 0x88, 0x88, 0x10, 0xe5,
  0x8c, 0xf6, 0x1d,
]
const WARP_LDY = 16
const WARP_SRC_TABLE = 18

/** CODE_04853B's decode of DATA_04849D into CurrentSubmap (bank_04.asm:554-583). */
// prettier-ignore
const WARP_DEST: BytePattern = [
  0x8b, 0x4b, 0xab, 0xc2, 0x20, 0xae, 0xd6, 0x0d, 0xac, 0xf6, 0x1d,
  0xb9, ...A, 0x48, 0x29, 0xff, 0x01, 0x9d, 0x17, 0x1f, 0x4a, 0x4a, 0x4a, 0x4a, // 12 dest word
  0x9d, 0x1f, 0x1f, 0xb9, ...A, 0x9d, 0x19, 0x1f, 0x4a, 0x4a, 0x4a, 0x4a,
  0x9d, 0x21, 0x1f, 0x68, 0x4a, 0xeb, 0x29, 0x0f, 0x00, 0x8d, 0xc3, 0x13,
]
const WARP_DST_TABLE = 12

const hex = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0')

/** The one site of `p`, with the routine's address in the refusal. */
function site(rom: RomFile, p: BytePattern, what: string): number | string {
  const r = findExactlyOneSite(rom, p, what)
  return r.ok ? r.offset : r.reason
}

export function deriveOverworldAreas(rom: RomFile): OverworldAreaSet {
  const no = (unavailable: string): { unavailable: string } => ({ unavailable })
  const word = (at: number): number => rom.readAtFileOffset(at, 2)!.readUInt16LE(0)
  const byte = (at: number): number => rom.readAtFileOffset(at, 1)![0]!
  const span = (r: number, operandAt: number, n: number): Buffer | null => {
    const operand = word(r + operandAt)
    return operand < 0x8000 ? null : rom.readAtFileOffset((r & ~0x7fff) | (operand & 0x7fff), n)
  }

  const ps = site(rom, PSWITCH, 'PSwitch (SMWDisX bank_01.asm:13940, $01:E75B)')
  const path = site(rom, PATH, 'CODE_049A24, the path transitions (bank_04.asm:2835, $04:9A24)')
  const scan = site(rom, WARP_SCAN, 'CODE_048509, the warp scan (bank_04.asm:509, $04:8509)')
  const dest = site(rom, WARP_DEST, 'CODE_04853B, the warp destination (bank_04.asm:554, $04:853B)')
  for (const s of [ps, path, scan, dest]) if (typeof s === 'string') return no(s)
  const [psAt, pathAt, scanAt, destAt] = [ps, path, scan, dest] as number[]

  const entry = byte(psAt + 4)

  // 14 records: LDY #$41 walks 5-byte records and the counter #$1A steps 2 beside it.
  const y = byte(pathAt + PATH_LDY)
  const counter = byte(pathAt + PATH_COUNTER)
  if (y % PATH_STRIDE !== 0 || counter !== (y / PATH_STRIDE) * 2) {
    return no(
      `CODE_049A24 (bank_04.asm:2835) has LDY #$${hex(y)} and counter #$${hex(counter)}: ` +
        `not the same number of ${PATH_STRIDE}-byte records, so which are read is unknown.`,
    )
  }
  const records = y / PATH_STRIDE + 1
  const src = span(pathAt, PATH_SRC_AREA, y + 1)
  const dst = span(pathAt, PATH_DST_AREA, y + 1)

  // 27 warps: LDY #$34 walks 2-byte words down to 0 (BPL after DEY DEY).
  const wy = byte(scanAt + WARP_LDY)
  if (wy % 2 !== 0) return no(`CODE_048509 (bank_04.asm:509) has an odd LDY #$${hex(wy)}.`)
  const warps = wy / 2 + 1
  const wSrc = span(scanAt, WARP_SRC_TABLE, warps * 2)
  const wDst = span(destAt, WARP_DST_TABLE, warps * 2)

  if (!src || !dst || !wSrc || !wDst) {
    return no(
      'An overworld area table operand is not inside its own bank (bank_04.asm:2784, :509).',
    )
  }

  const edges = new Map<number, number[]>()
  const add = (from: number, to: number): void => {
    edges.set(from, [...(edges.get(from) ?? []), to])
  }
  for (let i = 0; i < records; i++) add(src[i * PATH_STRIDE]!, dst[i * PATH_STRIDE]!)
  // The scan matches a word's high byte to the submap; the decode reads bits 9-12.
  for (let i = 0; i < warps; i++) add(wSrc[i * 2 + 1]!, (wDst.readUInt16LE(i * 2) >> 9) & 0xf)

  const seen = new Set([entry])
  const queue = [entry]
  while (queue.length > 0) {
    for (const to of edges.get(queue.pop()!) ?? []) {
      if (seen.has(to)) continue
      seen.add(to)
      queue.push(to)
    }
  }
  return { entry, areas: [...seen].sort((p, q) => p - q) }
}
