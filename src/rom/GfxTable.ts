/**
 * The decoded GFX sheets, and the source of truth while a user is painting.
 *
 * Held DECODED rather than re-encoded per stroke: re-compressing 50 files on
 * every brush stroke is not viable. The cost is that between an edit and a
 * save the cartridge bytes do not reflect the edit, so an emulator preview
 * shows unedited graphics until save. That is a deliberate tradeoff and the
 * UI has to say so.
 *
 * What gets PERSISTED is the pixel op, never the bytes it produces. See
 * src/rom/EditStack.ts: an op is intent, carries no cartridge bytes, and
 * survives the base cartridge changing underneath it. The arena rewrite
 * `planGfxSave` returns is derived on demand and thrown away.
 */
import { RomFile } from './RomFile'
import { BytePattern, WILD, findPattern } from './BytePattern'
import { bytesPerTile, decodeTilesBatch, setTilePixel } from './GraphicsDecoder'
import { inferGfxBpp, l3DepthUnknown } from './GfxLoader'
import { tryDecompress, encode } from './LcLz2'
import {
  ArenaResult,
  GFX_FILE_COUNT,
  checkStockCompression,
  layoutArena,
  readGfxFileTable,
} from './GfxArena'

/** One painted pixel. Serializable, and contains no cartridge bytes. */
export interface GfxPixelOp {
  kind: 'gfxPixel'
  file: number
  tile: number
  x: number
  y: number
  value: number
}

export type SetPixelResult = { status: 'ok' } | { status: 'refused'; reason: string }

/**
 * `UploadGFXFile`'s own tile counter (bank_00.asm:5431-5433): `LDY.B #$7F`
 * between the `STA`/`LDA` pair that brackets it, counted down to zero by the
 * `DEY / BPL` at 5475-5476, so the operand is tiles minus one.
 *
 * Read, not assumed. The operand is a wildcard here and the opcodes around
 * it are the anchor; measured, the run matches exactly once on 6 of 6
 * cartridges in this repo's corpus and reads $7F on all of them. Two matches
 * or none means we cannot say, and this returns null rather than 128.
 */
const TILE_COUNT_PATTERN: BytePattern = [0x8d, WILD, WILD, 0xa0, WILD, 0xad, WILD, WILD, 0xf0]
const TILE_COUNT_OPERAND = 4

export function readTilesPerFile(rom: RomFile): number | null {
  const hits = findPattern(rom, TILE_COUNT_PATTERN, 2)
  if (hits.length !== 1) return null
  const site = rom.readAtFileOffset(hits[0]!, TILE_COUNT_PATTERN.length)
  return site ? site[TILE_COUNT_OPERAND]! + 1 : null
}

export interface GfxFileState {
  index: number
  /** Decompressed bytes, painted in place. */
  bytes: Uint8Array
  /** The cartridge's own stream, kept as the re-encode template. Empty when
   *  the file could not be read back. */
  template: Uint8Array
  /** Null when the length fits no tile size: such a file is read-only until
   *  the user asserts a depth, matching the viewer's manual override. */
  bpp: 2 | 3 | 4 | null
  /** Set when `bpp` is null because the L3 range is unreadable, not the length. */
  depthUnknown?: string
  /** Why `bytes` is empty: an unreadable pointer table entry, or the reason
   *  `tryDecompress` gave. Unset when the file read cleanly. */
  readError?: string
  tileCount: number
  dirty: boolean
}

export class GfxTable {
  private constructor(
    readonly files: readonly GfxFileState[],
    /** Tiles the cartridge's upload loop reads per file, or null when the
     *  loop does not resolve. Separate from `tileCount`, which is how many
     *  tiles a file's bytes actually hold. */
    readonly tilesPerFile: number | null,
  ) {}

  static load(rom: RomFile): GfxTable {
    const files = readGfxFileTable(rom).map((f): GfxFileState => {
      const readable = f.offset !== null && f.terminated
      const template = readable
        ? new Uint8Array(rom.readAtFileOffset(f.offset!, f.byteLength)!)
        : new Uint8Array(0)
      const decoded = readable
        ? tryDecompress(template)
        : { ok: false as const, reason: 'the pointer table entry could not be read' }
      const bytes = decoded.ok ? decoded.bytes : new Uint8Array(0)
      const bpp = bytes.length > 0 ? inferGfxBpp(rom, f.index, bytes.length) : null
      return {
        index: f.index,
        bytes,
        template,
        bpp,
        ...(bpp === null && { depthUnknown: l3DepthUnknown(rom, bytes.length) ?? undefined }),
        ...(!decoded.ok && { readError: decoded.reason }),
        tileCount: bpp === null ? 0 : Math.floor(bytes.length / bytesPerTile(bpp)),
        dirty: false,
      }
    })
    return new GfxTable(files, readTilesPerFile(rom))
  }

