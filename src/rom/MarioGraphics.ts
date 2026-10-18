/**
 * The player-graphics buffer at $7E:2000 and the sprites that point Mario's tile
 * DMA at it (#980).
 *
 * MarioGFXDMA (SMWDisX bank_00.asm:4583-4605) uploads $40-byte pieces of this
 * buffer to OBJ VRAM word $6000 (row 1, chars 0-9) and $6100 (row 2, chars
 * $10-$19), five slots per row, two chars each, the source being DynGfxTilePtr
 * (rammap.asm:1321; row 2 is +$0A). A sprite that owns a slot sets that pointer
 * in its graphics routine, so the chars it draws are NOT the map's SP1 file:
 * the Podoboo (CODE_01E198, bank_01.asm:13180-13197) takes slot 3 of both rows
 * (chars 6, 7, $16, $17) from the buffer at +$6600 and +$6800. The slots are
 * read from the pointers WRAM holds after the sprite's own routine ran
 * (`uploadProbe`), not from the routine's bytes, so the call path is the run's.
 *
 * The buffer is built once at boot (CODE_00B888, bank_00.asm:6250-6290):
 * GFX33 (3bpp) is decompressed to $7E:2000 and expanded in place, backwards, to
 * 4bpp at the top of the area ($9D00-$ACFF), then GFX32 (Mario, 4bpp) is
 * decompressed over $7E:2000. Both pointers are read from the code's operands;
 * the routine itself is pinned by a SHA-256 over its fixed bytes.
 * Evidence scope: docs/rom/dynamic-sprite-gfx.md.
 */
import type { RomFile } from './RomFile'
import { cachedByVersion } from './RomFile'
import { findPattern, parsePattern as hex, type BytePattern } from './BytePattern'
import { fingerprint } from './Fingerprint'
import { parseStream, tryDecompress } from './LcLz2'
import { gfxSource } from './GfxLoader'
import type { CompressionCheck } from './GfxArena'
import { decode4bpp } from './GraphicsDecoder'

export const MARIO_GFX_BASE = 0x2000 // MarioGraphics, $7E:2000 (rammap.asm:2092)
const WRAM_BYTES = 0xb000 // up to the end of the expanded GFX33 ($ACFF)
export const DYN_GFX_TILE_PTR = 0x0d85 // rammap.asm:1321; one word per slot, row 2 at +$0A
const ROW_SLOTS = 5
const PIECE = 0x40 // bytes per slot (HW_DMACNT, bank_00.asm:4586)

/**
 * A boot routine found by its head and recognised by a hash of all of it: the head is under 8 bytes, `sha256` covers all `length` bytes with the operand slots (`bootFingerprint`) zeroed.
 */
export interface BootRoutine {
  anchor: BytePattern
  length: number
  sha256: string
}

// CODE_00B888 through the GFX32 pointer load at CODE_00B8D7 (bank_00.asm:6250-6290), 84 bytes. The anchor is the first
// seven bytes with the GFX33 operand word wild: under 8 bytes, so no literal run of the cart's code is committed, and
// several sites may match it; the SHA-256 alone says which is the routine. The JSR is pinned to the stock decompressor
// entry by that hash. Lunar Magic replaces its body (a direct GFX33 decompress to $7E:7D00, then a JMP to CODE_00B8D7):
// 141 of the 146 hack-corpus ROMs do, and those are not stock here.
export const STOCK_BOOT: BootRoutine = {
  anchor: hex('c2 10 a0 ?? ?? 84 8a'),
  length: 84,
  sha256: '41bd1df9519507a44f4eb96ded5761a2aafa0bfc36151c60290fbb3d8a54b05b',
}

// MarioGFXDMA's two upload loops (bank_00.asm:4580-4605), 64 bytes, hashed whole. A hack that patches them can send the
// slots anywhere, so the buffer is not read for it. One site in the vanilla ROM (one machine, one cart).
export const STOCK_DMA: BootRoutine = {
  anchor: hex('a9 00 60 8d 16 21 a2'),
  length: 64,
  sha256: 'ea61acf43341bd988f651b7339bc1c11300be7ef98639680c74d3883e7519355',
}

