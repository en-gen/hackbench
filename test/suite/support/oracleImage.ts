/**
 * Oracle-only WRAM images built from Mesen captures, for COMPARISON runs
 * (how much does a ROM-derived seed lose against a perfect one). They live in
 * test support on purpose: the runner's seed has one whole-WRAM entry,
 * `loaded`, which `loadLevelState` fills from the ROM; nothing under src/ can
 * name a capture-shaped field, so a capture cannot become a runtime input.
 */
import { WRAM_SIZE } from '../../../src/rom/sprites/interp/SpriteBus'

/** The level-header and Mario cells of a level-load WRAM image, as an oracle image. */
export function oracleCells(w: Uint8Array): Uint8Array {
  const img = new Uint8Array(WRAM_SIZE)
  for (const a of [0x5b, 0x5d, 0x64, 0x76, 0x82, 0x83, 0x85, 0x86, 0x1692, 0x190e]) img[a] = w[a]
  return img
}

/** An oracle image: the level cells or whole low WRAM, plus Map16 and extra blocks. */
export function oracleImage(opts: {
  wram?: Uint8Array
  cells?: Uint8Array
  map16?: { low: Uint8Array; high: Uint8Array }
  blocks?: { offset: number; bytes: Uint8Array }[]
}): Uint8Array {
  const img = new Uint8Array(WRAM_SIZE)
  if (opts.cells) img.set(opts.cells)
  if (opts.wram) img.set(opts.wram.subarray(0, 0x2000))
  if (opts.map16) {
    img.set(opts.map16.low, 0xc800)
    img.set(opts.map16.high, 0x1c800)
  }
  for (const b of opts.blocks ?? []) img.set(b.bytes, b.offset)
  return img
}
