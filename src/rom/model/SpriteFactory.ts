import type { LevelSprite } from '../LevelParser'
import { LINE_TRACKED_SPRITE_IDS, resolveLineGuideAttachment } from '../LineGuide'
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
import { ThwompAppearance } from './sprites/appearances/ThwompAppearance'
import { WingedSpriteAppearance } from './sprites/appearances/WingedSpriteAppearance'
import { BanzaiBillAppearance } from './sprites/appearances/BanzaiBillAppearance'
import { HammerBroPlatformAppearance } from './sprites/appearances/HammerBroPlatformAppearance'
import { CheepCheepAppearance } from './sprites/appearances/CheepCheepAppearance'
import { JumpingFishAppearance } from './sprites/appearances/JumpingFishAppearance'
import { SwimJumpFishAppearance } from './sprites/appearances/SwimJumpFishAppearance'
import { HopFlameAppearance } from './sprites/appearances/HopFlameAppearance'
import { KoopaAppearance } from './sprites/appearances/KoopaAppearance'
import { buildMovementBehavior } from './sprites/behaviors/BehaviorFactory'
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
  marioStartPx: { x: number; y: number },
  l1Tiles: Map<number, Tile>,
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
    // OnOffSwitch starts OFF at level load (RAM $14AF initializes to 0).
    // Expose as an editor toggle later; for now, false matches default play.
    const lineGuide = LINE_TRACKED_SPRITE_IDS.has(s.spriteId)
      ? resolveLineGuideAttachment(s.spriteId, s.x * 16, s.y * 16, l1, false)
      : undefined
    const meta = getSpriteMetadata(s.spriteId) ?? {}
    const behavior: SpriteBehavior = Object.assign(
      buildMovementBehavior(s.spriteId, meta),
      lineGuide !== undefined ? { lineGuide } : {},
    )

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
        reactRangeDy: thwompReactRangeDy(l1, l1Tiles, px, py),
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

    // Sprites $08/$09 (Green Para-Koopa flying-left / bouncing).
    // GreenParaKoopa (bank_01.asm:1817) ends with JMP Spr0to13Gfx. Spr0to13Gfx
    // calls KoopaWingGfxRt for sprite IDs >= $08 (bank_01.asm:1785-1788) — same
    // wing data as $0A/$0B/$0C, wingsInFront=true.
    if (s.spriteId === 0x08 || s.spriteId === 0x09) {
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

    // Sprites $0A/$0B/$0C (Red Vert Para-Koopa / Red Horz Para-Koopa / Yellow Para-Koopa).
    // Spr0to13Gfx (bank_01.asm:1748) calls KoopaWingGfxRt for indices >= $08 — no
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

    // Sprite $10 (Para-Goomba) uses WingedGoomba (bank_01.asm:1934):
    // GoombaWingGfxRt draws 2 wing OBJ entries then SubSprGfx2Entry1 draws the
    // Goomba body tile ($AA). Wings use OBJ palette 3 (CGRAM row 11) from
    // GoombaWingGfxProp $06/$46 (no-flip left / flipX right). Facing left:
    //   frame 0: 16×16 $C6 — left wing at DATA_018DC7[0]=$F7=−9 / DATA_018DD7[0]=$F7=−9
    //                        right wing at DATA_018DC7[1]=$0B=+11 / DATA_018DD7[1]=$F7=−9, flipX
    //   frame 1: 8×8 $5D  — left wing at DATA_018DC7[4]=$FD=−3  / DATA_018DD7[4]=$01=+1
    //                        right wing at DATA_018DC7[5]=$0C=+12 / DATA_018DD7[5]=$01=+1, flipX
    if (s.spriteId === 0x10) {
      const gLayout = buildSpriteLayout(tables, s.spriteId)
      const gBody: SpritePart[] = (gLayout?.tiles ?? []).map(t => ({
        char: chars.get(t.charNum) ?? placeholder,
        palette: t.palette, flipX: t.flipX, flipY: t.flipY, dx: t.dx, dy: t.dy,
      }))
      const GPAL = 11
      const GBASE = 0x400
      const gc = (n: number) => chars.get(GBASE + n) ?? placeholder
      const gp = (n: number, dx: number, dy: number, flipX: boolean): SpritePart =>
        ({ char: gc(n), palette: GPAL, flipX, flipY: false, dx, dy })
      const gwf0: SpritePart[] = [          // large wings
        gp(0xC6, -9, -9, false), gp(0xC7, -1, -9, false),
        gp(0xD6, -9, -1, false), gp(0xD7, -1, -1, false),
        gp(0xC7, 11, -9, true),  gp(0xC6, 19, -9, true),
        gp(0xD7, 11, -1, true),  gp(0xD6, 19, -1, true),
      ]
      const gwf1: SpritePart[] = [          // small wings
        gp(0x5D, -3, 1, false),
        gp(0x5D, 12, 1, true),
      ]
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        new WingedSpriteAppearance(gBody, [gwf0, gwf1]),
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

    // Dry Bones ($30 throws bones, $32 stays on ledge). DryBonesAndBeetle
    // (bank_01.asm:13520) dispatches to CODE_03C3DA (bank_03.asm:7831), which
    // writes two 16×16 big-tiles directly from DryBonesTiles. InitDryBones is
    // FaceMario, so SpriteMisc157C = SubHorizPos's Y at spawn: 0 when Mario is
    // right of (or at) the sprite → Prop $43 (hflip), top at DispX[1]=+8; else 1
    // → Prop $03 (no flip), top at DispX[4]=-8. Top tile $64 (state 0 anim 0),
    // bottom tile $66. Palette 1 + charHigh 1 from Sprite166EVals[$30/$32]=$13.
    // Sprite $31 (Bony Beetle) shares the handler but CODE_03C3DA diverts it
    // (CMP #$31 BEQ → GenericSprGfxRt2), so $31 stays on the generic path.
    if (s.spriteId === 0x30 || s.spriteId === 0x32) {
      const attr     = tables.spriteAttr[s.spriteId] ?? 0
      const palette  = 8 + ((attr >> 1) & 0x07)
      const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0
      const spritePx = s.x * 16
      const faceRight = marioStartPx.x >= spritePx
      const topDx   = faceRight ? 8 : -8
      const flipX   = faceRight
      const OBJ_BASE = 0x400
      // SNES large-OBJ: baseTile N → [N, N+1, N+$10, N+$11] at corner offsets
      // (0,0), (8,0), (0,8), (8,8). flipX reverses column order AND flips each tile.
      const bigTile = (baseTile: number, bdx: number, bdy: number): SpritePart[] => {
        const co = flipX ? [0x01, 0x00, 0x11, 0x10] : [0x00, 0x01, 0x10, 0x11]
        const dxo = [0, 8, 0, 8]
        const dyo = [0, 0, 8, 8]
        return co.map((off, i) => ({
          char: chars.get(OBJ_BASE + charHigh + ((baseTile + off) & 0x1FF)) ?? placeholder,
          palette, flipX, flipY: false,
          dx: bdx + dxo[i], dy: bdy + dyo[i],
        }))
      }
      const parts: SpritePart[] = [
        ...bigTile(0x64, topDx, -16),   // top body
        ...bigTile(0x66, 0, 0),         // bottom body
      ]
      out.push(new Sprite(
        s.spriteId, spritePx, s.y * 16,
        new StaticSpriteAppearance(parts),
        behavior,
      ))
      continue
    }

    // Chargin' Chuck ($91). Render in charging pose $13 (from DATA_02C6A3 in
    // CODE_02C6A7 / state 1, bank_02.asm:9401) with the football: 3 big-tile
    // body parts (ChuckHeadTiles, ChuckBody1[$13]=$20, ChuckBody2[$13]=$21)
    // plus 2 small 8×8 football tiles (chars $1C/$1D) drawn by CODE_02CAFC
    // (bank_02.asm:9874) with palette 3 from ChuckGfxProp. InitChuck
    // (bank_01.asm:772) calls FaceMario, storing SubHorizPos's Y into
    // SpriteMisc157C (=_3) and setting SpriteMisc151C (=_2) from
    // DATA_018526={$00,$04}: Mario-right → Chuck faces right (all body tiles
    // hflipped via _6=$40; head hflipped via DATA_02C885[0]=$40; football
    // hflipped via ChuckGfxProp[0]=$47); Mario-left → Chuck faces left (no
    // flips; DATA_02C885[4]=$00, ChuckGfxProp[1]=$07). Pose $13 offsets:
    // head (-10,-12) from DATA_02C830/02C84A; body2 (0,0) from DATA_02C93D;
    // body1 (-8,0) from DATA_02C909/02C971; football at (0,-8) and (+8,-8).
    if (s.spriteId === 0x91) {
      const attr          = tables.spriteAttr[s.spriteId] ?? 0
      const bodyPalette   = 8 + ((attr >> 1) & 0x07)
      const bodyCharHigh  = (attr & 0x01) !== 0 ? 0x100 : 0
      // Football uses hardcoded ChuckGfxProp (attr $07 in both directions for
      // palette/charHigh — only the hflip bit differs). Low nibble $07 →
      // palette 3 (8+3=11), charHigh 1.
      const ballAttr      = 0x07
      const ballPalette   = 8 + ((ballAttr >> 1) & 0x07)
      const ballCharHigh  = (ballAttr & 0x01) !== 0 ? 0x100 : 0
      const spritePx      = s.x * 16
      const faceRight     = marioStartPx.x >= spritePx      // _3 == 0 branch
      const OBJ_BASE = 0x400
      // SNES large-OBJ expansion: base char N → [N, N+1, N+$10, N+$11] at
      // corner offsets (0,0),(8,0),(0,8),(8,8). flipX reverses column order
      // AND flips each 8×8.
      const bigTile = (baseTile: number, bdx: number, bdy: number, flipX: boolean, pal: number, cHigh: number): SpritePart[] => {
        const co = flipX ? [0x01, 0x00, 0x11, 0x10] : [0x00, 0x01, 0x10, 0x11]
        const dxo = [0, 8, 0, 8]
        const dyo = [0, 0, 8, 8]
        return co.map((off, i) => ({
          char: chars.get(OBJ_BASE + cHigh + ((baseTile + off) & 0x1FF)) ?? placeholder,
          palette: pal, flipX, flipY: false,
          dx: bdx + dxo[i], dy: bdy + dyo[i],
        }))
      }
      const smallTile = (tile: number, dx: number, dy: number, flipX: boolean, pal: number, cHigh: number): SpritePart => ({
        char: chars.get(OBJ_BASE + cHigh + (tile & 0x1FF)) ?? placeholder,
        palette: pal, flipX, flipY: false, dx, dy,
      })
      // Draw order matches SMW OAM priority: head first (behind), then body2,
      // then body1 on top; football layered last (in front of head, overlapping body).
      const parts: SpritePart[] = faceRight
        ? [
            ...bigTile(0x06,  10, -12, true,  bodyPalette, bodyCharHigh),  // head (behind)
            ...bigTile(0x21,   0,   0, true,  bodyPalette, bodyCharHigh),  // body2
            ...bigTile(0x20,   8,   0, true,  bodyPalette, bodyCharHigh),  // body1
            smallTile(0x1C,  8,  -8, true,  ballPalette, ballCharHigh),    // football tile 1
            smallTile(0x1D,  0,  -8, true,  ballPalette, ballCharHigh),    // football tile 2
          ]
        : [
            ...bigTile(0x06, -10, -12, false, bodyPalette, bodyCharHigh),  // head (behind)
            ...bigTile(0x21,   0,   0, false, bodyPalette, bodyCharHigh),  // body2
            ...bigTile(0x20,  -8,   0, false, bodyPalette, bodyCharHigh),  // body1
            smallTile(0x1C,  0,  -8, false, ballPalette, ballCharHigh),    // football tile 1
            smallTile(0x1D,  8,  -8, false, ballPalette, ballCharHigh),    // football tile 2
          ]
      out.push(new Sprite(
        s.spriteId, spritePx, s.y * 16,
        new StaticSpriteAppearance(parts),
        behavior,
      ))
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
    } else if (s.spriteId >= 0x04 && s.spriteId <= 0x07) {
      // Ground-walking koopas — overlay hands off to KoopaWalkBehavior.
      appearance = new KoopaAppearance(parts)
    } else {
      appearance = new StaticSpriteAppearance(parts)
    }
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

