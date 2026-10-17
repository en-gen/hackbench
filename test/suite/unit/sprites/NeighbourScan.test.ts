/**
 * #841: a sprite whose own code scans the slot tables for a companion ($9C looks for a $9B in slots 0-9 and
 * draws it, SMWDisX bank_02.asm:12118-12148) is run a second time with the level list's neighbours in the other
 * slots. Synthetic, no ROM: the cart adds id 50 (draws its own piece, then scans slots 9..0 for a status-8
 * sprite numbered 51 and draws a piece at that slot's position under that slot's OAM index, as
 * PutHammerBroOnPlat does), id 51 (draws nothing, as $9B alone), id 52 (draws its own piece in its own turn).
 * Evidence scope: the fixture's own routines; the vanilla maps are graded by spriteGrade.captures.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'
import { romWindowHits } from '../../support/romWindows'
import { RomFile } from '../../../../src/rom/RomFile'
import { neighboursOf } from '../../../../src/rom/sprites/interp/Neighbours'
import { Refusal } from '../../../../src/rom/cpu/call'
import { Machine, RAM, runOnce } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { shellLoad } from '../../../../src/rom/sprites/ShellSprites'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const SCANNER = 50
const QUIET = 51
const DRAWS = 52
/** Draws its own piece only when it finds no companion; on finding one it draws the companion and moves its own piece 8 px. */
const SHIFTS = 53
/** Scans for id COMP and draws it with a tile from two cells: InitSpriteTables' $1600,X and its own INIT's $1640,X. */
const INITS = 54
const COMP = 55
/** Scans the number table only (never the status table). */
const NUMONLY = 56
/** Draws the companion with its x HIGH byte ($14E0,X) as the tile. */
const HIGHBYTE = 57
/** Scans for a status-9 sprite numbered 5, which is what list id $DB becomes (#837 shells). */
const SHELLSCAN = 58
const SHELL_LIST_ID = 0xdb
/** Draws nothing of its own; scans for id QUIET and draws only that companion. */
const BARE = 59

/** Every byte run this file's cart plants, for the copyright check at the foot of the file. */
const planted: number[][] = []

