/** Vanilla-shaped overworld area routines for synthetic ROMs (OverworldAreas gates). */
import { RomFile } from '../../../src/rom/RomFile'
import { AREA_SPANS, type AreaFingerprints } from '../../../src/rom/OverworldAreas'
import { spanFingerprint } from '../../../src/rom/SubmapFlagGate'

export type Name = keyof typeof AREA_SPANS

// The area routines as hand-written stand-ins, not the cart's code: each span is the module's
// length and operand offsets, its two anchor opcodes, NOPs between and zeroed operand slots.
// The module recognizes them through SYNTHETIC_AREA_FPS, the way OverworldDecode's
// SYNTHETIC_FPS recognizes its NOP spans. Citations for the real routines are in the module.
export const NAMES = Object.keys(AREA_SPANS) as Name[]
export const LEN = (n: Name): number => AREA_SPANS[n].length
export const CODE = Object.fromEntries(
  NAMES.map(n => {
    const s = AREA_SPANS[n]
    const bytes = new Array<number>(s.length).fill(0xea)
    bytes[0] = s.anchor[0]
    bytes[1] = s.anchor[1]
    for (const i of s.mask) bytes[i] = 0
    return [n, bytes]
  }),
) as Record<Name, number[]>
export const SYNTHETIC_AREA_FPS = Object.fromEntries(
  NAMES.map(n => [n, [spanFingerprint(Buffer.from(CODE[n]), AREA_SPANS[n].mask)!]]),
) as AreaFingerprints
// SNES addresses; `moves` sites follow the routine bank.
export const WHERE: Record<Name, { at: number; moves?: true }> = {
  camera: { at: 0x00a300 },
  scan: { at: 0x048509, moves: true },
  dest: { at: 0x04853b, moves: true },
  path: { at: 0x049a24, moves: true },
}
// Call instructions planted by `call`, not fingerprinted: the module reads their operands.
export const CALLS = { jsl: 0x00a08a, jsrPath: 0x049616, jsrStar: 0x049161, jsrPipe: 0x049184 }
export type CallName = keyof typeof CALLS
// Operand offsets inside the routines above.
export const OP = {
  camX: 26,
  camY: 33,
  pathCounter: 18,
  pathLdy: 23,
  pathSrc: 44,
  pathDst: 67,
  warpLdy: 16,
  warpSrc: 18,
  warpDst: 12,
}
export const T = { warpSrc: 0x8431, warpDst: 0x849d, pathSrc: 0x9968, pathDst: 0x99ae }

export const inBank = (at: number, bank: number): number => (bank << 16) | (at & 0xffff)
export const siteAt = (n: Name, bank = 4): number =>
  WHERE[n].moves ? inBank(WHERE[n].at, bank) : WHERE[n].at

// Areas read from the vanilla ROM: the high byte of DATA_048431, bits 9-12 of
// DATA_04849D, and the area byte of each 5-byte path record.
// prettier-ignore
export const WARP_SRC = [0, 0, 0, 0, 0, 0, 0, 2, 2, 4, 4, 4, 4, 6, 2, 6, 0, 6, 0, 6, 0, 6, 6, 5, 5, 4, 1]
// prettier-ignore
export const WARP_DST = [2, 2, 4, 4, 4, 4, 6, 0, 0, 0, 0, 0, 0, 0, 6, 2, 6, 0, 6, 0, 6, 4, 5, 6, 1, 6, 6]
export const PATH_SRC = [0, 0, 1, 1, 0, 2, 4, 0, 0, 3, 0, 3, 0, 3]
export const PATH_DST = [1, 1, 0, 0, 2, 0, 0, 4, 3, 0, 3, 0, 3, 0]

// Table cells, also used to plant mutations after `stub()` builds the vanilla ROM.
export const warpSrc = (rom: RomFile, i: number, area: number, bank = 4): void =>
  rom.writeAt(inBank(T.warpSrc + 2 * i, bank), [0x10, area])
