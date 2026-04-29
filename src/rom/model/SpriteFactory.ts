import type { LevelSprite } from '../LevelParser'
import { LINE_TRACKED_SPRITE_IDS, lineGuideAnchor, resolveLineGuideAttachment } from '../LineGuide'
import type { RomFile } from '../RomFile'
import { buildSpriteLayout, readSpriteTileTables } from '../SpriteTileLoader'
import type { Char } from './chars/Char'
import { isActsLikeVertSolid } from './OverlayContext'
import type { Tile } from './tiles/Tile'
import { makeTransparentPlaceholderChar } from './tiles/TileFactory'
import { Sprite } from './sprites/Sprite'
import { CompositeSprite } from './sprites/CompositeSprite'
import { StaticSpriteAppearance, type SpritePart } from './sprites/appearances/StaticSpriteAppearance'
import { PSwitchAppearance } from './sprites/appearances/PSwitchAppearance'
import { BlurpAppearance } from './sprites/appearances/BlurpAppearance'
import { RipVanFishAppearance } from './sprites/appearances/RipVanFishAppearance'
import { ThwompAppearance } from './sprites/appearances/ThwompAppearance'
import { ThwimpAppearance } from './sprites/appearances/ThwimpAppearance'
import { WingedSpriteAppearance } from './sprites/appearances/WingedSpriteAppearance'
import { BanzaiBillAppearance } from './sprites/appearances/BanzaiBillAppearance'
import { HammerBroPlatformAppearance } from './sprites/appearances/HammerBroPlatformAppearance'
import { VolcanoLotusAppearance } from './sprites/appearances/VolcanoLotusAppearance'
import { CheepCheepAppearance } from './sprites/appearances/CheepCheepAppearance'
import { JumpingFishAppearance } from './sprites/appearances/JumpingFishAppearance'
import { SwimJumpFishAppearance } from './sprites/appearances/SwimJumpFishAppearance'
import { HopFlameAppearance } from './sprites/appearances/HopFlameAppearance'
import { LineBrownPlatAppearance } from './sprites/appearances/LineBrownPlatAppearance'
import { LineCheckerPlatAppearance } from './sprites/appearances/LineCheckerPlatAppearance'
import { RopeMechanismAppearance } from './sprites/appearances/RopeMechanismAppearance'
import { KoopaAppearance } from './sprites/appearances/KoopaAppearance'
import { SuperKoopaAppearance } from './sprites/appearances/SuperKoopaAppearance'
import { DryBonesAppearance } from './sprites/appearances/DryBonesAppearance'
import { CharginChuckAppearance } from './sprites/appearances/CharginChuckAppearance'
import { ClappinChuckAppearance } from './sprites/appearances/ClappinChuckAppearance'
import { KeyholeAppearance } from './sprites/appearances/KeyholeAppearance'
import { buildMovementBehavior } from './sprites/behaviors/BehaviorFactory'
import type { SpriteAppearance } from './sprites/SpriteAppearance'
import type { SpriteBehavior } from './sprites/SpriteBehavior'
import { getSpriteMetadata } from './sprites/SpriteMetadata'

/**
 * Load sprites for a level and wrap them in the self-rendering model.
 *
 * Each LevelSprite (x, y in tile coords + spriteId) becomes a
 * Sprite(id, px*16, py*16, appearance, behavior). Appearance is assembled
 * from the ROM's per-sprite-id layout (SubSprGfx tables + hand-extracted
 * 0x54-0xC8 overrides).
 *
 * Sprites without a known layout fall back to a single-char anchor
 * marker. Sprites with no anchor char at all are skipped.
 *
 * === CANNOT MIGRATE: items that must stay in this factory ===
 *
 * 1. $9C cross-sprite pairing (pre-scan + CompositeSprite construction):
 *    PutHammerBroOnPlat pairs a $9B Hammer Bro with a co-located $9C
 *    platform. The pairing requires scanning ALL sprites before any one
 *    is constructed. No single-sprite Appearance class can own this.
 *
 * 2. thwompReactRangeDy ($26 Thwomp behavior enrichment):
 *    Needs the full l1 grid and l1Tiles metadata map to walk downward
 *    from the spawn tile and find the first solid blocker row. Both are
 *    factory-level data structures too large/level-specific to pass
 *    through a fromTables signature. The reactRangeDy enrichment on the
 *    behavior object also depends on this result, so it stays here too.
 *
 * 3. airborne L1-probe for $71-$73 Super Koopa:
 *    l1[s.y+1]?.[s.x] checks the live L1 grid for a tile below the
 *    sprite. The result is passed to SuperKoopaAppearance.fromTables as
 *    the airborne parameter -- the factory keeps the one-line probe.
 *
 * 4. faceRight / marioStartPx direction resolution:
 *    Several sprites (DryBones, SuperKoopa, CharginChuck) call FaceMario
 *    at spawn. The factory has the mario start position and computes
 *    faceRight = marioStartPx.x >= spritePx, then passes it to fromTables.
 *    This computation stays in the factory; the per-sprite logic is inside
 *    the appearance class.
 */
