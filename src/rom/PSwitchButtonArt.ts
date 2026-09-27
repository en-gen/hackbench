/**
 * The P-switch button's own ROM art (#574): its tiles, the pressed pair's
 * displacement and the OAM attribute bits each tile draws with. Every value is
 * read behind an opcode gate; derivations and corpus measurements are in
 * docs/rom/pswitch-button-art.md.
 */
import { RomFile } from './RomFile'
import { formatAddr } from './addressing'
import { matchesBytes, WILD, type BytePattern } from './BytePattern'
import { VRAM_CHAR_BASE } from './GfxLoader'
import { branchTarget, toSigned8 } from './dispatch/DispatchChain'

type Refusal = { ok: false; reason: string }
/** [offset from the group's resolved base, pattern, name for a refusal]. */
type Part = [number, BytePattern, string]

const STUN_DISPATCH = 0x01a1b0
const CALL_SPRITE_INIT = 0x018172
const LEVEL_MODE_LOAD = 0x0584f9
const POW_SPRITE_ID = 0x3e
const BUTTON_FRAME_PX = 16
const PRESSED_TILE_PX = 8

// prettier-ignore
export const PSWITCH_PARTS = {
  dispatch: [[0, [0xc9, 0x3e, 0xf0, WILD], 'CMP #$3E / BEQ StunPow (bank_01.asm:4516-4517)']],
  stunPow: [
    [0, [0xbc, WILD, WILD, 0xf0, WILD], 'LDY / BEQ CODE_01A218 (bank_01.asm:4565-4566)'],
    [12, [0x20, WILD, WILD], 'JSR SmushedGfxRt (bank_01.asm:4571)'],
    [18, [0xb9, WILD, WILD, 0x29, WILD, 0x99, WILD, WILD], 'tile 1 AND mask (bank_01.asm:4573-4575)'],
  ],
  unpressedSite: [
    [0, [0xa9, 0x01, 0x9d, WILD, WILD, 0x20, WILD, WILD, 0xa9, WILD], 'unpressed tile (bank_01.asm:4579-4582)'],
  ],
  smushedGfxRt: [
    [14, [0x69, WILD], 'X displacement (bank_01.asm:13899)'],
    [22, [0x69, WILD], 'Y displacement (bank_01.asm:13903)'],
    [34, [0xa9, WILD, 0xe0, 0x3e, 0xf0, WILD], 'pressed tile (bank_01.asm:13909-13911)'],
    [73, [0x09, 0x40], 'x-flip of tile 2 (bank_01.asm:13927)'],
  ],
  callSpriteInit: [
    [0, [0xa9, 0x08, 0x9d, WILD, WILD, 0xb5, WILD, 0x22, WILD, WILD, WILD], 'LDA #$08 / JSL ExecutePtr (bank_01.asm:225-229)'],
  ],
  initPSwitch: [
    [0, [0xb5, WILD], 'entry (bank_01.asm:666)'],
    [2, [0x4a, 0x4a, 0x4a, 0x4a, 0x29, 0x01], 'LSR/AND shift (bank_01.asm:667-671)'],
    [12, [0xb9, WILD, WILD], 'LDA PSwitchPal,Y (bank_01.asm:674)'],
  ],
  levelMode: [
    [0, [0x29, WILD, 0x8d, WILD, WILD, 0xaa, 0xbf, WILD, WILD, WILD, 0x85, 0x64], 'LevXYPPCCCTtbl load (bank_05.asm:539-543)'],
  ],
} satisfies Record<string, Part[]>

export interface PSwitchButtonArt {
  /** Unpressed art: one 16x16 OBJ tile number. */
  unpressedTile: number
  /** Pressed art: one 8x8 OBJ tile number, drawn twice. */
  pressedTile: number
  /** Tile 2's X displacement from tile 1, signed, 0-8. */
  xOffset: number
  /** Both pressed tiles' Y displacement, signed, 0-8. */
  yOffset: number
  /** StunPow's `AND #imm` on pressed tile 1's attribute. */
  tile1Mask: number
  /** Bits 0-3 of SpriteProperties, which every level mode agrees on. */
  spriteProperties: number
  /** PSwitchPal[0] and [1]: the blue and silver OBJ attribute bytes. */
  blueAttr: number
  silverAttr: number
}

