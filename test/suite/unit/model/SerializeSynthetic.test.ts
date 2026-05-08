/**
 * serialize.ts — synthetic coverage for private serializeL2 / serializeL3
 * and the scrollSimulator seed path.
 *
 * Test tree:
 *   serializeL2
 *     - null l2 → payload.l2 is null
 *     - L2Preset → kind='preset' emitted
 *     - L2ObjectStream → kind='objectStream' emitted
 *   serializeL3
 *     - null l3 → payload.l3 is null
 *     - L3TilemapLayer → serialized with tilemap + chars
 *   scrollSimulator?.seed ?? null
 *     - no scrollSimulator → payload.scrollSim is null (?? fires)
 *     - scrollSimulator present → payload.scrollSim is the seed (?? skipped)
 */

import { describe, it, expect } from 'vitest'
import { serialize } from '../../../../src/rom/model/serialize'
import { SmwMap } from '../../../../src/rom/model/SmwMap'
import { L2Preset, L2ObjectStream } from '../../../../src/rom/model/L2Layer'
import { L3TilemapLayer } from '../../../../src/rom/model/L3Layer'
import { Palette } from '../../../../src/rom/model/palette/Palette'
import { Color } from '../../../../src/rom/model/palette/Color'
import { StaticColorBehavior } from '../../../../src/rom/model/palette/behaviors/StaticColorBehavior'
import { Tile } from '../../../../src/rom/model/tiles/Tile'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import { StaticQuadBehavior } from '../../../../src/rom/model/tiles/behaviors/StaticQuadBehavior'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { NO_COLLISION } from '../../../../src/rom/model/tiles/TileCollision'
import { createMapStore } from '../../../../src/rom/model/stores/mapStore'
import { buildScrollSimulator } from '../../../../src/rom/scrollSim'
import { loadVanillaRom , vanillaRomPresent } from '../scrollSim_capture'
import type { ScrollSimSeed } from '../../../../src/rom/scrollSim'
import type { SubtileQuad } from '../../../../src/rom/model/tiles/Tile'
import type { GfxSheet } from '../../../../src/rom/GfxLoader'
import type { LevelHeader } from '../../../../src/rom/model/SmwMap'

// ── Primitive fixtures ────────────────────────────────────────────────────────

const RGBA = { r: 0, g: 0, b: 0, a: 255 }
const placeholder = new Char(-1, new StaticPixelsBehavior(new Uint8Array(64)))
const subTile = new SubTile(placeholder, 0, false, false, false)
const QUAD: SubtileQuad = [subTile, subTile, subTile, subTile]
const tile0 = new Tile(0, new StaticQuadBehavior(QUAD), 0, NO_COLLISION)
const CHARS = new Map([[0, placeholder]])
const L1_TILES = new Map([[0, tile0]])
const BG_TILES = new Map<number, Tile>()

const paletteColor = new Color(new StaticColorBehavior(RGBA))
const PALETTE = new Palette(
  Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => paletteColor)),
  paletteColor,
)

const HEADER: LevelHeader = {
  mode: 0, music: 0, tileset: 0, orientation: 'horizontal',
  initialCameraYPx: 0, timeLimit: 0, marioStartPx: { x: 0, y: 0 },
}

/** No-op scroll seed (cmd $00 both sides — no ROM reads needed). */
const SCROLL_SEED: ScrollSimSeed = {
  layer1XPos: 0, layer1YPos: 0, layer2XPos: 0, layer2YPos: 0,
  layer1ScrollCmd: 0, layer2ScrollCmd: 0,
  layer1ScrollBits: 0, layer2ScrollBits: 0,
  horizLayer2Setting: 0, vertLayer2Setting: 0,
  marioSpawnX: 0, marioSpawnY: 0, screenMode: 0,
}

/** 4 × 128-tile L3 GFX sheet of transparent pixels. */
function makeL3Chars(): GfxSheet[] {
  const emptySheet: GfxSheet = Array.from({ length: 128 }, () => new Uint8Array(64))
  return [emptySheet, emptySheet, emptySheet, emptySheet]
}

