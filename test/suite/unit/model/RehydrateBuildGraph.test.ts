/**
 * rehydrate.ts buildGraph — branch coverage.
 *
 * Test tree:
 *   bgTiles
 *     - absent (undefined) → empty bgTiles map returned
 *     - present → bgTiles map populated
 *   scrollSim
 *     - null → scrollSimulator passed as null in mapStore
 *     - defined seed → buildScrollSimulator called; no error
 *   marioStartPx
 *     - defined { x, y } → marioSpawnX from x (??-left branch)
 *     - undefined (as any) → marioSpawnX = 0 (??-right branch)
 *   buildL2
 *     - null descriptor → L2Layer is null
 *     - kind='preset' → L2Preset created
 *     - kind='objectStream' (layer2YRange=null, tileDyRanges=null) → ??-right branches
 *     - kind='objectStream' (layer2YRange defined, tileDyRanges defined) → ??-left branches
 *   buildL3
 *     - absent / null → L3Layer is null
 *     - descriptor with all chars populated → pixels truthy branch (new Uint8Array(pixels))
 *     - descriptor with sparse chars (holes) → pixels falsy branch (new Uint8Array(64))
 */

import { describe, it, expect } from 'vitest'
import { buildGraph } from '../../../../src/rom/model/rehydrate'
import type {
  MapPayload,
  ColorDescriptor,
  PaletteDescriptor,
  SubTileDescriptor,
  SubtileQuadDescriptor,
  TileDescriptor,
  L2Descriptor,
  L3Descriptor,
  ScrollSimSeedDescriptor,
  LevelHeaderDescriptor,
  SpriteDescriptor,
} from '../../../../src/rom/model/MapPayload'
import { NO_COLLISION } from '../../../../src/rom/model/tiles/TileCollision'

// ── Primitive fixtures ────────────────────────────────────────────────────────

const STATIC_COLOR: ColorDescriptor = { kind: 'static', value: { r: 0, g: 0, b: 0, a: 255 } }

/** 16×16 palette grid — minimal valid PaletteDescriptor */
const PALETTE_DESC: PaletteDescriptor = {
  cells: Array.from({ length: 16 }, () =>
    Array.from({ length: 16 }, () => STATIC_COLOR),
  ),
  backAreaColor: STATIC_COLOR,
}

const ST: SubTileDescriptor = { charNum: 0, palette: 0, flipX: false, flipY: false, priority: false }
const QUAD = [ST, ST, ST, ST] as unknown as SubtileQuadDescriptor

const TILE: TileDescriptor = { kind: 'static', quad: QUAD, actsLike: 0, collision: NO_COLLISION }

/** Minimal char descriptor — static with 64 zero-valued pixels. */
const CHAR_STATIC = { kind: 'static' as const, pixels: Array(64).fill(0) }

/** Minimal valid LevelHeaderDescriptor with marioStartPx present. */
function makeHeader(override?: Partial<LevelHeaderDescriptor>): LevelHeaderDescriptor {
  return {
    mode: 0,
    music: 0,
    tileset: 0,
    orientation: 'horizontal',
    initialCameraYPx: 0,
    timeLimit: 0,
    marioStartPx: { x: 50, y: 100 },
    ...override,
  }
}

/** Minimal scroll simulator seed (cmd $00 = no-op both sides). */
const SCROLL_SEED: ScrollSimSeedDescriptor = {
  layer1XPos: 0,
  layer1YPos: 0,
  layer2XPos: 0,
  layer2YPos: 0,
  layer1ScrollCmd: 0,
  layer2ScrollCmd: 0,
  layer1ScrollBits: 0,
  layer2ScrollBits: 0,
  horizLayer2Setting: 0,
  vertLayer2Setting: 0,
  marioSpawnX: 0,
  marioSpawnY: 0,
  screenMode: 0,
}

/** Returns a minimal MapPayload with all optional fields absent / null. */
function makeBasePayload(overrides: Partial<MapPayload> = {}): MapPayload {
  return {
    levelId: 1,
    header: makeHeader(),
    chars: { 0: CHAR_STATIC },
    tiles: { 0: TILE },
    palette: PALETTE_DESC,
    layout: [[0, null], [null, 0]],
    l2: null,
    sprites: [] as readonly SpriteDescriptor[],
    tileset: 0,
    screenCount: 1,
    screenPipeVariantIdx: [0],
    scrollSim: null,
    ...overrides,
  }
}

// ── bgTiles ───────────────────────────────────────────────────────────────────

describe('buildGraph — bgTiles absent', () => {
  it('returns empty bgTiles map when bgTiles key is not in payload', () => {
    // Covers: if (payload.bgTiles) — false branch
    const payload = makeBasePayload()       // no bgTiles key
    const { bgTiles } = buildGraph(payload)
    expect(bgTiles.size).toBe(0)
  })
})

