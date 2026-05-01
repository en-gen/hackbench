import type { RgbaColor } from '../GraphicsDecoder'
import type { TileCollision } from './tiles/TileCollision'

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

/**
 * Shared fields on every TileDescriptor. `actsLike` survives any LM
 * acts-like override; `collision` is pre-computed at factory time from
 * the ROM's block-behavior table (DATA_00F05C) and the acts-like ranges
 * so the webview doesn't need ROM bytes to answer "does this tile block
 * a sprite from direction X?".
 */
interface TileDescriptorBase {
  actsLike: number
  collision: TileCollision
}

export type TileDescriptor =
  | ({ kind: 'static'; quad: SubtileQuadDescriptor } & TileDescriptorBase)
  | ({
      kind: 'vineSource'
      quad: SubtileQuadDescriptor
      /** Tile $006 quad used as the vine indicator icon above the block. */
      overlayQuad: SubtileQuadDescriptor | null
    } & TileDescriptorBase)
  | ({
      kind: 'starOneUpVineBlock'
      quad: SubtileQuadDescriptor
      vineOverlayQuad: SubtileQuadDescriptor | null
      /** OBJ chars for 1-up mushroom sprite $78 (TL/TR/BL/BR), -1 when missing. */
      oneupCharNums: readonly number[]
      /** OBJ chars for star sprite $76 (TL/TR/BL/BR), -1 when missing. */
      starCharNums: readonly number[]
    } & TileDescriptorBase)
  | ({
      kind: 'keyCoinBalloonKoopaBlock'
      quad: SubtileQuadDescriptor
      /** OBJ chars for Key sprite $80 (TL/TR/BL/BR), -1 when missing. */
      keyCharNums:       readonly number[]
      /** OBJ chars for Flying Red Coin sprite $7E (TL/TR/BL/BR), -1 when missing. */
      redCoinCharNums:   readonly number[]
      /** OBJ chars for P-Balloon sprite $7D (TL/TR/BL/BR), -1 when missing. */
      pballoonCharNums:  readonly number[]
      /** OBJ chars for Green Para-Koopa sprite $09 (TL/TR/BL/BR), -1 when missing. */
      paraKoopaCharNums: readonly number[]
    } & TileDescriptorBase)
  | ({ kind: 'pipeVariants'; variants: readonly SubtileQuadDescriptor[] } & TileDescriptorBase)
  | ({
      kind: 'switchPalaceAlternate'
      off: SubtileQuadDescriptor
      on: SubtileQuadDescriptor
      color: 0 | 1 | 2 | 3
    } & TileDescriptorBase)
  | ({
      kind: 'pSwitchReveal'
      revealedQuad: SubtileQuadDescriptor
      /** Off-state alpha (0..1). Default 0.5 when omitted. */
      offAlpha?: number
    } & TileDescriptorBase)
  | ({
      kind: 'invisibleBlockReveal'
      revealedQuad: SubtileQuadDescriptor
      /** Optional reward indicator drawn above the block in a pre-pass. */
      rewardOverlayQuad: SubtileQuadDescriptor | null
      /** Constant alpha (0..1). Default 0.5 when omitted. */
      alpha?: number
    } & TileDescriptorBase)

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
      kind: 'ripVanFish'
      idleParts:     readonly SpritePartDescriptor[]
      detectedParts: readonly SpritePartDescriptor[]
    }
  | {
      kind: 'wingedSprite'
      bodyParts: readonly SpritePartDescriptor[]
      wingFrames: readonly [readonly SpritePartDescriptor[], readonly SpritePartDescriptor[]]
      wingsInFront: boolean
    }
  | {
      kind: 'hammerBroPlatform'
      platformParts: readonly SpritePartDescriptor[]
      wingFrames: readonly [readonly SpritePartDescriptor[], readonly SpritePartDescriptor[]]
    }
  | {
      kind: 'superKoopa'
      grounded:      readonly [readonly SpritePartDescriptor[], readonly SpritePartDescriptor[]]
      groundedFlash: readonly [readonly SpritePartDescriptor[], readonly SpritePartDescriptor[]]
      airborne:      readonly [readonly SpritePartDescriptor[], readonly SpritePartDescriptor[]]
      airborneFlash: readonly [readonly SpritePartDescriptor[], readonly SpritePartDescriptor[]]
      isAirborne: boolean
    }
  | {
      kind: 'volcanoLotus'
      headParts: readonly SpritePartDescriptor[]
      flowerFrames: readonly [readonly SpritePartDescriptor[], readonly SpritePartDescriptor[]]
    }
  | {
      kind: 'lineBrownPlat'
      platformParts: readonly SpritePartDescriptor[]
      direction: 'forward' | 'reverse'
    }
  | {
      kind: 'lineCheckerPlat'
      platformParts: readonly SpritePartDescriptor[]
      xShift: number
      width:  number
    }
  | {
      kind: 'ropeMechanism'
      motorFrames:     readonly (readonly SpritePartDescriptor[])[]
      bodyTemplate:    readonly SpritePartDescriptor[]
      knotTemplate:    readonly SpritePartDescriptor[]
      smokePuffFrames: readonly (readonly SpritePartDescriptor[])[]
      segmentCount:    number
    }
  | { kind: 'spikeTop'; parts0: readonly SpritePartDescriptor[]; parts1: readonly SpritePartDescriptor[] }
  | { kind: 'hammerBro'; parts: readonly SpritePartDescriptor[] }

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
  /** Nested child sprite for CompositeSprite (e.g. Hammer Bro on Platform).
   *  Absolute-positioned; recursion is intentional so composites can nest. */
  secondary?: SpriteDescriptor
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
  /**
   * Mario's starting pixel position at level load — picked from DATA_05F000/
   * 05F200 (or DATA_05FA00/05FC00 for sublevels reached via a secondary
   * entrance), resolved through DATA_05D730/740/750/758. Used by sprite
   * handlers whose flip/state depends on FaceMario at spawn.
   */
  marioStartPx: { x: number; y: number }
}

// ── Layer 3 ──────────────────────────────────────────────────────────

/**
 * Pre-computed L3 scroll-range rectangle (level pixel coords) for the
 * editor's BG-coverage overlay. Mirrors `L3ScrollRange` in L3Loader.ts —
 * duplicated here as a plain interface so the webview module doesn't have
 * to import from the extension-side rom layer.
 */
export interface L3ScrollRangeDescriptor {
  kind: 'tide' | 'fixed' | 'camera-tracked' | 'none'
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  /** Wave-surface row Y-position at high tide ($A0). Tide kinds only. */
  yHighTide?: number
  /** Wave-surface row Y-position at low tide ($30). Tide kinds only. */
  yLowTide?:  number
}

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
  /**
   * Pre-computed L3 scroll-range rectangle. Drives the editor's "Show L3
   * range" overlay so the designer can see where the BG will be visible
   * during play. `kind: 'none'` when there's no gameplay-area content.
   */
  scrollRange?: L3ScrollRangeDescriptor
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
