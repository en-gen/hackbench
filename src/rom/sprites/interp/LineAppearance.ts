/** Where a line-guided sprite is first drawn on its line, and whether it ever appears (D156). Read from the ROM's own state and loader. */
import type { RomFile } from '../../RomFile'
import { fingerprint } from '../../Fingerprint'

/** The line step's lock state after a pass: SpriteTableC2,X ($00C2) and the lock timer SpriteMisc1540,X ($1540). */
export interface LineState {
  lock: number
  timer: number
}

/**
 * The first pass after which the sprite is on its line: locked (SpriteTableC2 = 1, bank_01.asm:12116-12118) with the
 * timer InitLineBrwnPlat starts (bank_01.asm:11809-11810) run out. The lock alone leaves it on the probe corner
 * (bank_01.asm:12045-12061). The draw comes before the step (bank_01.asm:12204-12215), so the line spot is drawn next pass.
 */
export function onLinePass(states: readonly LineState[]): number | undefined {
  const at = states.findIndex(s => s.lock === 1 && s.timer === 0)
  return at < 0 ? undefined : at
}

/** Where a spawn left the sprite's parts along the scroll axis (screen pixels), or null when it drew nothing. */
export interface Spawn {
  /** 1 scrolling right/down, -1 left/up, 0 the map-load window (no scroll). */
  dir: -1 | 0 | 1
  extent: { lo: number; hi: number } | null
}

/** Shown unless behind the scroll. A still camera is not conservative (a sprite behind it drifts in), so: the side it starts on. */
export function appears({ dir, extent }: Spawn, screen: number): boolean {
  if (!extent) return false
  if (dir > 0) return extent.hi > 0
  if (dir < 0) return extent.lo < screen
  return extent.hi > 0 && extent.lo < screen
}

/** Never appears in play: no spawn the loader allows shows it. No spawn at all proves nothing. */
export const neverAppears = (spawns: readonly Spawn[], screen: number): boolean =>
  spawns.length > 0 && spawns.every(s => !appears(s, screen))

/** A routine's bytes named by one SHA-256 (whole span, vanilla US, one machine). */
export interface LoaderDigest {
  at: number
  len: number
  sha: string
}

/**
 * LoadSprFromLevel with its offset tables, DATA_02A7F6 to the column compare (bank_02.asm:5217-5281): a sprite spawns when
 * (camera + offset) & $F0 is its column; DATA_02A7F6/DATA_02A7F9 hold 16-bit offsets, index 0 left/up, 2 right/down.
 * 96 bytes in one digest, none stated elsewhere (D126).
 */
export const LOADER: LoaderDigest = {
  at: 0x02a7f6,
  len: 96,
  sha: '309784bc22b4810a3da31cedfaf5d00ba6c4d5e2412738d4f861398f44d43eea',
}

/** The offsets, or null when the loader is not the stock one (the caller then says it could not check). */
export function loaderWindow(
  rom: RomFile,
  d: LoaderDigest = LOADER,
): { right: number; left: number } | null {
  const b = rom.readAt(d.at, d.len)
  if (!b || fingerprint(b) !== d.sha) return null
  const word = (i: number) => ((b[i]! | (b[3 + i]! << 8)) << 16) >> 16
  return { left: word(0), right: word(2) }
}
