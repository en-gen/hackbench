import type { Char } from '../../chars/Char'
import type { RenderTarget } from '../../RenderTarget'
import type { MapStore } from '../../stores/mapStore'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import type { SpritePart } from './StaticSpriteAppearance'

const OBJ_CHAR_BASE = 0x400

/**
 * RopeMotorTiles (bank_01.asm:12557): db $C0,$C2,$E0,$C2 — 4-frame animation.
 * ROM frame index: ((slotIndex * 4) XOR effFrame) >> 3 & 3, where effFrame is
 * the raw game frame counter. The editor advances a 4-frame internal cycle
 * once per sprite-animation tick.
 */
const MOTOR_TILES = [0xC0, 0xC2, 0xE0, 0xC2] as const
const BODY_TILE   = 0xCE
const KNOT_TILE   = 0xDE

/**
 * Rope smoke routes through the dispatcher at CODE_0296C0 (bank_02.asm:2955).
 * Sprite $64 spawns smoke with SmokeSpriteNumber=$03 (CODE_018063, bank_01.asm:97),
 * which dispatches to CODE_029927 — NOT the generic CODE_0296E3 path. The rope-specific
 * tile table is DATA_029922 (bank_02.asm): db $66,$66,$64,$62,$62.
 *
 * Lifecycle (timer 19→0, indexed by timer>>2):
 *   timer 19..12 (age 0-7)   → $62 (newest, just spawned)
 *   timer 11..8  (age 8-11)  → $64 (middle)
 *   timer 7..0   (age 12-19) → $66 (oldest, fading)
 *
 * Size: 8×8 — CODE_029927 (bank_02.asm:3337-3338) writes #$00 (small) to OAMTileSize.
 * Rises 1 px every 8 frames (DEC SmokeSpriteYPos at bank_02.asm:3298).
 *
 * Palette: CODE_029927 (bank_02.asm:3351-3352) does
 *   `LDA.B SpriteProperties / STA.W OAMTileAttr+$100,Y` —
 * unmodified copy of SpriteProperties (DP $64) into OAM. SpriteProperties is
 * the global priority byte set once per level at bank_00.asm:2401-2402
 * (`LDA #!OBJ_Priority2 / STA SpriteProperties` → `$20`); no handler on the
 * smoke path reloads it per-sprite. The rope-specific tweaker bytes ($31 body,
 * $37 motor) are written directly to OAMTileAttr by CODE_01DC54 and never
 * flow through SpriteProperties. Decoded palette index is therefore
 * `(0x20 >> 1) & 7 = 0` → CGRAM row `8 + 0 = 8` regardless of which sprite
 * spawned the smoke. Caller passes the derived row as `smokePalette`.
 */
const SMOKE_TILES = [0x62, 0x64, 0x66] as const

/**
 * Editor sprite-animation heartbeat (`spriteAnimTimer`,
 * mapEditor/main.ts) ticks at ≈125 ms — close to but distinct from the
 * map-tile animation rate. Issue #174 split the sprite cadence off the
 * level-tile cadence; this constant is retained because the smoke
 * lifecycle math depends on a fixed advance per tick.
 *
 * In-game, an 8-frame spawn cycle has 5 distinct visual states across its
 * 8 phases:
 *   phase 0..2 (3 frames): 3-alive,  $62 + $64 + $66, yRise 0/1/2
 *   phase 3   (1 frame ): 2-alive,  $62 (yRise 1) + $66 (yRise 2)
 *   phase 4..6 (3 frames): 2-alive,  $62 (yRise 1) + $66 (yRise 2)  [same as phase 3]
 *   phase 7   (1 frame ): 2-alive,  $64 (yRise 1) + $66 (yRise 2)  [newest tile flips]
 *
 * Advancing by 3 game frames per editor tick visits all 8 phases over an
 * 8-tick cycle (phase visit order: 0, 3, 6, 1, 4, 7, 2, 5). Result:
 *   - 3-alive state appears 3/8 of ticks (matches game's 3/8 time-share)
 *   - phase-3..6 2-alive  4/8 ticks       (matches game's 4/8)
 *   - phase-7 2-alive     1/8 ticks       (matches game's 1/8)
 * Every editor tick is a distinct visual frame ("running at map tile rate"
 * per user's spec). ×4 over-represented 3-alive at 50%; ×1 looped the
 * lifecycle at 1/8 game speed and looked frozen.
 */
const GAME_FRAMES_PER_TICK = 3

