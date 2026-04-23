/**
 * SpriteTileLoader.ts -- loads the per-sprite-ID tile layout tables used by
 * SMW's generic sprite draw routines.
 *
 * SubSprGfx2Entry1 (bank_01.asm:4148) is the dominant routine — used by
 * roughly 60 of the ~80 call sites in bank_01-04 (Goombas, Koopas, Buzzy
 * Beetles, Rex, Chuck variants, etc.). It writes ONE OAM entry with the
 * hardware's "large" (16x16) tile-size bit set, so a single char number N
 * expands to the contiguous 4-char block [N, N+1, N+$10, N+$11] — that's
 * TL, TR, BL, BR in a 2x2 grid within OBJ VRAM.
 *
 * We port that semantics here: SprTilemap[SprTilemapOffset[id]] gives the
 * base char N, and buildSpriteLayout returns the four implicit 8x8 corners.
 *
 * SubSprGfx0 (four independent 8x8 chars) and SubSprGfx1 (two stacked
 * 16x16 big-tiles, 16x32 total) are used by minority paths that this
 * loader doesn't model yet — those sprites will render using the wrong
 * layout until we differentiate per sprite ID.
 *
 * Sprite166EVals (bank_07.asm:792) is the spawn-time source for
 * SpriteOBJAttribute — LoadSpriteTables in bank_07.asm:977 reads this byte,
 * masks it with $0F (so only the palette bits and char-high bit survive),
 * and stores it as the sprite's OAM attribute. Flip bits and priority are
 * left zero and get set later by per-sprite handlers at runtime.
 *
 * ROM addresses come from SMW_U.sym:
 *   $01:9B83 SprTilemap         (variable-length flat table, ~252 bytes)
 *   $01:9C7F SprTilemapOffset   (84 bytes, one per sprite ID 0x00..0x53)
 *   $01:9CD3 GeneralSprDispX    (4 bytes)
 *   $01:9CD7 GeneralSprDispY    (4 bytes)
 *   $07:F3FE Sprite166EVals     (~257 bytes; low nibble = default OAM attr)
 *
 * Sprite IDs beyond 0x53 use custom per-sprite draw routines (SubSprGfx1,
 * handwritten routines) that this loader does not model. Callers should
 * treat a missing entry as "no generic layout available."
 */

import { RomFile } from './RomFile'

export const SPR_TILEMAP_ADDR          = 0x019B83
export const SPR_TILEMAP_OFFSET_ADDR   = 0x019C7F
export const GENERAL_SPR_DISP_X_ADDR   = 0x019CD3
export const GENERAL_SPR_DISP_Y_ADDR   = 0x019CD7
export const SPRITE_166E_VALS_ADDR     = 0x07F3FE
export const SPR_0_TO_13_PROP_ADDR     = 0x0188F0

export const SPR_TILEMAP_OFFSET_COUNT  = 0x54   // sprites 0x00..0x53
export const SPR_TILEMAP_LEN           = 0xFC   // 0x9C7F - 0x9B83
export const SPRITE_166E_VALS_COUNT    = 0x100
export const SPR_0_TO_13_PROP_COUNT    = 0x14   // sprites 0x00..0x13

/** Raw sprite tile layout data read from ROM. */
export interface SpriteTileTables {
  /** Flat table of 8-bit OBJ tile numbers referenced by tilemap offsets. */
  tilemap: Uint8Array
  /** One offset per sprite ID (0x00..0x53) into `tilemap`. */
  tilemapOffset: Uint8Array
  /** Corner X offsets — indexed 0..3 = TL, TR, BL, BR. */
  dispX: number[]
  /** Corner Y offsets — same indexing as dispX. */
  dispY: number[]
  /** OAM attribute byte per sprite ID (vhoopppc): flip, priority, OBJ palette, tile high bit. */
  spriteAttr: Uint8Array
  /** Spr0to13 property byte per sprite ID (0x00..0x13).
   *  Bit 6 set = sprite is drawn 16x32 (two stacked big-tiles) via SubSprGfx1. */
  spr0to13Prop: Uint8Array
}