/** Operand offsets in the routine: GFX33 low, high, bank; expansion top (word); source top (word); GFX32 low/high (word). */
const OP = { g33Lo: 3, g33Hi: 4, g33Bank: 8, top: 30, srcTop: 35, g32: 80 }
const MASKED = [OP.g33Lo, OP.g33Hi, OP.g33Bank, OP.top, OP.top + 1, OP.srcTop, OP.srcTop + 1, OP.g32, OP.g32 + 1] // prettier-ignore

/** The hash `BootRoutine.sha256` holds: SHA-256 of `bytes` with the operand slots zeroed. */
export function bootFingerprint(bytes: Uint8Array): string | null {
  const masked = Uint8Array.from(bytes)
  for (const o of MASKED) masked[o] = 0
  return fingerprint(masked)
}

export type MarioBuffer = { ok: true; bytes: Uint8Array } | { ok: false; reason: string }
const BUILT = new WeakMap<RomFile, { version: number; value: MarioBuffer }>()

/** `bytes[a - $2000]` is WRAM $7E:a after boot; or why the ROM's build of it is not the one read here. */
export function readMarioGraphics(rom: RomFile): MarioBuffer {
  return cachedByVersion(BUILT, rom, () => buildMarioGraphics(rom, gfxSource(rom)))
}

/** `readMarioGraphics` without the cache; the compression gate and the routine are injectable (tests build both). */
export function buildMarioGraphics(
  rom: RomFile,
  src: CompressionCheck,
  boot: BootRoutine = STOCK_BOOT,
  dma: BootRoutine | undefined = boot === STOCK_BOOT ? STOCK_DMA : undefined, // tests that inject a boot bring their own
): MarioBuffer {
  const fail = (reason: string): MarioBuffer => ({ ok: false, reason })
  const sites = findPattern(rom, boot.anchor).filter(at => {
    const b = rom.readAtFileOffset(at, boot.length)
    return b !== null && bootFingerprint(b) === boot.sha256
  })
  if (sites.length !== 1) return fail('the boot routine that builds the Mario graphics buffer is not the stock one') // prettier-ignore
  if (
    dma &&
    findPattern(rom, dma.anchor).filter(
      at => fingerprint(rom.readAtFileOffset(at, dma.length)) === dma.sha256,
    ).length !== 1
  )
    // prettier-ignore
    return fail('the routine that uploads the Mario graphics buffer to VRAM is not the stock one')
  if (!src.ok) return fail(src.reason)
  const site = rom.readAtFileOffset(sites[0]!, boot.length)!
  const w = (i: number) => site[i]!
  const lo = w(OP.g33Lo) | (w(OP.g33Hi) << 8)
  const at33 = (w(OP.g33Bank) << 16) | lo
  const top = (w(OP.top + 1) << 8) | w(OP.top) // GraphicsUncompPtr: last word of the expansion
  const srcTop = (w(OP.srcTop + 1) << 8) | w(OP.srcTop) // LDX: last source byte of the 3bpp file
  const g33 = rom.readAt(at33, 0x6000)
  if (!g33 || lo < 0x8000) return fail('GFX33 does not point into ROM')
  const s33 = parseStream(g33)
  const d33 = tryDecompress(g33, { order: src.order })
  if (!s33.terminated || !d33.ok) return fail('GFX33 does not decompress')
  // ReadByte (bank_00.asm:6405-6413) carries into the next bank at $FFFF; CODE_00B8D7 then sets the low word.
  const end = w(OP.g33Bank) * 0x8000 + lo - 0x8000 + s33.byteLength
  const at32 = (Math.floor(end / 0x8000) << 16) | (w(OP.g32 + 1) << 8) | w(OP.g32)
  const g32 = rom.readAt(at32, 0x8000)
  const d32 = g32 && tryDecompress(g32, { order: src.order })
  if (!d32 || !d32.ok) return fail('GFX32 does not decompress')
  const buf = new Uint8Array(WRAM_BYTES - MARIO_GFX_BASE)
  if (d33.bytes.length > buf.length || d32.bytes.length > buf.length) return fail('a GFX file overruns the buffer') // prettier-ignore
  buf.set(d33.bytes)
  const bad = expandTo4bpp(buf, srcTop, top - MARIO_GFX_BASE)
  if (bad) return fail(bad)
  buf.set(d32.bytes)
  return { ok: true, bytes: buf }
}

