/**
 * On the corpus: vanilla and its LM resave keep the frames they had before
 * the source read changed, and the four ROMs whose level JSL skips
 * CODE_05BB39 still get real stock frames, composited and marked unverified
 * with an error, rather than blanked.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  getAnimatedChars,
  loadAnimationData,
  readAnimRoutine,
  serializeAnimationData,
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
  })
}

// Measured on this corpus, one machine: each hack's $00A2A5 JSL target.
const REDIRECTS: [string, string][] = [
  [CORPUS[2]!, '13AC77'],
  [CORPUS[3]!, '12D4CA'],
  [CORPUS[4]!, '16F15D'],
  [CORPUS[5]!, '13C1C2'],
]

// Invictus replaces the stock LC_LZ2 decompressor, so its GFX33/GFX32 do not
// decode as stock format even though its JSL is also redirected: there is no
// stock data to composite, unlike the other three redirected ROMs.
const NO_STOCK_DATA = CORPUS[4]

for (const [name, target] of REDIRECTS) {
  describe.skipIf(!hasRom(name))(`${name}: level JSL goes to $${target}`, () => {
    it('is unverified, names the target, and shows stock frames when the stock data itself reads', () => {
      const rom = SmwRom.open(romPath(name))
      const r = frameZeroChars(rom.rom, 0, loadVram(rom.rom, 0))!
      expect(r.error).toMatch(/couldn't be loaded/)
      if (name === NO_STOCK_DATA) {
        expect(r.animData).toBeUndefined()
        return
      }
      expect(r.animData).toBeDefined()
      expect(r.error).toContain(`$${target}`)
      const chars = getAnimatedChars(r.animData!)
      expect(chars.size).toBeGreaterThan(0)
      // At least one animated character actually changed from a blank read.
      let anyNonBlank = false
      for (const slot of VRAM_SLOT_NAMES) {
        r.vram[slot]?.forEach((px, i) => {
          if (chars.has(VRAM_CHAR_BASE[slot] + i) && px.some(p => p !== 0)) anyNonBlank = true
        })
      }
      expect(anyNonBlank).toBe(true)
    })

    it('the sheet, where it renders, carries the error and no playback', () => {
      const r = decodeMap16Sheet(SmwRom.open(romPath(name)), 0, 'fg', { bg: 0, fg: 0 })
      if (r.status !== 'ok') return expect(r.reason).toMatch(/GFX cannot be read/)
      expect(r.sheet.animationNote).toContain(
        name === NO_STOCK_DATA ? "couldn't be loaded" : `$${target}`,
      )
      expect(r.sheet.charAnimation).toBeUndefined() // no playback from an unverified source
      if (name !== NO_STOCK_DATA) expect(r.sheet.charSheets.some(c => c.animated)).toBe(true)
    })
  })
}

// The #573 research table: switched slots 6-13, their char bases and switches.
const VANILLA_SWITCHES = [
  [0x50, 'blue'],
  [0x54, 'blue'],
  [0x58, 'blue'],
  [0x5c, 'silver'],
  [0x78, 'blue'],
  [0x7c, 'onOff'],
  [0xda, 'onOff'],
  [0x6c, 'blue'],
]

for (const name of [VANILLA, MAGIC]) {
  describe.skipIf(!hasRom(name))(`${name}: switch alternates`, () => {
    it('reads the vanilla tables, timer base and shift from the slot loop', () => {
      expect(readAnimRoutine(SmwRom.open(romPath(name)).rom)).toEqual({
        ok: true,
        vramDest: [0x05b93b, 0x05b93d, 0x05b93f],
        behaviorTable: 0x05b96b,
        selectorTable: 0x05b97d,
        timerBase: 0x14ad,
        shift: 0x26,
        tilesetOffsetTable: 0x05b98b,
        animatedTileData: 0x05b999,
      })
    })

    it('tags exactly the research table slots on tilesets 0-14', () => {
      const rom = SmwRom.open(romPath(name)).rom
      for (let ts = 0; ts < 15; ts++) {
        const data = loadAnimationData(rom, ts)!
        expect(data.switchUnavailable).toBeUndefined()
        for (const frame of data.frames) {
          const tagged = frame.filter(s => s.alt)
          expect(tagged.map(s => [s.charBase, s.alt!.switch])).toEqual(VANILLA_SWITCHES)
          expect(tagged.every(s => s.alt!.tiles.length === 4)).toBe(true)
        }
      }
    })
  })
}

for (const [name, target] of REDIRECTS) {
  describe.skipIf(!hasRom(name))(`${name}: switch read`, () => {
    it('is unavailable, naming the JSL target', () => {
      const r = readAnimRoutine(SmwRom.open(romPath(name)).rom)
      expect(!r.ok && r.reason).toContain(`$${target}`)
    })
  })
}
