import { readActsLikeTable } from '../../ActsLikeLoader'
import {
  isMarioStandable,
  isSlopeTile,
  readSlopeTable,
} from '../../BlockBehaviorLoader'
import {
  marioFeetLanding,
  marioTileDispatch,
  marioTileSolidity,
  PSWITCH_INACTIVE,
  readMarioDispatchTables,
} from '../../MarioTileDispatch'
import { readSlopeTables, resolveSlope } from '../../SlopeResolver'
import {
  loadMap16WithPipeVariants,
  PIPE_VARIANT_TILE_COUNT,
  PIPE_VARIANT_TILE_START,
  type Map16Tile,
  type SubTile as Map16SubTileDescriptor,
} from '../../Map16'
import type { RomFile } from '../../RomFile'
import type { Char } from '../chars/Char'
import { Char as CharClass } from '../chars/Char'
import { StaticPixelsBehavior } from '../chars/behaviors/StaticPixelsBehavior'
import { SubTile } from './SubTile'
import { Tile, type SubtileQuad } from './Tile'
import { InvisibleBlockRevealBehavior } from './behaviors/InvisibleBlockRevealBehavior'
import { StarOneUpVineBlockBehavior, ONEUP_CHAR_NUMS, STAR_CHAR_NUMS } from './behaviors/StarOneUpVineBlockBehavior'
import { PipeVariantsBehavior } from './behaviors/PipeVariantsBehavior'
import { PSwitchRevealBehavior } from './behaviors/PSwitchRevealBehavior'
import { StaticQuadBehavior } from './behaviors/StaticQuadBehavior'
import { SwitchPalaceAlternateBehavior } from './behaviors/SwitchPalaceAlternateBehavior'
import { VineSourceBehavior } from './behaviors/VineSourceBehavior'

const SWITCH_PALACE_OFF_BASE = 0x06A
const SWITCH_PALACE_ON_BASE = 0x16A
const SWITCH_PALACE_COLORS = 4 // yellow, green, red, blue

/**
 * Blue-P-switch "hidden" tiles. Each entry maps a hidden tile ID to the
 * substitute tile whose Map16 definition supplies the revealed artwork,
 * plus an optional CGRAM-row palette override. Derived from legacy
 * `pSwitchReveal()` in the map-editor webview (bank_00.asm CODE_00F545,
 * lines 12111-12116 for door palette).
 *
 *   $27  silver door top     → chars of $1F, palette 4 (silver/blue)
 *   $28  silver door bottom  → chars of $20, palette 4
 *   $29  hidden ? block      → chars of $24 (same palette)
 *   $2A  hidden coin         → chars of $2B (same palette)
 */
interface PSwitchRevealEntry {
  readonly substitute: number
  readonly palOverride?: number
}
const P_SWITCH_REVEALS: ReadonlyMap<number, PSwitchRevealEntry> = new Map([
  [0x27, { substitute: 0x1F, palOverride: 4 }],
  [0x28, { substitute: 0x20, palOverride: 4 }],
  [0x29, { substitute: 0x24 }],
  [0x2A, { substitute: 0x2B }],
])

/**
 * Invisible blocks that reveal as their *visible* coin-giver counterpart
 * at a fixed 50% alpha, plus an optional reward-indicator quad drawn as
 * a pre-pass overlay above the block. Unlike `P_SWITCH_REVEALS`, there
 * is no state that flips these back to full opacity — the designer just
 * needs to see that something is there.
 *
 * We don't draw the post-hit form ($132 "used block") because that tile
 * is the shared exhausted state for ~18 different block types (coin
 * blocks, item blocks, invisible wings, turn blocks) per DATA_00F0C8
 * (bank_00.asm:12766); showing it would conflate distinct block
 * semantics.
 *
 *   $21  invisible coin block  → reveal $123 (? block graphic)
 *                               + reward overlay $02B (coin)
 */