export function readSpriteTileTables(rom: RomFile): SpriteTileTables | null {
  const tilemap        = rom.readAt(SPR_TILEMAP_ADDR,        SPR_TILEMAP_LEN)
  const tilemapOffset  = rom.readAt(SPR_TILEMAP_OFFSET_ADDR, SPR_TILEMAP_OFFSET_COUNT)
  const dispXBuf       = rom.readAt(GENERAL_SPR_DISP_X_ADDR, 4)
  const dispYBuf       = rom.readAt(GENERAL_SPR_DISP_Y_ADDR, 4)
  const rawAttr        = rom.readAt(SPRITE_166E_VALS_ADDR,   SPRITE_166E_VALS_COUNT)
  const spr0to13Prop   = rom.readAt(SPR_0_TO_13_PROP_ADDR,   SPR_0_TO_13_PROP_COUNT)
  if (!tilemap || !tilemapOffset || !dispXBuf || !dispYBuf || !rawAttr || !spr0to13Prop) return null
  // Match LoadSpriteTables (bank_07.asm:978) — only the low nibble of
  // Sprite166EVals feeds SpriteOBJAttribute (palette + char-high bit).
  const spriteAttr = new Uint8Array(rawAttr.length)
  for (let i = 0; i < rawAttr.length; i++) spriteAttr[i] = rawAttr[i] & 0x0F
  return {
    tilemap: new Uint8Array(tilemap),
    tilemapOffset: new Uint8Array(tilemapOffset),
    dispX: Array.from(dispXBuf),
    dispY: Array.from(dispYBuf),
    spriteAttr,
    spr0to13Prop: new Uint8Array(spr0to13Prop),
  }
}

/** One 8x8 subtile entry for a sprite corner. */
export interface SpriteSubtile {
  /** Flat VRAM char index (0..1535) matching hackbench's `vramIndexed` layout. */
  charNum: number
  /** CGRAM row (8..15 for OBJ palettes). */
  palette: number
  flipX: boolean
  flipY: boolean
  /** Corner X offset in pixels relative to sprite anchor. */
  dx: number
  /** Corner Y offset in pixels relative to sprite anchor. */
  dy: number
}

/** Layout for a single sprite ID (frame 0 of animated sprites).
 *
 *  `height` is 16 for SubSprGfx2 sprites (one big-tile → 4 8x8 corners) or
 *  32 for SubSprGfx1 sprites (two stacked big-tiles → 8 8x8 corners). Corner
 *  dy values are relative to the sprite's anchor, where anchor Y is the
 *  bottom-of-visual-box row — so tall sprites have dy in [-16..+8] and short
 *  sprites have dy in [0..8].
 *
 *  `width` is 16 for the common case (one big-tile column) or 32 for
 *  wide sprites like Thwomp that draw 2 columns of big-tiles side by side.
 *  Wide sprites always use dy in [0..31] (top-anchored, not bottom-anchored).
 */
export interface SpriteLayout {
  spriteId: number
  height: 16 | 32
  width?: 16 | 32
  tiles: SpriteSubtile[]
}

/**
 * Per-sprite-ID OBJ base-tile override for sprite IDs 0x54-0xC8.
 *
 * Sprites below 0x54 have entries in the ROM's SprTilemapOffset table and
 * render through the shared SubSprGfx0/1/2 code, which this loader already
 * handles. Sprites in 0x54..0xC8 use handwritten OAM construction inside
 * their own handlers — there's no single SMW data table covering them. This
 * map was auto-extracted from CallSpriteMain (bank_01.asm:898-1098) plus
 * Bnk3CallSprMain's dispatch chain (bank_03.asm:4305+), by following each
 * handler up to depth 3 and capturing the first `LDA ... STA OAMTileNo`
 * pair — either an immediate like `LDA #$CA` or an indexed load like
 * `LDA PokeyTiles,X` whose first data byte is taken as the base char.
 *
 * The base char drives a 16x16 SubSprGfx2-style layout (hardware large-tile
 * expansion to chars [N, N+1, N+$10, N+$11]). This is a faithful preview
 * for most sprites, but several have visually distinct layouts the loader
 * can't model without a full per-handler port — e.g. Banzai Bill (32x32),
 * Wiggler (multi-segment), Pokey (vertical stack). Those still appear as
 * a single 16x16 tile that matches one part of their full body.
 *
 * IDs 0xDA-0xDD are shell aliases (resolveShellAlias).
 * IDs in (0x54..0xC8) not listed here — and 0xC9..0xE7 (generators, scroll
 * sprites) — fall through to the anchor marker.
 */