function cart(opts: { breakShellLoader?: boolean } = {}): RomFile {
  const bytes = new Uint8Array(buildSyntheticRom().buffer)
  const off = (snes: number) => (snes >>> 16) * 0x8000 + ((snes & 0xffff) - 0x8000)
  const put = (snes: number, b: number[]) => {
    expect(bytes.subarray(off(snes), off(snes) + b.length).every(v => v === 0)).toBe(true)
    bytes.set(b, off(snes))
    planted.push([...b])
  }
  // JSR $8640 (id 0's draw) / LDY #9 / loop: LDA $14C8,Y / EOR #8 / BNE next / LDA $009E,Y / EOR #51 / BEQ found
  // / next: DEY / BPL loop / RTS / found: PHX / TYX / JSR $8640 / PLX / RTS
  put(0x019800, [
    0x20, 0x40, 0x86, 0xa0, 0x09, 0xb9, 0xc8, 0x14, 0x49, 0x08, 0xd0, 0x07, 0xb9, 0x9e, 0x00,
    0x49, QUIET, 0xf0, 0x04, 0x88, 0x10, 0xef, 0x60, 0xda, 0xbb, 0x20, 0x40, 0x86, 0xfa, 0x60,
  ]) // prettier-ignore
  // LDY #9 / loop: LDA $14C8,Y / EOR #8 / BNE next / LDA $009E,Y / EOR #51 / BEQ found / next: DEY / BPL loop
  // / JSR $8640 / RTS / found: PHX / TYX / JSR $8640 / PLX / LDA $E4,X / CLC / ADC #8 / STA $E4,X / JSR $8640 / RTS
  put(0x019900, [
    0xa0, 0x09, 0xb9, 0xc8, 0x14, 0x49, 0x08, 0xd0, 0x07, 0xb9, 0x9e, 0x00, 0x49, QUIET, 0xf0, 0x07,
    0x88, 0x10, 0xef, 0x20, 0x40, 0x86, 0x60, 0xda, 0xbb, 0x20, 0x40, 0x86, 0xfa, 0xb5, 0xe4, 0x18,
    0x69, 0x08, 0x95, 0xe4, 0x20, 0x40, 0x86, 0x60,
  ]) // prettier-ignore
  const main = (id: number, at: number) => put(0x018320 + 9 + id * 2, [at & 0xff, at >> 8])
  // mainTable entries default to $8600 (an RTS), which are not zero: clear the three words first.
  for (const id of [SCANNER, DRAWS, SHIFTS]) {
    const o = off(0x018320 + 9 + id * 2)
    bytes[o] = 0
    bytes[o + 1] = 0
  }
  // Scanner shape: JSR own / LDY #9 / loop: [LDA $14C8,Y / EOR #8 / BNE next] LDA $9E,Y / EOR #num / BEQ found
  // / next: DEY / BPL loop / RTS / found: PHX / TYX / JSR draw / PLX / RTS.
  const scan = (num: number, own: number, draw: number, withStatus: boolean, status = 8) => {
    const body = [...(withStatus ? [0xb9, 0xc8, 0x14, 0x49, status, 0xd0, 0x07] : []), 0xb9, 0x9e, 0x00, 0x49, num, 0xf0, 0x04, 0x88] // prettier-ignore
    return [0x20, own & 0xff, own >> 8, 0xa0, 0x09, ...body, 0x10, 256 - (body.length + 2), 0x60, 0xda, 0xbb, 0x20, draw & 0xff, draw >> 8, 0xfa, 0x60] // prettier-ignore
  }
  // A draw written for this test: y before x, then the tile bytes given, then the attribute and the size bit (Y is a multiple of 4, so AND #$FC is a no-op; the NOPs are padding).
  // OAM index from $15EA,X; x, y from $E4/$D8,X less the camera ($1A/$1C).
  const drawing = (tile: number[]) => [0xb5, 0xd8, 0x38, 0xea, 0xe5, 0x1c, 0xbc, 0xea, 0x15, 0xea, 0x99, 0x01, 0x03, 0xb5, 0xe4, 0x38, 0xea, 0xe5, 0x1a, 0x99, 0x00, 0x03, ...tile, 0xa9, 0x0a, 0x99, 0x03, 0x03, 0x98, 0x29, 0xfc, 0x4a, 0xea, 0x4a, 0xa8, 0xa9, 0x02, 0xea, 0x99, 0x60, 0x04, 0x60] // prettier-ignore
  // tile = $1600,X + $1640,X
  put(0x019b00, drawing([0xbd, 0x00, 0x16, 0x18, 0x7d, 0x40, 0x16, 0x99, 0x02, 0x03]))
  put(0x019b80, [0xa9, 0x2c, 0x9d, 0x40, 0x16, 0x60]) // COMP's INIT: LDA #$2C / STA $1640,X / RTS
  put(0x019e00, drawing([0xbd, 0xe0, 0x14, 0x99, 0x02, 0x03])) // tile = $14E0,X
  put(0x019a00, scan(COMP, 0x8640, 0x9b00, true))
  put(0x019c00, scan(QUIET, 0x8640, 0x8640, false))
  put(0x019d00, scan(QUIET, 0x8640, 0x9e00, true))
  put(0x019f00, scan(5, 0x8640, 0x8640, true, 9))
  put(0x019f80, scan(QUIET, 0x8600, 0x8640, true)) // own = an RTS: nothing drawn alone
  const word = (table: number, id: number, v: number) => {
    const o = off(table + id * 2)
    bytes[o] = v & 0xff
    bytes[o + 1] = v >> 8
  }
  word(0x018170 + 11, COMP, 0x9b80)
  for (const id of [INITS, NUMONLY, HIGHBYTE, SHELLSCAN, BARE]) word(0x018320 + 9, id, 0)
  word(0x018320 + 9, INITS, 0x9a00)
  word(0x018320 + 9, NUMONLY, 0x9c00)
  word(0x018320 + 9, HIGHBYTE, 0x9d00)
  word(0x018320 + 9, SHELLSCAN, 0x9f00)
  word(0x018320 + 9, BARE, 0x9f80)
  main(SCANNER, 0x9800)
  main(DRAWS, 0x8640)
  main(SHIFTS, 0x9900)
  // The shell ceiling compare's opcode ($02A8C0) is what shellLoad reads for a id from $C9 up: a wrong byte refuses.
  if (opts.breakShellLoader) bytes[off(0x02a8c0)] = 0xea
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

  it('a sprite that draws nothing alone but draws its companion is adopted from an empty run', () => {
    const alone = runOnce(rom, BARE, seedWith())
    expect(alone.chosen).toBeUndefined()
    const m = runOnce(rom, BARE, seedWith([{ id: QUIET, x: 0x90, y: 0x70 }]))
    expect(m.neighbourRun).toBe('adopted')
    expect(partsOf(m).map(p => [p.dx, p.dy])).toEqual([[16, -16]])
  })

  it('a companion found only by changing its own part is not adopted', () => {
    const neighbours = [{ id: QUIET, x: 0x90, y: 0x70 }]
    const alone = runOnce(rom, SHIFTS, seedWith())
    const m = runOnce(rom, SHIFTS, seedWith(neighbours))
    expect(m.scansSlots).toBe(true)
    expect(m.neighbourRun).toBe('same')
    expect(m.dependsOn).not.toContain('neighbours')
    expect(partsOf(m)).toEqual(partsOf(alone))
  })

  it('a neighbour run with no seed.neighbours is refused with a reason, not a crash', () => {
    const make = () => new Machine(rom, seedWith(), SCANNER, undefined, true)
    expect(make).toThrow(Refusal)
    expect(make).toThrow(/neighbour run.*seed lists no neighbours/)
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

describe('neighbour placement (#841)', () => {
  const rom = cart()
  const chars = (m: ReturnType<typeof runOnce>) =>
    partsOf(m)
      .map(p => p.char)
      .sort((a, b) => a - b)

  it("a companion's INIT runs and the loop's InitSpriteTables stores reach its slot before the scanner draws it", () => {
    const m = runOnce(rom, INITS, seedWith([{ id: COMP, x: 0x90, y: 0x70 }]))
    expect(m.neighbourRun).toBe('adopted')
    // $55 from InitSpriteTables(X = its slot) + $2C from its own INIT; either missing changes the tile.
    expect(chars(m)).toEqual([0x24, 0x81])
  })

  it('a scanner that reads only the number table is still run again', () => {
    const m = runOnce(rom, NUMONLY, seedWith([{ id: QUIET, x: 0x90, y: 0x70 }]))
    expect(m.scansSlots).toBe(true)
    expect(m.neighbourRun).toBe('adopted')
    expect(partsOf(m)).toHaveLength(2)
  })

  it('a companion on the next screen is placed with its x high byte (drawn from $14E0,X)', () => {
    const m = runOnce(rom, HIGHBYTE, seedWith([{ id: QUIET, x: 0x110, y: 0x70 }]))
    expect(m.neighbourRun).toBe('adopted')
    expect(chars(m)).toEqual([0x01, 0x24])
  })

  it("a neighbour that refuses in the second run is reported as refused, and the scanner's own picture stands", () => {
    // Id 4's MAIN executes COP: the run alone has no neighbour to refuse on.
    const alone = runOnce(rom, SCANNER, seedWith())
    const m = runOnce(rom, SCANNER, seedWith([{ id: 4, x: 0x90, y: 0x70 }, { id: QUIET, x: 0xa0, y: 0x70 }])) // prettier-ignore
    expect(m.neighbourRun).toBe('refused')
    expect(partsOf(m)).toEqual(partsOf(alone))
  })
})

describe('a neighbour id the loader reader refuses is not placed (#841)', () => {
  it('$DB is skipped and the next neighbour takes the first free slot, not the one after', () => {
    const rom = cart({ breakShellLoader: true })
    expect(shellLoad(rom, SHELL_LIST_ID).refusal).toBeDefined()
    const m = new Machine(rom, seedWith([{ id: SHELL_LIST_ID, x: 0x90, y: 0x70 }, { id: QUIET, x: 0xa0, y: 0x70 }]), 0, undefined, true) // prettier-ignore
    const w = m.bus.wram
    // Slot 0 is the sprite under test, so the first free slot is 1.
    expect(m.neighbourSlots).toEqual([1])
    expect(w[RAM.spriteNumber + 1]).toBe(QUIET)
    for (let k = 2; k < 10; k++) expect(w[RAM.status + k]).toBe(0)
  })
})

describe('a shell neighbour is placed as the loader loads it (#837, #841)', () => {
  const rom = cart()
  const near = { x: 0x90, y: 0x70 }

  it('list id $DB takes number 5 and status 9, so a scan for a status-9 number 5 finds it', () => {
    const m = runOnce(rom, SHELLSCAN, seedWith([{ id: SHELL_LIST_ID, ...near }]))
    expect(m.neighbourRun).toBe('adopted')
    expect(partsOf(m)).toHaveLength(2)
  })

  it('a plain id equal to the shell number is not a status-9 sprite, so the same scan finds nothing', () => {
    const m = runOnce(rom, SHELLSCAN, seedWith([{ id: 5, ...near }]))
    expect(m.neighbourRun).toBe('same')
  })
})

describe('neighboursOf', () => {
  const sp = (index: number, screen: number, x: number, spriteId = 1, y = 5): LevelSprite =>
    ({ screen, x, y, spriteId, extraBit: false, raw: [0, 0, 0], index, streamOffset: index }) // prettier-ignore
  const px = (e: LevelSprite) => ({ x: e.x * 16, y: e.y * 16 })

  it('keeps the screen and the one each side, drops itself and generators, nearest first', () => {
    const me = sp(0, 4, 70)
    const list = [me, sp(1, 6, 100), sp(2, 5, 90), sp(3, 3, 60), sp(4, 4, 71, 0xcb), sp(5, 4, 72)]
    expect(neighboursOf(list, me, px).map(n => n.x / 16)).toEqual([72, 60, 90])
  })

  it('keeps $C8, the status-9 shell ids ($DA-$DD, $DF) and nothing else from $C8 to $FF', () => {
    const me = sp(0, 4, 70)
    const keep = [0xc8, 0xda, 0xdb, 0xdc, 0xdd, 0xdf]
    for (let id = 0xc8; id <= 0xff; id++) {
      const kept = neighboursOf([me, sp(1, 4, 71, id)], me, px).length === 1
      expect(kept, `id $${id.toString(16)}`).toBe(keep.includes(id))
    }
  })

  it('orders by distance in x and y together, not x alone', () => {
    const me = sp(0, 4, 70)
    // Same x distance, different y: ties on x alone keep list order. Then a nearer x that is far in y.
    const list = [me, sp(1, 4, 71, 1, 15), sp(2, 4, 71, 1, 6), sp(3, 4, 69, 1, 25)]
    expect(neighboursOf(list, me, px).map(n => n.y / 16)).toEqual([6, 15, 25])
  })

  it('caps at the free slots (9 of 0-9)', () => {
    const me = sp(0, 1, 20)
    const list = [me, ...Array.from({ length: 15 }, (_, i) => sp(i + 1, 1, 21 + i))]
    expect(neighboursOf(list, me, px)).toHaveLength(9)
  })
})

describe.skipIf(!hasRom(VANILLA))(
  'the fixture routines are not copied from the game (#841)',
  () => {
    it('no 8 consecutive planted bytes occur anywhere in the vanilla cart', () => {
      planted.length = 0
      cart()
      expect(planted.length).toBeGreaterThan(10)
      expect(romWindowHits(planted, freshRom().buffer, 8)).toEqual([])
    })
  },
)
