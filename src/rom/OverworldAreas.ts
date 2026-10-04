/**
 * The overworld areas the ROM names: the hub (0) plus the areas of every live
 * path-transition and warp record (en-gen/hackbench#364). A record is live when its
 * source area is inside the camera table (a $FF-filled slot is not); its destination
 * is then listed, marked invalid when the camera table cannot place it. Each routine
 * read is opcode-gated and so is the caller that makes it run; a failed gate
 * refuses with its address and nothing falls back to vanilla.
 *
 * The camera gate currently refuses most Lunar Magic edited ROMs: LM's `JSL $0F:FAB0` hook
 * replaces `STA $20; SEP #$20` there (#522). The table reads themselves are unchanged.
 *
 * Hack-fragility points, not checked:
 * - DATA_00A06B is taken to be followed immediately by DATA_00A079 (bank_00.asm:4242-4246),
 *   so their operand distance is the camera table length.
 * - CODE_048509 and CODE_049A24 read their tables with DB = their own bank; only
 *   CODE_04853B sets DB itself (PHK/PLB). The callers' own callers are not checked.
 */
import type { RomFile } from './RomFile'
import { WILD, findUnique, type BytePattern } from './BytePattern'
import { hex4 } from './hex'
import { loromToOffset } from './addressing'

export interface OverworldArea {
  area: number
  /** Why the camera table (DATA_00A06B/DATA_00A079) cannot place this area. */
  invalid?: string
  /** Signed camera position of the window over half 1 (DATA_00A06B / DATA_00A079, bank_00.asm:4242-4248),
   *  read at the gated camera operands; absent on an invalid area. */
  cameraX?: number
  cameraY?: number
}
export type OverworldAreaSet = { areas: OverworldArea[] } | { unavailable: string }

const A: BytePattern = [WILD, WILD]
const PATH_STRIDE = 5
const WARP_STRIDE = 2

interface Site {
  name: string
  pattern: BytePattern
}
// prettier-ignore
const SITES = {
  /** The camera read: X table then Y table, indexed by area*2 (bank_00.asm:4324-4333).
   *  Operands: X table at 5, Y table at 12. */
  camera: { name: 'the camera read (bank_00.asm:4324-4333)', pattern: [
    0x0a, 0xaa, 0xc2, 0x20, 0xbd, ...A, 0x85, 0x1a, 0x85, 0x1e, 0xbd, ...A, 0x85, 0x1c, 0x85, 0x20,
    0xe2, 0x20,
  ] },
  /** CODE_049A24 to the end of its loop (bank_04.asm:2835-2885). Operands: counter 18, LDY 23,
   *  source area table 44, destination area table 67. */
  path: { name: 'CODE_049A24, the path transitions (bank_04.asm:2835, $04:9A24)', pattern: [
    0xc2, 0x20, 0xad, 0xd6, 0x0d, 0x4a, 0x4a, 0xaa, 0xbd, 0x11, 0x1f, 0x29, 0xff, 0x00,
    0x8d, 0xc3, 0x13, 0xa9, WILD, 0x00, 0x85, 0x02, 0xa0, WILD,
    0xae, 0xd6, 0x0d, 0xbd, 0x19, 0x1f, 0xd9, ...A, 0xd0, 0x3e,
    0xbd, 0x17, 0x1f, 0xd9, ...A, 0xd0, 0x36,
    0xb9, ...A, 0x29, 0xff, 0x00, 0xcd, 0xc3, 0x13, 0xd0, 0x2b,
    0xb9, ...A, 0x9d, 0x19, 0x1f, 0xb9, ...A, 0x9d, 0x17, 0x1f,
    0xb9, ...A, 0x29, 0xff, 0x00, 0x8d, 0xc3, 0x13,
    0xa4, 0x02, 0xb9, ...A, 0x29, 0xff, 0x00, 0x9d, 0x21, 0x1f,
    0xb9, ...A, 0x29, 0xff, 0x00, 0x9d, 0x1f, 0x1f, 0x80, 0x0b,
    0xc6, 0x02, 0xc6, 0x02, 0x88, 0x88, 0x88, 0x88, 0x88, 0x10, 0xaf, 0xe2, 0x20,
  ] },
  /** CODE_048509's scan of DATA_048431, ending at STY StarWarpIndex (bank_04.asm:527-550).
   *  Operands: LDY 16, source word table 18. */
  scan: { name: 'CODE_048509, the warp scan (bank_04.asm:527, $04:8509)', pattern: [
    0xac, 0xb3, 0x0d, 0xb9, 0x11, 0x1f, 0x85, 0x01, 0x64, 0x00, 0xc2, 0x20, 0xae, 0xd6, 0x0d,
    0xa0, WILD,
    0xb9, ...A, 0x45, 0x00, 0xc9, 0x00, 0x02, 0xb0, 0x0d, 0xdd, 0x1f, 0x1f,
    0xd0, 0x08, 0xbd, 0x21, 0x1f, 0xd9, ...A, 0xf0, 0x04, 0x88, 0x88, 0x10, 0xe5,
    0x8c, 0xf6, 0x1d,
  ] },
  /** CODE_04853B's decode of DATA_04849D into CurrentSubmap (bank_04.asm:554-581).
   *  Operand: destination word table 12. */
  dest: { name: 'CODE_04853B, the warp destination (bank_04.asm:554, $04:853B)', pattern: [
    0x8b, 0x4b, 0xab, 0xc2, 0x20, 0xae, 0xd6, 0x0d, 0xac, 0xf6, 0x1d,
    0xb9, ...A, 0x48, 0x29, 0xff, 0x01, 0x9d, 0x17, 0x1f, 0x4a, 0x4a, 0x4a, 0x4a,
    0x9d, 0x1f, 0x1f, 0xb9, ...A, 0x9d, 0x19, 0x1f, 0x4a, 0x4a, 0x4a, 0x4a,
    0x9d, 0x21, 0x1f, 0x68, 0x4a, 0xeb, 0x29, 0x0f, 0x00, 0x8d, 0xc3, 0x13,
  ] },
} satisfies Record<string, Site>
type Name = keyof typeof SITES