const SPRITE_BASE_TILE_OVERRIDES: Readonly<Record<number, number>> = {
  0x54: 0x08,   // Climbing net door
  0x55: 0xEA,   // Checkerboard platform, horizontal
  0x56: 0xEA,   // Flying rock platform, horizontal
  0x57: 0xEA,   // Checkerboard platform, vertical
  0x58: 0xEA,   // Flying rock platform, vertical
  0x59: 0x40,   // Turn block bridge, horizontal and vertical
  0x5A: 0x40,   // Turn block bridge, horizontal
  0x5E: 0xEA,   // Orange platform, goes on forever
  0x5F: 0xA2,   // Brown platform on a chain
  0x60: 0x00,   // Flat green switch palace switch
  0x61: 0xE2,   // Floating skulls
  0x62: 0xC8,   // Brown platform, line-guided
  0x63: 0xC8,   // Checker/brown platform, line-guided
  0x5B: 0x60,   // Brown platform floating in water — CODE_01B344 base tile (SpriteMisc1602=0)
  0x5C: 0xEA,   // Checkerboard platform that falls — CODE_01B2DF tile (SpriteMisc1602=1 from InitFallingPlat)
  0x5D: 0xCB,   // Orange platform floating in water — DiagPlatTiles[0], bank_01.asm:6989
  0x64: 0xAE,   // Rope mechanism, line-guided
  0x65: 0xAE,   // Chainsaw, line-guided
  0x66: 0xAE,   // Upside down chainsaw, line-guided
  0x67: 0x6C,   // Grinder, line-guided — CODE_01DC0B: (EffFrame & 2) | $6C, bank_01.asm:12534
  0x68: 0xC8,   // Fuzz ball, line-guided
  0x6A: 0x60,   // Coin game cloud
  0x6B: 0x3D,   // Spring board, left wall
  0x6C: 0x3D,   // Spring board, right wall
  0x6D: 0x80,   // Invisible solid block
  0x6E: 0x80,   // Dino Rhino
  0x6F: 0x80,   // Dino Torch
  0x70: 0xE8,   // Pokey
  0x71: 0xC8,   // Super Koopa, red cape
  0x72: 0xC8,   // Super Koopa, yellow cape
  0x73: 0xC8,   // Super Koopa, feather
  0x74: 0x24,   // Mushroom — PowerUpTiles[0], bank_01.asm:9528
  0x75: 0x26,   // Fire Flower — PowerUpTiles[1]
  0x76: 0x48,   // Star — PowerUpTiles[2]
  0x77: 0x44,   // Feather — (feather sprite uses char $44 in SP2)
  0x78: 0x0E,   // 1-Up — PowerUpTiles[3]
  0x79: 0xAE,   // Growing Vine
  0x7A: 0xAE,   // Firework — Bank3SprHandler, uses same particle tile range as vine
  0x7B: 0xD4,   // Goal Point
  0x7C: 0x6E,   // Princess Peach
  0x7D: 0x5D,   // Balloon
  0x7E: 0x5D,   // Flying Red coin
  0x7F: 0x5D,   // Flying yellow 1-Up
  0x80: 0x5D,   // Key
  0x81: 0x80,   // Changing item from translucent block
  0x82: 0xE4,   // Bonus game sprite
  0x83: 0x2A,   // Left flying question block (initial/unhit state; $2E after hit)
  0x84: 0x2A,   // Flying question block (initial/unhit state; $2E after hit)
  0x85: 0x2A,   // Unused sprite — per-frame InitFlying_Block; shares tile with 0x83/0x84
  0x86: 0xC4,   // Wiggler — WigglerTiles first byte, bank_02.asm:14984
  0x87: 0x60,   // Lakitu's cloud
  0x88: 0xC6,   // Winged cage (unused) — ADDR_02CCB9: BCC→$C6, bank_02.asm:10161
  0x8A: 0xD2,   // Bird from Yoshi's house — BirdsTilemap[0], bank_02.asm:15379
  0x8B: 0xC5,   // Puff of smoke from Yoshi's house
  0x8C: 0x60,   // Fireplace smoke/exit from side screen
  0x8D: 0x9C,   // Ghost house exit sign and door
  0x8F: 0x80,   // Scale platforms
  0x90: 0x80,   // Large green gas bubble
  0x91: 0x06,   // Chargin' Chuck — ChuckHeadTiles[0], bank_02.asm:9621
  0x92: 0x06,   // Splittin' Chuck
  0x93: 0x06,   // Bouncin' Chuck
  0x94: 0x06,   // Whistlin' Chuck
  0x95: 0x06,   // Clapin' Chuck
  0x96: 0x06,   // Unused Chargin' Chuck clone
  0x97: 0x06,   // Puntin' Chuck
  0x98: 0x06,   // Pitchin' Chuck
  0x99: 0xCE,   // Volcano Lotus
  0x9A: 0x98,   // Sumo Brother
  0x9C: 0x40,   // Flying blocks for Hammer Brother
  0x9D: 0xAA,   // Bubble with sprite
  0x9E: 0xA2,   // Ball and Chain — sphere at start of BanzaiBnCGrayPlat
  0x9F: 0x80,   // Banzai Bill — top-left char of BanzaiBillTiles (bank_02.asm:11331)
  0xA0: 0xE3,   // Activates Bowser scene
  0xA1: 0x45,   // Bowser's bowling ball
  0xA2: 0x40,   // MechaKoopa
  0xA3: 0xA2,   // Grey platform on chain
  0xA4: 0xAA,   // Floating Spike ball — CODE_01B666: (EffFrame>>2&2) | $AA, bank_01.asm:12413
  0xA5: 0xC8,   // Fuzzball/Sparky, ground-guided
  0xA6: 0xC8,   // HotHead, ground-guided
  0xA7: 0x4A,   // Iggy's ball
  0xA8: 0xA0,   // Blargg
  0xA9: 0x40,   // Reznor — ReznorTiles[0], bank_03.asm
  0xAA: 0xA8,   // Fishbone
  0xAC: 0x6A,   // Wooden Spike, moving down and up
  0xAD: 0x6A,   // Wooden Spike, moving up/down first
  0xAE: 0xCC,   // Fishin' Boo
  0xAF: 0x8C,   // Boo Block
  0xB0: 0x88,   // Reflecting stream of Boo Buddies
  0xB1: 0x2E,   // Creating/Eating block
  0xB2: 0xE0,   // Falling Spike
  0xB3: 0x32,   // Bowser statue fireball
  0xB4: 0x18,   // Grinder, non-line-guided
  0xB5: 0x2A,   // Sinking fireball used in boss battles
  0xB6: 0xAC,   // Reflecting fireball
  0xB7: 0xE4,   // Carrot Top lift, upper right
  0xB8: 0xE4,   // Carrot Top lift, upper left
  0xB9: 0xC0,   // Info Box
  0xBA: 0xC4,   // Timed lift
  0xBB: 0xCC,   // Grey moving castle block
  0xBC: 0x00,   // Bowser statue
  0xBD: 0xE0,   // Sliding Koopa without a shell
  0xBE: 0xAE,   // Swooper bat
  0xC0: 0x85,   // Grey platform on lava
  0xC1: 0x40,   // Flying grey turnblocks
  0xC2: 0xEC,   // Blurp fish
  0xC3: 0x86,   // Porcu-Puffer fish
  0xC4: 0x60,   // Grey platform that falls
  0xC5: 0xC0,   // Big Boo Boss
  0xC8: 0x2A,   // Light switch block for dark room
}