interface InvisibleBlockRevealEntry {
  readonly substitute: number
  readonly rewardOverlay?: number
}
const INVISIBLE_BLOCK_REVEALS: ReadonlyMap<number, InvisibleBlockRevealEntry> = new Map([
  [0x021, { substitute: 0x123, rewardOverlay: 0x02B }],
])

/**
 * Build the Map16 tile graph for a tileset.
 *
 * Pipe tiles ($133-$13A) get `PipeVariantsBehavior([v0Quad, v1Quad, v2Quad, v3Quad])`
 * so the rendered palette follows `ctx.pipeVariantIdx` (per-screen). Every
 * other tile gets `StaticQuadBehavior(quad)`. Further state-driven wrappers
 * (switch palace, etc) layer on top in later refactor steps.
 *
 * @param chars char graph keyed by flat VRAM char index. A missing char
 *              produces a transparent placeholder so callers render
 *              nothing rather than crashing on unloaded sprite slots.
 */
export function buildTiles(
  rom: RomFile,
  tileset: number,
  chars: Map<number, Char>,
): Map<number, Tile> {
  const placeholder = makePlaceholderChar()
  const { tiles: baseTiles, pipeVariants } = loadMap16WithPipeVariants(rom, tileset)
  const actsLike = readActsLikeTable(rom)
  const slopeTable   = readSlopeTable(rom)
  const marioTables  = readMarioDispatchTables(rom)
  const slopeTables  = readSlopeTables(rom)
  const tiles = new Map<number, Tile>()

  /**
   * Classify a tile's sprite-collision fields. Every branch is a
   * direct port of a named ASM routine — no folklore, no approximation.
   * Landing (Y=2) and bonking (Y=3) go through different code paths
   * with different ranges; they're tracked as separate flags.
   */
  const classify = (actsLikeId: number) => {
    const low  = actsLikeId & 0xFF
    const high = (actsLikeId >> 8) & 0xFF

    // Page-0 guard — sprite collision routines check the Map16 tile's
    // HIGH BYTE before applying any range test:
    //   CODE_01928E (bank_01.asm:2617-2618): JSR CODE_019441 → A = high
    //     byte; STA SprMap16TouchHorizHigh / BEQ + — if high = 0, the
    //     entire wall check is skipped.
    //   CODE_0192C9 (bank_01.asm:2651-2657): same pattern — BEQ
    //     Return01930F skips floor/ceiling detection for page-0 tiles.
    // Page-0 tiles ($0xx actsLike) are therefore unconditionally
    // passthrough for sprites regardless of their low byte.
    const isPage0 = high === 0

    // CODE_01928E (bank_01.asm:2613-2635) — sprite horizontal wall.
    //   SprMap16TouchHorizHigh BEQ skip  (page-0 → passthrough, see above)
    //   CMP #$11 / BCC +       (< $11 → not a wall)
    //   CMP #$6E / BCS +       (>= $6E → not a wall)
    //   → JSR CODE_019425       (sets SpriteBlockedDirs)
    //
    // The ROM's sprite-collision routines (CODE_01928E for walls,
    // CODE_0192C9 for vert collision, CODE_01933B for landing) do NOT
    // consult `DATA_00F05C` (the block-behavior table). That table
    // governs Mario's hit-from-below dispatch (`CODE_00F17F`,
    // bank_00.asm:12846) — coin spawn, ?-block transform, vine grow —
    // not whether the tile is collidable. Sprite-side floor / wall /
    // ceiling are therefore PURE range checks after the page-0 gate.
    // Filtering these by `bhBlocks` (BH_EMPTY → false) was a
    // misapplication that excluded $11A item blocks, $11C wood planks,
    // etc. from sprite collision even though the ROM treats them as
    // solid.
    const wall = !isPage0 && low >= 0x11 && low <= 0x6D

    // CODE_01933B (bank_01.asm:2705-2721) — LANDING path (reached from
    // CODE_0192C9 Y=2 via CODE_019310). Gated by the page-0 check above.
    //   <$11     → CODE_0193B0 semi-solid (sub-pixel gate; approximated
    //              as "solid from above" for the static overlay).
    //   $11-$6D  → CODE_0193B8 solid.
    //   $6E-$D7  → CODE_00FA19 slope-angle table, called unconditionally
    //              for the entire range. DATA_00EAC1 is NOT consulted here;
    //              it is a buoyancy table (CODE_019211). All slope-range
    //              tiles are therefore landable; `floor` is the complete
    //              "sprite-landable" predicate — `slopeTable` is separate.
    //   >=$D8    → CODE_019386 solid.
    const inSolidRange    = low >= 0x11 && low <= 0x6D
    const inSlopeRange    = low >= 0x6E && low <= 0xD7
    const inTilesetWindow = tileset !== 0 && tileset !== 7 && low >= 0xC4 && low <= 0xC9
    const floor =
      !isPage0 && (
        low <= 0x10 ||            // CODE_0193B0 semi-solid platform range
        inSolidRange ||            // standard solid
        inSlopeRange ||            // CODE_00FA19 slope-angle landing
        low >= 0xD8                // CODE_019386 upper solid range
      )

    // CODE_0192C9 (bank_01.asm:2646-2668) — BONKING path (Y=3).
    // Gated by the same page-0 check (BEQ Return01930F for Y=3 path too).
    //   CMP #$11 / BCC return    (< $11 → not solid)
    //   CMP #$6E / BCC +solid    ($11-$6D → solid)
    //   CMP SolidTileStart       (tileset window default $C4)
    //     BCC return             (below window → not solid)
    //   CMP SolidTileEnd         (tileset window default $CA)
    //     BCS return             (at/above window → not solid)
    //   → solid (in window range)
    const ceiling = !isPage0 && (inSolidRange || inTilesetWindow)

    // DATA_00EAC1 (bank_00.asm:11946) membership — slope recognition.
    // Not reached for page-0 tiles (CODE_0192C9 never dispatches there).
    const slopeTableFlag = !isPage0 && isSlopeTile(actsLikeId, slopeTable)

    // Mario perspective — tiles Mario comes to rest on. Uses the real
    // ASM dispatches ported in `src/rom/MarioTileDispatch.ts`:
    //
    //   1. `marioFeetLanding` = `CODE_00EDF7` (bank_00.asm:12401) —
    //      the feet-landing dispatcher. Returns `land` for most
    //      $00-$6D low bytes (Mario's fall stops on these), `hole`
    //      for tileset 3/$E $59-$5B, `slope` for $6E-$FA (slope-angle
    //      path separate), `special` for $FB+. `marioFloor` is true
    //      when feet-landing returns `land`, OR when the tile is
    //      in the slope table (slopes ARE Mario surfaces).
    //
    //   2. `marioTileDispatch` = `CODE_00F127` (bank_00.asm:12789) —
    //      block-action dispatcher. Returns `hurt` for tiles that
    //      `HurtMario` (spike $2F unconditional, tileset 5/$D
    //      $59-$5B, tileset 1 $66-$69). Hurt tiles bounce Mario off
    //      and are excluded from ALL Mario surface fields.
    //
    //   3. `isMarioStandable` — thin wide-pattern pass-through filter
    //      (coins $2A-$2E, checkpoint $66-$69) where the block-action
    //      ALWAYS fires to collect/pass regardless of tileset.
    //
    // Each Mario field is the UNION of two collision sources: the
    // physical-wall flag (F545) AND the block-action dispatch (F127).
    // F545 covers tiles that physically block Mario in the current
    // frame; F127 covers tiles that trigger an interaction on contact
    // (hidden blocks, note blocks, ? blocks) even when F545 says the
    // tile is passable in its current form. Both paths are gated by
    // the same `marioOk` filter so pass-through tiles (coins, midway
    // tape) and hurt tiles (spike) stay excluded.
    const dispatch0 = marioTileDispatch(low, tileset, 0, marioTables)
    const dispatch1 = marioTileDispatch(low, tileset, 1, marioTables)
    const dispatch2 = marioTileDispatch(low, tileset, 2, marioTables)
    const dispatch3 = marioTileDispatch(low, tileset, 3, marioTables)
    const hurtsFromAnyDir = (
      dispatch0.kind === 'hurt' ||
      dispatch1.kind === 'hurt' ||
      dispatch2.kind === 'hurt' ||
      dispatch3.kind === 'hurt'
    )
    // F127 block-action hits, split by which Mario face touches the
    // tile. DATA_00F0EC encoding per `PlayerBlockedDir` (rammap.asm:632):
    //   dir 0 → F0EC[0]=$08 = bit 3 = PlayerBlock_Top    → Mario head bump → CEILING
    //   dir 1 → F0EC[1]=$01 = bit 0 = PlayerBlock_Right  → WALL (right face)
    //   dir 2 → F0EC[2]=$02 = bit 1 = PlayerBlock_Left   → WALL (left face)
    //   dir 3 → F0EC[3]=$04 = bit 2 = PlayerBlock_Bottom → Mario feet land → FLOOR
    // Included as classification triggers because tiles like $021
    // (invisible coin block) are F545-non-solid but DO interact with
    // Mario on head bump: the dispatch transforms them to their visible
    // counterpart and Mario bonks. Coins $2A-$2E and spike $2F also
    // return 'hit' from some directions — they stay excluded via the
    // `marioOk` filter (isMarioStandable hand-list + hurtsFromAnyDir).
    const hitOnHead  = dispatch0.kind === 'hit'
    const hitOnSides = dispatch1.kind === 'hit' || dispatch2.kind === 'hit'
    const hitOnFeet  = dispatch3.kind === 'hit'
    const feetLanding  = marioFeetLanding(low, tileset)
    const marioOk      = isMarioStandable(actsLikeId) && !hurtsFromAnyDir
    // CODE_00F545 (bank_00.asm:13410) is Mario's SOLIDITY predicate,
    // gating the wall-flag set at bank_00.asm:12189 via the F44D probe
    // at bank_00.asm:13342-13353. Page-0 tiles ($0xx) outside a few
    // P-switch / switch-palace special cases are non-solid — that's
    // why checkpoint-post bodies ($030/$032/$033/$035), midway tape
    // ($038), goal tape ($039/$03C), decorative fill ($03F), and
    // lava-corner graphics ($0A3/$0A6) pass through Mario. Page-1
    // tiles ($1xx) are solid by default — ground $100, item blocks
    // $11A/$11E, structural terrain. P-switch state is assumed
    // inactive at classify time; per-frame overlays can layer the
    // reactive state if needed.
    const marioSolid = marioTileSolidity(low, high, PSWITCH_INACTIVE)
    // Mario's ceiling/wall range check matches the sprite-range
    // $11-$6D / $C4-$C9 tileset window (CODE_00EC46 bank_00.asm:12161
    // and CODE_00ECB1 bank_00.asm:12218). Mario fields union the F545
    // physical-wall gate with the F127 block-action gate, then apply
    // the hurt / Mario-standable filter on top — so ?-blocks ($11A/$11F)
    // and hidden coin blocks ($021) report `marioCeiling=true` from
    // the F127 head-bump dispatch even when F545 says non-solid.
    const marioInSolidRange    = low >= 0x11 && low <= 0x6D
    const marioInCeilingWindow = tileset !== 0 && tileset !== 7 && low >= 0xC4 && low <= 0xC9
    // Slopes are NOT floors. `feetLanding` returns 'slope' (not 'land')
    // for tiles in the $6E-$D7 range — they have a diagonal surface,
    // not a flat top. The "Show surfaces" overlay draws a horizontal
    // line, which is only correct for flat floors. Slope membership is
    // still surfaced via `slopeTable` for overlays that render angle.
    const marioFloor   = (marioSolid || hitOnFeet)  && (feetLanding.kind === 'land') && marioOk
    const marioCeiling = (marioSolid || hitOnHead)  && (marioInSolidRange || marioInCeilingWindow) && marioOk
    const marioWall    = (marioSolid || hitOnSides) && marioInSolidRange && marioOk

    // CODE_00ED86 (bank_00.asm:12334) — Mario's slope-surface profile.
    // resolveSlope returns null outside the $6E-$D7 range, otherwise a
    // 16-byte per-pixel-X height array derived from DATA_00E632 via the
    // tileset-specific SlopesPtr map (DATA_00E55E or DATA_00E5C8).
    //
    // Gated by F545 solidity. The ROM checks F545 at bank_00.asm:12393
    // (`CODE_00EDE9: JSR CODE_00F44D / BNE`) before any slope dispatch
    // fires — non-solid tiles route to `CODE_00F309` (midway / coin
    // handlers) instead. F545 says page-0 tiles outside the P-switch /
    // switch-palace special cases are non-solid, so a page-0 placement
    // of a slope-range low byte (e.g. $0A6 lava-corner graphic, $073
    // bush graphic) is decorative — Mario walks straight through it
    // and the slope-angle path never runs. Without this gate the
    // overlay would draw misleading slope lines on those passthrough
    // tiles. resolveSlope itself stays low-byte-only (matching the
    // ROM's `LDA [SlopesPtr],Y` indirection); the high-byte solidity
    // gate lives here at the call site beside the rest of F545.
    const slope = marioSolid
      ? resolveSlope(low, tileset, slopeTables)
      : null

    return {
      floor, ceiling, wall,
      marioFloor, marioCeiling, marioWall,
      slopeTable: slopeTableFlag,
      ...(slope ? { slope } : {}),
    }
  }

  // Pre-compute all quads so we can cross-reference off/on pairs for
  // switch-palace without repeating subtile conversion.
  const quads = new Map<number, SubtileQuad>()
  for (const m16 of baseTiles) quads.set(m16.id, quadFromMap16(m16, chars, placeholder))

  // Vine overlay: tile $006 quad used as the indicator icon drawn above
  // vine-source blocks. Null if this tileset has no vine tile (rare).
  const vineOverlayQuad = quads.get(0x006) ?? null

  // Item-block indicator chars from sprite OBJ VRAM.
  const oneupChars = ONEUP_CHAR_NUMS.map(i => chars.get(i) ?? null)
  const starChars  = STAR_CHAR_NUMS.map(i => chars.get(i) ?? null)

  for (const m16 of baseTiles) {
    if (isPipeTile(m16.id)) continue // handled below
    if (isSwitchPalaceTile(m16.id)) continue // handled below
    if (P_SWITCH_REVEALS.has(m16.id)) continue // handled below
    if (INVISIBLE_BLOCK_REVEALS.has(m16.id)) continue // handled below

    const override = actsLike.get(m16.id)
    const actsLikeId = override ?? m16.id
    const quad = quads.get(m16.id)!

    // Tile $1A (any page) — 3-state column-cycle item block (star/1-up/vine).
    // The block-hit dispatch keys on the Map16 low byte (CODE_00F17F), so
    // tiles whose acts-like resolves to low byte $1A get this behavior.
    const lowByte = actsLikeId & 0xFF
    if (lowByte === 0x1A) {
      tiles.set(m16.id, new Tile(m16.id, new StarOneUpVineBlockBehavior(
        quad, vineOverlayQuad, oneupChars, starChars,
      ), actsLikeId, classify(actsLikeId)))
      continue
    }

    // VineSourceBehavior for tiles whose acts-like is $2A/$2B — vine generators
    // (DATA_00F05C index 25/26 = $03). Without reading the real LM
    // acts-like table, only explicit overrides in the acts-like map hit
    // this branch.
    const behavior = override !== undefined && isVineSource(override)
      ? new VineSourceBehavior(quad, vineOverlayQuad)
      : new StaticQuadBehavior(quad)
    tiles.set(m16.id, new Tile(m16.id, behavior, actsLikeId, classify(actsLikeId)))
  }

  // Hidden tiles revealed by the blue P-switch. We always draw the
  // revealed artwork so the designer can see what's there, with the
  // behavior fading alpha when the P-switch is inactive. If the
  // substitute tile is missing from this tileset's Map16 table (some
  // tilesets have holes), fall back to the hidden tile's own quad so
  // the cell never renders completely empty.
  for (const [hiddenId, entry] of P_SWITCH_REVEALS) {
    const srcQuad = quads.get(entry.substitute) ?? quads.get(hiddenId)
    if (!srcQuad) continue
    const revealed = entry.palOverride !== undefined
      ? withPaletteOverride(srcQuad, entry.palOverride)
      : srcQuad
    const actsLikeId = actsLike.get(hiddenId) ?? hiddenId
    tiles.set(hiddenId, new Tile(hiddenId, new PSwitchRevealBehavior(revealed), actsLikeId, classify(actsLikeId)))
  }

  // Invisible blocks revealed as a visible counterpart at a fixed 50%
  // alpha, with an optional reward-indicator quad drawn as a pre-pass
  // overlay. Fall back to the hidden tile's own quad if the substitute
  // is missing from this tileset's Map16 table; the reward overlay is
  // silently omitted if its quad is missing.
  for (const [hiddenId, entry] of INVISIBLE_BLOCK_REVEALS) {
    const srcQuad = quads.get(entry.substitute) ?? quads.get(hiddenId)
    if (!srcQuad) continue
    const rewardQuad = entry.rewardOverlay !== undefined
      ? (quads.get(entry.rewardOverlay) ?? null)
      : null
    const actsLikeId = actsLike.get(hiddenId) ?? hiddenId
    tiles.set(hiddenId, new Tile(
      hiddenId,
      new InvisibleBlockRevealBehavior(srcQuad, rewardQuad),
      actsLikeId,
      classify(actsLikeId),
    ))
  }

  for (let i = 0; i < PIPE_VARIANT_TILE_COUNT; i++) {
    const id = PIPE_VARIANT_TILE_START + i
    const variantQuads: SubtileQuad[] = pipeVariants.map(variant =>
      quadFromMap16(variant[i], chars, placeholder),
    )
    const actsLikeId = actsLike.get(id) ?? id
    tiles.set(id, new Tile(id, new PipeVariantsBehavior(variantQuads), actsLikeId, classify(actsLikeId)))
  }

  for (let c = 0; c < SWITCH_PALACE_COLORS; c++) {
    const offId = SWITCH_PALACE_OFF_BASE + c
    const onId = SWITCH_PALACE_ON_BASE + c
    const offQuad = quads.get(offId)!
    const onQuad = quads.get(onId)!
    const color = c as 0 | 1 | 2 | 3
    // Both `$06x` and `$16x` share one behavior instance that renders
    // (state ? onQuad : offQuad) — i.e., both default to the dotted
    // "off" visual when the palace has not been hit, and both flip to
    // the solid "on" visual when it has. The collision rule in
    // drawSurfaces matches: both passable by default, both solid
    // when their corresponding color is toggled.
    const behavior = new SwitchPalaceAlternateBehavior(offQuad, onQuad, color)
    const offActsLike = actsLike.get(offId) ?? offId
    const onActsLike  = actsLike.get(onId)  ?? onId
    tiles.set(offId, new Tile(offId, behavior, offActsLike, classify(offActsLike)))
    tiles.set(onId,  new Tile(onId,  behavior, onActsLike,  classify(onActsLike)))
  }

  return tiles
}

