/**
 * SpriteSeed.ts -- the one object that says what the machine holds before a
 * sprite's INIT runs. Generic by construction: nothing here is keyed on a
 * sprite id. A Mesen capture supplies the same shape, so an emulator run and a
 * core run start from identical values.
 */

/**
 * The level-header-derived cells sprites read: found by recording which WRAM
 * a run reads before writing it (`RunOptions.trackInputs`) over 1,957 recorded
 * sprites and keeping the cells that are level state rather than the sprite's
 * own slot, Mario or the camera. rammap.asm names in each comment.
 */
export interface LevelState {
  /** $5B ScreenMode: 0 horizontal, 1 vertical (bit 7 variants). */
  screenMode: number
  /** $5D LevelScrLength: screens in the level. */
  screens: number
  /** $64 SpriteProperties: OAM priority bits sprites OR into their attribute. */
  spriteProps: number
  /** $85 LevelIsWater. */
  water: number
  /** $86 LevelIsSlippery. */
  slippery: number
  /** $190E SpriteBuoyancy. */
  buoyancy: number
  /** $1692 SpriteMemorySetting: picks the OAM index table row. */
  spriteMemory: number
  /** $82-$83 SlopesPtr: the tileset's slope table pointer (low, high). */
  slopes: number
}

export interface SpriteSeed {
  /** Sprite table slot the routine runs in ($15E9 and the X register). */
  slot: number
  /** Level position the level's sprite list places the sprite at (16 bit). */
  sprite: { x: number; y: number }
  /** Mario's level position, written to BOTH $94/$96 (Next) and $D1/$D3 (Now). */
  mario: { x: number; y: number; dir: number }
  /** Layer 1 camera, $1A/$1C. */
  camera: { x: number; y: number }
  /** $13 TrueFrame and $14 EffFrame during the INIT frame; both tick once per MAIN pass after it. */
  trueFrame: number
  effFrame: number
  /** MAIN pass cap after INIT; the frame policy picks the first pass that draws within it. */
  mainPasses: number
  /** What the level loader leaves in WRAM that sprite code reads (measured, not guessed: see docs 11.4). */
  level: LevelState
  /** Extra single-byte WRAM writes, offset to value. $9D (sprites locked) is 0. */
  ram: Record<number, number>
  /**
   * The WRAM the ROM's own level loader produced for this level
   * (`loadLevelState`, LevelLoader.ts). Applied before everything else; when
   * present the `level` cells and `mario.dir` are not written (the ROM's
   * entrance setup provides them). It is the ONLY way a whole-WRAM image gets
   * in: oracle images built from captures live in test support, so a capture
   * cannot become a runtime input by a field of this seed.
   */
  loaded?: Uint8Array
}

export const SPRITE_SEED: SpriteSeed = {
  slot: 0,
  sprite: { x: 0x80, y: 0x80 },
  // dir $76 PlayerDirection (used only when no loaded image supplies it): 1 faces
  // right, what the ROM's entrance setup leaves for most levels; the Boos read it.
  mario: { x: 0x80, y: 0x80, dir: 1 },
  camera: { x: 0, y: 0 },
  trueFrame: 0,
  effFrame: 0,
  mainPasses: 64,
  level: {
    screenMode: 0,
    screens: 0x14,
    spriteProps: 0x20,
    water: 0,
    slippery: 0,
    buoyancy: 0,
    spriteMemory: 0,
    slopes: 0,
  },
  // $9D SpritesLocked off, stated although WRAM starts zeroed, so a fixture
  // that differs says so.
  ram: { 0x9d: 0 },
}

/** A seed with some fields replaced, deep for the nested position objects. */
export type SeedOverride = Partial<Omit<SpriteSeed, 'sprite' | 'mario' | 'camera' | 'level'>> & {
  sprite?: Partial<SpriteSeed['sprite']>
  mario?: Partial<SpriteSeed['mario']>
  camera?: Partial<SpriteSeed['camera']>
  level?: Partial<LevelState>
}

export function withSeed(over: SeedOverride, base: SpriteSeed = SPRITE_SEED): SpriteSeed {
  return {
    ...base,
    ...over,
    sprite: { ...base.sprite, ...over.sprite },
    mario: { ...base.mario, ...over.mario },
    camera: { ...base.camera, ...over.camera },
    level: { ...base.level, ...over.level },
    ram: { ...base.ram, ...over.ram },
  }
}
