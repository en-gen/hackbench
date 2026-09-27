/**
 * Stock-shaped Map16 engine code at fixed synthetic addresses, so a stub ROM
 * carries every site `src/rom/Map16.ts` reads (#489). Each field is an operand
 * a site holds, so a test can plant a non-stock value or drop the site.
 */
import { RomFile } from '../../../src/rom/RomFile'
import { plantGfxReadPath, plantPaletteCol1ReachPath } from './syntheticGfxCart'

export interface Map16Code {
  bank: number
  bgBase: number
  bgStride: number
  /** `CPX.W` bound in bytes of Map16Pointers; the L1 (foreground) count reader sees it too. */
  bgBound: number
  slopeTileset: number
  slopeStarts: [number, number]
  slopeSource: number
  slopeLastIndex: number
  slopeStride: number
  appTable: number
  tilesetTable: number
  tilesetWord: number
  commonBase: number
  bitmapAddr: number
  /** Level reads go through a Lunar Magic style hook with this bank and CMP bound. */
  hook: { bank: number; bound: number; wrapper?: 'brl' | 'bra' } | null
  pipes: 'reached' | 'skipped'
  /** A second fill-loop count site with this bound, so the counts can disagree. */
  extraCount: number | null
}

export const STOCK_SHAPE: Map16Code = {
  bank: 0x0d,
  bgBase: 0x9100,
  bgStride: 8,
  bgBound: 0x400,
  slopeTileset: 7,
  slopeStarts: [0x1c4, 0x1ec],
  slopeSource: 0x8a70,
  slopeLastIndex: 3,
  slopeStride: 8,
  appTable: 0x058776,
  tilesetTable: 0x058000,
  tilesetWord: 0x8b70,
  commonBase: 0x8000,
  bitmapAddr: 0x0581bb,
  hook: null,
  pipes: 'reached',
  extraCount: null,
}

export type Map16Site =
  'bgLoop' | 'bgPath' | 'bank00' | 'bank05' | 'credits' | 'slopes' | 'app' | 'fgSetup'

export const SITE_ADDR: Record<
  Exclude<Map16Site, 'bank00' | 'bank05'> | 'hook' | 'wrapper',
  number
> = {
  bgPath: 0x058060,
  bgLoop: 0x05819b,
  fgSetup: 0x0581fb,
  slopes: 0x058270,
  app: 0x0587a0,
  credits: 0x0c94d5,
  hook: 0x06f540,
  wrapper: 0x06f5d0,
}
const BG_ROUTINE = 0x058126
const APP_SECOND = 0x0580c0
const CREDITS_FILL = 0x0c94a1
export const WRAPPER_BRA = 0x06f5a3
export const BANK00_SITES = [0x00c170, 0x00c252]
export const BANK05_SITES = [0x058a3c, 0x058b18, 0x058c0a, 0x058cfd]

export const w = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff]
const jsl = (to: number): number[] => [0x22, ...w(to), to >> 16]

/** A 512 KB LoROM stub with the Map16 engine code planted, minus `omit`. */
export function map16Stub(code: Partial<Map16Code> = {}, omit: Map16Site[] = []): Uint8Array {
  const bytes = new Uint8Array(0x80000)
  bytes[0xffd5] = 0x20
  const rom = RomFile.fromBytes('map16-stub.sfc', bytes)
  plantMap16Code(rom, { ...STOCK_SHAPE, ...code }, omit)
  return bytes
}

/** `map16Stub` plus the GFX read path and palette column 1, enough for
 *  `decodeMap16Sheet` to return a sheet. */
export function map16DecodeStub(): RomFile {
  const rom = new RomFile('map16-decode-stub.sfc', Buffer.from(map16Stub()))
  rom.writeAt(0x00ffd5, [0x20]) // LoROM map mode, at file $7FD5
  plantGfxReadPath(rom)
  plantPaletteCol1ReachPath(rom)
  return rom
}

