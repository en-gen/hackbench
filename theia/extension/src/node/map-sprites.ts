/**
 * The map tab's sprite layer (#564), drawn by the table engine.
 *
 * Pure, so it is unit tested in CI; `ProjectServiceImpl` only resolves the
 * working copy and delegates here. Each sprite of the level's stream goes to
 * `drawSpriteParts`; the chars come from the level's own VRAM (SP1-SP4, as
 * `loadVram` placed them) and the colors from the level's CGRAM, whose rows
 * 8-15 are the sprite palettes. The ROW a part uses is the engine's: it reads
 * the sprite's own palette source (docs/sprites/sprite-engine-divergence.md),
 * so the level's palette is only the colors that row holds, not a choice.
 *
 * A part lands at the sprite's anchor (its tile corner, in map pixels) plus
 * the engine's dx/dy: negative, off the 16 px grid, and free to spill past
 * its tile or screen, so nothing is snapped and each sprite is one bitmap
 * the view cuts per screen. A sprite the engine declines (no descriptor, a
 * repointed handler, chars not loaded, a custom handler) is a 16 x 16 marker
 * with its hex id, never invented art. That includes the non-visual sprites
 * (auto-scroll, generators, layer control): their real treatment is deferred.
 */
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { parseLevelSprites } from '../../../../src/rom/LevelParser'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import { getCharPixels, type VramState } from '../../../../src/rom/GfxLoader'
import { bgr555ToRgba, type RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { getPaletteColor } from '../../../../src/rom/PaletteLoader'
import { readMarioStartPos } from '../../../../src/rom/L3Loader'
import { readSpriteTileTables } from '../../../../src/rom/SpriteTileLoader'
import {
  drawSpriteParts,
  findDescriptor,
  resolveIdentity,
  type EnginePart,
  type EngineResult,
  type PaletteNote,
} from '../../../../src/rom/model/sprites/generic/SpriteDrawEngine'
import type { MapSpriteDto, MapSpritesResult, SwitchFlagsDto } from '../common/project-protocol'
import { screenTiles, type L1ModelCache } from './map-screen'

const TILE = 16
const MARK = 16
/** The marker's colors: a dark fill under white hex digits, in an editor blue frame. */
const FILL: RgbaColor = [20, 20, 40, 220]
const FRAME: RgbaColor = [90, 200, 255, 255]
const INK: RgbaColor = [255, 255, 255, 255]

/** 3 x 5 hex digits, one string of 15 cells per digit, row-major. */
const FONT = [
  '111101101101111', '010110010010111', '111001111100111', '111001111001111',
  '101101111001001', '111100111001111', '111100111101111', '111001001001001',
  '111101111101111', '111101111001111', '111101111101101', '110101110101110',
  '111100100100111', '110101101101110', '111100110100111', '111100110100100',
] // prettier-ignore

/** What the model supplies: the level's chars and its 256-color CGRAM. */
export interface SpriteModel {
  vram: VramState
  colors: RgbaColor[]
}

/** Runs the engine for one sprite; injected so the placement math is tested without a cart. */
export type SpriteDrawer = (sprite: LevelSprite) => EngineResult

/** The anchor's X in level pixels is what facing and Yoshi-egg color read. */
const pixelX = (s: LevelSprite) => s.x * TILE

function marker(id: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(MARK * MARK * 4)
  const put = (x: number, y: number, c: RgbaColor) => out.set(c, (y * MARK + x) * 4)
  for (let y = 0; y < MARK; y++) {
    for (let x = 0; x < MARK; x++) {
      put(x, y, x === 0 || y === 0 || x === MARK - 1 || y === MARK - 1 ? FRAME : FILL)
    }
  }
  // Two digits, 3 x 5 scaled 2x: 6 px wide each, centred.
  ;[(id >> 4) & 15, id & 15].forEach((d, n) => {
    for (let i = 0; i < 15; i++) {
      if (FONT[d]![i] !== '1') continue
      const [cx, cy] = [2 + n * 7 + (i % 3) * 2, 3 + Math.floor(i / 3) * 2]
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) put(cx + ox, cy + oy, INK) // prettier-ignore
    }
  })
  return out
}

function placeholder(s: LevelSprite, reason: string): MapSpriteDto {
  const [x, y] = [pixelX(s), s.y * TILE]
  return {
    index: s.index,
    id: s.spriteId,
    x,
    y,
    box: { x0: x, y0: y, x1: x + MARK, y1: y + MARK },
    rgba: base64(marker(s.spriteId)),
    status: 'placeholder',
    reason,
  }
}

const base64 = (b: Uint8ClampedArray) =>
  Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64')

/** The part's pixels into `out` (bitmap origin `ox, oy`), color index 0 left clear. */
function blit(
  out: Uint8ClampedArray,
  width: number,
  p: EnginePart,
  at: [number, number],
  pixels: Uint8Array,
  row: (c: number) => RgbaColor,
): void {
  for (let ty = 0; ty < 8; ty++) {
    for (let tx = 0; tx < 8; tx++) {
      const v = pixels[(p.flipY ? 7 - ty : ty) * 8 + (p.flipX ? 7 - tx : tx)]!
      if (v === 0) continue
      out.set(row(v), ((at[1] + ty) * width + at[0] + tx) * 4)
    }
  }
}