/**
 * True when a tile's acts-like value routes the block-hit dispatch to the
 * vine generator (`GeneratedTiles[3] = CODE_00C077`). The game reads only
 * the low byte of `Map16TileNumber` and subtracts $11 to index DATA_00F05C,
 * so any tile whose acts-like low byte is $2A or $2B (→ indices 25/26 →
 * behavior $03) spawns a vine. That's why e.g. $11A acts-like $2B works
 * despite the page bit differing.
 */
function isVineSource(actsLikeId: number): boolean {
  const lowByte = actsLikeId & 0xFF
  return lowByte === 0x2A || lowByte === 0x2B
}

function isSwitchPalaceTile(id: number): boolean {
  if (id >= SWITCH_PALACE_OFF_BASE && id < SWITCH_PALACE_OFF_BASE + SWITCH_PALACE_COLORS) return true
  if (id >= SWITCH_PALACE_ON_BASE && id < SWITCH_PALACE_ON_BASE + SWITCH_PALACE_COLORS) return true
  return false
}

function isPipeTile(id: number): boolean {
  return id >= PIPE_VARIANT_TILE_START && id < PIPE_VARIANT_TILE_START + PIPE_VARIANT_TILE_COUNT
}

export function quadFromMap16(m16: Map16Tile, chars: Map<number, Char>, placeholder: Char): SubtileQuad {
  return [
    toSubTile(m16.tl, chars, placeholder),
    toSubTile(m16.tr, chars, placeholder),
    toSubTile(m16.bl, chars, placeholder),
    toSubTile(m16.br, chars, placeholder),
  ]
}