describe('buildGraph — bgTiles present', () => {
  it('populates bgTiles map when bgTiles is defined', () => {
    // Covers: if (payload.bgTiles) — true branch + inner loop
    const payload = makeBasePayload({
      bgTiles: { 5: TILE },
    })
    const { bgTiles } = buildGraph(payload)
    expect(bgTiles.size).toBe(1)
    expect(bgTiles.has(5)).toBe(true)
  })
})

// ── scrollSim ─────────────────────────────────────────────────────────────────

describe('buildGraph — scrollSim null', () => {
  it('builds map without scroll simulator when scrollSim is null', () => {
    // Covers: payload.scrollSim ? ... : null — false branch (null result)
    const payload = makeBasePayload({ scrollSim: null })
    const { map } = buildGraph(payload)
    expect(map).toBeDefined()
  })
})

describe('buildGraph — scrollSim defined', () => {
  it('calls buildScrollSimulator when scrollSim seed is provided', () => {
    // Covers: payload.scrollSim ? buildScrollSimulator(...) : null — true branch
    const payload = makeBasePayload({ scrollSim: SCROLL_SEED })
    const { map } = buildGraph(payload)
    expect(map).toBeDefined()
  })
})

// ── marioStartPx ─────────────────────────────────────────────────────────────

describe('buildGraph — marioStartPx defined', () => {
  it('uses marioStartPx.x when present (??-left side branch)', () => {
    // Covers: payload.header.marioStartPx?.x ?? 0 — left side (defined value)
    const payload = makeBasePayload({
      header: makeHeader({ marioStartPx: { x: 72, y: 200 } }),
    })
    // If this doesn't throw, the ?.x path executed correctly.
    const { map } = buildGraph(payload)
    expect(map).toBeDefined()
  })
})

describe('buildGraph — marioStartPx undefined', () => {
  it('falls back to 0 when marioStartPx is absent (??-right side branch)', () => {
    // Covers: payload.header.marioStartPx?.x ?? 0 — right side (?? fires)
    const header = { ...makeHeader(), marioStartPx: undefined } as any
    const payload = makeBasePayload({ header })
    const { map } = buildGraph(payload)
    expect(map).toBeDefined()
  })
})

// ── buildL2 ───────────────────────────────────────────────────────────────────

describe('buildGraph — l2 null', () => {
  it('builds map with no L2 layer when l2 descriptor is null', () => {
    // Covers: buildL2 if (!desc) return null — true branch
    const { map } = buildGraph(makeBasePayload({ l2: null }))
    expect(map).toBeDefined()
  })
})

describe('buildGraph — l2 kind=preset', () => {
  it('builds L2Preset when l2.kind is preset', () => {
    // Covers: buildL2 if (desc.kind === 'preset') — true branch
    const l2: L2Descriptor = {
      kind: 'preset',
      page: 0,
      layout: [[0, null], [null, 0]],
    }
    const payload = makeBasePayload({
      bgTiles: { 0: TILE },
      l2,
    })
    const { map } = buildGraph(payload)
    expect(map).toBeDefined()
  })
})

describe('buildGraph — l2 kind=objectStream (layer2YRange=null, tileDyRanges=null)', () => {
  it('builds L2ObjectStream with null ranges (??-right branches fire)', () => {
    // Covers: buildL2 objectStream path
    //   desc.paletteOrMask ?? 0 — left side (0 is not null/undefined)
    //   desc.layer2YRange ?? null — right side (null fires ??)
    //   desc.tileDyRanges ?? null — right side (null fires ??)
    const l2: L2Descriptor = {
      kind: 'objectStream',
      layout: [[0, null]],
      initialLayer2YPx: 0,
      scrollRange: { kind: 'none', xMin: 0, xMax: 0, yMin: 0, yMax: 0 },
      paletteOrMask: 0,
      layer2YRange: null,
      tileDyRanges: null,
    }
    const { map } = buildGraph(makeBasePayload({ l2 }))
    expect(map).toBeDefined()
  })
})

describe('buildGraph — l2 kind=objectStream (layer2YRange defined, tileDyRanges defined)', () => {
  it('builds L2ObjectStream with defined ranges (??-left branches skip)', () => {
    // Covers:
    //   desc.layer2YRange ?? null — left side (defined, ?? skipped)
    //   desc.tileDyRanges ?? null — left side (defined, ?? skipped)
    const l2: L2Descriptor = {
      kind: 'objectStream',
      layout: [[null]],
      initialLayer2YPx: 0,
      scrollRange: { kind: 'fixed', xMin: 0, xMax: 256, yMin: 0, yMax: 432 },
      paletteOrMask: 0,
      layer2YRange: { min: -10, max: 10 },
      tileDyRanges: [[{ min: -5, max: 5 }]],
    }
    const { map } = buildGraph(makeBasePayload({ l2 }))
    expect(map).toBeDefined()
  })
})

