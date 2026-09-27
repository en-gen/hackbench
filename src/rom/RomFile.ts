import * as fs from 'fs'
import { hasCopierHeader, loromToOffset, hiromToOffset, COPIER_HEADER_SIZE } from './addressing'

/**
 * SNES ROM map mode (from internal header byte at $FFD5 / $7FD5).
 *   $20 / $30 = LoROM (fast or slow)
 *   $21 / $31 = HiROM (fast or slow)
 */
export type RomMapMode = 'lorom' | 'hirom' | 'unknown'

/**
 * Wraps a ROM file buffer and provides addressed reads via SNES LoROM/HiROM mapping.
 *
 * Map mode is auto-detected from the internal ROM header:
 *   - LoROM header: map mode byte at file offset $7FD5
 *   - HiROM header: map mode byte at file offset $FFD5
 * Both are checked; the one with a valid map mode byte wins. If both match (unlikely),
 * LoROM is preferred. If neither matches, 'unknown' is returned and LoROM is used
 * as the default.
 */
export class RomFile {
  readonly filePath: string
  /**
   * Backing bytes, and the one mutation path `version` does not see. Left
   * public because three callers want the whole ROM at once; nothing writes
   * an element through it, so `writeAt` is the only way the bytes move.
   *
   * Type-asserted as `Buffer` for the host-side TS
   * callers (PaletteLoader, SmwRom, etc.) that want Buffer-only methods
   * like `readUInt16LE` and `toString('ascii')`. At runtime the value
   * may actually be a plain `Uint8Array` when constructed by the
   * webview from `postMessage`-delivered ROM bytes - that's safe
   * because the webview side only calls `readByte` / `readWord` (both
   * refactored to byte-indexed access that works on either type).
   */
  readonly buffer: Buffer
  readonly hasHeader: boolean
  readonly romSize: number
  readonly mapMode: RomMapMode

  constructor(filePath: string, buffer: Buffer | Uint8Array) {
    this.filePath = filePath
    this.buffer = buffer as Buffer
    this.hasHeader = hasCopierHeader(buffer.length)
    this.romSize = buffer.length - (this.hasHeader ? COPIER_HEADER_SIZE : 0)
    this.mapMode = this._detectMapMode()
  }

  static load(filePath: string): RomFile {
    return new RomFile(filePath, fs.readFileSync(filePath))
  }

  /** Construct a RomFile from raw bytes. Used by the webview to
   *  reconstruct a reader from the `Uint8Array` shipped in the
   *  modelPayload. */
  static fromBytes(filePath: string, bytes: Uint8Array): RomFile {
    return new RomFile(filePath, bytes)
  }

  private _detectMapMode(): RomMapMode {
    const hdrBase = this.hasHeader ? COPIER_HEADER_SIZE : 0

    // LoROM internal header: map mode byte at file offset $7FD5
    const loromMapByte = this.buffer[hdrBase + 0x7fd5]
    // HiROM internal header: map mode byte at file offset $FFD5
    const hiromMapByte = this.buffer[hdrBase + 0xffd5]

    const isLoRom = loromMapByte === 0x20 || loromMapByte === 0x30
    const isHiRom = hiromMapByte === 0x21 || hiromMapByte === 0x31

    if (isLoRom && !isHiRom) return 'lorom'
    if (isHiRom && !isLoRom) return 'hirom'
    if (isLoRom) return 'lorom' // prefer LoROM if both match
    return 'unknown' // default to LoROM behavior via readAt()
  }

  /**
   * Read bytes directly by ROM file offset, bypassing SNES address mapping.
   * Useful for contiguous data blocks (e.g. GFX files) that span LoROM bank
   * boundaries - linear addition of SNES addresses breaks at 32 KB boundaries.
   *
   * @param fileOffset  Byte offset from the start of ROM data (after any copier header).
   */
  readAtFileOffset(fileOffset: number, length: number): Buffer | null {
    const actualOffset = (this.hasHeader ? COPIER_HEADER_SIZE : 0) + fileOffset
    if (actualOffset < 0 || actualOffset + length > this.buffer.length) return null
    return this._copy(actualOffset, length)
  }

  readAt(snesAddr: number, length: number): Buffer | null {
    const offset =
      this.mapMode === 'hirom'
        ? hiromToOffset(snesAddr, this.hasHeader)
        : loromToOffset(snesAddr, this.romSize, this.hasHeader)
    if (offset === null || offset + length > this.buffer.length) return null
    return this._copy(offset, length)
  }

