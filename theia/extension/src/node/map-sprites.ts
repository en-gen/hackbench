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
 * own MAIN from the ROM on the 65816 core (src/rom/sprites/interp/)
 * and draws the first pass that puts a tile in OAM, at the PLACED spot. INIT
 * runs for the PICTURE only (D139 D, D138 A: tiles, flips, variants, status);
 * its moves are not shown (D134, D91), so a Piranha Plant's +8 / -1 (InitPiranha,
 * SMWDisX bank_01.asm:880-889) waits for play/simulate. The table engine (`engineDrawer`) stays
 * as the comparison oracle of step 3 and goes in step 4. Seeds are generic:
 * the ROM-run level loader's WRAM, Mario at the level's start, the camera
 * placed so the sprite is on screen. The colors the sprite's own code wrote to
 * CGRAM (NMI upload list, palette mirror, direct registers;
 * `Machine.paletteWrites`) override the level's row for that sprite only.
 * Each sprite is run alone, except one whose own code scans the slot tables
 * for a companion ($9C looks for a $9B): it is run a second time with the
 * map's neighboring sprites in the other slots, because the picture it draws
 * includes that companion (#841). Not modelled: any other reaction to a
 * neighbor, and the player's actions: a sprite shows its first pose.
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
import { DOOR_PART_BIT } from '../../../../src/rom/model/ColorMath'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { parseLevelSprites } from '../../../../src/rom/LevelParser'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import { getCharPixels, type VramState } from '../../../../src/rom/GfxLoader'
import {
  charsFromUploads,
  readMarioGraphics,
  uploadProbe,
  type MarioBuffer,
  type SlotUpload,
} from '../../../../src/rom/MarioGraphics'
import { bgr555ToRgba, type RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { getPaletteColor } from '../../../../src/rom/PaletteLoader'
import { readMarioStartPos } from '../../../../src/rom/MarioStartPos'
import {
  runOnce,
  type RunOptions,
  RAM,
  drawnParts,
  type SpriteModel as BaseModel,
  type PaletteWrite,
  type SpritePart,
} from '../../../../src/rom/sprites/interp/SpriteRunner'
import { isRopeId, ropeModel, type RopeAt } from '../../../../src/rom/sprites/interp/RopeLength'
import {
  drawnPass,
  findReveal,
  type RevealCondition,
} from '../../../../src/rom/sprites/interp/RevealSearch'
import {
  castleFlames,
  VANILLA_FLAME_ROUTINES,
  type FlameRoutines,
} from '../../../../src/rom/sprites/interp/CastleFlames'
import { levelSeed } from '../../../../src/rom/sprites/interp/LevelLoader'
import {
  EXTRA_BITS,
  hasExtraBitNeighbour,
  NEIGHBOUR_EXTRA_BIT_REASON,
  neighboursOf,
} from '../../../../src/rom/sprites/interp/Neighbours'
import { undrawnNote, type UndrawnChildren } from '../../../../src/rom/sprites/interp/SpawnedChildren' // prettier-ignore
import {
  EERIES_COUNT,
  fiveEeries,
  VANILLA_EERIES_ROUTINES,
  type EeriesRoutines,
} from '../../../../src/rom/sprites/interp/FiveEeries'
import {
  rotatingRing,
  VANILLA_RING_ROUTINES,
  type RingRoutines,
} from '../../../../src/rom/sprites/interp/RotatingRing'
import {
  TORPEDO_LAUNCHER_ID,
  torpedoLauncher,
} from '../../../../src/rom/sprites/interp/TorpedoLauncher'
import {
  PLATFORM_COUNT,
  threePlatforms,
  VANILLA_PLATFORM_ROUTINES,
  type PlatformRoutines,
} from '../../../../src/rom/sprites/interp/ThreePlatforms'
import { withSeed, type SpriteSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { getSpriteMetadata } from '../../../../src/rom/model/sprites/SpriteMetadata'
import { readSpriteTileTables } from '../../../../src/rom/SpriteTileLoader'
import {
  drawSpriteParts,
  findDescriptor,
  resolveIdentity,
  type EnginePart,
  type EngineResult,
  type PaletteNote,
} from '../../../../src/rom/model/sprites/generic/SpriteDrawEngine'
import type {
  MapSpriteDto,
  MapSpritesResult,
  SpriteFramesResult,
  SwitchFlagsDto,
} from '../common/project-protocol'
import { RIDES_WITH_REASON } from '../common/project-protocol'
import { screenTiles, unreadable, type L1ModelCache } from './map-screen'

const TILE = 16
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
  /**
   * The player graphics buffer, read when a drawn sprite pointed Mario's tile DMA at it (#980; the Podoboo's
   * chars). Called only then. Absent: such a sprite is drawn from the map's own chars, marked unverified.
   */
  playerGraphics?: () => MarioBuffer
}

/**
 * What a drawer answers for one sprite: the table engine's result, or the
 * interpreter's. `anchor` is where the sprite stands (the placed spot at rest, after INIT
 * when it ran; the parts' dx/dy are relative to it); absent, the stream position is the anchor.
 * `reason` is a refusal in the interpreter's own words.
 */
export type SpriteDrawResult =
  | (Omit<Extract<EngineResult, { ok: true }>, 'parts'> & {
      parts: DrawPart[]
      anchor?: { x: number; y: number }
      /** Where the level stores the sprite, when the picture is drawn elsewhere (INIT shifts it before its first frame, R16). */
      stored?: { x: number; y: number }
      /** With `stored`: where the sprite's start-up code left it, before its first step. */
      afterInit?: { x: number; y: number }
      /** With `stored`: how the sprite got onto its line from where start-up left it (its first steps, or a fall). */
      onLine?: 'step' | 'fell'
      /** The list spot the DTO reports (hover, selection, drag) when the picture stands elsewhere: the game lays it out itself (D158 / Decision 124, InitLatches.ts). */
      listPos?: { x: number; y: number }
      /** The condition that made this hidden sprite draw (RevealSearch.ts): drawn whole in the screen door, with a tooltip. */
      reveal?: RevealCondition
      /** CGRAM colors the sprite's own code set by its drawn frame (interpreter only). */
      runtimePalette?: PaletteWrite[]
      /** The player-buffer slots the drawn frame's run pointed Mario's tile DMA at (interpreter only; #980). */
      uploads?: SlotUpload[]
      /** Set when the run's seed is not the ROM-run level state: why the art is unverified. */
      unverified?: string
      /** The list sprites this sprite's own code drew (a neighbor run, #1049), each with the parts drawn for it. */
      children?: { index: number; parts: DrawPart[] }[]
      /** A plain-words line about what the map shows of this sprite (not a flaw): it goes on the map's note line. */
      note?: string
      /** The undrawn spawned children behind `note`, as data (#1281). */
      undrawn?: UndrawnChildren
      /** The interpreter detail behind a plain note, for its tooltip. */
      noteDetail?: string
    })
  | Extract<EngineResult, { ok: false }>
  | { ok: false; reason: string; unverified?: string }

/** A part with its OAM priority (attribute bits 5:4); the table engine's parts have none and draw at 2. */
export type DrawPart = EnginePart & { priority?: number; door?: boolean }

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

/** The part's pixels into `out` and its priority into `prio` (bitmap origin `ox, oy`), color index 0 left clear. */
function blit(
  out: Uint8ClampedArray,
  prio: Uint8Array,
  width: number,
  p: DrawPart,
  at: [number, number],
  pixels: Uint8Array,
  row: (c: number) => RgbaColor,
): void {
  for (let ty = 0; ty < 8; ty++) {
    for (let tx = 0; tx < 8; tx++) {
      const v = pixels[(p.flipY ? 7 - ty : ty) * 8 + (p.flipX ? 7 - tx : tx)]!
      if (v === 0) continue
      const at1 = (at[1] + ty) * width + at[0] + tx
      out.set(row(v), at1 * 4)
      prio[at1] = (p.priority ?? 2) | (p.door ? DOOR_PART_BIT : 0)
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
  /** One sprite's bitmap from a drawer result: its parts blitted at the anchor, or the marker when it cannot be drawn. */
  const render = (s: LevelSprite, res: SpriteDrawResult): MapSpriteDto => {
    if (!res.ok) return placeholder(s, 'reason' in res ? res.reason : res.failure.kind, 'unverified' in res ? res.unverified : undefined) // prettier-ignore
    // A marker says what the drawn sprite would have: the note reaches the map's note line either way.
    const told = {
      ...('note' in res && res.note ? { note: res.note } : {}),
      ...('noteDetail' in res && res.noteDetail ? { noteDetail: res.noteDetail } : {}),
      ...('undrawn' in res && res.undrawn ? { undrawn: res.undrawn } : {}),
    }
    if (res.parts.length === 0) return { ...placeholder(s, 'noParts'), ...told }
    let unverified = 'unverified' in res ? res.unverified : undefined
    let upload: Map<number, Uint8Array> | undefined
    if ('uploads' in res && res.uploads?.length) {
      const d = charsFromUploads(model.playerGraphics?.() ?? { ok: false, reason: 'no player graphics buffer was given' }, res.uploads) // prettier-ignore
      if (d.ok) upload = d.chars
      // D51/D57: a ROM whose buffer cannot be read keeps today's art, with the reason said.
      else {
        const why = `its chars come from the player graphics buffer, which is not read here (${d.reason}); drawn from the map's loaded sprite graphics instead` // prettier-ignore
        unverified = unverified ? `${unverified}; ${why}` : why
      }
    }
    const art = res.parts.map(p => upload?.get(p.charNum) ?? getCharPixels(model.vram, p.charNum)) // prettier-ignore
    // A missing char would draw as a hole: draw the pieces that have art (the sprite's own and its companions alike),
    // say how many do not, and keep the marker only when none does. `parts` and `pixels` stay index-aligned.
    const parts = res.parts.filter((_, i) => art[i])
    const pixels = art.filter(a => a)
    if (parts.length === 0) return { ...placeholder(s, 'charsNotLoaded'), ...told }
    if (parts.length < res.parts.length) {
      const why = `${res.parts.length - parts.length} of ${res.parts.length} pieces are not drawn: their graphics are not in this map's loaded sprite graphics` // prettier-ignore
      unverified = unverified ? `${unverified}; ${why}` : why
    }
    const [ax, ay] = 'anchor' in res && res.anchor ? [res.anchor.x, res.anchor.y] : [pixelX(s), s.y * TILE] // prettier-ignore
    const box = {
      x0: ax + Math.min(...parts.map(p => p.dx)),
      y0: ay + Math.min(...parts.map(p => p.dy)),
      x1: ax + Math.max(...parts.map(p => p.dx)) + 8,
      y1: ay + Math.max(...parts.map(p => p.dy)) + 8,
    }
    const width = box.x1 - box.x0
    const out = new Uint8ClampedArray(width * (box.y1 - box.y0) * 4)
    // The PPU keeps the opaque pixel of the OAM entry first in its rotation and only then compares
    // ITS priority with the BG (hardware, not a ROM trace), so a pixel's priority is the part that
    // wins it. SMW starts the rotation at OAMAddress (bank_00.asm:563-566): 0 (:779), so the lowest
    // index wins, except in Roy, Morton and Ludwig's rooms, where slot 100 does (:2775-2776; not modelled).
    const prio = new Uint8Array(width * (box.y1 - box.y0)).fill(2)
    const dyn = res.paletteNote ? dynamic(res.paletteNote) : []
    // The sprite's own CGRAM writes (WRAM upload list, palette mirror, direct), per sprite.
    const runtime = new Map<number, number>()
    for (const w of ('runtimePalette' in res && res.runtimePalette) || []) runtime.set(w.index, w.bgr555) // prettier-ignore
    parts.forEach((p, i) => {
      const note = res.paletteNote
      const row = (c: number): RgbaColor => {
        // Only the parts on the row the handler uploads to; another row keeps the level's colors.
        const spliced = note && p.palette === note.row && c >= note.firstCol ? dyn[c - note.firstCol] : undefined // prettier-ignore
        if (spliced) return spliced
        const set = runtime.get(p.palette * 16 + c)
        return set !== undefined ? bgr555ToRgba(set) : getPaletteColor(model, p.palette, c)
      }
      blit(out, prio, width, p, [ax + p.dx - box.x0, ay + p.dy - box.y0], pixels[i]!, row)
    })
    const at = ('listPos' in res && res.listPos) || { x: ax, y: ay }
    return {
      index: s.index,
      id: s.spriteId,
      x: at.x,
      y: at.y,
      box,
      rgba: base64(out),
      ...('stored' in res && res.stored ? { stored: res.stored } : {}),
      ...('afterInit' in res && res.afterInit ? { afterInit: res.afterInit } : {}),
      ...('onLine' in res && res.onLine ? { onLine: res.onLine } : {}),
      parts: parts.map(p => ({ char: p.charNum, palette: p.palette, flipX: p.flipX, flipY: p.flipY, dx: p.dx, dy: p.dy })), // prettier-ignore
      priority: base64(new Uint8ClampedArray(prio.buffer)),
      status: 'drawn',
      ...(unverified ? { unverified } : {}),
      ...told,
      ...('reveal' in res && res.reveal
        ? { screenDoor: true, reveal: revealText(res.reveal) }
        : {}),
    }
  }
  // Sprites a parent drew (the $9B a $9C picks up, #1049) are part of the parent's picture, not unexplained.
  const claimed = new Map<number, { parent: number; res: SpriteDrawResult; parts: DrawPart[] }>()
  const dtos = sprites.map((s): MapSpriteDto => {
    // Fail closed: a possibly custom sprite is never given vanilla art.
    if ((s.raw[0] ?? 0) & EXTRA_BITS) return placeholder(s, 'extraBits')
    const res = draw(s)
    if (res.ok) for (const c of res.children ?? []) claimed.set(c.index, { parent: s.index, res, parts: c.parts }) // prettier-ignore
    return render(s, res)
  })
  // Such a sprite (a placeholder, for whatever reason it drew nothing alone) stays in the list (D52: it can be selected and dragged) with the
  // tiles the parent drew for it as its area and no marker. The view hit-tests it and does not paint it again.
  return dtos.map((d, n) => {
    const c = claimed.get(d.index)
    if (!c || d.status !== 'placeholder' || d.reason === 'extraBits') return d
    const own = render(sprites[n]!, { ...c.res, parts: c.parts } as SpriteDrawResult)
    return own.status === 'drawn' ? { ...own, x: d.x, y: d.y, drawnBy: c.parent } : d
  })
}

const NO_IMAGE_NOTE =
  'The rope is shown at its short length: the level loader could not be run on this ROM.'

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
 * flip swaps which char sits where). Highest OAM index first, so the lower index (in front of the other OBJs) is
 * blitted last and wins an overlap. `char` is the 9-bit OBJ char; hackbench
 * numbers OBJ chars from $400.
 */
export function interpParts(parts: readonly SpritePart[]): DrawPart[] {
  const out: DrawPart[] = []
  for (const p of [...parts].sort((a, b) => b.oam - a.oam)) {
    const cells = p.size === 16 ? ([[0, 0], [1, 0], [0, 1], [1, 1]] as const) : ([[0, 0]] as const) // prettier-ignore
    for (const [cx, cy] of cells) {
      const [col, row] = [p.flipX ? 1 - cx : cx, p.flipY ? 1 - cy : cy]
      out.push({
        charNum: 0x400 + (p.size === 16 ? neighbour(p.char, cx, cy) : p.char),
        palette: p.palette,
        priority: p.priority,
        door: p.door,
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

/** A run that also kept, per pass, the player-buffer slots the sprite pointed at (`runWithUploads`). */
export type RunModel = BaseModel & { uploads?: SlotUpload[][] }

/**
 * `runOnce`, plus the DynGfxTilePtr slots a sprite that uploads from the player buffer wrote (#980), from the
 * run the model came from.
 */
export function runWithUploads(
  rom: RomFile,
  id: number,
  seed: SpriteSeed,
  opts: Pick<RunOptions, 'stopAtDraw' | 'trackInputs'> = {},
): RunModel {
  const [alone, rerun] = [uploadProbe(), uploadProbe()]
  const m = runOnce(rom, id, seed, {
    atRest: true,
    probe: alone.probe,
    neighbourProbe: rerun.probe,
    ...opts,
  })
  // Only an adopted rerun is the picture, so only then are its uploads the model's (#1169).
  return Object.assign(m, { uploads: m.neighbourRun === 'adopted' ? rerun.byPass : alone.byPass })
}

/** The marker's reason code when the search found no condition that draws the sprite (`WHY_NOT_DRAWN`). */
export const UNREVEALED = 'unrevealed'

/** Mario's fixed state in every reveal probe, said in the tooltip (RevealSearch.ts MARIO_STATE). */
const MARIO_SAID = 'small Mario, on foot'

/** The tooltip line for each condition. Keyed by the condition the search found, never by a sprite id. */
export const REVEAL_TEXT: Record<RevealCondition, string> = {
  'mario-at-sprite': 'appears when Mario gets close to this spot',
  'mario-left': 'appears when Mario is just left of this spot',
  'mario-right': 'appears when Mario is just right of this spot',
  'more-frames': 'appears after a while',
  'p-switch': 'appears while a P-switch is active',
  'on-off': 'appears when the ON/OFF switch is flipped',
  'none-found': 'is not always there, and the app could not tell what hides it',
}
const revealText = (c: RevealCondition) => c === 'none-found' ? REVEAL_TEXT[c] : `${REVEAL_TEXT[c]} (${MARIO_SAID})` // prettier-ignore

/**
 * Fewest quiet passes at the end of a run before its colors count as settled. A vanilla fade writes a rung every
 * 4 passes (SMWDisX bank_01.asm:8715-8722); vanilla map $11C goes quiet at pass 30 of 63 (one machine).
 */
const SETTLE_TAIL = 16

/** The colors CGRAM holds after pass `p`: the run's writes are cumulative and the last one to a color wins. */
const netColors = (m: RunModel, p: number) => new Map(m.passes[p]!.palette.map(w => [w.index, w.bgr555] as const)) // prettier-ignore
/** True when two net color maps hold the same color at every index. */
const sameColors = (a: Map<number, number>, b: Map<number, number>) => a.size === b.size && [...a].every(([i, v]) => b.get(i) === v) // prettier-ignore

/**
 * The CGRAM colors a picture is drawn with (#1097). The chosen pass is a pose policy: the Magikoopa's first drawn
 * frame comes before any upload (bank_01.asm:8474, 8733-8755), so its writes left the level's row showing. CGRAM
 * keeps what the run wrote, drawn or not, so use the net writes at the last pass. Marked when they may be wrong:
 * not settled (the quiet span since the last change, scanning from pass 1, is under SETTLE_TAIL or no
 * longer than the longest gap between earlier changes); first drawn inside the tail; or it left and the colors
 * changed while away or differ from before it left or from its first picture. One change gives no gap to
 * compare, so a lone update is marked too (vanilla: 0 such sprites or frames). Docs: sprite-1f-magikoopa.md s5.
 */
function runtimeColors(m: RunModel): { writes: PaletteWrite[]; why?: string } {
  const last = m.passes.length - 1
  const net = netColors(m, last)
  const writes = [...net].map(([index, bgr555]) => ({ index, bgr555 }))
  // Guards the loops below and keeps hand-built models of a few passes from being marked; no production run is that short.
  if (last < SETTLE_TAIL) return { writes }
  const end = 'so its colors may differ in the game'
  const first = m.passes.findIndex(p => drawnParts(p).length > 0)
  if (first >= last - SETTLE_TAIL)
    return { writes, why: `it only appeared when the check ended, ${end}` }
  const changed = (p: number) => !sameColors(netColors(m, p), netColors(m, p - 1))
  const events: number[] = []
  for (let p = 1; p <= last; p++) if (changed(p)) events.push(p)
  const quiet = last - (events[events.length - 1] ?? first)
  const gap = Math.max(0, ...events.slice(1).map((e, i) => e - events[i]!))
  if (events.length === 1) return { writes, why: `its colors changed only once, ${end}` }
  if (quiet < SETTLE_TAIL || quiet <= gap)
    return { writes, why: `its colors were still changing when the check ended, ${end}` }
  const away = m.passes.map((_, p) => p).filter(p => p > first && !drawnParts(m.passes[p]!).length)
  if (
    away.length &&
    (away.some(changed) ||
      [first, ...away.filter(p => drawnParts(m.passes[p - 1]!).length).map(p => p - 1)].some(
        p => !sameColors(net, netColors(m, p)),
      ))
  )
    return { writes, why: `it disappeared partway through and its colors changed, ${end}` }
  return { writes }
}

const UNCHECKED_LOADER = "HackBench could not check whether this sprite appears in play (the map's sprite loader is not the stock one)" // prettier-ignore

/** Reasons a picture is unverified, joined as `unverifiedOf` joins them, each once. */
export const joinReasons = (...r: (string | undefined)[]): string | undefined =>
  [...new Set(r.flatMap(x => x?.split('; ') ?? []).filter(Boolean))].join('; ') || undefined

function unverifiedOf(m: RunModel, generic: string | undefined): { unverified?: string } {
  const why = [
    generic,
    (m.shifted || m.neverAppears) && m.lineInitReason,
    m.initMoved &&
      m.lineGateReason &&
      `drawn on its map tile although its start-up code moves it: ${m.lineGateReason}`,
    m.spawnUnchecked && UNCHECKED_LOADER,
    m.noLineReason,
  ].filter(Boolean)
  return why.length ? { unverified: why.join('; ') } : {}
}

/** What the interpreter shows for one sprite: its model, as the drawer's reply. */
export function modelResult(m: RunModel): SpriteDrawResult {
  const generic = m.seedSource === 'generic'
  const why = [...(generic ? [`level loader refused (${m.seedReason}); drawn from a placement-only seed`] : []), ...(m.unverifiedReason ? [m.unverifiedReason] : [])] // prettier-ignore
  if (m.refusal) return { ok: false, reason: `refused: ${m.refusal}`, ...(why.length ? { unverified: why.join('; ') } : {}) } // prettier-ignore
  const pass = m.chosen === undefined ? undefined : m.passes[m.chosen]
  const colors = pass ? runtimeColors(m) : undefined
  if (colors?.why) why.push(colors.why)
  const u = why.length ? { unverified: why.join('; ') } : {}
  if (!pass) return { ok: false, reason: m.emptyReason ?? 'drew no tile', ...u }
  const uploads = m.chosen === undefined ? undefined : m.uploads?.[m.chosen]
  if (!m.anchor) return { ok: false, reason: m.emptyReason ?? 'drew no tile', ...u }
  // The at-rest picture of a sprite whose INIT shifts it is drawn where INIT left it; its list position is the stored tile.
  const stored = m.shifted
    ? { stored: { x: m.anchor.rawX, y: m.anchor.rawY }, afterInit: m.initAt }
    : {}
  return {
    ok: true,
    parts: interpParts(drawnParts(pass)),
    anchor: { x: m.anchor.x, y: m.anchor.y },
    ...(m.reveal ? { reveal: m.reveal } : {}),
    ...stored,
    // The two notes are separate sentences; either alone is unchanged.
    ...(m.neverAppears || m.lengthNote ? { note: [m.neverAppears && 'never appears in play', m.lengthNote].filter(Boolean).join('. ') } : {}), // prettier-ignore
    ...(m.shifted && m.onLine ? { onLine: m.onLine } : {}),
    ...(m.absolutePlacement
      ? {
          listPos: { x: m.anchor.rawX, y: m.anchor.rawY },
          note: 'The game lays this sprite out itself, at fixed spots of the map; it does not follow where the list places it.',
        }
      : {}),
    runtimePalette: colors!.writes,
    ...(pass.drew
      ? { children: pass.drew.children.map(c => ({ index: c.index, parts: interpParts(pass.parts.filter(p => c.oam.includes(p.oam))) })) } // prettier-ignore
      : {}),
    ...(uploads?.length ? { uploads } : {}),
    ...u,
    // Every reason the picture is not fully checked stands: the generic seed, a patched INIT that moved the sprite, a refused gate
    // that left it on its tile, a loader that could not be read, a line it never reached.
    ...unverifiedOf(m, u.unverified),
    identity: { spriteId: m.id, mainHandler: 0, initHandler: 0, status: 'vanilla' },
  }
}

/** The launcher's `unverified` text: its reasons joined as-is, each already a full statement (a repointed arm, a spawn other than $44, a changed routine). */
export function launcherUnverified(reasons: readonly string[]): string | undefined {
  return reasons.length ? `Torpedo launcher unverified: ${reasons.join('; ')}` : undefined // prettier-ignore
}

/**
 * Sprite $CA (#985), a shooter: the frame at launch. The ROM's own LaunchTorpedo and LauncherArm run
 * and the game's sprite loop on the slot it spawned (TorpedoLauncher.ts) give the arm's and the spawned
 * Torpedo Ted's OAM entries in one machine, so the torpedo keeps the direction and launch timer the shooter
 * wrote into its slot (a fresh run of sprite $44 would lose them). One bitmap, anchored at the shooter, so the
 * hover and the selection box are the launcher's. Any refusal is the marker (D52), with its reason.
 */
function launcherResult(rom: RomFile, seed: SpriteSeed): SpriteDrawResult {
  const l = torpedoLauncher(rom, seed)
  if (!l.ok) return { ok: false, reason: l.reason }
  const unverified = launcherUnverified(l.unverified)
  return {
    ok: true,
    parts: interpParts([...l.torpedoParts, ...l.arm]),
    anchor: { x: seed.sprite.x, y: seed.sprite.y },
    ...(unverified ? { unverified } : {}),
    identity: { spriteId: l.torpedoId, mainHandler: 0, initHandler: 0, status: 'vanilla' },
  }
}

/** Why a replay in the loader's top slot may differ when an earlier sprite of the list was loaded first (bank_02.asm:5400-5405: the search goes down from the top). */
export const EARLIER_SPRITE_REASON =
  'an earlier sprite in the list may have taken the slot the game puts this one in, so one block can differ by a pixel and in its item'

/** True when a list entry before `s` was loaded at level start (SpriteLoadStatus set), so it may hold a slot the search would have used. */
export function earlierSpriteLoaded(
  list: readonly LevelSprite[],
  s: LevelSprite,
  loadStatus: (index: number) => number,
): boolean {
  return list.some(
    e => e.index < s.index && e.index >= 0 && e.index < 128 && loadStatus(e.index) !== 0,
  )
}

/** SpriteLoadStatus, SMWDisX rammap.asm:1968 (SMW_U.sym 00001938): one byte per sprite list entry, 128 of them. */
const SPRITE_LOAD_STATUS = 0x1938

/** Sprite $DE: a loader command that spawns five Wave Eeries (CODE_02A88C, SMWDisX bank_02.asm:5312-5318). */
const FIVE_EERIES = 0xde

/**
 * The five Eeries of a stream entry (#1015), run from the ROM's own spawner: ONE sprite at its real stream index
 * (so hover and selection find it), the five Eeries as its parts. In a vertical map the loader hands the spawner the
 * scroll-axis boundary, the entry's Y, as its X (bank_02.asm:5232-5238); the spawner is run on that input and the result
 * is flagged `unverified`, because no vanilla map places a $DE there (D52: drawn, not blanked). A spawner that is not
 * the hashed one is flagged the same way. A loader route the reader cannot place, or nothing drawn, is a marker with the reason.
 */
function eeriesResult(
  rom: RomFile,
  seed: SpriteSeed,
  s: LevelSprite,
  vertical: boolean,
  routines: EeriesRoutines,
): SpriteDrawResult {
  // The spawner reads its data byte through SpriteDataPtr, which only the ROM-run loader's image sets.
  if (!seed.loaded) return { ok: false, reason: `the five Eeries need the level loader's image: ${seed.loadRefusal ?? 'no level image was given'}` } // prettier-ignore
  const [x, y] = [pixelX(s), s.y * TILE]
  const input = vertical ? y : x
  const r = fiveEeries(rom, seed, { x: input, y, at: { x, y }, index: s.index, streamOffset: s.streamOffset }, routines) // prettier-ignore
  // The slot-range reason is true only while the spawner is the game's own; a changed one may spawn fewer for its own reasons.
  const gameOwn = r.unverified.length === 0
  if (!r.ok) {
    const none = `None of the ${EERIES_COUNT} Eeries appear`
    return { ok: false, reason: r.none ? (gameOwn ? `${none}: this map's sprite memory setting leaves no room.` : `${none}.`) : `refused: ${r.reason}` } // prettier-ignore
  }
  const why = [
    ...r.unverified.map(u => `${u} is not the vanilla shape`),
    ...(vertical ? ["in a vertical map the spawner is given the entry's Y as its X (the loader's boundary), derived from the loader and not checked: no vanilla map places one"] : []), // prettier-ignore
  ].join('; ')
  // What spawned and did not draw is a shortfall to tell, not a flaw of the routine: it goes in the note, not `unverified`.
  const notes = [
    ...(r.spawned < EERIES_COUNT ? [`Only ${r.spawned} of the ${EERIES_COUNT} Eeries appear${gameOwn ? `: this map's sprite memory setting leaves room for ${r.spawned}.` : '.'}`] : []), // prettier-ignore
    ...r.notes,
  ]
  return {
    ok: true,
    parts: interpParts(r.parts),
    anchor: { x, y },
    identity: { spriteId: s.spriteId, mainHandler: 0, initHandler: 0, status: 'vanilla' },
    // Fewer than five is the game's answer for this map's slot range, not a flaw: said in plain words, not `unverified`.
    ...(notes.length ? { note: notes.join(' ') } : {}),
    ...(r.undrawn ? { undrawn: r.undrawn } : {}),
    ...(r.noteDetail ? { noteDetail: r.noteDetail } : {}),
    ...(why
      ? { unverified: `the five Eeries are drawn from the spawner the loader calls, and ${why}` }
      : {}),
  }
}

/** Sprite $E0: a loader command that spawns three Grey Platforms on Chain ($A3) (CODE_02A89C, SMWDisX bank_02.asm:5325-5331). */
const THREE_PLATFORMS = 0xe0

/**
 * The three platforms of a stream entry (the $E0 issue), run from the ROM's own spawner and their INIT: ONE sprite at its
 * real stream index, the platforms and their chains as its parts. A vertical map is drawn flagged `unverified`, as for $DE (the loader hands
 * the spawner the Y boundary as X there; D52: drawn, not blanked). A changed routine does not blank it (D52): drawn, flagged `unverified`.
 */
function platformsResult(
  rom: RomFile,
  seed: SpriteSeed,
  s: LevelSprite,
  vertical: boolean,
  routines: PlatformRoutines,
): SpriteDrawResult {
  // The spawner reads its data byte through SpriteDataPtr, which only the ROM-run loader's image sets.
  if (!seed.loaded) return { ok: false, reason: `the three platforms need the level loader's image: ${seed.loadRefusal ?? 'no level image was given'}` } // prettier-ignore
  const [x, y] = [pixelX(s), s.y * TILE]
  // A vertical map hands the spawner the entry's Y boundary as its X (bank_02.asm:5232-5238), as for the Eeries.
  const r = threePlatforms(rom, seed, { x: vertical ? y : x, y, at: { x, y }, index: s.index, streamOffset: s.streamOffset }, routines) // prettier-ignore
  const gameOwn = r.unverified.length === 0
  if (!r.ok) {
    const none = `None of the ${PLATFORM_COUNT} platforms appear`
    return { ok: false, reason: r.none ? (gameOwn ? `${none}: this map's sprite memory setting leaves no room.` : `${none}.`) : `refused: ${r.reason}` } // prettier-ignore
  }
  const why = [
    ...r.unverified.map(
      u =>
        `${u} is not the vanilla shape${u === 'the platform spawner' ? ', so where its platforms sit and their per-platform values are taken from that edited code and not checked' : ''}`,
    ),
    ...(vertical ? ["in a vertical map the spawner is given the entry's Y as its X (the loader's boundary), derived from the loader and not checked: no vanilla map places one"] : []), // prettier-ignore
  ].join('; ')
  // What spawned and did not draw, or came out short, is a shortfall to tell, not a flaw of the routine: the note, not `unverified`.
  const notes = [
    ...(r.spawned < PLATFORM_COUNT ? [`Only ${r.spawned} of the ${PLATFORM_COUNT} platforms appear${gameOwn ? `: this map's sprite memory setting leaves room for ${r.spawned}.` : '.'}`] : []), // prettier-ignore
    ...(r.spawned > PLATFORM_COUNT ? [`The spawner made ${r.spawned} platforms, more than the ${PLATFORM_COUNT} the game makes.`] : []), // prettier-ignore
    ...r.notes,
  ]
  return {
    ok: true,
    parts: interpParts(r.parts),
    anchor: { x, y },
    identity: { spriteId: s.spriteId, mainHandler: 0, initHandler: 0, status: 'vanilla' },
    ...(notes.length ? { note: notes.join(' ') } : {}),
    ...(r.undrawn ? { undrawn: r.undrawn } : {}),
    ...(r.noteDetail ? { noteDetail: r.noteDetail } : {}),
    ...(why
      ? {
          unverified: `the three platforms are drawn from the spawner the loader calls, and ${why}`,
        }
      : {}),
  }
}

/** Sprites $E2 (counter-clockwise) and $E3 (clockwise): a ring of 10 cluster sprites, not slot sprites (CODE_02AAC0, SMWDisX bank_02.asm:5640-5641). */
const RING_LEFT = 0xe2
const RING_RIGHT = 0xe3

/**
 * The ring of a stream entry (#983), run from the ROM's own spawn and draw: ONE sprite at its real stream index
 * (so hover and selection find it), the 10 pieces as its parts. A vertical level is not drawn (owner call B):
 * the loader hands the spawn the screen's Y boundary as the ring's X there (bank_02.asm:5232-5238, 5703-5706).
 * A routine or call-path part that is not the vanilla shape does not blank it (D52): drawn, flagged `unverified`.
 */
function ringResult(
  rom: RomFile,
  seed: SpriteSeed,
  s: LevelSprite,
  vertical: boolean,
  routines: RingRoutines,
): SpriteDrawResult {
  if (vertical) return { ok: false, reason: 'the rotating ring is not drawn in a vertical level: the game takes its centre from the wrong axis there' } // prettier-ignore
  const [x, y] = [pixelX(s), s.y * TILE]
  const r = rotatingRing(rom, seed, { id: s.spriteId, x, y, index: s.index, streamOffset: s.streamOffset }, routines) // prettier-ignore
  if (!r.ok) return { ok: false, reason: `refused: ${r.reason}` }
  const why = r.unverified.map(u => `${u} is not the vanilla shape`).join('; ')
  return {
    ok: true,
    parts: interpParts(r.parts),
    anchor: { x, y },
    identity: { spriteId: s.spriteId, mainHandler: 0, initHandler: 0, status: 'vanilla' },
    ...(why
      ? {
          unverified: `the rotating ring is drawn from the code at the vanilla address, and ${why}`,
        }
      : {}),
  }
}

/**
 * The interpreter over this cart, for the level `index`: `levelSeed` runs the
 * ROM's own loader, Mario at the level's start, one sprite run alone per call.
 * When the loader refuses (a hack that moves its entry points) the model
 * reports `seedSource: 'generic'` with the loader's reason, and EVERY sprite
 * so run is answered with `unverified`: still drawn, never presented as run
 * from the level's own state. The runner decides; nothing here re-derives it.
 */
export function interpDrawer(...args: Parameters<typeof interpRunner>): SpriteDrawer {
  const runner = interpRunner(...args)
  return s => {
    const r = runner(s)
    return 'direct' in r ? r.direct : modelResult(r.m)
  }
}

/** One sprite's run: the interpreter's model plus whether `fixOffsets` found screen-fixed parts, or an answer a special-case routine gave directly (rings, the torpedo launcher). */
export type SpriteRun = { m: RunModel; fixed: boolean } | { direct: SpriteDrawResult }

/** The run behind `interpDrawer`. */
export function interpRunner(
  rom: RomFile,
  index: number,
  model: { isVertical: boolean; screenCount: number },
  run: (rom: RomFile, id: number, seed: SpriteSeed, opts?: Pick<RunOptions, 'stopAtDraw' | 'trackInputs'>) => RunModel = runWithUploads, // prettier-ignore
  seedFor: (rom: RomFile, index: number) => SpriteSeed = levelSeed,
  ringRoutines: RingRoutines = VANILLA_RING_ROUTINES,
  eeriesRoutines: EeriesRoutines = VANILLA_EERIES_ROUTINES,
  platformRoutines: PlatformRoutines = VANILLA_PLATFORM_ROUTINES,
  /** The map's whole sprite list: a sprite that scans the slots for a companion is run with its neighbors (#841). */
  list: readonly LevelSprite[] = [],
  /** Look for what reveals a sprite that draws nothing at rest (RevealSearch.ts): the map view's runs only. */
  reveal: boolean = run === runWithUploads,
  /** Test hook for the rope: a synthetic cart's loader fingerprint. */
  ropeHooks: Pick<RopeAt, 'spec'> = {},
): (sprite: LevelSprite) => SpriteRun {
  // The loader runs once per map, not per sprite.
  const base = seedFor(rom, index)
  // Mario's start is what the ROM-run loader left in $94/$96 (the entrance it ran); the
  // table re-derivation is only for a generic seed, which has no loader image.
  const w = base.loaded
  const mario = w
    ? { x: w[0x94]! | (w[0x95]! << 8), y: w[0x96]! | (w[0x97]! << 8) }
    : readMarioStartPos(rom, index)
  // No start to seed the run with: refuse (compute turns this into an `unavailable` reply) rather than
  // seed Mario at {0,0} or the default position.
  if (!mario) throw new Error(`Mario start position unavailable: entrance tables unreadable for map ${index.toString(16)}`) // prettier-ignore
  // Layer 1 as the loader left it ($1A/$1C): where a screen-fixed part's OAM position is on the map.
  const loaderCam = w && { x: w[0x1a]! | (w[0x1b]! << 8), y: w[0x1c]! | (w[0x1d]! << 8) }
  // OAM + the loader's camera is what the game shows only for a sprite its start-of-level load loaded:
  // the loader runs CODE_05801E -> CODE_02A751 (bank_05.asm:72), which marks each loaded sprite's
  // SpriteLoadStatus byte ($1938 + list index, bank_02.asm:5285) and clears a generator's or a
  // no-free-slot sprite's (5345, 5419). 128 entries; a later index is not tracked, so not placed.
  // Only the map's own shape is added to a generic seed; a loaded one ignores it.
  const shape = { level: { screenMode: model.isVertical ? 1 : 0, screens: model.screenCount } }
  return s => {
    if (s.spriteId === RING_LEFT || s.spriteId === RING_RIGHT) return { direct: ringResult(rom, base, s, model.isVertical, ringRoutines) } // prettier-ignore
    const [x, y] = [pixelX(s), s.y * TILE]
    const camera = cameraFor(x, y, model.isVertical, model.screenCount)
    const neighbours = neighboursOf(list, s, e => ({ x: pixelX(e), y: e.y * TILE }))
    const seed = (camera: { x: number; y: number }, extra = {}) => withSeed({ sprite: { x, y }, camera, mario, ...shape, ...(neighbours.length ? { neighbours } : {}), ...extra }, base) // prettier-ignore
    if (s.spriteId === FIVE_EERIES) return { direct: eeriesResult(rom, seed(camera), s, model.isVertical, eeriesRoutines) } // prettier-ignore
    if (s.spriteId === THREE_PLATFORMS) return { direct: platformsResult(rom, seed(camera), s, model.isVertical, platformRoutines) } // prettier-ignore
    if (s.spriteId === TORPEDO_LAUNCHER_ID) return { direct: launcherResult(rom, seed(camera)) } // prettier-ignore
    // The map's own loader placed it at map load (D156): it also spawns at the map-load camera.
    const opening = !!w && s.index >= 0 && s.index < 128 && !!w[SPRITE_LOAD_STATUS + s.index]
    // The rope draws its length from the slot the loader gives it (RopeLength.ts, #1230): run in that slot, not slot 0.
    const rope = !!w && isRopeId(s.spriteId)
    const tracked = reveal ? { trackInputs: true } : undefined
    let m = rope
      ? ropeModel(rom, { id: s.spriteId, setting: w![0x1692]!, x, y, vertical: model.isVertical, ...ropeHooks }, slot => run(rom, s.spriteId, seed(camera, { opening, slot }), tracked)) // prettier-ignore
      : run(rom, s.spriteId, seed(camera, { opening }), tracked)
    // No loader image: the slot cannot be known, so the rope stays short and says so (a confirmed rope only).
    if (!w && isRopeId(s.spriteId) && m.snaps) m = { ...m, lengthNote: NO_IMAGE_NOTE }
    // A sprite placed at the game's own layout (the bonus game) was replayed in the loader's top slot; an earlier loaded sprite
    // may have taken it, which moves one block by a pixel and changes its item (measured on $000, slots 9 vs 8): drawn, marked.
    if (
      m.absolutePlacement &&
      !m.unverifiedReason &&
      earlierSpriteLoaded(list, s, i => w?.[SPRITE_LOAD_STATUS + i] ?? 0)
    )
      m = { ...m, unverifiedReason: EARLIER_SPRITE_REASON }
    // An extra-bit entry is never seeded, so a scanner would draw without it: marked. With stock neighbors seeded the run above
    // had the scan hook and `scansSlots` is exact; with none, one probe run with the extras in finds out. A rope is not probed (its slot run differs).
    if (
      !rope &&
      hasExtraBitNeighbour(list, s) &&
      (neighbours.length
        ? m.scansSlots
        : run(
            rom,
            s.spriteId,
            seed(camera, {
              opening,
              neighbours: neighboursOf(list, s, e => ({ x: pixelX(e), y: e.y * TILE }), true),
            }),
          ).scansSlots)
    )
      // prettier-ignore
      m = { ...m, unverifiedReason: joinReasons(m.unverifiedReason, NEIGHBOUR_EXTRA_BIT_REASON) }
    // Hidden sprites take their picture from the search, whatever the at-rest run drew (a mole drawn from where Mario starts).
    if (reveal) {
      const rv = findReveal(seed(camera, { opening }), m, (q, probe) =>
        run(rom, s.spriteId, q, { stopAtDraw: probe }),
      )
      if (rv.status === 'hidden') return { m: { ...rv.model, unverifiedReason: joinReasons(rv.model.unverifiedReason, m.unverifiedReason) }, fixed: false } // prettier-ignore
      if (rv.status === 'refused') return { m: { ...m, chosen: undefined, refusal: rv.reason }, fixed: false } // prettier-ignore
      // Drew from the real start, blank under a probe, no condition found: the real-start picture stands, in the door.
      if (rv.status === 'unrevealed' && rv.drewAtRest)
        return { m: { ...m, chosen: drawnPass(m), reveal: 'none-found' }, fixed: false } // prettier-ignore
      if (rv.status === 'unrevealed') return { m: { ...m, chosen: undefined, emptyReason: UNREVEALED }, fixed: false } // prettier-ignore
    }
    const at = m.chosen
    if (!w || !loaderCam || at === undefined || !m.anchor || s.index < 0 || s.index >= 128 || !w[SPRITE_LOAD_STATUS + s.index]) return { m, fixed: false } // prettier-ignore
    // Probe: the camera moved 13 x 11 px (not a multiple of the 8 px tile pitch, so a neighbor
    // tile cannot alias) towards the sprite's screen centre, so it stays drawn; run only to the drawn pass.
    // A sprite with its own gate on the camera ($8D draws only while low byte of Layer1XPos < $46, bank_02.asm:15670-15673)
    // may draw nothing there: the shift is tried the other way, and if that draws nothing too the probe
    // proves nothing and the run stands (no position is invented).
    // A sprite drawn at fixed map positions (InitLatches.ts) has no screen-fixed parts, and its camera is not the loader's.
    // A rope is not screen-fixed, and its probe would run in another slot than the picture.
    if (m.absolutePlacement || (rope && m.snaps)) return { m, fixed: false }
    const dir = [x - camera.x < 128 ? -13 : 13, y - camera.y < 112 ? -11 : 11]
    for (const k of [1, -1]) {
      const shifted = { x: camera.x + dir[0]! * k, y: camera.y + dir[1]! * k }
      const probe = run(rom, s.spriteId, seed(shifted, { mainPasses: at + 1 }))
      if (!probe.passes[at] || !drawnParts(probe.passes[at]!).length) continue
      const fixed = fixOffsets(m, probe, loaderCam, w)
      return { m: fixed ?? m, fixed: !!fixed }
    }
    return { m, fixed: false }
  }
}

/**
 * Parts whose OAM position is the same with the camera moved are screen-fixed
 * (the Side Exit's flame, CODE_02F4EB, SMWDisX bank_02.asm:15531-15576, writes
 * screen coordinates): their map position is OAM + the loader's camera, not
 * the sprite's offset, and is not wrapped to a byte. A part whose X (9 bits) and Y are
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
  const at = m.chosen
  // Compared and rewritten as one list: a screen-fixed companion piece is fixed like the sprite's own.
  const flat = (r: RunModel) => {
    const q = at === undefined ? undefined : r.passes[at]
    return q && { ...q, parts: drawnParts(q) }
  }
  const [pass, other] = [flat(m), flat(probe)]
  if (!m.anchor || !pass || !other) return null
  const anchor = m.anchor
  // Residue: the loader's entry is the part's X and Y, in an entry that is not all zero. Tile and
  // attribute are not compared: the castle-flame cluster rewrites them. An all-zero entry is the loader's
  // fill, not a drawn part, so a genuine part at (0, 0) must move.
  const residue = (p: SpritePart) => {
    const e = loaded.subarray(RAM.oam + p.oam * 4, RAM.oam + p.oam * 4 + 4)
    // X is 9 bits: bit 8 sits in the size table, one byte per OAM entry (SpriteRunner.readParts); it counts as non-zero.
    const x9 = e[0]! | ((loaded[RAM.oamSize + p.oam]! & 1) << 8)
    return (e.some(v => v) || x9 > 255) && x9 === p.ox && e[1] === p.oy
  }
  // Each axis on its own: $8D's X is table - Layer1XPos (follows the camera) but its Y is a bare table byte.
  /** Per axis, whether part `p` is screen-fixed: its OAM X or Y is the same in the probe run (the camera moved) and is not loader residue. */
  const fixedAxes = (p: SpritePart) => {
    const q = !residue(p) ? other.parts.find(q => q.oam === p.oam) : undefined
    return { x: !!q && q.ox === p.ox, y: !!q && q.oy === p.oy }
  }
  const axes = pass.parts.map(fixedAxes)
  if (!axes.some(f => f.x || f.y)) return null
  // X is 9 bits (bit 8 is the sign); OAM Y $E0-$FF is above the screen's top edge. A fixed axis is not wrapped to a byte.
  const parts = pass.parts.map((p, i) => {
    const f = axes[i]!
    return {
      ...p,
      dx: f.x ? (p.ox > 255 ? p.ox - 512 : p.ox) + cam.x - anchor.x : p.dx,
      dy: f.y ? (p.oy >= 0xe0 ? p.oy - 256 : p.oy) + cam.y - anchor.y : p.dy,
    }
  })
  return { ...m, passes: m.passes.map((q, i) => (i === at ? { ...q, parts, companions: [] } : q)) }
}

/** Sprite $E6, whose spawn puts the castle flames on Layer 2 (CODE_02AAC0, SMWDisX bank_02.asm:5636-5637). */
const CASTLE_FLAMES_ID = 0xe6

/**
 * The castle flames (#894): the ROM's own spawn and draw run with Layer 2 at zero give each flame's
 * position in Layer 2 space; Layer 2 repeats every 256 px (a flame's byte position wraps), so a copy
 * stands at every 256 px in X and Y across the map, `dy` pixels below that (the map's Layer1YPos -
 * Layer2YPos, as the background is drawn). A stream without a plain $E6 has none. A run that is refused
 * or a char that is not loaded draws none, and says so in the note. A routine or call-path part that is
 * not the vanilla shape does not blank them (owner ruling D52, option B): they are drawn from the ROM's own
 * code, flagged `unverified`, and the note names what differs.
 */
export function castleFlameSprites(
  rom: RomFile,
  seed: SpriteSeed,
  sprites: readonly LevelSprite[],
  model: SpriteModel & { isVertical: boolean; screenCount: number },
  dy: number | undefined,
  dynamic?: (note: PaletteNote) => RgbaColor[],
  routines: FlameRoutines = VANILLA_FLAME_ROUTINES,
): { sprites: MapSpriteDto[]; note?: string; noteDetail?: string } {
  if (!sprites.some(s => s.spriteId === CASTLE_FLAMES_ID && !(s.raw[0]! & EXTRA_BITS))) return { sprites: [] } // prettier-ignore
  const none = (why: string, noteDetail?: string) => ({ sprites: [], note: `The castle flames are not drawn: ${why}.`, ...(noteDetail ? { noteDetail } : {}) }) // prettier-ignore
  if (dy === undefined) return none('the background position is unknown')
  const run = castleFlames(rom, seed, routines)
  if (!run.ok) return none('the routines that draw them could not be run on this ROM', run.reason)
  if (run.parts.length === 0) return none('the routines drew nothing')
  const { w, h } = screenTiles(model.isVertical)
  const [mapW, mapH] = model.isVertical ? [w * TILE, model.screenCount * h * TILE] : [model.screenCount * w * TILE, h * TILE] // prettier-ignore
  // One bitmap per flame per copy, not one per copy: a copy spans the whole width of its flames.
  const jobs: { x: number; y: number; parts: DrawPart[] }[] = []
  // The X >= $F0 overflow (CODE_02FA16) draws a flame twice, at $F8 and at $1F8: one period apart, so the
  // second one's copy at -256 lands on the first and would paint it twice. Identical bitmaps at one place are kept once.
  const seen = new Set<string>()
  for (const flame of run.parts) {
    const parts = interpParts([flame])
    const [x0, x1] = [Math.min(...parts.map(p => p.dx)), Math.max(...parts.map(p => p.dx)) + 8]
    const [y0, y1] = [Math.min(...parts.map(p => p.dy)), Math.max(...parts.map(p => p.dy)) + 8]
    // Copies at every 256 px, from one before the map; only those that reach it are kept.
    for (let x = -256; x < mapW; x += 256)
      for (let y = (((dy % 256) + 256) % 256) - 512; y < mapH; y += 256)
        if (x + x1 > 0 && x + x0 < mapW && y + y1 > 0 && y + y0 < mapH) {
          const at = JSON.stringify(parts.map(p => ({ ...p, dx: p.dx + x, dy: p.dy + y })))
          if (!seen.has(at)) jobs.push({ x, y, parts })
          seen.add(at)
        }
  }
  // One fake stream entry per bitmap, at the copy's origin; the drawer answers with that flame's parts.
  const entry = (n: number): LevelSprite => ({ screen: 0, x: 0, y: 0, spriteId: CASTLE_FLAMES_ID, extraBit: false, raw: [0, 0, 0], index: -1 - n, streamOffset: 0 }) // prettier-ignore
  const draw: SpriteDrawer = s => {
    const job = jobs[-1 - s.index]!
    return {
      ok: true,
      parts: job.parts,
      anchor: job,
      identity: { spriteId: CASTLE_FLAMES_ID, mainHandler: 0, initHandler: 0, status: 'vanilla' },
    }
  }
  const drawn = drawSprites(
    jobs.map((_, n) => entry(n)),
    model,
    draw,
    dynamic,
  )
  // D52: a copy whose chars are not loaded is a marker at its position (as for any sprite), the rest are drawn.
  const missing = drawn.some(d => d.status !== 'drawn')
  if (missing && drawn.every(d => d.status !== 'drawn')) return none('their chars are not loaded')
  const placed = drawn.map((d, n) => {
    if (d.status === 'drawn') return d
    const [x, y] = [jobs[n]!.x + Math.min(...jobs[n]!.parts.map(p => p.dx)), jobs[n]!.y + Math.min(...jobs[n]!.parts.map(p => p.dy))] // prettier-ignore
    return { ...d, x, y, box: { x0: x, y0: y, x1: x + MARK, y1: y + MARK } }
  })
  const why = run.unverified.map(u => `${u} is not the vanilla shape`).join('; ')
  const unverified = `the castle flames are drawn from the code at the vanilla address, and ${why}`
  const notes = [
    ...(missing ? ['Some castle flames are only marked: their chars are not loaded.'] : []),
    ...(why
      ? [
          "The castle flames are drawn from this ROM's own code, which differs from the original game.",
        ]
      : []),
  ]
  return {
    sprites: placed.map(d => ({
      ...d,
      fixedTo: 'layer2' as const,
      ...(why ? { unverified } : {}),
    })),
    ...(notes.length ? { note: notes.join(' ') } : {}),
    ...(why ? { noteDetail: why } : {}),
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

/**
 * The map-level line for sprites drawn without the ROM-run level state: shown, flagged. The line is plain words;
 * every distinct cause (the loader's refusal, a memory setting, an earlier sprite) goes in `detail`, one per line,
 * for the tooltip. Joined by newline, not `; `, because one cause can hold a `;` itself (#1166).
 */
export const unverifiedNote = (sprites: readonly MapSpriteDto[]) => {
  const flagged = sprites.filter(s => s.unverified)
  if (flagged.length === 0) return undefined
  const n = flagged.length
  return {
    note: `Unverified: ${n} ${n === 1 ? 'sprite' : 'sprites'} may not be drawn exactly as in the game.`,
    detail: [...new Set(flagged.map(s => s.unverified!))].join('\n'),
  }
}

/** Placeholders drawn because the sprite may not be the vanilla one: the id's vanilla name would be a guess. */
const NOT_VANILLA = new Set(['extraBits', 'customHandler'])

/**
 * The sprite with its plain name from the app's sprite name table (#981); a sprite the table lacks keeps none.
 * Fail closed: a sprite with extra bits set or a repointed handler gets no name, as it gets no vanilla art.
 */
const named = (s: MapSpriteDto): MapSpriteDto => {
  if (s.reason && NOT_VANILLA.has(s.reason)) return s
  const name = getSpriteMetadata(s.id)?.displayName
  return name ? { ...s, name } : s
}

/**
 * The map's sprite notes: each sprite's note collapsed through a Set (the same sentence on many sprites shows once),
 * except undrawn spawned children, which are summed per noun so two spawners that each lose one say 2 (#1281).
 */
export function mapNotes(sprites: MapSpriteDto[]): string[] {
  const rest = new Set<string>()
  const sums = new Map<UndrawnChildren['noun'], number>()
  for (const s of sprites) {
    if (!s.note) continue
    const own = s.undrawn ? undrawnNote(s.undrawn) : undefined
    const left = own ? s.note.replace(own, '').trim() : s.note
    if (left) rest.add(left)
    if (!s.undrawn) continue
    sums.set(s.undrawn.noun, (sums.get(s.undrawn.noun) ?? 0) + s.undrawn.count)
  }
  const total = [...sums].map(([noun, count]) => undrawnNote({ noun, count }))
  return [...rest, ...total]
}

/** The reply for a stream: its sprites drawn, in the geometry of the map's screens. */
export function spriteLayer(
  data: Uint8Array,
  model: SpriteModel & { isVertical: boolean; screenCount: number },
  draw: SpriteDrawer,
  dynamic?: (note: PaletteNote) => RgbaColor[],
): Extract<MapSpritesResult, { status: 'ok' }> {
  const { w, h } = screenTiles(model.isVertical)
  const sprites = drawSprites(parseLevelSprites(data, model.isVertical), model, draw, dynamic).map(
    named,
  )
  const unverified = unverifiedNote(sprites)
  const details = new Set(sprites.flatMap(s => (s.noteDetail ? [s.noteDetail] : [])))
  const detail = [unverified?.detail, ...details].filter(Boolean).join('\n')
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
        unverified?.note,
        ...mapNotes(sprites),
      ]
        .filter(Boolean)
        .join(' ') || undefined,
    ...(detail ? { noteDetail: detail } : {}),
  }
}

/**
 * Replies per working-copy bytes and map: running every sprite's 64
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

/** The colors a handler uploads to CGRAM at runtime, read from the cart (the engine's `dynamicCgram` note). */
const dynamicOf = (rom: RomFile) => (n: PaletteNote) => {
  const b = rom.readAt(n.entryAddr, n.colors * 2)
  return b ? Array.from({ length: n.colors }, (_, i) => bgr555ToRgba(b[i * 2]! | (b[i * 2 + 1]! << 8))) : [] // prettier-ignore
}

/**
 * The sprite layer with the castle flames folded in: their sprites appended, their note after the layer's on the
 * visible line, and the two technical details kept apart, one per line, so neither is lost (#1166).
 */
export function withFlames(
  layer: Extract<MapSpritesResult, { status: 'ok' }>,
  flames: ReturnType<typeof castleFlameSprites>,
): Extract<MapSpritesResult, { status: 'ok' }> {
  const detail = [layer.noteDetail, flames.noteDetail].filter(Boolean).join('\n')
  return {
    ...layer,
    sprites: [...layer.sprites, ...flames.sprites],
    note: [layer.note, flames.note].filter(Boolean).join(' ') || undefined,
    ...(detail ? { noteDetail: detail } : {}),
  }
}

/** Runs the sprite interpreter at rest for every placed sprite on one map and folds the results into the served model; a Layer 1 refusal passes through as plain words with detail (#967). */
function compute(
  cache: L1ModelCache,
  bytes: Uint8Array,
  romPath: string,
  index: number,
): Exclude<MapSpritesResult, { status: 'rom-not-located' }> {
  // Sprites do not depend on the palaces; any flags give the same model.
  const built = cache.get(bytes, romPath, index, NO_FLAGS)
  if (!built.ok) return unreadable(built.detail ?? built.reason, built.reason)
  const model = built.inputs
  try {
    // A copy, as the model cache makes: the working copy's array is shared.
    const rom = new SmwRom(RomFile.fromBytes(romPath, Buffer.from(bytes)))
    const ptr = rom.getLevelSpritePointer(index)
    // A stream in the ROM's last bytes is still a stream (as SmwRom.getLevelRawData reads).
    const data = ptr === null ? null : readStream(rom.rom, ptr)
    if (!data) return unreadable(`No sprite data at the pointer for slot ${index.toString(16)}`, "this map's sprites could not be found in the ROM.") // prettier-ignore
    // The level loader runs once; the sprites and the castle flames both start from its image.
    const base = levelSeed(rom.rom, index)
    const stream = parseLevelSprites(data, model.isVertical)
    const draw = interpDrawer(rom.rom, index, model, runWithUploads, () => base, undefined, undefined, undefined, stream) // prettier-ignore
    // Read (and cached on the cart) only when a drawn sprite points Mario's tile DMA at the buffer.
    const withUploads = { ...model, playerGraphics: () => readMarioGraphics(rom.rom) }
    const dynamic = dynamicOf(rom.rom)
    const layer = spriteLayer(data, withUploads, draw, dynamic)
    const flames = castleFlameSprites(rom.rom, base, stream, model, model.l2?.ok ? model.l2.l2.dy : undefined, dynamic) // prettier-ignore
    if (flames.sprites.length === 0 && !flames.note) return layer
    return withFlames(layer, flames)
  } catch (err) {
    return unreadable((err as Error).message)
  }
}

/** Frames kept for one sprite's preview: a walk cycle is 2-9 poses; the rest would only be repeats. */
export const MAX_FRAMES = 16

/**
 * One sprite's distinct poses (#984), for the Properties preview. `m.passes` are consecutive real game
 * frames, so each pass that draws is blitted through `drawSprites` as if it were `chosen`: no second draw
 * path. The loop starts at `m.chosen` (the pose the map shows; frame 0 IS its bitmap unless that pass is not drawn) and goes on
 * to the later passes. A pose is its parts' chars, flips and offsets from one another (sorted: OAM order is
 * not a pose), after the sprite's own movement is subtracted, so only the art changes between frames.
 * Where a part is measured from differs by sprite: usually the one anchor (the placed spot at rest), with the sprite drawing
 * where it stood at the end of the pass (`pos`); for a line-guided id ($62, $64-$68) on a vanilla-shaped
 * handler the pass before's `pos` (`origin`, when `m.snaps`), the draw running before the move. `drawAt` is where the sprite
 * stood when it drew. A sprite with screen-fixed parts (`fixOffsets`) is not animated here: their map
 * position comes from the loader's camera for the chosen pass only, so another pass has no honest place.
 * When the chosen pass is not drawn (unloaded chars: the map shows a marker), the later poses that do draw are still kept and `reason` is the chosen pass's, so the panel never calls it "one pose" (#1113).
 */
export function framesOf(
  run: SpriteRun,
  s: LevelSprite,
  model: SpriteModel,
  dynamic?: (note: PaletteNote) => RgbaColor[],
): { frames: MapSpriteDto[]; reason?: string } {
  if ('direct' in run) return { frames: [], reason: 'it is drawn by a special routine' }
  const { m, fixed } = run
  const ref = m.chosen === undefined ? undefined : m.passes[m.chosen]
  if (!ref || !drawnParts(ref).length) {
    const r = modelResult(m)
    return { frames: [], reason: 'reason' in r ? r.reason : 'drew no tile' }
  }
  if (fixed) return { frames: [], reason: 'its parts are fixed to the screen' }
  const drawAt = (q: typeof ref) => (m.snaps ? q.origin : q.pos)
  const seen = new Set<string>()
  const frames: MapSpriteDto[] = []
  let why: string | undefined // set only when the chosen pass is not drawn
  for (const pass of m.passes.filter(q => q.pass >= ref.pass && drawnParts(q).length > 0)) {
    // dx' places the art where it stands relative to the sprite, on the chosen pass's anchor.
    const [ax, ay] = [pass.origin.x - drawAt(pass).x + drawAt(ref).x - ref.origin.x, pass.origin.y - drawAt(pass).y + drawAt(ref).y - ref.origin.y] // prettier-ignore
    const parts = drawnParts(pass).map(p => ({ ...p, dx: p.dx + ax, dy: p.dy + ay }))
    const pieces = interpParts(parts)
    const [mx, my] = [Math.min(...pieces.map(p => p.dx)), Math.min(...pieces.map(p => p.dy))]
    const key = pieces.map(p => [p.charNum, p.palette, +p.flipX, +p.flipY, p.dx - mx, p.dy - my].join()).sort().join(';') // prettier-ignore
    if (seen.has(key)) continue
    seen.add(key)
    const shifted = {
      ...m,
      chosen: pass.pass,
      passes: m.passes.map(q => (q === pass ? { ...q, parts, companions: [] } : q)),
    }
    const [f] = drawSprites([s], model, () => modelResult(shifted), dynamic)
    if (f!.status !== 'drawn') {
      // The map shows a marker for this sprite, so say why beside the later poses that do draw (#1113); a skip after a frame exists says nothing.
      if (!frames.length) why ??= f!.reason ?? f!.status
      continue
    }
    // A pass whose parts wrapped past 256 px or left the screen is not the same sprite's next pose: stop,
    // so the loop stays a contiguous run of real frames (vanilla: 54 sprites on 13 maps had one).
    const b0 = frames[0]?.box
    if (b0 && (['x0', 'y0', 'x1', 'y1'] as const).some(k => Math.abs(f!.box[k] - b0[k]) >= 256))
      break
    frames.push(f!)
    if (frames.length >= MAX_FRAMES) break
  }
  return why ? { frames, reason: why } : { frames }
}

/** The run behind a sprite's frames: at rest, like the map's picture (D139 D: INIT's look, D134 position), so frame 0 is that bitmap. */
export function frameRun(
  rom: RomFile,
  index: number,
  model: { isVertical: boolean; screenCount: number },
  base: SpriteSeed,
  s: LevelSprite,
  list: readonly LevelSprite[] = [],
): SpriteRun {
  // prettier-ignore
  return interpRunner(rom, index, model, undefined, () => base, undefined, undefined, undefined, list)(s)
}

/** The frames answer: a sprite its parent drew gets the rides-with code, anything else keeps what `framesOf` found. */
export function framesAnswer(
  frames: { frames: MapSpriteDto[]; reason?: string },
  dto?: Pick<MapSpriteDto, 'drawnBy'>,
): SpriteFramesResult {
  if (dto?.drawnBy !== undefined) return { status: 'ok', frames: [], reason: RIDES_WITH_REASON }
  return { status: 'ok', ...frames }
}

/** One sprite of a map as frames: the same seed, camera and drawer the map view used, run again for this sprite alone. */
export function mapSpriteFrames(
  cache: L1ModelCache,
  bytes: Uint8Array,
  romPath: string,
  index: number,
  spriteIndex: number,
): SpriteFramesResult {
  const built = cache.get(bytes, romPath, index, NO_FLAGS)
  if (!built.ok) return { status: 'unavailable', reason: built.reason }
  const model = built.inputs
  try {
    const rom = new SmwRom(RomFile.fromBytes(romPath, Buffer.from(bytes)))
    const ptr = rom.getLevelSpritePointer(index)
    const data = ptr === null ? null : readStream(rom.rom, ptr)
    const s = data && parseLevelSprites(data, model.isVertical).find(q => q.index === spriteIndex)
    if (!s)
      return {
        status: 'unavailable',
        reason: `No sprite ${spriteIndex} on map ${index.toString(16)}`,
      }
    // Extra bits fail closed in the map view; there is nothing to animate either.
    if ((s.raw[0] ?? 0) & EXTRA_BITS) return { status: 'ok', frames: [], reason: 'extraBits' }
    const base = levelSeed(rom.rom, index)
    const stream = parseLevelSprites(data, model.isVertical)
    // The same player-buffer reader the map path gives, so frame 0 is the bitmap the map drew (D138 A).
    const withUploads = { ...model, playerGraphics: () => readMarioGraphics(rom.rom) }
    const frames = framesOf(frameRun(rom.rom, index, model, base, s, stream), s, withUploads, dynamicOf(rom.rom)) // prettier-ignore
    // Drawn by its parent on the map (the $9B a $9C carries): its tiles are the parent's, so say that, not "drew no tile".
    const dto = frames.frames.length ? undefined : drawSprites(stream, model, interpDrawer(rom.rom, index, model, undefined, () => base, undefined, undefined, undefined, stream)).find(d => d.index === s.index) // prettier-ignore
    return framesAnswer(frames, dto)
  } catch (err) {
    return { status: 'unavailable', reason: (err as Error).message }
  }
}
