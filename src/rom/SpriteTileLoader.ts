/**
 * SpriteTileLoader.ts -- loads the per-sprite-ID tile layout tables used by
 * SMW's generic sprite draw routines.
 *
 * SubSprGfx2Entry1 (bank_01.asm:4148) is the dominant routine - used by
 * roughly 60 of the ~80 call sites in bank_01-04 (Goombas, Koopas, Buzzy
 * Beetles, Rex, Chuck variants, etc.). It writes ONE OAM entry with the
 * hardware's "large" (16x16) tile-size bit set, so a single char number N
 * expands to the contiguous 4-char block [N, N+1, N+$10, N+$11] - that's
 * TL, TR, BL, BR in a 2x2 grid within OBJ VRAM.
 *
 * We port that semantics here: SprTilemap[SprTilemapOffset[id]] gives the
 * base char N, and buildSpriteLayout returns the four implicit 8x8 corners.
 *
 * SubSprGfx0 (four independent 8x8 chars) and SubSprGfx1 (two stacked
 * 16x16 big-tiles, 16x32 total) are modelled too. Which of the three a
 * sprite uses is read off the open cart by `dispatch/GfxRoutineReader`,
 * which walks the sprite's handler; the frozen residue below covers only
 * the ids that walk cannot reach.
 *
 * Sprite166EVals (bank_07.asm:792) is the spawn-time source for
 * SpriteOBJAttribute - LoadSpriteTables in bank_07.asm:977 reads this byte,
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
 *   $01:8335 YoshiPal           (4 bytes; Yoshi Egg per-position OAM attr)
 *
 * Sprite IDs beyond 0x53 use custom per-sprite draw routines (SubSprGfx1,
 * handwritten routines) that this loader does not model. Callers should
 * treat a missing entry as "no generic layout available."
 */

import { RomFile } from './RomFile'
import {
  decidedPropGroup,
  decidedRoutine,
  readGfxRoutines,
  type GfxRoutine,
  type GfxRoutineReading,
} from './dispatch/GfxRoutineReader'

export const SPR_TILEMAP_ADDR = 0x019b83
export const SPR_TILEMAP_OFFSET_ADDR = 0x019c7f
export const GENERAL_SPR_DISP_X_ADDR = 0x019cd3
export const GENERAL_SPR_DISP_Y_ADDR = 0x019cd7
export const GENERAL_SPR_GFX_PROP_ADDR = 0x019cdb
export const SPRITE_166E_VALS_ADDR = 0x07f3fe
export const SPR_0_TO_13_PROP_ADDR = 0x0188f0
export const YOSHI_PAL_ADDR = 0x018335
export const WALL_FOLLOW_ATTR_ADDR = 0x02bcc7
/** `ORA.W DATA_02BCC7,Y` in WallFollowersMain (bank_02.asm:8089), at $02:BD17 on vanilla US 1.0. */
export const WALL_FOLLOW_ORA_ADDR = 0x02bd17

export const SPR_TILEMAP_OFFSET_COUNT = 0x54 // sprites 0x00..0x53
export const SPR_TILEMAP_LEN = 0xfc // 0x9C7F - 0x9B83
export const GENERAL_SPR_GFX_PROP_COUNT = 24 // 6 groups × 4 corners
export const SPRITE_166E_VALS_COUNT = 0x100
export const SPR_0_TO_13_PROP_COUNT = 0x14 // sprites 0x00..0x13
export const YOSHI_PAL_COUNT = 4
export const WALL_FOLLOW_ATTR_COUNT = 16 // DATA_02BCC7: directions 0..7, then the wall-side set

/** Raw sprite tile layout data read from ROM. */
export interface SpriteTileTables {
  /** Flat table of 8-bit OBJ tile numbers referenced by tilemap offsets. */
  tilemap: Uint8Array
  /** One offset per sprite ID (0x00..0x53) into `tilemap`. */
  tilemapOffset: Uint8Array
  /** Corner X offsets - indexed 0..3 = TL, TR, BL, BR. */
  dispX: number[]
  /** Corner Y offsets - same indexing as dispX. */
  dispY: number[]
  /** GeneralSprGfxProp flip flags: 6 groups × 4 corners, bit6=flipX bit7=flipY.
   *  Index as gfxProp[group * 4 + corner]. ROM address $01:9CDB (bank_01.asm:3848). */
  gfxProp: number[]
  /** OAM attribute byte per sprite ID (vhoopppc): flip, priority, OBJ palette, tile high bit. */
  spriteAttr: Uint8Array
  /** Spr0to13 property byte per sprite ID (0x00..0x13).
   *  Bit 6 set = sprite is drawn 16x32 (two stacked big-tiles) via SubSprGfx1. */
  spr0to13Prop: Uint8Array
  /** YoshiPal (bank_01.asm:461) - four OAM attribute bytes. InitYoshiEgg
   *  (bank_01.asm:463) overwrites SpriteOBJAttribute with the entry chosen by
   *  (SpriteXPosLow >> 4) & 3, so Sprite166EVals[$2C] never reaches the screen. */
  yoshiPal: Uint8Array
  /** DATA_02BCC7 (bank_02.asm:8051): OBJ flip bits WallFollowersMain ORs into a
   *  Spike Top's attribute, indexed by its direction ($C2). Absent on synthetic
   *  tables; absent means the flip is not modelled. */
  wallFollowAttr?: Uint8Array
  /** Which shared draw routine each sprite's handler reaches on THIS cart,
   *  read by `GfxRoutineReader`. Absent on synthetically built tables, which
   *  then fall back to the frozen overrides below. */
  gfxRoutines?: ReadonlyMap<number, GfxRoutineReading>
}

/**
 * True when the instruction at WALL_FOLLOW_ORA_ADDR is still `ORA abs,Y` ($19)
 * naming the low 16 bits of WALL_FOLLOW_ATTR_ADDR. A hack that moves or rewrites
 * that read makes the vanilla table the wrong one, so the flip is left
 * unmodelled, never read from the vanilla address. The operand is 16-bit, so it
 * names a bank-2 address only while DB is the routine's bank, as the other `.W`
 * table read in WallFollowersMain (bank_02.asm:8085) already assumes. Checked on
 * vanilla US 1.0 only.
 */
function wallFollowTableIsRead(rom: RomFile): boolean {
  const ins = rom.readAt(WALL_FOLLOW_ORA_ADDR, 3)
  return !!ins && ins[0] === 0x19 && (ins[1] | (ins[2] << 8)) === (WALL_FOLLOW_ATTR_ADDR & 0xffff)
}

