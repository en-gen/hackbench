/**
 * The bus model, the guard and the machine factory on synthetic carts (no ROM,
 * no corpus). Audit #647: F3 (FastROM mirrors), F6 (WAI), F7 (past the image),
 * F8 (SRAM), F9 (HiROM, shape reads), F11 (Mode 7 latch), and the bus snapshot
 * and write recorder the call sites share.
 */
import { describe, expect, it } from 'vitest'
import { Refusal, callSubroutine } from '../../../../src/rom/cpu/call'
import { RomFile } from '../../../../src/rom/RomFile'
import { bytesAt } from '../../../../src/rom/sprites/interp/Guards'
import { loaderShapeProblem } from '../../../../src/rom/sprites/interp/LevelLoader'
import { recordWrites, romGuard, smwMachine } from '../../../../src/rom/sprites/interp/Machine'
import { romOffset, SpriteBus } from '../../../../src/rom/sprites/interp/SpriteBus'
import { runSprite } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

/** A cart of `banks` 32 KB LoROM banks whose every byte is its bank number plus one. */
function bankCart(banks: number): RomFile {
  const b = new Uint8Array(banks * 0x8000)
  for (let i = 0; i < b.length; i++) b[i] = (i >> 15) + 1
  return RomFile.fromBytes('synthetic.sfc', b)
}
const read = (rom: RomFile, a: number): number => new SpriteBus(rom).read(a)

describe('FastROM mirrors (F3)', () => {
  it('banks $80-$BF mirror the low 8 KB of WRAM', () => {
    const bus = new SpriteBus(bankCart(8))
    bus.write(0x7e0123, 0xaa)
    expect(bus.read(0x810123)).toBe(0xaa)
    expect(bus.read(0xbf0123)).toBe(0xaa)
    bus.write(0x810124, 0xbb)
    expect(bus.read(0x7e0124)).toBe(0xbb)
  })
  it('$40:0123 is not WRAM', () => {
    const bus = new SpriteBus(bankCart(8))
    bus.write(0x7e0123, 0xaa)
    expect(bus.read(0x400123)).not.toBe(0xaa)
  })
  it('the register window folds through banks $80-$BF', () => {
    const bus = new SpriteBus(bankCart(8))
    bus.write(0x814202, 200)
    bus.write(0x814203, 100)
    expect(bus.read(0x814216) | (bus.read(0x814217) << 8)).toBe(20000)
    expect(bus.read(0x004216)).toBe(20000 & 0xff)
    expect(bus.hwWrites.get(0x4203)).toBe(1)
  })
  it('code under DB=$81 reads both through the CPU', () => {
    // LDA $0123 ; STA $0200 ; LDA $4216 ; RTS, run with DB=$81 (what a FastROM hack runs under).
    const rom = bankCart(8)
    rom.writeAt(0x008000, [0xad, 0x23, 0x01, 0x8d, 0x00, 0x02, 0xad, 0x16, 0x42, 0x60])
    const { bus, cpu } = smwMachine(rom)
    bus.wram[0x123] = 0x5a
    bus.write(0x4202, 3)
    bus.write(0x4203, 5)
    const r = callSubroutine(cpu, 0x008000, { kind: 'jsr', maxSteps: 20, regs: { db: 0x81 } })
    expect(r.kind).toBe('returned')
    expect(bus.wram[0x200]).toBe(0x5a)
    expect(cpu.a & 0xff).toBe(15)
  })
})