  /** Up to `max` bytes at `snesAddr`, fewer when the ROM ends first. */
  readUpTo(snesAddr: number, max: number): Buffer | null {
    const offset =
      this.mapMode === 'hirom'
        ? hiromToOffset(snesAddr, this.hasHeader)
        : loromToOffset(snesAddr, this.romSize, this.hasHeader)
    if (offset === null || offset >= this.buffer.length) return null
    return this._copy(offset, Math.min(max, this.buffer.length - offset))
  }

  /**
   * A detached copy of a byte range, never a view onto `buffer`.
   *
   * `Buffer.prototype.slice` is `subarray`, so a `Buffer`-backed cart used
   * to hand readers a live window and a write through one moved no
   * `version`; `Uint8Array.prototype.slice` already copied, so it depended
   * on how the RomFile was built. Latent, not live: all 102 `readAt` sites
   * checked. Called through `Uint8Array.prototype.slice` and not
   * `Buffer.from` because the webview bundle has no `Buffer`; species
   * dispatch keeps a `Buffer` backing's result a `Buffer`.
   */
  private _copy(offset: number, length: number): Buffer {
    return Uint8Array.prototype.slice.call(this.buffer, offset, offset + length) as Buffer
  }

  readByte(snesAddr: number): number | null {
    const buf = this.readAt(snesAddr, 1)
    return buf ? (buf[0] ?? null) : null
  }

  readWord(snesAddr: number): number | null {
    // Manual two-byte composition rather than `Buffer.readUInt16LE` so
    // RomFile can be backed by either a Node `Buffer` or a plain
    // `Uint8Array` - the webview gets the ROM bytes as a Uint8Array
    // across the postMessage boundary and constructs a RomFile from it.
    const buf = this.readAt(snesAddr, 2)
    if (!buf) return null
    const lo = buf[0] ?? 0
    const hi = buf[1] ?? 0
    return (hi << 8) | lo
  }

  readString(snesAddr: number, length: number): string {
    // Host-only: depends on Node's Buffer.toString. Webview RomFiles
    // are read-only and don't hit this path.
    const buf = this.readAt(snesAddr, length)
    return buf ? buf.toString('ascii').replace(/\0/g, ' ').trimEnd() : ''
  }

  /** Bumped by every `writeAt`. Lets a cache keyed on this `RomFile`
   *  notice that the bytes underneath it changed, which tests that plant
   *  bytes rely on. Not persisted and not part of the ROM. */
  private _version = 0
  get version(): number {
    return this._version
  }

  /**
   * File offset a SNES address maps to, or null if it is not in ROM.
   *
   * Exposed because a patch is expressed in FILE offsets (it is applied to the
   * raw byte array before the emulator ever reads it), while everything that
   * locates level data works in SNES addresses. Callers previously had no way
   * to cross that boundary without re-deriving the mapMode and copier-header
   * branches below, which is exactly the duplication that goes stale.
   */
  fileOffsetOf(snesAddr: number): number | null {
    return this.mapMode === 'hirom'
      ? hiromToOffset(snesAddr, this.hasHeader)
      : loromToOffset(snesAddr, this.romSize, this.hasHeader)
  }

  writeAt(snesAddr: number, data: Buffer | number[]): void {
    // Host-only: file-backed write needs Node's Buffer.copy. Webview
    // RomFiles never write back to ROM (the writeback path is the
    // extension host's responsibility).
    const offset =
      this.mapMode === 'hirom'
        ? hiromToOffset(snesAddr, this.hasHeader)
        : loromToOffset(snesAddr, this.romSize, this.hasHeader)
    if (offset === null)
      throw new Error(`Address ${snesAddr.toString(16)} is not writable (not ROM)`)
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
    bytes.copy(this.buffer, offset)
    this._version++
  }

  save(): void {
    fs.writeFileSync(this.filePath, this.buffer)
  }
  saveAs(destPath: string): void {
    fs.writeFileSync(destPath, this.buffer)
  }
}

/**
 * Memoizes a per-`RomFile` computation, keyed on `version` so a `writeAt`
 * (which bumps it) invalidates the cache instead of a gate answering a scan
 * made before the write. A caller that re-derives the same site once per
 * level -- 512 times over -- would otherwise re-scan a multi-MB ROM 512 times.
 */
export function cachedByVersion<T>(
  cache: WeakMap<RomFile, { version: number; value: T }>,
  rom: RomFile,
  compute: () => T,
): T {
  const hit = cache.get(rom)
  if (hit && hit.version === rom.version) return hit.value
  const value = compute()
  cache.set(rom, { version: rom.version, value })
  return value
}
