/**
 * The capture viewer's logic: load one map's capture, run its checks, and
 * build the self-contained HTML page and the index. render_capture.ts is the
 * command line around runCapture.
 *
 * Pages embed ROM-derived bytes, which is why they go only where the caller
 * says and never into the repo. Canvas in the page is the rasterizer.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import * as zlib from 'zlib'
import { inflateRawSync, inflateSync } from 'zlib'
import { buildSync } from 'esbuild'
import * as D from './capture_decode'
import * as Draw from './capture_draw'
import type { GridMeta, Mismatch, PipeInfo } from './capture_decode'

const { hex, hexWord } = D
export type Reader = (name: string) => Buffer | null
/** incomplete: a check that decides the map could not run (a layer not compared or refused). */
export type Verdict = 'pass' | 'weak' | 'fail' | 'incomplete' | 'unavailable'
/** One check's outcome, as the Checks table shows it. */
export type Result = 'pass' | 'weak' | 'fail' | 'not compared' | 'informational'

// ppu.json keys the map-wide render reads; each holds a number or an object whose `byte` is the register.
// prettier-ignore
export const REGS = ['BGMODE_2105', 'BG1SC_2107', 'BG2SC_2108', 'BG3SC_2109', 'BG12NBA_210B', 'BG34NBA_210C', 'OBSEL_2101'] as const
type Regs = Record<(typeof REGS)[number], number>
// The only tile-id rule and vertical in-screen layout map16Id/map16Index implement.
export const TILE_ID_RULE = '(high & 1) * 256 + low'
export const VERTICAL_RULE = '(col//16)*$100 + (row%16)*$10 + col%16'
/** Charges one entry's declared size to a capture's budget, before it is read; `fail` throws. */
const budget = (fail: (why: string) => never) => {
  let total = 0
  return (name: string, size: number) => {
    if (size > MAX_ENTRY) fail(`${name} states ${size} bytes, over the ${MAX_ENTRY} this reads`)
    total += size
    if (total > MAX_TOTAL) fail(`${name} brings the entries read to ${total} bytes, over the ${MAX_TOTAL} a capture may expand to`) // prettier-ignore
  }
}
const PIPE_RANGE = /Map16Pointers\[\$([0-9a-f]+)\.\.\$([0-9a-f]+)\]/i
/** The largest entry read: ~160x the largest real one (sprite_spawns.json, ~410 KB, over 161 captures at layers_v5). */
const MAX_ENTRY = 64 << 20
/** All entries a capture may expand to together; a map's seven required files are well under 1 MiB. */
const MAX_TOTAL = 128 << 20
/** A layer picture is one SNES frame, at most 512x478 (hi-res, interlaced): 1 << 18 pixels, 1024 on a side. */
const MAX_PNG_PIXELS = 1 << 18
const MAX_PNG_SIDE = 1024

/** One of Mesen's layer pictures: layer_<name>.png and the files beside it. */
interface Ref {
  name: string
  png: Buffer
  /** The camera on the picture's frame, null when not recorded. */
  x: number | null
  y: number | null
  /** The backdrop Mesen was given for this render, as RGB, or null. */
  sentinel: number[] | null
  /** 0 the load sample, k the k-th window. */
  view: number
  /** The status-bar interrupt line on this picture's frame. */
  irqLine?: number
  /** What the game held on the frame this picture shows; without it the picture is not compared. */
  own?: View
}
interface View {
  /** BG1, BG2, BG3 scroll as [H, V], from the registers read on the picture's frame. */
  scroll: number[][]
  regs: Regs
  vram: Buffer
  oam: Buffer | null
  cgram: Buffer | null
}
export interface ViewerData {
  level: string
  cols: number
  rows: number
  /** Everything the map-wide render uses; no window data. */
  draw: D.LevelInput
  backdrop: number[]
  /** The load sample's CGRAM, the map's palette. */
  cgram: string
  /** Distinct camera positions with an SNES picture (the check's counts are in Checks). */
  screens: number
  /** The map's sprite list, placed, with where each was seen alive (null: not recorded). */
  spriteList: { id: number; x: number; y: number; alive: string[] | null }[]
  mismatches: Mismatch[]
  /** Drawn sprites that match no frame recorded for them. */
  spriteMismatches: SpriteMismatch[]
}
interface SpriteMismatch {
  k: number
  id: number
  x: number
  y: number
  w: number
  h: number
  reason: string
}
/** The checks as the page shows them: a row per layer, then short lists. */
export interface Checks {
  rows: { layer: string; result: Result; map: string; snes: string; note: string }[]
  lists: { title: string; items: string[] }[]
}

export interface Level {
  verdict: Verdict
  /** Every check in one line, for the run log: `checks` flattened. */
  detail: string
  checks?: Checks
  /** The Foreground map check on its own, before the SNES comparison is folded in. */
  mapCheck?: Result
  mismatches: Mismatch[]
  data?: ViewerData
  /** Per layer, differing SNES pixels per window (null: not compared). */
  snes?: Record<string, number[] | null>
  orientation?: string
  screens?: number
  /** Object Layer 2's grid + defs against BG2 VRAM; null when Layer 2 is not objects. */
  l2?: { verdict: string; differ: number; compared: number } | null
  /** Layers this tool would not draw, each with the rule that refused it. */
  refused?: string[]
  /** Mesen's pictures with their data: Node only, for the checks. */
  refs?: Ref[]
}

/** A capture file this tool cannot read: the map is unavailable, the run goes on. */
class CaptureFileError extends Error {}
const unavailable = (detail: string): Level => ({ verdict: 'unavailable', detail, mismatches: [] })

/**
 * Decode a PNG to RGBA with Node's zlib, for the SNES counts. 8-bit RGB,
 * RGBA or palette, not interlaced; any other kind returns null, and that
 * screen is not compared. A damaged PNG is a CaptureFileError.
 */
export function pngRgba(b: Buffer): { w: number; h: number; px: Uint8ClampedArray } | null {
  if (b.length < 8 || b.readUInt32BE(0) !== 0x89504e47) return null
  let [o, w, h, depth, type, lace] = [8, 0, 0, 0, 0, 0]
  const idat: Buffer[] = []
  let plte: Buffer | null = null
  while (o + 8 <= b.length) {
    const [len, t] = [b.readUInt32BE(o), b.toString('ascii', o + 4, o + 8)]
    const d = b.subarray(o + 8, o + 8 + len)
    if (t === 'IHDR')
      [w, h, depth, type, lace] = [d.readUInt32BE(0), d.readUInt32BE(4), d[8], d[9], d[12]] // prettier-ignore
    else if (t === 'PLTE') plte = d
    else if (t === 'IDAT') idat.push(d)
    o += 12 + len
  }
  const bpp = { 2: 3, 6: 4, 3: 1 }[type]
  if (depth !== 8 || lace || !bpp || (type === 3 && !plte)) return null
  if (w > MAX_PNG_SIDE || h > MAX_PNG_SIDE || w * h > MAX_PNG_PIXELS)
    throw new CaptureFileError(`a PNG states ${w}x${h}, over the ${MAX_PNG_SIDE} per side and ${MAX_PNG_PIXELS} pixels a capture picture can be`) // prettier-ignore
  const stride = w * bpp
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: Math.max(1, h * (stride + 1)) })
  } catch (e) {
    throw new CaptureFileError(`a PNG does not inflate (${(e as Error).message})`)
  }
  if (raw.length !== h * (stride + 1)) throw new CaptureFileError(`a ${w}x${h} PNG inflates to ${raw.length} bytes, not ${h * (stride + 1)}`) // prettier-ignore
  // Unfiltered in place, one byte at a time without allocating: this loop is
  // most of a run's time.
  const row = new Uint8Array(h * stride)
  for (let y = 0; y < h; y++) {
    const [f, src, dst] = [raw[y * (stride + 1)], y * (stride + 1) + 1, y * stride]
    if (f > 4) throw new CaptureFileError(`a PNG row uses filter ${f}`)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[dst + x - bpp] : 0
      const up = y ? row[dst + x - stride] : 0
      let add = 0
      if (f === 1) add = a
      else if (f === 2) add = up
      else if (f === 3) add = (a + up) >> 1
      else if (f === 4) {
        const c = x >= bpp && y ? row[dst + x - stride - bpp] : 0
        const pa = Math.abs(up - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + up - 2 * c)
        add = pa <= pb && pa <= pc ? a : pb <= pc ? up : c
      }
      row[dst + x] = (raw[src + x] + add) & 255
    }
  }
  const px = new Uint8ClampedArray(w * h * 4)
  const from = type === 3 ? plte! : row
  for (let i = 0; i < w * h; i++) {
    const o = type === 3 ? row[i] * 3 : i * bpp
    px[i * 4] = from[o]
    px[i * 4 + 1] = from[o + 1]
    px[i * 4 + 2] = from[o + 2]
    px[i * 4 + 3] = 255
  }
  return { w, h, px }
}

const num = (v: unknown) => {
  const n = D.parseNum(v && typeof v === 'object' ? (v as { byte?: unknown }).byte : v)
  return Number.isNaN(n) ? null : n
}
type Rec = Record<string, unknown>
/** A sidecar list: [] when absent; anything but a list is a CaptureFileError. */
function list(v: unknown, what: string): Rec[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new CaptureFileError(`${what} is not a list`)
  return v
}