export type PSwitchButtonArtResult = { ok: true; art: PSwitchButtonArt } | Refusal

/** Every part of one group matched at `base`, or why not. */
function readParts(rom: RomFile, base: number, parts: Part[], where: string): Buffer[] | Refusal {
  const hits: Buffer[] = []
  for (const [offset, pattern, name] of parts) {
    const hit = rom.readAt(base + offset, pattern.length)
    if (!hit || !matchesBytes(hit, pattern))
      return { ok: false, reason: `${where} (${formatAddr(base)}): ${name} no longer matches` }
    hits.push(hit)
  }
  return hits
}

const isRefusal = (r: Buffer[] | Refusal): r is Refusal => !Array.isArray(r)
const word = (b: Buffer, i: number): number => b[i]! | (b[i + 1]! << 8)

export function readPSwitchButtonArt(rom: RomFile): PSwitchButtonArtResult {
  const P = PSWITCH_PARTS
  const dispatch = readParts(rom, STUN_DISPATCH, P.dispatch, 'the sprite-stun dispatch')
  if (isRefusal(dispatch)) return dispatch
  const stunPowAt = branchTarget(dispatch[0]![3]!, STUN_DISPATCH + 2)
  const stunPow = readParts(rom, stunPowAt, P.stunPow, 'StunPow')
  if (isRefusal(stunPow)) return stunPow
  const [head, jsr, andSite] = stunPow
  const unpressedAt = branchTarget(head![4]!, stunPowAt + 3)
  const unpressed = readParts(rom, unpressedAt, P.unpressedSite, 'the unpressed-tile site')
  if (isRefusal(unpressed)) return unpressed
  const smushedAt = (stunPowAt & 0xff0000) | word(jsr!, 1)
  const smushed = readParts(rom, smushedAt, P.smushedGfxRt, 'SmushedGfxRt')
  if (isRefusal(smushed)) return smushed
  const [xSite, ySite, tileSite] = smushed

  const xOffset = toSigned8(xSite![1]!)
  const yOffset = toSigned8(ySite![1]!)
  for (const [axis, v] of [
    ['X', xOffset],
    ['Y', yOffset],
  ] as const) {
    if (v < 0 || v + PRESSED_TILE_PX > BUTTON_FRAME_PX)
      return {
        ok: false,
        reason: `SmushedGfxRt's ${axis} displacement (${v}) would draw a pressed tile outside the 16px button frame`,
      }
  }

  const pal = readPSwitchPal(rom)
  if (!pal.ok) return pal
  const props = readLevelSpriteProperties(rom)
  if (!props.ok) return props

  return {
    ok: true,
    art: {
      unpressedTile: unpressed[0]![9]!,
      pressedTile: tileSite![1]!,
      xOffset,
      yOffset,
      tile1Mask: andSite![4]!,
      spriteProperties: props.lowNibble,
      blueAttr: pal.blueAttr,
      silverAttr: pal.silverAttr,
    },
  }
}

