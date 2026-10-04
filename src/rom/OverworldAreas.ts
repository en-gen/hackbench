/**
 * The overworld areas the ROM can reach: a BFS from the new-game entry area
 * over the path transitions and the warps (en-gen/hackbench#364). Every
 * routine read is opcode-gated and so is each caller that makes it run; a
 * failed gate refuses with its address and nothing falls back to vanilla.
 *
 * Hack-fragility points, not checked: that EnterFileSelect (bank_00.asm:3388)
 * is reached, that InitSaveData runs the copy loop in full, and that the
 * callers' own callers do.
 */
import type { RomFile } from './RomFile'
import { WILD, findUnique, type BytePattern } from './BytePattern'
import { hex2, hex4 } from './hex'
import { SPRITE_MAIN_PTR_ADDR } from './SpritePriorityLoader'

export interface OverworldArea {
  area: number
  /** Why the camera table (DATA_00A06B/DATA_00A079) cannot place this area. */
  invalid?: string
}
export type OverworldAreaSet = { entry: number; areas: OverworldArea[] } | { unavailable: string }

const A: BytePattern = [WILD, WILD]
const MSGBOX_SPRITE = 0x19

/** Sprite $19's handler, the intro message box (bank_01.asm:923; the disassembly labels it
 *  PSwitch, bank_01.asm:13939-13947): CMP #t is a timer threshold, and A equals it when the
 *  STAs to OWPlayerSubmap and SaveDataBufferSubmap run, so it is also the area written. */
// prettier-ignore
const MSGBOX: BytePattern = [
  0xbd, 0x64, 0x15, 0xc9, WILD, 0xd0, 0x0c, 0x8d, 0x11, 0x1f, 0x8d, 0xb8, 0x1f,
  0x9e, 0xc8, 0x14, 0xee, 0x26, 0x14, 0x60,
]
/** InitSaveData's copy of InitPlayerOverworldData into SaveDataBufferSubmap (bank_00.asm:3886-3892). */
const INIT_LOOP: BytePattern = [0xa2, 0x15, 0xbd, ...A, 0x9d, 0xb8, 0x1f, 0xca, 0x10, 0xf7, 0x60]
/** EnterFileSelect: LDA #intro / STA OverworldOverride / JSR InitSaveData (bank_00.asm:3389-3391). */
const INTRO: BytePattern = [0xa9, WILD, 0x8d, 0x09, 0x01, 0x20, ...A]
/** The camera read: X table then Y table, indexed by area*2 (bank_00.asm:4324-4333). */
// prettier-ignore
const CAMERA: BytePattern = [
  0x0a, 0xaa, 0xc2, 0x20, 0xbd, ...A, 0x85, 0x1a, 0x85, 0x1e, 0xbd, ...A, 0x85, 0x1c, 0x85, 0x20,
  0xe2, 0x20,
]
/** CODE_049A24 to the end of its loop (bank_04.asm:2835-2885); A = a table operand. */
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
/** CODE_048509's scan of DATA_048431 (bank_04.asm:527-550), ending at STY StarWarpIndex. */
// prettier-ignore
const WARP_SCAN: BytePattern = [
  0xac, 0xb3, 0x0d, 0xb9, 0x11, 0x1f, 0x85, 0x01, 0x64, 0x00, 0xc2, 0x20, 0xae, 0xd6, 0x0d,
  0xa0, WILD,                                                             // 16 LDY
  0xb9, ...A, 0x45, 0x00, 0xc9, 0x00, 0x02, 0xb0, 0x0d, 0xdd, 0x1f, 0x1f, // 18 source word
  0xd0, 0x08, 0xbd, 0x21, 0x1f, 0xd9, ...A, 0xf0, 0x04, 0x88, 0x88, 0x10, 0xe5,
  0x8c, 0xf6, 0x1d,
]
/** CODE_04853B's decode of DATA_04849D into CurrentSubmap (bank_04.asm:554-581). */
// prettier-ignore
const WARP_DEST: BytePattern = [
  0x8b, 0x4b, 0xab, 0xc2, 0x20, 0xae, 0xd6, 0x0d, 0xac, 0xf6, 0x1d,
  0xb9, ...A, 0x48, 0x29, 0xff, 0x01, 0x9d, 0x17, 0x1f, 0x4a, 0x4a, 0x4a, 0x4a, // 12 dest word
  0x9d, 0x1f, 0x1f, 0xb9, ...A, 0x9d, 0x19, 0x1f, 0x4a, 0x4a, 0x4a, 0x4a,
  0x9d, 0x21, 0x1f, 0x68, 0x4a, 0xeb, 0x29, 0x0f, 0x00, 0x8d, 0xc3, 0x13,
]
/** Operand offsets inside the patterns above. */
const PATH_COUNTER = 18
const PATH_LDY = 23
const PATH_SRC = 44
const PATH_DST = 67
const WARP_LDY = 16
const WARP_SRC = 18
const WARP_DST_AT = 12
const PATH_STRIDE = 5
const WARP_STRIDE = 2