/** One build of a strip: the frame and the words its pipe tiles took. */
type Build = { frame: number; words: number[] }
/** A build `includeNegative` kept from the default drop, but could not resolve: no words, or a NaN frame/strip. */ // prettier-ignore
export type UnresolvedBuild = { strip: number; frame: number }
export type Pipes = PipeInfo & { builds: Record<string, Build[]>; unresolved: UnresolvedBuild[] }

/**
 * The pipe words of every strip build map16_pipe_writes.json lists: pointer
 * i of a build defines tile lo + i, and `defs` gives its 4 words in
 * `defsWordOrder`. Builds before `loadFrame` belong to another map (a
 * castle's entrance room) and are dropped; each strip then starts from its
 * first build, the map as first seen. Null unless the sidecar states the
 * range, the word order, the defs and the builds.
 */
export function pipeInfo(
  writes: unknown,
  loadFrame = -Infinity,
  opts: { includeNegative?: boolean } = {},
): Pipes | null {
  const w = (writes ?? {}) as {
    entryPointers?: string
    defs?: Record<string, unknown[]>
    defsWordOrder?: unknown
    stripBuilds?: Rec[]
  }
  const range = PIPE_RANGE.exec(String(w.entryPointers ?? ''))
  const order = D.parseQuadrantOrder(w.defsWordOrder)
  if (!range || !order || !w.defs || !Array.isArray(w.stripBuilds)) return null
  const [lo, hi, defs] = [parseInt(range[1], 16), parseInt(range[2], 16), w.defs]
  const wordsOf = (ptrs: string[]): number[] | null => {
    const q4 = ptrs.map(p => list(defs[p], `map16_pipe_writes.json defs ${p}`).map(D.parseNum))
    return ptrs.length === hi - lo + 1 && q4.every(q => q.length === 4 && !q.some(Number.isNaN)) ? q4.flatMap(q => [0, 1, 2, 3].map(k => q[order.indexOf(k)])) : null // prettier-ignore
  }
  const builds: Record<string, Build[]> = {}
  const unresolved: UnresolvedBuild[] = []
  for (const b of list(w.stripBuilds, 'map16_pipe_writes.json stripBuilds')) {
    const ptrs = list(b.pointers, 'map16_pipe_writes.json stripBuilds pointers').map(String)
    const [st, frame, words] = [Number(b.strip), Number(b.frame), wordsOf(ptrs)]
    if (!opts.includeNegative) {
      // Exactly the original condition: default behavior is unchanged.
      if (st < 0 || !words || Number.isNaN(frame) || frame < loadFrame) continue
      ;(builds[st] ??= []).push({ frame, words })
      continue
    }
    // Through the opt-in only: a build with unresolved pointers or a NaN
    // frame/strip is surfaced in `unresolved` rather than silently dropped
    // (frame < loadFrame stays a deliberate drop - it belongs to another room).
    if (frame < loadFrame) continue
    if (Number.isNaN(st) || Number.isNaN(frame) || !words) {
      unresolved.push({ strip: st, frame })
      continue
    }
    ;(builds[st] ??= []).push({ frame, words })
  }
  for (const l of Object.values(builds)) l.sort((a, b) => a.frame - b.frame)
  const strips = Object.fromEntries(Object.entries(builds).map(([st, l]) => [st, l[0].words]))
  return { lo, hi, strips, builds, unresolved }
}

/**
 * The pipe words a picture taken at `frame` shows: each strip's latest
 * build at or before it. A strip not yet built by then has no words (a
 * guess, left out of the check).
 */
export function pipeAt(p: Pipes, frame: number): PipeInfo {
  const strips: Record<string, number[]> = {}
  for (const [st, l] of Object.entries(p.builds)) {
    const last = l.filter(b => b.frame <= frame).pop()
    if (last) strips[st] = last.words
  }
  return { lo: p.lo, hi: p.hi, strips }
}

/** OAM entries of one recorded frame, relative to the sprite, hidden ones dropped. */
function framePieces(frame: Rec, rec: Rec, obsel: number): D.SpritePiece[] | null {
  // A recorded frame lists `tiles` (dx, dy, tile, attr, large), front first;
  // a record with no recorded frames lists its OAM `entries` by index.
  const entries = list(frame.tiles ?? frame.entries, 'sprite_spawns.json tiles')
  if (!entries.length) return null
  // Relative already (dx/dy), or screen OAM against the sprite and camera of that frame.
  const at = [frame.x ?? rec.x, frame.y ?? rec.y, frame.cameraX ?? rec.cameraX, frame.cameraY ?? rec.cameraY].map(num) // prettier-ignore
  const relative = entries.every(p => num(p.dx) !== null && num(p.dy) !== null)
  if (!relative && at.some(v => v === null)) return null
  return entries
    .filter(p => {
      if (relative) return true
      const y = num(p.y) ?? 0
      // An entry parked in the band below the screen is hidden, not part of the picture.
      return !(y >= 224 && y + D.objSize(obsel, ((num(p.sizeXHigh) ?? 0) >> 1) & 1)[1] <= 256)
    })
    .map((p, k) => {
      const hi = typeof p.large === 'boolean' ? (p.large ? 2 : 0) : (num(p.sizeXHigh) ?? 0)
      const [dx, dy] = relative
        ? [num(p.dx)!, num(p.dy)!]
        : D.pieceOffset((num(p.x) ?? 0) + (hi & 1) * 256, num(p.y) ?? 0, at[0]!, at[1]!, at[2]!, at[3]!) // prettier-ignore
      return { i: num(p.entry) ?? k, dx, dy, tile: num(p.tile) ?? 0, attr: num(p.attr) ?? 0, large: (hi >> 1) & 1 } // prettier-ignore
    })
}

/**
 * The frame a spawn record draws: the one whose frameIndex is the record's
 * firstFrameIndex. When that frame was not observed, or the sprite has no
 * frame index, the earliest recorded frame is drawn and marked as a guess.
 * A record with no recorded frames draws the OAM entries it recorded when
 * it first drew.
 */
export function spriteFrame(rec: Rec, obsel: number) {
  const frames = list(rec.frames, 'sprite_spawns.json frames')
  if (!frames.length) {
    const pieces = framePieces(rec, rec, obsel)
    return pieces
      ? { pieces, reason: '', recorded: [pieces] }
      : { pieces: null, reason: 'Its record lacks the sprite position, camera or OAM entries of one frame', recorded: [] } // prettier-ignore
  }
  const want = num(rec.firstFrameIndex)
  const exact = want === null ? undefined : frames.find(f => num(f.frameIndex) === want)
  const chosen = exact ?? frames[0]
  const noIndex = want === null || frames.every(f => num(f.frameIndex) === null)
  const listed = frames.map(f => (num(f.frameIndex) === null ? '?' : String(num(f.frameIndex)))).join(', ') // prettier-ignore
  const drawn = num(chosen.frameIndex)
  const note = `frame ${drawn === null ? '(no index)' : drawn} drawn; recorded frames ${listed}`
  const pieces = framePieces(chosen, rec, obsel)
  // Every recorded frame, for checking against what the SNES drew.
  const recorded = frames.map(f => framePieces(f, rec, obsel)).filter(p => p !== null)
  if (!pieces) return { pieces: null, reason: 'Its recorded frame lacks OAM entries or their position', frames: note, recorded } // prettier-ignore
  const reason = exact ? '' : noIndex ? 'No frame index; the earliest recorded frame is drawn' : 'First animation frame not observed; the earliest recorded frame is drawn' // prettier-ignore
  return { pieces, reason, frames: note, recorded }
}

/** The worst of several results: a failure, then anything not compared, then weak. */
function worst(rs: Result[]): Result {
  for (const r of ['fail', 'not compared', 'weak'] as Result[]) if (rs.includes(r)) return r
  return 'pass'
}

/** A map's Level, or unavailable with the reason when a capture file cannot be read. */
function guarded(load: () => Level): Level {
  try {
    return load()
  } catch (e) {
    if (!(e instanceof CaptureFileError)) throw e
    return unavailable(e.message)
  }
}

export function loadLevel(read: Reader, level: string, windows: string[] = []): Level {
  return guarded(() => readLevel(read, level, windows))
}

