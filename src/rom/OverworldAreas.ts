/**
 * The overworld areas the ROM names: the hub (0) plus the areas of every live
 * path-transition and warp record (en-gen/hackbench#364). A record is live when its
 * source area is inside the camera table (a $FF-filled slot is not); its destination
 * is then listed, marked invalid when the camera table cannot place it. Each routine
 * read is fingerprint-gated (SHA-256, operands masked) and so is the caller that makes it run, the
 * routine being found where that caller calls; a failed gate
 * refuses with its address and nothing falls back to vanilla.
 *
 * The camera gate currently refuses most Lunar Magic edited ROMs: LM's `JSL $0F:FAB0` hook
 * replaces `STA $20; SEP #$20` there (#522). The table reads themselves are unchanged.
 *
 * Hack-fragility points, not checked:
 * - DATA_00A06B is taken to be followed immediately by DATA_00A079 (bank_00.asm:4242-4246),
 *   so their operand distance is the camera table length.
 * - Only the four listed callers (CALLERS) are followed to a routine; any other caller of a
 *   moved copy is not checked.
 * - CODE_048509 and CODE_049A24 read their tables with DB = their own bank; only
 *   CODE_04853B sets DB itself (PHK/PLB). The callers' own callers are not checked.
 */
import type { RomFile } from './RomFile'
import { findPattern } from './BytePattern'
import { spanFingerprint } from './SubmapFlagGate'
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

const PATH_STRIDE = 5
const WARP_STRIDE = 2

/**
 * A recognized span, by fingerprint rather than by its bytes (docs/testing.md "Legal position":
 * no ROM slices in commits). `mask` lists the operand offsets zeroed before hashing; the code
 * reads the ones that matter itself. `anchor` is the span's first two bytes, only a speed
 * filter for the scan: the SHA-256 decides. A moved routine still matches wherever it sits.
 */
interface Span {
  name: string
  length: number
  mask: readonly number[]
  anchor: readonly [number, number]
  fingerprints: readonly string[]
}
// prettier-ignore
const SPANS = {
  /** The camera read: X table then Y table, indexed by area*2 (bank_00.asm:4324-4333).
   *  Operands: X table at 5, Y table at 12. Found by scan: nothing calls it. */
  camera: { name: 'the camera read (bank_00.asm:4324-4333)', length: 20, mask: [5, 6, 12, 13], anchor: [0x0a, 0xaa], fingerprints: ['45e288664c2af7f49afd158c374869224acf3ab5fbff1183be5288682715726f'] },
  /** CODE_049A24 to the end of its loop (bank_04.asm:2835-2885). Operands: counter 18, LDY 23,
   *  source area table 44, destination area table 67; the rest are ignored table addresses. */
  path: { name: 'CODE_049A24, the path transitions (bank_04.asm:2835, $04:9A24)', length: 110, mask: [18, 23, 31, 32, 39, 40, 44, 45, 55, 56, 61, 62, 67, 68, 78, 79, 87, 88], anchor: [0xc2, 0x20], fingerprints: ['d26f51c1fa40605fe0621e4109e2f92b55c42d2719a29e014a9888dfafa6bbeb'] },
  /** CODE_048509's scan of DATA_048431, ending at STY StarWarpIndex (bank_04.asm:527-550).
   *  Operands: LDY 16, source word table 18. */
  scan: { name: 'CODE_048509, the warp scan (bank_04.asm:527, $04:8509)', length: 47, mask: [16, 18, 19, 36, 37], anchor: [0xac, 0xb3], fingerprints: ['37a1f3b40432191c88d42b886f0e63c37a37bd7b8f71a32ebce33f6a2a67396f'] },
  /** CODE_04853B's decode of DATA_04849D into CurrentSubmap (bank_04.asm:554-581).
   *  Operand: destination word table 12. */
  dest: { name: 'CODE_04853B, the warp destination (bank_04.asm:554, $04:853B)', length: 50, mask: [12, 13, 29, 30], anchor: [0x8b, 0x4b], fingerprints: ['bfab0d7cefabefcf270b71855026a0db935c8445c9d2cfa0f4d26ba9428eb08f'] },
  jsl: { name: 'JSL CODE_04853B in GM0CLoadOverworld (bank_00.asm:4252-4255)', length: 12, mask: [6, 7, 8], anchor: [0xad, 0x9c], fingerprints: ['93777e3774b19af08653e2ca97886dca96906e82e3c04c22b530013240fad5a7'] },
  jsrPath: { name: 'JSR CODE_049A24 (bank_04.asm:2356-2361)', length: 12, mask: [7, 8], anchor: [0xdd, 0x26], fingerprints: ['baebf498dd0997c2caf5c5ddba1f87e3be7bf81dd7173ac5fb820c2335a42f9f'] },
  jsrStar: { name: 'JSR CODE_048509 on the star tile (bank_04.asm:1753-1757)', length: 12, mask: [5, 6], anchor: [0xc9, 0x5f], fingerprints: ['988a4d2d8e4309cf5254512eaf32b06914fc45eae3d0216ad2e639241a46c3e5'] },
  jsrPipe: { name: 'JSR CODE_048509 on the pipe tile (bank_04.asm:1770-1774)', length: 12, mask: [5, 6], anchor: [0xc9, 0x5b], fingerprints: ['fa4f9548c9d907effdd11909eaee37cf6e3ba9014f7488a37da62bcfd34b4280'] },
} satisfies Record<string, Span>
type Name = keyof typeof SPANS
/** Recognized fingerprints per span; a synthetic ROM passes its own (code that is not the cart's). */
export type AreaFingerprints = Record<Name, readonly string[]>
export const AREA_FINGERPRINTS = Object.fromEntries(
  Object.entries(SPANS).map(([k, v]) => [k, v.fingerprints]),
) as unknown as AreaFingerprints
/** Span geometry, for a test that plants its own code at the same operand offsets. */
export const AREA_SPANS: Readonly<Record<Name, Pick<Span, 'length' | 'mask' | 'anchor'>>> = SPANS