/**
 * CODE_00B8AD's loop (bank_00.asm:6267-6288): the 3bpp tiles ending at `buf[x]` become 4bpp tiles ending at the
 * word `buf[p]`, walking down. Per 24-byte tile: its 8 plane-2 bytes as words with a zero high byte, then its 8
 * plane-0/1 words. Null, or why the operands put it outside the buffer.
 */
export function expandTo4bpp(buf: Uint8Array, x: number, p: number): string | null {
  if (x >= buf.length || p < 1 || p + 1 >= buf.length)
    return 'the expansion points outside the buffer'
  for (;;) {
    for (let i = 0; i < 8; i++, x--, p -= 2) [buf[p], buf[p + 1]] = [buf[x]!, 0]
    for (let i = 0; i < 8; i++, p -= 2) {
      x--
      ;[buf[p], buf[p + 1]] = [buf[x]!, buf[x + 1]!]
      x--
      if (x < 0) return null
    }
    if (p < 0) return 'the expansion runs below the buffer'
  }
}

/** The decoded pixels (64 palette indices, as getCharPixels gives) of the OBJ chars a sprite's pointers fill, keyed by hackbench char ($400 + OBJ char). */
export type DynamicChars =
  { ok: true; chars: Map<number, Uint8Array> } | { ok: false; reason: string }

/** One DynGfxTilePtr slot (0-4 row 1, 5-9 row 2) a sprite's run pointed at WRAM address `ptr`. */
export interface SlotUpload {
  slot: number
  ptr: number
}

/**
 * A `Probe` for `runOnce`: after each pass, the slots whose pointer differs from the one before the passes began
 * (probe -1), so the slots are the ones the sprite's own routine wrote in the run the draw came from.
 * `byPass[p]` is cumulative. A routine that writes the value already there is not seen (that slot keeps the map's chars).
 */
export function uploadProbe(): {
  probe: (pass: number, wram: Uint8Array) => void
  byPass: SlotUpload[][]
} {
  const ptr = (w: Uint8Array, i: number) =>
    w[DYN_GFX_TILE_PTR + 2 * i]! | (w[DYN_GFX_TILE_PTR + 2 * i + 1]! << 8)
  let before: number[] = []
  const byPass: SlotUpload[][] = []
  const probe = (pass: number, wram: Uint8Array) => {
    const now = Array.from({ length: 2 * ROW_SLOTS }, (_, i) => ptr(wram, i))
    if (pass < 0) before = now
    else byPass[pass] = now.flatMap((p, slot) => (p !== before[slot] ? [{ slot, ptr: p }] : []))
  }
  return { probe, byPass }
}

/** Chars a slot lands on: row 1 is OBJ chars 0-9 (VRAM word $6000), row 2 $10-$19 ($6100). */
const slotChars = (slot: number): number[] => {
  const [row, s] = [Math.floor(slot / ROW_SLOTS), slot % ROW_SLOTS]
  return [row * 0x10 + s * 2, row * 0x10 + s * 2 + 1]
}

/** The chars `uploads` put on the OBJ sheet, decoded from the buffer; or why a pointer is not into it. */
export function charsFromUploads(
  buffer: MarioBuffer,
  uploads: readonly SlotUpload[],
): DynamicChars {
  if (!buffer.ok) return buffer
  const chars = new Map<number, Uint8Array>()
  for (const { slot, ptr } of uploads) {
    const from = ptr - MARIO_GFX_BASE
    const piece = buffer.bytes.subarray(from, from + PIECE)
    if (slot < 0 || slot >= 2 * ROW_SLOTS || from < 0 || piece.length !== PIECE) {
      return { ok: false, reason: `a slot points outside the player buffer ($${ptr.toString(16)})` }
    }
    slotChars(slot).forEach((c, i) => chars.set(0x400 + c, decode4bpp(piece, i * 32)))
  }
  return { ok: true, chars }
}