/**
 * Override-table patches for sprites in the 0x00-0x53 range where the
 * SprTilemap default picks the wrong base tile (usually because the sprite
 * writes its own OAM after the generic draw). Rare — most sprites in this
 * range work fine via SprTilemap.
 */
const SPRITE_LOW_RANGE_OVERRIDES: Readonly<Record<number, number>> = {
  0x44: 0x80,   // Torpedo Ted — TorpedoGfxRt LDA #$80/#$82, bank_02.asm:7544
}

export const MAX_SPRITE_ID_WITH_LAYOUT = 0xC8

/**
 * Tall (16x32) overrides for prominent enemies whose handler builds OAM
 * with two stacked big-tiles. Values come from direct inspection of each
 * sprite's tile table in bank_02/bank_03:
 *
 *   DinoRhinoTiles   bank_03.asm:3911  $C0,$C2,$E4,$E6 ...   top=$C0 bottom=$E4
 *   SuperKoopaTiles  bank_02.asm:14373 $C8,$D8,$D0,$E0 ...   top=$C8 bottom=$D0
 *   RexTiles         bank_03.asm:2877  $8A,$AA ...           top=$8A bottom=$AA
 *   MegaMoleTiles    bank_03.asm:1018  $C6,$C8,$E6,$E8 ...   top=$C6 bottom=$E6
 *   SumoBrosTiles    bank_02.asm:12447 $98,$99,$A7,$A8 ...   top=$98 bottom=$A7
 *   HammerBroTiles   bank_02.asm:12039 $5A,$4A,$46,$48 ...   top=$5A bottom=$46
 *   VolcanoLotusTiles bank_02.asm:12708 $8E,$9E,$E2          top=$8E bottom=$9E
 */