/** PSwitchPal, reached through the sprite-init table's $3E entry rather than a literal InitPSwitch. */
function readPSwitchPal(
  rom: RomFile,
): { ok: true; blueAttr: number; silverAttr: number } | Refusal {
  const P = PSWITCH_PARTS
  const dispatcher = readParts(rom, CALL_SPRITE_INIT, P.callSpriteInit, 'CallSpriteInit')
  if (isRefusal(dispatcher)) return dispatcher
  const entryAddr = CALL_SPRITE_INIT + dispatcher[0]!.length + POW_SPRITE_ID * 2
  const entry = rom.readAt(entryAddr, 2)
  if (!entry)
    return {
      ok: false,
      reason: `the sprite init table's $3E entry (${formatAddr(entryAddr)}) is not readable`,
    }
  const initAt = (CALL_SPRITE_INIT & 0xff0000) | word(entry, 0)
  const init = readParts(rom, initAt, P.initPSwitch, 'InitPSwitch')
  if (isRefusal(init)) return init
  const palAt = (initAt & 0xff0000) | word(init[2]!, 1)
  const pal = rom.readAt(palAt, 2)
  if (!pal) return { ok: false, reason: `PSwitchPal (${formatAddr(palAt)}) is not readable` }
  // SubSprGfx2Entry1 ORs these in after skipping its EOR (bank_01.asm:4166-4173), so a
  // flip bit here flips the unpressed 16x16, which this picture does not draw.
  if ((pal[0]! | pal[1]!) & 0xc0)
    return {
      ok: false,
      reason: `PSwitchPal (${formatAddr(palAt)}) sets a flip bit, which would flip the unpressed P-switch`,
    }
  return { ok: true, blueAttr: pal[0]!, silverAttr: pal[1]! }
}

/** Bits 0-3 of SpriteProperties: LevXYPPCCCTtbl[level mode], refused unless every mode agrees. */
function readLevelSpriteProperties(rom: RomFile): { ok: true; lowNibble: number } | Refusal {
  const site = readParts(rom, LEVEL_MODE_LOAD, PSWITCH_PARTS.levelMode, 'the level-mode load')
  if (isRefusal(site)) return site
  const b = site[0]!
  const count = b[1]! + 1 // AND #mask bounds the level mode, so the index
  const table = b[7]! | (b[8]! << 8) | (b[9]! << 16)
  const name = `LevXYPPCCCTtbl (${formatAddr(table)})`
  const wram = (table & 0xffff) < 0x8000 || ((table >> 16) & 0x7e) === 0x7e
  if (wram || (table & 0xffff) + count > 0x10000) return { ok: false, reason: `${name} is not ROM` }
  const entries = rom.readAt(table, count)
  if (!entries) return { ok: false, reason: `${name} is not readable` }
  const nibbles = new Set([...entries].map(e => e & 0x0f))
  if (nibbles.size !== 1)
    return {
      ok: false,
      reason: `${name}'s level modes disagree on the OBJ name table and palette bits, so the P-switch's depends on the level`,
    }
  return { ok: true, lowNibble: [...nibbles][0]! }
}

/** The OAM attribute byte each drawn tile gets (see docs/rom/pswitch-button-art.md). */
export function pSwitchTileAttrs(
  art: PSwitchButtonArt,
  pswitchPal: number,
): { unpressed: number; pressed1: number; pressed2: number } {
  const attr = pswitchPal | art.spriteProperties
  return { unpressed: attr, pressed1: attr & art.tile1Mask, pressed2: attr | 0x40 }
}

/** An OAM tile number to the flat sp1-sp4 char number; attribute bit 0 selects the name table. */
export function spriteCharNum(oamTile: number, attr: number): number {
  const [low, high] =
    attr & 1 ? [VRAM_CHAR_BASE.sp3, VRAM_CHAR_BASE.sp4] : [VRAM_CHAR_BASE.sp1, VRAM_CHAR_BASE.sp2]
  const t = oamTile & 0xff
  return t < 0x80 ? low + t : high + (t - 0x80)
}

/** A 16x16 OBJ's four tile numbers: the column wraps in the low nibble, the row in the name table. */
export function bigObjTiles(tile: number): [number, number, number, number] {
  const right = (tile & 0xf0) | ((tile + 1) & 0x0f)
  return [tile & 0xff, right, (tile + 0x10) & 0xff, (right + 0x10) & 0xff]
}

/** OBJ attribute byte -> CGRAM row: bits 1-3 pick one of the OBJ palettes in rows 8-15. */
export function objAttrToCgramRow(attr: number): number {
  return 8 + ((attr >> 1) & 0x7)
}