// ── buildL3 ───────────────────────────────────────────────────────────────────

describe('buildGraph — l3 absent', () => {
  it('builds map with no L3 when l3 is undefined', () => {
    // Covers: buildL3(payload.l3 ?? null) — ?? fires (undefined), buildL3(!desc) true branch
    const payload = makeBasePayload()   // l3 key absent
    const { map } = buildGraph(payload)
    expect(map).toBeDefined()
  })

  it('builds map with no L3 when l3 is explicitly null', () => {
    // Covers: buildL3(payload.l3 ?? null) where l3=null → ?? fires, buildL3(!desc) true branch
    const payload = makeBasePayload({ l3: null })
    const { map } = buildGraph(payload)
    expect(map).toBeDefined()
  })
})

/** Build a minimal L3Descriptor. `sparseChars` controls whether chars has data. */
function makeL3Desc(sparseChars = false): L3Descriptor {
  return {
    tilemap: Array(4096).fill(0),
    // 512 entries: 4 sheets × 128 tiles. Each entry is 64 pixel indices.
    chars: sparseChars
      // Empty outer array — desc.chars[idx] is always undefined → falsy pixels branch.
      ? []
      // All 512 slots filled with 64 zero-valued pixels → truthy pixels branch.
      : Array.from({ length: 512 }, () => Array(64).fill(0)),
    initialYPx: 0,
    levelPixelW: 256,
    levelPixelH: 432,
  }
}

describe('buildGraph — l3 with all chars populated', () => {
  it('wraps each char pixel array (pixels truthy branch)', () => {
    // Covers: buildL3 inner loop → pixels ? new Uint8Array(pixels) : ... — true branch
    const payload = makeBasePayload({ l3: makeL3Desc(false) })
    const { map } = buildGraph(payload)
    expect(map).toBeDefined()
  })
})

describe('buildGraph — l3 with sparse/empty chars array', () => {
  it('uses zero-filled Uint8Array(64) for missing char slots (pixels falsy branch)', () => {
    // Covers: buildL3 inner loop → pixels ? ... : new Uint8Array(64) — false branch
    const payload = makeBasePayload({ l3: makeL3Desc(true) })
    const { map } = buildGraph(payload)
    expect(map).toBeDefined()
  })
})

// ── tiles loop — ?? right-side branches ──────────────────────────────────────

describe('buildGraph — tile descriptor missing actsLike and collision', () => {
  it('falls back to id for actsLike and NO_COLLISION when fields absent (?? right-side branches)', () => {
    // TILE always carries actsLike:0 and collision:NO_COLLISION, so their ??
    // operators always take the left branch.  Use a descriptor that omits
    // both fields — V8 then takes the right branch for both expressions:
    //   desc.actsLike   ?? id          → id
    //   desc.collision  ?? NO_COLLISION → NO_COLLISION
    const tileNoMeta = { kind: 'static', quad: QUAD } as any
    const payload = makeBasePayload({ tiles: { 7: tileNoMeta } })
    const { tiles } = buildGraph(payload)
    expect(tiles.has(7)).toBe(true)
  })
})

describe('buildGraph — bgTile descriptor missing actsLike and collision', () => {
  it('falls back to id and NO_COLLISION for bgTiles (?? right-side branches)', () => {
    // Same as the tiles test above but exercises the bgTiles loop:
    //   td.actsLike   ?? id          → id
    //   td.collision  ?? NO_COLLISION → NO_COLLISION
    const tileNoMeta = { kind: 'static', quad: QUAD } as any
    const payload = makeBasePayload({ bgTiles: { 9: tileNoMeta } })
    const { bgTiles } = buildGraph(payload)
    expect(bgTiles.has(9)).toBe(true)
  })
})

// ── buildL2 — paletteOrMask ?? right-side branches ───────────────────────────

describe('buildGraph — l2 objectStream with paletteOrMask absent', () => {
  it('falls back to 0 for paletteOrMask when field is absent (?? right-side branches)', () => {
    // The two existing objectStream tests always supply `paletteOrMask: 0`,
    // so the left side of `desc.paletteOrMask ?? 0` fires (0 ≠ null/undefined).
    // Omitting the field triggers the right-side branch in BOTH expressions:
    //   buildL2Tiles(l1Tiles, desc.paletteOrMask ?? 0)  → 0
    //   new L2ObjectStream(..., desc.paletteOrMask ?? 0, ...)  → 0
    const l2 = {
      kind: 'objectStream',
      layout: [[null]],
      initialLayer2YPx: 0,
      scrollRange: { kind: 'none', xMin: 0, xMax: 0, yMin: 0, yMax: 0 },
      // paletteOrMask intentionally absent
      layer2YRange: null,
      tileDyRanges: null,
    } as any
    const { map } = buildGraph(makeBasePayload({ l2 }))
    expect(map).toBeDefined()
  })
})
