/**
 * The L2 uploader dispatch (bank_05.asm:111-114, 1099-1135) as stock bytes in a zeroed 512 KB
 * ROM, with every routine it names planted just far enough to be classified, so a test can
 * flip any byte of the chain without a cart.
 */
import type { RomFile } from '../../../src/rom/RomFile'

export const CALLER_AT = 0x0580bd
export const SITE_AT = 0x058955
export const EXEC_AT = 0x00d000
export const IMAGE_AT = 0x058d7a
export const OBJ_A_AT = 0x058b8d
export const OBJ_B_AT = 0x058c71
export const NONE_AT = 0x058c70

export const IMAGE_MODES = [0x00, 0x0a, 0x0c, 0x0d, 0x0e, 0x11, 0x1e]
export const OBJECT_MODES = [1, 2, 3, 4, 5, 6, 7, 8, 0x0f, 0x1f]
export type StockKind = 'image' | 'objects' | 'none'
export const stockKind = (mode: number): StockKind =>
  IMAGE_MODES.includes(mode) ? 'image' : OBJECT_MODES.includes(mode) ? 'objects' : 'none'

const long = (a: number) => [a & 0xff, (a >> 8) & 0xff, (a >> 16) & 0xff]
// prettier-ignore
const objectsHead = [0x08, 0xc2, 0x30, 0xad, 0x25, 0x19, 0x29, 0xff, 0x00, 0x0a, 0xaa, 0xe2, 0x20, 0xa0, 0x00, 0x00]
// prettier-ignore
const imageHead = [0x08, 0xe2, 0x30, 0xad, 0x2b, 0x19, 0x29, 0x0f, 0x0a, 0x8d, 0x0c, 0x19, 0xa0, 0x30]
// prettier-ignore
const execHead = [0x84, 0x05, 0x7a, 0x84, 0x02, 0xc2, 0x30, 0x29, 0xff, 0x00, 0x85, 0x03, 0x0a, 0x65, 0x03, 0xa8]
// REP #$30 / JSL CODE_0588EC / JSL CODE_058955 / JSL UploadOneMap16Strip
// prettier-ignore
const callerBytes = [0xc2, 0x30, 0x22, 0xec, 0x88, 0x05, 0x22, 0x55, 0x89, 0x05, 0x22, 0xad, 0x87, 0x00]

const stockTarget = (m: number): number =>
  ({ image: IMAGE_AT, objects: OBJ_A_AT, none: NONE_AT })[stockKind(m)]

/** Plant the stock chain; `target` overrides what each mode jumps to. */
export function plantUploaderTable(
  rom: RomFile,
  target: (mode: number) => number = stockTarget,
): void {
  rom.writeAt(CALLER_AT, callerBytes)
  rom.writeAt(SITE_AT, [0xe2, 0x30, 0xad, 0x25, 0x19, 0x22, ...long(EXEC_AT)])
  rom.writeAt(EXEC_AT, execHead)
  rom.writeAt(IMAGE_AT, imageHead)
  rom.writeAt(OBJ_A_AT, objectsHead)
  rom.writeAt(OBJ_B_AT, objectsHead)
  rom.writeAt(NONE_AT, [0x6b])
  for (let m = 0; m < 32; m++) rom.writeAt(SITE_AT + 9 + m * 3, long(target(m)))
}
