// Consumes: editorStore.cursorPx

import type { Char } from '../../chars/Char'
import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import type { RenderTarget } from '../../RenderTarget'
import { editorStore } from '../../stores/editorStore'
import type { MapStore } from '../../stores/mapStore'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'
import { COLORS, DASH_ALPHA, DASH_LINE_WIDTH, DEFAULT_DASH, rgba } from '../../overlays/primitives'
import { RIP_VAN_FISH_DETECT_HALF_PX } from '../behaviors/RipVanFishBehavior'

/**
 * Sprite $3D — Rip Van Fish. Self-rendering appearance.
 *
 * Frames (per `SprTilemap[$E2..$E5]` and the SpriteMisc1602 dispatch in
 * RipVanFishMain, bank_02.asm:8462):
 *
 *   misc1602=0 ($AE) — chasing A     (state 1, awake)
 *   misc1602=1 ($AC) — chasing B     (state 1, awake)
 *   misc1602=2 ($8C) — sleeping A    (state 0, idle)
 *   misc1602=3 ($8E) — sleeping B    (state 0, idle, alt every misc1570 bit)
 *
 * Both states animate via two-frame oscillation, both driven by the
 * `SpriteMisc1570` per-frame counter (incremented at RipVanFishMain:8489).
 * The dispatches in CODE_02C07B (idle) and CODE_02C0BB (awake) write
 * misc1602 from misc1570's bit pattern:
 *
 *   IDLE   (CODE_02C07B): `misc1602 = (misc1570 & $30) ? 2 : 3`
 *                         sleepA most of the time; sleepB blinks for
 *                         16 frames every 64 (when bits 4 AND 5 of
 *                         misc1570 are both clear).
 *   AWAKE  (CODE_02C0BB): `misc1602 = (misc1570 & $04) ? 1 : 0`
 *                         awakeA / awakeB alternate every 4 frames.
 *
 * The editor reuses `this.romFrame` as the misc1570 stand-in, so the
 * same bit checks select the current frame. Editor cycling is the
 * `(romFrame & $30) == 0` / `(romFrame & $04) != 0` reading.
 *
 * Each frame is a single 16×16 SubSprGfx2 big-tile expanded to four
 * 8×8 chars at TL/TR/BL/BR = base, base+1, base+$10, base+$11.
 *
 * Detection-zone overlay: a 96×96 square (±$30 each axis) centered on
 * the spawn — the static `(|dx| < $30) && (|dy| < $30)` check inside
 * CODE_02C02E. Dashed border + faint fill, lime-green to match the
 * patrol-overlay vocabulary for back-and-forth movement sprites.
 *
 * Z snore trail (sleeping only):
 *
 * Each Z is a minor extended sprite of type $06 (CODE_028DDB,
 * bank_02.asm:1784) spawned by CODE_02C0D9 (bank_02.asm:8604) on a
 * SpriteMisc1528 timer reset to `#$28` (40-frame period). Spawned at
 * `(sprite + $06, sprite + $00)` with timer = `#$7F`, x-speed = `#$FA`
 * (drifts left at 6/16 px/frame ≈ -0.375). Y decrements by 1 every
 * 4 frames (`MinExtSpriteTimer & $03 == 0`). Tile selected from
 * `RipVanFishZsTiles = $F1,$F0,$E1,$E0` indexed by `(timer >> 5) & 3` —
 * over the timer's $7F → $00 countdown the visible cycle is
 * **$E0 → $E1 → $F0 → $F1**.
 *
 * The trail is hidden when `inZone` (cursor inside the wake square) —
 * spawning halts on state→1 in the ASM, so the cursor stand-in mirrors
 * that gating. Animation advances on `tickAnimation()` ticks (driven by
 * the editor Play button via `spriteAnimTimer`); when paused, the trail
 * stays in its last computed pose.
 */

const OBJ_CHAR_BASE = 0x400
const CORNER_OFFSET = [0x00, 0x01, 0x10, 0x11] as const
const SUB_DX        = [0, 8, 0, 8] as const
const SUB_DY        = [0, 0, 8, 8] as const

/**
 * Expand one 16×16 SNES OAM big-tile into four 8×8 SpriteParts (matches
 * Thwomp's `bigTileParts`). The hardware's large-size bit makes tile N
 * occupy [N, N+1, N+$10, N+$11] for TL/TR/BL/BR.
 */
function bigTileParts(
  chars: Map<number, Char>,
  baseTile: number,
  palette: number,
  charHigh: number,
  placeholder: Char,
): SpritePart[] {
  return [0, 1, 2, 3].map(c => ({
    char: chars.get(OBJ_CHAR_BASE + charHigh + ((baseTile + CORNER_OFFSET[c]) & 0x1FF)) ?? placeholder,
    palette,
    flipX: false,
    flipY: false,
    dx: SUB_DX[c],
    dy: SUB_DY[c],
  }))
}