const SPRITE_TALL_OVERRIDES: Readonly<Record<number, { top: number; bottom: number }>> = {
  0x6E: { top: 0xC0, bottom: 0xE4 },   // Dino Rhino
  0x6F: { top: 0xC0, bottom: 0xE4 },   // Dino Torch
  0x71: { top: 0xC8, bottom: 0xD0 },   // Super Koopa, red cape
  0x72: { top: 0xC8, bottom: 0xD0 },   // Super Koopa, yellow cape
  0x73: { top: 0xC8, bottom: 0xD0 },   // Super Koopa, feather
  0x99: { top: 0x8E, bottom: 0x9E },   // Volcano Lotus
  0x9A: { top: 0x98, bottom: 0xA7 },   // Sumo Brother
  0x9B: { top: 0x5A, bottom: 0x46 },   // Hammer Brother
  0xAB: { top: 0x8A, bottom: 0xAA },   // Rex
  0xBF: { top: 0xC6, bottom: 0xE6 },   // Mega Mole
}

/**
 * Per-sprite-ID GFX-routine classification, derived from a static scan of
 * CallSpriteMain (bank_01.asm:898-1098) that follows each handler one level
 * into JSR targets to locate the first SubSprGfx call. The dominant routine
 * (SubSprGfx2, 16x16 big-tile) is the default, so only sprites that DIFFER
 * from it are listed here:
 *
 *   'sub1'  SubSprGfx1  — 16x32, two stacked big-tiles (feet on anchor)
 *   'sub0'  SubSprGfx0  — four independent 8x8 chars in a 2x2 16x16 layout
 *
 * Sprites not listed fall through to the SubSprGfx2 default, which is
 * correct for Koopas, Goombas, Bob-omb, fish, power-ups, most Bank3
 * handlers via their shared `GenericSprGfxRt2` stub, and similar.
 *
 * Handlers that dispatch to bank_03 (Bnk3CallSprMain — 37 sprites, e.g.
 * Rex, Mega Mole, Blargg, Reznor) generally also end in SubSprGfx2 via
 * their bank_03 main routines, so leaving them as default reproduces the
 * correct 16x16 layout for most of them.
 */
