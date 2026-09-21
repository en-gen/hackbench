import { describe, it, expect } from 'vitest'
import { existsSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  buildSpc,
  getLevelMusicBankAddr,
  getOverworldMusicBankAddr,
  getCreditsMusicBankAddr,
  countBankSongs,
} from '../../../src/rom/SpcBuilder'

const ROM_PATH = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const romPresent = existsSync(ROM_PATH)

describe('SpcBuilder', () => {
  if (!romPresent) {
    it.skip('ROM not available', () => {})
    return
  }
  const rom = SmwRom.open(ROM_PATH)

  it('reads correct music bank addresses from upload routines', () => {
    const level = getLevelMusicBankAddr(rom.rom)
    const overworld = getOverworldMusicBankAddr(rom.rom)
    const credits = getCreditsMusicBankAddr(rom.rom)
    console.log(`Level bank:     $${level.toString(16)}`)
    console.log(`Overworld bank: $${overworld.toString(16)}`)
    console.log(`Credits bank:   $${credits.toString(16)}`)
    // Expected from SMWDisX sym file:
    expect(level).toBe(0x0eaed6)
    expect(overworld).toBe(0x0e98b1)
    expect(credits).toBe(0x03e400)
  })

  it('counts songs in level music bank', () => {
    const addr = getLevelMusicBankAddr(rom.rom)
    const count = countBankSongs(rom.rom, addr)
    console.log(`Level bank songs: ${count}`)
    expect(count).toBeGreaterThan(10)
    expect(count).toBeLessThan(40)
  })

  it('builds a valid SPC file', () => {
    const spc = buildSpc(rom.rom, 1, 'level')
    expect(spc).not.toBeNull()
    expect(spc!.length).toBe(256 + 65536 + 128) // header + ARAM + DSP

    // Check SPC signature
    const sig = new TextDecoder().decode(spc!.slice(0, 33))
    console.log(`SPC signature: "${sig}"`)
    expect(sig).toBe('SNES-SPC700 Sound File Data v0.30')

    // Check ARAM is not all zeros
    const aram = spc!.slice(256, 256 + 65536)
    const nonZero = aram.filter(b => b !== 0).length
    console.log(`ARAM non-zero bytes: ${nonZero} / 65536`)
    expect(nonZero).toBeGreaterThan(1000)

    // Check engine entry point (PC in header at offset 37-38)
    const pc = spc![37] | (spc![38] << 8)
    console.log(`Engine PC: $${pc.toString(16).padStart(4, '0')}`)

    // Dump first few bytes of ARAM at key locations
    console.log(
      `ARAM[$0000-$000F]: ${Array.from(aram.slice(0, 16))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(' ')}`,
    )
    console.log(
      `ARAM[$0500-$050F]: ${Array.from(aram.slice(0x500, 0x510))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(' ')}`,
    )
    console.log(`ARAM[$00F4] (BGM cmd): $${aram[0xf4].toString(16).padStart(2, '0')}`)
  })

  it('level bank song pointer table dump', () => {
    const data = rom.rom.readAt(0x0eaed6 + 4, 64)! // skip 4-byte header, read 32 words
    for (let i = 0; i < 32; i++) {
      const ptr = data[i * 2] | (data[i * 2 + 1] << 8)
      console.log(`  entry[${i}] = $${ptr.toString(16).padStart(4, '0')}`)
    }
  })

  it('ROM block headers look correct', () => {
    // Read the 4-byte headers of each block
    for (const [name, addr] of [
      ['SPC engine', 0x0e8000],
      ['Samples', 0x0f8000],
      ['Level bank', 0x0eaed6],
    ] as const) {
      const hdr = rom.rom.readAt(addr as number, 4)!
      const size = hdr[0] | (hdr[1] << 8)
      const dest = hdr[2] | (hdr[3] << 8)
      console.log(
        `${name}: ROM=$${(addr as number).toString(16)}, size=${size} ($${size.toString(16)}), ARAM dest=$${dest.toString(16).padStart(4, '0')}`,
      )
    }
  })

  it('export multiple SPC variants for testing', () => {
    const outDir = resolve(__dirname, '../../roms')

    // Approach A: Current buildSpc (post-init, PC=APU_Loop)
    const spcA = buildSpc(rom.rom, 2, 'level')
    if (spcA) {
      writeFileSync(resolve(outDir, 'test_A_postinit.spc'), spcA)
      console.log(`A (post-init PC=$0549): ${spcA.length} bytes`)
    }

    // Approach B: Cold start at APU_Start, BGM at $F4 (original approach)
    // Manually build to test if engine init + command pickup works
    // Approach B doesn't need bankAddr - we patch approach A's SPC directly
    // We need the raw buildAram, so let's just patch approach A
    if (spcA) {
      const spcB = new Uint8Array(spcA)
      // Set PC back to $0500 (APU_Start)
      spcB[37] = 0x00
      spcB[38] = 0x05
      // Set BGM command in ARAM at $F4
      spcB[256 + 0xf4] = 2
      // Clear DSP regs (let engine init set them)
      for (let i = 256 + 65536; i < spcB.length; i++) spcB[i] = 0
      writeFileSync(resolve(outDir, 'test_B_coldstart.spc'), spcB)
      console.log(`B (cold start PC=$0500): ${spcB.length} bytes`)
    }

    // Approach C: Post-init but skip ahead 2 seconds (let engine settle)
    // The SPC format has a "song length" field at offset 169 (3-char text)
    // But we can't skip from here - the player handles that
    // Instead, set PC=APU_Loop, set SPCOutBuffer+2 to BGM to trigger processing
    if (spcA) {
      const spcC = new Uint8Array(spcA)
      // Also write BGM to SPCOutBuffer+2 (ARAM $0C) which the engine checks
      spcC[256 + 0x0c] = 2
      writeFileSync(resolve(outDir, 'test_C_outbuf.spc'), spcC)
      console.log(`C (post-init + SPCOutBuffer): ${spcC.length} bytes`)
    }
  })
})