/** Each routine's caller, the operand offset of its call target, and the routine it must reach. */
const CALLERS: { caller: Name; at: number; long?: true; to: Name }[] = [
  { caller: 'jsl', to: 'dest', at: 6, long: true },
  { caller: 'jsrPath', to: 'path', at: 7 },
  { caller: 'jsrStar', to: 'scan', at: 5 },
  { caller: 'jsrPipe', to: 'scan', at: 5 },
]

/** Cart offsets whose span hashes (operands masked) to a recognized fingerprint, at most 2. */
function findSpan(rom: RomFile, n: Name, fps: AreaFingerprints): number[] {
  const s: Span = SPANS[n]
  const hits: number[] = []
  for (const at of findPattern(rom, s.anchor)) {
    if (!fps[n].includes(spanFingerprint(rom.readAtFileOffset(at, s.length), s.mask) ?? ''))
      continue
    hits.push(at)
    if (hits.length > 1) break
  }
  return hits
}

/** Cart offset an operand names in the bank of `bankOf` (a cart offset in that bank), or null
 *  when the operand is not a LoROM bank-local address. */
const bankLocal = (bankOf: number, operand: number): number | null =>
  operand < 0x8000 ? null : (bankOf & ~0x7fff) | (operand & 0x7fff)

export function deriveOverworldAreas(
  rom: RomFile,
  fps: AreaFingerprints = AREA_FINGERPRINTS,
): OverworldAreaSet {
  const no = (unavailable: string): { unavailable: string } => ({ unavailable })
  const read = (at: number, n: number): Buffer => rom.readAtFileOffset(at, n)!
  const u8 = (at: number): number => read(at, 1)[0]!
  const u16 = (at: number): number => read(at, 2).readUInt16LE(0)
  /** `n` bytes at an operand, in the bank of the code that reads it. */
  const table = (code: number, operand: number, n: number): Buffer | null => {
    const at = bankLocal(code, operand)
    return at === null || operand + n > 0x10000 ? null : rom.readAtFileOffset(at, n)
  }

  const notStock = (n: Name): { unavailable: string } =>
    no(`${SPANS[n].name} is not stock: absent or not unique.`)
  const found = findSpan(rom, 'camera', fps)
  if (found.length !== 1) return notStock('camera')
  const at = { camera: found[0]! } as Record<Name, number>
  // A routine is where its caller calls: a hack that moves it and retargets the call still
  // resolves. Every caller of one routine must name the same site, and its bytes must hash.
  for (const c of CALLERS) {
    const hits = findSpan(rom, c.caller, fps)
    if (hits.length !== 1) return notStock(c.caller)
    const call = hits[0]!
    const op = u16(call + c.at)
    // A JSL target is a full address ($84 mirrors $04); a JSR stays in the caller's bank.
    const target = c.long
      ? loromToOffset((u8(call + c.at + 2) << 16) | op, rom.romSize)
      : bankLocal(call, op)
    if (target === null || (at[c.to] !== undefined && at[c.to] !== target)) {
      return no(
        `${SPANS[c.caller].name} does not call ${SPANS[c.to].name}, so it is not reached through stock code.`,
      )
    }
    if (at[c.to] === undefined) {
      const s = SPANS[c.to]
      const fp = spanFingerprint(rom.readAtFileOffset(target, s.length), s.mask)
      if (fp === null || !fps[c.to].includes(fp)) {
        return no(
          `${SPANS[c.caller].name} calls code at file offset ${target.toString(16).toUpperCase()} that is not ${SPANS[c.to].name} as shipped.`,
        )
      }
      at[c.to] = target
    }
  }

  // The camera tables are adjacent (bank_00.asm:4242-4246), so their distance is the length.
  const cameraX = u16(at.camera + 5)
  const cameraY = u16(at.camera + 12)
  if (cameraX < 0x8000 || cameraY <= cameraX || (cameraY - cameraX) % 2 !== 0) {
    return no(`${SPANS.camera.name} reads two tables that are not an even distance apart.`)
  }
  const cameraCount = (cameraY - cameraX) / 2
  const camX = table(at.camera, cameraX, cameraCount * 2)
  const camY = table(at.camera, cameraY, cameraCount * 2)
  if (!camX || !camY) {
    return no(`${SPANS.camera.name} reads a table that runs past the end of its bank.`)
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
      `${SPANS.path.name} or ${SPANS.scan.name} has a record count that does not match its stride.`,
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
