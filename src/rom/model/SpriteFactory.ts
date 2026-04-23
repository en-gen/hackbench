import type { LevelSprite } from '../LevelParser'
import type { RomFile } from '../RomFile'
import { buildSpriteLayout, readSpriteTileTables } from '../SpriteTileLoader'
import type { Char } from './chars/Char'
import { makeTransparentPlaceholderChar } from './tiles/TileFactory'
import { Sprite } from './sprites/Sprite'
import { CompositeSprite } from './sprites/CompositeSprite'
import { StaticSpriteAppearance, type SpritePart } from './sprites/appearances/StaticSpriteAppearance'
import { PSwitchAppearance } from './sprites/appearances/PSwitchAppearance'
import { ThwompAppearance } from './sprites/appearances/ThwompAppearance'
import { WingedSpriteAppearance } from './sprites/appearances/WingedSpriteAppearance'
import { BanzaiBillAppearance } from './sprites/appearances/BanzaiBillAppearance'
import { HammerBroPlatformAppearance } from './sprites/appearances/HammerBroPlatformAppearance'
import type { SpriteAppearance } from './sprites/SpriteAppearance'
import type { SpriteBehavior } from './sprites/SpriteBehavior'
import { getSpriteMetadata } from './sprites/SpriteMetadata'

/**
 * Load sprites for a level and wrap them in the self-rendering model.
 *
 * Each LevelSprite (x, y in tile coords + spriteId) becomes a
 * `Sprite(id, px*16, py*16, appearance, behavior)`. Appearance is a
 * `StaticSpriteAppearance` assembled from the ROM's per-sprite-id
 * layout (SubSprGfx tables + the hand-extracted 0x54-0xC8 overrides).
 *
 * Sprites without a known layout fall back to a single-char anchor
 * marker so they still render *something* (matches the legacy fallback).
 * Sprites with no anchor char at all are skipped.
 */
