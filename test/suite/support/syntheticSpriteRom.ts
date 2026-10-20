/**
 * A synthetic LoROM that has the sprite dispatch SHAPE the runner reads (the
 * game's sprite loop, HandleSprite, CallSpriteInit/Main, ExecutePtr) and a
 * handful of hand-assembled sprite routines. No ROM-derived bytes: every
 * routine below is written here, so CI (which has no cart) exercises the
 * runner, the dispatch reader and the refusal paths.
 *
 * Ids: 0 shifts +8 in INIT and draws one 16x16 piece; 1 shifts (+8,-1) with a
 * Y borrow; 2 draws a flip that follows Mario's side; 3 takes its tile from
 * the hardware multiplier; 4 executes COP in MAIN; 5 draws nothing; 6 has an
 * INIT pointer below $8000; 7, 8 and 9 end INIT with status $9, $0 and $1; 10
 * draws its tile from the level water flag ($85); 11 jumps out of ROM (JML $7E0000);
 * 12 draws into the $0200 OAM page; 13 leaves status 1 for two INIT frames; 14, 15 and 16 draw
 * 17 retries INIT and records $13/$14 per call; 18 draws its tile from $14; 19 writes a tile but
 * a Y only on odd frames; 14, 15 and 16 draw their tile from $13 (frame counter), $148B (RNG) and $76 (Mario direction). InitSpriteTables stores into a table indexed by X (the
 * slot) and GetRand steps an RNG at $148B, both with the vanilla call shape. The level
 * loader entries ($05:D8AE, $05:D8B7, $00:A635, $05:801E) carry the vanilla shape bytes
 * and small routines of our own. Ids 20, 21 and 22 draw like id 0 and set one CGRAM color
 * in INIT: 20 through the NMI upload list ($0681/$0682), 21 through a MainPalette list
 * ($0703, with $0680 = 6), 22 through $2121/$2122; 23 sets one color directly then by the list, 24 appends a list color and requests the MainPalette upload in one frame, 25 sets two colors with one CGADD, 26 writes id 21's MainPalette list without requesting the upload, 28 writes mirror colors with no list header, 29 uploads a two-color list entry, 27 appends a list color in every MAIN pass, 30 burns ~196k steps per INIT and never leaves status 1; 31 draws at X then moves X by +4 each MAIN; 32 is 31 but draws only from its second MAIN; 103 is the line-guided grinder's id: its MAIN has the vanilla SHAPE the runner's gate reads (bank_01.asm:11837-11846, 12182-12204) around a draw then a +4 move; 98 and 104 (JMP entry) and 101 and 102 (prelude entry) reach the same dispatch, 100 has the prelude but is not admitted. Options plant a defect for the oracle tests.
 */
import { RomFile } from '../../../src/rom/RomFile'
import type { DispatcherSpan } from '../../../src/rom/sprites/interp/SpriteDispatch'

import { putGm11Spans } from './syntheticGm11Spans'
import { putGrinderRoutines } from './syntheticGrinder'

