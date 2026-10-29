/**
 * Where a line-guided sprite is first drawn on its line, and whether it ever appears (D156, owner ruling of 2026-10-29).
 * Interpreted from the ROM's own state and loader, no fixed frame count or pixel offset.
 */
import type { RomFile } from '../../RomFile'
import { fingerprint } from '../../Fingerprint'

/** The line step's lock state after a pass: SpriteTableC2,X ($00C2) and the lock timer SpriteMisc1540,X ($1540). */
export interface LineState {
  lock: number
  timer: number
}

/**
 * The first pass after which the sprite is on its line: the line step has locked (SpriteTableC2 = 1, CODE_01D933,
 * bank_01.asm:12116-12118) and the lock timer InitLineBrwnPlat starts (bank_01.asm:11811-11812) has run out, so the
 * walk has written a line-table point (CODE_01D7B0). Before that the lock leaves it on the probe corner (CODE_01D8A4,
 * bank_01.asm:12045-12061). The game draws each frame where the frame before ended (the draw comes before the step,
 * bank_01.asm:12204-12215), so the first line spot is drawn on the pass after.
 */
export function onLinePass(states: readonly LineState[]): number | undefined {
  const at = states.findIndex(s => s.lock === 1 && s.timer === 0)
  return at < 0 ? undefined : at
}

/** Where a spawn left the sprite's parts along the scroll axis, in screen pixels, or null when it drew nothing. */
export interface Spawn {
  /** 1 scrolling right/down, -1 left/up, 0 the map-load window (no scroll). */
  dir: -1 | 0 | 1
  extent: { lo: number; hi: number } | null
}

/**
 * A spawn shows the sprite when it is not behind the scroll: scrolling right only moves the screen away from a sprite
 * entirely left of it. A still camera is NOT conservative (a sprite behind it drifts into view at its own speed), so
 * the test is the side it starts on, not a run of frames. "Starts behind", not "can never be seen".
 */
export function appears({ dir, extent }: Spawn, screen: number): boolean {
  if (!extent) return false
  if (dir > 0) return extent.hi > 0
  if (dir < 0) return extent.lo < screen
  return extent.hi > 0 && extent.lo < screen
}

/** Never appears in play: no spawn the loader allows shows it. No spawn at all proves nothing. */
export const neverAppears = (spawns: readonly Spawn[], screen: number): boolean =>
  spawns.length > 0 && spawns.every(s => !appears(s, screen))

/**
 * LoadSprFromLevel (bank_02.asm:5217-5280) with the two offset tables before it: a sprite spawns when
 * (camera + offset) & $F0 is its column, offset by scroll direction (DATA_02A7F6/DATA_02A7F9, 16 bits each, index 0
 * left/up, 2 right/down; ScrollDir is $55). Read from the ROM only when the routine and its tables hash to the stock
 * ones (86 bytes, one digest, vanilla US, one machine); any other cart gets null and no never-appears call.
 */
const LOADER = {
  at: 0x02a7f6,
  len: 86,
  sha: 'ad9e12473a8247b2b1cd48cfec4dc3cb1b710b120e5d71d50398320f94dd6edf',
}
export function loaderWindow(rom: RomFile): { right: number; left: number } | null {
  const b = rom.readAt(LOADER.at, LOADER.len)
  if (!b || fingerprint(b) !== LOADER.sha) return null
  const word = (i: number) => ((b[i]! | (b[3 + i]! << 8)) << 16) >> 16
  return { left: word(0), right: word(2) }
}
