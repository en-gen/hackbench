/**
 * The player-graphics buffer at $7E:2000 and the sprites that point Mario's tile
 * DMA at it (#980).
 *
 * MarioGFXDMA (SMWDisX bank_00.asm:4583-4605) uploads $40-byte pieces of this
 * buffer to OBJ VRAM word $6000 (row 1, chars 0-9) and $6100 (row 2, chars
 * $10-$19), five slots per row, two chars each, the source being DynGfxTilePtr
 * (rammap.asm:1321; row 2 is +$0A). A sprite that owns a slot sets that pointer
 * in its graphics routine, so the chars it draws are NOT the level's SP1 file:
 * the Podoboo (CODE_01E198, bank_01.asm:13180-13197) takes slot 3 of both rows
 * (chars 6, 7, $16, $17) from the buffer at +$6600 and +$6800.
 *
 * The buffer is built once at boot (CODE_00B888, bank_00.asm:6250-6290):
 * GFX33 (3bpp) is decompressed to $7E:2000 and expanded in place, backwards, to
 * 4bpp at the top of the area ($9D00-$ACFF), then GFX32 (Mario, 4bpp) is
 * decompressed over $7E:2000. Both pointers are read from the code's operands.
 * Evidence scope: docs/rom/dynamic-sprite-gfx.md.
 */
import type { RomFile } from './RomFile'
import { cachedByVersion } from './RomFile'
import { findPattern, parsePattern as hex, type BytePattern } from './BytePattern'
import { parseStream, tryDecompress } from './LcLz2'
import { gfxSource } from './GfxLoader'
import { decode4bpp } from './GraphicsDecoder'

export const MARIO_GFX_BASE = 0x2000 // MarioGraphics, $7E:2000 (rammap.asm:2092)
const WRAM_BYTES = 0xb000 // up to the end of the expanded GFX33 ($ACFF)
const DYN_GFX_TILE_PTR = 0x0d85 // rammap.asm:1321; one word per slot, row 2 at +$0A
const ROW_SLOTS = 5
const PIECE = 0x40 // bytes per slot (HW_DMACNT, bank_00.asm:4586)

// CODE_00B888 through the GFX32 pointer load at CODE_00B8D7 (bank_00.asm:6250-6290). The JSR is pinned to
// the stock decompressor entry; operand slots: GFX33 low/high/bank, expansion top, source top, GFX32 low/high.
const BUILD = hex(
  'c2 10 a0 ?? ?? 84 8a a9 ?? 85 8c a0 00 20 84 00 a9 7e 85 02 20 de b8 a9 7e 85 8f c2 30 a9 ?? ?? 85 8d ' +
    'a2 ?? ?? a0 08 00 bf 00 20 7e 29 ff 00 87 8d ca c6 8d c6 8d 88 d0 ef a0 08 00 ca bf 00 20 7e 87 8d ' +
    'ca 30 09 c6 8d c6 8d 88 d0 ef 80 d6 a9 ?? ?? 85 8a',
)

export type MarioBuffer = { ok: true; bytes: Uint8Array } | { ok: false; reason: string }
const BUILT = new WeakMap<RomFile, { version: number; value: MarioBuffer }>()

/** `bytes[a - $2000]` is WRAM $7E:a after boot; or why the ROM's build of it is not the one read here. */
export function readMarioGraphics(rom: RomFile): MarioBuffer {
  return cachedByVersion(BUILT, rom, () => build(rom))
}