function readLevel(read: Reader, level: string, windows: string[]): Level {
  const json = (n: string) => {
    const b = read(n)
    if (!b) return null
    let o: unknown
    try {
      o = JSON.parse(b.toString('utf8'))
    } catch (e) {
      throw new CaptureFileError(`${n} is not valid JSON (${(e as Error).message})`)
    }
    if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new CaptureFileError(`${n} is not a JSON object`) // prettier-ignore
    return o as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const b64 = (b: Buffer) => b.toString('base64')
  const bad = (p: string[]) => unavailable(p.join('; '))
  const summary = json('capture_summary.json')
  if (!summary) return bad(['no capture_summary.json: the capture aborted'])
  if (summary.identityGate !== 'pass') return bad([`identity gate: ${summary.identityGate}`])
  if (summary.layer1 && summary.layer1 !== 'map16') return bad([`Layer 1: ${summary.layer1}`])
  // The load sample, the first: the map's graphics and palettes come from it.
  const offset = Number(list(summary.samples, 'capture_summary.json samples')[0]?.offset ?? 0)
  const names = ['vram.bin', 'map16_grid.bin', 'map16_defs.bin', 'ppu.json', 'map16_grid.json', 'map16_defs.json', `frame_${String(offset).padStart(4, '0')}_cgram.bin`] // prettier-ignore
  const missing = names.filter(n => !read(n))
  if (missing.length) return bad(missing.map(n => `${n} missing`))
  const [vram, grid, defs, cgram] = [0, 1, 2, 6].map(i => read(names[i])!)
  const [ppu, gm, dj] = [3, 4, 5].map(i => json(names[i])!)

  const problems: string[] = []
  const regs = Object.fromEntries(REGS.map(k => [k, num(ppu[k])])) as Regs
  for (const k of REGS) if (regs[k] === null) problems.push(`ppu.json has no ${k}`)
  // Mode 1 with 8x8 chars on BG1-BG3 (BGMODE bits 4-6) is all this tool draws.
  const mode = regs.BGMODE_2105
  if (mode !== null && ((mode & 7) !== 1 || mode & 0x70)) {
    problems.push(`BGMODE ${hex(mode)} is not mode 1 with 8x8 chars on BG1-BG3`)
  }
  const cam = { x: num(ppu.camera?.layer1X), y: num(ppu.camera?.layer1Y) }
  if (cam.x === null || cam.y === null) problems.push('ppu.json has no camera.layer1X/Y')
  const l1 = gm.layer1 ?? {}
  const meta: GridMeta = {
    orientation: String(l1.orientation),
    screens: D.parseNum(l1.screens),
    bytesPerScreen: D.parseNum(l1.stride),
    lowOffset: D.parseNum(gm.lowOffset),
    highOffset: D.parseNum(gm.highOffset),
    base: D.parseNum(l1.base),
  }
  if (gm.tileId !== TILE_ID_RULE) problems.push(`map16_grid.json tileId is not ${TILE_ID_RULE}`)
  if (!['horizontal', 'vertical'].includes(meta.orientation)) problems.push('orientation unknown')
  if (Object.values(meta).some(v => Number.isNaN(v))) problems.push('map16_grid.json incomplete')
  if (meta.orientation === 'vertical' && gm.inScreen?.vertical !== VERTICAL_RULE) {
    problems.push(`vertical in-screen layout is not ${VERTICAL_RULE}`)
  }
  const dims = D.gridDims(meta)
  if (dims.cols !== l1.cols || dims.rows !== l1.rows) {
    problems.push(`grid is ${dims.cols}x${dims.rows} by stride, sidecar says ${l1.cols}x${l1.rows}`)
  }
  if (grid.length < meta.highOffset + meta.base + meta.screens * meta.bytesPerScreen) {
    problems.push(`map16_grid.bin is ${grid.length} bytes, sidecar implies more`)
  }
  const order = D.parseQuadrantOrder(dj.wordOrder)
  if (dj.available === false) problems.push(`map16 defs unavailable: ${dj.reason}`)
  if (!order) problems.push('map16_defs.json does not name all four word positions')
  const sampleFrame = D.parseNum(summary.anchorFrame) + offset
  // Without levelLoadFrame every strip build counts, and Coverage says so.
  const loadFrame = num(summary.levelLoadFrame)
  const pipe = pipeInfo(json('map16_pipe_writes.json'), loadFrame ?? -Infinity)
  if (!pipe) problems.push('map16_pipe_writes.json does not state the pipe range, defs, word order and strip builds') // prettier-ignore
  const boundaryNote = loadFrame === null ? ['load boundary not recorded: strip builds from every frame count'] : [] // prettier-ignore
  // Each window's BG1 picture data, read on the frame it shows.
  const wins = windows.map(w => {
    const wv = read(`windows/${w}/layer_bg1_vram.bin`)
    const wp = json(`windows/${w}/layer_bg1_data.json`)
    const [x, y, sc, frame] = [num(wp?.camera?.layer1X), num(wp?.camera?.layer1Y), num(wp?.BG1SC_2107), num(wp?.frame)] // prettier-ignore
    if (!wv || x === null || y === null || sc === null || frame === null) {
      problems.push(`window ${w} lacks layer_bg1_vram.bin, or a camera, BG1SC or frame in layer_bg1_data.json`) // prettier-ignore
    }
    // Layer2X/Y are what the NMI writes to BG2 scroll (bank_00.asm:307-314).
    const l2 = [num(wp?.camera?.layer2X), num(wp?.camera?.layer2Y)]
    return { name: w, vram: wv!, camX: x!, camY: y!, bg1sc: sc!, bg2sc: num(wp?.BG2SC_2108), l2, frame: frame! } // prettier-ignore
  })
  if (problems.length) return bad(problems)

  const inp = {
    vram,
    grid,
    defs,
    meta,
    order: order!,
    bg1sc: regs.BG1SC_2107,
    camX: cam.x!,
    camY: cam.y!,
    pipe: pipeAt(pipe!, sampleFrame),
  }
  // Cells a sprite generated during the scroll pass: a window from a later
  // frame is checked against the generated tile, not the load grid; the map
  // view keeps the load grid. Each Layer 1 GenerateTile call names the cells
  // it left (`cells`: col, row, after), replayed in frame order. Its `tile`
  // is the GenerateTile code, not a Map16 id. Layer 2 calls leave the
  // Foreground alone.
  const { cols: gCols } = D.gridDims(meta)
  const calls = list(json('scroll_pass.json')?.generateTileCalls, 'scroll_pass.json generateTileCalls') // prettier-ignore
  const made: { key: number; frame: number; id: number; sprite: string }[] = []
  const noLayer = calls.find(c => num(c.layer) === null)
  if (noLayer) return bad([`scroll_pass.json: a GenerateTile call at frame ${String(noLayer.frame)} names no layer`]) // prettier-ignore
  for (const c of calls.filter(c => num(c.layer) === 1))
    for (const k of Array.isArray(c.cells) ? (c.cells as Rec[]) : [{}]) {
      const [col, row, frame, id] = [num(k.col), num(k.row), num(c.frame), num(k.after)]
      if (col === null || row === null || frame === null || id === null) return bad([`scroll_pass.json: a Layer 1 GenerateTile call at frame ${String(c.frame)} does not name the cells it left`]) // prettier-ignore
      made.push({ key: row * gCols + col, frame, id, sprite: String((c.sprite as Rec)?.id ?? '?') })
    }
  const madeBy = new Map(made.map(g => [g.key, g.sprite]))
  // A call reaches a picture only from the next frame (docs/capture-viewer.md, GenerateTile).
  const generatedAt = (frame: number) =>
    new Map(
      made
        .filter(g => g.frame < frame)
        .sort((a, b) => a.frame - b.frame)
        .map(g => [g.key, g.id]),
    )
  const inputs = [inp, ...wins.map(w => ({ ...inp, vram: w.vram, bg1sc: w.bg1sc, camX: w.camX, camY: w.camY, pipe: pipeAt(pipe!, w.frame), generated: generatedAt(w.frame) }))] // prettier-ignore
  const checks = inputs.map(i => D.checkBg1(i))
  const runtime = [...new Set(checks.flatMap(c => c.runtime ?? []))]
  const bySprite = new Map<string, number>()
  for (const k of runtime) bySprite.set(madeBy.get(k)!, (bySprite.get(madeBy.get(k)!) ?? 0) + 1)
  const runtimeNote = runtime.length
    ? [`${runtime.length} Foreground cell${runtime.length === 1 ? '' : 's'} changed at runtime (${[...bySprite].map(([id, n]) => `${n} by sprite ${id}`).join(', ')}), checked against the generated tile`, 'the whole-map view draws the load grid'] // prettier-ignore
    : []
  const seen = new Set<string>()
  const oracle = {
    compared: checks.reduce((n, c) => n + c.compared, 0),
    mismatches: checks.flatMap(c => c.mismatches).filter(m => !seen.has(m.tx + ',' + m.ty) && !!seen.add(m.tx + ',' + m.ty)), // prettier-ignore
    ids: Math.max(...checks.map(c => c.ids)),
    strips: [Math.min(...checks.map(c => c.strips[0])), Math.max(...checks.map(c => c.strips[1]))],
  }
  const v = D.verdict(oracle)
  // A misplacement is a blind spot only if no camera position would have caught it.
  const spots = v === 'pass' ? inputs.map(i => D.blindSpots(i)) : [[]]
  const blind = spots[0].filter(b => spots.every(s => s.includes(b)))
  const fgMap: Result = v === 'pass' && blind.length ? 'weak' : v
  // The backdrop the SNES shows: CGRAM color 0 through color math. CGWSEL's
  // PPU byte may be missing; then the value the NMI writes there is used.
  const [cgadsub, fixed] = [num(ppu.CGADSUB_2131), num(ppu.COLDATA_2132?.fixedColorBgr555)]
  const cgwselPpu = num(ppu.CGWSEL_2130)
  const cgwsel = cgwselPpu ?? num(ppu.CGWSEL_2130?.wramColorAddition)
  const math = cgadsub === null || fixed === null || cgwsel === null ? null : D.backdropRgb(cgram, cgadsub, cgwsel, fixed) // prettier-ignore
  let backNote = 'backdrop: CGRAM color 0, the capture holds no color math registers'
  if (math) backNote = `backdrop: CGRAM color 0 with COLDATA ${hex(fixed!)} per CGADSUB ${hex(cgadsub!)}`
  else if (cgwsel !== null) backNote = `backdrop: CGRAM color 0, CGWSEL ${hex(cgwsel)} makes color math window-dependent` // prettier-ignore
  if (cgwsel !== null && cgwselPpu === null) {
    backNote += `, CGWSEL ${hex(cgwsel)} from WRAM ColorAddition (the PPU byte is not recorded)`
  }

  // Mesen's picture of each layer, at the load sample and in every window,
  // with the VRAM, CGRAM, OAM and registers read on the frame it shows. Its
  // scroll registers are what the PPU drew with: for BG1 and BG2, the NMI's
  // copy of Layer1/2 X/Y plus the screen-shake offset (bank_00.asm:296-314);
  // the camera variables have moved on whenever a layer scrolls or shakes.
  const regsOf = (p: Rec) => Object.fromEntries(REGS.map(k => [k, num(p[k]) ?? regs[k]])) as Regs
  const refs: Ref[] = []
  for (const [view, dir] of ['', ...wins.map(w => `windows/${w.name}/`)].entries())
    for (const name of ['bg1', 'bg2', 'bg3', 'obj']) {
      const f = `${dir}layer_${name}`
      const png = read(f + '.png')
      if (!png) continue
      const [side, pd, pv] = [json(f + '.json'), json(f + '_data.json'), read(f + '_vram.bin')]
      const scroll = [['BG1HOFS_210D', 'BG1VOFS_210E'], ['BG2HOFS_210F', 'BG2VOFS_2110'], ['BG3HOFS_2111', 'BG3VOFS_2112']].map(q => q.map(k => num(pd?.[k]))) // prettier-ignore
      const own = pv && pd && scroll.flat().every(v => v !== null) ? { scroll: scroll as number[][], regs: regsOf(pd), vram: pv, oam: read(f + '_oam.bin'), cgram: read(f + '_cgram.bin') } : undefined // prettier-ignore
      // The sentinel is a CGRAM color (BGR555), widened as Mesen widens it.
      const sw = num(side?.transparentSentinelBgr555)
      const sentinel = sw === null ? null : D.bgr555(new Uint8Array([sw & 255, sw >> 8]), 0)
      const irq = num(pd?.statusBar?.irqLine)
      refs.push({ name, png, x: num(pd?.camera?.layer1X), y: num(pd?.camera?.layer1Y), sentinel, view, own, ...(irq !== null && irq >= 0 ? { irqLine: irq } : {}) }) // prettier-ignore
    }
  const screens = new Set(refs.map(r => `${r.x},${r.y}`)).size
  const clear = refs.length && refs.every(r => r.sentinel) ? [] : ['SNES transparency unverified: no sentinel color in the picture sidecars'] // prettier-ignore

  // The map's sprite list, placed where the list puts it. An entry is seen
  // when its index is a live slot's listIndex in a window's picture data:
  // keyed on the index, never the id, which the loader may convert.
  const listed = list(json('sprites.json')?.entries, 'sprites.json entries')
  const aliveIn = new Map<number, string[]>()
  let tracked = false
  for (const w of wins)
    for (const n of ['bg1', 'bg2', 'bg3', 'obj']) {
      const f = `windows/${w.name}/layer_${n}_data.json`
      const data = json(f)
      if (n === 'obj' && data?.slots) tracked = true
      for (const k of list(data?.slots, `${f} slots`).map(s => num(s.listIndex)))
        if (k !== null && k !== 0xff) aliveIn.set(k, [...(aliveIn.get(k) ?? []), w.name])
    }
  const spriteList = listed.map((e, k) => ({
    id: num(e.id) ?? -1,
    x: num(e.x) ?? 0,
    y: num(e.y) ?? 0,
    alive: tracked ? [...new Set(aliveIn.get(num(e.index) ?? k) ?? [])] : null, // a window's pictures each list it once
  }))
  const seenAlive = spriteList.filter(e => e.alive?.length).length

  // Each list sprite as it first drew (sprite_spawns.json), placed at its
  // list position. Mario's entries (playerOamEntries) are only dropped from
  // the window comparison.
  const sp = json('sprite_spawns.json')
  const player = list(sp?.playerOamEntries, 'sprite_spawns.json playerOamEntries').map(Number)
  const records = list(sp?.spawns, 'sprite_spawns.json spawns')
  const lost = new Map(list(sp?.unrecorded, 'sprite_spawns.json unrecorded').map(u => [num(u.listIndex), String(u.reason)])) // prettier-ignore
  const recordedFrames: D.SpritePiece[][][] = []
  const spawns: D.Spawn[] = spriteList.map((e, k) => {
    const index = num(listed[k].index) ?? k
    const rec = records.find(r => num(r.listIndex) === index)
    const [lx, ly] = [num(rec?.listX) ?? e.x, num(rec?.listY) ?? e.y]
    const none = { id: e.id, x: lx, y: ly, pieces: null, obsel: regs.OBSEL_2101 }
    if (!sp) return { ...none, reason: 'The capture has no sprite_spawns.json' }
    if (!rec) return { ...none, reason: `Its spawn was not recorded: ${lost.get(index) ?? 'no reason given'}` } // prettier-ignore
    const { recorded, ...drawnFrame } = spriteFrame(rec, regs.OBSEL_2101)
    recordedFrames[k] = recorded
    return { ...none, ...drawnFrame }
  })
  const listNote = !spriteList.length
    ? []
    : tracked
      ? [`sprite list: ${seenAlive} of ${spriteList.length} entries seen alive in a window`]
      : [`sprite list: ${spriteList.length} entries, liveness not recorded`]

  // Layer 2 as the map loaded it: a preset tilemap, or objects in the Map16
  // buffer with their own base and stride, stated by map16_grid.json
  // `layer2`. A layout it does not state is refused. The palette OR the
  // game's Layer 2 strip upload applies is taken exactly as the capture
  // recorded it, never inferred from the tileset here.
  const l2j = json('l2_tilemap.json') ?? {}
  const l2Source = String(l2j.l2Source ?? 'preset')
  const l2s = gm.layer2 ?? null
  const orRec = l2j.paletteOrApplied as Rec | null | undefined
  const orMask = orRec ? num(orRec.applied) : null
  const orNote =
    l2Source !== 'objects' ? '' :
    orRec === undefined ? 'Layer 2 palette OR not recorded' :
    orRec === null || orMask === null ? `Layer 2 palette OR unavailable: ${String(l2j.paletteOrReason ?? orRec?.reason ?? 'no reason given')}` :
    `Layer 2 palette OR ${String(orRec.applied)} as recorded (object tileset ${String(orRec.objectTileset)}, OR ${String(orRec.orMask)} when tileset ${String(orRec.compareTileset)}, else ${String(orRec.defaultMask)})` // prettier-ignore
  const l2: GridMeta | null = l2s
    ? { ...meta, orientation: String(l2s.orientation), screens: D.parseNum(l2s.screens), bytesPerScreen: D.parseNum(l2s.stride), base: D.parseNum(l2s.base), ...(orMask ? { wordOr: orMask } : {}) } // prettier-ignore
    : null
  // The Layer 2 check's camera: Layer2X/Y at the sample and in each window, never assumed.
  const l2cam = [num(ppu.camera?.layer2X), num(ppu.camera?.layer2Y)]
  const blindWin = wins.find(w => w.l2.includes(null) || w.bg2sc === null)
  const l2Problem =
    l2Source !== 'objects' ? '' :
    !l2 ? 'map16_grid.json states no layer2 layout' :
    !['horizontal', 'vertical'].includes(l2.orientation) || Object.values(l2).some(v => Number.isNaN(v)) ? 'map16_grid.json layer2 is incomplete' :
    l2.orientation === 'vertical' && gm.inScreen?.vertical !== VERTICAL_RULE ? `layer2 is vertical and the in-screen layout is not ${VERTICAL_RULE}` :
    D.gridDims(l2).cols !== l2s.cols || D.gridDims(l2).rows !== l2s.rows ? `layer2 is ${D.gridDims(l2).cols}x${D.gridDims(l2).rows} by stride, sidecar says ${l2s.cols}x${l2s.rows}` :
    grid.length < meta.highOffset + l2.base + l2.screens * l2.bytesPerScreen ? 'map16_grid.bin is shorter than layer2 needs' :
    l2cam.includes(null) ? 'ppu.json has no camera.layer2X/Y' :
    blindWin ? `window ${blindWin.name} has no camera.layer2X/Y or BG2SC_2108 in layer_bg1_data.json` : '' // prettier-ignore
  const background = l2Source === 'preset' ? 'preset' : l2Source === 'none' ? 'none' : l2Source === 'objects' && !l2Problem ? 'objects' : 'refused' // prettier-ignore
  const refused =
    background === 'refused'
      ? [`Background refused (rule l2-layout): ${l2Problem || `Layer 2 source '${l2Source}' is not one this tool draws`}`] // prettier-ignore
      : []
  // Object Layer 2 gets the BG1 check's twin: its grid + defs against the
  // BG2 tilemap the game uploaded, in every strip it holds. The strip window
  // is the same rule, from Layer2XPos/YPos (bank_05.asm:952-964, 967-980).
  const l2Checks =
    background === 'objects'
      ? [{ ...inp, bg1sc: regs.BG2SC_2108, camX: l2cam[0]!, camY: l2cam[1]! },
         ...wins.map(w => ({ ...inp, vram: w.vram, bg1sc: w.bg2sc!, camX: w.l2[0]!, camY: w.l2[1]! }))].map(i => D.checkBg1({ ...i, meta: l2!, pipe: D.NO_PIPES })) // prettier-ignore
      : []
  const l2Oracle = l2Checks.length
    ? { compared: l2Checks.reduce((n, c) => n + c.compared, 0), mismatches: l2Checks.flatMap(c => c.mismatches) } // prettier-ignore
    : null
  const l2v = l2Oracle ? D.verdict(l2Oracle) : null
  // The status bar is not map data. status_bar_cells.json names the BG3
  // tilemap words it occupies; every map cell on those words is neither
  // drawn nor compared. Without it, the status bar is included.
  const bar = json('status_bar_cells.json')
  const barWords = new Set((bar?.available ? list(bar.tilemapWordAddrs, 'status_bar_cells.json tilemapWordAddrs') : []).map(Number)) // prettier-ignore
  const hideBg3 = new Set<number>()
  for (let ty = 0; ty < 64; ty++)
    for (let tx = 0; tx < 64; tx++) if (barWords.has(D.tilemapWordAddr(regs.BG3SC_2109, tx, ty))) hideBg3.add(ty * 64 + tx) // prettier-ignore
  const barNote = hideBg3.size ? 'status bar excluded' : bar && !bar.available ? `status bar included: not identified (${String(bar.reason)})` : 'status bar included' // prettier-ignore
  // Effects is compared below each picture's status-bar interrupt line
  // (docs/capture-viewer.md, Status bar band).
  const bg3Refs = refs.filter(r => r.name === 'bg3' && r.view > 0)
  const lines = [...new Set(bg3Refs.map(r => r.irqLine))]
  const bandNote =
    bg3Refs.length && !lines.includes(undefined)
      ? `Effects compared below each picture's status-bar interrupt line (${lines.join(', ')})`
      : 'Effects compared on every line where a picture has no status-bar interrupt line'
  const drawIn: D.LevelInput = {
    meta,
    order: order!,
    pipe: { lo: pipe!.lo, hi: pipe!.hi, strips: pipe!.strips },
    background,
    ...(background === 'objects' ? { l2: l2! } : {}),
    ...(hideBg3.size ? { hideBg3: [...hideBg3] } : {}),
    grid: b64(grid),
    defs: b64(defs),
    vram: b64(vram),
    regs,
    spawns,
  }
  const drawn = D.renderLevel(drawIn)

  // The map's sprites against their coded appearance: each drawn sprite
  // must be one of the frames sprite_spawns.json recorded for it from the
  // running game, from its first real frame on. What a screen showed later
  // does not decide the map, so windows are not consulted here.
  const spriteMismatches: SpriteMismatch[] = []
  let spritesChecked = 0
  spawns.forEach((s, k) => {
    if (!s.pieces) return
    spritesChecked++
    if ((recordedFrames[k] ?? []).some(p => D.sameShape(p, s.pieces!))) return
    const xs = s.pieces.map(p => p.dx)
    const ys = s.pieces.map(p => p.dy)
    spriteMismatches.push({
      k,
      id: s.id,
      x: s.x + Math.min(...xs),
      y: s.y + D.REF_DY + Math.min(...ys),
      w: Math.max(...s.pieces.map(p => p.dx + D.objSize(s.obsel, p.large)[0])) - Math.min(...xs),
      h: Math.max(...s.pieces.map(p => p.dy + D.objSize(s.obsel, p.large)[1])) - Math.min(...ys),
      reason: `Sprite ${hex(s.id)} (list entry ${k}) is not drawn as any frame recorded for it`,
    })
  })
  const pipeGuesses = drawn.guesses.filter(g => g.kind === 'pipe').length
  const spriteGuesses = drawn.guesses.length - pipeGuesses
  const byReason = new Map<string, number>()
  for (const e of spawns.filter(e => e.reason)) byReason.set(e.pieces ? e.reason : 'not drawn', (byReason.get(e.pieces ? e.reason : 'not drawn') ?? 0) + 1) // prettier-ignore
  const sources = [
    "Foreground: the Map16 grid and defs at load, with each strip's pipe set from its first build (stripBuilds), as the map is first seen", // prettier-ignore
    background === 'preset' ? 'Background: the BG2 tilemap at load, tiled 1:1 from the map origin' : background === 'objects' ? 'Background: the Layer 2 object grid (Map16) at load, drawn with the same defs' : background === 'none' ? 'no Background' : 'Background refused', // prettier-ignore
    'Effects: the BG3 tilemap at load, tiled 1:1 from the map origin',
    sp ? "Sprites: the map's sprite list, each as coded, on the sprite's first real frame, with Mario at the map's start" : 'no Sprites (no sprite_spawns.json)', // prettier-ignore
    'graphics and palettes at load',
  ]
  // Our drawing code against Mesen's picture of each layer, per window, from
  // that picture's own frame data. A picture it cannot compare, or one that
  // compares no pixel, leaves the layer not compared.
  const snes: Record<string, number[] | null> = {}
  for (const name of ['bg1', 'bg2', 'bg3', 'obj']) {
    const counts = refs
      .filter(r => r.name === name && r.view > 0)
      .map(r => {
        const [v, png] = [r.own, pngRgba(r.png)]
        if (!v || !png) return null
        const w = { ...v, pal: D.palette(v.cgram ?? cgram), player, hideBg3: [...hideBg3] }
        const local = D.windowLayer(name, w, png.w, png.h)
        if (name === 'bg3' && r.irqLine !== undefined)
          local.skip.fill(1, 0, Math.min(png.h, r.irqLine + 1) * png.w)
        const pic = { x: 0, y: 0, w: png.w, h: png.h, px: png.px, sentinel: r.sentinel, skip: local.skip } // prettier-ignore
        const { n, differ } = D.refDiff(local.rgba, local.opaque, png.w, png.h, pic, 0)
        return n ? differ : null
      })
    snes[name] = counts.length && counts.every(c => c !== null) ? (counts as number[]) : null
  }
  const snesResult = (c: number[] | null): Result => (!c ? 'not compared' : c.some(x => x > 0) ? 'fail' : 'pass') // prettier-ignore

  const n = (x: number) => x.toLocaleString('en-US')
  const px = (c: number[] | null) => (c ? `${n(c.reduce((a, b) => a + b, 0))} px on ${c.length} screen${c.length === 1 ? '' : 's'}` : 'not compared') // prettier-ignore
  const rows: Checks['rows'] = [
    {
      layer: 'Foreground',
      result: worst([fgMap, snesResult(snes.bg1)]),
      map: `${n(oracle.mismatches.length)} of ${n(oracle.compared)} cells differ`,
      snes: px(snes.bg1),
      note: [
        v !== 'pass' ? '' : blind.length ? `weak: would also pass ${blind.join(', ')}` : 'shift and stride errors would fail',
        meta.orientation === 'vertical' && v === 'pass' && !blind.includes('half-screen term') ? 'half-screen term tested' : '',
      ].filter(Boolean).join('. '), // prettier-ignore
    },
    {
      layer: 'Background',
      result: refused.length ? 'not compared' : worst([...(l2v ? [l2v] : []), snesResult(snes.bg2)]), // prettier-ignore
      map: refused.length ? 'refused' : l2Oracle ? `${n(l2Oracle.mismatches.length)} of ${n(l2Oracle.compared)} Background object cells differ` : 'preset tilemap, no map check', // prettier-ignore
      snes: px(snes.bg2),
      note: [orNote, ...refused].filter(Boolean).join('. '),
    },
    { layer: 'Effects', result: snesResult(snes.bg3), map: 'no map check', snes: px(snes.bg3), note: `${barNote}. ${bandNote}` }, // prettier-ignore
    {
      layer: 'Sprites',
      result: 'informational',
      map: spritesChecked ? `${n(spriteMismatches.length)} of ${n(spritesChecked)} drawn sprites differ from their recorded frames` : 'no recorded frames', // prettier-ignore
      snes: px(snes.obj),
      note: spriteMismatches.length ? spriteMismatches.map(m => `entry ${m.k} ${hex(m.id)}`).join(', ') : 'never fails the map', // prettier-ignore
    },
  ]
  const summaryChecks: Checks = {
    rows,
    lists: [
      {
        title: `Guesses (${drawn.guesses.length})`,
        items: [
          ...(pipeGuesses ? [`${pipeGuesses} pipe colors: these columns were not drawn during capture`] : []), // prettier-ignore
          ...(!spriteGuesses ? [] : !sp ? ['sprites: the capture has no sprite_spawns.json'] : [...byReason].map(([r, k]) => `${k} sprites: ${r === 'not drawn' ? 'not drawn, their spawn not recorded' : r.split(';')[0].toLowerCase()}`)), // prettier-ignore
        ],
      },
      { title: 'Changed at runtime', items: runtimeNote },
      {
        title: 'Coverage',
        items: [
          `${oracle.ids} Map16 ids in strips ${oracle.strips.join('..')}`,
          `SNES pictures for ${screens} screen${screens === 1 ? '' : 's'}`,
          ...(wins.length ? [`Foreground checked at ${inputs.length} camera positions`] : []),
          `Foreground cells compared per camera position: ${checks.map(c => n(c.compared)).join(', ')}`,
          ...listNote,
          ...boundaryNote,
          ...clear,
          ...(meta.orientation === 'vertical' ? ['vertical map: Background and Effects tiling is untested on real data'] : []), // prettier-ignore
        ],
      },
      { title: 'Drawn from load-time data', items: sources },
      { title: 'Backdrop', items: [backNote] },
    ].filter(l => l.items.length),
  }
  const deciding = worst(rows.slice(0, 3).map(r => r.result))
  const verdictOut: Verdict = deciding === 'not compared' ? 'incomplete' : deciding === 'informational' ? 'pass' : deciding // prettier-ignore
  const detail = [
    ...rows.map(
      r => `${r.layer} ${r.result}: ${r.map}, SNES ${r.snes}${r.note ? ` (${r.note})` : ''}`,
    ),
    ...summaryChecks.lists.flatMap(l => l.items),
  ].join('; ')

  const data: ViewerData = {
    level,
    ...dims,
    draw: drawIn,
    backdrop: math ?? D.bgr555(cgram, 0),
    cgram: b64(cgram),
    screens,
    spriteList,
    mismatches: oracle.mismatches.slice(0, 500),
    spriteMismatches,
  }
  return {
    verdict: verdictOut,
    detail,
    checks: summaryChecks,
    mapCheck: fgMap,
    mismatches: oracle.mismatches,
    data,
    snes,
    orientation: meta.orientation,
    screens: meta.screens,
    refs,
    l2: l2Oracle ? { verdict: l2v!, differ: l2Oracle.mismatches.length, compared: l2Oracle.compared } : null, // prettier-ignore
    refused,
  }
}

/** 1 on any failure; 2 when a map or one of its deciding checks went uncompared, since that is not a pass. */
export function exitCode(verdicts: Verdict[]): number {
  if (verdicts.includes('fail')) return 1
  return !verdicts.length || verdicts.some(v => v === 'incomplete' || v === 'unavailable') ? 2 : 0
}

// Inlined into the page beside viewer() by page(); free names on purpose,
// since an import would compile to a module reference the page lacks.
declare const decodeWord: typeof D.decodeWord, map16Id: typeof D.map16Id
declare const palette: typeof D.palette, layerOrder: typeof D.layerOrder
declare const stripOf: typeof D.stripOf, cellWord: typeof D.cellWord
declare const renderLevel: typeof D.renderLevel, unb64: typeof D.unb64

/** Runs in the page, not in Node. */
function viewer(V: ViewerData) {
  const $ = (id: string) => document.getElementById(id) as HTMLInputElement
  const pal = palette(unb64(V.cgram))
  const [grid, defs] = [unb64(V.draw.grid), unb64(V.draw.defs)]
  const hasDef = (id: number) => id < defs.length >> 3
  // The map, drawn once from its data (renderLevel takes no window data).
  const { W, H, layers: L, guesses } = renderLevel(V.draw)
  const guessAt = new Map(guesses.map(g => [g.c + ',' + g.r, g.reason]))

  const cv = document.getElementById('cv') as HTMLCanvasElement
  ;[cv.width, cv.height] = [W, H]
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(W, H)
  function composite() {
    const on = [0, 1, 2, 3].map(l => $('l' + l).checked)
    const plane = $('plane').value
    const passes = layerOrder(V.draw.regs.BGMODE_2105).filter(
      ([l, p]) => on[l] && (l === 3 || plane === 'both' || (plane === 'high') === (p === 1)),
    )
    const back = $('back').checked
    const d = img.data
    for (let i = 0; i < W * H; i++) {
      let ci = -1
      for (const [l, p] of passes)
        if (L[l].idx[i] && L[l].pri[i] === p) {
          ci = L[l].idx[i]
          break
        }
      if (ci < 0 && !back) d[i * 4 + 3] = 0
      else d.set(ci < 0 ? [...V.backdrop, 255] : [...pal.subarray(ci * 3, ci * 3 + 3), 255], i * 4)
    }
    ctx.putImageData(img, 0, 0)
  }
  const vert = V.draw.meta.orientation === 'vertical'

  const stage = $('stage')
  const box = (x: number, y: number, s: number, z: number, cls = '') =>
    `<i class="${cls}" style="left:${x * s * z}px;top:${y * s * z}px;width:${s * z}px;height:${s * z}px"></i>`
  function layout() {
    const z = +$('zoom').value
    stage.style.width = W * z + 'px'
    stage.style.height = H * z + 'px'
    const g = $('grid')
    g.style.display = $('showgrid').checked ? '' : 'none'
    g.style.backgroundImage = `repeating-linear-gradient(${vert ? 'to bottom' : 'to right'},
      #f0f 0 1px, transparent 1px ${256 * z}px)`
    g.innerHTML = ''
    for (let s = 0; s < V.draw.meta.screens; s++) {
      const t = g.appendChild(document.createElement('span'))
      t.textContent = hex(s, 2, '')
      t.style.left = (vert ? 2 : s * 256 * z + 3) + 'px'
      t.style.top = (vert ? s * 256 * z + 2 : 2) + 'px'
    }
    const m = $('mm')
    m.style.display = $('showmm').checked ? '' : 'none'
    m.innerHTML =
      V.mismatches.map(e => box(e.tx, e.ty, 8, z)).join('') +
      V.spriteMismatches.map(e => `<i style="left:${e.x * z}px;top:${e.y * z}px;width:${e.w * z}px;height:${e.h * z}px"></i>`).join('') // prettier-ignore
    const g2 = $('gs')
    g2.style.display = $('showguess').checked ? '' : 'none'
    g2.innerHTML = guesses.map(g => box(g.c, g.r, 16, z, 'g')).join('')
    const sl = $('sl')
    sl.style.display = $('showlist').checked ? '' : 'none'
    sl.innerHTML = V.spriteList
      .map(e => `<i class="${e.alive?.length === 0 ? 'n' : ''}" style="left:${e.x * z}px;top:${e.y * z}px;width:${16 * z}px;height:${16 * z}px">${hex(e.id, 0, '')}</i>`)
      .join('') // prettier-ignore
  }
  const mmAt = new Map(V.mismatches.map(e => [e.tx + ',' + e.ty, e]))
  const M = V.draw
  stage.addEventListener('mousemove', e => {
    const z = +$('zoom').value
    const b = stage.getBoundingClientRect()
    const x = Math.floor((e.clientX - b.left) / z)
    const y = Math.floor((e.clientY - b.top) / z)
    const [c, r] = [x >> 4, y >> 4]
    if (c >= V.cols || r >= V.rows) return
    const id = map16Id(grid, M.meta, c, r)
    // Left: the cell. Right: guesses and sprites. Both columns keep their
    // space, and the panel is fixed, so the text never moves the map.
    const lines = [`px ${x},${y}  tile ${hex(c, 3)},${hex(r, 2)}  Map16 ${hex(id, 3)}`]
    const side: string[] = []
    const guess = guessAt.get(c + ',' + r)
    if (guess) side.push(guess)
    for (const m of V.spriteMismatches)
      if (x >= m.x && y >= m.y && x < m.x + m.w && y < m.y + m.h) side.push('MISMATCH ' + m.reason)
    V.spriteList.forEach((e, k) => {
      if (x < e.x || y < e.y || x >= e.x + 16 || y >= e.y + 16) return
      const seen = e.alive === null ? 'liveness not recorded' : e.alive.length ? `seen alive in ${e.alive.join(', ')}` : 'not seen alive in any window' // prettier-ignore
      const f = V.draw.spawns[k]?.frames
      side.push(`Sprite list entry ${k}: id ${hex(e.id, 2)}`, `  ${seen}`, ...(f ? [`  ${f}`] : []))
    })
    ;['TL', 'TR', 'BL', 'BR'].forEach((n, q) => {
      if (!hasDef(id)) return
      const w = cellWord(defs, M.order, M.pipe, id, stripOf(M.meta, c, r), q).word
      const f = decodeWord(w)
      const flips = `${f.flipX ? ' flipX' : ''}${f.flipY ? ' flipY' : ''}`
      lines.push(`${n} ${hex(w, 4)} char ${hex(f.char, 3)} row ${f.pal} pri ${f.prio}${flips}`)
    })
    const mm = mmAt.get((x >> 3) + ',' + (y >> 3))
    if (mm) lines.push(`MISMATCH VRAM ${hexWord(mm.vram)} vs grid+defs ${hexWord(mm.derived)}`)
    $('hc').textContent = lines.join('\n')
    $('hs').textContent = side.join('\n')
  })
  document.querySelectorAll('input,select').forEach(el =>
    el.addEventListener('input', () => {
      if (/^(l\d|plane|back)$/.test(el.id)) composite()
      layout()
    }),
  )
  composite()
  layout()
}

const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
/** A result as a CSS class: its own name, or `nc` for not compared. */
const cls = (r: string) => (r === 'not compared' ? 'nc' : r)

const CSS = `body{background:#1e1e1e;color:#ccc;font:13px system-ui,sans-serif;margin:0 12px}
#bar{position:sticky;top:0;background:#252526;padding:6px;z-index:9;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
#wrap{overflow:auto;max-height:calc(100vh - 16em)}#stage{position:relative}#stage>*{position:absolute;left:0;top:0}
#cv{image-rendering:pixelated;width:100%;height:100%}#grid,#mm,#gs{width:100%;height:100%;pointer-events:none}
#grid span{position:absolute;color:#f0f;font:bold 11px monospace}#mm i,#gs i{position:absolute}
#mm i{outline:1px solid red}#gs i{outline:1px dashed #fb3}
#sl{width:100%;height:100%;pointer-events:none}#sl i{position:absolute;outline:1px solid #3cf;color:#3cf;font:bold 9px monospace}
#sl i.n{outline-style:dotted;color:#f6c}
#hover{position:fixed;left:12px;right:12px;bottom:0;height:9.5em;box-sizing:border-box;display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:4px 8px;background:#252526;border-top:1px solid #444;z-index:10}
#hover>div{white-space:pre;font:12px monospace;overflow:hidden;min-width:0}body{padding-bottom:10.5em}td,th{padding:2px 8px;text-align:left;vertical-align:top}
details{background:#252526;padding:4px 10px;margin:6px 0;max-width:62em}details li{margin:3px 0}
a{color:#4fc1ff}.pass{color:#4ec94e}.fail{color:#f14c4c}.weak,.nc,.incomplete,.unavailable{color:#e0a030}
header{padding:8px 0;display:flex;gap:12px;align-items:baseline}header b{font-size:16px}
.badge{border:1px solid currentColor;border-radius:9px;padding:0 8px;font-weight:bold}
#checks{max-width:62em}#checks h4{margin:10px 0 2px}#checks ul{margin:0;padding-left:20px}#checks table{border-collapse:collapse}
#checks td,#checks th{border-bottom:1px solid #333}`

const help = (screens: number) => `<details><summary>How to read this page</summary>
<p>This page shows one map as the game has it at load, not what any screen showed. Every
graphics layer is drawn once from data copied out of the running game when the map
loaded:</p>
<ul>
<li><b>Foreground</b>: the map's tile grid and tile definitions.</li>
<li><b>Background</b>: the background tilemap, tiled at full size from the map's left
edge; in the game it scrolls slower than the foreground, which is not shown.</li>
<li><b>Effects</b>: the BG3 tilemap, tiled at full size from the map's left edge like
the background; parallax is not shown. The status bar tiles the capture names are left out.</li>
<li><b>Sprites</b>: the map's sprite list, each as coded, on the
sprite's first real frame, with Mario at the map's start, placed where the list puts it.
Its check is informational and never fails the map.</li>
<li><b>Backdrop</b>: the color behind everything.</li>
</ul>
<p>Look for garbled tiles, wrong colors, shifted chunks, or seams at the magenta screen
numbers.</p>
<ul>
<li><b>both / low / high planes</b> shows only tiles drawn behind or in front of sprites.
<b>zoom</b> enlarges; <b>screens</b> shows the magenta screen borders and numbers.</li>
<li>The badge at the top is the map's result. <b>pass</b> means every check matched.
<b>weak</b> means it matched, but the data was too uniform to catch every kind of mistake.
<b>fail</b> means some differ. <b>incomplete</b> means a check could not run; Checks says which.</li>
<li><b>Checks</b>, below the map, has a row per graphics layer. The map check compares every foreground
tile the game put in video memory with the one we drew, for the part of the map the game had
loaded.</li>
<li>The next column counts the pixels where our drawing code differs from the SNES, over
${screens} captured screen${screens === 1 ? '' : 's'}. Mesen saved each graphics layer's picture with the data the game held on that
frame, and we draw that screen again from the same data. This checks our drawing code; it does
not decide what the map contains. The index page shows the same counts.</li>
<li>A tile the game changed while the capture scrolled (a sprite generating it) is checked
against what the game generated, not counted as a failure. The page still shows it as loaded.</li>
<li><b>Mismatches</b>: red outlines mark tiles or sprites that disagree with the data.</li>
<li><b>Show guesses</b>: amber dashed outlines are cells drawn from the best data we have
but not confirmed, or sprites we could only mark. Hover one to see why.</li>
<li><b>Sprite list</b>: a cyan box with the sprite's id marks where the map's sprite
list places each sprite. A dotted pink box was never seen alive in any captured screen.</li>
<li>Hover anywhere to see the tile number and how it is built.</li>
</ul></details>`

/**
 * capture_draw.ts's whole module, real-bundled with esbuild into one IIFE
 * (#421 step 2 round 3). capture_draw.ts re-exports its 8x8 pixel
 * primitives from the core (src/rom/render/TileResolver.ts) instead of
 * defining them itself, so `foreground`/`drawBg` call an imported binding.
 * `Function.prototype.toString` on such a function reflects whatever the
 * HOST bundler rewrote that call to (tsx/esbuild: `(0,import_X.f)(...)`;
 * Vite's SSR transform: `__vite_ssr_import_0__.f(...)`) - a reference
 * meaningless outside that bundler's own module scope, which broke every
 * generated page (#421 step 2 round 3, confirmed on $0C3). A real bundle
 * has no such artifact: esbuild resolves the import itself and the output
 * references nothing outside the IIFE. Built once and cached, since
 * `runCapture` calls `page()` once per map.
 */
let captureDrawBundle: string | undefined
function bundleCaptureDraw(): string {
  if (captureDrawBundle === undefined) {
    const result = buildSync({
      entryPoints: [join(__dirname, 'capture_draw.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: '__CaptureDraw',
      platform: 'browser',
      target: 'es2020',
    })
    captureDrawBundle = result.outputFiles[0].text
  }
  return captureDrawBundle
}

/** The page's script: the real capture_draw.ts bundle, its exports unpacked to their own names (so `viewer`'s bare references to them still resolve), then the viewer. */
function pageScript(v: ViewerData) {
  const decls = Object.keys(Draw).map(k => `var ${k} = __CaptureDraw.${k};`)
  const json = JSON.stringify(v).replace(/</g, '\\u003c')
  return `${bundleCaptureDraw()}\n${decls.join('\n')}\nvar __name=function(f){return f};\n(${viewer.toString()})(${json})`
}

export function page(L: Level): string {
  const v = L.data!
  const box = (id: string, text: string, title: string, on = true) =>
    `<input type=checkbox id=${id}${on ? ' checked' : ''}><label for=${id} title="${esc(title)}">${text}</label>`
  return `<!doctype html><meta charset=utf-8><title>Capture ${esc(v.level)}</title><style>${CSS}</style>
<header><a href="../index.html">index</a> <b>map ${esc(v.level)}</b> <span class="badge ${L.verdict}">${L.verdict}</span></header>
<div id=bar>${box('l0', 'Foreground', 'BG1, from the Map16 grid and defs')}
${box('l1', 'Background', "Background tiled from the map's left edge; parallax not shown.")}
${box('l2', 'Effects', 'BG3, 2bpp: the whole tilemap as loaded, tiled 1:1 from the map origin, without the status bar tiles the capture names. Parallax is not shown')}
${box('l3', 'Sprites', 'OBJ: the map sprite list, each as coded on its first real frame. Its check is informational and never fails the map')}
${box('back', 'Backdrop', 'CGRAM color 0 through color math with the fixed color, as Checks says under Backdrop. SMW writes its sky color to COLDATA (bank_00.asm:5868-5883), not to CGRAM')}
<select id=plane aria-label="Tile planes" title="Tilemap word bit 13"><option value=both>both planes</option>
<option value=low>low plane</option><option value=high>high plane</option></select>
<label for=zoom>zoom</label><input id=zoom type=range min=1 max=4 value=2>
${box('showgrid', 'screens', 'Magenta screen borders with screen numbers in hex')}
${box('showmm', 'Mismatches', 'Red: VRAM differs from grid + defs')}
${box('showguess', 'Show guesses', 'Amber: drawn from unconfirmed data; hover for the reason')}
${box('showlist', 'Sprite list', 'Cyan: where the map sprite list places each sprite, with its id; dotted pink: never seen alive in a window')}
</div>
<div id=wrap><div id=stage><canvas id=cv></canvas><div id=grid></div><div id=mm></div><div id=gs></div><div id=sl></div></div></div>
<div id=hover><div id=hc></div><div id=hs></div></div>
${checksHtml(L.checks)}
${help(v.screens)}
<script>${pageScript(v)}</script>`
}

/** The Checks section below the map: a row per layer, then one idea per line. */
function checksHtml(c: Checks | undefined): string {
  if (!c) return ''
  const rows = c.rows.map(r => `<tr><td>${r.layer}<td class="${cls(r.result)}">${esc(r.result)}<td>${esc(r.map)}<td>${esc(r.snes)}<td>${esc(r.note)}`) // prettier-ignore
  const lists = c.lists.map(l => `<h4>${esc(l.title)}</h4><ul>${l.items.map(i => `<li>${esc(i)}`).join('')}</ul>`) // prettier-ignore
  return `<section id=checks><h3>Checks</h3>
<table><tr><th>graphics layer<th>result<th>map check<th>drawing code vs SNES<th>note
${rows.join('\n')}</table>
${lists.join('\n')}</section>`
}

/** Write whole or not at all, and never hold the file: a reader never sees half a page. */
function writeAtomic(path: string, text: string) {
  writeFileSync(path + '.tmp', text)
  renameSync(path + '.tmp', path)
}

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n
})
/** CRC-32 as zip stores it, in JS for Node 20, where zlib has no crc32. */
export function crc32Js(b: Uint8Array): number {
  let c = -1
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8)
  return ~c >>> 0
}
const native = (zlib as { crc32?: (b: Uint8Array) => number }).crc32
export const crc32 = native ? (b: Uint8Array) => native(b) >>> 0 : crc32Js

