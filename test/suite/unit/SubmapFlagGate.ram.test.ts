/**
 * D185 (docs/decisions/2026-11-05-d126-exception-entry-site-ram.md): the entry path's opcode checks also
 * compare the RAM-address operands, against a named table (ENTRY_RAM). Evidence scope: unit tests on
 * synthetic carts (no ROM) plus, where the vanilla ROM is present, one machine's read of its operands.
 *
 * The synthetic half sweeps every operand byte of every instruction that names RAM, every single-byte
 * alternative, on the cart's own invented table (SYNTHETIC_RAM). The corpus half reads the same operands from
 * the ROM and compares them with ENTRY_RAM, so a mistyped address goes red where a ROM exists.
 */
import { describe, expect, it } from 'vitest'
import { freshRom, hasRom, romPath, VANILLA } from '../support/corpus'
import { loadVanillaBytes, vanillaHits, windowSet } from '../support/vanillaWindows'
import {
  ENTRY_RAM,
  LM_ENTRY_SITE_OPS,
  OVERWORLD_ENTRY,
  ENTRY_SITE_OPS,
  operandBytes,
  readTranslevelBias,
  stockCodeMismatch,
  type RamKey,
  type StockOp,
} from '../../../src/rom/SubmapFlagGate'
import type { RomFile } from '../../../src/rom/RomFile'
import {
  blankStockRom,
  plantLmEntryHook,
  SYNTHETIC_FINGERPRINTS,
  SYNTHETIC_RAM,
} from '../support/syntheticRom'

const RAM_OPS = OVERWORLD_ENTRY.filter((c): c is StockOp => 'op' in c && c.ram !== undefined)
const KEYS = Object.keys(ENTRY_RAM) as RamKey[]
const FP = SYNTHETIC_FINGERPRINTS.entry
/** [op, operand byte index] for every RAM operand byte on the path. */
const BYTES = (ops: readonly StockOp[]): [StockOp, number][] =>
  ops.flatMap(o => Array.from({ length: operandBytes(o.op) }, (_, i): [StockOp, number] => [o, i]))

/** Every single-byte alternative of every operand byte: `refused` counts the ones `check` calls bad. */
function sweep(
  make: () => RomFile,
  ops: readonly StockOp[],
  check: (rom: RomFile, op: StockOp) => string | null,
): { tried: number; refused: number; wrongReason: string[] } {
  let tried = 0
  let refused = 0
  const wrongReason: string[] = []
  for (const [o, i] of BYTES(ops)) {
    const rom = make()
    const at = o.addr + 1 + i
    const stock = rom.readByte(at)!
    for (let v = 0; v < 0x100; v++) {
      if (v === stock) continue
      rom.writeAt(at, [v])
      tried++
      const why = check(rom, o)
      if (why !== null) refused++
      if (why !== null && !why.includes('addresses')) wrongReason.push(`${at.toString(16)}=${v}`)
    }
    rom.writeAt(at, [stock])
  }
  return { tried, refused, wrongReason }
}

