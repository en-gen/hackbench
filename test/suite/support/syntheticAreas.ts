/** Vanilla-shaped overworld area routines for synthetic ROMs (OverworldAreas gates). */
import { RomFile } from '../../../src/rom/RomFile'

// Routine bytes as the vanilla ROM holds them (SMWDisX bank_00.asm:4250-4333;
// bank_04.asm:527-581, :1753-1774, :2356-2361, :2835-2885). '??' is an operand the
// module reads or ignores. Kept apart from the module's patterns on purpose.
export const HEX = {
  camera: '0a aa c2 20 bd ?? ?? 85 1a 85 1e bd ?? ?? 85 1c 85 20 e2 20',
  scan:
    'ac b3 0d b9 11 1f 85 01 64 00 c2 20 ae d6 0d a0 ?? b9 ?? ?? 45 00 c9 00 02 b0 0d dd 1f 1f ' +
    'd0 08 bd 21 1f d9 ?? ?? f0 04 88 88 10 e5 8c f6 1d',
  dest:
    '8b 4b ab c2 20 ae d6 0d ac f6 1d b9 ?? ?? 48 29 ff 01 9d 17 1f 4a 4a 4a 4a 9d 1f 1f b9 ?? ?? ' +
    '9d 19 1f 4a 4a 4a 4a 9d 21 1f 68 4a eb 29 0f 00 8d c3 13',
  path:
    'c2 20 ad d6 0d 4a 4a aa bd 11 1f 29 ff 00 8d c3 13 a9 ?? 00 85 02 a0 ?? ae d6 0d bd 19 1f ' +
    'd9 ?? ?? d0 3e bd 17 1f d9 ?? ?? d0 36 b9 ?? ?? 29 ff 00 cd c3 13 d0 2b b9 ?? ?? 9d 19 1f ' +
    'b9 ?? ?? 9d 17 1f b9 ?? ?? 29 ff 00 8d c3 13 a4 02 b9 ?? ?? 29 ff 00 9d 21 1f b9 ?? ?? ' +
    '29 ff 00 9d 1f 1f 80 0b c6 02 c6 02 88 88 88 88 88 10 af e2 20',
  jsl: 'ad 9c 1b f0 04 22 ?? ?? ?? 20 a6 a1',
  jsrPath: 'dd 26 94 d0 2a 5a 20 ?? ?? 7a a9 01',
  jsrStar: 'c9 5f d0 18 20 ?? ?? d0 2e 9c f7 1d',
  jsrPipe: 'c9 5b d0 11 20 ?? ?? d0 0b ee 9c 1b',
}
export type Name = keyof typeof HEX
// SNES addresses; `moves` sites follow the routine bank.
export const WHERE: Record<Name, { at: number; moves?: true }> = {
  camera: { at: 0x00a130 },
  scan: { at: 0x048509, moves: true },
  dest: { at: 0x04853b, moves: true },
  path: { at: 0x049a24, moves: true },
  jsl: { at: 0x00a08a },
  jsrPath: { at: 0x049616, moves: true },
  jsrStar: { at: 0x049161, moves: true },
  jsrPipe: { at: 0x049184, moves: true },
}
// Operand offsets inside the routines above.
export const OP = {
  pathCounter: 18,
  pathLdy: 23,
  pathSrc: 44,
  pathDst: 67,
  warpLdy: 16,
  warpSrc: 18,
  warpDst: 12,
}
export const T = { warpSrc: 0x8431, warpDst: 0x849d, pathSrc: 0x9968, pathDst: 0x99ae }

export const tokens = (s: string): string[] => s.split(' ')
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
/** Plant routine or caller `n` from HEX at its address in `bank`, operands filled from `ops`. */
export function plant(rom: RomFile, n: Name, bank: number, ops: Record<number, number> = {}): void {
  const b = tokens(HEX[n]).map(t => (t === '??' ? 0 : parseInt(t, 16)))
  for (const [i, v] of Object.entries(ops)) b[Number(i)] = v
  rom.writeAt(siteAt(n, bank), b)
}

/** Plants vanilla-shaped routines, callers and tables (from HEX) into `rom`. */
export function plantAreas(rom: RomFile, bank = 4): void {
  const put = (n: Name, ops: Record<number, number> = {}): void => plant(rom, n, bank, ops)
  const low = (n: Name): number => siteAt(n, bank) & 0xffff
  put('camera', { ...word(5, 0xa06b), ...word(12, 0xa079) })
  put('scan', { [OP.warpLdy]: (WARP_SRC.length - 1) * 2, ...word(OP.warpSrc, T.warpSrc) })
  put('dest', word(OP.warpDst, T.warpDst))
  put('path', {
    [OP.pathCounter]: (PATH_SRC.length - 1) * 2,
    [OP.pathLdy]: (PATH_SRC.length - 1) * 5,
    ...word(OP.pathSrc, T.pathSrc),
    ...word(OP.pathDst, T.pathDst),
  })
  put('jsl', { ...word(6, low('dest')), 8: bank })
  put('jsrPath', word(7, low('path')))
  put('jsrStar', word(5, low('scan')))
  put('jsrPipe', word(5, low('scan')))
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