/**
 * The entries of a zip, `\` read as `/`, each inflated and checked once, on
 * first read. Stored and deflated entries only, each checked against its
 * size and CRC; anything else, a repeated name, or a damaged archive is a
 * CaptureFileError.
 */
export function unzip(zip: Buffer): Map<string, () => Buffer> {
  const fail = (why: string): never => {
    throw new CaptureFileError(`not a readable zip: ${why}`)
  }
  let end = zip.length - 22
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0) fail('no end of central directory')
  const out = new Map<string, () => Buffer>()
  const charge = budget(fail)
  let o = zip.readUInt32LE(end + 16)
  for (let k = zip.readUInt16LE(end + 10); k > 0; k--) {
    if (o + 46 > zip.length || zip.readUInt32LE(o) !== 0x02014b50) fail('bad central directory')
    const [method, crc, packed, size, local] = [zip.readUInt16LE(o + 10), zip.readUInt32LE(o + 16), zip.readUInt32LE(o + 20), zip.readUInt32LE(o + 24), zip.readUInt32LE(o + 42)] // prettier-ignore
    const name = zip.toString('utf8', o + 46, o + 46 + zip.readUInt16LE(o + 28)).replace(/\\/g, '/')
    o += 46 + zip.readUInt16LE(o + 28) + zip.readUInt16LE(o + 30) + zip.readUInt16LE(o + 32)
    if (name.endsWith('/')) continue
    if (out.has(name)) fail(`${name} appears twice`)
    let cached: Buffer | undefined
    out.set(name, () => (cached ??= read()))
    const read = () => {
      if (method !== 0 && method !== 8) fail(`${name} uses compression method ${method}`)
      charge(name, size)
      if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) fail(`${name} has no local header`) // prettier-ignore
      const at = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      let data = zip.subarray(at, at + packed)
      try {
        if (method === 8) data = inflateRawSync(data, { maxOutputLength: Math.max(1, size) })
      } catch (e) {
        fail(`${name}: ${(e as Error).message}`)
      }
      if (data.length !== size) fail(`${name} is ${data.length} bytes, its header says ${size}`)
      if (crc32(data) !== crc) fail(`${name} fails its CRC`)
      return data
    }
  }
  return out
}

