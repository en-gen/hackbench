/**
 * The L2 uploader dispatch (bank_05.asm:111-114, 1099-1135) as stock bytes in a zeroed 512 KB
 * ROM, with every routine it names planted just far enough to be classified, so a test can
 * flip any byte of the chain without a cart.
 */
import type { RomFile } from '../../../src/rom/RomFile'

// Made-up addresses and a made-up mode mapping: the stock ones are asserted only in the
// corpus-gated tests, read from the ROM (docs/testing.md, no vanilla tables committed).
export const CALLER_AT = 0x069000
export const SITE_AT = 0x06a000
export const EXEC_AT = 0x00d000
export const IMAGE_AT = 0x07a000
export const OBJ_A_AT = 0x07b000
export const OBJ_B_AT = 0x07c000
export const NONE_AT = 0x07d000

export type PlantedKind = 'image' | 'objects' | 'none'
/**
 * `(mode + bit 4) % 4`: every kind appears, interleaved, and mode m differs from m + 16, so a
 * reader that masks the mode with $0F instead of $1F is caught.
 */
export const plantedKind = (mode: number): PlantedKind =>
  (['image', 'objects', 'none', 'objects'] as const)[(mode + (mode >> 4)) % 4]!

const long = (a: number) => [a & 0xff, (a >> 8) & 0xff, (a >> 16) & 0xff]
// prettier-ignore
const objectsHead = [0x08, 0xc2, 0x30, 0xad, 0x25, 0x19, 0x29, 0xff, 0x00, 0x0a, 0xaa, 0xe2, 0x20, 0xa0, 0x00, 0x00]
// prettier-ignore
const imageHead = [0x08, 0xe2, 0x30, 0xad, 0x2b, 0x19, 0x29, 0x0f, 0x0a, 0x8d, 0x0c, 0x19, 0xa0, 0x30]
// prettier-ignore
const execHead = [0x84, 0x05, 0x7a, 0x84, 0x02, 0xc2, 0x30, 0x29, 0xff, 0x00, 0x85, 0x03, 0x0a, 0x65, 0x03, 0xa8]
// REP #$30 / JSL CODE_0588EC / JSL CODE_058955 / JSL UploadOneMap16Strip
// prettier-ignore
const callerBytes = [0xc2, 0x30, 0x22, 0x10, 0x91, 0x06, 0x22, ...long(SITE_AT), 0x22, 0x20, 0x92, 0x06]

const stockTarget = (m: number): number =>
  ({ image: IMAGE_AT, objects: OBJ_A_AT, none: NONE_AT })[plantedKind(m)]

/** Plant the planted chain; `target` overrides what each mode jumps to. */
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
