/**
 * The overworld areas the ROM names: the hub (0) plus the areas of every live
 * path-transition and warp record (en-gen/hackbench#364). A record is live when its
 * source area is inside the camera table (a $FF-filled slot is not); its destination
 * is then listed, marked invalid when the camera table cannot place it. Each routine
 * read is fingerprint-gated (SHA-256, operands masked, at least 24 unknown bytes each). A routine
 * is not trusted for being stock alone: some JSL or JSR in the cart must reach it, a structural
 * check read from the call's own operand (no fingerprint over the short call spans). A failed
 * gate refuses with its address and nothing falls back to vanilla.
 *
 * The camera gate currently refuses most Lunar Magic edited ROMs: LM's hook at the end of the
 * camera span replaces its last instructions (#522). The table reads themselves are unchanged.
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

/** Operand offsets of the two camera tables inside the camera span. */
const CAMERA_X_AT = 26
const CAMERA_Y_AT = 33
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
  /** CODE_00A11B from its screen setup to the camera read's last store (bank_00.asm:4316-4333): the
   *  camera X table then Y table, indexed by area*2. Operands: the JSR and JSL targets (3, 12),
   *  the turn and submap reads (16, 19), X table at 26, Y table at 33. Found by scan: nothing
   *  calls it. */
  camera: { name: 'the camera read (bank_00.asm:4316-4333)', length: 41, mask: [3, 4, 12, 13, 14, 16, 17, 19, 20, 26, 27, 33, 34], anchor: [0xa0, 0x02], fingerprints: ['25e4f87ca2d278a1c92154f42f9069de0efe4a1e7e575eadc9830f667639b4e8'] },
  /** CODE_049A24 to the end of its loop (bank_04.asm:2835-2885). Operands: counter 18, LDY 23,
   *  source area table 44, destination area table 67; the rest are ignored table addresses. */
  path: { name: 'CODE_049A24, the path transitions (bank_04.asm:2835, $04:9A24)', length: 110, mask: [18, 23, 31, 32, 39, 40, 44, 45, 55, 56, 61, 62, 67, 68, 78, 79, 87, 88], anchor: [0xc2, 0x20], fingerprints: ['d26f51c1fa40605fe0621e4109e2f92b55c42d2719a29e014a9888dfafa6bbeb'] },
  /** CODE_048509's scan of DATA_048431, ending at STY StarWarpIndex (bank_04.asm:527-550).
   *  Operands: LDY 16, source word table 18. */
  scan: { name: 'CODE_048509, the warp scan (bank_04.asm:527, $04:8509)', length: 47, mask: [16, 18, 19, 36, 37], anchor: [0xac, 0xb3], fingerprints: ['37a1f3b40432191c88d42b886f0e63c37a37bd7b8f71a32ebce33f6a2a67396f'] },
  /** CODE_04853B's decode of DATA_04849D into CurrentSubmap (bank_04.asm:554-581).
   *  Operand: destination word table 12. */
  dest: { name: 'CODE_04853B, the warp destination (bank_04.asm:554, $04:853B)', length: 50, mask: [12, 13, 29, 30], anchor: [0x8b, 0x4b], fingerprints: ['bfab0d7cefabefcf270b71855026a0db935c8445c9d2cfa0f4d26ba9428eb08f'] },
} satisfies Record<string, Span>
type Name = keyof typeof SPANS
/** Recognized fingerprints per span; a synthetic ROM passes its own (code that is not the cart's). */
export type AreaFingerprints = Record<Name, readonly string[]>
export const AREA_FINGERPRINTS = Object.fromEntries(
  Object.entries(SPANS).map(([k, v]) => [k, v.fingerprints]),
) as unknown as AreaFingerprints
/** Span geometry, for a test that plants its own code at the same operand offsets. */
export const AREA_SPANS: Readonly<Record<Name, Pick<Span, 'length' | 'mask' | 'anchor'>>> = SPANS

/** Routines reached by a call, and whether it is a JSL (the rest are JSR in the routine's bank). */
const CALLED: { name: Name; long?: true }[] = [
  { name: 'dest', long: true },
  { name: 'path' },
  { name: 'scan' },
]

/** Cart offsets whose span hashes (operands masked) to a recognized fingerprint, at most `max`. */
function findSpan(rom: RomFile, n: Name, fps: AreaFingerprints, max = 8): number[] {
  const s: Span = SPANS[n]
  const hits: number[] = []
  for (const at of findPattern(rom, s.anchor)) {
    if (!fps[n].includes(spanFingerprint(rom.readAtFileOffset(at, s.length), s.mask) ?? ''))
      continue
    hits.push(at)
    if (hits.length >= max) break
  }
  return hits
}

/**
 * How many instructions call the routine at cart offset `target`: a JSL whose operand names it
 * (the FastROM mirror bank too), or a JSR to its low word from its own bank. Structure read from
 * the operands; a data run that spells the same bytes also counts, so this says "something may
 * call it", not "the game does".
 */
function callersOf(rom: RomFile, target: number, long: boolean): number {
  const lo = 0x8000 | (target & 0x7fff)
  const bank = target >> 15
  if (long) {
    return [bank, bank | 0x80].reduce(
      (n, b) => n + findPattern(rom, [0x22, lo & 0xff, lo >> 8, b]).length,
      0,
    )
  }
  return findPattern(rom, [0x20, lo & 0xff, lo >> 8]).filter(at => at >> 15 === bank).length
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
  const found = findSpan(rom, 'camera', fps, 2)
  if (found.length !== 1) return notStock('camera')
  const at = { camera: found[0]! } as Record<Name, number>
  // A routine is where a call reaches it: a hack that moves one and retargets the call still
  // resolves, and a left-behind stock copy that nothing calls is ignored.
  for (const c of CALLED) {
    const hits = findSpan(rom, c.name, fps)
    if (hits.length === 0) return notStock(c.name)
    const called = hits.filter(h => callersOf(rom, h, c.long === true) > 0)
    if (called.length === 0) {
      return no(`${SPANS[c.name].name} is never called, so it is not reached through stock code.`)
    }
    if (called.length > 1) return notStock(c.name)
    at[c.name] = called[0]!
  }

  // The camera tables are adjacent (bank_00.asm:4242-4246), so their distance is the length.
  const cameraX = u16(at.camera + CAMERA_X_AT)
  const cameraY = u16(at.camera + CAMERA_Y_AT)
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

  // The camera read doubles the area index with 8-bit A (bank_00.asm:4324), so the index is (area*2) & $FF.
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