/**
 * A file read through one descriptor: its size is charged from that
 * descriptor, then exactly that many bytes are read from it, so a file replaced
 * or grown after the size was taken is refused, not read in full. `afterSize`
 * is a test seam, run between the size and the read.
 */
export function readBounded(
  f: string,
  name: string,
  charge: (name: string, size: number) => void,
  afterSize?: () => void,
): Buffer {
  const fd = openSync(f, 'r')
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new CaptureFileError(`a capture folder: ${name} is not a regular file`)
    charge(name, st.size)
    afterSize?.()
    const buf = Buffer.alloc(st.size)
    let got = 0
    while (got < st.size) {
      const r = readSync(fd, buf, got, st.size - got, got)
      if (!r) break
      got += r
    }
    if (got !== st.size || readSync(fd, Buffer.alloc(1), 0, 1, st.size) > 0)
      throw new CaptureFileError(`a capture folder: ${name} changed size while being read (${st.size} bytes when opened)`) // prettier-ignore
    return buf
  } finally {
    closeSync(fd)
  }
}

/** A map's reader and window names, from its folder or its zip. */
export function openMap(path: string, name: string): { read: Reader; windows: string[] } {
  let read: Reader
  let files: string[]
  if (statSync(path).isDirectory()) {
    const charge = budget(why => {
      throw new CaptureFileError(`a capture folder: ${why}`)
    })
    const seen = new Map<string, Buffer | null>()
    read = n => {
      if (!seen.has(n)) {
        const f = join(path, n)
        seen.set(n, existsSync(f) ? readBounded(f, n, charge) : null)
      }
      return seen.get(n) ?? null
    }
    const w = join(path, 'windows')
    files = existsSync(w) ? readdirSync(w).filter(n => statSync(join(w, n)).isDirectory()).map(n => `windows/${n}/`) : [] // prettier-ignore
  } else {
    const entries = unzip(readFileSync(path))
    // Under `<name>/`, as zipping the map's folder writes it, or at the root.
    const pre = [...entries.keys()].every(n => n.startsWith(name + '/')) ? name + '/' : ''
    read = n => entries.get(pre + n)?.() ?? null
    files = [...entries.keys()].map(n => n.slice(pre.length))
  }
  const windows = new Set(files.flatMap(n => /^windows\/([^/]+)\//.exec(n)?.[1] ?? []))
  return { read, windows: [...windows].sort() }
}

/**
 * The two folders from the command line, null unless both are given.
 * Relative ones are taken from INIT_CWD, where npm was run: npm runs the
 * script from the repo root, so process.cwd() is not the user's folder.
 */
export function cliFolders(
  args: string[],
  env = process.env,
  cwd = process.cwd(),
): [string, string] | null {
  // prettier-ignore
  const base = env.INIT_CWD ?? cwd
  return args.length >= 2 && args[0] && args[1] ? [resolve(base, args[0]), resolve(base, args[1])] : null // prettier-ignore
}

/** The repo holding this script: pages never go inside it. */
export const REPO = resolve(__dirname, '..', '..')

/** Why `out` may not receive pages rendered from `input`, or ''. */
export function folderProblem(input: string, out: string, repo = REPO): string {
  // Through junctions and symlinks: the nearest existing ancestor's real path, plus the rest.
  const real = (p: string): string => {
    const full = resolve(p)
    if (existsSync(full)) return realpathSync.native(full)
    const up = dirname(full)
    return up === full ? full : join(real(up), basename(full))
  }
  const within = (a: string, b: string) => {
    const r = relative(real(b), real(a))
    return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r))
  }
  if (within(out, input)) return `the output folder ${out} is the captures folder or inside it`
  if (within(input, out)) return `the output folder ${out} contains the captures folder`
  if (within(out, repo)) return `the output folder ${out} is inside the repo; pages embed ROM-derived bytes` // prettier-ignore
  return ''
}

