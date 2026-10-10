/**
 * The map tab's sprite layer (#564), drawn by the sprite interpreter (#585).
 *
 * Pure, so it is unit tested in CI; `ProjectServiceImpl` only resolves the
 * working copy and delegates here. Each sprite of the level's stream is run by
 * `interpDrawer` (below); the chars come from the level's own VRAM (SP1-SP4,
 * as `loadVram` placed them) and the colors from the level's CGRAM, whose rows
 * 8-15 are the sprite palettes. The ROW a part uses is the sprite's own
 * (its OAM attribute byte), so the level's palette is only the colors that row
 * holds, not a choice.
 *
 * A part lands at the sprite's anchor (its tile corner, in map pixels) plus
 * the part's dx/dy: negative, off the 16 px grid, and free to spill past
 * its tile or screen, so nothing is snapped and each sprite is one bitmap
 * the view cuts per screen. A sprite the interpreter refuses or that draws
 * nothing, or whose chars are not loaded, is a 16 x 16 marker with its hex id
 * and the reason, never invented art. That includes the non-visual sprites
 * (auto-scroll, generators, layer control): their real treatment is deferred.
 *
 * THE SERVED PATH IS THE INTERPRETER (#585): `interpDrawer` runs the sprite's
 * own INIT and MAIN from the ROM on the 65816 core (src/rom/sprites/interp/)
 * and draws the first pass that puts a tile in OAM, at the anchor INIT left
 * (a Piranha Plant's +8 / -1, InitPiranha, SMWDisX bank_01.asm:880-889, comes
 * from running it, not from a table). The table engine (`engineDrawer`) stays
 * as the comparison oracle of step 3 and goes in step 4. Seeds are generic:
 * the ROM-run level loader's WRAM, Mario at the level's start, the camera
 * placed so the sprite is on screen. The colors the sprite's own code wrote to
 * CGRAM (NMI upload list, palette mirror, direct registers;
 * `Machine.paletteWrites`) override the level's row for that sprite only.
 * Not modelled: the sprite is run alone, so one that reacts to a neighbour or
 * to the player's actions shows its first pose.
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
  RAM,
  type SpriteModel as RunModel,
  type PaletteWrite,
  type SpritePart,
} from '../../../../src/rom/sprites/interp/SpriteRunner'
import { levelSeed } from '../../../../src/rom/sprites/interp/LevelLoader'
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
      /** Set when the run's seed is not the ROM-run level state: why the art is unverified. */
      unverified?: string
    })
  | Extract<EngineResult, { ok: false }>
  | { ok: false; reason: string; unverified?: string }

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

