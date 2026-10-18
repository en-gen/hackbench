/**
 * Where a Layer 3 Smash sprite ($89) first puts layer 3 on a map (#807, #997): worked out by running
 * the ROM's own level loader, start-up sweep and sprite loop (sprites/interp/SmashLanding.ts), so the
 * position is whatever the code gives from the power-on RNG, not a stored number. Settings byte $80
 * (CODE_00A007, bank_00.asm:4184-4195) leaves Layer3YPos at $D0 until the smasher's main writes both
 * cells every frame (Layer3SmashMain, bank_02.asm:11123-11124 -> CODE_00FF61, bank_00.asm:14778-14803).
 * A map with no smasher in its sprite list keeps $D0 and X 0 (`pos` null). A step that cannot run refuses
 * with its reason, and the map view then keeps those load-time values with an unverified-position note.
 */
import { firstLanding, SMASH_SPRITE_ID, type LandingResult } from './sprites/interp/SmashLanding'
import { parseLevelSprites, type LevelSprite } from './LevelParser'
import type { RomFile } from './RomFile'
import { SmwRom } from './SmwRom'

export interface L3Position {
  x: number
  y: number
}
export type L3SmashResult = { ok: true; pos: L3Position | null } | { ok: false; reason: string }

/** A map's sprite list, or null when its pointer is unreadable or no $FF terminator lies inside the read (128 sprites fit). */
export function readMapSprites(rom: RomFile, mapId: number): LevelSprite[] | null {
  let ptr: number | null
  try {
    ptr = new SmwRom(rom).getLevelSpritePointer(mapId)
  } catch {
    return null // SmwRom refuses a cart whose map mode it cannot read
  }
  const data = ptr === null ? null : rom.readAt(ptr, 0x200)
  if (!data) return null
  let end = 1
  while (end < data.length && data[end] !== 0xff) end += 3
  return end < data.length ? parseLevelSprites(data) : null
}

/**
 * Layer 3's first-landing position on `mapId`. The sprite list is read first, so a map with no smash
 * sprite is a plain null (the load-time position) whatever the interpreter could do with this ROM; only
 * a map that lists one runs the landing. A refusal here is the caller's to show as an unverified position.
 */
export function readL3SmashLoadPos(
  rom: RomFile,
  mapId: number,
  landing: (rom: RomFile, map: number) => LandingResult = firstLanding,
  sprites: (rom: RomFile, map: number) => LevelSprite[] | null = readMapSprites,
): L3SmashResult {
  const list = sprites(rom, mapId)
  if (!list) return { ok: false, reason: 'the sprite list could not be read' }
  if (!list.some(s => s.spriteId === SMASH_SPRITE_ID)) return { ok: true, pos: null }
  const r = landing(rom, mapId)
  return r.ok ? { ok: true, pos: r.landing } : r
}