export function buildSprites(
  rom: RomFile,
  levelSprites: readonly LevelSprite[],
  chars: Map<number, Char>,
  l1: readonly (number | null)[][],
): Sprite[] {
  const tables = readSpriteTileTables(rom)
  if (!tables) return []

  const placeholder = makeTransparentPlaceholderChar()

  // Pre-scan: $9C (Hammer Bro Platform) absorbs a co-located $9B into a
  // CompositeSprite. In vanilla SMW these always come paired at identical
  // (x, y); the paired $9B is suppressed from the top-level list and
  // re-emitted as the composite's child. See plan in
  // docs/sprite-validation-batches.md (and Annex in the plan file).
  const suppressed = new Set<number>()          // indices to skip
  const pairedBro = new Map<number, number>()   // $9C index → $9B index
  for (let i = 0; i < levelSprites.length; i++) {
    if (levelSprites[i].spriteId !== 0x9C) continue
    for (let j = 0; j < levelSprites.length; j++) {
      if (i === j || suppressed.has(j)) continue
      const a = levelSprites[i], b = levelSprites[j]
      if (b.spriteId === 0x9B && a.x === b.x && a.y === b.y) {
        pairedBro.set(i, j)
        suppressed.add(j)
        break
      }
    }
  }

  const out: Sprite[] = []
  for (let i = 0; i < levelSprites.length; i++) {
    if (suppressed.has(i)) continue
    const s = levelSprites[i]
    const behavior: SpriteBehavior = {
      kind: `sprite_${s.spriteId.toString(16)}`,
      ...getSpriteMetadata(s.spriteId),
    }

    // Sprite $9F (Banzai Bill) renders a 4×4 grid of 16×16 big-tiles (64×64 px)
    // from CODE_02D5E4 (bank_02.asm:11338) — not the single 16×16 fallback that
    // buildSpriteLayout would produce. Placed at the screen edge to show the
    // spawn-in position when the screen scrolls.
    if (s.spriteId === 0x9F) {
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        BanzaiBillAppearance.fromTables(chars, placeholder),
        behavior,
      ))
      continue
    }

    // Sprite $26 (Thwomp) has a custom ROM draw routine (ThwompGfx, not
    // SubSprGfx2): 4 body big-tiles at x+4/x+12 relative to the
    // InitThwomp-shifted anchor plus a cursor-selected face tile. The
    // generic layout would place it as a single 16×16 big-tile in the
    // wrong spot, so dispatch to the dedicated appearance.
    if (s.spriteId === 0x26) {
      const attr     = tables.spriteAttr[s.spriteId] ?? 0
      const palette  = 8 + ((attr >> 1) & 0x07)
      const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0
      const px       = s.x * 16
      const py       = s.y * 16
      const thwompBehavior: SpriteBehavior = {
        ...behavior,
        reactRangeDy: thwompReactRangeDy(l1, px, py),
      }
      out.push(new Sprite(
        s.spriteId, px, py,
        ThwompAppearance.fromTables(chars, palette, charHigh, placeholder),
        thwompBehavior,
      ))
      continue
    }

    // Sprites $83/$84 (Left/Right Flying Question Block) draw a 16×16 ? block
    // body plus two animated 8×8 wing tiles driven by ctx.animFrame, matching
    // the in-game KoopaWingGfxRt/CODE_019E95 routine (bank_01.asm:4024/4083).
    if (s.spriteId === 0x83 || s.spriteId === 0x84) {
      const layout = buildSpriteLayout(tables, s.spriteId)
      const bodyParts: SpritePart[] = (layout?.tiles ?? []).map(t => ({
        char: chars.get(t.charNum) ?? placeholder,
        palette: t.palette, flipX: t.flipX, flipY: t.flipY, dx: t.dx, dy: t.dy,
      }))
      const WING_PAL = 11
      const BASE = 0x400
      const c = (n: number) => chars.get(BASE + n) ?? placeholder
      const p = (n: number, dx: number, dy: number, flipX: boolean): SpritePart =>
        ({ char: c(n), palette: WING_PAL, flipX, flipY: false, dx, dy })
      // Frame 0: one 8×8 tile per wing (OAM size $00)
      const wf0: SpritePart[] = [
        p(0x5D,  -3, -2, true),   // left
        p(0x5D,  11, -2, false),  // right
      ]
      // Frame 1: 16×16 OAM tile per wing (size $02) = 2×2 block of 8×8 chars.
      // Left wing has flipX set → SNES swaps columns and flips each tile.
      // Sibling chars: $C6→TL, $C7→TR, $D6→BL, $D7→BR (VRAM layout: +1 right, +$10 down)
      const wf1: SpritePart[] = [
        p(0xC7, -11, -10, true),  p(0xC6,  -3, -10, true),   // left wing top row
        p(0xD7, -11,  -2, true),  p(0xD6,  -3,  -2, true),   // left wing bottom row
        p(0xC6,  11, -10, false), p(0xC7,  19, -10, false),  // right wing top row
        p(0xD6,  11,  -2, false), p(0xD7,  19,  -2, false),  // right wing bottom row
      ]
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        new WingedSpriteAppearance(bodyParts, [wf0, wf1]),
        behavior,
      ))
      continue
    }

    // Sprites $0A/$0B/$0C (Red Vert Para-Koopa / Red Horz Para-Koopa / Yellow Para-Koopa).
    // Spr0to13Gfx (bank_01.asm:1748) calls KoopaWingGfxRt for indices > $08 — no
    // CODE_019E95 pre-adjustment, so wing offsets come directly from KoopaWingDispXLo/Y
    // (bank_01.asm:4006). Wings render in front of the koopa body (wingsInFront=true).
    if (s.spriteId === 0x0A || s.spriteId === 0x0B || s.spriteId === 0x0C) {
      const layout = buildSpriteLayout(tables, s.spriteId)
      const bodyParts: SpritePart[] = (layout?.tiles ?? []).map(t => ({
        char: chars.get(t.charNum) ?? placeholder,
        palette: t.palette, flipX: t.flipX, flipY: t.flipY, dx: t.dx, dy: t.dy,
      }))
      const [wf0, wf1] = buildKoopaWingFrames(chars, placeholder)
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        new WingedSpriteAppearance(bodyParts, [wf0, wf1], true),
        behavior,
      ))
      continue
    }

    // Keyhole ($0E). The game's handler (bank_01.asm:13209) writes two 8×8 OAM
    // entries with hardcoded tile numbers — tile $EB at (x+8, y) and tile $FB
    // at (x+8, y+8), attr $30 (OBJ palette 0 = CGRAM row 8, charHigh=0, priority 3).
    // InitKeyHole (bank_01.asm:13199) permanently adds +8 to SpriteXPosLow before
    // the main loop starts, so the tile positions already include that offset.
    // The generic SprTilemapOffset path picks the wrong tiles; this case overrides it.
    if (s.spriteId === 0x0E) {
      const OBJ_BASE = 0x400
      const KEYHOLE_PAL = 8   // OBJ palette 0 = CGRAM row 8
      const keyholeparts: SpritePart[] = [
        { char: chars.get(OBJ_BASE + 0xEB) ?? placeholder, palette: KEYHOLE_PAL, flipX: false, flipY: false, dx: 8, dy: 0 },
        { char: chars.get(OBJ_BASE + 0xFB) ?? placeholder, palette: KEYHOLE_PAL, flipX: false, flipY: false, dx: 8, dy: 8 },
      ]
      out.push(new Sprite(s.spriteId, s.x * 16, s.y * 16, new StaticSpriteAppearance(keyholeparts), behavior))
      continue
    }

    // Sprite $9C (Hammer Brother Platform). FlyingPlatformGfx (bank_02.asm:12216)
    // draws 2 static turn-blocks + 2 animated wings; at runtime, when a $9B is
    // co-located, PutHammerBroOnPlat repositions it 16px up and calls
    // HammerBroGfx. We build a CompositeSprite so the Hammer Bro retains its
    // own id/displayName/behavior for hover.
    if (s.spriteId === 0x9C) {
      const platformApp = buildHammerBroPlatformAppearance(chars, placeholder)
      const broIdx = pairedBro.get(i)
      let spr: Sprite
      if (broIdx !== undefined) {
        const broLevelSprite = levelSprites[broIdx]
        const broBehavior: SpriteBehavior = {
          kind: `sprite_${broLevelSprite.spriteId.toString(16)}`,
          ...getSpriteMetadata(broLevelSprite.spriteId),
        }
        const broLayout = buildSpriteLayout(tables, 0x9B)
        const broParts: SpritePart[] = (broLayout?.tiles ?? []).map(t => ({
          char: chars.get(t.charNum) ?? placeholder,
          palette: t.palette, flipX: t.flipX, flipY: t.flipY, dx: t.dx, dy: t.dy,
        }))
        const broSprite = new Sprite(
          broLevelSprite.spriteId,
          broLevelSprite.x * 16,
          broLevelSprite.y * 16 - 16,          // 16px = 1 tile above the platform
          new StaticSpriteAppearance(broParts),
          broBehavior,
        )
        spr = new CompositeSprite(s.spriteId, s.x * 16, s.y * 16, platformApp, behavior, broSprite)
      } else {
        spr = new Sprite(s.spriteId, s.x * 16, s.y * 16, platformApp, behavior)
      }
      out.push(spr)
      continue
    }

    const layout = buildSpriteLayout(tables, s.spriteId)
    if (!layout) {
      const boxChar = chars.get(-2) ?? makeTransparentPlaceholderChar()
      const palette = 8 + ((tables.spriteAttr[s.spriteId] ?? 0) >> 1 & 0x07)
      const boxParts: SpritePart[] = [
        { char: boxChar, palette, flipX: false, flipY: false, dx: 0, dy: 0 },
        { char: boxChar, palette, flipX: true,  flipY: false, dx: 8, dy: 0 },
        { char: boxChar, palette, flipX: false, flipY: true,  dx: 0, dy: 8 },
        { char: boxChar, palette, flipX: true,  flipY: true,  dx: 8, dy: 8 },
      ]
      out.push(new Sprite(s.spriteId, s.x * 16, s.y * 16, new StaticSpriteAppearance(boxParts), behavior))
      continue
    }

    const parts: SpritePart[] = layout.tiles.map(t => ({
      char: chars.get(t.charNum) ?? placeholder,
      palette: t.palette,
      flipX: t.flipX,
      flipY: t.flipY,
      dx: t.dx,
      dy: t.dy,
    }))

    const appearance: SpriteAppearance = s.spriteId === 0x3E
      ? new PSwitchAppearance(parts)
      : new StaticSpriteAppearance(parts)
    out.push(new Sprite(s.spriteId, s.x * 16, s.y * 16, appearance, behavior))
  }
  return out
}