/**
 * Every sprite as one bitmap, in the stream's order. `dynamic` supplies the
 * colors a sprite's own handler uploads to CGRAM at runtime (the engine's
 * `dynamicCgram` note): spliced over the level's row, the rest kept.
 */
export function drawSprites(
  sprites: readonly LevelSprite[],
  model: SpriteModel,
  draw: SpriteDrawer,
  dynamic: (note: PaletteNote) => RgbaColor[] = () => [],
): MapSpriteDto[] {
  return sprites.map(s => {
    const res = draw(s)
    if (!res.ok) return placeholder(s, res.failure.kind)
    const pixels = res.parts.map(p => getCharPixels(model.vram, p.charNum))
    if (res.parts.length === 0) return placeholder(s, 'noParts')
    // One missing char would draw as a hole, so the whole sprite is marked.
    if (pixels.some(p => !p)) return placeholder(s, 'charsNotLoaded')
    const [ax, ay] = [pixelX(s), s.y * TILE]
    const box = {
      x0: ax + Math.min(...res.parts.map(p => p.dx)),
      y0: ay + Math.min(...res.parts.map(p => p.dy)),
      x1: ax + Math.max(...res.parts.map(p => p.dx)) + 8,
      y1: ay + Math.max(...res.parts.map(p => p.dy)) + 8,
    }
    const width = box.x1 - box.x0
    const out = new Uint8ClampedArray(width * (box.y1 - box.y0) * 4)
    const dyn = res.paletteNote ? dynamic(res.paletteNote) : []
    res.parts.forEach((p, i) => {
      const note = res.paletteNote
      const row = (c: number): RgbaColor => {
        const spliced = note && c >= note.firstCol ? dyn[c - note.firstCol] : undefined
        return spliced ?? getPaletteColor(model, p.palette, c)
      }
      blit(out, width, p, [ax + p.dx - box.x0, ay + p.dy - box.y0], pixels[i]!, row)
    })
    return {
      index: s.index,
      id: s.spriteId,
      x: ax,
      y: ay,
      box,
      rgba: base64(out),
      status: 'drawn',
    }
  })
}

/** The engine over this cart: a missing descriptor or a repointed handler is a miss, never a guess. */
export function engineDrawer(rom: RomFile, marioX: number): SpriteDrawer | null {
  const tables = readSpriteTileTables(rom)
  if (!tables) return null
  return s => {
    const descriptor = findDescriptor(s.spriteId)
    if (!descriptor) return { ok: false, failure: { kind: 'noDescriptor', spriteId: s.spriteId } }
    const identity = resolveIdentity(rom, s.spriteId)
    if (identity?.status === 'custom') {
      return {
        ok: false,
        identity,
        failure: { kind: 'customHandler', spriteId: s.spriteId, table: 'main', expected: descriptor.vanillaMainHandler, found: identity.mainHandler }, // prettier-ignore
      }
    }
    // romFrame 0: the still pose, as the map tab holds every animated tile at frame 0.
    return drawSpriteParts({ rom, tables, descriptor, spriteX: pixelX(s), ctx: { marioX, romFrame: 0 } }) // prettier-ignore
  }
}

/** A map's sprites from the working copy's bytes, over the same model as its screens. */
export function mapSprites(
  cache: L1ModelCache,
  bytes: Uint8Array,
  romPath: string,
  index: number,
  flags: SwitchFlagsDto,
): Exclude<MapSpritesResult, { status: 'rom-not-located' }> {
  const built = cache.get(bytes, romPath, index, flags)
  if (!built.ok) return { status: 'unavailable', reason: built.reason }
  const model = built.inputs
  try {
    // A copy, as the model cache makes: the working copy's array is shared.
    const rom = new SmwRom(RomFile.fromBytes(romPath, Buffer.from(bytes)))
    const ptr = rom.getLevelSpritePointer(index)
    const data = ptr === null ? null : rom.rom.readAt(ptr, 0x200)
    if (!data) return { status: 'unavailable', reason: `No sprite data at the pointer for slot ${index.toString(16)}` } // prettier-ignore
    const draw = engineDrawer(rom.rom, readMarioStartPos(rom.rom, index).x)
    if (!draw) return { status: 'unavailable', reason: 'The sprite tile tables cannot be read' }
    const dynamic = (n: PaletteNote) => {
      const b = rom.rom.readAt(n.entryAddr, n.colors * 2)
      return b ? Array.from({ length: n.colors }, (_, i) => bgr555ToRgba(b[i * 2]! | (b[i * 2 + 1]! << 8))) : [] // prettier-ignore
    }
    const { w, h } = screenTiles(model.isVertical)
    return {
      status: 'ok',
      orientation: model.isVertical ? 'vertical' : 'horizontal',
      screenCount: model.screenCount,
      width: w * TILE,
      height: h * TILE,
      sprites: drawSprites(parseLevelSprites(data, model.isVertical), model, draw, dynamic),
    }
  } catch (err) {
    return { status: 'unavailable', reason: (err as Error).message }
  }
}