export interface SyntheticOptions {
  /** ADC operand of id 0's INIT shift. */
  initShift?: number
  /** Replace id 0's MAIN tile STA with NOPs (draws nothing useful). */
  noTileWrite?: boolean
  /** Break the sprite loop's countdown (loop reader must refuse). */
  badLoop?: boolean
  /** A second copy of the loop's countdown inside the scanned window (must refuse). */
  dupLoop?: boolean
  /** The dispatch's INIT call reaches a different routine than the others (must refuse). */
  badExecutePtr?: boolean
  /** Break the HandleSprite shape (dispatch reader must refuse). */
  badDispatch?: boolean
  /** Break the InitSpriteTables or GetRand shape. */
  badInitTables?: boolean
  badGetRand?: boolean
  /** GetRand's two JSL banks use the FastROM mirror $81, as 36 of 101 hacks do. */
  fastRomGetRand?: boolean
  /**
   * Break one level-loader entry shape (by its first byte: 'lead' 'jump' 'callsite' 'pointers' 'entrance'
   * 'data' 'scroll' 'update'; by its last: 'scrollTail' 'updateTail'), or make a GM11-span routine
   * return wrongly ('scrollRtl' 'updateRts') or pop above its frame and repair S ('scrollPop').
   */
  badLoader?:
    | 'lead'
    | 'jump'
    | 'callsite'
    | 'pointers'
    | 'entrance'
    | 'data'
    | 'scroll'
    | 'update'
    | 'scrollTail'
    | 'updateTail'
    | 'updateOperand'
    | 'scrollRtl'
    | 'updateRts'
    | 'scrollPop'
  /**
   * UpdateScreenPosition carries a JML at $00:F6E4 (86 of 107 corpus ROMs do) to $05:F000, which
   * does the rest of its work: 'jml' ends in RTL, 'loop' never returns, 'rts' ends in the wrong return.
   */
  updateHook?: 'jml' | 'loop' | 'rts'
  /** The data loader executes COP after its shape bytes. */
  loaderCop?: boolean
  /** Break one shape of the item block spawn routine at $02:8905: its slot countdown or its status write. */
  badSpawn?: 'head' | 'status' | 'dispatch'
  /** The spawn routine's own timer immediate (written to $1540,X); default $37. */
  spawnTimer?: number
  /** The spawn routine never returns. */
  spawnLoop?: boolean
  /** Id 103's handler body differs from the vanilla shape in one operand (behaviour the same). */
  alteredGrinder?: boolean
  /** Id 103 draws on its first MAIN only. */
  grinderDrawsOnce?: boolean
  /** Id 103 draws on passes 0 and 1 only. */
  grinderDrawsTwice?: boolean
  /** Id 103 draws on its second MAIN only. */
  grinderDrawsOnPass1?: boolean
  /** Id 103 draws from its second MAIN onward (already on its track at the first draw). */
  grinderDrawsFromPass1?: boolean
  /** Id 31's MAIN pointer is id 103's handler: the shape matches, the id does not. */
  id31IsGrinder?: boolean
}

const BANK = 0x8000

/** Our own block spawn dispatcher, written for this fixture: index compare, JSL FindFreeSprSlot, fall-through. */
// prettier-ignore
export const SYNTHETIC_DISPATCHER_CODE: readonly number[] = Object.freeze([
  0xa5, 0x05,             // LDA $05: the content index
  0xc9, 0x0c,             // CMP #$0C
  0xf0, 0x03,             // BEQ slot
  0x4c, 0x05, 0x89,       // JMP $8905: GenSpriteFromBlk's own countdown
  0x22, 0xe4, 0xa9, 0x02, // slot: JSL FindFreeSprSlot, Y = slot or $FF
  0x5a, 0xfa,             // PHY / PLX: X = Y, N set when none was free
  0x30, 0x03,             // BMI done
  0x4c, 0x22, 0x89,       // JMP $8922: the status write
  0x6b,                   // done: RTL
])

/** The gate's view of SYNTHETIC_DISPATCHER_CODE: the JSL operand masked, the rest hashed. */
export const SYNTHETIC_DISPATCHER: DispatcherSpan = Object.freeze({
  length: SYNTHETIC_DISPATCHER_CODE.length,
  callAt: 10,
  fingerprints: Object.freeze(['5e321bdaabc6e582f75144b988d69dda7e2942736697a29d06e5f5f2ec6b9f3b']),
})