/** ROM-derived frame base tiles (SprTilemap[$E2..$E5]). */
export const RIP_VAN_FISH_FRAMES = {
  awakeA: 0xAE,   // misc1602=0
  awakeB: 0xAC,   // misc1602=1
  sleepA: 0x8C,   // misc1602=2
  sleepB: 0x8E,   // misc1602=3
} as const

/**
 * Z trail constants — all ROM-derived from bank_02.asm.
 *
 *   INIT_TIMER  `#$7F`  init MinExtSpriteTimer (CODE_02C0F2:8639)
 *   KILL_TIMER  `#$14`  CODE_028DDB:1834 — slot is cleared when the
 *                       just-decremented timer equals $14, so the visible
 *                       lifetime is the count of decremented timer values
 *                       in $7E..$15 = 106 frames.
 *   SPAWN_PER   `#$28`  reset MinExtSpriteSlotTimer (CODE_02C0D9:8615)
 *   MAX_SLOTS   ceil(LIFETIME / SPAWN_PER) = ceil(106/40) = 3 — actual
 *                       max simultaneous Zs in steady state (the ROM slot
 *                       pool is 12, but only ~2-3 live for a single fish
 *                       since lifetime/period ≈ 2.65).
 *   SPAWN_DX    `#$06`  CODE_02C0F2:8632 (sprite_x + 6 → MinExtSpriteXPosLow)
 *   SPAWN_DY    `#$00`  CODE_02C0F2:8636 (sprite_y + 0 → MinExtSpriteYPosLow)
 *   X_SPEED     `#$FA`  signed 8.4 fp velocity (CODE_02C0F2:8641),
 *                       wobbled every frame by CODE_028DDB:1794-1798:
 *                         INC XSpeed                    ; +1
 *                         AND timer with #$10
 *                         BNE +
 *                         DEC XSpeed
 *                         DEC XSpeed                    ; -2 if bit 4 clear
 *                       so XSpeed oscillates between -7 and +9 across
 *                       16-frame stretches of `timer & $10`. Net X drift
 *                       over 106 frames is only a few pixels, NOT linear.
 *   Y_DRIFT     -1 px per 4 frames (CODE_028DDB:1810–1813, dec when
 *               `MinExtSpriteTimer & $03 == 0`).
 *   POS_APPLY   CODE_02B5C8 — signed 8.4 fp velocity:
 *                 subpixel += (xSpeed << 4) & $FF
 *                 carry     = subpixel overflow
 *                 dx       += sign-extended (xSpeed >> 4) + carry
 *
 *   ROM_FRAMES_PER_TICK 125 ms / (1000/60) = 7.5 — sprite-anim cadence
 *   (`SPRITE_ANIM_INTERVAL_MS` in webview/mapEditor/main.ts) at 8 Hz vs
 *   the SNES PPU at 60 Hz.
 *
 *   TILES order  $E0 → $E1 → $F0 → $F1 over a particle's lifetime, which
 *   is what `RipVanFishZsTiles[(timer >> 5) & 3]` produces over the
 *   countdown $7F → $00 (table is `db $F1,$F0,$E1,$E0`).
 *
 * The trajectory is precomputed by stepping the exact ROM physics for
 * each of the 106 visible frames; the render path is a table lookup.
 * Net X motion ends up around ±5 px from spawn, Y drifts up ~25 px —
 * matching the OAM captures showing Zs in a near-vertical column.
 */
const Z_INIT_TIMER        = 0x7F
const Z_KILL_TIMER        = 0x14
const Z_INIT_X_SPEED      = 0xFA  // signed 8.4 fp = -6
const Z_SPAWN_PERIOD      = 0x28
const Z_MAX_SLOTS         = 3
const Z_TOTAL_PERIOD      = Z_SPAWN_PERIOD * Z_MAX_SLOTS  // 120-frame cycle
const Z_SPAWN_DX          = 0x06
const Z_SPAWN_DY          = 0x00
const ROM_FRAMES_PER_TICK = 125 / (1000 / 60)              // 7.5
export const Z_TILES      = [0xE0, 0xE1, 0xF0, 0xF1] as const

/**
 * Precomputed Z particle trajectory. Each entry is the per-frame state
 * of one Z slot, with `age = 0` being the first frame post-spawn (the
 * spawn frame itself runs CODE_02C0F2 only — drawing starts the frame
 * after, when CODE_028DDB first executes). Steps the exact ROM physics
 * from CODE_028DDB and CODE_02B5C8.
 */
