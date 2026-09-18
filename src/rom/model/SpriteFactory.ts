import type { LevelSprite } from '../LevelParser'
import { LINE_TRACKED_SPRITE_IDS, lineGuideAnchor, resolveLineGuideAttachment } from '../LineGuide'
import type { RomFile } from '../RomFile'
import { buildSpriteLayout, buildYoshiEggLayout, readSpriteTileTables, YOSHI_EGG_ID } from '../SpriteTileLoader'
import type { Char } from './chars/Char'
import { isPriorityDecorative } from './OverlayContext'
import type { Tile } from './tiles/Tile'
import { makeTransparentPlaceholderChar } from './tiles/TileFactory'
import { Sprite } from './sprites/Sprite'
import { CompositeSprite } from './sprites/CompositeSprite'
import { StaticSpriteAppearance, type SpritePart } from './sprites/appearances/StaticSpriteAppearance'
import { buildSpriteAppearance } from './sprites/appearances/AppearanceFactory'
import { RipVanFishAppearance } from './sprites/appearances/RipVanFishAppearance'
import { ThwompAppearance } from './sprites/appearances/ThwompAppearance'
import { ThwimpAppearance } from './sprites/appearances/ThwimpAppearance'
import { WingedSpriteAppearance } from './sprites/appearances/WingedSpriteAppearance'
import { BallAndChainAppearance } from './sprites/appearances/BallAndChainAppearance'
import { BanzaiBillAppearance } from './sprites/appearances/BanzaiBillAppearance'
import { HammerBroAppearance } from './sprites/appearances/HammerBroAppearance'
import { HammerBroPlatformAppearance } from './sprites/appearances/HammerBroPlatformAppearance'
import { VolcanoLotusAppearance } from './sprites/appearances/VolcanoLotusAppearance'
import { LineBrownPlatAppearance } from './sprites/appearances/LineBrownPlatAppearance'
import { LineCheckerPlatAppearance } from './sprites/appearances/LineCheckerPlatAppearance'
import { RopeMechanismAppearance } from './sprites/appearances/RopeMechanismAppearance'
import { ChainsawAppearance } from './sprites/appearances/ChainsawAppearance'
import { SuperKoopaAppearance } from './sprites/appearances/SuperKoopaAppearance'
import { DryBonesAppearance } from './sprites/appearances/DryBonesAppearance'
import { BouncinChuckAppearance } from './sprites/appearances/BouncinChuckAppearance'
import { CharginChuckAppearance } from './sprites/appearances/CharginChuckAppearance'
import { ChuckAppearance } from './sprites/appearances/ChuckAppearance'
import { ClappinChuckAppearance } from './sprites/appearances/ClappinChuckAppearance'
import { PitchinChuckAppearance } from './sprites/appearances/PitchinChuckAppearance'
import { WhistlinChuckAppearance } from './sprites/appearances/WhistlinChuckAppearance'
import { PuntinChuckAppearance } from './sprites/appearances/PuntinChuckAppearance'
import { SplittinChuckAppearance } from './sprites/appearances/SplittinChuckAppearance'
import { KeyholeAppearance } from './sprites/appearances/KeyholeAppearance'
import { MagikoopaAppearance } from './sprites/appearances/MagikoopaAppearance'
import { MAGIKOOPA_PALS, readDynPalEntry, resolveRestingEntry } from './palette/DynSpritePalette'
import { SpikeTopAppearance } from './sprites/appearances/SpikeTopAppearance'
import { MontyMoleAppearance } from './sprites/appearances/MontyMoleAppearance'
import { SumoBrotherAppearance } from './sprites/appearances/SumoBrotherAppearance'
import { WoodSpikeAppearance } from './sprites/appearances/WoodSpikeAppearance'
import { WigglerAppearance } from './sprites/appearances/WigglerAppearance'
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

  // $1F's on-screen colours are uploaded to CGRAM by its teleport fade
  // (CODE_01C028, bank_01.asm:8733), not supplied by the level palette. Which
  // rung the fade rests on is re-read from this cart, not assumed.
  const magikoopaPal =
    readDynPalEntry(rom, MAGIKOOPA_PALS, resolveRestingEntry(rom, MAGIKOOPA_PALS)) ?? []

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

    // $9E (Ball and Chain) -- sphere (4× 8×8 tile $EA) + 2 chain links (tile $E8)
    // from CODE_02D813 (sphere) and CODE_02D62A (chain loop).
    // Rest pose: theta=0 (InitBallNChain default) → sphere 56 px below pivot.
    if (s.spriteId === 0x9E) {
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        BallAndChainAppearance.fromTables(chars, placeholder),
        behavior,
      ))
      continue
    }

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
    // body plus two animated 8×8 wing tiles advanced by the appearance's
    // internal sprite-tick state, matching the in-game KoopaWingGfxRt /
    // CODE_019E95 routine (bank_01.asm:4024/4083).
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
          new HammerBroAppearance(broParts),
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

    // Chuck-family sprites ($91 Chargin', $92 Splittin', $93 Bouncin',
    // $94 Whistlin', $95 Clappin', $97 Puntin', $98 Pitchin'). All resolve
    // their body palette / charHigh from Sprite166EVals via
    // ChuckAppearance.bodyAttrs and their face direction from FaceMario via
    // ChuckAppearance.facesMario — see ChuckAppearance.ts for the full asm
    // grounding. Per-chuck dispatch differs only in which appearance class
    // is built and (for Puntin') the extra ball palette derived from
    // sprite $1B.
    if (
      s.spriteId === 0x91 || s.spriteId === 0x92 || s.spriteId === 0x93
   || s.spriteId === 0x94 || s.spriteId === 0x95
   || s.spriteId === 0x97 || s.spriteId === 0x98
    ) {
      const { palette: bodyPalette, charHigh: bodyCharHigh } =
        ChuckAppearance.bodyAttrs(tables.spriteAttr[s.spriteId] ?? 0)
      const faceRight = ChuckAppearance.facesMario(s.x * 16, marioStartPx.x)
      let appearance: ChuckAppearance
      switch (s.spriteId) {
        case 0x91:
          appearance = CharginChuckAppearance.fromTables(chars, placeholder, bodyPalette, bodyCharHigh, faceRight)
          break
        case 0x92:
          appearance = SplittinChuckAppearance.fromTables(chars, placeholder, bodyPalette, bodyCharHigh, faceRight)
          break
        case 0x93:
          appearance = BouncinChuckAppearance.fromTables(chars, placeholder, bodyPalette, bodyCharHigh, faceRight)
          break
        case 0x94:
          appearance = WhistlinChuckAppearance.fromTables(chars, placeholder, bodyPalette, bodyCharHigh, faceRight)
          break
        case 0x95:
          appearance = ClappinChuckAppearance.fromTables(chars, placeholder, bodyPalette, bodyCharHigh, faceRight)
          break
        case 0x97: {
          // Puntin' Chuck composes sprite $1B (Football) at its spawn offset
          // (CODE_03CBB3 bank_03.asm:8769); its palette comes from $1B's attr.
          const { palette: ballPalette, charHigh: ballCharHigh } =
            ChuckAppearance.bodyAttrs(tables.spriteAttr[0x1B] ?? 0)
          appearance = PuntinChuckAppearance.fromTables(
            chars, placeholder, bodyPalette, bodyCharHigh, ballPalette, ballCharHigh, faceRight,
          )
          break
        }
        case 0x98:
          appearance = PitchinChuckAppearance.fromTables(chars, placeholder, bodyPalette, bodyCharHigh, faceRight)
          break
      }
      out.push(new Sprite(s.spriteId, s.x * 16, s.y * 16, appearance, behavior))
      continue
    }

    // $9A (Sumo Brother) — custom 4-part OAM layout via SumoBroGfx
    // (bank_02.asm:12456). Generic buildSpriteLayout returns only the head
    // tile fallback ($98) since the sprite uses its own table-driven render
    // path; build the full head-plus-body layout here.
    if (s.spriteId === 0x9A) {
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        SumoBrotherAppearance.fromTables(chars, placeholder),
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
      // Smoke palette is NOT inherited from the rope's body attr. CODE_029927
      // (bank_02.asm:3351-3352) copies SpriteProperties (DP $64) directly into
      // OAMTileAttr. SpriteProperties is the global priority byte set once at
      // level init by bank_00.asm:2401-2402 (`LDA #!OBJ_Priority2 = $20`);
      // no handler on the smoke path reloads it per-sprite, so the value at
      // smoke-render time is always $20. The decoded row coincidentally equals
      // bodyPalette, but it is derived independently here.
      const SMOKE_SPRITE_PROPERTIES = 0x20
      const smokePalette = 8 + ((SMOKE_SPRITE_PROPERTIES >> 1) & 0x07)
      const { anchorX, anchorY } = lineGuideAnchor(lineGuide, s.x, s.y, -8, -8)
      out.push(new Sprite(
        s.spriteId, anchorX, anchorY,
        RopeMechanismAppearance.fromTables(chars, motorPalette, bodyPalette, smokePalette, charHigh, placeholder),
        behavior,
      ))
      continue
    }

    // Sprite $65/$66 (Chainsaw / Upside-down Chainsaw, line-guided).
    // ChainsawGfx (bank_03.asm:7639) places OAM at (SprX−8, SprY−8); the
    // −8/−8 draw offset is absorbed here via lineGuideAnchor so the Appearance
    // renders motor + chain segments at (0,0) and (0, chainDy) relative to anchor.
    // Chain direction: DATA_03C25F[id−$65]=$F2=−14 ($65 above), $0E=+14 ($66 below).
    if (s.spriteId === 0x65 || s.spriteId === 0x66) {
      const { anchorX, anchorY } = lineGuideAnchor(lineGuide, s.x, s.y, -8, -8)
      out.push(new Sprite(
        s.spriteId, anchorX, anchorY,
        ChainsawAppearance.fromTables(chars, s.spriteId === 0x66, placeholder),
        behavior,
      ))
      continue
    }

    // $67 (Grinder): CODE_01DC0B draws 4 big-tiles via DATA_01DC3B/3F
    // X offsets $F0,$00,$F0,$00 and Y offsets $F0,$F0,$00,$00 — 32×32 sprite
    // with OAM anchor at SprX/SprY and visual centre at SprX−0.5.
    // lineGuideAnchor snaps to the track tile's pixel origin (col*16); +8 offsets
    // the anchor to the tile centre so the 32×32 body straddles it symmetrically.
    // $68 (Fuzz Ball): CODE_01DBD4 calls SubSprGfx2Entry1 after SBC #$08 so OAM
    // sits at (SprX−8, SprY−8) → 16×16 tile spans [SprX−8, SprX+7].
    // dispX=[0,8,0,8] means StaticSpriteAppearance renders at [anchor, anchor+15].
    // SprX ≈ col*16 + 4..11 → anchor = SprX−8 ≈ col*16 + 0 → drawOffset (0, 0).
    // Appearance is built inline (StaticSpriteAppearance for both) to avoid a
    // forward reference to the `let appearance` declared later in this loop body.
    if (s.spriteId === 0x67 || s.spriteId === 0x68) {
      const grLayout = buildSpriteLayout(tables, s.spriteId)
      if (grLayout) {
        const grParts: SpritePart[] = grLayout.tiles.map(t => ({
          char: chars.get(t.charNum) ?? placeholder,
          palette: t.palette,
          flipX: t.flipX,
          flipY: t.flipY,
          dx: t.dx,
          dy: t.dy,
        }))
        const dx = s.spriteId === 0x67 ? 8 : 0
        const dy = s.spriteId === 0x67 ? 8 : 0
        const { anchorX, anchorY } = lineGuideAnchor(lineGuide, s.x, s.y, dx, dy)
        out.push(new Sprite(s.spriteId, anchorX, anchorY, new StaticSpriteAppearance(grParts), behavior))
      }
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

    // $AC/$AD (Wooden Spike) — WoodSpikeGfx (bank_03.asm:2669).
    // 5 stacked 16×16 tiles from hardcoded WoodSpikeTiles/WoodSpikeGfxProp.
    // $AC: InitWoodSpike (bank_01.asm:488) subtracts $40 from Y → tip at spawn,
    //   body 64 px above; all V-flip (prop $81).
    // $AD: InitMontyMole (bank_01.asm:730) leaves Y unchanged → tip at spawn,
    //   body 64 px below; no flip (prop $01).
    if (s.spriteId === 0xAC || s.spriteId === 0xAD) {
      // spriteMisc151C = SpriteXPosLow & $10 (CODE_039475): non-zero negates Y speed.
      // For $AC, SpriteMisc151C is always 0 (InitWoodSpike never sets it).
      // For $AD, InitMontyMole sets it from (SpriteXPosLow & $10): bit 4 of pixel X.
      const spriteMisc151C = s.spriteId === 0xAD ? (s.x * 16) & 0x10 : 0
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        WoodSpikeAppearance.fromTables(chars, s.spriteId as 0xAC | 0xAD, placeholder, spriteMisc151C),
        behavior,
      ))
      continue
    }

    // $86 (Wiggler) — multi-segment chain per WigglerGfx (bank_02.asm:14987).
    // Head + 4 body big-tiles plus an 8×8 eye. H-flip is direction-dependent
    // via SpriteTableC2 shift register (face-right → H-flip on, face-left →
    // no flip). faceLeft mirrors FaceMario at spawn (CODE_02D4FA).
    if (s.spriteId === 0x86) {
      const attr     = tables.spriteAttr[s.spriteId] ?? 0
      const palette  = 8 + ((attr >> 1) & 0x07)
      const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0
      const faceLeft = marioStartPx.x < s.x * 16
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        WigglerAppearance.fromTables(chars, palette, charHigh, faceLeft, placeholder),
        behavior,
      ))
      continue
    }

    // $4D (ground Monty Mole) - 2-frame SubSprGfx0 pose, state 1 of the
    // SpriteTableC2 jump table (CODE_01E343, bank_01.asm:13388-13414).
    // DATA_01E35F selects the SpriteMisc1602 tile quad ($01/$02) and
    // DATA_01E361 the GeneralSprGfxProp flip quad ($00/$05); the generic
    // sub0 path in buildSpriteLayout hardcodes SpriteMisc1602 = 0 and so
    // reads the sprite's SubSprGfx2 frame list instead of either quad.
    if (s.spriteId === 0x4D) {
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        MontyMoleAppearance.fromTables(chars, tables, placeholder),
        behavior,
      ))
      continue
    }

    // $1F (Magikoopa) - SubSprGfx1 16x32 body + 8x8 wand, 4-frame state-2 cast
    // cycle. `Magikoopa` (bank_01.asm:8413) dispatches through SpriteTableC2 & 3;
    // only state 2 (CODE_01BE6E, bank_01.asm:8493) is a steady visible pose.
    // Facing is SubHorizPos, recomputed live in-game (bank_01.asm:8496-8498) and
    // pinned here to Mario's spawn side, as $30/$91 already do. Palette: the
    // resting MagiKoopaPals entry spliced over CGRAM row 15 columns 0-7.
    // See docs/sprite-1f-magikoopa.md.
    if (s.spriteId === 0x1F) {
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        MagikoopaAppearance.fromTables(chars, tables, placeholder, marioStartPx.x >= s.x * 16, magikoopaPal),
        behavior,
      ))
      continue
    }

    // $2E (Spike Top) - 2-frame animation per WallFollowersMain bank_02.asm:8079-8091.
    // Tiles at SprTilemap[tilemapBase+0/1] alternate every 8 ticks; direction is
    // hardcoded to 0 (DATA_02BCC7[0]=$00, no flip), which is wrong when Mario spawns
    // left of the sprite. See SpikeTopAppearance.fromTables.
    if (s.spriteId === 0x2E) {
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        SpikeTopAppearance.fromTables(chars, tables, placeholder),
        behavior,
      ))
      continue
    }

    // $2C (Yoshi Egg) - resting state, no idle animation; its palette depends
    // on the sprite's X position. See buildYoshiEggLayout for the ROM trace.
    if (s.spriteId === YOSHI_EGG_ID) {
      const eggLayout = buildYoshiEggLayout(tables, s.x * 16)
      const eggParts: SpritePart[] = eggLayout.tiles.map(t => ({
        char: chars.get(t.charNum) ?? placeholder,
        palette: t.palette,
        flipX: t.flipX,
        flipY: t.flipY,
        dx: t.dx,
        dy: t.dy,
      }))
      out.push(new Sprite(s.spriteId, s.x * 16, s.y * 16, new StaticSpriteAppearance(eggParts), behavior))
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

    // spriteId → "pure-parts" appearance subclass dispatch lives in
    // `buildSpriteAppearance` so the host and the webview rehydrate
    // path stay in sync (issue #293). Sprites with extra-data
    // appearances (Thwomp, RipVanFish, WingedSprite, etc.) are
    // constructed in their own branches above.
    const appearance: SpriteAppearance = buildSpriteAppearance(s.spriteId, parts)
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
  // Skip priority-decorative tiles (which pass through sprite collision)
  // and use
  // the authoritative `tile.collision.floor` predicate, which covers all
  // four CODE_01933B branches (incl. tiles like $100 whose acts-like is
  // page-0 solid behavior, missed by `isActsLikeVertSolid`'s $11..$6D
  // fast-path).
  const rows     = l1.length
  const colStart = Math.floor((px + 4) / 16)
  const colEnd   = Math.ceil((px + 28) / 16)
  const startRow = Math.ceil((py + 32) / 16)
  let blockerRow = rows
  outer: for (let r = startRow; r < rows; r++) {
    for (let c = colStart; c < colEnd; c++) {
      const id = l1[r]?.[c]
      if (id === null || id === undefined) continue
      const tile = l1Tiles.get(id)
      if (!tile || isPriorityDecorative(tile)) continue
      if (tile.collision.floor) { blockerRow = r; break outer }
    }
  }
  const zoneBottom = blockerRow < rows ? (blockerRow + 1) * 16 : rows * 16
  return zoneBottom - py
}
