/**
 * The gfx layer's reducer: a run of 8x8 character edits folded into the
 * working copy as ONE decompress / re-encode pass (docs/layer-previews.md,
 * "Staged (gfx)"). src/project/WorkingRom.ts decides what a run is; this
 * module only changes bytes. Pure: no I/O, no project.
 *
 * Every dirty file is re-encoded against the BASE ROM's own stream, never
 * against whatever an earlier run left there. That is what makes the result
 * a function of the decoded pixels alone, so folding a run and applying its
 * characters one at a time produce the same bytes. Clean files keep the
 * stream they already have.
 */
import { RomFile } from './RomFile'
import { COPIER_HEADER_SIZE } from './addressing'
import { GFX_FILE_COUNT, checkStockCompression, layoutArena, readGfxFileTable } from './GfxArena'
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

/** The base ROM's own stream for each file; empty where it cannot be read. */
export function baseGfxTemplates(base: Uint8Array): Uint8Array[] {
  const rom = view(base)
  return readGfxFileTable(rom).map(f =>
    f.offset !== null && f.terminated
      ? new Uint8Array(rom.readAtFileOffset(f.offset, f.byteLength)!)
      : new Uint8Array(0),
  )
}

/**
 * Apply `edits`, in order, to `out` in place. Throws GfxRefusal, leaving
 * `out` untouched, for a replaced decompressor, an unknown bit depth, a bad
 * pixel, a stream that does not round trip, or an arena that overflows.
 */
export function foldGfxRun(
  out: Uint8Array,
  hasHeader: boolean,
  templates: readonly Uint8Array[],
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

  const streams = table.files.slice(0, GFX_FILE_COUNT).map(f => f.template)
  for (const i of order) {
    const r = encodeChecked(i, table.files[i]!.bytes, templates[i] ?? new Uint8Array(0), encoder)
    if (!r.ok) throw new GfxRefusal(r.reason)
    streams[i] = r.stream
  }

  const plan = layoutArena(rom, streams)
  if (plan.status === 'overflow') throw new GfxRefusal(plan.reason, plan.overage)
  if (plan.status !== 'ok') throw new GfxRefusal(plan.reason)
  const at = hasHeader ? COPIER_HEADER_SIZE : 0 // ArenaWrite.offset is cart-relative
  for (const w of plan.plan.writes) out.set(w.bytes, at + w.offset)
}
