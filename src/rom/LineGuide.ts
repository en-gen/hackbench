/**
 * LineGuide.ts — load-time port of the SMW line-guide sprite attachment logic.
 *
 * Seven sprite IDs ($62-$68) follow Map16 "track" tiles: $62/$63 brown
 * platforms, $64 rope mechanism, $65/$66 chainsaws, $67 grinder, $68 fuzz
 * ball. At spawn the game picks one direction (forward/reverse) from bit 4
 * of SpriteXPosLow and then probes a small box around the adjusted position
 * looking for a Map16 tile in range $76..$99. The first tile found becomes
 * the attachment point; tile $94/$95 gate on OnOffSwitch state.
 *
 * This module mirrors only the **load-time** logic — it does NOT walk
 * LineTable waypoints, apply per-frame movement, or handle mid-segment
 * re-entry direction flips. The editor surfaces the resolved attachment
 * (direction + attached tile) so the user can see where the game will
 * latch the sprite and toggle direction when editing.
 *
 * ROM references (SMW_U disassembly):
 *   CODE_01D7F4  bank_01.asm:11948  4-corner probe loop
 *   CODE_01D856  bank_01.asm:11996  tile-range + ON/OFF check
 *   InitLineGuidedSpr  bank_01.asm:11788  $65-$68 X-adjust + direction
 *   InitLinePlat       bank_01.asm:11774  $62-$64 direction flag
 *   CODE_01DAA2        bank_01.asm:12323  platform probe-shift ($18/$28)
 */

/** Inclusive range of Map16 tile IDs accepted by the 4-corner probe. */
const LINE_GUIDE_TILE_MIN = 0x76
const LINE_GUIDE_TILE_MAX = 0x99

/** ON/OFF switch gated track tiles (CODE_01D856, bank_01.asm:11996).
 *  $94 blocks traffic while switch is OFF; $95 blocks while switch is ON. */
const ON_OFF_TILE_A = 0x94
const ON_OFF_TILE_B = 0x95

/**
 * 4-corner probe offsets from CODE_01D7F4 (bank_01.asm:11933).
 * DATA_01D7E1/E5: XLow/XHigh offsets  $FC,$04,$FC,$04  (-4, +4, -4, +4)
 * DATA_01D7E9/ED: YLow/YHigh offsets  $FC,$FC,$04,$04  (-4, -4, +4, +4)
 * The ROM iterates Y=3→0 (LDY #$03 / DEY / BPL); first match wins.
 * Index 0 here = Y=3 (bottom-right), index 3 = Y=0 (top-left).
 */
const CORNER_DX = [+4, -4, +4, -4] as const
const CORNER_DY = [+4, +4, -4, -4] as const

/** Sprites whose init routine is InitLinePlat or InitLineRope. */
const LINE_PLATFORM_IDS = new Set<number>([0x62, 0x63, 0x64])
/** Sprites whose init routine is InitLineGuidedSpr. */
const LINE_GUIDED_IDS = new Set<number>([0x65, 0x66, 0x67, 0x68])

/** All sprite IDs that follow line-guide tracks. Exposed so the factory and
 *  editor can test membership with a single source of truth. */
export const LINE_TRACKED_SPRITE_IDS: ReadonlySet<number> = new Set<number>([
  ...LINE_PLATFORM_IDS, ...LINE_GUIDED_IDS,
])

export interface LineGuideAttachment {
  /** Map16 grid cell the sprite attaches to. */
  trackTile: { col: number; row: number }
  /** Traversal direction derived from bit 4 of SpriteXPosLow. */
  direction: 'forward' | 'reverse'
}

/**
 * Probe a 4-corner ±4px box around (x, y) for a line-guide Map16 tile.
 * Returns the first matching cell in the ROM's iteration order (Y=3→0) or
 * null if none match. ON/OFF tiles are skipped when their gate would block
 * the sprite at the supplied switch state.
 */