export function buildSyntheticRom(o: SyntheticOptions = {}): RomFile {
  const rom = new Uint8Array(8 * BANK) // banks 0-7
  const put = (snes: number, bytes: number[]): void => {
    const bank = snes >>> 16
    rom.set(bytes, bank * BANK + ((snes & 0xffff) - 0x8000))
  }
  // ExecutePtr at $00:86FA, the 16-bit pointer-table jump: reads the return address as the table base,
  // indexes it by A, jumps through DP in bank 1. The shape the runner reads (checkExecutePtr) fixes the
  // opcodes and leaves the direct-page cells free, so this uses $0A-$0D, not the game's scratch cells.
  const [save, ptr] = [0x0d, 0x0a] // Y saved here; the 3-byte pointer at $0A-$0C
  const [STY, PLY, REP, AND, ASL, TAY, PLA, STA, INY, LDAL, SEP, LDY, JML] = [0x84, 0x7a, 0xc2, 0x29, 0x0a, 0xa8, 0x68, 0x85, 0xc8, 0xb7, 0xe2, 0xa4, 0xdc] // prettier-ignore
  put(0x0086fa, [STY, save, PLY, STY, ptr, REP, 0x30, AND, 0xff, 0x00, ASL, TAY, PLA, STA, ptr + 1, INY, LDAL, ptr, STA, ptr, SEP, 0x30, LDY, save, JML, ptr, 0x00]) // prettier-ignore
  // $07:F7D2 InitSpriteTables: JSL / JSL / RTL. The first stub stores into a table
  // indexed by X, so a run that does not set X to the slot leaves the wrong cell.
  put(0x07f7d2, [o.badInitTables ? 0xea : 0x22, 0xa0, 0xf7, 0x07, 0x22, 0xb0, 0xf7, 0x07, 0x6b])
  put(0x07f7a0, [0xa9, 0x55, 0x9d, 0x00, 0x16, 0x6b]) // LDA #$55 / STA $1600,X / RTL
  put(0x07f7b0, [0x6b])
  // $01:ACF9 GetRand: PHY LDY #1 JSL step DEY JSL step PLY RTL; the step (at $01:AD40, not the game's address) increments $148B.
  const gb = o.fastRomGetRand ? 0x81 : 0x01
  put(0x01acf9, [0x5a, 0xa0, 0x01, 0x22, 0x40, 0xad, gb, o.badGetRand ? 0xea : 0x88, 0x22, 0x40, 0xad, gb, 0x7a, 0x6b]) // prettier-ignore
  put(0x01ad40, [0xee, 0x8b, 0x14, 0x6b]) // INC $148B / RTL
  // Level loader: the vanilla shape bytes, then a small routine of our own after each.
  const bad = (k: string, b: number) => (o.badLoader === k ? 0xea : b)
  // GM11's three calls, CODE_05D796's prologue and sublevel branch, and the JMP into the pointer loader.
  put(0x0096f4, [bad('callsite', 0x22), 0x96, 0xd7, 0x05])
  put(0x0096f8, [0xa2, 0x07, 0xb5, 0x1a, 0x9d, 0x62, 0x14, 0xca, 0x10, 0xf8])
  put(0x009705, [0x20, 0x35, 0xa6])
  put(
    0x009708,
    [0xa9, 0x20, 0x85, 0x5e, 0x20, 0x96, 0xa7, 0xee, 0x04, 0x14, 0x22, 0xdb, 0xf6, 0x00],
  )
  put(0x009716, [0x22, 0x1e, 0x80, 0x05])
  put(0x05d796, [bad('lead', 0x8b), 0x4b, 0xab, 0xe2, 0x30, 0x9c, 0xcf, 0x13, 0xad, 0x95, 0x1b, 0xd0, 0x05, 0xac, 0x25, 0x14, 0xf0, 0x03, 0x20, 0xac, 0xdb, 0xad, 0x1a, 0x14, 0xd0, 0x03, 0x4c, 0x3e, 0xd8]) // prettier-ignore
  put(0x05d83b, [bad('jump', 0x4c), 0xb7, 0xd8])
  // CODE_05D8B7 shape, then SEP #$30 / LDA #7 / STA $1692 / STA $1A / PLB / RTL
  put(0x05d8b7, [bad('pointers', 0xc2), 0x30, 0xa5, 0x0e, 0x0a, 0x18, 0x65, 0x0e, 0xa8, 0xe2, 0x30, 0xa9, 0x07, 0x8d, 0x92, 0x16, 0x85, 0x1a, 0xab, 0x6b]) // prettier-ignore
  putGm11Spans(put, o)
  // CODE_00A635 shape, then LDA $0000 / LDA #6 / STA $71 / RTS
  put(0x00a635, [bad('entrance', 0xad), 0xad, 0x14, 0x0d, 0xae, 0x14, 0x0d, 0x0c, 0x19, 0xd0, 0x0a, 0xad, 0x00, 0x00, 0xa9, 0x06, 0x85, 0x71, 0x60]) // prettier-ignore
  // CODE_05801E shape, STA $7EC800,X, LDA #$77 / STA $5E (CODE_0584E3 rewrites $5E, bank_05.asm:560,
  // so only a data loader run AFTER the screen setup leaves $77), then PLP RTL (or COP)
  put(0x05801e, [bad('data', 0x08), 0xe2, 0x20, 0xc2, 0x10, 0xa2, 0x00, 0x00, 0xa9, 0x25, 0x9f, 0x00, 0xc8, 0x7e, 0xa9, 0x77, 0x85, 0x5e, ...(o.loaderCop ? [0x02, 0x00] : [0x28, 0x6b])]) // prettier-ignore
  // $01:808C sprite loop: PHB PHK PLB, X = $0B..0 { STX $15E9; JSR setup; JSR handle }
  put(0x01808b, [0xea]) // a NOP before the loop: the zero fill then PHB PHK is itself a window of the game's
  put(0x01808c, [
    0x8b, 0x4b, 0xab, 0xa2, o.badLoop ? 0x0a : 0x0b, 0x8e, 0xe9, 0x15, 0x20, 0xe0, 0x80, 0x20, 0x27, 0x81, 0xca,
    0x10, 0xf4, 0xab, 0x6b,
  ]) // prettier-ignore
  if (o.dupLoop) put(0x01808c + 22, [0xa2, 0x0b, 0x8e, 0xe9, 0x15, 0x20, 0xe0, 0x80, 0x20, 0x27, 0x81, 0xca, 0x10, 0xf4]) // prettier-ignore
  // $01:80E0 per-sprite setup (the loop's first JSR, read from its operand): OAM index 4 * slot, so two running slots write different entries.
  put(0x0180e0, [0x8a, 0x0a, 0x0a, 0x9d, 0xea, 0x15, 0x60])
  // $01:8127 HandleSprite (16 bytes of code, then the status table).
  const handle = o.badDispatch ? 0xea : 0xbd
  put(0x018127, [handle, 0xc8, 0x14, 0xf0, 0x34, 0xc9, 0x08, 0xd0, 0x03, 0x4c, 0x20, 0x83, 0x22, 0xfa, 0x86, 0x00]) // prettier-ignore
  const statusTable = Array.from({ length: 13 }, () => 0x8160)
  statusTable[1] = 0x8170
  put(
    0x018137,
    statusTable.flatMap(w => [w & 0xff, w >> 8]),
  )
  put(0x018160, [0x60])
  // $01:8170 CallSpriteInit, table of 201 words after the JSL.
  put(0x018170, [0xa9, 0x08, 0x9d, 0xc8, 0x14, 0xb5, 0x9e, 0x22, o.badExecutePtr ? 0x00 : 0xfa, 0x86, 0x00]) // prettier-ignore
  // $01:8320 CallSpriteMain.
  put(0x018320, [0x9c, 0x00, 0x14, 0xb5, 0x9e, 0x22, 0xfa, 0x86, 0x00])
  const initTable = Array.from({ length: 201 }, () => 0x8600)
  const mainTable = Array.from({ length: 201 }, () => 0x8600)
  initTable[0] = 0x8610
  initTable[1] = 0x8620
  initTable[6] = 0x0010
  initTable[7] = 0x8730
  initTable[8] = 0x8740
  initTable[9] = 0x8750
  mainTable[0] = 0x8640
  mainTable[1] = 0x8640
  mainTable[2] = 0x8680
  mainTable[3] = 0x86c0
  mainTable[4] = 0x8700
  mainTable[10] = 0x8780
  mainTable[11] = 0x8a00
  mainTable[12] = 0x8a40
  initTable[13] = 0x8800
  mainTable[13] = 0x8640
  mainTable[14] = 0x8900
  mainTable[15] = 0x8940
  mainTable[16] = 0x8980
  initTable[17] = 0x8b00
  mainTable[17] = 0x8640
  mainTable[18] = 0x8b40
  mainTable[19] = 0x8b80
  initTable[20] = 0x8c00
  initTable[21] = 0x8c30
  initTable[22] = 0x8c60
  initTable[23] = 0x8d00
  initTable[24] = 0x8d40
  initTable[25] = 0x8d80
  initTable[26] = 0x8e00
  initTable[28] = 0x8f00
  initTable[29] = 0x9000
  initTable[30] = 0x9100
  mainTable[29] = 0x8640
  mainTable[28] = 0x8640
  mainTable[26] = 0x8640
  mainTable[27] = 0x8e40
  mainTable[31] = 0x9300
  mainTable[32] = 0x92a0
  mainTable[103] = 0x9200
  for (const id of [98, 104]) mainTable[id] = 0x9600
  for (const id of [100, 101, 102]) mainTable[id] = 0x9610
  mainTable[33] = 0x8a80
  if (o.id31IsGrinder) mainTable[31] = 0x9500
  for (const id of [20, 21, 22, 23, 24, 25]) mainTable[id] = 0x8640
  const words = (t: number[]) => t.flatMap(w => [w & 0xff, w >> 8])
  put(0x018170 + 11, words(initTable))
  put(0x018320 + 9, words(mainTable))
  // $02:8905 GenSpriteFromBlk (item block spawn): the vanilla shapes at its entry and at $028922, then a
  // body of our own: status from a table indexed by the content index $05, sprite number from another,
  // InitSpriteTables, then 1540,X = a timer immediate and C2,X += 1. Tables: $02:88A3 numbers, $02:88C5
  // status, by content index 1: sprite 5 (draws nothing), 8; 2: sprite 13 (counts its INIT calls), 9;
  // 3: sprite 0 (draws a 16x16 piece), 8.
  put(0x0288a3, [0, 5, 13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 13])
  put(0x0288c5, [0, 8, 9, 8, 0, 0, 0, 0, 0, 0, 0, 0, 9])
  // The dispatcher at $02:88DC: our own routine (not the game's), with the observable behaviour the runner needs.
  // Content 12 goes through FindFreeSprSlot (which here always answers slot 7) and on a slot to the status write
  // at $028922; every other index jumps to $028905. Its fingerprint is SYNTHETIC_DISPATCHER, injected by the tests.
  if (o.badSpawn !== 'dispatch') put(0x0288dc, [...SYNTHETIC_DISPATCHER_CODE])
  put(0x02a9e3, [0xea]) // a NOP before the opening: six zero bytes then STZ $0E is itself a window of the game's
  put(0x02a9e4, [0x64, 0x0e, 0x8b, 0x4b, 0xab, 0xa0, 0x07, 0xab, 0x6b]) // FindFreeSprSlot stand-in (its STZ $0E / PHB PHK PLB opening): Y = 7
  // The free-slot hit branches to a JMP $8922 at $028912 (a displacement of 6, not the game's), so the head shares no 8 bytes with it.
  put(0x028905, [o.badSpawn === 'head' ? 0xea : 0xa2, 0x0b, 0xbd, 0xc8, 0x14, 0xf0, 0x06, 0xca, 0xe0, 0xff, 0xd0, 0xf6, 0x6b, 0x4c, 0x22, 0x89]) // prettier-ignore
  put(0x028922, [o.badSpawn === 'status' ? 0xea : 0x8e, 0x61, 0x18, 0xa4, 0x05, 0xb9, 0xc5, 0x88, 0x9d, 0xc8, 0x14, 0xb9, 0xa3, 0x88, 0x95, 0x9e, 0x22, 0xd2, 0xf7, 0x07]) // prettier-ignore
  put(
    0x028936,
    o.spawnLoop
      ? [0x4c, 0x36, 0x89]
      : [0xa9, o.spawnTimer ?? 0x37, 0x9d, 0x40, 0x15, 0xf6, 0xc2, 0x6b],
  )
  // The level loader's shell sites (bank_02.asm:5290-5291, 5312-5361, 5456-5462), written as the instructions they are.
  // CMP #op / branch to `to`: the displacement is computed from the target label's address.
  const cmpBr = (at: number, op: number, br: number, to: number) =>
    put(at, [0xc9, op, br, to - at - 4])
  cmpBr(0x02a866, 0xe7, 0x90, 0x02a88c)
  cmpBr(0x02a88c, 0xde, 0xd0, 0x02a89c)
  cmpBr(0x02a89c, 0xe0, 0xd0, 0x02a8ac)
  cmpBr(0x02a8ac, 0xcb, 0x90, 0x02a8d4)
  cmpBr(0x02a8b0, 0xda, 0xb0, 0x02a8c0)
  cmpBr(0x02a8c0, 0xe1, 0x90, 0x02a8d0)
  put(0x02a8d0, [0xa9, 0x09, 0x80, 0x02a8df - 0x02a8d0 - 4])
  put(0x02a978, [0xc9, 0x09, 0xb7, 0x00, 0x90, 0x06])
  put(0x02a97e, [0x38, 0xe9, 0xda, 0x18, 0x69, 0x04])
  // status1 sets status 1. A handler ending `xx 60` before the zero fill ends `60, 0xea`: those two bytes plus the fill are a window of the game's.
  // listAdd appends `vals` to the NMI upload list at $0682+ (the last of `vals` is the terminator); stY stores a constant through Y.
  const status1 = [0xa0, 0x01, 0x98, 0x9d, 0xc8, 0x14]
  const stY = (addr: number, v: number): number[] => [0xa0, v, 0x8c, addr & 0xff, addr >> 8]
  const listAdd = (vals: number[], advance: number): number[] => [
    0xda, 0xae, 0x81, 0x06, ...vals.map((v, i) => [0xa9, v, 0x9d, 0x82 + i, 0x06]).reverse().flat(),
    0x8a, 0x38, 0x69, advance - 1, 0x8d, 0x81, 0x06, 0xfa, 0x60,
  ] // prettier-ignore
  // Handlers.
  put(0x018600, [0x60])
  put(0x018610, [0xa9, o.initShift ?? 8, 0x18, 0x75, 0xe4, 0x95, 0xe4, 0x60])
  // id 1 INIT: X + 8, Y - 1 with the borrow into the high byte.
  put(0x018620, [0xa9, 0x08, 0x18, 0x75, 0xe4, 0x95, 0xe4, 0xb5, 0xd8, 0xd0, 0x03, 0xde, 0xd4, 0x14, 0xd6, 0xd8, 0x60]) // prettier-ignore
  // One 16x16 piece at the sprite position minus the scroll, in OAM entry 4 * slot.
  const draw = (tile: number[], attr: number[]): number[] => [
    0xbc, 0xea, 0x15, 0x38, 0xb5, 0xe4, 0xe5, 0x1a, 0x99, 0x00, 0x03, 0x38, 0xb5, 0xd8, 0xe5, 0x1c,
    0x99, 0x01, 0x03, ...tile, ...attr, 0xda, 0x98, 0x4a, 0x4a, 0xaa, 0xa9, 0x01, 0x0a, 0x9d, 0x60, 0x04, 0xfa, 0x60,
  ] // prettier-ignore
  const tileSta = o.noTileWrite ? [0xea, 0xea, 0xea] : [0x99, 0x02, 0x03]
  put(0x018640, draw([0xa9, 0x24, ...tileSta], [0xa9, 0x0a, 0x99, 0x03, 0x03]))
  // id 2: attribute $4A (X flip) when Mario is left of the sprite, else $0A.
  put(0x018680, draw([0xa9, 0x24, 0x99, 0x02, 0x03], [0xa9, 0x0a, 0x99, 0x03, 0x03, 0xa5, 0xd1, 0xd5, 0xe4, 0xb0, 0x05, 0xa9, 0x4a, 0x99, 0x03, 0x03])) // prettier-ignore
  // id 3: tile = 3 * 5 from the CPU multiplier ($4202/$4203 in, $4216 out).
  put(0x0186c0, draw([0xa9, 0x03, 0x8d, 0x02, 0x42, 0xa9, 0x05, 0x8d, 0x03, 0x42, 0xad, 0x16, 0x42, 0x99, 0x02, 0x03], [0xa9, 0x0a, 0x99, 0x03, 0x03])) // prettier-ignore
  // id 10: tile = $85 (LevelIsWater).
  put(0x018780, draw([0xa5, 0x85, 0x99, 0x02, 0x03], [0xa9, 0x0a, 0x99, 0x03, 0x03]))
  put(0x018700, [0x02, 0x00])
  // id 13 INIT: counts calls in $1610,X; while fewer than 3, put status back to 1.
  put(0x018800, [
    0xfe,
    0x10,
    0x16,
    0xbd,
    0x10,
    0x16,
    0xc9,
    0x03,
    0xb0,
    0x06,
    ...status1,
    0x60,
    0xea,
  ])
  const ownTile = (load: number[]) =>
    draw([...load, 0x99, 0x02, 0x03], [0xa9, 0x0a, 0x99, 0x03, 0x03])
  put(0x018900, ownTile([0xa5, 0x13])) // tile = $13
  put(0x018940, ownTile([0xad, 0x8b, 0x14])) // tile = $148B
  put(0x018980, ownTile([0xa5, 0x76])) // tile = $76
  // id 17 INIT: retries twice (as id 13) and records $13 and $14 of each call in $1620,X and $1630,X.
  put(0x018b00, [
    0xa5,
    0x14,
    0x9d,
    0x30,
    0x16,
    0xa5,
    0x13,
    0x9d,
    0x20,
    0x16,
    0xfe,
    0x10,
    0x16,
    0xbd,
    0x10,
    0x16,
    0xc9,
    0x03,
    0xb0,
    0x06,
    ...status1,
    0x60,
    0xea,
  ])
  put(0x018b40, ownTile([0xa5, 0x14])) // id 18: tile = $14
  // id 19: always writes its tile byte; writes X, Y and attribute only when $13 is odd, so on
  // even passes only a stale Y (from the pass before) could make the tile visible.
  put(0x018b80, [0xbc, 0xea, 0x15, 0xa5, 0x13, 0x4a, 0xa9, 0x24, 0x99, 0x02, 0x03, 0x90, 0x0f, 0xa9, 0x60, 0x99, 0x01, 0x03, 0xa9, 0x50, 0x99, 0x00, 0x03, 0xa9, 0x0a, 0x99, 0x03, 0x03, 0x60]) // prettier-ignore
  // id 33: draws one piece whose OAM X low byte is $0E and whose size byte ($0460 + index) is $0F, both
  // planted through the seed, so a test can set any 9-bit X. Y follows the sprite as in the others.
  put(0x018a80, [0xbc, 0xea, 0x15, 0xa5, 0x0e, 0x99, 0x00, 0x03, 0x38, 0xb5, 0xd8, 0xe5, 0x1c, 0x99, 0x01, 0x03, 0xa9, 0x24, 0x99, 0x02, 0x03, 0xa9, 0x0a, 0x99, 0x03, 0x03, 0xda, 0x98, 0x4a, 0x4a, 0xaa, 0xa5, 0x0f, 0x9d, 0x60, 0x04, 0xfa, 0x60]) // prettier-ignore
  // id 11: JML $7E0000, execution leaves ROM.
  put(0x018a00, [0x5c, 0x00, 0x00, 0x7e])
  // id 12: draws into the $0200 OAM page, entry 3 ($020C..), tile $33, size byte $0423 = 2.
  put(0x018a40, [0xa9, 0x60, 0x8d, 0x0d, 0x02, 0xa9, 0x50, 0x8d, 0x0c, 0x02, 0xa9, 0x0a, 0x8d, 0x0f, 0x02, 0xa9, 0x33, 0x8d, 0x0e, 0x02, 0xa9, 0x02, 0x8d, 0x23, 0x04, 0x60]) // prettier-ignore
  // id 20: append [2 bytes, color $D1, $03FF] to the upload list and bump $0681 by 4.
  put(0x018c00, listAdd([0x02, 0xd1, 0xff, 0x03, 0x00], 4))
  // id 21: an overworld-style MainPalette list at $0703 (count 2, color $D2, data $01AA) and $0680 = 6.
  put(0x018c30, [
    ...stY(0x0703, 0x02),
    ...stY(0x0704, 0xd2),
    ...stY(0x0705, 0xaa),
    ...stY(0x0706, 0x01),
    ...stY(0x0680, 0x06),
    0x60,
  ])
  // id 22: color $D3 = $0255 through CGADD/CGDATA.
  put(0x018c60, [...stY(0x2121, 0xd3), ...stY(0x2122, 0x55), ...stY(0x2122, 0x02), 0x60])
  // id 23: color $D1 set directly ($11,$02 = $0211), then by the upload list ($03FF): the list takes effect later.
  put(0x018d00, [
    ...stY(0x2121, 0xd1),
    ...stY(0x2122, 0x11),
    ...stY(0x2122, 0x02),
    ...listAdd([0x02, 0xd1, 0xff, 0x03, 0x00], 4),
  ])
  // id 24: appends a list color (as id 20) and writes $0680 = 6 in the same frame: the MainPalette walk must leave the list alone.
  put(0x018d40, [
    ...listAdd([0x02, 0xd1, 0xff, 0x03, 0x00], 4).slice(0, -1),
    ...stY(0x0680, 0x06),
    0x60,
  ])
  // id 25: two colors through one CGADD: $D4 = $0123, then $D5 = $0456 by auto-increment.
  put(0x018d80, [
    ...stY(0x2121, 0xd4),
    ...stY(0x2122, 0x23),
    ...stY(0x2122, 0x01),
    ...stY(0x2122, 0x56),
    ...stY(0x2122, 0x04),
    0x60,
  ])
  // id 26: id 21's MainPalette list, but $0680 is never written.
  put(0x018e00, [
    ...stY(0x0703, 0x02),
    ...stY(0x0704, 0xd2),
    ...stY(0x0705, 0xaa),
    ...stY(0x0706, 0x01),
    0x60,
    0xea,
  ])
  // id 29: one list entry of two colors, $D6 = $0111 and $D7 = $0222.
  put(0x019000, listAdd([0x04, 0xd6, 0x11, 0x01, 0x22, 0x02, 0x00], 8))
  // id 28: colors at the MainPalette bytes of color $D2 with no list header, and $0680 = 6: nothing is uploaded.
  put(0x018f00, [...stY(0x0680, 0x06), ...stY(0x08a7, 0xaa), ...stY(0x08a8, 0x01), 0x60])
  // id 27: appends a list color every MAIN pass (the same bytes as id 20's INIT).
  put(0x018e40, listAdd([0x02, 0xd1, 0xff, 0x03, 0x00], 4))
  // id 30 INIT: burns 196,608 steps (65,536 x DEY, NOP, BNE: under the 200,000 per-call budget) and leaves status 1, so the game retries it every frame.
  put(0x019100, [0xc2, 0x10, 0xa0, 0x00, 0x00, 0x88, 0xea, 0xd0, 0xfc, 0xe2, 0x10, ...status1, 0x60, 0xea]) // prettier-ignore
  putGrinderRoutines(put, o, draw([0xa9, 0x24, 0x99, 0x02, 0x03], [0xa9, 0x0a, 0x99, 0x03, 0x03]))
  // INIT routines that leave status 9, 0 and 1.
  for (const [addr, status] of [
    [0x018730, 9],
    [0x018740, 0],
    [0x018750, 1],
  ]) {
    put(addr, [0xa0, status, 0x98, 0x9d, 0xc8, 0x14, 0x60, 0xea]) // LDY #st / TYA / STA $14C8,X / RTS
  }
  return RomFile.fromBytes('synthetic.sfc', rom)
}