/** Build a minimal SmwMap with configurable L2 / L3 / scrollSim. */
function makeMap(opts: {
  l2?: SmwMap['l2']
  l3?: SmwMap['l3']
  withScrollSim?: boolean
}): SmwMap {
  const scrollSimulator = opts.withScrollSim
    ? buildScrollSimulator(loadVanillaRom(), SCROLL_SEED)
    : null
  const mapStore = createMapStore({ scrollSimulator })
  return new SmwMap(
    1,
    HEADER,
    /* l1 */ [[0, null], [null, 0]],
    opts.l2 ?? null,
    opts.l3 ?? null,
    /* sprites */ [],
    PALETTE,
    /* tileset */ 0,
    /* screenCount */ 1,
    /* screenPipeVariantIdx */ [0],
    L1_TILES,
    BG_TILES,
    mapStore,
  )
}

// ── serializeL2 ───────────────────────────────────────────────────────────────

describe.skipIf(!vanillaRomPresent)('serialize — l2 null', () => {
  it('emits payload.l2 = null when map has no L2 layer', () => {
    // Covers: serializeL2 if (l2 === null) return null — true branch
    const payload = serialize(makeMap({ l2: null }), CHARS, L1_TILES)
    expect(payload.l2).toBeNull()
  })
})

describe.skipIf(!vanillaRomPresent)('serialize — L2Preset', () => {
  it("emits kind='preset' when map.l2 is an L2Preset", () => {
    // Covers: serializeL2 if (l2 instanceof L2Preset) — true branch
    const preset = new L2Preset(0, [[0, null]], BG_TILES)
    const payload = serialize(makeMap({ l2: preset }), CHARS, L1_TILES)
    expect(payload.l2?.kind).toBe('preset')
  })
})

describe.skipIf(!vanillaRomPresent)('serialize — L2ObjectStream', () => {
  it("emits kind='objectStream' when map.l2 is an L2ObjectStream", () => {
    // Covers: serializeL2 if (l2 instanceof L2ObjectStream) — true branch
    const stream = new L2ObjectStream([[0, null]], L1_TILES)
    const payload = serialize(makeMap({ l2: stream }), CHARS, L1_TILES)
    expect(payload.l2?.kind).toBe('objectStream')
  })
})

// ── serializeL3 ───────────────────────────────────────────────────────────────

describe.skipIf(!vanillaRomPresent)('serialize — l3 null', () => {
  it('emits payload.l3 = null when map has no L3 layer', () => {
    // Covers: serializeL3 if (l3 === null) return null — true branch
    const payload = serialize(makeMap({ l3: null }), CHARS, L1_TILES)
    expect(payload.l3).toBeNull()
  })
})

describe.skipIf(!vanillaRomPresent)('serialize — L3TilemapLayer', () => {
  it('serializes L3TilemapLayer into tilemap + chars arrays', () => {
    // Covers: serializeL3 if (!(l3 instanceof L3TilemapLayer)) — false branch
    //         + the for-of sheet loop
    const l3 = new L3TilemapLayer(new Uint16Array(4096), makeL3Chars(), 0, 256, 432)
    const payload = serialize(makeMap({ l3 }), CHARS, L1_TILES)
    expect(payload.l3).not.toBeNull()
    expect(Array.isArray(payload.l3?.tilemap)).toBe(true)
    expect(Array.isArray(payload.l3?.chars)).toBe(true)
    // 4 sheets × 128 tiles = 512 char entries
    expect(payload.l3?.chars.length).toBe(512)
  })
})

// ── scrollSimulator?.seed ?? null ─────────────────────────────────────────────

describe.skipIf(!vanillaRomPresent)('serialize — no scrollSimulator', () => {
  it('emits payload.scrollSim = null when mapStore has no simulator', () => {
    // Covers: map.mapStore.scrollSimulator?.seed ?? null
    //   — ?.seed path when scrollSimulator is null → undefined → ?? fires → null
    const payload = serialize(makeMap({ withScrollSim: false }), CHARS, L1_TILES)
    expect(payload.scrollSim).toBeNull()
  })
})

describe.skipIf(!vanillaRomPresent)('serialize — with scrollSimulator', () => {
  it('emits payload.scrollSim as the seed when simulator is present', () => {
    // Covers: map.mapStore.scrollSimulator?.seed ?? null
    //   — ?.seed path when scrollSimulator is defined → seed object → ?? skipped
    const payload = serialize(makeMap({ withScrollSim: true }), CHARS, L1_TILES)
    expect(payload.scrollSim).not.toBeNull()
    // The seed is the same object we passed in (no transformation)
    expect(payload.scrollSim?.layer1ScrollCmd).toBe(SCROLL_SEED.layer1ScrollCmd)
  })
})