/** Each routine's caller: its call target must be the site the routine was found at. */
// prettier-ignore
const CALLERS: { what: string; call: BytePattern; at: number; long?: true; to: Name }[] = [
  { what: 'JSL CODE_04853B in GM0CLoadOverworld (bank_00.asm:4252-4255)', to: 'dest', at: 6, long: true,
    call: [0xad, 0x9c, 0x1b, 0xf0, 0x04, 0x22, ...A, WILD, 0x20, 0xa6, 0xa1] },
  { what: 'JSR CODE_049A24 (bank_04.asm:2356-2361)', to: 'path', at: 7,
    call: [0xdd, 0x26, 0x94, 0xd0, 0x2a, 0x5a, 0x20, ...A, 0x7a, 0xa9, 0x01] },
  { what: 'JSR CODE_048509 on the star tile (bank_04.asm:1753-1757)', to: 'scan', at: 5,
    call: [0xc9, 0x5f, 0xd0, 0x18, 0x20, ...A, 0xd0, 0x2e, 0x9c, 0xf7, 0x1d] },
  { what: 'JSR CODE_048509 on the pipe tile (bank_04.asm:1770-1774)', to: 'scan', at: 5,
    call: [0xc9, 0x5b, 0xd0, 0x11, 0x20, ...A, 0xd0, 0x0b, 0xee, 0x9c, 0x1b] },
]

/** Cart offset an operand names in the bank of `bankOf` (a cart offset in that bank), or null
 *  when the operand is not a LoROM bank-local address. */
const bankLocal = (bankOf: number, operand: number): number | null =>
  operand < 0x8000 ? null : (bankOf & ~0x7fff) | (operand & 0x7fff)

