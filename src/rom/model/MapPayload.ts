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
  | { kind: 'pSwitch'; parts: readonly SpritePartDescriptor[] }
  | {
      kind: 'thwomp'
      bodyParts: readonly SpritePartDescriptor[]
      alertFace: readonly SpritePartDescriptor[]
      aggressiveFace: readonly SpritePartDescriptor[]
    }
  | {
      kind: 'wingedBlock'
      bodyParts: readonly SpritePartDescriptor[]
      wingFrames: readonly [readonly SpritePartDescriptor[], readonly SpritePartDescriptor[]]
    }

export interface SpriteBehaviorDescriptor {
  kind: string
  displayName?: string
  spawns?: number
  isGenerator?: boolean
  reactRangeDy?: number
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
  /** True when BG3 draws in front of L1 non-priority tiles. */
  layer3Priority?: boolean
  /**
   * Initial Layer1YPos (camera Y) in pixels. From DATA_05D708 via
   * DATA_05F200[level] bits 3:2 (bank_05.asm:7329-7335). For vertical levels,
   * the high byte comes from DATA_05F600[level] & $1F.
   * Seeds the camera viewport and positions L3 tide overlays correctly.
   */
  initialCameraYPx: number
  /**
   * Time-limit index from header byte 3 bits 7:6 (0..3). Indexes TimerTable
   * ($0584D7) to give the starting timer: 0=none, 1=200, 2=300, 3=400.
   */
  timeLimit: number
}

// ── Layer 3 ──────────────────────────────────────────────────────────

export interface L3Descriptor {
  /** 4096-entry VRAM tilemap (index = row*64+col), as 16-bit unsigned values. */
  tilemap: readonly number[]
  /**
   * Decoded 2BPP pixel data for each L3 char: flat array of 512 entries
   * (4 files × 128 tiles), each entry is 64 pixel indices (0–3).
   * Access: chars[fileIdx * 128 + localIdx]
   */
  chars: readonly (readonly number[])[]
  /** Initial Layer3YPos in pixels (from Layer3TilemapSettings). */
  initialYPx: number
  /** Level pixel width (screens × 256, or 512 for vertical). */
  levelPixelW: number
  /** Level pixel height (432 for horizontal, screens × 256 for vertical). */
  levelPixelH: number
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
  /** Layer 3 tilemap + decoded chars. null when the level has no L3. */
  l3?: L3Descriptor | null
  sprites: readonly SpriteDescriptor[]
  tileset: number
  screenCount: number
  screenPipeVariantIdx: readonly number[]
}