export function plantMap16Code(rom: RomFile, c: Map16Code, omit: Map16Site[]): void {
  const put = (site: Map16Site, at: number, data: number[]): void => {
    if (!omit.includes(site)) rom.writeAt(at, data)
  }
  for (let t = 0; t < 15; t++) rom.writeAt(c.tilesetTable + t * 2, w(c.tilesetWord))

  // prettier-ignore
  put('fgSetup', SITE_ADDR.fgSetup, [
    0xe2, 0x30, 0xad, 0x31, 0x19, 0x0a, 0xaa, 0xa9, c.bitmapAddr >> 16, 0x85, 0x0f, 0xa9, 0x00, 0x85,
    0x84, 0xa9, 0xc4, 0x8d, 0x30, 0x14, 0xa9, 0xca, 0x8d, 0x31, 0x14, 0xc2, 0x20, 0xa9, 0x5e, 0xe5,
    0x85, 0x82, 0xbf, ...w(c.tilesetTable), c.tilesetTable >> 16, 0x85, 0x00, 0xa9, ...w(c.commonBase),
    0x85, 0x02, 0xa9, ...w(c.bitmapAddr), 0x85, 0x0d,
  ])

  // LDX.W #$B900 / STX.B _D / REP #$20 / JSR CODE_058126, whose first byte is PHP.
  // prettier-ignore
  put('bgPath', SITE_ADDR.bgPath, [0xa2, 0x00, 0xb9, 0x86, 0x0d, 0xc2, 0x20, 0x20, ...w(BG_ROUTINE)])
  put('bgPath', BG_ROUTINE, [0x08])
  // prettier-ignore
  const fill = [
    0xc2, 0x20, 0xa9, ...w(c.bgBase), 0x85, 0x00, 0xa2, 0x00, 0x00, 0xa5, 0x00, 0x9d, 0xbe, 0x0f,
    0xa5, 0x00, 0x18, 0x69, ...w(c.bgStride), 0x85, 0x00, 0xe8, 0xe8, 0xe0, ...w(c.bgBound), 0xd0, 0xec,
  ]
  put('bgLoop', SITE_ADDR.bgLoop, [...fill, 0x28, 0x60])
  // The credits copy (bank_0C.asm:790-804) ends in a bare RTS.
  rom.writeAt(CREDITS_FILL, [...fill, 0x60])
  if (c.extraCount !== null) {
    // prettier-ignore
    rom.writeAt(0x008100, [0x69, 0x08, 0x00, 0x85, 0x65, 0xe8, 0xe8, 0xe0, ...w(c.extraCount), 0xd0, 0xf3])
  }

  const run = (start: number): number[] => [0xa9, ...w(start), 0x0a, 0xa8]
  // prettier-ignore
  const loop = [
    0xa2, ...w(c.slopeLastIndex), 0xa5, 0x00, 0x99, 0xbe, 0x0f, 0x18, 0x69, ...w(c.slopeStride),
    0x85, 0x00, 0xc8, 0xc8, 0xca, 0x10, 0xf0,
  ]
  // prettier-ignore
  put('slopes', SITE_ADDR.slopes, [
    0xc0, 0x40, 0x00, 0xd0, 0xbf, 0xad, 0x31, 0x19, 0xf0, 0x04, 0xc9, c.slopeTileset, 0xd0, 0x44,
    0xa9, 0xff, 0x8d, 0x30, 0x14, 0x8d, 0x31, 0x14, 0xc2, 0x30, 0xa9, 0xc8, 0xe5, 0x85, 0x82,
    ...run(c.slopeStarts[0]), 0xa9, ...w(c.slopeSource), 0x85, 0x00, ...loop,
    ...run(c.slopeStarts[1]), ...loop,
  ])

  // prettier-ignore
  const app = [
    0x29, 0x06, 0x00, 0xaa, 0xa9, 0x33, 0x01, 0x0a, 0xa8, 0xa9, 0x07, 0x00, 0x85, 0x00,
    0xbf, ...w(c.appTable), c.appTable >> 16,
    0x99, 0xbe, 0x0f, 0xc8, 0xc8, 0x18, 0x69, 0x08, 0x00, 0xc6, 0x00, 0x10, 0xf3,
  ]
  // Each reader behind its stock index lead-in, or behind a JMP to its exit.
  for (const at of [SITE_ADDR.app, APP_SECOND]) {
    const exit = (at & 0xffff) + app.length
    // prettier-ignore
    const lead = c.pipes === 'reached'
      ? [0xe2, 0x30, 0xa5, 0x47, 0x4a, 0x4a, 0x4a, 0xc2, 0x30]
      : [0x4c, ...w(exit), 0x4a, 0x4a, 0xc2, 0x30]
    put('app', at - lead.length, [...lead, ...app])
  }
  rom.writeAt(c.appTable, [...w(0x8ab0), ...w(0x84e0), ...w(0x8af0), ...w(0x8b30)])

  const hook = c.hook
  const wrapperAt = hook?.wrapper === 'bra' ? WRAPPER_BRA : SITE_ADDR.wrapper
  // The stock ROM's two bank_00 and four bank_05 read sites.
  for (const at of BANK00_SITES) {
    const read = hook ? [...jsl(wrapperAt), 0xea] : [0xc2, 0x20, 0xb9, 0xbe, 0x0f]
    put('bank00', at, [
      0xa9,
      0xff,
      0x9f,
      0x8d,
      0x83,
      0x7f,
      0xa9,
      c.bank,
      0x85,
      0x06,
      ...read,
      0x85,
      0x04,
    ])
  }
  for (const at of BANK05_SITES) {
    const read = hook ? jsl(SITE_ADDR.hook) : [0xb9, 0xbe, 0x0f]
    // prettier-ignore
    put('bank05', at, [
      0xa0, c.bank, 0xad, 0x31, 0x19, 0xc9, 0x10, 0x30, 0x02, 0xa0, 0x05, 0x84, 0x0c, 0xc2, 0x30,
      ...read, 0x85, 0x0a,
    ])
  }
  put('credits', SITE_ADDR.credits, [0xa9, c.bank, 0x85, 0x6a, 0xbd, 0xbe, 0x0f, 0x85, 0x68])
  if (!hook) return
  // CMP #bound / BCC to the low-tile path; the expanded path it skips is not planted.
  rom.writeAt(SITE_ADDR.hook, [
    0xc9,
    ...w(hook.bound),
    0x90,
    0x10,
    ...new Array<number>(0x10).fill(0x6b),
  ])
  rom.writeAt(SITE_ADDR.hook + HOOK_LOW_AT, hookLow(hook.bank))
  rom.writeAt(wrapperAt, hookWrapper(hook.wrapper ?? 'brl', SITE_ADDR.hook - wrapperAt))
}

export const HOOK_LOW_AT = 0x15
/** The hook's low-tile path; bytes 11 and 16 are the two bank immediates. */
export function hookLow(bank: number): number[] {
  // prettier-ignore
  return [
    0xa8, 0xad, 0x30, 0x19, 0xc9, 0x00, 0x10, 0x90, 0x05, 0xa9, 0x00, 0xda, 0x80, 0x03,
    0xa9, 0x00, bank, 0x85, 0x0b, 0xb9, 0xbe, 0x0f, 0x6b,
  ]
}

/** GPW2's BRL wrapper (rel16 at 10-11) or GPW 1.2's BRA wrapper (rel8 at 10), `toHook` from its start. */
export function hookWrapper(form: 'brl' | 'bra', toHook: number): number[] {
  const tail = [0xa4, 0x0b, 0x84, 0x05, 0x7a, 0x84, 0x0b, 0x6b]
  const head = [0xc2, 0x20, 0x98, 0xd4, 0x0b, 0x4b, 0x62]
  return form === 'brl'
    ? [...head, 0x02, 0x00, 0x82, ...w((toHook - 12) & 0xffff), ...tail]
    : [...head, 0x01, 0x00, 0x80, (toHook - 11) & 0xff, ...tail]
}