export function readSpriteTileTables(rom: RomFile): SpriteTileTables | null {
  const tilemap = rom.readAt(SPR_TILEMAP_ADDR, SPR_TILEMAP_LEN)
  const tilemapOffset = rom.readAt(SPR_TILEMAP_OFFSET_ADDR, SPR_TILEMAP_OFFSET_COUNT)
  const dispXBuf = rom.readAt(GENERAL_SPR_DISP_X_ADDR, 4)
  const dispYBuf = rom.readAt(GENERAL_SPR_DISP_Y_ADDR, 4)
  const gfxPropBuf = rom.readAt(GENERAL_SPR_GFX_PROP_ADDR, GENERAL_SPR_GFX_PROP_COUNT)
  const rawAttr = rom.readAt(SPRITE_166E_VALS_ADDR, SPRITE_166E_VALS_COUNT)
  const spr0to13Prop = rom.readAt(SPR_0_TO_13_PROP_ADDR, SPR_0_TO_13_PROP_COUNT)
  const yoshiPal = rom.readAt(YOSHI_PAL_ADDR, YOSHI_PAL_COUNT)
  const wallFollowAttr = wallFollowTableIsRead(rom)
    ? rom.readAt(WALL_FOLLOW_ATTR_ADDR, WALL_FOLLOW_ATTR_COUNT)
    : null
  if (
    !tilemap ||
    !tilemapOffset ||
    !dispXBuf ||
    !dispYBuf ||
    !gfxPropBuf ||
    !rawAttr ||
    !spr0to13Prop ||
    !yoshiPal
  )
    return null
  // Match LoadSpriteTables (bank_07.asm:978) - only the low nibble of
  // Sprite166EVals feeds SpriteOBJAttribute (palette + char-high bit).
  const spriteAttr = new Uint8Array(rawAttr.length)
  for (let i = 0; i < rawAttr.length; i++) spriteAttr[i] = rawAttr[i] & 0x0f
  return {
    tilemap: new Uint8Array(tilemap),
    tilemapOffset: new Uint8Array(tilemapOffset),
    dispX: Array.from(dispXBuf),
    dispY: Array.from(dispYBuf),
    gfxProp: Array.from(gfxPropBuf),
    spriteAttr,
    spr0to13Prop: new Uint8Array(spr0to13Prop),
    yoshiPal: new Uint8Array(yoshiPal),
    // Model-only table: a failed read leaves it absent, never nulls the tables the served engine uses.
    ...(wallFollowAttr ? { wallFollowAttr: new Uint8Array(wallFollowAttr) } : {}),
    // 84 handler walks, about 22 ms on vanilla cold. `readGfxRoutines`
    // caches per cart on `RomFile.version`, which matters because a map
    // build reruns on every toolbar change and this was the largest single
    // term in it.
    gfxRoutines: readGfxRoutines(rom, SPR_TILEMAP_OFFSET_COUNT),
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
 *  bottom-of-visual-box row - so tall sprites have dy in [-16..+8] and short
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
 * FROZEN DERIVATION. These 98 values were traced by hand against vanilla
 * and do not track the cart. A hack that repoints any of these handlers, or
 * that changes the tile a handler writes, renders here with the vanilla
 * tile and no warning at all. That is the whole risk, stated plainly.
 *
 * The comment this replaces claimed the table was auto-extracted by
 * following each handler to its first `LDA ... STA OAMTileNo` pair, taking
 * an immediate's operand or an indexed load's first table byte. That claim
 * is false. Applying exactly that rule with `HandlerWalk` reproduces 36 of
 * the 98 values (the 35 to 36 move after #99 is a coincidence: $7E's tile
 * $E8 equals the first store the walk reaches in $7D-$80); 57 differ and 5 find no store at all, identically on all
 * six carts in the corpus. The table is curated, not extracted.
 *
 * Why it cannot be read live, in one line each, with the measurements and
 * the worked examples in `docs/sprites/sprite-gfx-routine-reading.md` section 6:
 * the first store a handler reaches is usually a shared OAM preamble and
 * not the sprite's own; a table-sourced tile needs an animation index that
 * lives in RAM; and which of several stores is the representative pose is
 * a human choice. Picking only the ones that agree with this table would
 * be calibration against the table itself.
 *
 * The base char drives a 16x16 SubSprGfx2-style layout (hardware large-tile
 * expansion to chars [N, N+1, N+$10, N+$11]). Several sprites have layouts
 * this cannot model even on vanilla: Banzai Bill (32x32), Wiggler
 * (multi-segment), Pokey (vertical stack) appear as one 16x16 tile matching
 * part of their body.
 *
 * IDs 0xDA-0xDD are shell aliases (resolveShellAlias). IDs in 0x54..0xC8
 * not listed here, and 0xC9..0xE7 (generators, scroll sprites), fall
 * through to the anchor marker.
 *
 * Method and the full per-id measurement: `docs/sprites/sprite-gfx-routine-reading.md`.
 */
export const SPRITE_BASE_TILE_OVERRIDES: Readonly<Record<number, number>> = {
  0x54: 0x08, // Climbing net door
  0x55: 0xea, // Checkerboard platform, horizontal
  0x56: 0xea, // Flying rock platform, horizontal
  0x57: 0xea, // Checkerboard platform, vertical
  0x58: 0xea, // Flying rock platform, vertical
  0x59: 0x40, // Turn block bridge, horizontal and vertical
  0x5a: 0x40, // Turn block bridge, horizontal
  0x5e: 0xea, // Orange platform, goes on forever
  0x5f: 0xa2, // Brown platform on a chain
  0x60: 0x00, // Flat green switch palace switch
  0x61: 0xe2, // Floating skulls
  // 0x62 Brown platform, line-guided: rendered by LineBrownPlatAppearance (direction-aware, not a static override).
  0x63: 0xc8, // Checker/brown platform, line-guided
  0x5b: 0x60, // Brown platform floating in water - CODE_01B344 base tile (SpriteMisc1602=0)
  0x5c: 0xea, // Checkerboard platform that falls - CODE_01B2DF tile (SpriteMisc1602=1 from InitFallingPlat)
  0x5d: 0xcb, // Orange platform floating in water - DiagPlatTiles[0], bank_01.asm:6989
  0x64: 0xae, // Rope mechanism, line-guided
  0x65: 0xae, // Chainsaw, line-guided
  0x66: 0xae, // Upside down chainsaw, line-guided
  // 0x67 Grinder line-guided - promoted to SPRITE_WIDE_OVERRIDES (32×32, 4-way symmetric)
  0x68: 0xc8, // Fuzz ball, line-guided
  0x6a: 0x60, // Coin game cloud
  0x6b: 0x3d, // Spring board, left wall
  0x6c: 0x3d, // Spring board, right wall
  0x6d: 0x80, // Invisible solid block
  0x6e: 0x80, // Dino Rhino - superseded by SPRITE_WIDE_OVERRIDES; kept as fallback
  0x6f: 0xea, // Dino Torch - DinoTorchTiles[0] (frame 0 body), bank_03.asm:3900
  0x70: 0xe8, // Pokey
  0x71: 0xc8, // Super Koopa, red cape - superseded by SpriteFactory custom handler; kept as fallback
  0x72: 0xc8, // Super Koopa, yellow cape, straight, drops feather - superseded by SpriteFactory
  0x73: 0xc8, // Super Koopa, yellow cape, swooping, drops feather - superseded by SpriteFactory
  0x74: 0x24, // Mushroom - PowerUpTiles[0], bank_01.asm:9528
  0x75: 0x26, // Fire Flower - PowerUpTiles[1]
  0x76: 0x48, // Star - PowerUpTiles[2]
  0x77: 0x0e, // Feather - PowerUpTiles[3] ($77 - $74 = 3)
  0x78: 0x24, // 1-Up - PowerUpTiles[4] ($78 - $74 = 4)
  0x79: 0xae, // Growing Vine
  0x7a: 0xae, // Firework - Bank3SprHandler, uses same particle tile range as vine
  // 0x7B Goal Tape - moved to SPRITE_WIDE_OVERRIDES (three 8×8 parts, not 16×16 big-tile)
  0x7c: 0x6e, // Princess Peach
  // PowerUpGfxRt: PowerUpTiles[sprite - $74], bank_01.asm:9528-9530, 9632-9637 (#99)
  0x7d: 0xe4, // Balloon
  0x7e: 0xe8, // Flying Red coin (body only; wing tiles from CODE_019E95 not modelled)
  0x7f: 0x24, // Flying yellow 1-Up (body only; wings not modelled)
  0x80: 0xec, // Key - PowerUpGfxRt with PowerUpTiles[$0C], bank_01.asm:9528
  0x81: 0x80, // Changing item from translucent block
  0x82: 0xe4, // Bonus game sprite
  0x83: 0x2a, // Left flying question block (initial/unhit state; $2E after hit)
  0x84: 0x2a, // Flying question block (initial/unhit state; $2E after hit)
  0x85: 0x2a, // Unused sprite - per-frame InitFlying_Block; shares tile with 0x83/0x84
  // 0x86 Wiggler - handled by WigglerAppearance in SpriteFactory (multi-segment chain + eye).
  0x87: 0x60, // Lakitu's cloud
  0x88: 0xc6, // Winged cage (unused) - ADDR_02CCB9: BCC→$C6, bank_02.asm:10161
  0x8a: 0xd2, // Bird from Yoshi's house - BirdsTilemap[0], bank_02.asm:15379
  0x8b: 0xc5, // Puff of smoke from Yoshi's house
  0x8c: 0x60, // Fireplace smoke/exit from side screen
  0x8d: 0x9c, // Ghost house exit sign and door
  0x8f: 0x80, // Scale platforms
  0x90: 0x80, // Large green gas bubble
  0x91: 0x06, // Chargin' Chuck - handled in SpriteFactory (FaceMario direction); kept as fallback
  0x92: 0x06, // Splittin' Chuck
  0x93: 0x06, // Bouncin' Chuck
  0x94: 0x06, // Whistlin' Chuck
  0x95: 0x06, // Clappin' Chuck
  0x96: 0x06, // Unused Chargin' Chuck clone
  0x97: 0x06, // Puntin' Chuck
  // 0x98 Pitchin' Chuck - promoted to SPRITE_WIDE_OVERRIDES (release pose $19)
  // 0x99 Volcano Lotus - handled in SpriteFactory (VolcanoLotusAppearance: head + animated flower)
  0x9a: 0x98, // Sumo Brother
  0x9b: 0x46, // Hammer Brother - HammerBroTiles[2] (left body big-tile), bank_02.asm:12040
  0x9c: 0x40, // Flying blocks for Hammer Brother
  0x9d: 0xaa, // Bubble with sprite
  // 0x9E Ball and Chain - handled by BallAndChainAppearance in SpriteFactory
  0x9f: 0x80, // Banzai Bill - top-left char of BanzaiBillTiles (bank_02.asm:11331)
  0xa0: 0xe3, // Activates Bowser scene
  0xa1: 0x45, // Bowser's bowling ball
  0xa2: 0x40, // MechaKoopa
  0xa3: 0xa2, // Grey platform on chain
  0xa4: 0xaa, // Floating Spike ball - CODE_01B666: (EffFrame>>2&2) | $AA, bank_01.asm:12413
  0xa5: 0xc8, // Fuzzball/Sparky, ground-guided
  0xa6: 0xc8, // HotHead, ground-guided
  0xa7: 0x4a, // Iggy's ball
  0xa8: 0xa0, // Blargg
  0xa9: 0x40, // Reznor - ReznorTiles[0], bank_03.asm
  0xaa: 0xa8, // Fishbone
  // 0xAC / 0xAD (Wooden Spike) - handled by WoodSpikeAppearance in SpriteFactory;
  // WoodSpikeGfx uses hardcoded tile tables, not SprTilemap.
  0xae: 0xcc, // Fishin' Boo
  0xaf: 0x8c, // Boo Block
  0xb0: 0x88, // Reflecting stream of Boo Buddies
  0xb1: 0x2e, // Creating/Eating block
  0xb2: 0xe0, // Falling Spike
  0xb3: 0x32, // Bowser statue fireball
  0xb4: 0x18, // Grinder, non-line-guided
  0xb5: 0x2a, // Sinking fireball used in boss battles
  0xb6: 0xac, // Reflecting fireball
  0xb9: 0xc0, // Info Box
  0xba: 0xc4, // Timed lift
  0xbb: 0xcc, // Grey moving castle block
  0xbc: 0x00, // Bowser statue
  0xbd: 0xe0, // Sliding Koopa without a shell
  0xbe: 0xae, // Swooper bat
  0xc0: 0x85, // Grey platform on lava
  0xc1: 0x40, // Flying grey turnblocks
  0xc2: 0xec, // Blurp fish
  0xc3: 0x86, // Porcu-Puffer fish
  // 0xC4 Grey Falling Platform - handled in SpriteFactory (4-tile 64×16; FallingPlatTiles bank_03.asm:525)
  0xc5: 0xc0, // Big Boo Boss
  0xc8: 0x2a, // Light switch block for dark room
}

/**
 * Override-table patches for sprites in the 0x00-0x53 range where the
 * SprTilemap default picks the wrong base tile, because the sprite writes
 * its own OAM after the generic draw.
 *
 * FROZEN DERIVATION, one entry, for the same reason the 0x54-0xC8 table is
 * frozen: the handler stores two immediates and choosing between them is a
 * judgement about which pose to show. A hack that changes TorpedoGfxRt
 * renders with $80 regardless.
 */
const SPRITE_LOW_RANGE_OVERRIDES: Readonly<Record<number, number>> = {
  0x44: 0x80, // Torpedo Ted - TorpedoGfxRt LDA #$80/#$82, bank_02.asm:7544
}

export const MAX_SPRITE_ID_WITH_LAYOUT = 0xc8

/**
 * Tall (16x32) overrides for sprites whose handler builds OAM with exactly
 * two stacked 16x16 big-tiles.
 *
 * FROZEN DERIVATION, one entry. `RexGfxRt` (bank_03.asm:2884) uses none of
 * the three shared draw routines, so the routine reader reports $AB as
 * unreached and has nothing to contribute; the two tile numbers come from
 * `RexTiles` (bank_03.asm:2877) read by hand at frame 0. A hack that
 * changes Rex's tiles renders the vanilla ones.
 *
 * Sprites removed because they are 2x2 WIDE (4 OBJ entries):
 *   $6E Dino Rhino  -> SPRITE_WIDE_OVERRIDES (DinoRhinoTiles: $C0,$C2,$E4,$E6)
 *   $BF Mega Mole   -> SPRITE_WIDE_OVERRIDES (MegaMoleTiles:  $C6,$C8,$E6,$E8)
 *
 * Sprites removed because they use custom mixed-size OAM (base tile fallback):
 *   $6F Dino Torch   - 1 body + flame particles; BASE=$EA
 *   $71/$72/$73 Super Koopa - per-entry charHigh + vflip + FaceMario, handled in SpriteFactory
 *   $99 Volcano Lotus - handled in SpriteFactory (VolcanoLotusAppearance)
 *   $9A Sumo Brother  - 8x8 head + 16x16 body pairs; BASE=$98
 *   $9B Hammer Brother - mixed 8x8/16x16; BASE=$5A
 */
const SPRITE_TALL_OVERRIDES: Readonly<Record<number, { top: number; bottom: number }>> = {
  0xab: { top: 0x8a, bottom: 0xaa }, // Rex - RexTiles bank_03.asm:2877
}

/**
 * Degradation floor for the GFX-routine classification.
 *
 * FROZEN DERIVATION, and deliberately kept at its full original size.
 * `GfxRoutineReader` resolves 57 of the 84 ids below $54 from the open
 * cart, and where it does the live answer wins. Where it does not, an id
 * with no entry here silently becomes `sub2`, which is a 16x16 sprite
 * where a 16x32 one belongs. Planting a `JMP (abs)` at $1A's handler entry
 * on vanilla turns its layout from 32px and 8 tiles into 16px and 4, which
 * is what removing an entry from this table buys.
 *
 * So: live beats frozen when live has an answer, frozen beats nothing when
 * it does not. Four of these are never reached live on any of the six
 * carts in the corpus and would be load-bearing today:
 *
 *   $1F Magikoopa, $4D and $4E Monty Mole - the handler calls through
 *       `ExecutePtr` (bank_00.asm:847), which never returns, so the bytes
 *       after the call are its argument table and the walk stops there
 *   $27 Thwimp - no shared call found; the walk records a callDepth stop,
 *       but depth 8 does not find one either
 *
 * The other 13 are reached live on all six carts and agree with the value
 * here on all six, so they are dead weight until a cart breaks the walk.
 * That is exactly when they matter.
 *
 * None of this tracks a cart. A hack that changes which routine one of the
 * unresolved handlers calls renders with the vanilla layout and no warning.
 */
const SPRITE_GFX_OVERRIDES: Readonly<Record<number, GfxRoutine>> = {
  // SubSprGfx1 (16x32)
  0x1a: 'sub1', // Classic Piranha Plant
  0x1e: 'sub1', // Lakitu
  0x1f: 'sub1', // Magikoopa - unused: SpriteFactory intercepts $1F before buildSpriteLayout
  0x22: 'sub1', // Green vertical net Koopa
  0x23: 'sub1', // Red vertical net Koopa
  0x24: 'sub1', // Green horizontal net Koopa
  0x25: 'sub1', // Red horizontal net Koopa
  0x2a: 'sub1', // Upside-down Piranha Plant
  0x41: 'sub1', // Dolphin, horizontal
  0x42: 'sub1', // Dolphin 2, horizontal
  0x43: 'sub1', // Dolphin, vertical
  // SubSprGfx0 (4 independent 8x8)
  0x14: 'sub0', // Spiny, falling
  0x27: 'sub0', // Thwimp
  0x2b: 'sub0', // Sumo Brother's fire lightning
  0x2f: 'sub0', // Portable spring board
  0x4d: 'sub0', // Ground-dwelling Monty Mole - see MontyMoleAppearance
  0x4e: 'sub0', // Ledge-dwelling Monty Mole - see caveat below
}

/**
 * Known-wrong entry: $4E does NOT use SubSprGfx0. CODE_01E343
 * (bank_01.asm:13388) branches `CMP #$4D / BNE +`, so $4E takes the `+` path
 * at bank_01.asm:13416-13424 - `LDA #$03 : STA SpriteMisc1602 : JSR
 * SubSprGfx2Entry1`, a single 16x16 big-tile from SprTilemap[offset+3], with
 * SpriteOBJAttribute overridden to ((EffFrame << 2) & $C0) | $31 (a 4-phase
 * flip cycle, OBJ palette 0, char-high 1). Correcting it needs a per-sprite
 * attribute override and a 4-frame animation, so it is left on the sub0 path
 * here rather than half-fixed.
 */

/**
 * Wide (32x32) sprites whose handler writes 4 big-tiles in a 2x2
 * arrangement rather than calling SubSprGfx. Each entry lists the 4
 * quadrant big-tiles: baseTile=base OBJ char N (expands to
 * [N, N+1, N+$10, N+$11]); baseDx/baseDy=pixel offset of the quadrant's
 * top-left corner in the atlas; flipX=true means the SNES mirrors this
 * quadrant horizontally (both the corner order and each 8x8 tile).
 *
 * FROZEN DERIVATION throughout. Every quadrant, offset and flip below was
 * read by hand out of a per-sprite tile table and its displacement and
 * property tables. Nothing here tracks the cart: a hack that edits any of
 * those tables, or repoints the handler, renders the vanilla shape.
 *
 * It is frozen for a stronger reason than the base-tile table. The layout
 * is spread across three or four parallel tables plus a loop whose trip
 * count is in the code, so reading it live means an interpreter, not a
 * walk. Most of these handlers also call no shared routine at all, though
 * not all: $4F reaches both sub0 and sub2, which is why the routine reader
 * lists it as ambiguous rather than unreached.
 *
 * Derived from ThwompGfx (bank_01.asm:6422):
 *   ThwompTiles:    db $8E,$8E,$AE,$AE
 *   ThwompDispX:    db $FC,$04,$FC,$04   (signed: -4, +4, -4, +4)
 *   ThwompGfxProp:  db $03,$43,$03,$43   (bit6=flipX on the +4 column)
 * Left column uses tile $8E/$AE with no flip; right column mirrors them.
 */
const SPRITE_WIDE_OVERRIDES: Readonly<
  Record<
    number,
    {
      quadrants: ReadonlyArray<{
        baseTile: number
        baseDx: number
        baseDy: number
        flipX?: boolean
        flipY?: boolean
      }>
      /** Extra individual 8×8 tiles for sprites with mixed-size OAM (e.g. 8×8 head + 16×16 body).
       *  dx/dy are pixel offsets from the sprite anchor; charHigh from `attr` is applied automatically.
       *  palette defaults to the sprite's main OBJ palette; override when a specific part uses a
       *  different palette in its own draw routine (e.g. Pitchin' Chuck's baseball uses attr $09 → pal 12).
       *  Parts are appended AFTER all quadrants in the tiles list, so they render ON TOP of quadrants. */
      parts?: ReadonlyArray<{
        tile: number
        dx: number
        dy: number
        flipX?: boolean
        palette?: number
      }>
      /** Override the sprite's OBJ attribute when Sprite166EVals differs from the runtime draw routine.
       *  Low nibble only (matches readSpriteTileTables masking): bits 3-1 = palette offset, bit 0 = charHigh. */
      attr?: number
    }
  >
> = {
  0x26: {
    quadrants: [
      { baseTile: 0x8e, baseDx: 0, baseDy: 0 }, // top-left
      { baseTile: 0x8e, baseDx: 16, baseDy: 0, flipX: true }, // top-right
      { baseTile: 0xae, baseDx: 0, baseDy: 16 }, // bottom-left
      { baseTile: 0xae, baseDx: 16, baseDy: 16, flipX: true }, // bottom-right
    ],
  },
  // Dino Rhino ($6E): DinoRhinoTiles frame 0, DinoRhinoTileDispX $F8/$08 (-8/+8),
  //   DinoRhinoTileDispY $F0/$00 (-16/0) - bank_03.asm:3904
  0x6e: {
    quadrants: [
      { baseTile: 0xc0, baseDx: -8, baseDy: -16 }, // top-left
      { baseTile: 0xc2, baseDx: 8, baseDy: -16 }, // top-right
      { baseTile: 0xe4, baseDx: -8, baseDy: 0 }, // bottom-left
      { baseTile: 0xe6, baseDx: 8, baseDy: 0 }, // bottom-right
    ],
  },
  // Hammer Brother ($9B): HammerBroGfx ORA.B #$37 → palette 3, charHigh 1.
  //   Sprite166EVals[$9B]=0x00 is wrong; override attr=0x07 (pal 3, charHigh 1).
  //   HammerBroDispX $08/$10/$00/$10, HammerBroDispY $F8/$F8/$00/$00 - bank_02.asm:12033
  //   Loop X=3..0: entry[3]=$48(16x16) at (+16,0), [2]=$46(16x16) at (0,0),
  //                entry[1]=$4A(8x8) at (+16,-8), [0]=$5A(8x8) at (+8,-8)
  0x9b: {
    attr: 0x07,
    quadrants: [
      { baseTile: 0x46, baseDx: 0, baseDy: 0 }, // body-left  (16×16)
      { baseTile: 0x48, baseDx: 16, baseDy: 0 }, // body-right (16×16)
    ],
    parts: [
      { tile: 0x5a, dx: 8, dy: -8 }, // head-left  (8×8)
      { tile: 0x4a, dx: 16, dy: -8 }, // head-right (8×8)
    ],
  },
  // Mega Mole ($BF): MegaMoleTiles frame 0, MegaMoleTileDispX $00/$10 (0/+16),
  //   MegaMoleTileDispY $F0/$00 (-16/0) - bank_03.asm:1013
  0xbf: {
    quadrants: [
      { baseTile: 0xc6, baseDx: 0, baseDy: -16 }, // top-left
      { baseTile: 0xc8, baseDx: 16, baseDy: -16 }, // top-right
      { baseTile: 0xe6, baseDx: 0, baseDy: 0 }, // bottom-left
      { baseTile: 0xe8, baseDx: 16, baseDy: 0 }, // bottom-right
    ],
  },
  // Carrot Top lift ($B7) - CarrotTopLiftGfx (bank_03.asm:1661).
  // DiagPlatTiles2[0..2]=$E4,$E0,$E2; DiagPlatDispX[0..2]=$10,$00,$10;
  // DiagPlatDispY[0..2]=$00,$10,$10; DiagPlatGfxProp[0..2]=$0B (no flip).
  // Upper-left quadrant is empty - the platform is an upward-left L-shape.
  0xb7: {
    quadrants: [
      { baseTile: 0xe4, baseDx: 16, baseDy: 0 }, // upper-right
      { baseTile: 0xe0, baseDx: 0, baseDy: 16 }, // lower-left
      { baseTile: 0xe2, baseDx: 16, baseDy: 16 }, // lower-right
    ],
  },
  // Carrot Top lift ($B8) - same tables, indices 3..5; all flipX ($4B).
  // Upper-right quadrant is empty - mirrors $B7 horizontally.
  0xb8: {
    quadrants: [
      { baseTile: 0xe4, baseDx: 0, baseDy: 0, flipX: true }, // upper-left
      { baseTile: 0xe2, baseDx: 0, baseDy: 16, flipX: true }, // lower-left
      { baseTile: 0xe0, baseDx: 16, baseDy: 16, flipX: true }, // lower-right
    ],
  },
  // Goal Tape ($7B) - CODE_01C12D (bank_01.asm:8865).
  // Three 8×8 extra-OAM tiles; no 16×16 big-tile is written.
  // X offsets: −8, 0, +8 from GetDrawInfoBnk1 anchor. Y offset: +8 (bank_01.asm:8882).
  // Tile $D4 (left cap), $D5 (middle), $D5 (right), all at OAMTileAttr=$32.
  // Attr $32: bits 3:1 = (0x32>>1)&7 = 1 → OBJ pal 1 → CGRAM row 9; charHigh = 0.
  // Low nibble 0x32 & 0x0F = 0x02 overrides Sprite166EVals[$7B].
  0x7b: {
    attr: 0x02,
    quadrants: [],
    parts: [
      { tile: 0xd4, dx: -8, dy: 8 }, // left cap
      { tile: 0xd5, dx: 0, dy: 8 }, // middle
      { tile: 0xd5, dx: 8, dy: 8 }, // right
    ],
  },
  // Grinder line-guided ($67): CODE_01DC0B (bank_01.asm:12521) draws 4 big-tiles
  // all sharing base char $6C (animated to $6C/$6E via EffFrame bit 1), with
  // hardcoded attr table DATA_01DC43=$33/$73/$B3/$F3 (pal 1, charHigh 1, 4-way
  // symmetric flip). DATA_01DC3B/3F put the sprite anchor at the center: TL at
  // (-16,-16), TR at (0,-16) flipX, BL at (-16,0) flipY, BR at (0,0) flipX+flipY.
  0x67: {
    attr: 0x03,
    quadrants: [
      { baseTile: 0x6c, baseDx: -16, baseDy: -16 }, // TL
      { baseTile: 0x6c, baseDx: 0, baseDy: -16, flipX: true }, // TR
      { baseTile: 0x6c, baseDx: -16, baseDy: 0, flipY: true }, // BL
      { baseTile: 0x6c, baseDx: 0, baseDy: 0, flipX: true, flipY: true }, // BR
    ],
  },
  // Dry Bones ($30, $32) and Chargin' Chuck ($91) are handled in SpriteFactory
  // rather than here because their flip direction depends on FaceMario
  // evaluated against the level's Mario start position - not a property of the
  // sprite tile tables.
  //
  // Pitchin' Chuck ($98) - pose $19 (windup overhead, ball cocked for release).
  // bank_02.asm:9591 CODE_02C81A. SMW OAM order back→front:
  //   entry 3 head ($06)  →  entry 2 ball ($AD, pal 12 via attr $09)
  //   → entry 1 body-bot ($AE)  →  entry 0 body-top ($5D)
  // We keep head as a quadrant (16×16), then flatten body-bot into 4 explicit
  // 8×8 parts so we can insert the baseball BETWEEN head and body. That lets
  // body-bot and body-top render on top of the ball (matches OAM priority).
  // Offsets: head (-6,-11) from DATA_02C830/02C84A; body-bot at anchor;
  // body-top (+1,-8) from DATA_02C909/02C971; baseball (+1,-12) from
  // CODE_02CB2D/02CB39. Face-left (_151C=4), no flipX.
  0x98: {
    quadrants: [
      { baseTile: 0x06, baseDx: -6, baseDy: -11 }, // head 16×16 (back)
    ],
    parts: [
      // Baseball (attr $09 → OBJ pal 4 = CGRAM row 12, red stitches).
      { tile: 0xad, dx: 1, dy: -12, palette: 12 },
      // Body-bot $AE expanded to 4 explicit 8×8 chars (large-OBJ: N, N+1, N+$10, N+$11).
      { tile: 0xae, dx: 0, dy: 0 },
      { tile: 0xaf, dx: 8, dy: 0 },
      { tile: 0xbe, dx: 0, dy: 8 },
      { tile: 0xbf, dx: 8, dy: 8 },
      // Body-top / arm detail on top so it isn't obscured by the ball.
      { tile: 0x5d, dx: 1, dy: -8 },
    ],
  },
  // Jumping Piranha Plant ($4F) - CODE_02E0CD (bank_02.asm:12812).
  // InitPiranha (bank_01.asm:880): SpriteXPosLow += 8 - centers the 16px-wide
  // head within the 32px pipe. All dx values are shifted +8 relative to the
  // spawn tile to match. GenericSprGfxRt0/2 are bare bank-switching wrappers
  // (bank_01.asm:61/2393) - no additional X offset.
  // OAM priority: head goes to OAM index 0 (drawn IN FRONT), body to indices 4-7
  // (BEHIND). To match this, body parts come FIRST in the array and the head's
  // 4 expanded 8×8 tiles come LAST so the head overlays the body's upper row.
  // Head: GenericSprGfxRt2 with SpriteMisc1602=2 → SprTilemap[0x3A+2] = $AE;
  //   Sprite166EVals[$4F]=$08 → attr=$08 (pal 12, charHigh=0); SpriteProperties=$10
  //   ORed in at runtime (priority bit only). Large 16×16 expands to $AE,$AF,$BE,$BF.
  // Body: GenericSprGfxRt0 with SpriteOBJAttribute=$0A (charHigh=0, pal 13) at Y+8;
  //   SpriteMisc1602=1 → SprTilemap[0x3E..0x41] = [$83,$83,$C4,$C4].
  //   GeneralSprGfxProp[A=1, group 1]: tiles 1 and 3 (TR, BR) have X-flip ($40).
  0x4f: {
    attr: 0x08,
    quadrants: [],
    parts: [
      // Body (drawn first, BEHIND head)
      { tile: 0x83, dx: 8, dy: 8, palette: 13 }, // neck-TL
      { tile: 0x83, dx: 16, dy: 8, flipX: true, palette: 13 }, // neck-TR
      { tile: 0xc4, dx: 8, dy: 16, palette: 13 }, // stem-BL
      { tile: 0xc4, dx: 16, dy: 16, flipX: true, palette: 13 }, // stem-BR
      // Head 16×16 large-tile expansion (drawn last, IN FRONT)
      { tile: 0xae, dx: 8, dy: 0 },
      { tile: 0xaf, dx: 16, dy: 0 },
      { tile: 0xbe, dx: 8, dy: 8 },
      { tile: 0xbf, dx: 16, dy: 8 },
    ],
  },
}

/**
 * Degradation floor for the `GeneralSprGfxProp` group index.
 *
 * `SubSprGfx0Entry1` (bank_01.asm:3855) reads the accumulator as `_5` and
 * selects row `_5 * 4` in `GeneralSprGfxProp`, four bytes, one per corner,
 * bit 6 flipX and bit 7 flipY. Where the walk resolves a sprite to `sub0`
 * it now also reads the `LDA #imm` immediately in front of the call, so
 * the group comes off the cart.
 *
 * FROZEN DERIVATION below, kept for the same reason as the routine floor:
 * a cart the walk cannot read gets 0, which is "no flips" and wrong for a
 * sprite that wanted 2. Measured on the five distinct carts in
 * the corpus, the live read gives $14 = 2, $2B = 0 and $2F = 2, which is
 * exactly what this table plus the default already produced, so nothing
 * renders differently today.
 */
const SUB0_GFX_PROP_GROUP: Readonly<Record<number, number>> = {
  0x14: 2, // SpinyEgg - bank_01.asm:1813
  0x2f: 2, // Portable spring board - bank_01.asm:13884
}

/**
 * Fallback for the `Spr0to13Gfx` family when no cart was read.
 *
 * FROZEN DERIVATION, used only for synthetically built `SpriteTileTables`.
 * When `tables.gfxRoutines` is present, `GfxRoutineReader` reads the same
 * decision off the cart instead: it finds the `LDA Spr0to13Prop,Y : AND #$40
 * : BNE` at bank_01.asm:1762-1765 and takes the table address, the mask and
 * the branch polarity from the bytes, so a hack that moves the table or
 * changes the bit is followed. The id list below is not; it was traced by
 * hand and covers only ids seen calling into the family in vanilla.
 */
function isSpr0to13TallSprite(tables: SpriteTileTables, spriteId: number): boolean {
  if (spriteId >= tables.spr0to13Prop.length) return false
  const SPR_0_TO_13_START_IDS = [
    0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0f, 0x11, 0x13,
  ]
  if (!SPR_0_TO_13_START_IDS.includes(spriteId)) return false
  return (tables.spr0to13Prop[spriteId] & 0x40) !== 0
}

/**
 * The cart's answer first, the frozen residue second.
 *
 * Live beats frozen deliberately: where the two disagree the cart is right
 * and the table is stale. They do not disagree on any of the six carts in
 * the corpus, which is what makes the swap safe to make now rather than a
 * behaviour change dressed as a refactor.
 */
function spriteGfxRoutine(tables: SpriteTileTables, spriteId: number): GfxRoutine {
  const live = decidedRoutine(tables.gfxRoutines?.get(spriteId))
  if (live) return live
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
 * Shell-sprite IDs $DA-$DD spawn as empty shells lying on the ground. At level
 * load (bank_02.asm:5339-5362, 5454-5462) their SpriteStatus is forced to $09
 * (stunned/carryable) and their SpriteNumber is re-aliased to the Koopa ID
 * $04-$07 via `SEC; SBC #$DA; CLC; ADC #$04`. Status $09 routes through
 * HandleSprStunned → CODE_019806 (bank_01.asm:3313), which stores $06 into
 * SpriteMisc1602 (for OAMIndex ≠ 0; $08 otherwise), then calls SubSprGfx2Entry1
 * (bank_01.asm:4148). That routine reads a SINGLE base tile from
 * SprTilemap[SprTilemapOffset[Koopa] + SpriteMisc1602] and writes it as one
 * 16×16 OAM entry - the stationary shell-on-ground graphic, not the walking
 * Koopa's upper body. Palette comes from Sprite166EVals[$04..$07] (the Koopa
 * attr), since SpriteNumber has been aliased by draw time.
 */
const STUNNED_ANIM_OFFSET = 0x06

function resolveShellAlias(spriteId: number): { targetId: number; shellOnly: boolean } {
  if (spriteId >= 0xda && spriteId <= 0xdd) {
    return { targetId: spriteId - 0xda + 0x04, shellOnly: true }
  }
  return { targetId: spriteId, shellOnly: false }
}

/**
 * SNES large-OBJ expansion of base char N → [N, N+1, N+$10, N+$11] at corners
 * [TL, TR, BL, BR]. flipX swaps the columns AND mirrors each 8×8; flipY swaps
 * the rows AND flips each 8×8; both does both.
 */
const CORNER_OFFSETS = {
  none: [0x00, 0x01, 0x10, 0x11],
  flipX: [0x01, 0x00, 0x11, 0x10],
  flipY: [0x10, 0x11, 0x00, 0x01],
  both: [0x11, 0x10, 0x01, 0x00],
} as const

/** Pick the corner order for a flip combination. */
function cornerOffsetsFor(flipX: boolean, flipY: boolean): readonly number[] {
  return flipX && flipY
    ? CORNER_OFFSETS.both
    : flipX
      ? CORNER_OFFSETS.flipX
      : flipY
        ? CORNER_OFFSETS.flipY
        : CORNER_OFFSETS.none
}

/** Sprite ID of the Yoshi Egg. */
export const YOSHI_EGG_ID = 0x2c

/**
 * Resting layout for the Yoshi Egg ($2C): char $00, an X-position-dependent
 * palette, and a mirrored big-tile. The generic SprTilemap path gets the last
 * two wrong. Full trace: docs/sprites/smw-sprite-2c-yoshi-egg.md
 *
 * CODE_01F78D (bank_01.asm:16057) stamps the immediate $00 over OAMTileNo
 * after SubSprGfx2Entry1 (bank_01.asm:4148) returns, so SprTilemap is dead
 * here. InitYoshiEgg (bank_01.asm:463) stores a YoshiPal byte
 * (bank_01.asm:461) into SpriteOBJAttribute UNMASKED, unlike LoadSpriteTables
 * (bank_07.asm:978), so its flip bits are live. SubSprGfx2Entry1 then EORs
 * OBJ_XFlip into the attribute because ZeroSpriteTables (bank_07.asm:940)
 * leaves SpriteMisc157C at 0.
 *
 * OAM priority (attribute bits 5-4) is not modelled: SpriteSubtile has no
 * priority field and no other layout in this module models one.
 *
 * Evidence scope: SMWDisX line numbers plus the twelve opcode bytes at LoROM
 * $01:F78D read back from the vanilla US 1.0 ROM. No other region checked.
 *
 * @param spritePixelX  Sprite pixel X. Only bits 5-4 reach the YoshiPal index,
 *   so masking to SpriteXPosLow first would not change the result.
 */
export function buildYoshiEggLayout(tables: SpriteTileTables, spritePixelX: number): SpriteLayout {
  const attr = tables.yoshiPal[(spritePixelX >> 4) & 0x03] ?? 0
  const palette = 8 + ((attr >> 1) & 0x07)
  const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0
  // EOR, not ORA: an attribute that already has bit 6 set comes out unmirrored.
  const flipX = ((attr ^ 0x40) & 0x40) !== 0
  const flipY = (attr & 0x80) !== 0

  const YOSHI_EGG_CHAR = 0x00 // CODE_01F78D: LDA #$00 / STA OAMTileNo+$100,Y
  const OBJ_CHAR_BASE = 0x400
  const offsets = cornerOffsetsFor(flipX, flipY)

  return {
    spriteId: YOSHI_EGG_ID,
    height: 16,
    tiles: [0, 1, 2, 3].map(corner => ({
      charNum: OBJ_CHAR_BASE + charHigh + ((YOSHI_EGG_CHAR + offsets[corner]) & 0x1ff),
      palette,
      flipX,
      flipY,
      dx: tables.dispX[corner] ?? 0,
      dy: tables.dispY[corner] ?? 0,
    })),
  }
}

export function buildSpriteLayout(tables: SpriteTileTables, spriteId: number): SpriteLayout | null {
  const alias = resolveShellAlias(spriteId)
  if (alias.shellOnly) {
    const tilemapBase = tables.tilemapOffset[alias.targetId] ?? 0
    const shellBaseTile = tables.tilemap[tilemapBase + STUNNED_ANIM_OFFSET] ?? 0
    const attr = tables.spriteAttr[alias.targetId] ?? 0
    const palette = 8 + ((attr >> 1) & 0x07)
    const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0
    const OBJ_CHAR_BASE = 0x400
    const cornerOffset = [0x00, 0x01, 0x10, 0x11]
    const shellTiles: SpriteSubtile[] = [0, 1, 2, 3].map(corner => ({
      charNum: OBJ_CHAR_BASE + charHigh + ((shellBaseTile + cornerOffset[corner]) & 0x1ff),
      palette,
      flipX: false,
      flipY: false,
      dx: tables.dispX[corner] ?? 0,
      dy: tables.dispY[corner] ?? 0,
    }))
    return { spriteId, height: 16, tiles: shellTiles }
  }

  // Wide (32×32) sprites: checked before the range guard so that sprites
  // above SPR_TILEMAP_OFFSET_COUNT ($6E Dino Rhino, $BF Mega Mole) are handled.
  // For sprites 0x00-0x53 this also intercepts Thwomp ($26) before the
  // generic SprTilemap path.
  const wideSpec = SPRITE_WIDE_OVERRIDES[spriteId]
  if (wideSpec) {
    const wAttr = wideSpec.attr ?? tables.spriteAttr[spriteId] ?? 0
    const wPalette = 8 + ((wAttr >> 1) & 0x07)
    const wCharHigh = (wAttr & 0x01) !== 0 ? 0x100 : 0
    const W_OBJ_BASE = 0x400
    const wideCorners = (
      baseTile: number,
      baseDx: number,
      baseDy: number,
      flipX = false,
      flipY = false,
    ): SpriteSubtile[] => {
      const offsets = cornerOffsetsFor(flipX, flipY)
      return [0, 1, 2, 3].map(corner => ({
        charNum: W_OBJ_BASE + wCharHigh + ((baseTile + offsets[corner]) & 0x1ff),
        palette: wPalette,
        flipX,
        flipY,
        dx: baseDx + (tables.dispX[corner] ?? 0),
        dy: baseDy + (tables.dispY[corner] ?? 0),
      }))
    }
    const extraParts: SpriteSubtile[] = (wideSpec.parts ?? []).map(p => ({
      charNum: W_OBJ_BASE + wCharHigh + (p.tile & 0x1ff),
      palette: p.palette ?? wPalette,
      flipX: p.flipX ?? false,
      flipY: false,
      dx: p.dx,
      dy: p.dy,
    }))
    return {
      spriteId,
      height: 32,
      width: 32,
      tiles: [
        ...wideSpec.quadrants.flatMap(q =>
          wideCorners(q.baseTile, q.baseDx, q.baseDy, q.flipX, q.flipY),
        ),
        ...extraParts,
      ],
    }
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
        charNum: OBJ_CHAR_BASE + charHigh + ((baseTile + cornerOffset[corner]) & 0x1ff),
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
  const cornerOffset = [0x00, 0x01, 0x10, 0x11] // TL, TR, BL, BR

  const bigTileCorners = (baseTile: number, baseDy: number): SpriteSubtile[] => {
    return [0, 1, 2, 3].map(corner => ({
      charNum: OBJ_CHAR_BASE + charHigh + ((baseTile + cornerOffset[corner]) & 0x1ff),
      palette,
      flipX: false,
      flipY: false,
      dx: tables.dispX[corner] ?? 0,
      dy: baseDy + (tables.dispY[corner] ?? 0),
    }))
  }

  // Para-Goomba ($3F) and Para-Bomb ($40): ParachuteSprites (bank_01.asm:11558).
  // Two draw units in sequence:
  //   1. 16×16 parachute via SubSprGfx2Entry1 - drawn at ORIGINAL_X, ORIGINAL_Y−16.
  //      SpriteX is NOT modified before SubSprGfx2Entry1 (line 11663); X modification
  //      happens AFTER (lines 11671–11679) for the body draw. So parachute dx = 0.
  //      SubSprGfx2Entry1 adds SpriteMisc1602 DIRECTLY to tilemapOffset (no ×4).
  //      Frame 0 (SpriteMisc1570=0): DATA_01D55E[0]=$0D → tilemapIdx=$0D+tilemapBase.
  //      OBJAttr override: (attr & $F1)|$06 → palette=OBJ_3/row_11, charHigh preserved.
  //      DATA_01D56E[0]=$00 → SpriteMisc157C LSR → carry=0 → EOR OBJ_XFlip → h-flip.
  //      H-flipped big-tile: columns swap (TL↔TR, BL↔BR) and each 8×8 char individually flipX'd.
  //   2. Body via SubSprGfx0 at (ORIGINAL_X + DATA_01D57E[0], ORIGINAL_Y − 2).
  //      DATA_01D57E[0]=$F8=−8 → body dx = −8.
  //      DATA_01D59E[0]=$0E=14 → body_Y = (ORIGINAL_Y−16)+14 = ORIGINAL_Y−2 → dy = −2.
  //      DATA_01D5B0[0]=$01 → GeneralSprGfxProp[$04..$07]={$00,$40,$00,$40} → flipX right column.
  if (spriteId === 0x3f || spriteId === 0x40) {
    const PARACHUTE_FRAME = 0x0d // DATA_01D55E[0]
    const pc = tables.tilemap[tilemapBase + PARACHUTE_FRAME] ?? 0
    const ppRow = 11 // (attr & $F1)|$06 → ppp=011 → OBJ pal 3 → CGRAM row 11
    // Parachute: drawn at (ORIGINAL_X, ORIGINAL_Y−16). X is unmodified at draw time.
    const parachuteTiles: SpriteSubtile[] = [
      {
        charNum: OBJ_CHAR_BASE + charHigh + ((pc + 0x01) & 0x1ff),
        palette: ppRow,
        flipX: true,
        flipY: false,
        dx: 0,
        dy: -16,
      }, // TL ← orig TR
      {
        charNum: OBJ_CHAR_BASE + charHigh + ((pc + 0x00) & 0x1ff),
        palette: ppRow,
        flipX: true,
        flipY: false,
        dx: 8,
        dy: -16,
      }, // TR ← orig TL
      {
        charNum: OBJ_CHAR_BASE + charHigh + ((pc + 0x11) & 0x1ff),
        palette: ppRow,
        flipX: true,
        flipY: false,
        dx: 0,
        dy: -8,
      }, // BL ← orig BR
      {
        charNum: OBJ_CHAR_BASE + charHigh + ((pc + 0x10) & 0x1ff),
        palette: ppRow,
        flipX: true,
        flipY: false,
        dx: 8,
        dy: -8,
      }, // BR ← orig BL
    ]
    // Body: drawn at (ORIGINAL_X−8, ORIGINAL_Y−2). DATA_01D57E[0]=$F8=−8, DATA_01D59E[0]=$0E=14.
    const bodyFlipX = [false, true, false, true] // GeneralSprGfxProp[$04..$07] bit 6
    const bodyTiles: SpriteSubtile[] = [0, 1, 2, 3].map(corner => ({
      charNum: OBJ_CHAR_BASE + charHigh + ((tables.tilemap[tilemapBase + corner] ?? 0) & 0x1ff),
      palette,
      flipX: bodyFlipX[corner],
      flipY: false,
      dx: (tables.dispX[corner] ?? 0) - 8, // SpriteX shifted −8 before body draw
      dy: (tables.dispY[corner] ?? 0) - 2, // SpriteY = (ORIGINAL_Y−16)+14 = ORIGINAL_Y−2
    }))
    return { spriteId, height: 32, tiles: [...parachuteTiles, ...bodyTiles] }
  }

  const routine = spriteGfxRoutine(tables, spriteId)

  if (routine === 'sub1') {
    // SubSprGfx1 (bank_01.asm:3920) reads two tiles from SprTilemap at
    // [offset + anim*2] (top) and [offset + anim*2 + 1] (bottom) and draws
    // them at (_0, _1) and (_0, _1 + $10).
    //
    // The -16/0 anchoring below is the Spr0to13Gfx case, where the caller
    // subtracts $0F/$00 from SpriteYPos/High before the JSR (CODE_018BEC,
    // bank_01.asm:1772-1774). Callers that do NOT pre-shift Y need 0/+16
    // instead; verified for $1F, whose state-2 `JSR SubSprGfx1`
    // (bank_01.asm:8529) has no such wrapper, which is why it has its own
    // appearance. The remaining sub1 IDs ($1A, $1E, $22-$25, $2A, $41-$43)
    // have not been traced to their callers and may share that 16px offset
    // error. Tracked in docs/sprites/sprite-1f-magikoopa.md section 2.
    const topTile = tables.tilemap[tilemapBase] ?? 0
    const bottomTile = tables.tilemap[tilemapBase + 1] ?? 0
    return {
      spriteId,
      height: 32,
      tiles: [...bigTileCorners(topTile, -16), ...bigTileCorners(bottomTile, 0)],
    }
  }

  if (routine === 'sub0') {
    // SubSprGfx0 (bank_01.asm:3853) reads four INDEPENDENT 8x8 char bytes
    // from SprTilemap[offset + 0..3] and lays them out as TL, TR, BL, BR
    // per GeneralSprDispX/Y. Unlike SubSprGfx2 there's no large-size
    // expansion - each corner picks its own char. Flip flags come from
    // GeneralSprGfxProp[propGroup*4 + corner] (bit6=flipX, bit7=flipY).
    //
    // NOT modelled here: the routine's first selector. bank_01.asm:3865-3869
    // computes `_2 = (SpriteMisc1602 << 2) + SprTilemapOffset[id]`, so each
    // animation frame owns its own 4-byte quad (walked through in
    // docs/sprites/sprite-4d-monty-mole.md). This builder returns one
    // static layout and therefore pins SpriteMisc1602 = 0. Sprites whose
    // drawing state sets a non-zero SpriteMisc1602 ($4D ground Monty Mole)
    // or that animate across quads ($14 Spiny egg, via SetAnimationFrame)
    // need a dedicated multi-frame SpriteAppearance, not an entry here.
    const propGroup =
      decidedPropGroup(tables.gfxRoutines?.get(spriteId)) ?? SUB0_GFX_PROP_GROUP[spriteId] ?? 0
    return {
      spriteId,
      height: 16,
      tiles: [0, 1, 2, 3].map(corner => {
        const tileByte = tables.tilemap[tilemapBase + corner] ?? 0
        const gfxFlags = tables.gfxProp[propGroup * 4 + corner] ?? 0
        return {
          charNum: OBJ_CHAR_BASE + charHigh + (tileByte & 0x1ff),
          palette,
          flipX: (gfxFlags & 0x40) !== 0,
          flipY: (gfxFlags & 0x80) !== 0,
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