const SPRITE_GFX_OVERRIDES: Readonly<Record<number, 'sub0' | 'sub1'>> = {
  // SubSprGfx1 (16x32) — 11 sprites
  0x1A: 'sub1',   // Classic Piranha Plant
  0x1E: 'sub1',   // Lakitu
  0x1F: 'sub1',   // Magikoopa
  0x22: 'sub1',   // Green vertical net Koopa
  0x23: 'sub1',   // Red vertical net Koopa
  0x24: 'sub1',   // Green horizontal net Koopa
  0x25: 'sub1',   // Red horizontal net Koopa
  0x2A: 'sub1',   // Upside-down Piranha Plant
  0x41: 'sub1',   // Dolphin, horizontal
  0x42: 'sub1',   // Dolphin 2, horizontal
  0x43: 'sub1',   // Dolphin, vertical
  // SubSprGfx0 (4 independent 8x8) — 6 sprites
  0x14: 'sub0',   // Spiny, falling
  0x27: 'sub0',   // Thwimp
  0x2B: 'sub0',   // Sumo Brother's fire lightning
  0x2F: 'sub0',   // Portable spring board
  0x4D: 'sub0',   // Ground-dwelling Monty Mole
  0x4E: 'sub0',   // Ledge-dwelling Monty Mole
}

/**
 * Wide (32×32) sprites whose handler writes 4 big-tiles in a 2×2 arrangement
 * rather than calling SubSprGfx. Each entry lists the 4 quadrant big-tiles:
 * baseTile=base OBJ char N (expands to [N, N+1, N+$10, N+$11]);
 * baseDx/baseDy=pixel offset of the quadrant's top-left corner in the atlas;
 * flipX=true means the SNES mirrors this quadrant horizontally (both the
 * corner order and each 8×8 tile are flipped).
 *
 * Derived from ThwompGfx (bank_01.asm:6422):
 *   ThwompTiles:    db $8E,$8E,$AE,$AE
 *   ThwompDispX:    db $FC,$04,$FC,$04   (signed: -4, +4, -4, +4)
 *   ThwompGfxProp:  db $03,$43,$03,$43   (bit6=flipX on the +4 column)
 * Left column uses tile $8E/$AE with no flip; right column mirrors them.
 */
const SPRITE_WIDE_OVERRIDES: Readonly<Record<number, {
  quadrants: ReadonlyArray<{ baseTile: number; baseDx: number; baseDy: number; flipX?: boolean }>
}>> = {
  0x26: { quadrants: [
    { baseTile: 0x8E, baseDx:  0, baseDy:  0 },             // top-left
    { baseTile: 0x8E, baseDx: 16, baseDy:  0, flipX: true }, // top-right
    { baseTile: 0xAE, baseDx:  0, baseDy: 16 },              // bottom-left
    { baseTile: 0xAE, baseDx: 16, baseDy: 16, flipX: true }, // bottom-right
  ]},
}

/**
 * Sprites routed through Spr0to13Start (CallSpriteMain entries 0x04-0x07,
 * 0x0C, 0x0F, 0x11, 0x13) also promote to tall when Spr0to13Prop bit 6 is
 * set (bank_01.asm:1762-1767). Rather than hardcoding which Koopas are
 * tall, read the prop table — it's what the ASM does.
 */
function isSpr0to13TallSprite(tables: SpriteTileTables, spriteId: number): boolean {
  if (spriteId >= tables.spr0to13Prop.length) return false
  const SPR_0_TO_13_START_IDS = [0x04, 0x05, 0x06, 0x07, 0x0C, 0x0F, 0x11, 0x13]
  if (!SPR_0_TO_13_START_IDS.includes(spriteId)) return false
  return (tables.spr0to13Prop[spriteId] & 0x40) !== 0
}

function spriteGfxRoutine(
  tables: SpriteTileTables,
  spriteId: number,
): 'sub0' | 'sub1' | 'sub2' {
  const override = SPRITE_GFX_OVERRIDES[spriteId]
  if (override) return override
  if (isSpr0to13TallSprite(tables, spriteId)) return 'sub1'
  return 'sub2'
}

/**
 * Build the 4-corner 16x16 layout for one sprite ID using SubSprGfx2Entry1
 * semantics: one base char N → four 8x8 corners [N, N+1, N+$10, N+$11].
 *
 * Returns null for sprite IDs outside the generic-layout range (0x54+).
 */