export interface ZTrajectoryFrame {
  readonly tileIdx: number   // 0..3 indexes Z_TILES → $E0/$E1/$F0/$F1
  readonly dx:      number   // pixel offset from sprite TL (signed)
  readonly dy:      number
}

function computeZTrajectory(): readonly ZTrajectoryFrame[] {
  const frames: ZTrajectoryFrame[] = []
  let xSpeed   = Z_INIT_X_SPEED   // unsigned 8-bit, treated signed via wrap
  let xPosSpx  = 0                // sub-pixel X accumulator (CODE_02B5C8)
  let dx       = Z_SPAWN_DX
  let dy       = Z_SPAWN_DY
  let timer    = Z_INIT_TIMER

  for (;;) {
    // CODE_028DDB:1787-1789 — decrement timer (skip if already 0)
    if (timer === 0) break
    timer = (timer - 1) & 0xFF

    // CODE_028DDB:1834 — kill check fires BEFORE the tile-no is set, so
    // the frame at timer=$14 is not part of the visible trail.
    if (timer === Z_KILL_TIMER) break

    // CODE_028DDB:1794-1798 — wobble XSpeed ±1 based on timer bit 4.
    xSpeed = (xSpeed + 1) & 0xFF
    if ((timer & 0x10) === 0) xSpeed = (xSpeed - 2) & 0xFF

    // CODE_02B5C8 — apply X velocity as signed 8.4 fp.
    const subAdd = (xSpeed << 4) & 0xFF
    const total  = xPosSpx + subAdd
    const carry  = total >= 0x100 ? 1 : 0
    xPosSpx      = total & 0xFF
    let intHigh  = (xSpeed >> 4) & 0x0F
    if (intHigh >= 0x08) intHigh -= 0x10  // ROM `ORA #$F0` sign-extension
    dx += intHigh + carry

    // CODE_028DDB:1810-1813 — Y stair-steps -1 every 4 frames.
    if ((timer & 0x03) === 0) dy -= 1

    // CODE_028DDB:1840-1848 — `RipVanFishZsTiles[(timer >> 5) & 3]`.
    // ROM table is `db $F1,$F0,$E1,$E0` (idx 0..3 → tile), so our
    // Z_TILES order [$E0,$E1,$F0,$F1] uses tileIdx = 3 - romIdx.
    const tileIdx = 3 - ((timer >> 5) & 0x03)

    frames.push({ tileIdx, dx, dy })
  }

  return frames
}

export const Z_TRAJECTORY: readonly ZTrajectoryFrame[] = computeZTrajectory()
export const Z_LIFETIME_FRAMES = Z_TRAJECTORY.length

export class RipVanFishAppearance implements SpriteAppearance {
  readonly hitRect: HitRect
  private romFrame  = 0
  private tickCount = 0

  /**
   * `sleepFrames[0]` = sleepB ($8E, misc1602=3) — eyes-blink alternate
   * `sleepFrames[1]` = sleepA ($8C, misc1602=2) — eyes-closed default
   * `awakeFrames[0]` = awakeA ($AE, misc1602=0) — chasing pose A
   * `awakeFrames[1]` = awakeB ($AC, misc1602=1) — chasing pose B
   */
  constructor(
    readonly sleepFrames: readonly [readonly SpritePart[], readonly SpritePart[]],
    readonly awakeFrames: readonly [readonly SpritePart[], readonly SpritePart[]],
    readonly zParts:      readonly SpritePart[],
  ) {
    // hitRect intentionally excludes zParts — the trail is decoration,
    // not a click target.
    this.hitRect = partsHitRect([
      ...sleepFrames[0], ...sleepFrames[1],
      ...awakeFrames[0], ...awakeFrames[1],
    ])
  }

  static fromTables(
    chars:       Map<number, Char>,
    palette:     number,
    charHigh:    number,
    placeholder: Char,
  ): RipVanFishAppearance {
    const zParts: SpritePart[] = Z_TILES.map(t => ({
      char:    chars.get(OBJ_CHAR_BASE + charHigh + (t & 0x1FF)) ?? placeholder,
      palette,
      flipX:   false,
      flipY:   false,
      dx:      0,
      dy:      0,
    }))
    const tileParts = (base: number) => bigTileParts(chars, base, palette, charHigh, placeholder)
    return new RipVanFishAppearance(
      [tileParts(RIP_VAN_FISH_FRAMES.sleepB), tileParts(RIP_VAN_FISH_FRAMES.sleepA)],
      [tileParts(RIP_VAN_FISH_FRAMES.awakeA), tileParts(RIP_VAN_FISH_FRAMES.awakeB)],
      zParts,
    )
  }