export function buildSprites(
  rom: RomFile,
  levelSprites: readonly LevelSprite[],
  chars: Map<number, Char>,
  l1: readonly (number | null)[][],
  marioStartPx: { x: number; y: number },
  l1Tiles: Map<number, Tile>,
): Sprite[] {
  const tables = readSpriteTileTables(rom)
  if (!tables) return []

  const placeholder = makeTransparentPlaceholderChar()

  // Pre-scan: $9C (Hammer Bro Platform) absorbs a co-located $9B into a
  // CompositeSprite. Cannot migrate: requires multi-sprite scan before any
  // individual sprite is constructed. See CANNOT MIGRATE note above.
  const suppressed = new Set<number>()
  const pairedBro = new Map<number, number>()
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
    const lineGuide = LINE_TRACKED_SPRITE_IDS.has(s.spriteId)
      ? resolveLineGuideAttachment(s.spriteId, s.x * 16, s.y * 16, l1, false)
      : undefined
    const meta = getSpriteMetadata(s.spriteId) ?? {}
    const behavior: SpriteBehavior = Object.assign(
      buildMovementBehavior(s.spriteId, meta),
      lineGuide !== undefined ? { lineGuide } : {},
    )

    // $9F (Banzai Bill) -- 4x4 grid of 16x16 big-tiles from CODE_02D5E4.
    if (s.spriteId === 0x9F) {
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        BanzaiBillAppearance.fromTables(chars, placeholder),
        behavior,
      ))
      continue
    }

    // $3D (Rip Van Fish) — custom appearance with cursor-driven idle/detected
    // pose swap and a 96×96 detection-zone overlay (per CODE_02C02E's
    // |dx| < $30 && |dy| < $30 wake-up check). Pose tile bases come from
    // SprTilemap[$E2..$E5] indexed by SpriteMisc1602 — see RipVanFishAppearance.
    if (s.spriteId === 0x3D) {
      const attr     = tables.spriteAttr[s.spriteId] ?? 0
      const palette  = 8 + ((attr >> 1) & 0x07)
      const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        RipVanFishAppearance.fromTables(chars, palette, charHigh, placeholder),
        behavior,
      ))
      continue
    }

    // $26 (Thwomp) -- custom ThwompGfx routine; reactRangeDy stays in factory
    // because it needs the live l1 + l1Tiles data structures (CANNOT MIGRATE).
    if (s.spriteId === 0x26) {
      const attr     = tables.spriteAttr[s.spriteId] ?? 0
      const palette  = 8 + ((attr >> 1) & 0x07)
      const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0
      const px       = s.x * 16
      const py       = s.y * 16
      const thwompBehavior: SpriteBehavior = {
        ...behavior,
        reactRangeDy: thwompReactRangeDy(l1, l1Tiles, px, py),
      }
      out.push(new Sprite(
        s.spriteId, px, py,
        ThwompAppearance.fromTables(chars, palette, charHigh, placeholder),
        thwompBehavior,
      ))
      continue
    }

    // Sprite $27 (Thwimp) uses SubSprGfx0Entry0 with _5=1, giving four
    // independent 8×8 tiles with H-flip on the right column (TR, BR).
    // The generic sub0 path in buildSpriteLayout hardcodes flipX=false,
    // so it renders the right column un-mirrored. Dispatch to the
    // dedicated appearance which reads the same tables correctly.
    if (s.spriteId === 0x27) {
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        ThwimpAppearance.fromTables(chars, tables, placeholder),
        behavior,
      ))
      continue
    }

    // Sprites $83/$84 (Left/Right Flying Question Block) draw a 16×16 ? block
    // body plus two animated 8×8 wing tiles driven by ctx.animFrame, matching
    // the in-game KoopaWingGfxRt/CODE_019E95 routine (bank_01.asm:4024/4083).
    if (s.spriteId === 0x83 || s.spriteId === 0x84) {
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        WingedSpriteAppearance.fromFlyingQBlock(chars, placeholder, buildSpriteLayout(tables, s.spriteId)),
        behavior,
      ))
      continue
    }

    // $08/$09 (Green Para-Koopa) and $0A/$0B/$0C (Red/Yellow Para-Koopa).
    // All five share the same KoopaWingGfxRt wing geometry (wingsInFront=true).
    if (s.spriteId === 0x08 || s.spriteId === 0x09
     || s.spriteId === 0x0A || s.spriteId === 0x0B || s.spriteId === 0x0C) {
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        WingedSpriteAppearance.fromParaKoopa(chars, placeholder, buildSpriteLayout(tables, s.spriteId)),
        behavior,
      ))
      continue
    }

    // $10 (Para-Goomba).
    if (s.spriteId === 0x10) {
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        WingedSpriteAppearance.fromParaGoomba(chars, placeholder, buildSpriteLayout(tables, s.spriteId)),
        behavior,
      ))
      continue
    }

    // $0E (Keyhole).
    if (s.spriteId === 0x0E) {
      out.push(new Sprite(s.spriteId, s.x * 16, s.y * 16, KeyholeAppearance.fromTables(chars, placeholder), behavior))
      continue
    }

    // $9C (Hammer Bro Platform). Cross-sprite pairing must stay in the factory
    // (CANNOT MIGRATE). The platform appearance is now in fromTables.
    if (s.spriteId === 0x9C) {
      const platformApp = HammerBroPlatformAppearance.fromTables(chars, placeholder)
      const broIdx = pairedBro.get(i)
      let spr: Sprite
      if (broIdx !== undefined) {
        const broLevelSprite = levelSprites[broIdx]
        const broBehavior: SpriteBehavior = {
          kind: 'sprite_' + broLevelSprite.spriteId.toString(16),
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
          broLevelSprite.y * 16 - 16,
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

    // $30/$32 (Dry Bones).
    if (s.spriteId === 0x30 || s.spriteId === 0x32) {
      const attr      = tables.spriteAttr[s.spriteId] ?? 0
      const palette   = 8 + ((attr >> 1) & 0x07)
      const charHigh  = (attr & 0x01) !== 0 ? 0x100 : 0
      const faceRight = marioStartPx.x >= s.x * 16
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        DryBonesAppearance.fromTables(chars, placeholder, palette, charHigh, faceRight),
        behavior,
      ))
      continue
    }

    // $99 (Volcano Lotus).
    if (s.spriteId === 0x99) {
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        VolcanoLotusAppearance.fromTables(chars, placeholder),
        behavior,
      ))
      continue
    }

    // $71/$72/$73 (Super Koopa). airborne L1-probe stays in factory
    // (one-line check; see CANNOT MIGRATE note above). The cell directly
    // below the sprite is "ground" only if its tile resolves to a solid
    // floor (per TileFactory.classify) — page-0 decoration tiles like
    // $02D/$02E/$0A3 (the foreground bushes / clouds in level $00D)
    // sit visually behind the sprite and must NOT pin it to the grounded
    // pose. Mirrors `CODE_01928E` page-0 BEQ-skip semantics.
    if (s.spriteId === 0x71 || s.spriteId === 0x72 || s.spriteId === 0x73) {
      const spritePx  = s.x * 16
      const faceRight = marioStartPx.x >= spritePx
      const belowId   = l1[s.y + 1]?.[s.x] ?? null
      const belowTile = belowId !== null ? l1Tiles.get(belowId) : undefined
      const airborne  = !belowTile?.collision.floor
      out.push(new Sprite(
        s.spriteId, spritePx, s.y * 16,
        SuperKoopaAppearance.fromTables(
          chars, placeholder,
          tables.spriteAttr[s.spriteId] ?? 0,
          s.spriteId, faceRight, airborne,
        ),
        behavior,
      ))
      continue
    }

    // $91 (Chargin' Chuck).
    if (s.spriteId === 0x91) {
      const attr         = tables.spriteAttr[s.spriteId] ?? 0
      const bodyPalette  = 8 + ((attr >> 1) & 0x07)
      const bodyCharHigh = (attr & 0x01) !== 0 ? 0x100 : 0
      const faceRight    = marioStartPx.x >= s.x * 16
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        CharginChuckAppearance.fromTables(chars, placeholder, bodyPalette, bodyCharHigh, faceRight),
        behavior,
      ))
      continue
    }

    // $95 (Clappin' Chuck).
    if (s.spriteId === 0x95) {
      const attr         = tables.spriteAttr[s.spriteId] ?? 0
      const bodyPalette  = 8 + ((attr >> 1) & 0x07)
      const bodyCharHigh = (attr & 0x01) !== 0 ? 0x100 : 0
      const faceRight    = marioStartPx.x >= s.x * 16
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        ClappinChuckAppearance.fromTables(chars, placeholder, bodyPalette, bodyCharHigh, faceRight),
        behavior,
      ))
      continue
    }

    // Sprite $62 (Brown Platform, line-guided): direction-aware appearance.
    // Direction is derived from bit 4 of SpriteXPosLow by InitLinePlat
    // (bank_01.asm:11774) and resolved into lineGuide.direction above.
    if (s.spriteId === 0x62) {
      const attr     = tables.spriteAttr[0x62] ?? 0x01
      const palette  = 8 + ((attr >> 1) & 0x07)
      const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0
      const dir = lineGuide?.direction ?? 'reverse'
      // Anchor = sprite's nominal position (track tile origin when probe succeeds,
      // spawn tile origin otherwise). render() applies −xShift/−8 itself.
      const { anchorX, anchorY } = lineGuideAnchor(lineGuide, s.x, s.y)
      out.push(new Sprite(
        s.spriteId, anchorX, anchorY,
        LineBrownPlatAppearance.fromTables(chars, palette, charHigh, placeholder, dir),
        behavior,
      ))
      continue
    }

    // Sprite $63 (Checker Platform, line-guided).
    // InitLinePlat (bank_01.asm:11774): SpriteMisc1602 = (SpriteXPosLow & 0x10) ^ 0x10.
    // Even tile col → SpriteMisc1602≠0 → checker mode (80px, 5 tiles, xShift=40px).
    // Odd tile col  → SpriteMisc1602=0  → brown mode  (48px, 3 tiles, xShift=24px).
    // CODE_01DAA2 (bank_01.asm:12323) reads SpriteMisc1602 for xShift, same as $62, so the
    // same $18/$28 values apply. Unlike $62, xShift is fixed at spawn — not from lineGuide.
    if (s.spriteId === 0x63) {
      const attr        = tables.spriteAttr[0x63] ?? 0x01
      const palette     = 8 + ((attr >> 1) & 0x07)
      const charHigh    = (attr & 0x01) !== 0 ? 0x100 : 0
      const checkerMode = (s.x % 2 === 0)
      // Anchor = sprite's nominal position. render() applies −xShift/−8 itself.
      const { anchorX, anchorY } = lineGuideAnchor(lineGuide, s.x, s.y)
      out.push(new Sprite(
        s.spriteId, anchorX, anchorY,
        LineCheckerPlatAppearance.fromTables(chars, palette, charHigh, placeholder, checkerMode),
        behavior,
      ))
      continue
    }

    // Sprite $64 (Rope Mechanism, line-guided).
    // RopeMechanismAppearance owns the segment layout and motor animation.
    // See bank_01.asm:12557 (RopeMotorTiles), 12564 (CODE_01DC54), 12620 (knot overwrite).
    // Offset: _0=spriteX−8, _1=spriteY−8 absorbed via lineGuideAnchor drawOffset.
    if (s.spriteId === 0x64) {
      const attr        = tables.spriteAttr[0x64] ?? 0
      const charHigh    = (attr & 0x01) !== 0 ? 0x100 : 0
      const motorPalette = 11  // ($37 >> 1) & 0x07 = 3 → CGRAM 8+3=11
      const bodyPalette  = 8   // ($31 >> 1) & 0x07 = 0 → CGRAM 8+0=8
      const { anchorX, anchorY } = lineGuideAnchor(lineGuide, s.x, s.y, -8, -8)
      out.push(new Sprite(
        s.spriteId, anchorX, anchorY,
        RopeMechanismAppearance.fromTables(chars, motorPalette, bodyPalette, charHigh, placeholder),
        behavior,
      ))
      continue
    }

    // $0C4 (Grey Falling Platform) — CODE_038492 (bank_03.asm:528).
    // FallingPlatTiles=$60/$61/$61/$62 at FallingPlatDispX=0/16/32/48 px.
    // Sprite166EVals[$C4]=$F3 → &$0F=$03 → OBJ pal 1 (CGRAM row 9), charHigh=1 ($100).
    if (s.spriteId === 0xC4) {
      const OBJ_BASE = 0x400
      const attr = tables.spriteAttr[s.spriteId] ?? 0
      const palette = 8 + ((attr >> 1) & 0x07)
      const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0
      const tiles = [0x60, 0x61, 0x61, 0x62] as const
      const parts: SpritePart[] = tiles.flatMap((t, col) => {
        const dx = col * 16
        return [
          { char: chars.get(OBJ_BASE + charHigh + t)        ?? placeholder, palette, flipX: false, flipY: false, dx: dx,     dy: 0 },
          { char: chars.get(OBJ_BASE + charHigh + t + 1)    ?? placeholder, palette, flipX: false, flipY: false, dx: dx + 8, dy: 0 },
          { char: chars.get(OBJ_BASE + charHigh + t + 0x10) ?? placeholder, palette, flipX: false, flipY: false, dx: dx,     dy: 8 },
          { char: chars.get(OBJ_BASE + charHigh + t + 0x11) ?? placeholder, palette, flipX: false, flipY: false, dx: dx + 8, dy: 8 },
        ]
      })
      out.push(new Sprite(s.spriteId, s.x * 16, s.y * 16, new StaticSpriteAppearance(parts), behavior))
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

    let appearance: SpriteAppearance
    if (s.spriteId === 0x3E) {
      appearance = new PSwitchAppearance(parts)
    } else if (s.spriteId === 0x15) {
      appearance = new CheepCheepAppearance(parts, false)
    } else if (s.spriteId === 0x16) {
      appearance = new CheepCheepAppearance(parts, true)
    } else if (s.spriteId === 0x18) {
      appearance = new JumpingFishAppearance(parts)
    } else if (s.spriteId === 0x47) {
      appearance = new SwimJumpFishAppearance(parts)
    } else if (s.spriteId === 0x1D) {
      appearance = new HopFlameAppearance(parts)
    } else if (s.spriteId === 0xC2) {
      appearance = new BlurpAppearance(parts)
    } else if (s.spriteId <= 0x07 || s.spriteId === 0x0F) {
      // $00-$07 shelless + shelled koopas, $0F Goomba — all ground walkers
      // with KoopaWalkBehavior; KoopaAppearance draws the patrol-path overlay.
      appearance = new KoopaAppearance(parts)
    } else {
      appearance = new StaticSpriteAppearance(parts)
    }
    out.push(new Sprite(s.spriteId, s.x * 16, s.y * 16, appearance, behavior))
  }
  return out
}

/**
 * Pixel distance from py (top of thwomp body) down through the bottom of
 * the first solid L1 row below the body -- i.e. where the thwomp would stop
 * falling. Any non-null tile counts as a blocker. Falls back to the level
 * floor when nothing blocks. The appearance uses this to gate face-tile
 * reactivity by cursor Y.
 *
 * Cannot migrate to ThwompAppearance.fromTables: needs the full l1 grid and
 * l1Tiles map, which are factory-level level data structures, not ROM tables.
 */
function thwompReactRangeDy(
  l1: readonly (number | null)[][],
  l1Tiles: Map<number, Tile>,
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
      const id = l1[r]?.[c]
      if (id === null || id === undefined) continue
      const actsLike = l1Tiles.get(id)?.actsLike ?? id
      if (isActsLikeVertSolid(actsLike)) { blockerRow = r; break outer }
    }
  }
  const zoneBottom = blockerRow < rows ? (blockerRow + 1) * 16 : rows * 16
  return zoneBottom - py
}
