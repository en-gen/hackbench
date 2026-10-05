import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { Cpu } from '../../../../src/rom/spriteInterp/Cpu65816'

/** A 64 KiB synthetic LoROM image with `code` at $00:8000. No ROM bytes involved. */
function cart(code: number[]): RomFile {
  const buf = new Uint8Array(0x10000)
  buf.set(code, 0)
  return RomFile.fromBytes('synthetic.sfc', buf)
}

describe('Cpu65816 (synthetic code)', () => {
  it('runs a JSR/RTS program and returns over the entry frame', () => {
    // LDA #$12 ; CLC ; ADC #$30 ; STA $10 ; JSR $800C ; RTS ; NOP ; LDA $10 ; ASL A ; STA $11 ; RTS
    const rom = cart([
      0xa9, 0x12, 0x18, 0x69, 0x30, 0x85, 0x10, 0x20, 0x0c, 0x80, 0x60, 0xea, 0xa5, 0x10, 0x0a,
      0x85, 0x11, 0x60,
    ])
    const cpu = new Cpu(rom)
    const r = cpu.run(0x008000, 'jsr')
    expect(r.refusal).toBeNull()
    expect([cpu.wram[0x10], cpu.wram[0x11]]).toEqual([0x42, 0x84])
    expect(r.steps).toBe(10)
  })

  it('pushes and pulls index registers at their own width (planted: width inverted)', () => {
    // REP #$10 ; LDX #$1234 ; PHX ; PLY ; SEP #$10 ; STY $20 ; RTS
    const rom = cart([0xc2, 0x10, 0xa2, 0x34, 0x12, 0xda, 0x7a, 0xe2, 0x10, 0x84, 0x20, 0x60])
    const cpu = new Cpu(rom)
    const r = cpu.run(0x008000, 'jsr')
    // With a mis-sized pull the stack is off by one and RTS never meets the entry frame.
    expect(r.refusal).toBeNull()
    expect(cpu.wram[0x20]).toBe(0x34)
  })

  it('refuses an opcode it does not model, and names it', () => {
    const cpu = new Cpu(cart([0x42, 0x00])) // WDM
    expect(cpu.run(0x008000, 'jsr').refusal).toEqual({ reason: 'opcode $42', at: 0x008000 })
  })

  it('counts register-space writes and models the multiply unit', () => {
    // LDA #$07 ; STA $4202 ; LDA #$09 ; STA $4203 ; LDA $4216 ; STA $10 ; RTS
    const cpu = new Cpu(
      cart([
        0xa9, 0x07, 0x8d, 0x02, 0x42, 0xa9, 0x09, 0x8d, 0x03, 0x42, 0xad, 0x16, 0x42, 0x85, 0x10,
        0x60,
      ]),
    )
    const r = cpu.run(0x008000, 'jsr')
    expect([r.hwWrites, cpu.wram[0x10]]).toEqual([2, 63])
  })
})
