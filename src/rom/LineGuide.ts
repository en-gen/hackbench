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
 * InitLinePlat for sprites $62-$64 (bank_01.asm:11774).
 *
 * Bit 4 of SpriteXPosLow (XORed into SpriteMisc1602) picks the draw shift:
 *   clear → SpriteMisc1602=$10 → xShift=$28 (forward)
 *   set   → SpriteMisc1602=$00 → xShift=$18 (reverse)
 *
 * CODE_01DAA2 (bank_01.asm:12323) applies (X -= xShift, Y -= $08) only for
 * the OAM draw, then RESTORES X/Y from the stack before calling CODE_01D74D
 * (bank_01.asm:12358). InitLinePlat also INCs SpriteMisc1540 to 1 before the
 * first LineFuzzy_Plats call (bank_01.asm:11781), which bypasses the same-tile
 * skip in CODE_01D7F4 so all four corners are probed.
 *
 * The 4-corner probe therefore runs at the UNSHIFTED spawn position — not at
 * (spawnX - xShift, spawnY - $08).
 */
function applyInitLinePlat(spawnX: number, spawnY: number): InitResult {
  const xLow = spawnX & 0xFF
  const forward = (xLow & 0x10) === 0
  return {
    probeX: spawnX,
    probeY: spawnY,
    direction: forward ? 'forward' : 'reverse',
  }
}

/**
 * Compute the pixel anchor for a line-guided sprite given the resolved
 * attachment and the sprite's spawn tile.
 *
 * The anchor is the sprite's nominal pixel position — what gets passed to
 * `new Sprite(id, anchorX, anchorY, ...)` and ultimately to
 * `appearance.render(ctx, target, x, y)`. When the probe finds a track tile
 * the anchor snaps to that tile's pixel origin; otherwise it falls back to
 * the spawn tile's pixel origin. Either way the returned anchor equals the
 * game's SpriteXPosLow / SpriteYPosLow at the moment the platform's draw
 * routine runs.
 *
 * `drawOffsetX/Y` absorb any fixed pre-OAM shift that the sprite's draw
 * routine applies but the Appearance's `render()` does NOT replicate:
 *
 *   $62/$63 — render() subtracts xShift and 8 itself  → drawOffset (0, 0)
 *   $64     — StaticSpriteAppearance adds no offset    → drawOffset (−8, −8)
 *             (CODE_01DC54 does _0=SpriteX−8, _1=SpriteY−8 before OAM)
 */
export function lineGuideAnchor(
  lineGuide: LineGuideAttachment | null | undefined,
  spawnCol:  number,
  spawnRow:  number,
  drawOffsetX = 0,
  drawOffsetY = 0,
): { anchorX: number; anchorY: number } {
  const baseX = lineGuide?.trackTile ? lineGuide.trackTile.col * 16 : spawnCol * 16
  const baseY = lineGuide?.trackTile ? lineGuide.trackTile.row * 16 : spawnRow * 16
  return { anchorX: baseX + drawOffsetX, anchorY: baseY + drawOffsetY }
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
