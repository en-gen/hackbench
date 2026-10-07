/**
 * The gfx layer's reducer: a run of 8x8 character edits folded into the
 * working copy as ONE decompress / re-encode pass (docs/layer-previews.md,
 * "Staged (gfx)"). src/project/WorkingRom.ts decides what a run is; this
 * module only changes bytes. Pure: no I/O, no project.
 *
 * Everything the fold lays out against comes from the BASE ROM: each dirty
 * file is re-encoded against the base's own stream, and the regions and
 * their capacities are the base's. Reading either from the working copy
 * would make the result depend on how earlier edits were grouped (a region
 * grown into its filler until it touches an outlier file merges with it).
 * From the base, the bytes are a function of the decoded pixels alone, so
 * folding a run and applying its characters one at a time agree.
 */
import { RomFile } from './RomFile'
import { COPIER_HEADER_SIZE, loromToOffset } from './addressing'
import {
  GFX_FILE_COUNT,
  checkStockCompression,
  checkWritableCompression,
  layoutArena,
  planRegions,
  readGfxFileTable,
} from './GfxArena'
import { GfxEncoder, GfxTable, encodeChecked } from './GfxTable'
import { encode } from './LcLz2'

export interface GfxCharPixel {
  x: number
  y: number
  value: number
}

/** One character's changed pixels in one GFX file. Only the pixels the user
 *  changed are held, so a layer carries no artwork it did not draw. */
export interface GfxCharEdit {
  file: number
  tile: number
  pixels: GfxCharPixel[]
}

/** A gfx layer the ROM cannot take, with the reason to show the user. */
export class GfxRefusal extends Error {
  constructor(
    reason: string,
    /** Bytes past the arena's capacity, when that is why. */
    readonly overage?: number,
  ) {
    super(reason)
    this.name = 'GfxRefusal'
  }
}

function view(bytes: Uint8Array): RomFile {
  return new RomFile('working', Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length))
}

/** What every fold lays out against: the base ROM and its own streams. */
export interface GfxBase {
  rom: RomFile
  /** Each file's stream in the base; empty where it cannot be read. */
  templates: Uint8Array[]
  /**
   * Buffer-absolute `[start, end)` ranges a fold rewrites: every region's
   * whole capacity and the three pointer tables. A word write there would be
   * silently undone by the next gfx layer. Empty when no gfx layer can apply.
   */
  guarded: [number, number][]
}

export function readGfxBase(base: Uint8Array): GfxBase {
  const rom = view(base)
  const table = readGfxFileTable(rom)
  const templates = table.map(f =>
    f.offset !== null && f.terminated
      ? new Uint8Array(rom.readAtFileOffset(f.offset, f.byteLength)!)
      : new Uint8Array(0),
  )
  const gate = checkStockCompression(rom)
  const hdr = rom.hasHeader ? COPIER_HEADER_SIZE : 0
  const guarded: [number, number][] = []
  if (gate.ok) {
    for (const r of planRegions(rom, table))
      guarded.push([hdr + r.start, hdr + r.start + r.capacity])
    for (const site of [gate.sites.lo, gate.sites.hi, gate.sites.bank]) {
      const o = loromToOffset(site, rom.romSize)
      if (o !== null) guarded.push([hdr + o, hdr + o + GFX_FILE_COUNT])
    }
  }
  return { rom, templates, guarded }
}

/** Bytes a write replaced: putting `old` back at `at` undoes it. */
export interface Overwritten {
  /** Buffer-absolute. */
  at: number
  old: Uint8Array
}

/**
 * Apply `edits`, in order, to `out` in place, and return what the writes
 * replaced (only the span of each write that actually changed). Throws
 * GfxRefusal, leaving `out` untouched, for a replaced decompressor, a missing
 * file or character, an unknown bit depth, a bad pixel, a stream that does
 * not round trip, a file the working copy cannot read, or an arena that
 * overflows.
 */
export function foldGfxRun(
  out: Uint8Array,
  hasHeader: boolean,
  base: GfxBase,
  edits: readonly GfxCharEdit[],
  encoder: GfxEncoder = encode,
): Overwritten[] {
  const rom = view(out)
  const gate = checkWritableCompression(rom)
  if (!gate.ok) throw new GfxRefusal(gate.reason)

  const table = GfxTable.load(rom)
  const order: number[] = [] // dirty files, first touched first
  for (const e of edits) {
    const t = table.checkTile(e.file, e.tile)
    if (t.status === 'refused') throw new GfxRefusal(`GFX ${e.file} char ${e.tile}: ${t.reason}`)
    for (const p of e.pixels) {
      const r = table.setPixel({ kind: 'gfxPixel', file: e.file, tile: e.tile, ...p })
      if (r.status === 'refused') throw new GfxRefusal(`GFX ${e.file} char ${e.tile}: ${r.reason}`)
    }
    if (!order.includes(e.file)) order.push(e.file)
  }

  const streams = table.files.map(f => f.template)
  for (const i of order) {
    const r = encodeChecked(i, table.files[i]!.bytes, base.templates[i]!, encoder)
    if (!r.ok) throw new GfxRefusal(r.reason)
    streams[i] = r.stream
  }

  const plan = layoutArena(rom, streams, base.rom)
  if (plan.status === 'overflow') throw new GfxRefusal(plan.reason, plan.overage)
  if (plan.status !== 'ok') throw new GfxRefusal(plan.reason)
  const at = hasHeader ? COPIER_HEADER_SIZE : 0 // ArenaWrite.offset excludes the copier header
  const replaced: Overwritten[] = []
  for (const w of plan.plan.writes) {
    const p = at + w.offset
    let i = 0
    let j = w.bytes.length - 1
    while (i <= j && out[p + i] === w.bytes[i]) i++
    while (j >= i && out[p + j] === w.bytes[j]) j--
    if (i <= j) replaced.push({ at: p + i, old: out.slice(p + i, p + j + 1) })
    out.set(w.bytes, p)
  }
  return replaced
}