/**
 * Build para-koopa wing frames from the raw KoopaWingGfxRt tables (bank_01.asm:4006).
 * Para-koopas call KoopaWingGfxRt directly (no CODE_019E95 pre-adjustment).
 *
 * KoopaWingGfxRt is called ONCE per frame (Spr0to13Gfx:1788) and draws ONE wing.
 * SpriteMisc157C selects the wing side: 0 → left (index 0/1, dx=-1, flipX),
 *                                        1 → right (index 2/3, dx=+9, no flip).
 * SubSprGfx1:3957 maps SpriteMisc157C=1 → body NOT flipped (right-facing), so
 * we display the right wing to match the default right-facing body.
 *
 *   KoopaWingDispXLo/Hi index 2/3: $09/$00 → dx=+9
 *   KoopaWingDispY       index 2/3: $FC/$F4 → dy=-4 / -12
 *   KoopaWingTiles:      $5D (8×8, frame 0), $C6 (16×16, frame 1)
 *   KoopaWingGfxProp     index 2/3: $06 → no flipX
 */
function buildKoopaWingFrames(
  chars: Map<number, Char>,
  placeholder: Char,
): [SpritePart[], SpritePart[]] {
  const WING_PAL = 11
  const BASE = 0x400
  const c = (n: number) => chars.get(BASE + n) ?? placeholder
  const p = (n: number, dx: number, dy: number, flipX: boolean): SpritePart =>
    ({ char: c(n), palette: WING_PAL, flipX, flipY: false, dx, dy })

  // Frame 0 (editor default, animFrame=0): 16×16 right wing open (tile $C6, table index 3).
  // Game frame order has $5D first, but animFrame resets to 0 before first render,
  // so we put the open wing here to match the editor's default display state.
  // SNES large-OBJ no-flip: TL←N, TR←N+1, BL←N+$10, BR←N+$11.
  const wf0: SpritePart[] = [
    p(0xC6,  9, -12, false), p(0xC7, 17, -12, false),
    p(0xD6,  9,  -4, false), p(0xD7, 17,  -4, false),
  ]

  // Frame 1: 8×8 right wing closed (tile $5D, table index 2)
  const wf1: SpritePart[] = [p(0x5D, 9, -4, false)]

  return [wf0, wf1]
}