describe('the RAM table on the overworld entry path (D185)', () => {
  it('names 7 addresses over 13 operand bytes, each used by an instruction, no two the same', () => {
    expect(KEYS.length).toBe(7)
    expect(new Set(RAM_OPS.map(o => o.ram))).toEqual(new Set(KEYS))
    expect(BYTES(RAM_OPS).length).toBe(13)
    expect(new Set(Object.values(ENTRY_RAM)).size).toBe(7)
  })

  it('the synthetic table is invented: no entry equals the stock address, and the cart reads clean', () => {
    for (const k of KEYS) expect(SYNTHETIC_RAM[k], k).not.toBe(ENTRY_RAM[k])
    expect(readTranslevelBias(blankStockRom(), FP).ok).toBe(true)
  })

  it('refuses every single-byte alternative of every RAM operand byte, with the address reason', () => {
    const r = sweep(blankStockRom, RAM_OPS, (rom, o) => stockCodeMismatch(rom, [o], FP))
    expect(r.wrongReason).toEqual([])
    expect(r.tried).toBe(13 * 255)
    expect(r.refused).toBe(3315)
  })

  it('the whole path, not just the one instruction, refuses each of them', () => {
    const r = sweep(blankStockRom, RAM_OPS, rom => {
      const bias = readTranslevelBias(rom, FP)
      return bias.ok ? null : bias.reason
    })
    expect(r.refused).toBe(3315)
    expect(r.wrongReason).toEqual([])
  })

  it('names the instruction, the address found and the address expected', () => {
    const rom = blankStockRom()
    const o = ENTRY_SITE_OPS.find(c => c.ram === '_E')!
    rom.writeAt(o.addr + 1, [0x77])
    expect(stockCodeMismatch(rom, [o], FP)).toContain('store to _E')
    expect(stockCodeMismatch(rom, [o], FP)).toContain('addresses $77, not _E at $4B')
  })

  it('under the Lunar Magic hook, the site operands it keeps are checked: every alternative is refused', () => {
    const kept = LM_ENTRY_SITE_OPS.filter(o => o.ram !== undefined)
    expect(BYTES(kept).length).toBe(6)
    const make = (): RomFile => {
      const rom = blankStockRom()
      plantLmEntryHook(rom)
      return rom
    }
    expect(readTranslevelBias(make(), FP).ok).toBe(true)
    const r = sweep(make, kept, rom => {
      const bias = readTranslevelBias(rom, FP)
      return bias.ok ? null : bias.reason
    })
    expect(r.refused).toBe(6 * 255)
    expect(r.wrongReason).toEqual([])
  })

  it('the hooked sites (guard and table load) have an operand check of their own where the stock opcode stays', () => {
    // The JSL that replaces the OWLayer1Translevel load has no RAM operand to compare; its target is the
    // recognized-hook check. The store after it still names TranslevelNo and is in RAM_OPS (swept above).
    const load = RAM_OPS.find(o => o.ram === 'OWLayer1Translevel')!
    expect(operandBytes(load.op)).toBe(3)
    expect(RAM_OPS.some(o => o.ram === 'TranslevelNo')).toBe(true)
  })
})

describe('the assembled synthetic cart against the vanilla ROM (D185 condition 2)', () => {
  const scoped = (cart: Uint8Array, vanilla: Set<string>): string[] =>
    vanillaHits(cart, vanilla, 8).filter(h => h >= '$05:D83E' && h <= '$05:D8B6' && h.startsWith('$05:D8')) // prettier-ignore
  const cartOf = (rom: RomFile): Uint8Array => Uint8Array.from(rom.readAtFileOffset(0, 0x80000)!)

  describe.skipIf(!hasRom(VANILLA))('with the vanilla ROM present', () => {
    it('the built cart has 0 vanilla 8-byte windows at the entry site, with its invented operands', () => {
      const vanilla = windowSet(loadVanillaBytes(romPath(VANILLA)), 8)
      expect(scoped(cartOf(blankStockRom()), vanilla)).toEqual([])
    })

    it('a planted vanilla RAM operand set is found by the same scan', () => {
      const vanilla = windowSet(loadVanillaBytes(romPath(VANILLA)), 8)
      const game = freshRom()
      const rom = blankStockRom()
      for (const o of RAM_OPS)
        rom.writeAt(o.addr + 1, [...game.readAt(o.addr + 1, operandBytes(o.op))!])
      // Whether the scan alone reddens is measured, not assumed: this asserts it does.
      expect(scoped(cartOf(rom), vanilla).length).toBeGreaterThan(0)
    })
  })
})

describe.skipIf(!hasRom(VANILLA))('ENTRY_RAM against the vanilla ROM (D185 condition 3)', () => {
  const operand = (rom: RomFile, o: StockOp): number =>
    rom.readAt(o.addr + 1, operandBytes(o.op))!.reduce((v, b, i) => v | (b << (8 * i)), 0)

  it('every instruction that names RAM holds the address its key names, read from the ROM', () => {
    const rom = freshRom()
    for (const o of RAM_OPS)
      expect(operand(rom, o), `${o.what} -> ${o.ram}`).toBe(ENTRY_RAM[o.ram!])
    expect(
      stockCodeMismatch(
        rom,
        OVERWORLD_ENTRY.filter((c): c is StockOp => 'op' in c),
      ),
    ).toBeNull()
  })

  it('on the vanilla ROM every single-byte alternative of the 13 operand bytes is refused', () => {
    const rom = freshRom()
    const r = sweep(
      () => rom,
      RAM_OPS,
      (m, o) => stockCodeMismatch(m, [o]),
    )
    expect(r.wrongReason).toEqual([])
    expect(r.refused).toBe(3315)
  })
})
