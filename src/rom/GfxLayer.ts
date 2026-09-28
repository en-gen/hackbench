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
import { COPIER_HEADER_SIZE } from './addressing'
import { checkStockCompression, layoutArena, readGfxFileTable } from './GfxArena'
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
}

export function readGfxBase(base: Uint8Array): GfxBase {
  const rom = view(base)
  const templates = readGfxFileTable(rom).map(f =>
    f.offset !== null && f.terminated
      ? new Uint8Array(rom.readAtFileOffset(f.offset, f.byteLength)!)
      : new Uint8Array(0),
  )
  return { rom, templates }
}

/**
 * Apply `edits`, in order, to `out` in place. Throws GfxRefusal, leaving
 * `out` untouched, for a replaced decompressor, an unknown bit depth, a bad
 * pixel, a stream that does not round trip, or an arena that overflows.
 */
export function foldGfxRun(
  out: Uint8Array,
  hasHeader: boolean,
  base: GfxBase,
  edits: readonly GfxCharEdit[],
  encoder: GfxEncoder = encode,
): void {
  const rom = view(out)
  const gate = checkStockCompression(rom)
  if (!gate.ok) throw new GfxRefusal(gate.reason)

  const table = GfxTable.load(rom)
  const order: number[] = [] // dirty files, first touched first
  for (const e of edits) {
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
  for (const w of plan.plan.writes) out.set(w.bytes, at + w.offset)
}