/**
 * Build $9C's own visual parts (2 static turn-blocks + 2 animated wing frames)
 * directly from the ROM tile data in FlyingPlatformGfx. Palette 9 / charHigh 0
 * come from the hardcoded attribute $32 — independent of Sprite166EVals which
 * the runtime routine doesn't consult.
 */
function buildHammerBroPlatformAppearance(
  chars: Map<number, Char>,
  placeholder: Char,
): HammerBroPlatformAppearance {
  const PAL = 9                 // attr $32 & $0F = $02 → OBJ palette 1 → CGRAM row 9
  const OBJ_BASE = 0x400
  const c = (n: number) => chars.get(OBJ_BASE + (n & 0x1FF)) ?? placeholder

  // SNES large-OBJ expansion: baseTile N → chars [N, N+1, N+$10, N+$11] at
  // (0,0), (8,0), (0,8), (8,8). flipX reverses column order AND flips each tile.
  const bigTile = (baseTile: number, dx: number, dy: number, flipX = false): SpritePart[] => {
    const co = flipX ? [0x01, 0x00, 0x11, 0x10] : [0x00, 0x01, 0x10, 0x11]
    const dxo = [0, 8, 0, 8]
    const dyo = [0, 0, 8, 8]
    return co.map((off, i) => ({
      char: c(baseTile + off),
      palette: PAL,
      flipX,
      flipY: false,
      dx: dx + dxo[i],
      dy: dy + dyo[i],
    }))
  }

  // Single 8×8 OAM tile (OAM size $00 in HammerBroTileSize).
  const smallTile = (tile: number, dx: number, dy: number, flipX = false): SpritePart => ({
    char: c(tile),
    palette: PAL,
    flipX,
    flipY: false,
    dx,
    dy,
  })

  const platformParts: SpritePart[] = [
    ...bigTile(0x40,  0, 0),
    ...bigTile(0x40, 16, 0),
  ]

  // Frame 0: big-tile wings at (-14, -10) flipX and (+30, -10).
  const frame0: SpritePart[] = [
    ...bigTile(0xC6, -14, -10, true),
    ...bigTile(0xC6,  30, -10, false),
  ]

  // Frame 1: 8×8 wings at (-6, -2) flipX and (+30, -2).
  const frame1: SpritePart[] = [
    smallTile(0x5D, -6, -2, true),
    smallTile(0x5D, 30, -2, false),
  ]

  return new HammerBroPlatformAppearance(platformParts, [frame0, frame1])
}

/**
 * Pixel distance from `py` (top of thwomp body) down through the bottom of
 * the first solid L1 row below the body — i.e. where the thwomp would stop
 * falling. Any non-null tile counts as a blocker (matches the fall-path
 * overlay in drawThwompZones). Falls back to the level floor when nothing
 * blocks. The appearance uses this to gate face-tile reactivity by cursor Y.
 */
function thwompReactRangeDy(
  l1: readonly (number | null)[][],
  px: number,
  py: number,
): number {
  const rows     = l1.length
  const colStart = Math.floor((px + 4) / 16)
  const colEnd   = Math.ceil((px + 28) / 16)
  const startRow = Math.ceil((py + 32) / 16)
  let blockerRow = rows
  outer: for (let r = startRow; r < rows; r++) {
    for (let c = colStart; c < colEnd; c++) {
      if ((l1[r]?.[c] ?? null) !== null) { blockerRow = r; break outer }
    }
  }
  const zoneBottom = blockerRow < rows ? (blockerRow + 1) * 16 : rows * 16
  return zoneBottom - py
}

