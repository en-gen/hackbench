/**
 * Which decompressor a GFX load actually runs, read from the bytes at the
 * entry its caller reaches (CODE_00B8DE on a stock ROM,
 * bank_00.asm:6294-6413). Two replacements are recognized besides stock;
 * evidence and the survey behind them are in docs/rom/gfx-decompressors.md.
 */
import type { RomFile } from './RomFile'
import { WILD, matchesBytes, type BytePattern } from './BytePattern'
import { fingerprint } from './Fingerprint'
import { formatAddr } from './addressing'
import { parseStream } from './LcLz2'

/** REP #$10 / LDY #$0000 / JSR ReadByte / CMP #$FF (bank_00.asm:6294-6300). */
export const STOCK_LCLZ2_ENTRY: readonly number[] = [
  0xc2, 0x10, 0xa0, 0x00, 0x00, 0x20, 0x83, 0xb9, 0xc9, 0xff,
]
/** Where the entry's first instruction pair ends and the body begins. */
const BODY_AT = 5

/** PHP / REP #$30 / LDA $8A / EOR #key / STA $8A / PLP / REP #$10 / LDY #$0000 / RTL */
// prettier-ignore
export const XOR_PRELUDE: BytePattern = [
  0x08, 0xc2, 0x30, 0xa5, 0x8a, 0x49, WILD, WILD, 0x85, 0x8a, 0x28, 0xc2, 0x10, 0xa0, 0x00, 0x00, 0x6b,
]
const KEY_AT = 6

/** A body entered by JSL, recognized by the SHA-256 of `length` bytes from its target. */
export interface FastRoutine {
  length: number
  fingerprint: string
}

/** The MVN-based LC_LZ2 routine, in two builds (docs/rom/gfx-decompressors.md). */
export const FAST_LCLZ2: readonly FastRoutine[] = [
  {
    length: 0x1bc,
    fingerprint: 'c70bc52376ce570eddb05c7b592d07299969079ce36efdc9fd5ceef3502a2133',
  },
  {
    length: 0x1ab,
    fingerprint: '575f68adc5aca7ff5c7cbc1e0460dd605efc9158f8865892d4db0b846f4ad209',
  },
]

export type DecompressorKind = 'stock' | 'fast'
export type Decompressor =
  { ok: true; kind: DecompressorKind; key: number } | { ok: false; reason: string }

/** The 24-bit JSL target at `snes`, bank bit 7 folded for the FastROM
 *  mirror, or null off a JSL opcode or off the ROM. */
export function jslTarget(rom: RomFile, snes: number): number | null {
  const bytes = rom.readAt(snes, 4)
  if (!bytes || bytes[0] !== 0x22) return null
  return (bytes[1]! | (bytes[2]! << 8) | (bytes[3]! << 16)) & 0x7fffff
}

export const replacedReason = (entry: number, what: string): string =>
  `this ROM has replaced the LC_LZ2 decompressor at ${formatAddr(entry)} (${what}), ` +
  'so its GFX are not LC_LZ2 streams this editor can read or write'

/** The key the entry's prelude XORs into the pointer: 0 when the entry
 *  starts stock, null when it starts with anything else. */
export function preludeKey(rom: RomFile, entry: number): number | null {
  const head = rom.readAt(entry, BODY_AT)
  if (!head) return null
  if (matchesBytes(head, STOCK_LCLZ2_ENTRY.slice(0, BODY_AT))) return 0
  const target = head[4] === 0xea ? jslTarget(rom, entry) : null // JSL / NOP
  const p = target === null ? null : rom.readAt(target, XOR_PRELUDE.length)
  return p && matchesBytes(p, XOR_PRELUDE) ? p[KEY_AT]! | (p[KEY_AT + 1]! << 8) : null
}

export function readDecompressor(
  rom: RomFile,
  entry: number,
  fast: readonly FastRoutine[] = FAST_LCLZ2,
): Decompressor {
  const head = rom.readAt(entry, STOCK_LCLZ2_ENTRY.length)
  if (!head) return { ok: false, reason: 'the decompressor entry does not resolve to ROM data' }
  const replaced = (what: string): Decompressor => ({
    ok: false,
    reason: replacedReason(entry, what),
  })
  const key = preludeKey(rom, entry)
  if (key === null) {
    const target = jslTarget(rom, entry)
    return replaced(
      `an unrecognized entry${target === null ? '' : ` that calls ${formatAddr(target)}`}`,
    )
  }
  if (matchesBytes(head.subarray(BODY_AT), STOCK_LCLZ2_ENTRY.slice(BODY_AT))) {
    return { ok: true, kind: 'stock', key }
  }
  const target = head[BODY_AT + 4] === 0x60 ? jslTarget(rom, entry + BODY_AT) : null // JSL / RTS
  if (target === null) return replaced('an unrecognized body')
  const known = fast.some(f => fingerprint(rom.readAt(target, f.length)) === f.fingerprint)
  return known ? { ok: true, kind: 'fast', key } : replaced(`it calls ${formatAddr(target)}`)
}

/** Why `stream` has no single meaning on this decompressor, or null: the fast
 *  routine reads some commands above 4 unlike stock (docs/rom/gfx-decompressors.md). */
export function commandRefusal(kind: DecompressorKind, stream: Uint8Array): string | null {
  return kind === 'fast' && !parseStream(stream).terminated
    ? "it uses a command this ROM's decompressor reads differently from stock"
    : null
}
