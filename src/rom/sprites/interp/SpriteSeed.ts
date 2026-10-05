/**
 * SpriteSeed.ts -- the one object that says what the machine holds before a
 * sprite's INIT runs. Generic by construction: nothing here is keyed on a
 * sprite id. A Mesen capture supplies the same shape, so an emulator run and a
 * core run start from identical values.
 */

export interface SpriteSeed {
  /** Sprite table slot the routine runs in ($15E9 and the X register). */
  slot: number
  /** Level position the level's sprite list places the sprite at (16 bit). */
  sprite: { x: number; y: number }
  /** Mario's level position, written to BOTH $94/$96 (Next) and $D1/$D3 (Now). */
  mario: { x: number; y: number }
  /** Layer 1 camera, $1A/$1C. */
  camera: { x: number; y: number }
  /** $13 TrueFrame and $14 EffFrame at the first MAIN pass; both tick once per pass. */
  trueFrame: number
  effFrame: number
  /** MAIN passes after INIT. */
  mainPasses: number
  /** Extra single-byte WRAM writes, offset to value. $9D (sprites locked) is 0. */
  ram: Record<number, number>
  /**
   * Optional low-WRAM image ($0000-$1FFF) the machine starts from, for a seed
   * that carries the whole level state (a Mesen capture at level load). Every
   * other slot's status is zeroed after it is applied, so only the one sprite
   * runs; the fields above are written over it.
   */
  wramBase?: Uint8Array
  /**
   * The level's Map16 grid as the game holds it in WRAM: the low-byte table at
   * $7E:C800 and the high-byte table at $7F:C800 (up to $3800 bytes each).
   * Sprites read it for block contact; without it every cell is tile 0.
   */
  map16?: { low: Uint8Array; high: Uint8Array }
}

export const SPRITE_SEED: SpriteSeed = {
  slot: 0,
  sprite: { x: 0x80, y: 0x80 },
  mario: { x: 0x80, y: 0x80 },
  camera: { x: 0, y: 0 },
  trueFrame: 0,
  effFrame: 0,
  mainPasses: 16,
  // $9D SpritesLocked off; $1692 sprite memory setting 0 (the table row the
  // level header would pick). Both stated even though WRAM starts zeroed, so
  // a fixture that differs says so.
  ram: { 0x9d: 0, 0x1692: 0 },
}

/** A seed with some fields replaced, deep for the nested position objects. */
export function withSeed(over: Partial<SpriteSeed>, base: SpriteSeed = SPRITE_SEED): SpriteSeed {
  return {
    ...base,
    ...over,
    sprite: { ...base.sprite, ...over.sprite },
    mario: { ...base.mario, ...over.mario },
    camera: { ...base.camera, ...over.camera },
    ram: { ...base.ram, ...over.ram },
  }
}
