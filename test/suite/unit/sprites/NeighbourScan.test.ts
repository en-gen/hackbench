/**
 * #841: a sprite whose own code scans the slot tables for a companion ($9C looks for a $9B in slots 0-9 and
 * draws it, SMWDisX bank_02.asm:12118-12148) is run a second time with the level list's neighbours in the other
 * slots. Synthetic, no ROM: the cart adds id 50 (draws its own piece, then scans slots 9..0 for a status-8
 * sprite numbered 51 and draws a piece at that slot's position under that slot's OAM index, as
 * PutHammerBroOnPlat does), id 51 (draws nothing, as $9B alone), id 52 (draws its own piece in its own turn).
 * Evidence scope: the fixture's own routines; the vanilla maps are graded by spriteGrade.captures.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { neighboursOf } from '../../../../src/rom/sprites/interp/Neighbours'
import { runOnce } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const SCANNER = 50
const QUIET = 51
const DRAWS = 52

function cart(): RomFile {
  const bytes = new Uint8Array(buildSyntheticRom().buffer)
  const off = (snes: number) => (snes >>> 16) * 0x8000 + ((snes & 0xffff) - 0x8000)
  const put = (snes: number, b: number[]) => {
    expect(bytes.subarray(off(snes), off(snes) + b.length).every(v => v === 0)).toBe(true)
    bytes.set(b, off(snes))
  }
  // JSR $8640 (id 0's draw) / LDY #9 / loop: LDA $14C8,Y / CMP #8 / BNE next / LDA $009E,Y / CMP #51 / BEQ found
  // / next: DEY / BPL loop / RTS / found: PHX / TYX / JSR $8640 / PLX / RTS
  put(0x019800, [
    0x20, 0x40, 0x86, 0xa0, 0x09, 0xb9, 0xc8, 0x14, 0xc9, 0x08, 0xd0, 0x07, 0xb9, 0x9e, 0x00,
    0xc9, QUIET, 0xf0, 0x04, 0x88, 0x10, 0xef, 0x60, 0xda, 0xbb, 0x20, 0x40, 0x86, 0xfa, 0x60,
  ]) // prettier-ignore
  const main = (id: number, at: number) => put(0x018320 + 9 + id * 2, [at & 0xff, at >> 8])
  // mainTable entries default to $8600 (an RTS), which are not zero: clear the three words first.
  for (const id of [SCANNER, DRAWS]) {
    const o = off(0x018320 + 9 + id * 2)
    bytes[o] = 0
    bytes[o + 1] = 0
  }
  main(SCANNER, 0x9800)
  main(DRAWS, 0x8640)
  return RomFile.fromBytes('scan.sfc', bytes)
}

const seedWith = (neighbours?: { id: number; x: number; y: number }[]) =>
  withSeed({ sprite: { x: 0x80, y: 0x80 }, ...(neighbours ? { neighbours } : {}) })
const partsOf = (m: ReturnType<typeof runOnce>) => m.passes[m.chosen!]!.parts

describe('neighbour run for a sprite that scans the slot tables (#841)', () => {
  const rom = cart()

  it('alone, the scanner draws its own piece only and is marked as scanning', () => {
    const m = runOnce(rom, SCANNER, seedWith())
    expect(partsOf(m)).toHaveLength(1)
    expect(m.neighbourRun).toBeUndefined()
  })

  it('with a quiet neighbour listed, the scanner draws the neighbour too and says so', () => {
    const m = runOnce(rom, SCANNER, seedWith([{ id: QUIET, x: 0x90, y: 0x70 }]))
    expect(m.neighbourRun).toBe('adopted')
    expect(m.dependsOn).toContain('neighbours')
    const parts = partsOf(m)
    expect(parts).toHaveLength(2)
    // The companion is drawn at ITS position, under its own OAM index.
    expect(parts.map(p => [p.dx, p.dy]).sort()).toEqual([[0, 0], [16, -16]]) // prettier-ignore
    expect(new Set(parts.map(p => p.oam)).size).toBe(2)
  })

  it("a neighbour's own draw is not counted", () => {
    const m = runOnce(rom, SCANNER, seedWith([{ id: DRAWS, x: 0x90, y: 0x70 }, { id: QUIET, x: 0xa0, y: 0x70 }])) // prettier-ignore
    // Id 52 draws in its own turn at (16, -16); only the scanner's piece and id 51's are the scanner's.
    expect(partsOf(m).map(p => [p.dx, p.dy]).sort()).toEqual([[0, 0], [32, -16]]) // prettier-ignore
  })

  it('a scan that finds nothing changes nothing', () => {
    const alone = runOnce(rom, SCANNER, seedWith())
    const m = runOnce(rom, SCANNER, seedWith([{ id: DRAWS, x: 0x90, y: 0x70 }]))
    expect(m.neighbourRun).toBe('same')
    expect(m.dependsOn).not.toContain('neighbours')
    expect(partsOf(m)).toEqual(partsOf(alone))
  })

  it('a sprite that does not scan is not run again', () => {
    const m = runOnce(rom, 0, seedWith([{ id: QUIET, x: 0x90, y: 0x70 }]))
    expect(m.neighbourRun).toBeUndefined()
    expect(m.scansSlots).toBeUndefined()
    expect(partsOf(m)).toHaveLength(1)
  })

  it('the sprite under test in a high slot still gets its neighbours', () => {
    const m = runOnce(rom, SCANNER, withSeed({ slot: 9, sprite: { x: 0x80, y: 0x80 }, neighbours: [{ id: QUIET, x: 0x90, y: 0x70 }] })) // prettier-ignore
    expect(partsOf(m)).toHaveLength(2)
  })
})

describe('neighboursOf', () => {
  const sp = (index: number, screen: number, x: number, spriteId = 1): LevelSprite =>
    ({ screen, x, y: 5, spriteId, extraBit: false, raw: [0, 0, 0], index, streamOffset: index }) // prettier-ignore
  const px = (e: LevelSprite) => ({ x: e.x * 16, y: e.y * 16 })

  it('keeps the screen and the one each side, drops itself and generators, nearest first', () => {
    const me = sp(0, 4, 70)
    const list = [me, sp(1, 6, 100), sp(2, 5, 90), sp(3, 3, 60), sp(4, 4, 71, 0xcb), sp(5, 4, 72)]
    expect(neighboursOf(list, me, px).map(n => n.x / 16)).toEqual([72, 60, 90])
  })

  it('caps at the free slots (9 of 0-9)', () => {
    const me = sp(0, 1, 20)
    const list = [me, ...Array.from({ length: 15 }, (_, i) => sp(i + 1, 1, 21 + i))]
    expect(neighboursOf(list, me, px)).toHaveLength(9)
  })
})
