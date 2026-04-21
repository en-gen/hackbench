import type { RgbaColor } from '../GraphicsDecoder'

/**
 * Wire-format for shipping a built map from the extension host to the
 * webview over `postMessage`. All types are structured-clone safe
 * (no classes, no refs). The webview's `buildGraph` rehydrator walks
 * the descriptors and builds concrete model instances, wiring up
 * references by id.
 *
 * A single `kind` switch inside the rehydrator is the only place in
 * the webview that branches on behavior variety — after that call,
 * downstream code sees polymorphic objects only.
 */

// ── Chars ────────────────────────────────────────────────────────────

export type CharDescriptor =
  | { kind: 'static'; pixels: number[] }
  | { kind: 'animated'; frames: number[][] }
  | { kind: 'pSwitchAlt'; normal: CharDescriptor; alt: CharDescriptor }

// ── Tiles ────────────────────────────────────────────────────────────

export interface SubTileDescriptor {
  charNum: number
  palette: number
  flipX: boolean
  flipY: boolean
  priority: boolean
}

export type SubtileQuadDescriptor = readonly [
  SubTileDescriptor,
  SubTileDescriptor,
  SubTileDescriptor,
  SubTileDescriptor,
]

export type TileDescriptor =
  | { kind: 'static'; quad: SubtileQuadDescriptor }
  | { kind: 'pipeVariants'; variants: readonly SubtileQuadDescriptor[] }
  | {
      kind: 'switchPalaceAlternate'
      off: SubtileQuadDescriptor
      on: SubtileQuadDescriptor
      color: 0 | 1 | 2 | 3
    }
  | {
      kind: 'pSwitchReveal'
      revealedQuad: SubtileQuadDescriptor
      /** Off-state alpha (0..1). Default 0.5 when omitted. */
      offAlpha?: number
    }

// ── Palette ──────────────────────────────────────────────────────────

export type ColorDescriptor =
  | { kind: 'static'; value: RgbaColor }
  | { kind: 'cycling'; frames: readonly RgbaColor[] }

export interface PaletteDescriptor {
  cells: readonly (readonly ColorDescriptor[])[] // 16 × 16
  backAreaColor: ColorDescriptor
}

// ── Sprites ──────────────────────────────────────────────────────────

export interface SpritePartDescriptor {
  charNum: number
  palette: number
  flipX: boolean
  flipY: boolean
  dx: number
  dy: number
}

export type SpriteAppearanceDescriptor =
  | { kind: 'static'; parts: readonly SpritePartDescriptor[] }

export interface SpriteBehaviorDescriptor {
  kind: string
}

export interface SpriteDescriptor {
  id: number
  x: number
  y: number
  appearance: SpriteAppearanceDescriptor
  behavior: SpriteBehaviorDescriptor
}

// ── Level header / map ───────────────────────────────────────────────

export interface LevelHeaderDescriptor {
  mode: number
  music: number
  tileset: number
  orientation: 'horizontal' | 'vertical'
  /**
   * Layer-2 scroll settings 0..3 from $05F000+idx via the
   * VertLayer2Setting / HorizLayer2Setting tables. Drive BG parallax in
   * the camera-viewport preview. Default 0 when unknown.
   */
  vertLayer2Setting?: number
  horizLayer2Setting?: number
}

export type L2Descriptor =
  | {
      kind: 'preset'
      page: number
      /** BG tile ids populated into the layout. References `bgTiles`. */
      layout: readonly (readonly (number | null)[])[]
    }
  | {
      kind: 'objectStream'
      /** Regular Map16 tile ids from the existing `tiles` table. */
      layout: readonly (readonly (number | null)[])[]
    }

export interface MapPayload {
  levelId: number
  header: LevelHeaderDescriptor
  /** charNum → descriptor. Dense for loaded chars; holes ok. */
  chars: Record<number, CharDescriptor>
  /** tileId → descriptor. Dense for the 512-entry Map16 table. */
  tiles: Record<number, TileDescriptor>
  /** BG tileId → descriptor. Only populated when l2.kind === 'preset'. */
  bgTiles?: Record<number, TileDescriptor>
  palette: PaletteDescriptor
  /** L1 grid as tileIds (or null for empty cells). row-major. */
  layout: readonly (readonly (number | null)[])[]
  l2: L2Descriptor | null
  sprites: readonly SpriteDescriptor[]
  tileset: number
  screenCount: number
  screenPipeVariantIdx: readonly number[]
}
