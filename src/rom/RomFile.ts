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
   * Backing bytes. Type-asserted as `Buffer` for the host-side TS
   * callers (PaletteLoader, SmwRom, etc.) that want Buffer-only methods
   * like `readUInt16LE` and `toString('ascii')`. At runtime the value
   * may actually be a plain `Uint8Array` when constructed by the
   * webview from `postMessage`-delivered ROM bytes — that's safe
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
    const loromMapByte = this.buffer[hdrBase + 0x7FD5]
    // HiROM internal header: map mode byte at file offset $FFD5
    const hiromMapByte = this.buffer[hdrBase + 0xFFD5]

    const isLoRom = loromMapByte === 0x20 || loromMapByte === 0x30
    const isHiRom = hiromMapByte === 0x21 || hiromMapByte === 0x31

    if (isLoRom && !isHiRom) return 'lorom'
    if (isHiRom && !isLoRom) return 'hirom'
    if (isLoRom) return 'lorom'  // prefer LoROM if both match
    return 'unknown'             // default to LoROM behavior via readAt()
  }

  /**
   * Read bytes directly by ROM file offset, bypassing SNES address mapping.
   * Useful for contiguous data blocks (e.g. GFX files) that span LoROM bank
   * boundaries — linear addition of SNES addresses breaks at 32 KB boundaries.
   *
   * @param fileOffset  Byte offset from the start of ROM data (after any copier header).
   */
  readAtFileOffset(fileOffset: number, length: number): Buffer | null {
    const actualOffset = (this.hasHeader ? COPIER_HEADER_SIZE : 0) + fileOffset
    if (actualOffset < 0 || actualOffset + length > this.buffer.length) return null
    return this.buffer.slice(actualOffset, actualOffset + length) as Buffer
  }

  readAt(snesAddr: number, length: number): Buffer | null {
    const offset = this.mapMode === 'hirom'
      ? hiromToOffset(snesAddr, this.hasHeader)
      : loromToOffset(snesAddr, this.romSize, this.hasHeader)
    if (offset === null || offset + length > this.buffer.length) return null
    return this.buffer.slice(offset, offset + length) as Buffer
  }

  readByte(snesAddr: number): number | null {
    const buf = this.readAt(snesAddr, 1)
    return buf ? (buf[0] ?? null) : null
  }

  readWord(snesAddr: number): number | null {
    // Manual two-byte composition rather than `Buffer.readUInt16LE` so
    // RomFile can be backed by either a Node `Buffer` or a plain
    // `Uint8Array` — the webview gets the ROM bytes as a Uint8Array
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

  writeAt(snesAddr: number, data: Buffer | number[]): void {
    // Host-only: file-backed write needs Node's Buffer.copy. Webview
    // RomFiles never write back to ROM (the writeback path is the
    // extension host's responsibility).
    const offset = this.mapMode === 'hirom'
      ? hiromToOffset(snesAddr, this.hasHeader)
      : loromToOffset(snesAddr, this.romSize, this.hasHeader)
    if (offset === null) throw new Error(`Address ${snesAddr.toString(16)} is not writable (not ROM)`)
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
    bytes.copy(this.buffer, offset)
  }

  save(): void { fs.writeFileSync(this.filePath, this.buffer) }
  saveAs(destPath: string): void { fs.writeFileSync(destPath, this.buffer) }
}