describe('ROM reads past the image mirror (F7)', () => {
  it('a power-of-two image repeats: $08:8000 on 8 banks reads bank 0', () => {
    const rom = bankCart(8)
    expect(read(rom, 0x088000)).toBe(read(rom, 0x008000))
    expect(read(rom, 0x0f8123)).toBe(read(rom, 0x078123))
    expect(read(rom, 0x888000)).toBe(read(rom, 0x008000))
  })
  it('a non-power-of-two image repeats its upper part: 6 banks, $06:8000 reads bank 4', () => {
    const rom = bankCart(6)
    expect(read(rom, 0x058000)).toBe(6)
    expect(read(rom, 0x068000)).toBe(5)
    expect(read(rom, 0x078000)).toBe(6)
    expect(read(rom, 0x088000)).toBe(1) // the address wraps at the next power of two (8 banks)
  })
  it('mirroring follows the bsnes rule: size $1A0000 at $34:8000 reads offset $180000, not $100000', () => {
    const b = new Uint8Array(0x1a0000)
    b[0x180000] = 0xaa
    b[0x100000] = 0xbb
    expect(read(RomFile.fromBytes('m.sfc', b), 0x348000)).toBe(0xaa)
  })
  it('a copier header shifts every read by 512 bytes', () => {
    const bytes = new Uint8Array(512 + 0x40000)
    bytes[512] = 0x11
    expect(read(RomFile.fromBytes('h.smc', bytes), 0x008000)).toBe(0x11)
  })
  it('romOffset is null for WRAM, the low halves, SRAM and an empty image', () => {
    for (const a of [
      0x7e0000, 0x7fffff, 0x000000, 0x3f7fff, 0x807fff, 0x700000, 0x7d7fff, 0xf07fff,
    ])
      expect(romOffset(a, 0x400000)).toBeNull()
    expect(romOffset(0x008000, 0)).toBeNull()
    expect(romOffset(0x408000, 0x400000)).toBe(0x40 * 0x8000)
    expect(romOffset(0xfe0000, 0x400000)).toBe(0x7e * 0x8000)
  })
})

describe('SRAM is a buffer in the bus (F8)', () => {
  const big = () => RomFile.fromBytes('big.sfc', new Uint8Array(0x400000).fill(0x99))
  it('$70:0000 is read and written, never ROM bytes', () => {
    const bus = new SpriteBus(big())
    expect(bus.read(0x700000)).toBe(0)
    bus.write(0x700000, 0x5a)
    expect(bus.read(0x700000)).toBe(0x5a)
    expect(bus.read(0xf00000)).toBe(0x5a)
    expect(bus.read(0x708000)).toBe(0x99)
  })
  it('the buffer is not folded to a small chip: $70:0800 is distinct from $70:0000', () => {
    const bus = new SpriteBus(big())
    bus.write(0x700000, 1)
    bus.write(0x700800, 2)
    expect([bus.read(0x700000), bus.read(0x700800)]).toEqual([1, 2])
  })
  it('a fetch from SRAM is refused with the address', () => {
    const guard = romGuard(big())
    expect(() => guard(0x700000, 0xea)).toThrow(/execution left ROM code at \$700000/)
    expect(() => guard(0x7d7fff, 0xea)).toThrow(/\$7D7FFF/)
    expect(() => guard(0x708000, 0xea)).not.toThrow()
  })
})

describe('guard (F2, F6, F7)', () => {
  const guard = romGuard(bankCart(8))
  it.each([
    [0x00, 'BRK'],
    [0x02, 'COP'],
    [0x42, 'WDM'],
    [0xcb, 'WAI'],
    [0xdb, 'STP'],
  ])('refuses opcode %i (%s) with its address', (op, name) => {
    expect(() => guard(0x018123, op)).toThrow(new RegExp(`^${name} executed at \\$018123$`))
  })
  it('allows an ordinary opcode in ROM', () => {
    expect(() => guard(0x018123, 0xea)).not.toThrow()
  })
  it.each([0x7e0000, 0x7f8000, 0x006000, 0x806000, 0x3f7fff])(
    'refuses a fetch at %i outside ROM',
    a => {
      expect(() => guard(a, 0xea)).toThrow(Refusal)
      expect(() => guard(a, 0xea)).toThrow(/execution left ROM code at \$/)
    },
  )
  it('the location is reported before the opcode: BRK in WRAM says it left ROM', () => {
    expect(() => guard(0x7e0000, 0x00)).toThrow(/execution left ROM/)
  })
  it('WAI is refused before it executes: the routine never sees a NOP', () => {
    const rom = bankCart(8)
    rom.writeAt(0x008000, [0xcb, 0xa9, 0x33, 0x60])
    const m = smwMachine(rom)
    const r = callSubroutine(m.cpu, 0x008000, { kind: 'jsr', maxSteps: 10 })
    expect(r).toMatchObject({ kind: 'refused', reason: 'WAI executed at $008000', steps: 0 })
  })
})

