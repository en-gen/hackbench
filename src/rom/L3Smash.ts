/**
 * Where a Layer 3 Smash sprite ($89) puts layer 3 at level load (#807). Settings byte $80
 * (CODE_00A007, bank_00.asm:4184-4190) leaves Layer3YPos at $D0 and never writes Layer3XPos;
 * the smasher's main routine then writes both every frame from its own position, before
 * anything else (Layer3SmashMain, bank_02.asm:11123-11124 -> CODE_00FF61, bank_00.asm:14778-14803):
 *   X = sprite X, or $100 when it is outside $0000-$00FF; Y = $A0 - sprite Y (+ ScreenShakeYOffset, 0 at load).
 * The sprite is loaded at level start only inside the window CODE_02ACA1 sweeps (bank_02.asm:5876-5903):
 * camera X - $60 up to +$190 in 16 px steps, hi byte negative skipped. Camera X is 0 at load
 * (bank_05.asm:7170) and stays 0 while Mario starts left of the screen centre; any other start is
 * refused, not guessed. Captured frame 0 on maps $01F and $1D4 (layers_v5): (256,160) and (112,160).
 */
import { createHash } from 'crypto'
import type { CodeSite } from './L3CodeGate'
import { readMarioStartPos } from './L3Loader'
import { readSpritePointerSite } from './LevelTableGate'
import { parseLevelSprites, type LevelSprite } from './LevelParser'
import type { RomFile } from './RomFile'

export const SMASH_SPRITE_ID = 0x89
/** Sprite MAIN pointer table (bank $01); the entry is a stub that JSLs the main routine. */
const MAIN_PTR_TABLE = 0x0185cc
const SMASH_WINDOW_END = 0x190
const CAMERA_LEFT_OF_CENTRE = 0x80
export const SMASH_REFUSED = 'Layer 3 not drawn yet: hooked layer 3 smash sprite'

/** CODE_00FF61 .. its RTL, SHA-256 of the stock bytes (over the 32-byte pattern threshold). */
export const L3_SMASH_SITE: CodeSite = { addr: 0x00ff61, length: 50, sha256: '61156c5a1d73e95c1c9f966daa9464d898518da783fd9f3b48c5e208b57ffe06' } // prettier-ignore

export interface L3Position {
  x: number
  y: number
}
export type L3SmashResult = { ok: true; pos: L3Position | null } | { ok: false; reason: string }

const startsWith = (b: Uint8Array | null, want: readonly number[]) =>
  !!b && want.every((v, i) => b[i] === v)

/** The sprite $89 pointer reaches a JSL to a routine that opens with JSL CODE_00FF61, and that routine is the stock one. */
export function readSmashCodeGate(rom: RomFile, site: CodeSite = L3_SMASH_SITE): boolean {
  const lo = rom.readByte(MAIN_PTR_TABLE + SMASH_SPRITE_ID * 2)
  const hi = rom.readByte(MAIN_PTR_TABLE + SMASH_SPRITE_ID * 2 + 1)
  if (lo === null || hi === null) return false
  // PHB / LDA #$02 / PHA / PLB / JSL Layer3SmashMain (bank_01.asm:1265-1270)
  const stub = rom.readAt(0x010000 | (hi << 8) | lo, 9)
  if (!startsWith(stub, [0x8b, 0xa9, 0x02, 0x48, 0xab, 0x22]) || stub![8] !== 0x02) return false
  const main = rom.readAt((0x02 << 16) | (stub![7]! << 8) | stub![6]!, 4)
  const [a, b, c] = [site.addr & 0xff, (site.addr >> 8) & 0xff, site.addr >> 16]
  if (!startsWith(main, [0x22, a, b, c])) return false
  const body = rom.readAt(site.addr, site.length)
  return !!body && createHash('sha256').update(Buffer.from(body)).digest('hex') === site.sha256
}

/** Pure part: the smashers among a level's sprites, Mario's start X, and the position they give layer 3. */
export function l3SmashPos(sprites: readonly LevelSprite[], startX: number): L3SmashResult {
  const smashers = sprites.filter(s => s.spriteId === SMASH_SPRITE_ID)
  if (smashers.length === 0) return { ok: true, pos: null }
  if (startX >= CAMERA_LEFT_OF_CENTRE) {
    return { ok: false, reason: 'Layer 3 not drawn yet: camera X at load not derived' }
  }
  const loaded = smashers.filter(s => s.x * 16 <= SMASH_WINDOW_END)
  if (loaded.length > 1)
    return { ok: false, reason: 'Layer 3 not drawn yet: several smash sprites' }
  if (loaded.length === 0) return { ok: true, pos: null }
  // The parser's x and y are in 16 px units (LevelParser.ts:491-512).
  const x = loaded[0]!.x * 16
  const y = loaded[0]!.y * 16
  return { ok: true, pos: { x: x < 0x100 ? x : 0x100, y: (0xa0 - y) & 0xffff } }
}

/** Layer 3's load position from the level's smash sprite, or null when it has none loaded (`$D0`, X 0 stand). */
export function readL3SmashLoadPos(rom: RomFile, levelId: number): L3SmashResult {
  const site = readSpritePointerSite(rom)
  if (!site.ok) return { ok: false, reason: site.reason }
  const lo = rom.readByte(site.tableAddr + levelId * 2)
  const hi = rom.readByte(site.tableAddr + levelId * 2 + 1)
  const bank =
    site.bank.kind === 'fixed' ? site.bank.bank : rom.readByte(site.bank.tableAddr + levelId)
  if (lo === null || hi === null || bank === null) return { ok: false, reason: SMASH_REFUSED }
  const data = rom.readAt((bank << 16) | (hi << 8) | lo, 0x200)
  const sprites = data ? parseLevelSprites(data) : []
  const found = l3SmashPos(sprites, readMarioStartPos(rom, levelId).x)
  if (!found.ok || found.pos === null) return found
  return readSmashCodeGate(rom) ? found : { ok: false, reason: SMASH_REFUSED }
}