/**
 * Clone a quad, replacing every subtile's CGRAM-row palette with
 * `palette`. Used for the silver-door P-switch reveals where the
 * revealed chars come from a brown-palette door but should render in
 * palette 4 (silver/blue) — legacy does this via a pal-override atlas.
 */
function withPaletteOverride(quad: SubtileQuad, palette: number): SubtileQuad {
  return [
    new SubTile(quad[0].char, palette, quad[0].flipX, quad[0].flipY, quad[0].priority),
    new SubTile(quad[1].char, palette, quad[1].flipX, quad[1].flipY, quad[1].priority),
    new SubTile(quad[2].char, palette, quad[2].flipX, quad[2].flipY, quad[2].priority),
    new SubTile(quad[3].char, palette, quad[3].flipX, quad[3].flipY, quad[3].priority),
  ]
}

export function makeTransparentPlaceholderChar(): Char {
  return new CharClass(-1, new StaticPixelsBehavior(new Uint8Array(64)))
}

export function makePlaceholderBoxChar(): Char {
  const p = new Uint8Array(64)
  for (let x = 0; x < 8; x++) { p[x] = 3; p[56 + x] = 3 }
  for (let y = 1; y <= 6; y++) { p[y * 8] = 3; p[y * 8 + 7] = 3 }
  p[3 * 8 + 3] = 3; p[3 * 8 + 4] = 3
  p[4 * 8 + 3] = 3; p[4 * 8 + 4] = 3
  return new CharClass(-2, new StaticPixelsBehavior(p))
}

function toSubTile(
  desc: Map16SubTileDescriptor,
  chars: Map<number, Char>,
  placeholder: Char,
): SubTile {
  const char = chars.get(desc.charNum) ?? placeholder
  return new SubTile(char, desc.palette, desc.flipX, desc.flipY, desc.priority)
}

function makePlaceholderChar(): Char {
  // 64 palette-index-0 pixels = fully transparent per SNES convention.
  return new CharClass(-1, new StaticPixelsBehavior(new Uint8Array(64)))
}

// Re-export Map16Tile for callers that want to sanity-check factory input.
export type { Map16Tile }