function placeholder(s: LevelSprite, reason: string, unverified?: string): MapSpriteDto {
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
    ...(unverified ? { unverified } : {}),
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
    if (!res.ok) return placeholder(s, 'reason' in res ? res.reason : res.failure.kind, 'unverified' in res ? res.unverified : undefined) // prettier-ignore
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
    // The sprite's own CGRAM writes (WRAM upload list, palette mirror, direct), per sprite.
    const runtime = new Map<number, number>()
    for (const w of ('runtimePalette' in res && res.runtimePalette) || []) runtime.set(w.index, w.bgr555) // prettier-ignore
    res.parts.forEach((p, i) => {
      const note = res.paletteNote
      const row = (c: number): RgbaColor => {
        // Only the parts on the row the handler uploads to; another row keeps the level's colors.
        const spliced = note && p.palette === note.row && c >= note.firstCol ? dyn[c - note.firstCol] : undefined // prettier-ignore
        if (spliced) return spliced
        const set = runtime.get(p.palette * 16 + c)
        return set !== undefined ? bgr555ToRgba(set) : getPaletteColor(model, p.palette, c)
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
      ...('unverified' in res && res.unverified ? { unverified: res.unverified } : {}),
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
 * A 16 x 16 OBJ's char at cell (cx, cy): the PPU steps the column inside the
 * low nibble and the row inside the 256-char table, and leaves bit 8 (the
 * name table) alone, so `$1F` is `$1F, $10, $2F, $20` and `$F0` is
 * `$F0, $F1, $00, $01` (SNES OBJ name-table addressing, hardware behaviour;
 * not a ROM trace).
 */
const neighbour = (char: number, cx: number, cy: number): number =>
  (char & 0x100) | ((((char >> 4) + cy) & 0xf) << 4) | (((char & 0xf) + cx) & 0xf)

/**
 * The interpreter's `chosen` frame as drawable parts. A 16 x 16 OAM entry is
 * four 8 x 8 chars (tile, +1, +$10, +$11, wrapping as `neighbour` says: a
 * flip swaps which char sits where). Highest OAM index first, so the lower index (higher priority) is
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
        charNum: 0x400 + (p.size === 16 ? neighbour(p.char, cx, cy) : p.char),
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

/**
 * Camera that puts a level position on screen: centred, clamped to the scroll
 * range. The range is DERIVED from the level extents minus the 256 x 224 view,
 * not traced to the camera routine. The extents are the game's (a horizontal
 * level is LevelScrLength screens wide and $01B0 = 432 px tall, a vertical one
 * LevelScrLength screens tall), read off the collision routine's bounds
 * (CODE_00F44D, bank_00.asm:13293, 13299, 13326); the camera's own clamp was
 * not read, so this range is a derivation, not a trace.
 */
export function cameraFor(x: number, y: number, vertical: boolean, screens: number) {
  const [maxX, maxY] = vertical ? [256, screens * 256 - 224] : [screens * 256 - 256, 432 - 224]
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v))
  return { x: clamp(x - 128, maxX), y: clamp(y - 112, maxY) }
}

/** What the interpreter shows for one sprite: its model, as the drawer's reply. */
export function modelResult(m: RunModel): SpriteDrawResult {
  const generic = m.seedSource === 'generic'
  const u = generic ? { unverified: `level loader refused (${m.seedReason}); drawn from a placement-only seed` } : {} // prettier-ignore
  if (m.refusal) return { ok: false, reason: `refused: ${m.refusal}`, ...u }
  const pass = m.chosen === undefined ? undefined : m.passes[m.chosen]
  if (!m.anchor || !pass) return { ok: false, reason: m.emptyReason ?? 'drew no tile', ...u }
  return {
    ok: true,
    parts: interpParts(pass.parts),
    anchor: { x: m.anchor.x, y: m.anchor.y },
    runtimePalette: pass.palette,
    ...u,
    identity: { spriteId: m.id, mainHandler: 0, initHandler: 0, status: 'vanilla' },
  }
}

/**
 * The span of the level's sprite stream the game loads at level start, along one axis: read from
 * the ROM's start-load routine (CODE_02ACA1 horizontal, its vertical twin entered from CODE_02AC5C,
 * SMWDisX bank_02.asm:5837-5910), which backs the scroll position up by SBC #imm, calls
 * CODE_02A802 twice per column, steps 16 px, and runs while the column count is below CMP #imm.
 * Vanilla reads 96 and 32 (cross-checked in the test, never used as a default), so the window is
 * [camera - 96, camera + 416). Null when any gated byte is not the one expected: the caller
 * then places nothing (the old behaviour). Not read: DATA_02A7F6[1] (the offset added, 0 on vanilla).
 */
export function startLoadWindow(
  rom: RomFile,
  vertical: boolean,
): { back: number; columns: number } | null {
  const body = vertical ? 0x02ac61 : 0x02aca1
  if (vertical) {
    // LDA ScreenMode; LSR A; BCC CODE_02ACA1: the horizontal body is what a horizontal map runs.
    const head = rom.readAt(0x02ac5c, 5)
    if (!head || head[0] !== 0xa5 || head[2] !== 0x4a || head[3] !== 0x90 || 0x02ac5c + 5 + head[4]! !== 0x02aca1) return null // prettier-ignore
  }
  const b = rom.readAt(body, 54)
  if (!b) return null
  const [lo, hi] = vertical ? [0x1c, 0x1d] : [0x1a, 0x1b]
  // [offset, expected]; the wildcards (ScrollDir, ScreenMode's RAM and TileGenerateTrackB's address) are left out.
  const fixed: [number, number][] = [[0, 0xa5], [2, 0x48], [3, 0xa9], [4, 1], [5, 0x85], [7, 0xa5], [8, lo], [9, 0x48], [10, 0x38], [11, 0xe9], [13, 0x85], [14, lo], [15, 0xa5], [16, hi], [17, 0x48], [18, 0xe9], [19, 0], [20, 0x85], [21, hi], [22, 0x9c], [25, 0x20], [26, 0x02], [27, 0xa8], [28, 0x20], [29, 0x02], [30, 0xa8], [31, 0xa5], [32, lo], [33, 0x18], [34, 0x69], [35, 16], [36, 0x85], [37, lo], [38, 0xa5], [39, hi], [40, 0x69], [41, 0], [42, 0x85], [43, hi], [44, 0xee], [47, 0xad], [50, 0xc9], [52, 0x90], [53, 0xe3]] // prettier-ignore
  return fixed.every(([i, v]) => b[i] === v) ? { back: b[12]!, columns: b[51]! } : null
}

/**
 * The interpreter over this cart, for the level `index`: `levelSeed` runs the
 * ROM's own loader, Mario at the level's start, one sprite run alone per call.
 * When the loader refuses (a hack that moves its entry points) the model
 * reports `seedSource: 'generic'` with the loader's reason, and EVERY sprite
 * so run is answered with `unverified`: still drawn, never presented as run
 * from the level's own state. The runner decides; nothing here re-derives it.
 */
export function interpDrawer(
  rom: RomFile,
  index: number,
  model: { isVertical: boolean; screenCount: number },
  run: (rom: RomFile, id: number, seed: SpriteSeed) => RunModel = runOnce,
  seedFor: (rom: RomFile, index: number) => SpriteSeed = levelSeed,
): SpriteDrawer {
  // The loader runs once per map, not per sprite.
  const base = seedFor(rom, index)
  // Mario's start is what the ROM-run loader left in $94/$96 (the entrance it ran); the
  // table re-derivation is only for a generic seed, which has no loader image.
  const w = base.loaded
  const mario = w
    ? { x: w[0x94]! | (w[0x95]! << 8), y: w[0x96]! | (w[0x97]! << 8) }
    : readMarioStartPos(rom, index)
  // Layer 1 as the loader left it ($1A/$1C): where a screen-fixed part's OAM position is on the map.
  const loaderCam = w && { x: w[0x1a]! | (w[0x1b]! << 8), y: w[0x1c]! | (w[0x1d]! << 8) }
  // OAM + the loader's camera is what the game shows only for a sprite the start-load pass loads,
  // read from the ROM; the scroll axis decides (a horizontal map loads by column, a vertical by row).
  // Unreadable: nothing is placed.
  const axis = model.isVertical ? 'y' : 'x'
  const win = startLoadWindow(rom, model.isVertical)
  // Only the map's own shape is added to a generic seed; a loaded one ignores it.
  const shape = { level: { screenMode: model.isVertical ? 1 : 0, screens: model.screenCount } }
  return s => {
    const [x, y] = [pixelX(s), s.y * TILE]
    const camera = cameraFor(x, y, model.isVertical, model.screenCount)
    const seed = (camera: { x: number; y: number }, extra = {}) => withSeed({ sprite: { x, y }, camera, mario, ...shape, ...extra }, base) // prettier-ignore
    const m = run(rom, s.spriteId, seed(camera))
    const at = m.chosen
    if (!w || !loaderCam || !win || at === undefined || !m.anchor) return modelResult(m)
    // 16 px columns from the backed-up position; screens left of the map's start are skipped
    // (BMI), which a sprite at X or Y >= 0 never reaches, but they still count towards the 32.
    const first = (loaderCam[axis] - win.back) & ~15
    const here = { x, y }[axis]
    if (here < first || here >= first + win.columns * 16) return modelResult(m)
    // Probe: the camera moved 13 x 11 px (not a multiple of the 8 px tile pitch, so a neighbour
    // tile cannot alias) towards the sprite's screen centre, so it stays drawn; run only to the drawn pass.
    const shifted = { x: camera.x + (x - camera.x < 128 ? -13 : 13), y: camera.y + (y - camera.y < 112 ? -11 : 11) } // prettier-ignore
    const probe = run(rom, s.spriteId, seed(shifted, { mainPasses: at + 1 }))
    return modelResult(fixOffsets(m, probe, loaderCam, w) ?? m)
  }
}

/**
 * Parts whose OAM position is the same with the camera moved are screen-fixed
 * (the Side Exit's flame, CODE_02F4EB, SMWDisX bank_02.asm:15531-15576, writes
 * screen coordinates): their map position is OAM + the loader's camera, not
 * the sprite's offset, and is not wrapped to a byte. A part whose X and Y are
 * those the loader image already held at its (non-zero) OAM entry was not drawn
 * by this sprite (the level's own cluster sprites rewrite OAM 123-127 every frame) and
 * is left alone. Null when no part is screen-fixed.
 */
function fixOffsets(
  m: RunModel,
  probe: RunModel,
  cam: { x: number; y: number },
  loaded: Uint8Array,
): RunModel | null {
  // prettier-ignore
  const at = m.chosen
  const pass = at === undefined ? undefined : m.passes[at]
  const other = at === undefined ? undefined : probe.passes[at]
  if (!m.anchor || !pass || !other) return null
  const anchor = m.anchor
  // A zero entry is the loader's fill, not a drawn part: a genuine part at (0, 0) must move.
  const residue = (p: SpritePart) => {
    const e = loaded.subarray(RAM.oam + p.oam * 4, RAM.oam + p.oam * 4 + 4)
    return e.some(v => v) && e[0] === (p.ox & 0xff) && e[1] === p.oy
  }
  const same = (p: SpritePart) => !residue(p) && other.parts.some(q => q.oam === p.oam && q.ox === p.ox && q.oy === p.oy) // prettier-ignore
  if (!pass.parts.some(same)) return null
  // X is 9 bits (bit 8 is the sign); OAM Y $E0-$FF is above the screen's top edge.
  const parts = pass.parts.map(p =>
    same(p)
      ? { ...p, dx: (p.ox > 255 ? p.ox - 512 : p.ox) + cam.x - anchor.x, dy: (p.oy >= 0xe0 ? p.oy - 256 : p.oy) + cam.y - anchor.y } // prettier-ignore
      : p,
  )
  return { ...m, passes: m.passes.map((q, i) => (i === at ? { ...q, parts } : q)) }
}

/** A sprite stream's bytes: up to the window, fewer when the ROM ends first (as SmwRom.getLevelRawData reads). */
export const readStream = (rom: RomFile, ptr: number, window = STREAM_WINDOW) =>
  rom.readUpTo(ptr, window)

/** The stream's own terminator ($FF in a first-byte slot) within the bytes read. */
const terminated = (data: Uint8Array) => {
  for (let p = 1; p < data.length; p += 3) if (data[p] === 0xff) return true
  return false
}

/** The map-level line for sprites drawn without the ROM-run level state: they are shown, flagged. */
const unverifiedNote = (sprites: readonly MapSpriteDto[]) => {
  const u = sprites.find(s => s.unverified)?.unverified
  return u ? `Unverified: ${sprites.filter(s => s.unverified).length} sprites ${u}.` : undefined
}

/** The reply for a stream: its sprites drawn, in the geometry of the map's screens. */
export function spriteLayer(
  data: Uint8Array,
  model: SpriteModel & { isVertical: boolean; screenCount: number },
  draw: SpriteDrawer,
  dynamic?: (note: PaletteNote) => RgbaColor[],
): Extract<MapSpritesResult, { status: 'ok' }> {
  const { w, h } = screenTiles(model.isVertical)
  const sprites = drawSprites(parseLevelSprites(data, model.isVertical), model, draw, dynamic)
  return {
    status: 'ok',
    orientation: model.isVertical ? 'vertical' : 'horizontal',
    screenCount: model.screenCount,
    width: w * TILE,
    height: h * TILE,
    sprites,
    note:
      [
        terminated(data)
          ? undefined
          : 'The sprite stream has no end marker in the bytes read: sprites past them are not drawn.',
        unverifiedNote(sprites),
      ]
        .filter(Boolean)
        .join(' ') || undefined,
  }
}

/**
 * Replies per working-copy bytes and map: running every sprite's INIT and 64
 * passes takes a moment, and the working copy hands out new bytes after each
 * edit, so nothing here needs invalidating.
 */
/** Replies kept per working-copy bytes: each holds every sprite's bitmap, so a whole ROM's maps are not. */
const REPLIES_PER_BYTES = 8
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
  if (r) {
    // LRU: a hit moves the map to the newest end.
    byMap.delete(index)
    byMap.set(index, r)
  } else {
    r = compute(cache, bytes, romPath, index)
    // Only a computed answer is kept; an unavailable one may be a loader hiccup worth retrying.
    if (r.status === 'ok') {
      // The least recently used reply goes first (L1ModelCache, map-screen.ts:387, drops the oldest inserted).
      if (byMap.size >= REPLIES_PER_BYTES) byMap.delete(byMap.keys().next().value!)
      byMap.set(index, r)
    }
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
    const dynamic = (n: PaletteNote) => {
      const b = rom.rom.readAt(n.entryAddr, n.colors * 2)
      return b ? Array.from({ length: n.colors }, (_, i) => bgr555ToRgba(b[i * 2]! | (b[i * 2 + 1]! << 8))) : [] // prettier-ignore
    }
    return spriteLayer(data, model, draw, dynamic)
  } catch (err) {
    return { status: 'unavailable', reason: (err as Error).message }
  }
}