  /** The 64 palette indices of one tile, or null when it does not exist. */
  tile(file: number, index: number): Uint8Array | null {
    const f = this.files[file]
    if (!f || f.bpp === null || index < 0 || index >= f.tileCount) return null
    return (
      decodeTilesBatch(
        f.bytes.subarray(index * bytesPerTile(f.bpp), (index + 1) * bytesPerTile(f.bpp)),
        f.bpp,
      )[0] ?? null
    )
  }

  /** Whether `tile` of `file` exists and can be painted at all. */
  checkTile(file: number, tile: number): SetPixelResult {
    const f = this.files[file]
    if (!f) return { status: 'refused', reason: `there is no GFX file ${file}` }
    if (f.bpp === null) {
      return {
        status: 'refused',
        reason: `GFX ${file} is read-only until a depth is asserted: ${f.depthUnknown ?? `${f.bytes.length} bytes fits no tile size`}`,
      }
    }
    if (!Number.isInteger(tile) || tile < 0 || tile >= f.tileCount) {
      return { status: 'refused', reason: `GFX ${file} has ${f.tileCount} tiles, not tile ${tile}` }
    }
    return { status: 'ok' }
  }

  setPixel(op: GfxPixelOp): SetPixelResult {
    const checked = this.checkTile(op.file, op.tile)
    if (checked.status === 'refused') return checked
    const f = this.files[op.file]!
    const bpp = f.bpp! // checkTile refused a null depth
    try {
      setTilePixel(f.bytes, op.tile * bytesPerTile(bpp), bpp, op.x, op.y, op.value)
    } catch (err) {
      return { status: 'refused', reason: (err as Error).message }
    }
    f.dirty = true
    return { status: 'ok' }
  }

  isDirty(): boolean {
    return this.files.some(f => f.dirty)
  }

  dirtyFiles(): number[] {
    return this.files.filter(f => f.dirty).map(f => f.index)
  }
}

/** Swappable only so the round-trip oracle can be proven able to fail. */
export type GfxEncoder = (data: Uint8Array, template?: Uint8Array) => Uint8Array

/**
 * Turn the table back into cartridge bytes.
 *
 * Every file is encoded, dirty or not, so the layout depends only on the
 * table and not on which files were touched. Each stream is then decompressed
 * again and compared against what it was built from: a stream that does not
 * reproduce its own bytes must not reach the cartridge, whatever its length.
 */
export function planGfxSave(
  rom: RomFile,
  table: GfxTable,
  encoder: GfxEncoder = encode,
): ArenaResult {
  const gate = checkStockCompression(rom)
  if (!gate.ok) return { status: 'unavailable', reason: gate.reason }

  const streams: Uint8Array[] = []
  for (let i = 0; i < GFX_FILE_COUNT; i++) {
    const f = table.files[i]
    const r = encodeChecked(
      i,
      f?.bytes ?? new Uint8Array(0),
      f?.template ?? new Uint8Array(0),
      encoder,
    )
    if (!r.ok) return { status: 'unavailable', reason: r.reason }
    streams.push(r.stream)
  }
  return layoutArena(rom, streams)
}

/**
 * Encode file `index` against `template`, and prove the stream decompresses
 * back to exactly `bytes`: one that does not must not reach the ROM,
 * whatever its length.
 */
export function encodeChecked(
  index: number,
  bytes: Uint8Array,
  template: Uint8Array,
  encoder: GfxEncoder = encode,
): { ok: true; stream: Uint8Array } | { ok: false; reason: string } {
  if (template.length === 0) {
    return { ok: false, reason: `GFX ${index} could not be read back, so it cannot be re-encoded` }
  }
  let stream: Uint8Array
  try {
    stream = encoder(bytes, template)
  } catch (err) {
    return { ok: false, reason: `GFX ${index} did not re-encode: ${(err as Error).message}` }
  }
  const decoded = tryDecompress(stream)
  if (!decoded.ok) {
    return {
      ok: false,
      reason: `GFX ${index} re-encoded to a stream that fails to decompress: ${decoded.reason}`,
    }
  }
  const back = decoded.bytes
  if (Buffer.compare(Buffer.from(back), Buffer.from(bytes)) !== 0) {
    return {
      ok: false,
      reason:
        `GFX ${index} re-encoded to a stream that decompresses to ${back.length} bytes of ` +
        `different content, not the ${bytes.length} bytes it was built from`,
    }
  }
  return { ok: true, stream }
}