const NAMES = {
  msgbox: 'the intro message-box sprite $19 start-area write (bank_01.asm:13939, $01:E75B)',
  init: "InitSaveData's copy loop (bank_00.asm:3886-3892)",
  intro: 'EnterFileSelect (bank_00.asm:3388-3391)',
  camera: 'camera read (bank_00.asm:4324-4333)',
  path: 'CODE_049A24, the path transitions (bank_04.asm:2835, $04:9A24)',
  scan: 'CODE_048509, the warp scan (bank_04.asm:527, $04:8509)',
  dest: 'CODE_04853B, the warp destination (bank_04.asm:554, $04:853B)',
}
type Site = keyof typeof NAMES
const PATTERNS: Record<Site, BytePattern> = {
  msgbox: MSGBOX,
  init: INIT_LOOP,
  intro: INTRO,
  camera: CAMERA,
  path: PATH,
  scan: WARP_SCAN,
  dest: WARP_DEST,
}

/** Each routine's caller: its call target must be the site the routine was found at. */
// prettier-ignore
const CALLERS: { what: string; call: BytePattern; at: number; long?: true; to: Site }[] = [
  { what: 'JSL CODE_04853B in GM0CLoadOverworld (bank_00.asm:4252-4255)', to: 'dest', at: 6, long: true,
    call: [0xad, 0x9c, 0x1b, 0xf0, 0x04, 0x22, ...A, WILD, 0x20, 0xa6, 0xa1] },
  { what: 'JSR CODE_049A24 (bank_04.asm:2356-2361)', to: 'path', at: 7,
    call: [0xdd, 0x26, 0x94, 0xd0, 0x2a, 0x5a, 0x20, ...A, 0x7a, 0xa9, 0x01] },
  { what: 'JSR CODE_048509 on the star tile (bank_04.asm:1753-1757)', to: 'scan', at: 5,
    call: [0xc9, 0x5f, 0xd0, 0x18, 0x20, ...A, 0xd0, 0x2e, 0x9c, 0xf7, 0x1d] },
  { what: 'JSR CODE_048509 on the pipe tile (bank_04.asm:1770-1774)', to: 'scan', at: 5,
    call: [0xc9, 0x5b, 0xd0, 0x11, 0x20, ...A, 0xd0, 0x0b, 0xee, 0x9c, 0x1b] },
]