export function probeTrackTile(
  x: number, y: number,
  l1: readonly (number | null)[][],
  onOffSwitchInitial: boolean,
): { col: number; row: number } | null {
  for (let i = 0; i < 4; i++) {
    const col = Math.floor((x + CORNER_DX[i]) / 16)
    const row = Math.floor((y + CORNER_DY[i]) / 16)
    if (row < 0 || col < 0) continue
    const tile = l1[row]?.[col] ?? null
    if (tile == null) continue
    // Map16TileNumber in the ROM is an 8-bit value; CMP #$76/#$9A checks
    // only the low byte. We replicate that — page 1 tiles with a matching
    // low byte will also register, matching the game's behavior exactly.
    const id = tile & 0xFF
    if (id < LINE_GUIDE_TILE_MIN || id > LINE_GUIDE_TILE_MAX) continue
    if (id === ON_OFF_TILE_A && !onOffSwitchInitial) continue
    if (id === ON_OFF_TILE_B &&  onOffSwitchInitial) continue
    return { col, row }
  }
  return null
}

interface InitResult {
  probeX: number
  probeY: number
  direction: 'forward' | 'reverse'
}

/**
 * InitLineGuidedSpr for sprites $65-$68 (bank_01.asm:11788).
 *
 * Bit 4 of SpriteXPosLow picks the direction and shifts X:
 *   clear → forward: 16-bit X decreases by $140 (SEC / SBC #$40 / SBC #$01)
 *   set   → reverse: XLow += $0F (ADC with no carry into XHigh)
 *
 * The $140 forward shift is a faithful port — the ROM really does
 * SBC #$01 on the high byte (not #$00), so the sprite probes 20 tiles
 * to the left of its spawn. The ROM code also omits any carry from the
 * reverse-mode ADC #$0F, so XLow wraps independently of XHigh.
 */
function applyInitLineGuidedSpr(spawnX: number, spawnY: number): InitResult {
  const xLow = spawnX & 0xFF
  if ((xLow & 0x10) === 0) {
    return {
      probeX: (spawnX - 0x140) & 0xFFFF,
      probeY: spawnY,
      direction: 'forward',
    }
  }
  const xHigh = spawnX & 0xFF00
  const newLow = (xLow + 0x0F) & 0xFF
  return { probeX: xHigh | newLow, probeY: spawnY, direction: 'reverse' }
}

/**
 * InitLinePlat for sprites $62-$64 (bank_01.asm:11774) composed with
 * CODE_01DAA2 (bank_01.asm:12323), which actually performs the probe shift.
 *
 * Bit 4 of SpriteXPosLow (XORed into SpriteMisc1602) picks the shift:
 *   clear → SpriteMisc1602=$10 → probe shift = -$28  (2.5 tiles left)
 *   set   → SpriteMisc1602=$00 → probe shift = -$18  (1.5 tiles left)
 *
 * The Y is also shifted -$08 in CODE_01DAA2, so we mirror that too.
 * Direction mapping: clear=forward / set=reverse (same convention as
 * InitLineGuidedSpr so the editor exposes one unified direction toggle).
 */
function applyInitLinePlat(spawnX: number, spawnY: number): InitResult {
  const xLow = spawnX & 0xFF
  const forward = (xLow & 0x10) === 0
  const xShift = forward ? 0x28 : 0x18
  return {
    probeX: (spawnX - xShift) & 0xFFFF,
    probeY: (spawnY - 0x08) & 0xFFFF,
    direction: forward ? 'forward' : 'reverse',
  }
}

/**
 * Resolve where a line-tracked sprite attaches at level load and which
 * direction it will traverse. Returns null when the sprite ID does not
 * follow tracks, or when the probe finds no line-guide tile.
 *
 * Spawn coordinates are PIXELS (tile_col * 16, tile_row * 16 for
 * tile-aligned placements).
 */
export function resolveLineGuideAttachment(
  spriteId: number,
  spawnX: number, spawnY: number,
  l1: readonly (number | null)[][],
  onOffSwitchInitial: boolean,
): LineGuideAttachment | null {
  let init: InitResult
  if (LINE_GUIDED_IDS.has(spriteId)) {
    init = applyInitLineGuidedSpr(spawnX, spawnY)
  } else if (LINE_PLATFORM_IDS.has(spriteId)) {
    init = applyInitLinePlat(spawnX, spawnY)
  } else {
    return null
  }
  const trackTile = probeTrackTile(init.probeX, init.probeY, l1, onOffSwitchInitial)
  return trackTile ? { trackTile, direction: init.direction } : null
}