describe('HiROM is refused up front (F9)', () => {
  const hirom = () => {
    const bytes = Uint8Array.from(buildSyntheticRom().buffer)
    bytes[0x7fd5] = 0
    bytes[0xffd5] = 0x21
    return RomFile.fromBytes('hirom.sfc', bytes)
  }
  it('the header reads as HiROM', () => {
    expect(hirom().mapMode).toBe('hirom')
  })
  it('smwMachine, the loader shape check and the runner all refuse with the reason', () => {
    expect(() => smwMachine(hirom())).toThrow(/map byte is \$21/)
    expect(loaderShapeProblem(hirom())).toMatch(/map byte is \$21/)
    expect(runSprite(hirom(), 0).refusal).toMatch(/map byte is \$21/)
  })
  it('shape reads use the bus mapping, not the header mapper', () => {
    const rom = hirom()
    const viaBus = [0, 1, 2, 3].map(i => read(rom, 0x05d8b7 + i))
    expect(bytesAt(rom, 0x05d8b7, 4)).toEqual(viaBus)
    expect(rom.readAt(0x05d8b7, 4)).not.toEqual(Buffer.from(viaBus)) // the header mapper reads other bytes
  })
  it('any other mapper byte is refused too, naming it: $23 (SA-1)', () => {
    const bytes = Uint8Array.from(buildSyntheticRom().buffer)
    bytes[0x7fd5] = 0x23
    const rom = RomFile.fromBytes('sa1.sfc', bytes)
    expect(rom.mapMode).toBe('unknown')
    expect(loaderShapeProblem(rom)).toMatch(/map byte is \$23/)
    expect(() => smwMachine(rom)).toThrow(/\$23/)
  })
  it('bytesAt is null where the bus reads no ROM', () => {
    expect(bytesAt(bankCart(8), 0x7e0000, 2)).toBeNull()
    expect(bytesAt(bankCart(8), 0x00ffff, 2)).toBeNull() // second byte is $01:0000, a low half
  })
})

describe('hardware divide', () => {
  it('divide by zero gives $FFFF and leaves the dividend as the remainder', () => {
    const bus = new SpriteBus(bankCart(8))
    bus.write(0x4204, 100)
    bus.write(0x4205, 0)
    bus.write(0x4206, 0)
    expect(bus.read(0x4214) | (bus.read(0x4215) << 8)).toBe(0xffff)
    expect(bus.read(0x4216) | (bus.read(0x4217) << 8)).toBe(100)
  })
})

describe('Mode 7 multiplier latch is shared with $211C-$2120 (F11)', () => {
  it('a $211C write is the "previous byte" for the next $211B', () => {
    const bus = new SpriteBus(bankCart(8))
    for (const [r, v] of [[0x211b, 0], [0x211b, 0], [0x211c, 5], [0x211b, 1], [0x211c, 2]] as const) bus.write(r, v) // prettier-ignore
    const prod = bus.read(0x2134) | (bus.read(0x2135) << 8) | (bus.read(0x2136) << 16)
    expect(prod).toBe(0x20a) // $0105 * 2
  })
  it('the product follows a later $211B write: $211C=2, $211B=3, $211B=0 reads 6', () => {
    const bus = new SpriteBus(bankCart(8))
    bus.write(0x211c, 2)
    bus.write(0x211b, 3)
    bus.write(0x211b, 0)
    expect(bus.read(0x2134)).toBe(6)
  })
  it('the plain case is unchanged: $0102 * 3', () => {
    const bus = new SpriteBus(bankCart(8))
    bus.write(0x211b, 0x02)
    bus.write(0x211b, 0x01)
    bus.write(0x211c, 3)
    expect(bus.read(0x2134)).toBe(0x06)
    expect(bus.read(0x2135)).toBe(0x03)
  })
})

