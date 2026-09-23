/**
 * The scanner against vanilla SMW, whose driver is fully disassembled, so
 * every located address can be checked against SMWDisX bank_0E.asm.
 * Skips when the ROM is absent (always, in CI). HB_TEST_ROMS points a
 * worktree at a ROM folder outside it.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { scanRom } from '../../../../src/rom/nspc/SourceScan'
import { exportSong } from '../../../../src/rom/nspc/AmkExport'

const dir = process.env.HB_TEST_ROMS ?? resolve(__dirname, '../../../roms')
const path = resolve(dir, 'Super Mario World (USA).vanilla.sfc')

describe.skipIf(!existsSync(path))('scanRom on vanilla SMW (requires the ROM)', () => {
  const r = existsSync(path) ? scanRom(readFileSync(path)) : null!

  it('finds exactly the five uploads the game code loads', () => {
    // Engine $0E8000, samples $0F8000, banks $0E98B1, $0EAED6, $03E400 (SpcBuilder's upload routines).
    expect(r.chains.map(c => c.fileOffset)).toEqual([0x1e400, 0x70000, 0x718b1, 0x72ed6, 0x78000])
  })

  it('locates the driver tables SMWDisX names', () => {
    expect(r.images[0].engine).toMatchObject({
      songTable: 0x135e, // MusicData-2 (APU_0B40)
      instrTable: 0x5f46, // APU_0D4B
      percTable: 0x5fa5, // HandleVCmd
      dir: 0x8000, // DefaultDSPRegs/Vals, reg $5D
      vcmdFirst: 0xda,
    })
  })

  it('lists the songs per bank and marks the credits song that needs another bank', () => {
    const count = (label: string) => r.songs.filter(s => s.image.label.includes(label)).length
    expect(r.songs.filter(s => s.image.label === 'base')).toHaveLength(9)
    expect(count('072ED6')).toBe(27)
    expect(count('01E400')).toBe(3)
    expect(r.unavailable.map(u => u.command)).toEqual([1])
  })

  it('exports every song without an unknown command', () => {
    for (const s of r.songs) {
      const ex = exportSong(s.image, s.song, { folder: 'smw', title: 't', game: 'g' })
      expect(ex.warnings.filter(w => w.includes('no known meaning'))).toEqual([])
      expect(ex.samples.length).toBeGreaterThan(0)
    }
  })
})