/** ASM-derived constants (`CODE_029927`, bank_02.asm:3280-3339). */
const SMOKE_LIFETIME = 19  // ages 0..18 visible; pre-DEC timer=0 hits cleanup
const SPAWN_PERIOD   = 8   // CODE_018063 spawn condition: (slot*4 XOR EffFrame) & 7 == 0

/**
 * Pure lifecycle math — exposed for unit tests that want to address specific
 * within-cycle phases without going through the rAF tick coarsening.
 *
 * `effFrame` corresponds to in-game EffFrame for slot 0 (slot index is
 * unknown in the editor; different slots phase-shift the cycle but produce
 * identical visual vocabulary).
 *
 * Returns 2 or 3 cohort descriptors, newest first.
 */
export interface SmokePuffDescriptor {
  /** Index into SMOKE_TILES — 0 → $62, 1 → $64, 2 → $66. */
  readonly tileIdx: number
  /** Anchor-relative X offset (0 or 8) per DATA_01D717 spawn parity. */
  readonly puffDx:  number
  /** Pixels above the spawn baseline (0, 1, or 2) per DEC SmokeSpriteYPos. */
  readonly yRise:   number
}

/**
 * Tile by puff age. ASM (bank_02.asm:3326-3330):
 *   timer is decremented from 19; tile = DATA_029922[(post-DEC timer) >> 2].
 *   post-DEC timer at age N = 18 − N. DATA_029922 = $66,$66,$64,$62,$62.
 *
 *   age  0..6  → post-DEC 18..12 → idx 4..3 → $62 (smoke index 0)
 *   age  7..10 → post-DEC 11..8  → idx 2    → $64 (smoke index 1)
 *   age 11..18 → post-DEC 7..0   → idx 1..0 → $66 (smoke index 2)
 */
function tileForAge(age: number): number {
  return age <= 6 ? 0 : age <= 10 ? 1 : 2
}

/**
 * Pixels above spawn baseline by puff age. ASM (bank_02.asm:3296-3298):
 *   `LDA pre-DEC timer / AND #$07 / BNE + / DEC SmokeSpriteYPos`.
 *   pre-DEC timer at age N = 19 − N. (19 − N) & 7 == 0 ↔ N ≡ 3 (mod 8):
 *   first DEC at age 3, second at age 11.
 *
 *   age  0..2  → yRise 0
 *   age  3..10 → yRise 1
 *   age 11..18 → yRise 2
 */
function yRiseForAge(age: number): number {
  return age <= 2 ? 0 : age <= 10 ? 1 : 2
}

export function smokeCohortsAt(effFrame: number): SmokePuffDescriptor[] {
  const newestAge = effFrame & 7
  const cycle     = effFrame >> 3
  const cohorts: SmokePuffDescriptor[] = []
  for (let cohort = 0; cohort < 3; cohort++) {
    const age = newestAge + cohort * SPAWN_PERIOD
    if (age >= SMOKE_LIFETIME) continue
    const tileIdx = tileForAge(age)
    const puffDx  = ((cycle - cohort) & 1) === 0 ? 0 : 8
    const yRise   = yRiseForAge(age)
    cohorts.push({ tileIdx, puffDx, yRise })
  }
  return cohorts
}

function bigTileParts(tile: number, palette: number, c: (n: number) => Char): SpritePart[] {
  return [
    { char: c(tile),        palette, flipX: false, flipY: false, dx: 0, dy: 0 },
    { char: c(tile + 1),    palette, flipX: false, flipY: false, dx: 8, dy: 0 },
    { char: c(tile + 0x10), palette, flipX: false, flipY: false, dx: 0, dy: 8 },
    { char: c(tile + 0x11), palette, flipX: false, flipY: false, dx: 8, dy: 8 },
  ]
}

/**
 * Sprite $64 (Rope Mechanism) — animated motor + fixed body + knot + smoke puffs.
 *
 * CODE_01DC54 (bank_01.asm:12564) draws N segments stacked vertically:
 *   seg 0:     motor, animated from RopeMotorTiles[animFrame]
 *   seg 1..N-2: body tile $CE
 *   seg N-1:   knot tile $DE (overwrites last segment, bank_01.asm:12620)
 *
 * Smoke puffs (SmokeSpriteNumber subsystem) are spawned above the motor and
 * rendered as a single 8×8 tile cycling through $60→$62→$64→$66.
 *
 * Templates (bodyTemplate, knotTemplate) store parts at dy=0;
 * render() adds seg*16 to position each segment below the previous.
 */
