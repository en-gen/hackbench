/**
 * The map tab's sprite layer (#564), drawn by the sprite interpreter (#585).
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
 *
 * THE SERVED PATH IS THE INTERPRETER (#585): `interpDrawer` runs the sprite's
 * own INIT and MAIN from the ROM on the 65816 core (src/rom/sprites/interp/)
 * and draws the first pass that puts a tile in OAM, at the anchor INIT left
 * (a Piranha Plant's +8 / -1, InitPiranha, SMWDisX bank_01.asm:880-889, comes
 * from running it, not from a table). The table engine (`engineDrawer`) stays
 * as the comparison oracle of step 3 and goes in step 4. Seeds are generic:
 * the ROM-run level loader's WRAM, Mario at the level's start, the camera
 * placed so the sprite is on screen. CGRAM a handler writes at runtime is
 * applied: the colors the sprite's own code wrote (NMI upload
 * list, palette mirror, direct registers; `Machine.paletteWrites`) override
 * the level's row for that sprite only. Not modelled: the sprite is run
 * alone, so one that reacts to a neighbour or to the player's actions shows its first pose.
 * A sprite with bit 3 of byte 0 set is marked, not drawn: the gate fails
 * closed for sprites that MAY be custom (PIXI dispatches on bit 3), which the
 * vanilla descriptor would draw wrongly. Vanilla scroll/command sprites ($E8,
 * $E9, $EA, $F5; e.g. slot $115 id $EA) also set it, since scroll sprites
 * read the bits as Layer1ScrollBits (bank_02.asm:5301-5305), and get the same
 * marker; that costs nothing today because none has a descriptor. Bit 2 is
 * not gated: vanilla keeps both extra bits in Y high (bank_02.asm:5441-5447)
 * and the goal tape saves them (InitGoalTape, bank_01.asm:8785-8788) and
 * reads bit 2 as its secret exit (bank_01.asm:8833-8836). Custom PIXI sprites on
 * GrandPooWorld_V1.2 were measured with EE = 2 (reviewer's scan, one ROM).
 */
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { parseLevelSprites } from '../../../../src/rom/LevelParser'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import { getCharPixels, type VramState } from '../../../../src/rom/GfxLoader'
import { bgr555ToRgba, type RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { getPaletteColor } from '../../../../src/rom/PaletteLoader'
import { readMarioStartPos } from '../../../../src/rom/L3Loader'
import {
  runOnce,
  type SpriteModel as RunModel,
  type PaletteWrite,
  type SpritePart,
} from '../../../../src/rom/sprites/interp/SpriteRunner'
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { withSeed, type SpriteSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
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
const EXTRA_BITS = 0x08
const NO_FLAGS: SwitchFlagsDto = { yellow: false, green: false, red: false, blue: false }
/** Bytes of a level's sprite stream read; a longer one is noted, not silently cut. */
export const STREAM_WINDOW = 0x200
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

/**
 * What a drawer answers for one sprite: the table engine's result, or the
 * interpreter's. `anchor` is where the sprite stands after its INIT ran (the
 * parts' dx/dy are relative to it); absent, the stream position is the anchor.
 * `reason` is a refusal in the interpreter's own words.
 */
export type SpriteDrawResult =
  | (Extract<EngineResult, { ok: true }> & {
      anchor?: { x: number; y: number }
      /** CGRAM colors the sprite's own code set by its drawn frame (interpreter only). */
      runtimePalette?: PaletteWrite[]
    })
  | Extract<EngineResult, { ok: false }>
  | { ok: false; reason: string }

/** Runs a drawer for one sprite; injected so the placement math is tested without a cart. */
export type SpriteDrawer = (sprite: LevelSprite) => SpriteDrawResult

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
    // Fail closed: a possibly custom sprite is never given vanilla art.
    if ((s.raw[0] ?? 0) & EXTRA_BITS) return placeholder(s, 'extraBits')
    const res = draw(s)
    if (!res.ok) return placeholder(s, 'reason' in res ? res.reason : res.failure.kind)
    if (res.parts.length === 0) return placeholder(s, 'noParts')
    const pixels = res.parts.map(p => getCharPixels(model.vram, p.charNum))
    // One missing char would draw as a hole, so the whole sprite is marked.
    if (pixels.some(p => !p)) return placeholder(s, 'charsNotLoaded')
    const [ax, ay] = 'anchor' in res && res.anchor ? [res.anchor.x, res.anchor.y] : [pixelX(s), s.y * TILE] // prettier-ignore
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
      const runtime = new Map<number, number>()
      for (const w of ('runtimePalette' in res && res.runtimePalette) || []) runtime.set(w.index, w.bgr555) // prettier-ignore
      const row = (c: number): RgbaColor => {
        // The sprite's own CGRAM writes (WRAM upload list, palette mirror, direct), per sprite.
        const set = runtime.get(p.palette * 16 + c)
        // Only the parts on the row the handler uploads to; another row keeps the level's colors.
        const spliced = note && p.palette === note.row && c >= note.firstCol ? dyn[c - note.firstCol] : undefined // prettier-ignore
        if (set !== undefined && !spliced) return bgr555ToRgba(set)
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

/** The engine's parts as `[char, palette, flipX, flipY, dx, dy]`, order-free: how step 3 compares engines. */
export const partKey = (p: EnginePart) => [p.charNum, p.palette, +p.flipX, +p.flipY, p.dx, p.dy].join(',') // prettier-ignore

/**
 * The interpreter's `chosen` frame as drawable parts. A 16 x 16 OAM entry is
 * four 8 x 8 chars (tile, +1, +$10, +$11: a flip swaps which char sits
 * where). Highest OAM index first, so the lower index (higher priority) is
 * blitted last and wins an overlap. `char` is the 9-bit OBJ char; hackbench
 * numbers OBJ chars from $400.
 */
export function interpParts(parts: readonly SpritePart[]): EnginePart[] {
  const out: EnginePart[] = []
  for (const p of [...parts].sort((a, b) => b.oam - a.oam)) {
    const cells = p.size === 16 ? ([[0, 0], [1, 0], [0, 1], [1, 1]] as const) : ([[0, 0]] as const) // prettier-ignore
    for (const [cx, cy] of cells) {
      const [col, row] = [p.flipX ? 1 - cx : cx, p.flipY ? 1 - cy : cy]
      out.push({
        charNum: 0x400 + p.char + (p.size === 16 ? cx + cy * 16 : 0),
        palette: p.palette,
        flipX: p.flipX,
        flipY: p.flipY,
        dx: p.dx + (p.size === 16 ? col * 8 : 0),
        dy: p.dy + (p.size === 16 ? row * 8 : 0),
      })
    }
  }
  return out
}

/** Camera that puts a level position on screen: centred, clamped to the map's scroll range. */
export function cameraFor(x: number, y: number, vertical: boolean, screens: number) {
  const [maxX, maxY] = vertical ? [256, screens * 256 - 224] : [screens * 256 - 256, 432 - 224]
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v))
  return { x: clamp(x - 128, maxX), y: clamp(y - 112, maxY) }
}

/** What the interpreter shows for one sprite: its model, as the drawer's reply. */
export function modelResult(m: RunModel): SpriteDrawResult {
  if (m.refusal) return { ok: false, reason: `refused: ${m.refusal}` }
  const pass = m.chosen === undefined ? undefined : m.passes[m.chosen]
  if (!m.anchor || !pass) return { ok: false, reason: m.emptyReason ?? 'drew no tile' }
  return {
    ok: true,
    parts: interpParts(pass.parts),
    anchor: { x: m.anchor.x, y: m.anchor.y },
    runtimePalette: pass.palette,
    identity: { spriteId: m.id, mainHandler: 0, initHandler: 0, status: 'vanilla' },
  }
}

/**
 * The interpreter over this cart, for the level `index`: its own loader's
 * WRAM, Mario at the level's start, one sprite run alone per call. Null when
 * the loader cannot run (the table engine is then the only source).
 */
export function interpDrawer(
  rom: RomFile,
  index: number,
  model: { isVertical: boolean; screenCount: number },
  run: (rom: RomFile, id: number, seed: SpriteSeed) => RunModel = runOnce,
): SpriteDrawer | { reason: string } {
  const loaded = loadLevelState(rom, index)
  if (!loaded.ok) return { reason: loaded.reason }
  const mario = readMarioStartPos(rom, index)
  return s => {
    const [x, y] = [pixelX(s), s.y * TILE]
    const camera = cameraFor(x, y, model.isVertical, model.screenCount)
    return modelResult(run(rom, s.spriteId, withSeed({ sprite: { x, y }, camera, mario, loaded: loaded.wram }))) // prettier-ignore
  }
}

/** A sprite stream's bytes: up to the window, fewer when the ROM ends first (as SmwRom.getLevelRawData reads). */
export const readStream = (rom: RomFile, ptr: number, window = STREAM_WINDOW) =>
  rom.readUpTo(ptr, window)

/** The stream's own terminator ($FF in a first-byte slot) within the bytes read. */
const terminated = (data: Uint8Array) => {
  for (let p = 1; p < data.length; p += 3) if (data[p] === 0xff) return true
  return false
}

/** The reply for a stream: its sprites drawn, in the geometry of the map's screens. */
export function spriteLayer(
  data: Uint8Array,
  model: SpriteModel & { isVertical: boolean; screenCount: number },
  draw: SpriteDrawer,
  dynamic?: (note: PaletteNote) => RgbaColor[],
): Extract<MapSpritesResult, { status: 'ok' }> {
  const { w, h } = screenTiles(model.isVertical)
  return {
    status: 'ok',
    orientation: model.isVertical ? 'vertical' : 'horizontal',
    screenCount: model.screenCount,
    width: w * TILE,
    height: h * TILE,
    sprites: drawSprites(parseLevelSprites(data, model.isVertical), model, draw, dynamic),
    note: terminated(data)
      ? undefined
      : 'The sprite stream has no end marker in the bytes read: sprites past them are not drawn.',
  }
}

/**
 * Replies per working-copy bytes and map: running every sprite's INIT and 64
 * passes takes a moment, and the working copy hands out new bytes after each
 * edit, so nothing here needs invalidating.
 */
const replies = new WeakMap<Uint8Array, Map<number, ReturnType<typeof compute>>>()

/** A map's sprites from the working copy's bytes, over the same model as its screens. */
export function mapSprites(
  cache: L1ModelCache,
  bytes: Uint8Array,
  romPath: string,
  index: number,
): ReturnType<typeof compute> {
  let byMap = replies.get(bytes)
  if (!byMap) replies.set(bytes, (byMap = new Map()))
  let r = byMap.get(index)
  if (!r) {
    r = compute(cache, bytes, romPath, index)
    // Only a computed answer is kept; an unavailable one may be a loader hiccup worth retrying.
    if (r.status === 'ok') byMap.set(index, r)
  }
  return r
}

function compute(
  cache: L1ModelCache,
  bytes: Uint8Array,
  romPath: string,
  index: number,
): Exclude<MapSpritesResult, { status: 'rom-not-located' }> {
  // Sprites do not depend on the palaces; any flags give the same model.
  const built = cache.get(bytes, romPath, index, NO_FLAGS)
  if (!built.ok) return { status: 'unavailable', reason: built.reason }
  const model = built.inputs
  try {
    // A copy, as the model cache makes: the working copy's array is shared.
    const rom = new SmwRom(RomFile.fromBytes(romPath, Buffer.from(bytes)))
    const ptr = rom.getLevelSpritePointer(index)
    // A stream in the ROM's last bytes is still a stream (as SmwRom.getLevelRawData reads).
    const data = ptr === null ? null : readStream(rom.rom, ptr)
    if (!data) return { status: 'unavailable', reason: `No sprite data at the pointer for slot ${index.toString(16)}` } // prettier-ignore
    const draw = interpDrawer(rom.rom, index, model)
    if (typeof draw !== 'function') return { status: 'unavailable', reason: `The level loader did not run: ${draw.reason}` } // prettier-ignore
    const dynamic = (n: PaletteNote) => {
      const b = rom.rom.readAt(n.entryAddr, n.colors * 2)
      return b ? Array.from({ length: n.colors }, (_, i) => bgr555ToRgba(b[i * 2]! | (b[i * 2 + 1]! << 8))) : [] // prettier-ignore
    }
    return spriteLayer(data, model, draw, dynamic)
  } catch (err) {
    return { status: 'unavailable', reason: (err as Error).message }
  }
}