export function deriveOverworldAreas(rom: RomFile): OverworldAreaSet {
  const no = (unavailable: string): { unavailable: string } => ({ unavailable })
  const read = (at: number, n: number): Buffer => rom.readAtFileOffset(at, n)!
  const u8 = (at: number): number => read(at, 1)[0]!
  const u16 = (at: number): number => read(at, 2).readUInt16LE(0)
  /** `n` bytes at an operand, in the bank of the code that reads it. */
  const table = (code: number, operand: number, n: number): Buffer | null => {
    const at = bankLocal(code, operand)
    return at === null || operand + n > 0x10000 ? null : rom.readAtFileOffset(at, n)
  }

  const at = {} as Record<Name, number>
  for (const k of Object.keys(SITES) as Name[]) {
    const found = findUnique(rom, SITES[k].pattern)
    if (found === null) return no(`${SITES[k].name} is not stock: absent or not unique.`)
    at[k] = found
  }
  for (const c of CALLERS) {
    const call = findUnique(rom, c.call)
    const op = call === null ? 0 : u16(call + c.at)
    // A JSL target is a full address ($84 mirrors $04); a JSR stays in the caller's bank.
    const target =
      call === null
        ? null
        : c.long
          ? loromToOffset((u8(call + c.at + 2) << 16) | op, rom.romSize)
          : bankLocal(call, op)
    if (call === null || target !== at[c.to]) {
      return no(
        `${c.what} does not call ${SITES[c.to].name}, so it is not reached through stock code.`,
      )
    }
  }

  // The camera tables are adjacent (bank_00.asm:4242-4246), so their distance is the length.
  const cameraX = u16(at.camera + 5)
  const cameraY = u16(at.camera + 12)
  if (cameraX < 0x8000 || cameraY <= cameraX || (cameraY - cameraX) % 2 !== 0) {
    return no(`${SITES.camera.name} reads two tables that are not an even distance apart.`)
  }
  const cameraCount = (cameraY - cameraX) / 2
  const camX = table(at.camera, cameraX, cameraCount * 2)
  const camY = table(at.camera, cameraY, cameraCount * 2)
  if (!camX || !camY) {
    return no(`${SITES.camera.name} reads a table that runs past the end of its bank.`)
  }

  // Each loop starts at `LDY #n` and drops one record while Y stays below $80 (BPL).
  const ldy = (site: number, stride: number): number | null => {
    const y = u8(site)
    return y % stride !== 0 || y - stride > 0x7f ? null : y
  }
  const y = ldy(at.path + 23, PATH_STRIDE)
  const wy = ldy(at.scan + 16, WARP_STRIDE)
  if (y === null || wy === null || u8(at.path + 18) !== (y / PATH_STRIDE) * 2) {
    return no(
      `${SITES.path.name} or ${SITES.scan.name} has a record count that does not match its stride.`,
    )
  }
  const records = y / PATH_STRIDE + 1
  const warps = wy / WARP_STRIDE + 1
  const src = table(at.path, u16(at.path + 44), y + 1)
  const dst = table(at.path, u16(at.path + 67), y + 1)
  const wSrc = table(at.scan, u16(at.scan + 18), warps * 2)
  const wDst = table(at.dest, u16(at.dest + 12), warps * 2)
  if (!src || !dst || !wSrc || !wDst) {
    return no(
      'A path or warp table is outside its bank (DATA_049968, DATA_0499AE, DATA_048431, DATA_04849D).',
    )
  }

  // The camera read's ASL runs with 8-bit A (bank_00.asm:4324), so the index is (area*2) & $FF.
  const valid = (a: number): boolean => a < cameraCount && a < 0x80
  const seen = new Map<number, string | undefined>([[0, undefined]])
  const list = (area: number, label?: string): void => {
    if (seen.has(area)) return
    const tail =
      area < cameraCount
        ? `where the camera index (area*2) & $FF wraps`
        : `past the camera table's ${cameraCount} entries (DATA_00A06B at $${hex4(cameraX)}, DATA_00A079 at $${hex4(cameraY)})`
    seen.set(
      area,
      valid(area) ? undefined : `${label ?? 'A record'} leads to area ${area}, ${tail}.`,
    )
  }
  const record = (label: string, from: number, to: number): void => {
    if (!valid(from)) return
    list(from)
    list(to, label)
  }
  for (let i = 0; i < records; i++) {
    record(`path record ${i}`, src[i * PATH_STRIDE]!, dst[i * PATH_STRIDE]!)
  }
  // The scan matches a word's high byte to the submap; the decode reads bits 9-12.
  for (let i = 0; i < warps; i++) {
    record(`warp record ${i}`, wSrc[i * 2 + 1]!, (wDst.readUInt16LE(i * 2) >> 9) & 0xf)
  }
  const areas = [...seen]
    .sort(([p], [q]) => p - q)
    .map(([area, invalid]) => ({
      area,
      ...(invalid
        ? { invalid }
        : { cameraX: camX.readInt16LE(area * 2), cameraY: camY.readInt16LE(area * 2) }),
    }))
  return { areas }
}