/**
 * Render every map in `input`, each a folder or a zip named by its id in
 * hex (optionally with a suffix, 105_spawns), into `out`: a page per map
 * and an index. Nothing is written to `input`, and `out` may not overlap it
 * or lie inside the repo.
 */
export function runCapture(input: string, out: string, log = console.log, repo = REPO): number {
  const problem = folderProblem(input, out, repo)
  if (problem) {
    log(`refused: ${problem}`)
    return 2
  }
  const maps = new Map<string, string>()
  for (const n of readdirSync(input).sort()) {
    const m = /^([0-9a-f]{3}(?:_\w+)?)(\.zip)?$/i.exec(n)
    const dir = statSync(join(input, n)).isDirectory()
    if (!m || dir === !!m[2]) continue
    if (maps.has(m[1])) log(`${m[1]}: both a folder and a zip; the folder is read`)
    if (dir || !maps.has(m[1])) maps.set(m[1], join(input, n))
  }
  const levels = [...maps.keys()].sort()
  const RANK: Record<Verdict, number> = { fail: 0, incomplete: 1, unavailable: 2, weak: 3, pass: 4 }
  const rows: { rank: number; html: string }[] = []
  const verdicts: Verdict[] = []
  for (const lv of levels) {
    const label = '$' + lv.slice(0, 3).toUpperCase() + lv.slice(3)
    const L = guarded(() => {
      const src = openMap(maps.get(lv)!, lv)
      return readLevel(src.read, label, src.windows)
    })
    verdicts.push(L.verdict)
    log(`${label}  ${L.verdict.padEnd(11)} ${L.detail}`)
    for (const m of L.mismatches.slice(0, 5)) {
      log(`      tile ${m.tx},${m.ty} map16 ${hex(m.id)}: VRAM ${hexWord(m.vram)} vs ${hexWord(m.derived)}`) // prettier-ignore
    }
    const file = join(out, lv, 'viewer.html')
    if (L.data) {
      mkdirSync(join(out, lv), { recursive: true })
      writeAtomic(file, page(L))
    } else if (existsSync(file)) unlinkSync(file)
    const link = L.data ? `<a href="${lv}/viewer.html">${esc(label)}</a>` : esc(label)
    const layers = (L.checks?.rows ?? []).slice(0, 3)
    const cells = layers.length ? layers.map(r => `<td class="${cls(r.result)}">${esc(r.result)}<br>${esc(r.map)}<br>SNES ${esc(r.snes)}`).join('') : '<td><td><td>' // prettier-ignore
    const why = L.verdict === 'unavailable' ? L.detail : layers.filter(r => r.result === 'fail' || r.result === 'not compared').map(r => `${r.layer} ${r.result}${r.note ? `: ${r.note}` : ''}`).join('; ') // prettier-ignore
    rows.push({
      rank: RANK[L.verdict],
      html: `<tr><td>${link}<td class=${L.verdict}>${L.verdict}${cells}<td>${L.orientation ?? ''}<td>${L.screens ?? ''}<td>${esc(why)}`, // prettier-ignore
    })
  }
  rows.sort((a, b) => a.rank - b.rank)
  mkdirSync(out, { recursive: true })
  writeAtomic(
    join(out, 'index.html'),
    `<!doctype html><meta charset=utf-8><title>Captures</title><style>${CSS}</style>
<h2>Mesen captures</h2><p>One row per map, failures first.</p>
<ul><li>Each layer: its result, the map check (grid and defs against what the game put in video memory), and the pixels where our drawing code differs from the SNES per captured screen.
<li>A map fails when any Foreground, Background or Effects check fails, and is incomplete when one of them could not run. Sprites never decide it.
<li>Effects is compared below the status-bar interrupt line, since above it the SNES draws the bar.</ul>
<table><tr><th>map<th>result<th>Foreground<th>Background<th>Effects<th>orientation<th>screens<th>reason
${rows.map(r => r.html).join('\n')}</table>`,
  )
  const count = (v: Verdict) => verdicts.filter(x => x === v).length
  log(
    `\n${levels.length} map(s): ${count('pass')} pass, ${count('weak')} weak, ${count('fail')} fail, ${count('incomplete') + count('unavailable')} not compared`,
  )
  log(`index: ${join(out, 'index.html')}`)
  return exitCode(verdicts)
}