export const warpDst = (rom: RomFile, i: number, area: number, bank = 4): void =>
  rom.writeAt(inBank(T.warpDst + 2 * i, bank), [0x10, area << 1])
export const pathSrc = (rom: RomFile, i: number, area: number, bank = 4): void =>
  rom.writeAt(inBank(T.pathSrc + 5 * i, bank), [area])
export const pathDst = (rom: RomFile, i: number, area: number, bank = 4): void =>
  rom.writeAt(inBank(T.pathDst + 5 * i, bank), [area])
export const setByte = (rom: RomFile, n: Name, index: number, v: number): void =>
  rom.writeAt(siteAt(n) + index, [v])
export const setWord = (rom: RomFile, n: Name, index: number, v: number): void =>
  rom.writeAt(siteAt(n) + index, [v & 0xff, v >> 8])

export const word = (base: number, v: number): Record<number, number> => ({
  [base]: v & 0xff,
  [base + 1]: v >> 8,
})
/** Plant routine or caller `n` from CODE at its address in `bank`, operands filled from `ops`. */
export function plant(rom: RomFile, n: Name, bank: number, ops: Record<number, number> = {}): void {
  const b = [...CODE[n]]
  for (const [i, v] of Object.entries(ops)) b[Number(i)] = v
  rom.writeAt(siteAt(n, bank), b)
}

/** Where a planted call sits: JSL in bank 0, JSRs in the routine bank. */
export const callAt = (n: CallName, bank = 4): number =>
  n === 'jsl' ? CALLS[n] : inBank(CALLS[n], bank)
/**
 * Plants a call to `target` (low word) at `n`: a JSL to `bank` (or `bank` | $80 for the FastROM
 * mirror), or a JSR within the caller's own bank. `at` overrides the site.
 */
export function call(
  rom: RomFile,
  n: CallName,
  target: number,
  bank = 4,
  at: number = callAt(n, bank),
): void {
  rom.writeAt(
    at,
    n === 'jsl' ? [0x22, target & 0xff, target >> 8, bank] : [0x20, target & 0xff, target >> 8],
  )
}

/** Plants vanilla-shaped routines, callers and tables (from CODE) into `rom`. */
export function plantAreas(rom: RomFile, bank = 4): void {
  const put = (n: Name, ops: Record<number, number> = {}): void => plant(rom, n, bank, ops)
  const low = (n: Name): number => siteAt(n, bank) & 0xffff
  put('camera', { ...word(OP.camX, 0xa06b), ...word(OP.camY, 0xa079) })
  put('scan', { [OP.warpLdy]: (WARP_SRC.length - 1) * 2, ...word(OP.warpSrc, T.warpSrc) })
  put('dest', word(OP.warpDst, T.warpDst))
  put('path', {
    [OP.pathCounter]: (PATH_SRC.length - 1) * 2,
    [OP.pathLdy]: (PATH_SRC.length - 1) * 5,
    ...word(OP.pathSrc, T.pathSrc),
    ...word(OP.pathDst, T.pathDst),
  })
  call(rom, 'jsl', low('dest'), bank)
  call(rom, 'jsrPath', low('path'), bank)
  call(rom, 'jsrStar', low('scan'), bank)
  call(rom, 'jsrPipe', low('scan'), bank)
  WARP_SRC.forEach((a, i) => warpSrc(rom, i, a, bank))
  WARP_DST.forEach((a, i) => warpDst(rom, i, a, bank))
  PATH_SRC.forEach((a, i) => pathSrc(rom, i, a, bank))
  PATH_DST.forEach((a, i) => pathDst(rom, i, a, bank))
}

/** A 256 KB LoROM stub with the area routines planted. */
export function stub(bank = 4): RomFile {
  const rom = new RomFile('stub.sfc', Buffer.alloc(0x40000))
  plantAreas(rom, bank)
  return rom
}
