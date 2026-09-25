/**
 * #491 on the corpus: vanilla and its LM resave keep the frames they had
 * before the source read changed, and the four ROMs whose level JSL skips
 * CODE_05BB39 get blank stock characters and a note instead of stock frames.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  loadAnimationData,
  serializeAnimationData,
  stockAnimatedChars,
} from '../../../src/rom/AnimationLoader'
import { loadVram, VRAM_CHAR_BASE, VRAM_SLOT_NAMES } from '../../../src/rom/GfxLoader'
import { decodeMap16Sheet, frameZeroChars } from '../../../theia/extension/src/node/map16-decode'
import { CORPUS, MAGIC, VANILLA, hasRom, romPath } from '../support/corpus'

// sha256 of the output on develop at 999592d, before the change.
const ANIM_DIGEST = '7bd981ce9c7d5f9dc8e7f9557e95797508aca6a4615c2e8f847ac038e660a2e9'
const PHASES_DIGEST = '7e8e699554e55897c643f00ebd39f5d94fbede4e8576945b637b39167f368559'

for (const name of [VANILLA, MAGIC]) {
  describe.skipIf(!hasRom(name))(`${name}: stock frames unchanged`, () => {
    it('every tileset animates byte-identically to before', () => {
      const rom = SmwRom.open(romPath(name))
      const anim = createHash('sha256')
      const phases = createHash('sha256')
      for (let ts = 0; ts < 15; ts++) {
        const data = loadAnimationData(rom.rom, ts)
        anim.update(JSON.stringify(data ? serializeAnimationData(data) : null))
        const r = decodeMap16Sheet(rom, ts, 'fg', { bg: 0, fg: 0 })
        if (r.status !== 'ok') throw new Error(r.reason)
        expect(r.sheet.animationNote).toBeUndefined()
        if (ts === 0) expect(r.sheet.charSheets.some(c => c.animated)).toBe(true)
        phases.update(r.sheet.rgbaBase64)
        for (const p of r.sheet.charAnimation?.phases ?? []) phases.update(p)
      }
      expect(anim.digest('hex')).toBe(ANIM_DIGEST)
      expect(phases.digest('hex')).toBe(PHASES_DIGEST)
    })

    it('the stock routine writes 76 characters: $040-$07F, the berry 2x2, $0DA-$0DD, $0EA-$0ED', () => {
      const run = (from: number, n: number): number[] =>
        Array.from({ length: n }, (_, i) => from + i)
      const expected = [...run(0x40, 64), 0x80, 0x81, 0x90, 0x91, ...run(0xda, 4), ...run(0xea, 4)]
      const chars = stockAnimatedChars(SmwRom.open(romPath(name)).rom)
      expect([...chars].sort((a, b) => a - b)).toEqual(expected)
    })
  })
}

// Measured on this corpus, one machine: each hack's $00A2A5 JSL target.
const REDIRECTS: [string, string][] = [
  [CORPUS[2]!, '13AC77'],
  [CORPUS[3]!, '12D4CA'],
  [CORPUS[4]!, '16F15D'],
  [CORPUS[5]!, '13C1C2'],
]

for (const [name, target] of REDIRECTS) {
  describe.skipIf(!hasRom(name))(`${name}: level JSL goes to $${target}`, () => {
    it('blanks every stock animated character and says why', () => {
      const rom = SmwRom.open(romPath(name))
      const r = frameZeroChars(rom.rom, 0, loadVram(rom.rom, 0))!
      expect(r.animData).toBeUndefined()
      expect(r.note).toContain(`$${target}`)
      const chars = stockAnimatedChars(rom.rom)
      expect(chars.size).toBeGreaterThan(0)
      for (const slot of VRAM_SLOT_NAMES) {
        r.vram[slot]?.forEach((px, i) => {
          if (chars.has(VRAM_CHAR_BASE[slot] + i)) expect(px.every(p => p === 0)).toBe(true)
        })
      }
    })

    it('the sheet, where it renders, carries the note and no stock animation', () => {
      const r = decodeMap16Sheet(SmwRom.open(romPath(name)), 0, 'fg', { bg: 0, fg: 0 })
      if (r.status !== 'ok') return expect(r.reason).toMatch(/GFX cannot be read/)
      expect(r.sheet.animationNote).toContain(`$${target}`)
      expect(r.sheet.charAnimation).toBeUndefined()
      expect(r.sheet.charSheets.filter(c => c.animated)).toEqual([])
    })
  })
}