describe('snapshot and restore', () => {
  it('put back WRAM, the read-before-write map, SRAM, the multiplier units and the register counts', () => {
    const bus = new SpriteBus(bankCart(8))
    bus.inputs = new Set()
    bus.write(0x7e0010, 1)
    bus.write(0x4202, 3)
    bus.write(0x4203, 4)
    bus.write(0x700000, 7)
    bus.write(0x211b, 9)
    const snap = bus.snapshot()
    bus.write(0x7e0010, 2)
    bus.write(0x7e0011, 2)
    bus.write(0x4203, 100)
    bus.write(0x700000, 8)
    bus.write(0x211b, 1)
    bus.write(0x2121, 0)
    bus.restore(snap)
    expect(bus.wram[0x10]).toBe(1)
    expect(bus.wram[0x11]).toBe(0)
    expect(bus.read(0x4216)).toBe(12)
    expect(bus.read(0x700000)).toBe(7)
    expect(bus.hwWrites.get(0x4203)).toBe(1)
    expect(bus.hwWrites.has(0x2121)).toBe(false)
    // $11 was written after the snapshot: restored as unwritten, so reading it is an input again.
    bus.read(0x7e0011)
    expect([...bus.inputs]).toContain(0x11)
    // The PPU unit's latch is back too: the last byte it saw was 9, so $211B = 1 builds $0109.
    bus.write(0x211b, 1)
    bus.write(0x211c, 1)
    expect(bus.read(0x2134) | (bus.read(0x2135) << 8)).toBe(0x109)
  })
  it('a snapshot is a copy: later writes do not reach it', () => {
    const bus = new SpriteBus(bankCart(8))
    const snap = bus.snapshot()
    bus.write(0x7e0000, 5)
    expect(snap.wram[0]).toBe(0)
  })
})

describe('recordWrites', () => {
  it('logs WRAM at its 24-bit address and registers in order, filtered by `keep`', () => {
    const bus = new SpriteBus(bankCart(8))
    const all = recordWrites(bus)
    const regs = recordWrites(bus, a => a >= 0x2200 && a < 0x7e0000)
    bus.write(0x7e0010, 0xab)
    bus.write(0x4202, 3)
    bus.write(0x2100, 1)
    expect(all.log).toEqual([0x7e0010 * 256 + 0xab, 0x4202 * 256 + 3, 0x2100 * 256 + 1])
    expect(regs.log).toEqual([0x4202 * 256 + 3])
  })
  it('stop() puts the previous hooks back', () => {
    const bus = new SpriteBus(bankCart(8))
    const seen: number[] = []
    bus.onWramWrite = off => seen.push(off)
    const rec = recordWrites(bus)
    bus.write(0x7e0001, 1)
    rec.stop()
    bus.write(0x7e0002, 1)
    expect(seen).toEqual([1, 2])
    expect(rec.log).toHaveLength(1)
  })
})

describe('smwMachine', () => {
  it('copies the given WRAM image and installs the guard', () => {
    const w = new Uint8Array(0x20000)
    w[0x1234] = 0x77
    const { bus } = smwMachine(bankCart(8), w)
    expect(bus.wram[0x1234]).toBe(0x77)
    expect(() => bus.onInstruction!(0x7e0000, 0xea)).toThrow(Refusal)
  })
})