export function deriveOverworldAreas(rom: RomFile): OverworldAreaSet {
  const no = (unavailable: string): { unavailable: string } => ({ unavailable })
  const read = (at: number, n: number): Buffer => rom.readAtFileOffset(at, n)!
  const u8 = (at: number): number => read(at, 1)[0]!
  const u16 = (at: number): number => read(at, 2).readUInt16LE(0)
  /** `n` bytes at an operand, in the bank of the code that reads it. */
  const table = (code: number, operand: number, n: number): Buffer | null =>
    operand < 0x8000 || operand + n > 0x10000
      ? null
      : rom.readAtFileOffset((code & ~0x7fff) | (operand & 0x7fff), n)

  const at = {} as Record<Site, number | null>
  for (const k of Object.keys(PATTERNS) as Site[]) at[k] = findUnique(rom, PATTERNS[k])
  // The sprite $19 handler matters only when the intro runs, and the camera read only to
  // mark areas, so both are judged below, after the entry.
  for (const k of Object.keys(NAMES) as Site[]) {
    if (at[k] === null && k !== 'msgbox' && k !== 'camera')
      return no(`${NAMES[k]} is not stock: absent or not unique.`)
  }
  const [init, intro, path, scan, dest] = [at.init!, at.intro!, at.path!, at.scan!, at.dest!]

  for (const c of CALLERS) {
    const call = findUnique(rom, c.call)
    const op = call === null ? 0 : u16(call + c.at)
    const bank = call === null ? 0 : c.long ? u8(call + c.at + 2) << 15 : call & ~0x7fff
    if (call === null || op < 0x8000 || (bank | (op & 0x7fff)) !== at[c.to]) {
      return no(`${c.what} does not call ${NAMES[c.to]}, so it is not reached through stock code.`)
    }
  }

  // The start area: InitSaveData copies InitPlayerOverworldData[0] to SaveDataBufferSubmap.
  const first = table(init, u16(init + 3), 1)
  if (!first) return no(`${NAMES.init} reads a table outside its bank.`)
  const entry = first[0]!

  // The intro level's P-switch writes the area again, when the intro runs.
  if (u8(intro + 1) !== 0) {
    const ptr = u16(0x8000 + (SPRITE_MAIN_PTR_ADDR & 0x7fff) + MSGBOX_SPRITE * 2)
    if (at.msgbox === null || ptr < 0x8000 || 0x8000 + (ptr & 0x7fff) !== at.msgbox) {
      return no(`The intro runs, but ${NAMES.msgbox} is not the code sprite $19 runs.`)
    }
    const written = u8(at.msgbox + 4)
    if (written !== entry) {
      return no(
        `The sprite $19 handler writes area $${hex2(written)}, InitPlayerOverworldData holds $${hex2(entry)}.`,
      )
    }
  }

  // The camera tables are adjacent (bank_00.asm:4242-4246), so their distance is the length.
  const camera = at.camera
  if (camera === null) return no(`The ${NAMES.camera} is not stock: absent or not unique.`)
  const cameraX = u16(camera + 5)
  const cameraY = u16(camera + 12)
  if (cameraX < 0x8000 || cameraY <= cameraX || (cameraY - cameraX) % 2 !== 0) {
    return no(`${NAMES.camera} reads two tables that are not an even distance apart.`)
  }
  const cameraCount = (cameraY - cameraX) / 2

  // Each loop starts at `LDY #n` and drops one record while Y stays below $80 (BPL).
  const ldy = (site: number, stride: number): number | null => {
    const y = u8(site)
    return y % stride !== 0 || y - stride > 0x7f ? null : y
  }
  const y = ldy(path + PATH_LDY, PATH_STRIDE)
  const wy = ldy(scan + WARP_LDY, WARP_STRIDE)
  if (y === null || wy === null || u8(path + PATH_COUNTER) !== (y / PATH_STRIDE) * 2) {
    return no(`${NAMES.path} or ${NAMES.scan} has a record count that does not match its stride.`)
  }
  const records = y / PATH_STRIDE + 1
  const warps = wy / WARP_STRIDE + 1
  const src = table(path, u16(path + PATH_SRC), y + 1)
  const dst = table(path, u16(path + PATH_DST), y + 1)
  const wSrc = table(scan, u16(scan + WARP_SRC), warps * 2)
  const wDst = table(dest, u16(dest + WARP_DST_AT), warps * 2)
  if (!src || !dst || !wSrc || !wDst) {
    return no('A path or warp table is outside its bank (bank_04.asm:2784, :491, :509).')
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
  const areas = [...seen]
    .sort((p, q) => p - q)
    .map(area => ({
      area,
      ...(area >= cameraCount && {
        invalid: `Area ${area} is past the camera table's ${cameraCount} entries (DATA_00A06B at $${hex4(cameraX)}, DATA_00A079 at $${hex4(cameraY)}).`,
      }),
    }))
  return { entry, areas }
}