function build(rom: RomFile): MarioBuffer {
  const fail = (reason: string): MarioBuffer => ({ ok: false, reason })
  const hits = findPattern(rom, BUILD)
  if (hits.length !== 1) return fail('the boot routine that builds the Mario graphics buffer is not the stock one') // prettier-ignore
  const src = gfxSource(rom)
  if (!src.ok) return fail(src.reason)
  const site = rom.readAtFileOffset(hits[0]!, BUILD.length)!
  const w = (i: number) => site[i]!
  const at33 = (w(8) << 16) | (w(4) << 8) | w(3)
  const top = (w(31) << 8) | w(30) // GraphicsUncompPtr: last word of the expansion
  const srcTop = (w(36) << 8) | w(35) // LDX: last source byte of the 3bpp file
  const g33 = rom.readAt(at33, 0x6000)
  if (!g33 || (w(3) | (w(4) << 8)) < 0x8000) return fail('GFX33 does not point into ROM')
  const s33 = parseStream(g33)
  const d33 = tryDecompress(g33, { order: src.order })
  if (!s33.terminated || !d33.ok) return fail('GFX33 does not decompress')
  // ReadByte (bank_00.asm:6405-6413) carries into the next bank at $FFFF; CODE_00B8D7 then sets the low word.
  const end = w(8) * 0x8000 + ((w(4) << 8) | w(3)) - 0x8000 + s33.byteLength
  const at32 = (Math.floor(end / 0x8000) << 16) | (w(81) << 8) | w(80)
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

/** The decoded pixels (64 palette indices, as getCharPixels gives) of the OBJ chars a sprite's pointer fills, keyed by hackbench char ($400 + OBJ char). */
export type DynamicChars =
  { ok: true; chars: Map<number, Uint8Array> } | { ok: false; reason: string }

// CODE_01E198 (bank_01.asm:13180-13197): A = 8 << 5, + base, to one slot, + step, to another. Operands: base, step,
// the two DynGfxTilePtr slot addresses.
const PODOBOO = hex(
  'a9 01 20 ?? ?? c2 20 a9 ?? ?? 0a 0a 0a 0a 0a 18 69 ?? ?? 8d ?? ?? 18 69 ?? ?? 8d ?? ?? e2 20 60',
)
const SPRITE_UPLOADS: Record<number, BytePattern> = { 0x33: PODOBOO }

/** Chars a slot lands on: row 1 is OBJ chars 0-9 (VRAM word $6000), row 2 $10-$19 ($6100). */
const slotChars = (slot: number): number[] => {
  const [row, s] = [Math.floor(slot / ROW_SLOTS), slot % ROW_SLOTS]
  return [row * 0x10 + s * 2, row * 0x10 + s * 2 + 1]
}

/**
 * The chars sprite `spriteId` draws from the player buffer, or null when it has none (every other sprite),
 * or why the ROM's routine is not the shape read here.
 */
export function dynamicChars(
  rom: RomFile,
  spriteId: number,
  buffer: MarioBuffer = readMarioGraphics(rom),
): DynamicChars | null {
  const pattern = SPRITE_UPLOADS[spriteId]
  if (!pattern) return null
  const hits = findPattern(rom, pattern)
  if (hits.length !== 1) return { ok: false, reason: `sprite $${spriteId.toString(16)}'s graphics routine is not the stock one` } // prettier-ignore
  if (!buffer.ok) return buffer
  const s = rom.readAtFileOffset(hits[0]!, pattern.length)!
  const word = (i: number) => s[i]! | (s[i + 1]! << 8)
  const first = (word(8) << 5) + word(17)
  const targets: [number, number][] = [[word(20), first], [word(27), first + word(24)]] // prettier-ignore
  const chars = new Map<number, Uint8Array>()
  for (const [slotAddr, from] of targets) {
    const slot = (slotAddr - DYN_GFX_TILE_PTR) / 2
    const piece = buffer.bytes.subarray(from - MARIO_GFX_BASE, from - MARIO_GFX_BASE + PIECE)
    if (!Number.isInteger(slot) || slot < 0 || slot >= 2 * ROW_SLOTS || piece.length !== PIECE) {
      return { ok: false, reason: `sprite $${spriteId.toString(16)} points a slot outside the player buffer` } // prettier-ignore
    }
    slotChars(slot).forEach((c, i) => chars.set(0x400 + c, decode4bpp(piece, i * 32)))
  }
  return { ok: true, chars }
}