  /**
   * Drives both the Z-trail animation and the body-frame oscillation
   * forward by one sprite-anim tick. Called from `Sprite.tickAnimation()`
   * which is in turn driven by the map editor's Play button via
   * `spriteAnimTimer`. Wraps modulo the full spawn cycle
   * (`Z_TOTAL_PERIOD`) so the float counter never grows unboundedly;
   * 120 happens to be a clean multiple of the awake period (8) so the
   * `(romFrame & $04)` body-frame select stays continuous across wraps.
   */
  tickAnimation(): void {
    this.romFrame = (this.romFrame + ROM_FRAMES_PER_TICK) % Z_TOTAL_PERIOD
    this.tickCount++
  }

  render(
    target: RenderTarget,
    x: number,
    y: number,
    _behavior: SpriteBehavior,
    mapStore: MapStore,
  ): void {
    // Cursor inside the wake-up square swaps to the chasing pose. Reading
    // editorStore.cursorPx registers this sprite for re-render on cursor
    // moves; the toplevel renderModelOverlay also reads it, so the dep is
    // safe even when the cursor is null.
    const cursor = editorStore.cursorPx
    const cx     = x + 8
    const cy     = y + 8
    const inZone = cursor !== null
      && Math.abs(cursor.x - cx) < RIP_VAN_FISH_DETECT_HALF_PX
      && Math.abs(cursor.y - cy) < RIP_VAN_FISH_DETECT_HALF_PX

    // Body frame selection:
    //   awake: alternate every editor tick — ROM cycles at 7.5 Hz (8 ROM
    //     frames); the editor's 8 Hz display can only represent 4 Hz, so a
    //     simple tickCount parity avoids the aliasing that `(romFrame & $04)`
    //     produces (near-resonance → the frame sticks for ~1 s at a time).
    //   idle  (CODE_02C07B): `(misc1570 & $30) ? sleepA : sleepB`
    //     using romFrame as the misc1570 stand-in; 64-frame cycle maps
    //     well at 8 Hz (≈8.5 ticks/cycle, ~2 ticks on sleepA blink).
    const fishFrame = Math.floor(this.romFrame)
    const parts = inZone
      ? this.awakeFrames[this.tickCount % 2]
      : this.sleepFrames[(fishFrame & 0x30) === 0 ? 1 : 0]
    for (const part of parts) {
      const pixels = part.char.getPixels()
      const row    = mapStore.palette.row(part.palette)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }

    // Z snore trail — hidden when the fish is "awake" (cursor in zone).
    // ASM: spawner CODE_02C0D9 is gated by sleeping-state CODE_02C044
    // only, so on wake new Zs never spawn. Editor mirrors that by
    // skipping the whole trail render when inZone.
    if (!inZone) {
      for (let i = 0; i < Z_MAX_SLOTS; i++) {
        // Stagger: each slot's "spawn" is offset by SPAWN_PERIOD frames.
        // The mod brings stale values back into [0, TOTAL_PERIOD).
        const age = ((this.romFrame - i * Z_SPAWN_PERIOD) % Z_TOTAL_PERIOD + Z_TOTAL_PERIOD) % Z_TOTAL_PERIOD
        const ageInt = Math.floor(age)
        if (ageInt >= Z_LIFETIME_FRAMES) continue   // dead slot, between spawns
        const frame  = Z_TRAJECTORY[ageInt]
        const part   = this.zParts[frame.tileIdx]
        const pixels = part.char.getPixels()
        const row    = mapStore.palette.row(part.palette)
        target.blit8x8(pixels, { x: x + frame.dx, y: y + frame.dy }, row, part.flipX, part.flipY)
      }
    }
  }

  renderOverlay(
    ctx:        OverlayContext,
    x:          number,
    y:          number,
    isActive:   boolean,
    _getL1:     GetL1Tile,
    _levelCols: number,
    _levelRows: number,
    _behavior:  SpriteBehavior | undefined,
    _mapStore:  MapStore,
  ): void {
    if (!isActive) return
    const cx = x + 8
    const cy = y + 8
    const half = RIP_VAN_FISH_DETECT_HALF_PX
    const left = cx - half
    const top  = cy - half
    const w    = half * 2
    const h    = half * 2
    const color = COLORS.patrolPath

    ctx.save()
    // Faint fill so the zone reads at a glance.
    ctx.fillStyle = rgba(color, 0.10)
    ctx.fillRect(left, top, w, h)
    // Dashed border, same vocabulary as the patrol-line overlays.
    ctx.lineWidth   = DASH_LINE_WIDTH
    ctx.strokeStyle = rgba(color, DASH_ALPHA)
    ctx.setLineDash([...DEFAULT_DASH])
    ctx.strokeRect(left + 0.5, top + 0.5, w - 1, h - 1)
    ctx.setLineDash([])
    ctx.restore()
  }
}
