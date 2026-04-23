import { readActsLikeTable } from '../../ActsLikeLoader'
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
  const tiles = new Map<number, Tile>()

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
      ), actsLikeId))
      continue
    }

    // VineSourceBehavior for tiles whose acts-like is $2A/$2B — vine generators
    // (DATA_00F05C index 25/26 = $03). Without reading the real LM
    // acts-like table, only explicit overrides in the acts-like map hit
    // this branch.
    const behavior = override !== undefined && isVineSource(override)
      ? new VineSourceBehavior(quad, vineOverlayQuad)
      : new StaticQuadBehavior(quad)
    tiles.set(m16.id, new Tile(m16.id, behavior, actsLikeId))
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
    tiles.set(hiddenId, new Tile(hiddenId, new PSwitchRevealBehavior(revealed), actsLikeId))
  }

  for (let i = 0; i < PIPE_VARIANT_TILE_COUNT; i++) {
    const id = PIPE_VARIANT_TILE_START + i
    const variantQuads: SubtileQuad[] = pipeVariants.map(variant =>
      quadFromMap16(variant[i], chars, placeholder),
    )
    const actsLikeId = actsLike.get(id) ?? id
    tiles.set(id, new Tile(id, new PipeVariantsBehavior(variantQuads), actsLikeId))
  }

  for (let c = 0; c < SWITCH_PALACE_COLORS; c++) {
    const offId = SWITCH_PALACE_OFF_BASE + c
    const onId = SWITCH_PALACE_ON_BASE + c
    const offQuad = quads.get(offId)!
    const onQuad = quads.get(onId)!
    const color = c as 0 | 1 | 2 | 3
    const behavior = new SwitchPalaceAlternateBehavior(offQuad, onQuad, color)
    tiles.set(offId, new Tile(offId, behavior, actsLike.get(offId) ?? offId))
    tiles.set(onId,  new Tile(onId,  behavior, actsLike.get(onId)  ?? onId))
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