export class RopeMechanismAppearance implements SpriteAppearance {
  readonly hitRect: HitRect

  /**
   * Motor frame (4-state cycle indexing `MOTOR_TILES`). Advances once per
   * sprite-animation tick. The visual cadence (~125 ms × 4 ≈ 500 ms full
   * loop) is independent of the level-tile animation rate.
   */
  private motorFrame = 0

  /**
   * In-game-frame approximation for the smoke lifecycle. `tickAnimation()`
   * advances by `GAME_FRAMES_PER_TICK` per sprite tick so the cycle
   * replays at game pace.
   *
   * Why an internal counter: the smoke 8-phase spawn cycle needs more
   * range than a small frame index can carry, and its math is independent
   * of the motor cycle.
   *
   * `_smokeFrame` is exposed via a getter for unit tests that need to
   * inspect or seed the lifecycle at a specific phase without going through
   * tickAnimation's 8-frame quantum.
   */
  private _smokeFrame = 0

  /** Test-only seam: read or seed the in-game-frame counter. */
  get smokeFrame(): number { return this._smokeFrame }
  set smokeFrame(v: number) { this._smokeFrame = v & 0xFFFF }

  constructor(
    readonly motorFrames:     readonly (readonly SpritePart[])[],
    readonly bodyTemplate:    readonly SpritePart[],
    readonly knotTemplate:    readonly SpritePart[],
    readonly smokePuffFrames: readonly (readonly SpritePart[])[],
    readonly segmentCount:    number,
  ) {
    this.hitRect = { dx: 0, dy: 0, w: 16, h: segmentCount * 16 }
  }

  tickAnimation(): void {
    this.motorFrame = (this.motorFrame + 1) & 3
    this._smokeFrame = (this._smokeFrame + GAME_FRAMES_PER_TICK) & 0xFFFF
  }

  static fromTables(
    chars:        Map<number, Char>,
    motorPalette: number,
    bodyPalette:  number,
    smokePalette: number,
    charHigh:     number,
    placeholder:  Char,
    segmentCount  = 5,
  ): RopeMechanismAppearance {
    const c  = (n: number): Char => chars.get(OBJ_CHAR_BASE + charHigh + (n & 0x1FF)) ?? placeholder
    const c0 = (n: number): Char => chars.get(OBJ_CHAR_BASE + (n & 0x1FF))            ?? placeholder
    return new RopeMechanismAppearance(
      MOTOR_TILES.map(t => bigTileParts(t, motorPalette, c)),
      bigTileParts(BODY_TILE, bodyPalette, c),
      bigTileParts(KNOT_TILE, bodyPalette, c),
      SMOKE_TILES.map(t => [{ char: c0(t), palette: smokePalette, flipX: false, flipY: false, dx: 0, dy: 0 }]),
      segmentCount,
    )
  }

  render(target: RenderTarget, x: number, y: number, _behavior: SpriteBehavior, mapStore: MapStore): void {
    for (let seg = 0; seg < this.segmentCount; seg++) {
      const isMotor = seg === 0
      const isKnot  = seg === this.segmentCount - 1 && !isMotor
      const parts   = isMotor ? this.motorFrames[this.motorFrame]
                    : isKnot  ? this.knotTemplate
                    :           this.bodyTemplate
      const segDy   = seg * 16
      for (const part of parts) {
        target.blit8x8(
          part.char.getPixels(),
          { x: x + part.dx, y: y + part.dy + segDy },
          mapStore.palette.row(part.palette),
          part.flipX, part.flipY,
        )
      }
    }
    // Smoke lifecycle — see `smokeCohortsAt` (module-level) for the
    // ASM-derived math. tickAnimation advances `_smokeFrame` by
    // GAME_FRAMES_PER_TICK (3) per sprite tick — see the constant's
    // docstring for the trade-off rationale.
    //
    // Reactivity: redraw is triggered by the sprite-tick event in
    // mapEditor/main.ts, not by any read inside this method.
    for (const { tileIdx, puffDx, yRise } of smokeCohortsAt(this._smokeFrame)) {
      for (const part of this.smokePuffFrames[tileIdx]) {
        target.blit8x8(
          part.char.getPixels(),
          { x: x + part.dx + puffDx, y: y + part.dy - 6 - yRise },
          mapStore.palette.row(part.palette),
          part.flipX, part.flipY,
        )
      }
    }
  }
}
