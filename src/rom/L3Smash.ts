/**
 * Where a Layer 3 Smash sprite ($89) puts layer 3 at level load (#807). Settings byte $80
 * (CODE_00A007, bank_00.asm:4184-4190) leaves Layer3YPos at $D0 (STA at :4194) and never writes
 * Layer3XPos; the smasher's main routine then writes both every frame from its own position, before
 * anything else (Layer3SmashMain, bank_02.asm:11123-11124 -> CODE_00FF61, bank_00.asm:14778-14803):
 *   X = sprite X when it is in $FF00-$00FF (signed, CMP #$FF00 BMI / CMP #$0100 BMI), else $100;
 *   Y = $A0 - sprite Y (+ ScreenShakeYOffset, 0 at load).
 * The sprite is loaded at level start only inside the window CODE_02ACA1 sweeps (bank_02.asm:5876-5910):
 * camera X - $60 up to +$190 in 16 px steps, hi byte negative skipped. Camera X is taken as 0
 * (CODE_05D83E zeroes Layer1XPos, bank_05.asm:7170); that it stays 0 for a start left of $80 is NOT
 * traced: all three vanilla maps start at $10, so the $80 boundary is unverified and a start at or
 * past it is refused. The sweep, the spawn and the init entry are fingerprinted, so the window
 * constants below are the ROM's own or layer 3 is refused. Captured frame 0 on maps $01F and $1D4
 * (layers_v5): (256,160) and (112,160).
 */
import { readL3CodeGate, type CodeSite } from './L3CodeGate'
import { readMarioStartPos } from './MarioStartPos'
import { SmwRom } from './SmwRom'
import { parseLevelSprites, type LevelSprite } from './LevelParser'
import type { RomFile } from './RomFile'

export const SMASH_SPRITE_ID = 0x89
/** Sprite MAIN pointer table (bank $01); the entry is a stub that JSLs the main routine. */
const MAIN_PTR_TABLE = 0x0185cc
/** Init pointer table (bank $01); sprite $89's entry must reach a bare RTS (bank_01.asm:368, 652-653). */
const INIT_PTR_TABLE = 0x01817d
const SMASH_WINDOW_END = 0x190
const CAMERA_LEFT_OF_CENTRE = 0x80
export const SMASH_REFUSED = 'Layer 3 not drawn yet: hooked layer 3 smash sprite'
export const SPRITES_UNREADABLE = 'Layer 3 not drawn yet: sprite data unreadable'

/**
 * SHA-256 of the stock bytes (over the 32-byte pattern threshold): CODE_00FF61..RTL, the sprite
 * loader and its spawn (DATA_02A7F6 .. LoadSprFromLevel .. JMP LoadSpriteLoopStrt, bank_02.asm:5217-5506),
 * and the start-up sweep CODE_02ACA1 (5876-5910).
 */
export const L3_SMASH_SITES: readonly CodeSite[] = [
  { addr: 0x00ff61, length: 50, sha256: '61156c5a1d73e95c1c9f966daa9464d898518da783fd9f3b48c5e208b57ffe06' },
  { addr: 0x02a7f6, length: 0x1e8, sha256: 'f83b7dcc5d6510bfeebfff51912c69b83243f5338d4425dfb05be7f4f8600eb3' },
  { addr: 0x02aca1, length: 64, sha256: '316c5d582d0f08a944753fd1b45244d6f93f94d41edb7bf997e05c31980d82f1' },
] // prettier-ignore

export interface L3Position {
  x: number
  y: number
}
export type L3SmashResult = { ok: true; pos: L3Position | null } | { ok: false; reason: string }

const startsWith = (b: Uint8Array | null, want: readonly number[]) =>
  !!b && want.every((v, i) => b[i] === v)

/** The sprite $89 pointers reach the stock stub and a bare init, the main opens with JSL CODE_00FF61, and every site is stock. */
export function readSmashCodeGate(
  rom: RomFile,
  sites: readonly CodeSite[] = L3_SMASH_SITES,
): boolean {
  const ptr = (table: number) => {
    const lo = rom.readByte(table + SMASH_SPRITE_ID * 2)
    const hi = rom.readByte(table + SMASH_SPRITE_ID * 2 + 1)
    return lo === null || hi === null ? null : 0x010000 | (hi << 8) | lo
  }
  const init = ptr(INIT_PTR_TABLE)
  if (init === null || rom.readByte(init) !== 0x60) return false
  const at = ptr(MAIN_PTR_TABLE)
  if (at === null) return false
  // PHB / LDA #$02 / PHA / PLB / JSL Layer3SmashMain (bank_01.asm:1265-1270)
  const stub = rom.readAt(at, 9)
  if (!startsWith(stub, [0x8b, 0xa9, 0x02, 0x48, 0xab, 0x22]) || stub![8] !== 0x02) return false
  const main = rom.readAt((0x02 << 16) | (stub![7]! << 8) | stub![6]!, 4)
  const first = sites[0]!.addr
  if (!startsWith(main, [0x22, first & 0xff, (first >> 8) & 0xff, first >> 16])) return false
  return readL3CodeGate(rom, sites).ok
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
  // Below $A0 on screen (y > $A0) Layer3YPos goes negative; the hardware's 10-bit wrap is not modelled, so say so.
  if (y > 0xa0) return { ok: false, reason: 'Layer 3 not drawn yet: smash sprite below $A0' }
  return { ok: true, pos: { x: x >= 0x100 ? 0x100 : x, y: 0xa0 - y } }
}

/** A level's sprite stream, or null when its pointer is unreadable or no $FF terminator lies inside the read (128 sprites fit, SpriteLoadStatus). */
export function readLevelSprites(rom: RomFile, levelId: number): LevelSprite[] | null {
  let ptr: number | null
  try {
    ptr = new SmwRom(rom).getLevelSpritePointer(levelId)
  } catch {
    return null // SmwRom refuses a cart whose map mode it cannot read
  }
  const data = ptr === null ? null : rom.readAt(ptr, 0x200)
  if (!data) return null
  let end = 1
  while (end < data.length && data[end] !== 0xff) end += 3
  return end < data.length ? parseLevelSprites(data) : null
}

export interface SmashReads {
  sprites?: (rom: RomFile, levelId: number) => LevelSprite[] | null
  sites?: readonly CodeSite[]
}

/** Layer 3's load position from the level's smash sprite, or null when it has none loaded (`$D0`, X 0 stand). */
export function readL3SmashLoadPos(
  rom: RomFile,
  levelId: number,
  reads: SmashReads = {},
): L3SmashResult {
  const sprites = (reads.sprites ?? readLevelSprites)(rom, levelId)
  if (!sprites) return { ok: false, reason: SPRITES_UNREADABLE }
  const start = readMarioStartPos(rom, levelId)
  if (!start) return { ok: false, reason: 'Layer 3 not drawn yet: Mario start unreadable' }
  const found = l3SmashPos(sprites, start.x)
  if (!found.ok || found.pos === null) return found
  return readSmashCodeGate(rom, reads.sites) ? found : { ok: false, reason: SMASH_REFUSED }
}