/**
 * Shell-sprite IDs $DA-$DD are mapped to Koopa IDs $04-$07 at level-load
 * time (bank_02.asm:5460: `SEC; SBC #$DA; CLC; ADC #$04`) but with a "shell"
 * state so only the top-half of the usual 16x32 Koopa renders — the legs
 * don't appear. For the level viewer we treat them as 16x16 sprites that
 * reuse the Koopa color-variant palette.
 */
function resolveShellAlias(spriteId: number): { targetId: number; shellOnly: boolean } {
  if (spriteId >= 0xDA && spriteId <= 0xDD) {
    return { targetId: spriteId - 0xDA + 0x04, shellOnly: true }
  }
  return { targetId: spriteId, shellOnly: false }
}

export function buildSpriteLayout(
  tables: SpriteTileTables,
  spriteId: number,
): SpriteLayout | null {
  const alias = resolveShellAlias(spriteId)
  if (alias.shellOnly) {
    const inner = buildSpriteLayout(tables, alias.targetId)
    if (!inner) return null
    // Tall Koopa layout has 8 corners — the first 4 are the top big-tile
    // (shell). Shift them down so they render at the anchor row instead of
    // a row above, since the stationary shell occupies just one tile row.
    const shellTiles = inner.tiles.slice(0, 4).map(t => ({ ...t, dy: t.dy + 16 }))
    return { spriteId, height: 16, tiles: shellTiles }
  }

  // Sprites 0x54..0xC8 aren't covered by SprTilemapOffset. Check the
  // tall-override table first (16x32 big-tile stack), then fall back to
  // the single-tile base-tile override (16x16 via hardware large-size).
  if (spriteId >= SPR_TILEMAP_OFFSET_COUNT && spriteId <= MAX_SPRITE_ID_WITH_LAYOUT) {
    const attr = tables.spriteAttr[spriteId] ?? 0
    const palette = 8 + ((attr >> 1) & 0x07)
    const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0
    const OBJ_CHAR_BASE = 0x400
    const cornerOffset = [0x00, 0x01, 0x10, 0x11]

    const bigTileCorners = (baseTile: number, baseDy: number): SpriteSubtile[] =>
      [0, 1, 2, 3].map(corner => ({
        charNum: OBJ_CHAR_BASE + charHigh + ((baseTile + cornerOffset[corner]) & 0x1FF),
        palette,
        flipX: false,
        flipY: false,
        dx: tables.dispX[corner] ?? 0,
        dy: baseDy + (tables.dispY[corner] ?? 0),
      }))

    const tall = SPRITE_TALL_OVERRIDES[spriteId]
    if (tall) {
      return {
        spriteId,
        height: 32,
        tiles: [...bigTileCorners(tall.top, -16), ...bigTileCorners(tall.bottom, 0)],
      }
    }
    const baseTile = SPRITE_BASE_TILE_OVERRIDES[spriteId]
    if (baseTile === undefined) return null
    return { spriteId, height: 16, tiles: bigTileCorners(baseTile, 0) }
  }

  if (spriteId < 0 || spriteId >= SPR_TILEMAP_OFFSET_COUNT) return null

  // Wide (32×32) sprites: 4 quadrant big-tiles drawn side-by-side + stacked.
  const wideSpec = SPRITE_WIDE_OVERRIDES[spriteId]
  if (wideSpec) {
    const wAttr = tables.spriteAttr[spriteId] ?? 0
    const wPalette = 8 + ((wAttr >> 1) & 0x07)
    const wCharHigh = (wAttr & 0x01) !== 0 ? 0x100 : 0
    const W_OBJ_BASE = 0x400
    const wCornerOff = [0x00, 0x01, 0x10, 0x11]
    const wideCorners = (baseTile: number, baseDx: number, baseDy: number, flipX = false): SpriteSubtile[] =>
      [0, 1, 2, 3].map(corner => {
        const co = flipX ? [0x01, 0x00, 0x11, 0x10][corner] : wCornerOff[corner]
        return {
          charNum: W_OBJ_BASE + wCharHigh + ((baseTile + co) & 0x1FF),
          palette: wPalette,
          flipX,
          flipY: false,
          dx: baseDx + (tables.dispX[corner] ?? 0),
          dy: baseDy + (tables.dispY[corner] ?? 0),
        }
      })
    return {
      spriteId,
      height: 32,
      width: 32,
      tiles: wideSpec.quadrants.flatMap(q => wideCorners(q.baseTile, q.baseDx, q.baseDy, q.flipX)),
    }
  }

  const tilemapBase = tables.tilemapOffset[spriteId]
  const attr = tables.spriteAttr[spriteId] ?? 0

  // spriteAttr is already AND'd with $0F in readSpriteTileTables, so only the
  // palette bits and char-high bit are live. LoadSpriteTables leaves flip and
  // priority at zero; individual sprite handlers set them at runtime based on
  // direction, which this loader does not model.
  const palette = 8 + ((attr >> 1) & 0x07)
  const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0

  // OBJ tile 0 lives at hackbench char $400, per VRAM_CHAR_BASE in GfxLoader.ts.
  const OBJ_CHAR_BASE = 0x400

  // SNES large-size (16x16) sprite: base tile N expands to chars arranged as
  //   TL = N        TR = N+1
  //   BL = N+$10    BR = N+$11
  // (Rows of 16 chars per OBJ VRAM row.)
  const cornerOffset = [0x00, 0x01, 0x10, 0x11]  // TL, TR, BL, BR

  const bigTileCorners = (baseTile: number, baseDy: number): SpriteSubtile[] => {
    return [0, 1, 2, 3].map(corner => ({
      charNum: OBJ_CHAR_BASE + charHigh + ((baseTile + cornerOffset[corner]) & 0x1FF),
      palette,
      flipX: false,
      flipY: false,
      dx: tables.dispX[corner] ?? 0,
      dy: baseDy + (tables.dispY[corner] ?? 0),
    }))
  }

  const routine = spriteGfxRoutine(tables, spriteId)

  if (routine === 'sub1') {
    // SubSprGfx1 (bank_01.asm:3920) reads two tiles from SprTilemap at
    // [offset + anim*2] (top) and [offset + anim*2 + 1] (bottom). Callers
    // typically adjust Y up by ~$10 before drawing so the bottom tile sits
    // on the anchor row — we mirror that with dy=-16..-1 for the top and
    // dy=0..15 for the bottom.
    const topTile    = tables.tilemap[tilemapBase]     ?? 0
    const bottomTile = tables.tilemap[tilemapBase + 1] ?? 0
    return {
      spriteId,
      height: 32,
      tiles: [
        ...bigTileCorners(topTile, -16),
        ...bigTileCorners(bottomTile, 0),
      ],
    }
  }

  if (routine === 'sub0') {
    // SubSprGfx0 (bank_01.asm:3853) reads four INDEPENDENT 8x8 char bytes
    // from SprTilemap[offset + 0..3] and lays them out as TL, TR, BL, BR
    // per GeneralSprDispX/Y. Unlike SubSprGfx2 there's no large-size
    // expansion — each corner picks its own char.
    return {
      spriteId,
      height: 16,
      tiles: [0, 1, 2, 3].map(corner => {
        const tileByte = tables.tilemap[tilemapBase + corner] ?? 0
        return {
          charNum: OBJ_CHAR_BASE + charHigh + (tileByte & 0x1FF),
          palette,
          flipX: false,
          flipY: false,
          dx: tables.dispX[corner] ?? 0,
          dy: tables.dispY[corner] ?? 0,
        }
      }),
    }
  }

  // Default: SubSprGfx2Entry1 (one base char → hardware 16x16).
  // Low-range overrides patch a handful of sprite IDs whose generic draw
  // produces the wrong tile (TorpedoTed, etc.).
  const baseTile = SPRITE_LOW_RANGE_OVERRIDES[spriteId] ?? tables.tilemap[tilemapBase] ?? 0
  return {
    spriteId,
    height: 16,
    tiles: bigTileCorners(baseTile, 0),
  }
}
