/**
 * The quiet marker (#1011): a verdict, never an id list. All synthetic, so CI (no ROM) runs it; the vanilla
 * corpus cases are in QuietMarker.corpus.test.ts.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'

// The special drawers need a real ROM to draw; these spies delegate to the real routine and let one test plant an `ok` answer
// (the corpus is absent in CI), so the unreadable-routing mark on a direct result is testable on a synthetic cart.
vi.mock('../../../src/rom/sprites/interp/RotatingRing', async orig => {
  const m = await orig<typeof import('../../../src/rom/sprites/interp/RotatingRing')>()
  return { ...m, rotatingRing: vi.fn(m.rotatingRing) }
})
vi.mock('../../../src/rom/sprites/interp/FiveEeries', async orig => {
  const m = await orig<typeof import('../../../src/rom/sprites/interp/FiveEeries')>()
  return { ...m, fiveEeries: vi.fn(m.fiveEeries) }
})
vi.mock('../../../src/rom/sprites/interp/ThreePlatforms', async orig => {
  const m = await orig<typeof import('../../../src/rom/sprites/interp/ThreePlatforms')>()
  return { ...m, threePlatforms: vi.fn(m.threePlatforms) }
})
vi.mock('../../../src/rom/sprites/interp/TorpedoLauncher', async orig => {
  const m = await orig<typeof import('../../../src/rom/sprites/interp/TorpedoLauncher')>()
  return { ...m, torpedoLauncher: vi.fn(m.torpedoLauncher) }
})
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { composeScreen, DOOR_PART_BIT, DOOR_PART_ID } from '../../../src/rom/model/ColorMath'
import { FALLBACK_SCREENS } from '../../../src/rom/model/ScreenPlanes'
import { loadClasses, type LoadClass } from '../../../src/rom/sprites/interp/LoadClass'
import { rotatingRing } from '../../../src/rom/sprites/interp/RotatingRing'
import { fiveEeries } from '../../../src/rom/sprites/interp/FiveEeries'
import { threePlatforms } from '../../../src/rom/sprites/interp/ThreePlatforms'
import { torpedoLauncher } from '../../../src/rom/sprites/interp/TorpedoLauncher'
import { withSeed } from '../../../src/rom/sprites/interp/SpriteSeed'
import type { SpriteModel } from '../../../src/rom/sprites/interp/SpriteRunner'
import {
  drawSprites,
  drawnByParent,
  framesAnswer,
  framesGate,
  framesOf,
  interpDrawer,
  mapSpriteFrames,
  mapSprites,
  modelResult,
  spriteLayer,
  type SpriteDrawResult,
} from '../../../theia/extension/src/node/map-sprites'
import {
  spriteAt,
  spriteDoors,
  spriteName,
  spritePlanes,
} from '../../../theia/extension/src/browser/map-view-model'
import {
  framesReasonText,
  noteTitle,
  placeholderText,
  quietText,
  spriteProps,
  UNVERIFIED_NOTE,
} from '../../../theia/extension/src/browser/sprite-props'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'
import { COLORS } from '../support/mapInputs'

/** A list sprite with the given id, index and first raw byte (bit 3 is the extra-bits flag). */
const sprite = (spriteId: number, index = 0, raw0 = 0): LevelSprite =>
  ({ screen: 0, x: 3, y: 4, spriteId, extraBit: false, raw: [raw0, 0, 0], index }) as LevelSprite
/** The minimal sprite model drawSprites needs when no pixel is blitted (a verdict-only stand-in). */
const model = { vram: {} as never, colors: COLORS }
// A test stand-in for the loader's routing; production reads it from the ROM (LoadClass.ts).
const routedOf = (id: number): LoadClass =>
  id >= 0xe7 ? 'scroll' : id === 0xc9 ? 'shooter' : 'normal'
/** A drawer that answers each sprite id from a fixed table of results. */
const draw = (results: Record<number, SpriteDrawResult>) => (s: LevelSprite) => results[s.spriteId]!
/** Draws the sprites through drawSprites with the fixed results and the test routing. */
const run = (sprites: LevelSprite[], results: Record<number, SpriteDrawResult>) =>
  drawSprites(sprites, model, draw(results), undefined, routedOf)
/** Reads a DTO bitmap's alpha at a local pixel. */
const alpha = (d: MapSpriteDto) => {
  const b = Buffer.from(d.rgba, 'base64')
  return (x: number, y: number) => b[(y * 16 + x) * 4 + 3]!
}
/** A run model with no passes, overridden by `o`, as the interpreter would hand back. */
const runModel = (o: Partial<SpriteModel>): SpriteModel => ({ id: 1, passes: [], dependsOn: [], steps: [], ...o }) // prettier-ignore

describe('the verdict decides the marker', () => {
  const failed: SpriteDrawResult = { ok: false, reason: 'refused: INIT: step budget spent' }
  const empty: SpriteDrawResult = { ok: false, reason: 'drew no OAM tile', empty: true }
  const routed: SpriteDrawResult = { ok: false, reason: 'routed', routed: 'scroll' }

  it('an empty run is quiet; a refusal, a missing descriptor and no parts keep the failure box', () => {
    const [a, b, c, d] = run([sprite(1, 0), sprite(2, 1), sprite(3, 2), sprite(4, 3)], {
      1: empty,
      2: failed,
      3: { ok: false, failure: { kind: 'noDescriptor', spriteId: 3 } },
      4: {
        ok: true,
        parts: [],
        identity: { spriteId: 4, mainHandler: 0, initHandler: 0, status: 'vanilla' },
      },
    })
    expect([a!.status, b!.status, c!.status, d!.status]).toEqual(['quiet', 'placeholder', 'placeholder', 'placeholder']) // prettier-ignore
    expect(b!.reason).toBe('refused: INIT: step budget spent')
    expect(a!.kind).toBeUndefined()
  })

  it('does not decide by id: the same id is quiet or a failure box by what the run said', () => {
    const [q] = run([sprite(0xc9)], { 0xc9: empty })
    const [f] = run([sprite(0xc9)], { 0xc9: failed })
    expect([q!.status, f!.status]).toEqual(['quiet', 'placeholder'])
  })

  it('an empty run on a generic (unverified) seed keeps the box and its warning', () => {
    const generic = modelResult(runModel({ seedSource: 'generic', seedReason: 'no stock loader', emptyReason: 'drew no OAM tile' })) // prettier-ignore
    expect(generic).toMatchObject({ ok: false, empty: true, unverified: expect.stringContaining('no stock loader') }) // prettier-ignore
    const [d] = run([sprite(1)], { 1: generic })
    expect(d).toMatchObject({ status: 'placeholder', unverified: expect.stringContaining('no stock loader') }) // prettier-ignore
    const [verified] = run([sprite(1)], { 1: modelResult(runModel({ emptyReason: 'drew no OAM tile' })) }) // prettier-ignore
    expect(verified!.status).toBe('quiet')
  })

  it('a run with no chosen pass is empty only when the run says so (develop line and anchor line)', () => {
    expect(modelResult(runModel({ emptyReason: 'drew no OAM tile' }))).toMatchObject({
      ok: false,
      empty: true,
    })
    const unsaid = modelResult(runModel({}))
    expect(unsaid).toEqual({ ok: false, reason: 'drew no tile' })
    expect(run([sprite(1)], { 1: unsaid })[0]!.status).toBe('placeholder')
    const pass = { pass: 0, pos: { x: 0, y: 0 }, origin: { x: 0, y: 0 }, parts: [], uploads: [], palette: [] } // prettier-ignore
    expect(modelResult(runModel({ passes: [pass], chosen: 0, emptyReason: 'x' }))).toMatchObject({ ok: false, empty: true }) // prettier-ignore
    expect(modelResult(runModel({ passes: [pass], chosen: 0 }))).toEqual({
      ok: false,
      reason: 'drew no tile',
    })
  })

  it('spriteLayer passes the loader routing on: a scroll command with extra bits is quiet only with it', () => {
    const stream = Uint8Array.from([0, 0x08, 0x01, 0xe8, 0xff]) // one entry, id $E8, extra bit 3 set
    const m = { ...model, isVertical: false, screenCount: 1 }
    const d = draw({ 0xe8: { ok: false, reason: 'r', routed: 'scroll' } })
    expect(spriteLayer(stream, m, d).sprites[0]).toMatchObject({
      status: 'placeholder',
      reason: 'extraBits',
    })
    expect(spriteLayer(stream, m, d, undefined, routedOf).sprites[0]).toMatchObject({ status: 'quiet', kind: 'scroll' }) // prettier-ignore
  })

  it('a scroll command with extra bits is told "no picture", not the custom-sprite line, in the animation text', () => {
    const s = sprite(0xe8, 0, 0x08)
    expect(framesGate(s, routedOf)).toBe('it has no picture')
    expect(framesGate(sprite(0x10, 0, 0x08), routedOf)).toBe('extraBits')
    expect(framesGate(sprite(0xc9, 0, 0x08), routedOf)).toBe('extraBits') // a boxed shooter keeps the box's words
    expect(framesGate(sprite(0x10), routedOf)).toBeUndefined()
    expect(framesReasonText(framesGate(s, routedOf)!)).not.toMatch(/extra-bits/)
  })
  it('a routed scroll command is quiet even with the extra bits set; a routed shooter with them is not', () => {
    const [scroll] = run([sprite(0xe8, 0, 0x08)], { 0xe8: routed })
    expect(scroll).toMatchObject({ status: 'quiet', kind: 'scroll' })
    const [shooter] = run([sprite(0xc9, 0, 0x08)], { 0xc9: { ...routed, routed: 'shooter' } })
    expect(shooter).toMatchObject({ status: 'placeholder', reason: 'extraBits' })
    expect(run([sprite(0x10, 0, 0x08)], { 0x10: empty })[0]!.reason).toBe('extraBits')
  })

  it('the extra-bits gate is before the draw: an extra-bits sprite that is not a scroll command never runs its code', () => {
    const ran: number[] = []
    const spy = (s: LevelSprite): SpriteDrawResult => {
      ran.push(s.spriteId)
      throw new Error('custom code must not run')
    }
    const out = drawSprites([sprite(0x10, 0, 0x08), sprite(0xc9, 1, 0x08)], model, spy, undefined, routedOf) // prettier-ignore
    expect(out.map(d => d.reason)).toEqual(['extraBits', 'extraBits'])
    expect(ran).toEqual([])
    expect(() => drawSprites([sprite(0xe8, 0, 0x08)], model, spy, undefined, routedOf)).toThrow()
    expect(ran).toEqual([0xe8]) // a scroll command is the one exempt kind
  })
})

describe('the marker', () => {
  const [d] = run([sprite(0xc9)], { 0xc9: { ok: false, reason: 'x', routed: 'shooter' } })
  const a = alpha(d!)

  it('is 16 x 16 at the placed spot, with a clear interior and clear corners', () => {
    expect(d!.box).toEqual({ x0: 48, y0: 64, x1: 64, y1: 80 })
    for (const [x, y] of [[0, 0], [15, 0], [0, 15], [15, 15], [5, 7], [7, 5], [10, 8], [8, 10]]) expect(a(x!, y!)).toBe(0) // prettier-ignore
  })

  it('draws a ring and a center dot, with a dark edge so it reads on light and dark art', () => {
    const px = (x: number, y: number) => Array.from(Buffer.from(d!.rgba, 'base64').subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 3)) // prettier-ignore
    expect(a(7, 7)).toBe(255)
    expect(a(1, 7) + a(14, 7) + a(7, 1) + a(7, 14)).toBeGreaterThan(0)
    const lum = (c: number[]) => c[0]! + c[1]! + c[2]!
    const colors: number[] = []
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) if (a(x, y)) colors.push(lum(px(x, y)))
    expect(Math.max(...colors)).toBeGreaterThan(600)
    expect(Math.min(...colors)).toBeLessThan(150)
    expect(colors.length).toBeLessThan(120)
  })

  it('is hit anywhere in its box, the clear interior included, and the screen door skips it', () => {
    const g = { orientation: 'horizontal' as const, screenCount: 1, width: 512, height: 432 }
    const sprites = [d!]
    // Local (4, 7) is clear in the bitmap (the center dot is (7, 7)): only the whole-box rule hits it.
    expect(a(4, 7)).toBe(0)
    expect(spriteAt(sprites, g, 48 + 4, 64 + 7)?.index).toBe(d!.index)
    expect(spriteAt(sprites, g, 47, 71)).toBeUndefined()
    const doors = spriteDoors({ ...g, sprites }, 0)
    expect(doors && doors.every(v => v === 0)).toBe(true)
  })

  it('draws above a high-priority tile: every lit ring pixel shows over a tile that covers the box', () => {
    const g = { orientation: 'horizontal' as const, screenCount: 1, width: 256, height: 432 }
    const planes = spritePlanes({ ...g, sprites: [d!] }, 0)
    expect(planes.sprites3).not.toBeNull()
    expect([planes.sprites0, planes.sprites1, planes.sprites2]).toEqual([null, null, null])
    const tile = new Uint8ClampedArray(g.width * g.height * 4)
    for (let i = 0; i < tile.length; i += 4) tile.set([200, 0, 0, 255], i)
    const out = composeScreen({ width: g.width, height: g.height, planes: { l1High: tile, ...planes }, lists: FALLBACK_SCREENS, math: null }) // prettier-ignore
    let lit = 0
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const at = ((64 + y) * g.width + 48 + x) * 4
        if (a(x, y)) {
          lit++
          expect(Array.from(out.subarray(at, at + 3))).not.toEqual([200, 0, 0])
        } else expect(Array.from(out.subarray(at, at + 3))).toEqual([200, 0, 0]) // the tile shows through the clear part
      }
    expect(lit).toBeGreaterThan(40)
  })
})

describe('with the failure-marker hover (#1083), the no-reason words (#1113) and the rope door part (#1230)', () => {
  const empty = { ok: false, reason: 'drew no OAM tile in 64 passes', empty: true } as const
  const unrevealed = { ok: false, reason: 'unrevealed', empty: true } as const
  const refused = { ok: false, reason: 'refused: x' } as const

  it('a quiet marker and a failure marker are different statuses: each hover is one text, never both', () => {
    const results = {
      1: empty,
      2: refused,
      0xc9: { ok: false, reason: 'r', routed: 'shooter' },
      4: unrevealed,
    }
    const dtos = run([sprite(1, 0), sprite(2, 1), sprite(0xc9, 2), sprite(4, 3)], results as never)
    expect(dtos.map(d => d.status)).toEqual(['quiet', 'placeholder', 'quiet', 'quiet'])
    for (const d of dtos) {
      if (d.status === 'quiet') {
        expect(placeholderText(d)).toBeUndefined()
        expect(spriteName(d)).toBe(quietText(d))
      } else {
        expect(spriteName(d)).toBe(placeholderText(d))
        expect(spriteName(d)).not.toBe(quietText(d))
      }
    }
  })

  it('Properties shows a quiet sprite as its note, and the frames reason is a different sentence from the same family of words', () => {
    const [q, e] = run([sprite(4, 0), sprite(1, 1)], { 4: unrevealed, 1: empty })
    const words = 'It draws nothing at first, and the app could not tell what reveals it.'
    expect(spriteProps(q!).notes[0]).toBe(words)
    expect(framesReasonText('unrevealed')).toBe(words)
    expect(spriteProps(e!).notes[0]).toBe(
      'Nothing is drawn for it on the map; it may only show up in play.',
    )
    expect(framesReasonText(empty.reason)).toBe('Its code drew no tiles.')
  })

  it('a quiet marker keeps door 0 and has no door-part bit; a rope pixel under a door part gets its own door id', () => {
    const [q] = run([sprite(1, 0)], { 1: empty })
    expect([...Buffer.from(q!.priority!, 'base64')].every(p => (p & DOOR_PART_BIT) === 0)).toBe(
      true,
    )
    const px = (n: number) => Buffer.from(new Uint8Array(n).fill(255)).toString('base64')
    const rope = {
      index: 1,
      id: 0x64,
      x: 100,
      y: 100,
      box: { x0: 100, y0: 100, x1: 102, y1: 102 },
      status: 'drawn',
      rgba: px(16),
      priority: Buffer.from(new Uint8Array(4).fill(2 | DOOR_PART_BIT)).toString('base64'),
      screenDoor: true,
    } as MapSpriteDto
    const g = { orientation: 'horizontal' as const, screenCount: 1, width: 256, height: 432 }
    const doors = spriteDoors({ ...g, sprites: [q!, rope] }, 0)!
    const at = (x: number, y: number) => doors[y * g.width + x]!
    expect(at(q!.x + 7, q!.y + 7)).toBe(0)
    expect(at(100, 100) & (DOOR_PART_ID << 1)).not.toBe(0)
  })
})

describe('plain words', () => {
  it('names the class, then why nothing shows, with no jargon', () => {
    const words = [
      quietText({ kind: 'shooter', name: 'Bullet Bill Shooter' }),
      quietText({ kind: 'scroll', name: 'Whatever' }),
      quietText({ kind: undefined, name: 'Some Sprite' }),
      quietText({ kind: undefined, name: undefined }),
      quietText({ kind: 'generator', name: 'Eerie Generator' }),
    ]
    expect(words[0]).toBe('Bullet Bill Shooter: fires on a timer; nothing is drawn until it does')
    expect(words[1]).toBe('Scroll command: changes how the screen scrolls; it has no picture in the game') // prettier-ignore
    expect(words[2]).toBe(
      'Some Sprite: nothing is drawn for it on the map; it may only show up in play',
    )
    expect(words[3]).toBe('Nothing is drawn for it on the map; it may only show up in play')
    expect(words[4]).toBe('Eerie Generator: runs in the background; it has no picture on the map')
    for (const w of words) expect(w).not.toMatch(/OAM|pass|\$|0x|github|water|fog/i)
  })

  it('a sprite the reveal search could not explain is a quiet marker with the words for it (#1132)', () => {
    const unrevealed = { ok: false, reason: 'unrevealed', empty: true } as const
    const [d] = run([sprite(0x4d)], { 0x4d: unrevealed })
    expect(d).toMatchObject({ status: 'quiet', reason: 'unrevealed' })
    const words = 'It draws nothing at first, and the app could not tell what reveals it.'
    expect(quietText(d!)).toBe(words)
    expect(quietText({ kind: undefined, name: 'Monty Mole', reason: 'unrevealed' })).toBe(
      'Monty Mole: ' + words,
    )
    expect(spriteProps(d!).notes[0]).toBe(words)
  })

  it('the hover and Properties carry it; a failed sprite keeps the old line', () => {
    const [q, f] = run([sprite(0xe8, 0), sprite(2, 1)], { 0xe8: { ok: false, reason: 'r', routed: 'scroll' }, 2: { ok: false, reason: 'refused: x' } }) // prettier-ignore
    expect(spriteName(q!)).toMatch(/^Scroll command/)
    expect(spriteProps(q!).notes[0]).toMatch(/^Scroll command: .*game\.$/)
    expect(spriteProps(f!).notes[0]).toMatch(/^Not drawn: /)
  })

  it('a routed id is not described as drawn by its own routine in the animation line', () => {
    const r = framesOf({ direct: { ok: false, reason: 'x', routed: 'shooter' } }, sprite(0xc9), model) // prettier-ignore
    expect(r.frames).toEqual([])
    const words = framesReasonText(r.reason!)
    expect(words).toBe('It has no picture on the map, so there is nothing to animate.')
    expect(words).not.toMatch(/routine/)
  })
})

// An invented loader routine at the game's call site, table driven and unlike the game's (D126, rule 9). It reads the
// entry's id through a copy of the list pointer, looks up a class code in a test table and stores in the cell of that
// class. It also reads the things the loader's caller seeds (DB, the scroll direction, the list end) and refuses to read
// the id when a run starts from stale state (X, Y, SRAM, a WRAM latch), so each seed and each reset has a test that fails
// without it. No two adjacent instructions here are an adjacent pair of the game's routine (bank_02.asm:5223-5368), compared by eye against that listing; rom-window-probe --bin over the assembled bytes reports no 8-byte window.
const SITE = 0x028b1d
/** How many calls the fixture has before the site, and where the stub each one calls is. */
const CALLS = 8
const stub = (k: number) => 0x029300 + 0x10 * k
/** The fixture's own routine entry (where the real routine starts), and the stub its one call above the eight goes to. */
const ENTRY = 0x028ab1
/** The cell the stretch seeds (PlayerSparkleTimer), which the fixture routine reads to decide on its stub call. */
const SPARKLE = 0x18d3
const ABOVE = 0x029500
/** GivePlayerLives and InvinsibilityTimer (rammap.asm:1908, :1635), and the stubs the fixture calls when they are set. */
const [LIVES_CELL, STAR_CELL, LIVES_HOOK, STAR_HOOK] = [0x18e4, 0x1490, 0x029510, 0x029520]
/** GiveLivesTimer (rammap.asm:1909): the countdown path at bank_02.asm:1363-1364. */
const [TIMER_CELL, TIMER_HOOK] = [0x18e5, 0x029530]
/** PlayerXPosScrRel+1, PlayerYPosScrRel and +1 (rammap.asm:689, :694), direct-page cells read at bank_02.asm:1395-1400. */
const [REL_X_HI, REL_Y, REL_Y_HI] = [0x7f, 0x80, 0x81]
const ROUTINE = 0x029000
const TABLE = 0x029100
const TABLE_BIT3 = 0x029200
const TABLE_BIT2 = 0x029a00
const TABLE_BOTH = 0x029b00
const SCROLL_CELL = 0x143e
const GEN_CELL = 0x18b9
const SHOOT_SLOTS = 0x1783
const [NORMAL, SHOOT, GEN, SCROLL, SCROLL_OFFSET] = [0, 1, 2, 3, 4] // the last stores to the scroll cell, but a different value
/** The same for a shooter and a generator (a different value in the same cell), and a shooter that stores in another slot. */
const [SHOOT_OFFSET, GEN_OFFSET, SHOOT_ELSEWHERE, HITS_BRK] = [5, 6, 7, 8]
const [RTS, BNE_OP, BRA_OP, BEQ_OP] = [0x60, 0xd0, 0x80, 0xf0]
/** Which class code a table byte holds for an id: shooters 0x30-0x33, generators 0x40-0x4f, scroll commands 0x90 up. */
const BANDS = (id: number) =>
  id >= 0x90 ? SCROLL : id >= 0x40 && id < 0x50 ? GEN : id >= 0x30 && id < 0x34 ? SHOOT : NORMAL
/** What the routine stores: the id (steps with it), the id plus a constant, or the class code (does not step). */
type Store = 'id' | 'offset' | 'flat'
interface Plan {
  classes?: (id: number) => number
  /** The table used for an entry with extra bit 3 set; the routine reads it only when this is given. */
  bit3?: (id: number) => number
  /** The table used for an entry with extra bit 2 set (alone or with bit 3); the routine reads it before the bit 3 test. */
  bit2?: (id: number) => number
  /** The table used when both extra bits are set, tested before either alone (AND #$0C, CMP #$0C). */
  both?: (id: number) => number
  store?: Partial<Record<number, Store>>
  /** What a normal id's path does after the dispatch: the default records itself in SRAM and returns. */
  normal?: number[]
  /** Run the rest of the routine in the $82 mirror of the bank. */
  mirror?: boolean
  /** What follows a store; the default returns, and a run that stops at the store never reaches it. */
  afterStore?: number[]
  /** The cell a shooter id stores in. */
  shootCell?: number
  /** What an entry with extra bit 3 runs in place of the table lookup, before the id is read. */
  bit3Path?: number[]
  /** Replace the whole routine. */
  code?: number[]
}
/** The id read: through the copied list pointer into X. */
const ID_READ = [0xa0, 0x03, 0xb7, 0xe0, 0xaa]
/** A normal id: set the SRAM latch, leave X and Y nonzero, return. */
const NORMAL_PATH = [
  0xa9,
  0x05,
  0xeb,
  0xa9,
  0x07,
  0x8f,
  0x00,
  0x00,
  0x70,
  0xa2,
  0x02,
  0xa0,
  0x03,
  RTS,
]
/** 255 times round a two-instruction loop: over 500 steps and well under the cap. */
const LOOP_500 = [0xa2, 0xff, 0xca, BNE_OP, 0xfd]
/** The same loop nested 255 deep: over 100,000 steps, past the cap. */
const LOOP_100K = [0xa0, 0xff, 0xa2, 0xff, 0xca, BNE_OP, 0xfd, 0x88, BNE_OP, 0xf8]
type Item = number | string | { label: string }
/** Bytes with branch operands named by label: a string is the displacement to `{ label }`. */
function assemble(items: Item[], labels = new Map<string, number>()): number[] {
  const at = labels
  let n = 0
  for (const it of items)
    if (typeof it === 'object') at.set(it.label, n)
    else n++
  const out: number[] = []
  for (const it of items) {
    if (typeof it === 'number') out.push(it)
    else if (typeof it === 'string') out.push((at.get(it)! - (out.length + 1)) & 0xff)
  }
  return out
}
/** Where the fixture's gate block is, and the offsets in it of the branch edges (label -> byte offset of the branch). */
const GATES = 0x029600
const edgeAt = new Map<string, number>()
const [LO, HI] = [(n: number) => n & 0xff, (n: number) => n >> 8]
const BRA_EDGE = [BRA_OP, 0x00] // an edge: a branch to the next byte, so it changes nothing until a test points it at itself
/**
 * The stretch's lives, countdown and star gates and the four branch edges the game's runs must take (bank_02.asm:1368,
 * :1378, :1397, :1400), with the game's conditions but other instructions. A seed that misses a gate leaves its stub
 * unseen; a test turns an edge's branch into a self-loop (offset $FE), which only a run that reaches the edge sees.
 */
const gates = assemble(
  [
    // the countdown only under a non-zero lives, the lives hook from 2, the star hook from 8
    ...[0xae, LO(LIVES_CELL), HI(LIVES_CELL), 0xf0, 'endL'],
    ...[
      0xac,
      LO(TIMER_CELL),
      HI(TIMER_CELL),
      0xf0,
      'noT',
      0x20,
      LO(TIMER_HOOK),
      HI(TIMER_HOOK),
      { label: 'noT' },
    ],
    ...[
      0xe0,
      2,
      0x90,
      'noL',
      0x20,
      LO(LIVES_HOOK),
      HI(LIVES_HOOK),
      { label: 'noL' },
      { label: 'endL' },
    ],
    ...[
      0xae,
      LO(STAR_CELL),
      HI(STAR_CELL),
      0xe0,
      8,
      0x90,
      'noS',
      0x20,
      LO(STAR_HOOK),
      HI(STAR_HOOK),
      { label: 'noS' },
    ],
    // lives = 1 with the timer 0 (:1368)
    ...[
      0xae,
      LO(LIVES_CELL),
      HI(LIVES_CELL),
      0xe0,
      1,
      BNE_OP,
      'nA',
      0xac,
      LO(TIMER_CELL),
      HI(TIMER_CELL),
      BNE_OP,
      'nA',
      { label: 'edgeA' },
      ...BRA_EDGE,
      { label: 'nA' },
    ],
    // a star timer of 1-7 (:1378)
    ...[
      0xae,
      LO(STAR_CELL),
      HI(STAR_CELL),
      0xf0,
      'nB',
      0xe0,
      8,
      0xb0,
      'nB',
      { label: 'edgeB' },
      ...BRA_EDGE,
      { label: 'nB' },
    ],
    // the sparkle timer set and the player's screen-relative high byte (X) non-zero (:1397)
    ...[
      0xae,
      LO(SPARKLE),
      HI(SPARKLE),
      0xf0,
      'nC',
      0xac,
      REL_X_HI,
      0x00,
      0xf0,
      'nC',
      { label: 'edgeC' },
      ...BRA_EDGE,
      { label: 'nC' },
    ],
    // the sparkle timer set, both high bytes zero, the player's screen-relative Y at $D0 or more (:1400)
    ...[
      0xae,
      LO(SPARKLE),
      HI(SPARKLE),
      0xf0,
      'nD',
      0xac,
      REL_X_HI,
      0x00,
      BNE_OP,
      'nD',
      0xac,
      REL_Y_HI,
      0x00,
      BNE_OP,
      'nD',
      0xae,
      REL_Y,
      0x00,
      0xe0,
      0xd0,
      0x90,
      'nD',
      { label: 'edgeD' },
      ...BRA_EDGE,
      { label: 'nD' },
    ],
    0x4c, // back into the routine's own start, so the stack is as if the gates were inline
    LO(ENTRY + 26),
    HI(ENTRY + 26),
  ],
  edgeAt,
)
/** A 512 KB LoROM cart whose call site calls the invented routine; `edit` plants a defect after the build. */
function cart(
  plan: Plan = {},
  edit: (put: (at: number, b: number[]) => void) => void = () => undefined,
): RomFile {
  const buf = Buffer.alloc(0x80000)
  buf[0x7fd5] = 0x20
  const put = (at: number, bytes: number[]) =>
    buf.set(bytes, (at & 0x7fff) + ((at >> 16) & 0x3f) * 0x8000)
  const value = (s: Store) => (s === 'id' ? [0x8a] : s === 'offset' ? [0x8a, 0x18, 0x69, 0xf9] : [])
  const tail = (code: number, cell: number): Item[] => [
    ...value(
      plan.store?.[code] ??
        (code === SCROLL_OFFSET || code === SHOOT_OFFSET || code === GEN_OFFSET ? 'offset' : 'id'),
    ),
    0x8f,
    cell & 0xff,
    cell >> 8,
    0x00,
    ...(plan.afterStore ?? [RTS]),
  ]
  const jump = (ROUTINE & 0xffff) + 6 // the mirror's jump lands on the next byte after it
  const lookup = (table: number): Item[] => [0xbd, table & 0xff, table >> 8]
  const code = assemble(
    plan.code ?? [
      0xa5,
      0x14, // the opening the call site's target must have
      ...(plan.mirror ? [0x5c, jump & 0xff, jump >> 8, 0x82] : []),
      0xeb,
      BNE_OP,
      'ret', // stale A high byte (XBA brings it down)
      0xe0,
      0x00,
      BNE_OP,
      'ret',
      0xc0,
      0x00,
      BNE_OP,
      'ret', // stale X, stale Y
      0xaf,
      0x00,
      0x00,
      0x70,
      BNE_OP,
      'ret',
      0xad,
      0x00,
      0x0f,
      BNE_OP,
      'ret',
      0xee,
      0x00,
      0x0f,
      0xad,
      SPARKLE & 0xff,
      SPARKLE >> 8,
      BNE_OP,
      'ret', // SRAM and WRAM latches
      0xa5,
      0x55,
      0x49,
      0x01,
      BNE_OP,
      'ret', // the boundary seed
      0xa5,
      0xce,
      0x85,
      0xe0,
      0xa5,
      0xcf,
      0x85,
      0xe1,
      0xa5,
      0xd0,
      0x85,
      0xe2, // a copy of the list pointer
      0xa0,
      0x04,
      0xb7,
      0xe0,
      0x1a,
      BNE_OP,
      'ret', // the list end
      ...(plan.both
        ? [
            0xaf,
            0x01,
            0xe0,
            0x7e,
            0x29,
            0x0c,
            0xc9,
            0x0c,
            BNE_OP,
            'noBoth',
            ...ID_READ,
            ...lookup(TABLE_BOTH),
            BRA_OP,
            'go',
            { label: 'noBoth' },
          ]
        : []),
      ...(plan.bit2
        ? [
            0xaf,
            0x01,
            0xe0,
            0x7e,
            0x89,
            0x04,
            BEQ_OP,
            'no2', // the flags byte, bit 2
            ...ID_READ,
            ...lookup(TABLE_BIT2),
            BRA_OP,
            'go',
            { label: 'no2' },
          ]
        : []),
      ...(plan.bit3 || plan.bit3Path
        ? [
            0xaf,
            0x01,
            0xe0,
            0x7e,
            0x89,
            0x08,
            BEQ_OP,
            'plain', // the flags byte, bit 3
            ...(plan.bit3Path ?? [...ID_READ, ...lookup(TABLE_BIT3), BRA_OP, 'go']),
            { label: 'plain' },
          ]
        : []),
      ...ID_READ,
      ...lookup(TABLE),
      { label: 'go' },
      0xc9,
      SHOOT,
      BEQ_OP,
      'shoot',
      0xc9,
      GEN,
      BEQ_OP,
      'gen',
      0xc9,
      SCROLL,
      BEQ_OP,
      'scroll',
      0xc9,
      SCROLL_OFFSET,
      BEQ_OP,
      'offset',
      0xc9,
      SHOOT_OFFSET,
      BEQ_OP,
      'shootOff',
      0xc9,
      GEN_OFFSET,
      BEQ_OP,
      'genOff',
      0xc9,
      SHOOT_ELSEWHERE,
      BEQ_OP,
      'elsewhere',
      0xc9,
      HITS_BRK,
      BNE_OP,
      'fine',
      0x00, // BRK: a run no sweep can read
      { label: 'fine' },
      ...(plan.normal ?? NORMAL_PATH),
      { label: 'shoot' },
      ...tail(SHOOT, plan.shootCell ?? SHOOT_SLOTS + 2),
      { label: 'gen' },
      ...tail(GEN, GEN_CELL),
      { label: 'shootOff' },
      ...tail(SHOOT_OFFSET, plan.shootCell ?? SHOOT_SLOTS + 2),
      { label: 'genOff' },
      ...tail(GEN_OFFSET, GEN_CELL),
      { label: 'elsewhere' },
      ...tail(SHOOT_ELSEWHERE, (plan.shootCell ?? SHOOT_SLOTS + 2) + 1),
      { label: 'offset' },
      ...tail(SCROLL_OFFSET, SCROLL_CELL),
      { label: 'scroll' },
      ...tail(SCROLL, SCROLL_CELL),
      { label: 'ret' },
      RTS,
    ],
  )
  put(SITE, [0x20, ROUTINE & 0xff, (ROUTINE >> 8) & 0xff])
  // The main loop's stretch before the site: eight calls to invented stubs that just return, run on the core.
  for (let k = 1; k <= CALLS; k++) {
    put(SITE - 3 * k, [0x20, stub(k) & 0xff, stub(k) >> 8])
    put(stub(k), [RTS])
  }
  // The routine's own start, invented: push a byte, call a stub only when the seeded cell holds 2 (an XOR test, not the
  // game's), then branch on a zeroed cell to the eight calls; filler between.
  put(ENTRY, new Array(0x54).fill(0x4b))
  put(ENTRY, [
    0x48,
    // A, X and Y must be zero when a run starts: a stale one loops (compared before any of them is loaded)
    ...[0xc9, 0xe0, 0xc0].flatMap(op => [op, 0x00, BNE_OP, 0xfe]),
    0xad,
    SPARKLE & 0xff,
    SPARKLE >> 8,
    0x49,
    0x02,
    0xd0,
    0x03,
    0x20,
    ABOVE & 0xff,
    ABOVE >> 8,
    0x4c,
    LO(GATES),
    HI(GATES),
    0xa5,
    0x14,
    0xf0,
    0x54 - 30,
  ])
  put(ABOVE, [RTS])
  put(GATES, gates)
  put(LIVES_HOOK, [RTS])
  put(STAR_HOOK, [RTS])
  put(TIMER_HOOK, [RTS])
  put(ROUTINE, new Array(0x100).fill(0x4b)) // filler after the code, never run
  put(ROUTINE, code)
  put(
    TABLE,
    Array.from({ length: 256 }, (_, id) => (plan.classes ?? BANDS)(id)),
  )
  put(
    TABLE_BIT3,
    Array.from({ length: 256 }, (_, id) => (plan.bit3 ?? BANDS)(id)),
  )
  put(
    TABLE_BIT2,
    Array.from({ length: 256 }, (_, id) => (plan.bit2 ?? BANDS)(id)),
  )
  put(
    TABLE_BOTH,
    Array.from({ length: 256 }, (_, id) => (plan.both ?? BANDS)(id)),
  )
  edit(put)
  return RomFile.fromBytes('x.sfc', buf)
}
/** A cart whose sprite main loop no longer calls the loader, so its routing cannot be read. */
const noLoader = () => cart({}, put => put(SITE, [0xea]))
/** An empty seed and a one-screen horizontal level: all interpDrawer needs when the run is a spy. */
const seedFor = () => withSeed({ loaded: new Uint8Array(0x2000) })
const geometry = { isVertical: false, screenCount: 1 }
/** The unavailable reason for a ROM's loader read, or 'ok'. */
const reasonOf = (rom: RomFile) => {
  const r = loadClasses(rom)
  return r.status === 'unavailable' ? r.reason : 'ok'
}
/** Class codes with a run of ids moved: the shooter ids in two pieces, a generator band below the shooters, or a hole in the scroll ids. */
const withGap = (id: number) => (id === 0x32 ? NORMAL : BANDS(id))
const generatorsFirst = (id: number) =>
  id >= 0x10 && id < 0x20
    ? GEN
    : id >= 0x30 && id < 0x34
      ? SHOOT
      : BANDS(id) === GEN
        ? NORMAL
        : BANDS(id)
/** A single generator id where the band should be. */
const oneGenerator = (id: number) => (id === 0x60 ? GEN : BANDS(id) === GEN ? NORMAL : BANDS(id))
const scrollHole = (id: number) => (id === 0xc0 ? NORMAL : BANDS(id))

describe('LoadClass runs the loader and reads the class from what it writes', () => {
  it.each([
    [0x00, 'normal'],
    [0x2f, 'normal'],
    [0x30, 'shooter'],
    [0x33, 'shooter'],
    [0x34, 'normal'],
    [0x40, 'generator'],
    [0x4f, 'generator'],
    [0x50, 'normal'],
    [0x8f, 'normal'],
    [0x90, 'scroll'],
    [0xff, 'scroll'],
  ] as [number, LoadClass][])('routes id $%s as %s', (id, want) => {
    const r = loadClasses(cart())
    if (r.status !== 'ok') throw new Error(r.reason)
    expect(r.of(id)).toBe(want)
  })

  it('a run starts from a reset machine: no X, Y, SRAM or WRAM left by the run before', () => {
    // The routine returns before reading the id when any of them is stale, which makes the table unavailable.
    expect(reasonOf(cart())).toBe('ok')
  })

  it('a value that steps with the id from a constant offset is accepted', () => {
    const offset = { [SCROLL]: 'offset', [GEN]: 'offset', [SHOOT]: 'offset' } as const
    expect(reasonOf(cart({ store: offset }))).toBe('ok')
  })

  it('a return through the other bank mirror counts as a return', () => {
    expect(reasonOf(cart({ mirror: true }))).toBe('ok')
  })

  it.each([
    ['the call site is not a JSR', noLoader(), /does not call the level loader/],
    [
      'the target does not open with a direct-page load',
      cart({}, put => put(ROUTINE, [0xea])),
      /does not open the way/,
    ],
    ['a normal id hits BRK', cart({ normal: [0x00] }), /id \$00: BRK executed/],
    [
      'a normal id leaves ROM',
      cart({ normal: [0x5c, 0x00, 0x00, 0x7e] }),
      /id \$00: execution left ROM/,
    ],
    [
      'a normal id runs past the step cap',
      cart({ normal: [...LOOP_100K, ...NORMAL_PATH] }),
      /id \$00: did not return within 50000 steps/,
    ],
    [
      'a normal id returns with the stack off',
      cart({ normal: [0x48, RTS] }),
      /id \$00: returned with the stack/,
    ],
    [
      'a stray pop in the mirror bank keeps running',
      cart({ mirror: true, normal: [0xc2, 0x20, 0x68, 0xea, RTS] }),
      /id \$00: returned with the stack/,
    ],
    [
      'a return to the wrong bank that is not a mirror',
      cart({ normal: [0x5c, 0x00, 0x95, 0x03] }, put => put(0x039500, [RTS])),
      /id \$00: returned with the stack or the bank wrong/,
    ],
    [
      'a mirror return with the stack off',
      cart({ mirror: true, normal: [0xf4, 0xff, 0x7e, RTS] }),
      /id \$00: returned with the stack or the bank wrong/,
    ],
    [
      'the routine returns at once',
      cart({ code: [0xa5, 0x14, RTS] }),
      /without reading the list entry/,
    ],
    [
      'every id stores to one cell',
      cart({ classes: () => SCROLL }),
      /do not tell routed ids from sprites/,
    ],
    ['no id is routed', cart({ classes: () => NORMAL }), /do not tell routed ids from sprites/],
    ['the shooter ids have a gap', cart({ classes: withGap }), /shooter ids are not one run/],
    [
      'the generators come before the shooters',
      cart({ classes: generatorsFirst }),
      /(shooter|generator) ids do not come after/,
    ],
    ['the scroll ids have a hole', cart({ classes: scrollHole }), /scroll ids are not one run/],
    [
      'the shooter value does not step with the id',
      cart({ store: { [SHOOT]: 'flat' } }),
      /shooter value does not step/,
    ],
    [
      'the generator value does not step with the id',
      cart({ store: { [GEN]: 'flat' } }),
      /generator value does not step/,
    ],
    [
      'the scroll value does not step with the id',
      cart({ store: { [SCROLL]: 'flat' } }),
      /scroll value does not step/,
    ],
    [
      'a generator band of one id with a flat value',
      cart({ classes: oneGenerator, store: { [GEN]: 'flat' } }),
      /generator ids are a single id/,
    ],
    ['the ROM is not LoROM', cart({}, put => put(0x00ffd5, [0x21])), /not LoROM/],
  ] as [string, RomFile, RegExp][])('unavailable when %s', (_title, rom, why) => {
    expect(reasonOf(rom)).toMatch(why)
  })

  it('a ROM with no loader at all is unavailable', () => {
    const blank = RomFile.fromBytes('x.sfc', Buffer.alloc(0x80000))
    expect(loadClasses(blank)).toMatchObject({ status: 'unavailable' })
  })

  it('a stepping band of two ids reads ok', () => {
    const two = (id: number) => (id === 0x32 || id === 0x33 ? NORMAL : BANDS(id))
    const r = loadClasses(cart({ classes: two }))
    if (r.status !== 'ok') throw new Error(r.reason)
    expect([0x30, 0x31, 0x32].map(id => r.of(id))).toEqual(['shooter', 'shooter', 'normal'])
  })

  it('a normal path of a few hundred steps is read, not cut off', () => {
    expect(reasonOf(cart({ normal: [...LOOP_500, ...NORMAL_PATH] }))).toBe('ok')
  })

  it.each([0x1782, 0x1783, 0x1784, 0x1786, 0x1789, 0x178a, 0x178b])(
    'a shooter store at $%s is a shooter only inside the 8 slots',
    cell => {
      const r = loadClasses(cart({ shootCell: cell }))
      if (r.status !== 'ok') throw new Error(r.reason)
      expect(r.of(0x31)).toBe(cell >= 0x1783 && cell <= 0x178a ? 'shooter' : 'normal')
    },
  )
})

describe('LoadClass runs the stretch before the call', () => {
  /** The cart with the callee of call `k` replaced by `bytes`. */
  const hook = (k: number, bytes: number[]) => cart({}, put => put(stub(k), bytes))
  const unreached = /does not reach the level loader's call/
  const toLoader = [ROUTINE & 0xff, ROUTINE >> 8]
  const siteReturn = [(SITE + 2) & 0xff, ((SITE + 2) >> 8) & 0xff]

  it.each([
    ['a callee pops its return and leaves', hook(3, [0x68, 0x68, 0x5c, 0x00, 0x80, 0x10])],
    ['a callee loops', hook(3, [0x80, 0xfe])],
    ['a callee pops its return and returns out of the stretch', hook(3, [0x68, 0x68, RTS])],
    ['a callee jumps to the loader with the stack off', hook(3, [0x48, 0x4c, ...toLoader])],
    [
      'a JML over one call goes to a stub that returns',
      cart({}, put => put(SITE - 9, [0x5c, stub(1) & 0xff, stub(1) >> 8, 0x02])),
    ],
    ['a BRA over one call goes into a loop', cart({}, put => put(SITE - 9, [0x80, 0xfe]))],
    [
      'a JMP replaces the seeded call above the eight and never arrives',
      cart({}, put => (put(ENTRY + 8, [0x4c, 0x00, 0x94]), put(0x029400, [0x80, 0xfe]))),
    ],
    [
      'the first call is a call to the loader and a later one leaves',
      cart(
        {},
        put => (
          put(SITE - 24, [0x20, ...toLoader]),
          put(stub(5), [0x68, 0x68, 0x5c, 0x00, 0x80, 0x10])
        ),
      ),
    ],
    ['the last call is a call to the loader', cart({}, put => put(SITE - 3, [0x20, ...toLoader]))],
    ['a callee jumps to the loader with the stack balanced', hook(3, [0x4c, ...toLoader])],
    [
      'a callee returns into the loader through a pushed address',
      hook(3, [0xf4, (ROUTINE - 1) & 0xff, (ROUTINE - 1) >> 8, RTS]),
    ],
    [
      'a callee pops its return, pushes another and jumps to the loader',
      hook(3, [0x68, 0x68, 0xf4, 0x34, 0x12, 0x4c, ...toLoader]),
    ],
    [
      'a callee pops below the stretch, then forges the site frame and jumps to the loader',
      hook(3, [0x68, 0x68, 0x68, 0x68, 0xf4, 0x00, 0x00, 0xf4, ...siteReturn, 0x4c, ...toLoader]),
    ],
    [
      'a callee forges the site frame and jumps to the loader address in another bank',
      cart(
        {},
        put => (
          put(stub(3), [0x68, 0x68, 0xf4, ...siteReturn, 0x5c, ...toLoader, 0x03]),
          put(0x039000, [0x80, 0xfe])
        ),
      ),
    ],
    [
      'a callee pushes the site return address and jumps to the loader from a deeper stack',
      hook(3, [0xf4, (SITE + 2) & 0xff, ((SITE + 2) >> 8) & 0xff, 0x4c, ...toLoader]),
    ],
  ])('unavailable when %s', (_title, rom) => {
    expect(reasonOf(rom)).toMatch(unreached)
  })

  it.each([
    ['the lives branch loops', LIVES_HOOK, [0x80, 0xfe]],
    ['the lives branch pops its return and leaves', LIVES_HOOK, [0x68, 0x68, RTS]],
    ['the lives countdown loops', TIMER_HOOK, [0x80, 0xfe]],
    ['the lives countdown pops its return and leaves', TIMER_HOOK, [0x68, 0x68, RTS]],
    ['the star branch loops', STAR_HOOK, [0x80, 0xfe]],
    ['the star branch pops its return and leaves', STAR_HOOK, [0x68, 0x68, RTS]],
  ])('unavailable when a hook in %s', (_title, at, bytes) => {
    expect(reasonOf(cart({}, put => put(at, bytes)))).toMatch(unreached)
  })

  it.each([
    ['A', [0xa9, 0x05]],
    ['X', [0xa2, 0x05]],
    ['Y', [0xa0, 0x05]],
  ])('a run starts with %s zero, whatever the run before left in it', (_r, load) => {
    expect(reasonOf(cart({}, put => put(ABOVE, [...load, RTS])))).toBe('ok')
  })

  it.each([
    ['edgeA', 'lives 1 with the timer 0 (:1368)'],
    ['edgeB', 'a star timer of 1-7 (:1378)'],
    ['edgeC', 'a non-zero screen-relative high byte (:1397)'],
    ['edgeD', 'a screen-relative Y of $D0 or more (:1400)'],
  ])('unavailable when the branch taken for %s (%s) is turned into a loop', (label, _what) => {
    expect(reasonOf(cart({}, put => put(GATES + edgeAt.get(label)! + 1, [0xfe])))).toMatch(
      unreached,
    )
  })

  it('a hook at the seeded call that returns normally still reads ok', () => {
    expect(reasonOf(cart({}, put => put(ABOVE, [0xa9, 0x01, RTS])))).toBe('ok')
  })

  it.each([['a callee that does something else and returns', [0xa9, 0x01, RTS]]])(
    '%s still reads ok: the stretch proves arrival, not what the callees do',
    (_title, bytes) => {
      expect(reasonOf(hook(3, bytes))).toBe('ok')
    },
  )

  it('a byte edit in a callee recomputes', () => {
    const rom = cart()
    expect(reasonOf(rom)).toBe('ok')
    rom.writeAt(stub(5), [0x80, 0xfe])
    expect(reasonOf(rom)).toMatch(unreached)
  })

  it('what a callee leaves in WRAM or writes to a routing cell does not reach the sweeps', () => {
    const latch = [
      0xa9,
      0x01,
      0x8d,
      0x00,
      0x0f,
      0x8f,
      SCROLL_CELL & 0xff,
      SCROLL_CELL >> 8,
      0x00,
      RTS,
    ]
    const r = loadClasses(hook(2, latch))
    if (r.status !== 'ok') throw new Error(r.reason)
    expect([0x31, 0x45, 0x95].map(id => r.of(id))).toEqual(['shooter', 'generator', 'scroll'])
  })
})

describe('LoadClass extra bit 3', () => {
  const withBit = (id: number) => ({ ...sprite(id), raw: [0x08, 0, id] }) as LevelSprite
  /** The classes of a cart whose second sweep (extra bit 3) routes ids as `bit3` says. */
  const classesWith = (bit3: (id: number) => number) => {
    const r = loadClasses(cart({ bit3 }))
    if (r.status !== 'ok') throw new Error(r.reason)
    return r
  }
  const moved = (id: number) => (id >= 0x10 && id < 0x20 ? SCROLL : NORMAL)
  const onShooters = (id: number) => (id >= 0x30 && id < 0x34 ? SCROLL : BANDS(id))

  it('an entry with the bit set is a scroll command only when the plain sweep and the second sweep both say so', () => {
    const r = classesWith(BANDS)
    expect([0x50, 0x95, 0xa0].map(id => r.of(id, 0x08))).toEqual(['normal', 'scroll', 'scroll'])
    expect([0x50, 0x95, 0xa0].map(id => r.of(id))).toEqual(['normal', 'scroll', 'scroll'])
  })

  it.each([
    ['a band the second sweep moved onto plain normal ids', moved, 0x15],
    ['a band the second sweep put on plain shooters', onShooters, 0x31],
  ])('%s gets no exemption: its sprite code does not run and the box stays', (_t, bit3, id) => {
    const r = classesWith(bit3)
    expect(r.of(id, 0x08)).toBe('normal')
    const ran: number[] = []
    const run = (_r: RomFile, i: number) => (ran.push(i), runModel({ refusal: 'spy' }))
    const real = interpDrawer(cart({ bit3 }), 0, geometry, run, seedFor)
    const [d] = drawSprites([withBit(id)], model, real, undefined, r.of)
    expect(d).toMatchObject({ status: 'placeholder', reason: 'extraBits' })
    expect(ran).toEqual([])
  })

  it('the gate lets an extra-bits scroll command through only when the second sweep agrees on every one', () => {
    const scroll = { ok: false, reason: 'r', routed: 'scroll' } as const
    const results = { 0x95: scroll, 0xa0: scroll }
    const sprites = [withBit(0x95), withBit(0xa0)]
    const kept = drawSprites(sprites, model, draw(results), undefined, classesWith(BANDS).of)
    expect(kept.map(d => [d.status, d.kind])).toEqual([
      ['quiet', 'scroll'],
      ['quiet', 'scroll'],
    ])
    const some = classesWith(id => (id >= 0xa0 ? SCROLL : NORMAL)).of
    const lost = drawSprites(sprites, model, draw(results), undefined, some)
    expect(lost.map(d => [d.status, d.reason])).toEqual([
      ['placeholder', 'extraBits'],
      ['placeholder', 'extraBits'],
    ])
  })

  it.each([
    ['a different value in the scroll cell', SCROLL_OFFSET],
    ['the same value in another cell', GEN],
  ])('a scroll id that stores %s with the bit set gets no exemption', (_t, code) => {
    const r = classesWith(id => (id >= 0x90 ? code : NORMAL))
    expect([0x95, 0xa0].map(id => r.of(id, 0x08))).toEqual(['normal', 'normal'])
    expect(r.of(0xa0)).toBe('scroll')
  })

  it.each([
    [0x00, 'scroll'],
    [0x08, 'scroll'],
    [0x04, 'normal'],
    [0x0c, 'normal'],
  ])(
    'a loader that routes id A0 as scroll for extra bits 0 and 8 only: bits %i gives %s',
    (bits, want) => {
      const r = loadClasses(cart({ bit2: () => NORMAL }))
      if (r.status !== 'ok') throw new Error(r.reason)
      expect(r.of(0xa0, bits)).toBe(want)
    },
  )

  it('the gate shows no quiet marker for a scroll id whose $04 or $0C combination the loader routes as normal', () => {
    const r = classesWith(BANDS)
    const bit2 = loadClasses(cart({ bit2: () => NORMAL }))
    if (bit2.status !== 'ok') throw new Error('unavailable')
    const scroll = { ok: false, reason: 'r', routed: 'scroll' } as const
    for (const id of SCROLLS) {
      const at = (flags: number) => ({ ...sprite(id), raw: [flags, 0, id] }) as LevelSprite
      const out = drawSprites([at(0x00), at(0x08), at(0x04), at(0x0c)], model, draw({ [id]: scroll }), undefined, bit2.of) // prettier-ignore
      expect(out.map(d => d.status), `id ${id}`).toEqual(['quiet', 'quiet', 'placeholder', 'placeholder']) // prettier-ignore
      expect(r.of(id, 0x08)).toBe('scroll')
    }
  })

  const COMBOS = [0x04, 0x08, 0x0c]
  const SCROLLS = Array.from({ length: 0x70 }, (_, k) => 0x90 + k)

  it('a loader that routes the scroll ids as scroll for every combination grants each of $04, $08 and $0C, on every id', () => {
    const r = loadClasses(cart({ bit2: BANDS, bit3: BANDS }))
    if (r.status !== 'ok') throw new Error(r.reason)
    for (const bits of COMBOS) expect(SCROLLS.map(id => r.of(id, bits)), `bits ${bits}`).toEqual(SCROLLS.map(() => 'scroll')) // prettier-ignore
  })

  it('a loader that changes the scroll ids only when bit 3 is set leaves $04 alone and takes $08 and $0C', () => {
    const r = classesWith(() => NORMAL)
    expect([0x04, 0x08, 0x0c].map(b => r.of(0xa0, b))).toEqual(['scroll', 'normal', 'normal'])
  })

  it('a loader that moves the scroll ids for bit 2 only takes $04 and $0C and leaves $08', () => {
    const r = loadClasses(cart({ bit2: () => NORMAL }))
    if (r.status !== 'ok') throw new Error(r.reason)
    expect(SCROLLS.map(id => r.of(id, 0x08))).toEqual(SCROLLS.map(() => 'scroll'))
    expect(SCROLLS.map(id => r.of(id, 0x0c))).toEqual(SCROLLS.map(() => 'normal'))
  })

  const BANDS_OF = {
    shooter: [0x30, 0x31, 0x32, 0x33],
    generator: Array.from({ length: 16 }, (_, k) => 0x40 + k),
  }
  it.each(['shooter', 'generator'] as const)(
    'every plain %s the loader routes as normal with bit 2 set is boxed, not a quiet marker',
    kind => {
      const r = loadClasses(cart({ bit2: () => NORMAL }))
      if (r.status !== 'ok') throw new Error(r.reason)
      for (const id of BANDS_OF[kind]) {
        expect([0x04, 0x0c].map(b => r.of(id, b))).toEqual(['normal', 'normal'])
        expect(r.of(id)).toBe(kind)
        const results = { [id]: { ok: false, reason: 'r', routed: kind } as SpriteDrawResult }
        for (const flags of [0x04, 0x0c]) {
          const s = { ...sprite(id), raw: [flags, 0, id] } as LevelSprite
          const [d] = drawSprites([s], model, draw(results), undefined, r.of)
          expect(d, `id ${id} flags ${flags}`).toMatchObject({ status: 'placeholder', reason: 'extraBits' }) // prettier-ignore
        }
      }
    },
  )

  it('shooters and generators whose class bit 2 does not change keep the quiet marker; so do the plain ones', () => {
    const r = loadClasses(cart({ bit2: BANDS }))
    if (r.status !== 'ok') throw new Error(r.reason)
    for (const kind of ['shooter', 'generator'] as const)
      for (const id of BANDS_OF[kind]) {
        expect(r.of(id, 0x04)).toBe(kind)
        const results = { [id]: { ok: false, reason: 'r', routed: kind } as SpriteDrawResult }
        const at = (flags: number) => ({ ...sprite(id), raw: [flags, 0, id] }) as LevelSprite
        const out = drawSprites([at(0x04), at(0)], model, draw(results), undefined, r.of)
        expect(
          out.map(d => d.status),
          `id ${id}`,
        ).toEqual(['quiet', 'quiet'])
      }
  })

  it('a band the bit-2 sweep moved onto plain normal ids is boxed with that combination and drawn without it', () => {
    const r = loadClasses(cart({ bit2: moved }))
    if (r.status !== 'ok') throw new Error(r.reason)
    const empty = { ok: false, reason: 'drew no OAM tile', empty: true } as const
    for (let id = 0x10; id < 0x20; id++) {
      expect(r.of(id, 0x04), `id ${id}`).not.toBe('normal')
      expect([r.of(id), r.of(id, 0x08)]).toEqual(['normal', 'normal'])
      const at = (flags: number) => ({ ...sprite(id), raw: [flags, 0, id] }) as LevelSprite
      const [boxed, plain] = drawSprites([at(0x04), at(0)], model, draw({ [id]: empty }), undefined, r.of) // prettier-ignore
      expect(boxed, `id ${id}`).toMatchObject({ status: 'placeholder', reason: 'extraBits' })
      expect(plain!.reason).not.toBe('extraBits')
      expect(framesGate(at(0x04), r.of), `id ${id}`).toBe('extraBits')
    }
  })

  it('a normal id whose bit-2 run proves nothing (BRK) is boxed with that combination, not read as normal', () => {
    const r = loadClasses(cart({ bit2: id => (id >= 0x10 && id < 0x20 ? HITS_BRK : BANDS(id)) }))
    if (r.status !== 'ok') throw new Error(r.reason)
    for (let id = 0x10; id < 0x20; id++) {
      // a stand-in class that boxes: any routed class but scroll (the one that unboxes); no consumer tells them apart
      expect(r.of(id, 0x04), `id ${id}`).toBe('generator')
      expect(r.of(id)).toBe('normal')
    }
    expect([0x05, 0x31, 0x95].map(id => r.of(id, 0x04))).toEqual(['normal', 'shooter', 'scroll'])
  })

  it.each([0x08, 0x0c])(
    'one class whose bit-3 run proves nothing (BRK) loses only itself under %i',
    bits => {
      const r = loadClasses(cart({ bit3: id => (BANDS(id) === SHOOT ? HITS_BRK : BANDS(id)) }))
      if (r.status !== 'ok') throw new Error(r.reason)
      expect(SCROLLS.map(id => r.of(id, bits))).toEqual(SCROLLS.map(() => 'scroll'))
      expect(BANDS_OF.generator.map(id => r.of(id, bits))).toEqual(BANDS_OF.generator.map(() => 'generator')) // prettier-ignore
      expect(BANDS_OF.shooter.map(id => r.of(id, bits))).toEqual(
        BANDS_OF.shooter.map(() => 'normal'),
      )
    },
  )

  it('a combination of both bits is judged by its own run: $04 and $08 kept does not keep $0C', () => {
    const r = loadClasses(cart({ bit2: BANDS, bit3: BANDS, both: () => NORMAL }))
    if (r.status !== 'ok') throw new Error(r.reason)
    expect(SCROLLS.map(id => r.of(id, 0x04))).toEqual(SCROLLS.map(() => 'scroll'))
    expect(SCROLLS.map(id => r.of(id, 0x08))).toEqual(SCROLLS.map(() => 'scroll'))
    expect(SCROLLS.map(id => r.of(id, 0x0c))).toEqual(SCROLLS.map(() => 'normal'))
  })

  it.each([
    ['a different value in the same cell', SHOOT_OFFSET, GEN_OFFSET],
    ['the same value in another shooter slot', SHOOT_ELSEWHERE, GEN],
  ])('a shooter or generator that stores %s under bit 2 is not kept', (_t, shootCode, genCode) => {
    const r = loadClasses(cart({ bit2: id => (BANDS(id) === SHOOT ? shootCode : BANDS(id) === GEN ? genCode : BANDS(id)) })) // prettier-ignore
    if (r.status !== 'ok') throw new Error(r.reason)
    const [shooters, gens] = [BANDS_OF.shooter, BANDS_OF.generator]
    expect(shooters.map(id => r.of(id, 0x04))).toEqual(shooters.map(() => 'normal'))
    // the generator row of the second case stores the same value in the same cell, so it is kept; a different value is not
    expect(gens.map(id => r.of(id, 0x04))).toEqual(gens.map(() => (genCode === GEN ? 'generator' : 'normal'))) // prettier-ignore
    expect(SCROLLS.map(id => r.of(id, 0x04))).toEqual(SCROLLS.map(() => 'scroll'))
  })

  it('framesGate follows the real extra bits: $04 and $0C are read, not just bit 3', () => {
    const only0c = (id: number, bits?: number): LoadClass => (bits ? (bits === 0x0c ? 'scroll' : 'normal') : routedOf(id)) // prettier-ignore
    expect(framesGate(sprite(0xe8, 0, 0x0c), only0c)).toBe('it has no picture')
    expect(framesGate(sprite(0xe8, 0, 0x04), only0c)).toBe('extraBits')
    expect(framesGate(sprite(0xe8, 0, 0x08), only0c)).toBe('extraBits')
  })

  it('one scroll id the second sweep breaks takes every exemption with it, and the plain table still reads', () => {
    const r = classesWith(scrollHole)
    expect([0xc0, 0xa0].map(id => r.of(id, 0x08))).toEqual(['normal', 'normal'])
    expect(r.of(0xc0)).toBe('scroll')
  })

  const READS_ID = [0xa0, 0x03, 0xb7, 0xe0, 0xaa]
  const FLAT_A0 = [0xa9, 0xa0, 0x8f, SCROLL_CELL & 0xff, SCROLL_CELL >> 8, 0x00]
  it.each([
    ['reads the id, ignores it and stores a flat $A0', [...READS_ID, ...FLAT_A0]],
    ['hits BRK after reading the id', [...READS_ID, 0x00]],
    ['reads no id and stores a flat $A0', FLAT_A0],
  ])('a bit-set path that %s exempts nothing, and the plain table still reads', (_t, bit3Path) => {
    const r = loadClasses(cart({ bit3Path }))
    if (r.status !== 'ok') throw new Error(r.reason)
    expect([0x90, 0xa0, 0xff].map(id => r.of(id, 0x08))).toEqual(['normal', 'normal', 'normal'])
    expect(r.of(0xa0)).toBe('scroll')
  })

  it('the other bands may be anything with the bit set', () => {
    expect(reasonOf(cart({ bit3: withGap }))).toBe('ok')
  })
})

describe('LoadClass caches by the bytes the runs read', () => {
  it('an edit to a byte the run read recomputes; an edit to one it never read keeps the same answer', () => {
    const rom = cart()
    const first = loadClasses(rom)
    rom.writeAt(TABLE + 0x34, [SHOOT]) // id $34 is read by its run, and extends the shooter band
    const edited = loadClasses(rom)
    expect(edited).not.toBe(first)
    if (edited.status !== 'ok') throw new Error('unavailable')
    expect(edited.of(0x34)).toBe('shooter')
    rom.writeAt(0x02f000, [0x12]) // nothing reads it
    expect(loadClasses(rom)).toBe(edited)
  })

  it('a new RomFile of the same bytes shares the answer (the working copy hands out a new one per call)', () => {
    expect(loadClasses(cart())).toBe(loadClasses(cart()))
  })

  it('a write to the call site on the same RomFile reads the new routine, not the cached table', () => {
    const rom = cart({}, put => put(0x029800, [0xa5, 0x14, RTS]))
    expect(reasonOf(rom)).toBe('ok')
    rom.writeAt(SITE + 1, [0x00, 0x98])
    expect(reasonOf(rom)).toMatch(/without reading the list entry/)
  })

  it('the mapper is checked on every call, ahead of the cache', () => {
    expect(reasonOf(cart())).toBe('ok')
    expect(reasonOf(cart({}, put => put(0x00ffd5, [0x21])))).toMatch(/not LoROM/)
  })

  it('the run stops at the first write to a cell: a BRK after the store is never reached', () => {
    expect(reasonOf(cart({ afterStore: [0x00] }))).toBe('ok')
  })

  it('the first write decides: a later write to another cell changes nothing', () => {
    const later = [0x8f, SCROLL_CELL & 0xff, SCROLL_CELL >> 8, 0x00, RTS]
    const r = loadClasses(cart({ afterStore: later }))
    if (r.status !== 'ok') throw new Error(r.reason)
    expect([0x31, 0x45, 0x95].map(id => r.of(id))).toEqual(['shooter', 'generator', 'scroll'])
  })
})

describe('the served paths apply the loader routing', () => {
  afterEach(() => vi.restoreAllMocks())
  /** The fixture ROM with a one-entry stream (id, flags byte) at its end, a stub level model and the stream's pointer. */
  const served = (id: number, flags: number) => {
    const bytes = Uint8Array.from(cart().buffer)
    bytes.set([0, flags, 0x01, id, 0xff], 0x7ffb0)
    vi.spyOn(SmwRom.prototype, 'getLevelSpritePointer').mockReturnValue(0x0fffb0)
    const inputs = { vram: {}, colors: COLORS, isVertical: false, screenCount: 1 }
    return { bytes, cache: new L1ModelCache(() => ({ ok: true, inputs }) as never) }
  }

  it('mapSprites: a scroll command with extra bits is the quiet marker, not the extra-bits box', () => {
    const { bytes, cache } = served(0xa0, 0x08)
    const r = mapSprites(cache, bytes, 'x.sfc', 0)
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    expect(r.sprites[0]).toMatchObject({ status: 'quiet', kind: 'scroll' })
  })

  it('mapSprites: an id the loader does not route keeps the extra-bits box', () => {
    const { bytes, cache } = served(0x70, 0x08)
    const r = mapSprites(cache, bytes, 'x.sfc', 0)
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    expect(r.sprites[0]).toMatchObject({ status: 'placeholder', reason: 'extraBits' })
  })

  it('mapSpriteFrames: a scroll command with extra bits has no picture, not an extra-bits gate', () => {
    const { bytes, cache } = served(0xa0, 0x08)
    expect(mapSpriteFrames(cache, bytes, 'x.sfc', 0, 0)).toMatchObject({
      status: 'ok',
      frames: [],
      reason: 'it has no picture',
    })
  })
})

describe('the runner routes by what LoadClass read, with no fallback to the game bands', () => {
  /** A real interpDrawer over the fixture ROM with a spy run that records which ids ran as sprites. */
  const drawerFor = (rom: RomFile, ran: number[]) =>
    interpDrawer(
      rom,
      0,
      geometry,
      (_r, id) => (ran.push(id), runModel({ refusal: 'spy' })),
      seedFor,
    )

  it('routes the planted shooter and scroll bands without running sprite code; the game bands run as sprites', () => {
    const ran: number[] = []
    const d = drawerFor(cart(), ran)
    expect(d(sprite(0x31))).toMatchObject({ ok: false, routed: 'shooter' })
    expect(d(sprite(0x45))).toMatchObject({ ok: false, routed: 'generator' })
    expect(d(sprite(0xa0))).toMatchObject({ ok: false, routed: 'scroll' })
    expect(ran).toEqual([])
    // 0x70 is in no planted band, so it runs as a sprite.
    d(sprite(0x70))
    expect(ran).toEqual([0x70])
  })

  it('an unreadable loader routes nothing: the game bands are not assumed', () => {
    const ran: number[] = []
    const d = drawerFor(noLoader(), ran)
    d(sprite(0xe8))
    d(sprite(0xc9))
    expect(ran).toEqual([0xe8, 0xc9])
  })
})

describe('review findings (#1273)', () => {
  it('a shooter with no sprite name still gets the timer words, not the generic line', () => {
    expect(quietText({ kind: 'shooter', name: undefined })).toBe('Shooter: fires on a timer; nothing is drawn until it does') // prettier-ignore
  })

  it('an empty run whose loader routing could not be read is unverified (so it keeps the box), unless it can be read', () => {
    const empty = () => runModel({ emptyReason: 'drew no OAM tile' })
    const unreadable = interpDrawer(noLoader(), 0, geometry, empty, seedFor)
    const r = unreadable(sprite(0x70))
    expect(r).toMatchObject({ ok: false, empty: true, unverified: expect.stringContaining('routing could not be read') }) // prettier-ignore
    expect(drawSprites([sprite(0x70)], model, () => r, undefined, undefined)[0]!.status).toBe(
      'placeholder',
    )
    // A reason already there is kept, not replaced.
    const kept = interpDrawer(noLoader(), 0, geometry, () => runModel({ emptyReason: 'x', unverifiedReason: 'seed lacks state' }), seedFor)(sprite(0x70)) // prettier-ignore
    expect(kept).toMatchObject({ unverified: expect.stringContaining('seed lacks state') })
    // Readable routing: the empty run is verified, so quiet.
    const readable = interpDrawer(cart(), 0, geometry, empty, seedFor)(sprite(0x70))
    expect(readable).toMatchObject({ ok: false, empty: true })
    expect('unverified' in readable).toBe(false)
  })
})

describe('the route check runs before the special-case drawers (#1273)', () => {
  const never = () => {
    throw new Error('sprite code must not run')
  }
  const drawer = (rom: RomFile, run = never) => interpDrawer(rom, 0, geometry, run, seedFor)

  // 0xe2/0xe3 rings, 0xde Five Eeries, 0xe0 Three Platforms: BANDS routes every id from 0x90 up as a scroll command.
  it.each([
    ['ring left', 0xe2],
    ['ring right', 0xe3],
    ['Five Eeries', 0xde],
    ['Three Platforms', 0xe0],
  ])(
    '%s: an id the loader routes as a scroll command is the routed refusal, not its drawing',
    (_n, id) => {
      expect(drawer(cart())(sprite(id))).toMatchObject({ ok: false, routed: 'scroll' })
    },
  )

  it('the torpedo launcher still previews when the loader classes its id as a shooter', () => {
    // Classes run shooters, generators, scroll commands in id order, so the launcher's $CA sits in a shooter run $C8-$CB.
    const classes = (id: number) => (id >= 0xc8 && id < 0xcc ? SHOOT : id >= 0xcc && id < 0xd0 ? GEN : id >= 0xd0 ? SCROLL : NORMAL) // prettier-ignore
    const rom = cart({ classes })
    const c = loadClasses(rom)
    if (c.status !== 'ok') throw new Error(JSON.stringify(c))
    expect(c.of(0xca)).toBe('shooter')
    const r = drawer(rom)(sprite(0xca))
    expect(r).not.toHaveProperty('routed')
  })
})

describe('special drawers and the unreadable routing (#1273 round 2)', () => {
  const never = () => {
    throw new Error('sprite code must not run')
  }
  const WHY = 'routing could not be read'
  const ring = () => ({ ok: true as const, parts: [], unverified: [] as string[] })
  const spawn = () => ({ ...ring(), eeries: [], spawned: 5, notes: [] as string[] })
  const launch = () => ({ ok: true as const, torpedo: { x: 0, y: 0 }, torpedoId: 0x44, torpedoParts: [], arm: [], unverified: [] as string[] }) // prettier-ignore
  const drawer = (rom: RomFile) => interpDrawer(rom, 0, geometry, never, seedFor)
  const cases: [string, number, () => void][] = [
    ['$E2 ring', 0xe2, () => vi.mocked(rotatingRing).mockReturnValueOnce(ring())],
    ['$E3 ring', 0xe3, () => vi.mocked(rotatingRing).mockReturnValueOnce(ring())],
    ['Five Eeries', 0xde, () => vi.mocked(fiveEeries).mockReturnValueOnce(spawn())],
    ['Three Platforms', 0xe0, () => vi.mocked(threePlatforms).mockReturnValueOnce(spawn())],
    ['torpedo launcher', 0xca, () => vi.mocked(torpedoLauncher).mockReturnValueOnce(launch())],
  ]
  it.each(cases)(
    '%s: a drawn result is marked unverified when the routing cannot be read',
    (_n, id, plant) => {
      plant()
      const r = drawer(noLoader())(sprite(id))
      expect(r).toMatchObject({ ok: true, unverified: expect.stringContaining(WHY) })
    },
  )
  it('an existing unverified text on a special drawer is kept, not overwritten', () => {
    vi.mocked(rotatingRing).mockReturnValueOnce({ ...ring(), unverified: ['x'] })
    const r = drawer(noLoader())(sprite(0xe2))
    expect(r).toMatchObject({ unverified: expect.stringContaining('x is not the vanilla shape') })
    expect(JSON.stringify(r)).not.toContain(WHY)
  })
  it('readable routing adds nothing to a special drawer', () => {
    vi.mocked(rotatingRing).mockReturnValueOnce(ring())
    expect('unverified' in drawer(cart())(sprite(0xe2))).toBe(false)
  })
  it('a refused special drawer keeps its failure box without the routing reason', () => {
    vi.mocked(fiveEeries).mockReturnValueOnce({ ok: false, reason: 'nope', unverified: [] })
    const r = drawer(noLoader())(sprite(0xde))
    expect(r).toMatchObject({ ok: false })
    expect(JSON.stringify(r)).not.toContain(WHY)
  })
  // Classes run shooters, generators, scroll commands in id order; $CA is placed in each class in turn.
  it.each([
    ['generator', 'generator', (id: number) => (id >= 0xd0 ? SCROLL : id >= 0xc8 ? GEN : NORMAL)],
    ['scroll', 'scroll', (id: number) => (id >= 0xc8 ? SCROLL : NORMAL)],
  ] as const)(
    'the torpedo launcher the loader routes as a %s is the routed refusal',
    (_n, routed, classes) => {
      const rom = cart({ classes })
      const c = loadClasses(rom)
      if (c.status !== 'ok') throw new Error(JSON.stringify(c))
      expect(c.of(0xca)).toBe(routed)
      expect(drawer(rom)(sprite(0xca))).toMatchObject({ ok: false, routed })
    },
  )
})

describe('an unreadable loader routing marks a drawn run too (#1273)', () => {
  const tile = { oam: 0, char: 0, size: 8, palette: 9, priority: 2, flipX: false, flipY: false, dx: 0, dy: 0, attr: 0, ox: 0, oy: 0 } // prettier-ignore
  const drawn = () => runModel({ anchor: { x: 1, y: 1, rawX: 1, rawY: 1 }, passes: [{ pass: 0, pos: { x: 0, y: 0 }, origin: { x: 0, y: 0 }, parts: [tile], uploads: [], palette: [] }], chosen: 0 }) // prettier-ignore
  it('a run with no emptyReason gets the unverified reason', () => {
    const r = interpDrawer(noLoader(), 0, geometry, drawn, seedFor)(sprite(0x70))
    expect(r).toMatchObject({ unverified: expect.stringContaining('routing could not be read') })
    expect(r).toMatchObject({ unverified: expect.stringContaining('may be a shooter, generator or scroll command') }) // prettier-ignore
  })
  it('an existing unverifiedReason is kept', () => {
    const run = () => ({ ...drawn(), unverifiedReason: 'seed lacks state' })
    const r = interpDrawer(noLoader(), 0, geometry, run, seedFor)(sprite(0x70))
    expect(r).toMatchObject({ unverified: expect.stringContaining('seed lacks state') })
    expect(JSON.stringify(r)).not.toContain('routing could not be read')
  })
  it('readable routing adds nothing', () => {
    const r = interpDrawer(cart(), 0, geometry, drawn, seedFor)(sprite(0x70))
    expect(JSON.stringify(r)).not.toContain('routing could not be read')
  })
})

describe('with the plain unverified note (#1166)', () => {
  const stream = Uint8Array.from([0, 0x00, 0x01, 0x10, 0x00, 0x02, 0x11, 0xff]) // two entries, ids $10 and $11
  const m = { ...model, isVertical: false, screenCount: 1 }
  const drawn = (res: Record<number, SpriteDrawResult>) => spriteLayer(stream, m, draw(res))

  it('a quiet sprite keeps its note and is not counted as unverified; a box with a reason gets the plain line and the raw text', () => {
    const quiet: SpriteDrawResult = { ok: false, reason: 'drew no OAM tile', empty: true }
    const unverified: SpriteDrawResult = { ok: false, reason: 'drew no OAM tile', empty: true, unverified: "the loader's id routing could not be read (x)" } // prettier-ignore
    const r = drawn({ 0x10: quiet, 0x11: unverified })
    const [q, u] = r.sprites
    expect([q!.status, u!.status]).toEqual(['quiet', 'placeholder'])
    expect(r.note).toBe('Unverified: 1 sprite may not be drawn exactly as in the game.') // only the box counts
    expect(spriteProps(q!).notes[0]).toMatch(/may only show up in play\.$/)
    expect(spriteProps(q!).notes).not.toContain(UNVERIFIED_NOTE)
    const p = spriteProps(u!)
    expect(p.notes).toContain(UNVERIFIED_NOTE)
    expect(noteTitle(UNVERIFIED_NOTE, p)).toBe("the loader's id routing could not be read (x)")
  })
})

describe('an unreadable loader boxes every sprite with an extra bit (#1011, thread 4505953790)', () => {
  const GOAL_TAPE = 0x7b
  const bitsOf = (id: number, flags: number, index = 0) => ({ ...sprite(id, index), raw: [flags, 0, id] }) as LevelSprite // prettier-ignore
  /** A drawer that must not run: the box comes first. */
  const never = (s: LevelSprite): SpriteDrawResult => {
    throw new Error(`sprite ${s.spriteId} must not run`)
  }
  const flagsList = [0x04, 0x08, 0x0c]

  const ids = Array.from({ length: 256 }, (_, id) => id)
  it.each(flagsList)(
    'drawSprites: every id with flags %i is boxed "loaderUnreadable", its code not run',
    flags => {
      const out = drawSprites(ids.map(id => bitsOf(id, flags, id)), model, never, undefined, 'unreadable') // prettier-ignore
      expect(out.map(d => [d.status, d.reason])).toEqual(ids.map(() => ['placeholder', 'loaderUnreadable'])) // prettier-ignore
    },
  )

  it('flags $01-$03 are not extra bits: nothing is boxed for them, in the map or the frames', () => {
    const empty: SpriteDrawResult = { ok: false, reason: 'drew no OAM tile', empty: true }
    for (const flags of [0x01, 0x02, 0x03]) {
      const out = drawSprites(ids.map(id => bitsOf(id, flags, id)), model, () => empty, undefined, 'unreadable') // prettier-ignore
      expect(
        out.filter(d => d.reason === 'loaderUnreadable'),
        `flags ${flags}`,
      ).toEqual([])
      expect(ids.filter(id => framesGate(bitsOf(id, flags), 'unreadable')), `flags ${flags}`).toEqual([]) // prettier-ignore
    }
  })

  it('drawSprites: a sprite with no extra bit is drawn as before, and no routing at all (a caller that never routes) still draws bit 2', () => {
    const empty: SpriteDrawResult = { ok: false, reason: 'drew no OAM tile', empty: true }
    const [plain] = drawSprites([bitsOf(0x10, 0)], model, () => empty, undefined, 'unreadable')
    expect(plain!.reason).not.toBe('loaderUnreadable')
    const [absent] = drawSprites([bitsOf(0x10, 0x04)], model, () => empty, undefined, undefined)
    expect(absent!.reason).not.toBe('loaderUnreadable')
    expect(absent!.reason).not.toBe('extraBits')
  })

  it('drawSprites: a readable loader that leaves bit 2 alone still draws it (the goal tape included)', () => {
    const empty: SpriteDrawResult = { ok: false, reason: 'drew no OAM tile', empty: true }
    const r = loadClasses(cart())
    if (r.status !== 'ok') throw new Error(r.reason)
    for (const id of [0x10, GOAL_TAPE]) {
      const [d] = drawSprites([bitsOf(id, 0x04)], model, () => empty, undefined, r.of)
      expect(d!.reason, `id ${id}`).not.toMatch(/extraBits|loaderUnreadable/)
    }
  })

  it('framesGate: the same boxes for every id and extra-bit combination, with the same reason; a plain sprite has none', () => {
    for (const flags of flagsList)
      expect(ids.filter(id => framesGate(bitsOf(id, flags), 'unreadable') !== 'loaderUnreadable'), `flags ${flags}`).toEqual([]) // prettier-ignore
    expect(ids.filter(id => framesGate(bitsOf(id, 0), 'unreadable'))).toEqual([])
  })

  it('the words say the loader could not be read, in plain language, on the hover and in the animation text', () => {
    const say = "The app could not read how this ROM's sprite loader treats the extra-bits marker, so it cannot tell whether vanilla art is right." // prettier-ignore
    expect(framesReasonText('loaderUnreadable')).toBe(say)
    expect(placeholderText({ id: 0x7b, name: undefined, status: 'placeholder', reason: 'loaderUnreadable' })).toBe(`Sprite $7B: ${say}`) // prettier-ignore
  })

  describe('through the served paths, on a cart whose loader cannot be read', () => {
    afterEach(() => vi.restoreAllMocks())
    const servedOn = (rom: RomFile, id: number, flags: number) => {
      const bytes = Uint8Array.from(rom.buffer)
      bytes.set([0, flags, 0x01, id, 0xff], 0x7ffb0)
      vi.spyOn(SmwRom.prototype, 'getLevelSpritePointer').mockReturnValue(0x0fffb0)
      const inputs = { vram: {}, colors: COLORS, isVertical: false, screenCount: 1 }
      return { bytes, cache: new L1ModelCache(() => ({ ok: true, inputs }) as never) }
    }

    it.each([
      ['a call site that no longer calls the loader', noLoader],
      ['a table with no routed id', () => cart({ classes: () => NORMAL })],
    ])(
      'mapSprites and mapSpriteFrames: extra bits are boxed with the unreadable reason (%s)',
      (_t, make) => {
        expect(loadClasses(make()).status).toBe('unavailable')
        for (const id of [0x70, GOAL_TAPE])
          for (const flags of flagsList) {
            const { bytes, cache } = servedOn(make(), id, flags)
            const r = mapSprites(cache, bytes, 'x.sfc', 0)
            if (r.status !== 'ok') throw new Error(JSON.stringify(r))
            const at = `id ${id} flags ${flags}`
            expect(r.sprites[0], at).toMatchObject({ status: 'placeholder', reason: 'loaderUnreadable' }) // prettier-ignore
            expect(mapSpriteFrames(cache, bytes, 'x.sfc', 0, 0), at).toMatchObject({ status: 'ok', frames: [], reason: 'loaderUnreadable' }) // prettier-ignore
          }
      },
    )

    it('the goal tape boxed for an unreadable loader hovers by its id, not by its vanilla name', () => {
      const { bytes, cache } = servedOn(noLoader(), GOAL_TAPE, 0x04)
      const r = mapSprites(cache, bytes, 'x.sfc', 0)
      if (r.status !== 'ok') throw new Error(JSON.stringify(r))
      expect(r.sprites[0]!.name).toBeUndefined()
      expect(placeholderText(r.sprites[0]!)).toMatch(
        /^Sprite \$7B: The app could not read how this ROM/,
      )
      // control: the same sprite with no extra bit keeps its name
      const plain = servedOn(noLoader(), GOAL_TAPE, 0)
      const p = mapSprites(plain.cache, plain.bytes, 'x.sfc', 0)
      if (p.status !== 'ok') throw new Error(JSON.stringify(p))
      expect(p.sprites[0]!.name).toBe('Goal Tape')
    })

    it('a readable loader serves the same bit-2 sprite without that reason', () => {
      const { bytes, cache } = servedOn(cart(), 0x70, 0x04)
      const r = mapSprites(cache, bytes, 'x.sfc', 0)
      if (r.status !== 'ok') throw new Error(JSON.stringify(r))
      expect(r.sprites[0]!.reason).not.toMatch(/extraBits|loaderUnreadable/)
    })
  })
})

describe('the frames fallback routes as the map does (#1011, thread 4505953787)', () => {
  const sp1 = [0, 1].map(() => new Uint8Array(64).fill(3))
  const m = { vram: { sp1 }, colors: COLORS }
  const part = { charNum: 0x401, palette: 9, flipX: false, flipY: false, dx: 0, dy: 0 }
  const identity = { spriteId: 0x9c, mainHandler: 0, initHandler: 0, status: 'vanilla' } as const
  /** $10 is the parent here (an id the cart moves); it draws and claims the sprite at index 1. */
  const parentDraw = (s: LevelSprite): SpriteDrawResult =>
    s.spriteId === 0x10
      ? ({ ok: true, parts: [part], identity, children: [{ index: 1, parts: [{ ...part, dy: -16 }] }] } as unknown as SpriteDrawResult) // prettier-ignore
      : { ok: false, reason: 'drew no OAM tile', empty: true }
  const moved = (id: number) => (id >= 0x10 && id < 0x20 ? SCROLL : NORMAL)
  const stream = [{ ...sprite(0x10, 0), raw: [0x04, 0, 0x10] } as LevelSprite, sprite(0x9b, 1)]

  it('control: with no routing the bit-2 parent runs and claims its child', () => {
    const [, child] = drawSprites(stream, m, parentDraw)
    expect(child).toMatchObject({ status: 'drawn', drawnBy: 0 })
  })

  it('a bit-2 parent the loader re-routes is boxed, so it claims no child and the frames do not say it rides with it', () => {
    const rom = cart({ bit2: moved })
    expect(drawnByParent(rom, stream, m, parentDraw, 0)).toMatchObject({ status: 'placeholder', reason: 'extraBits' }) // prettier-ignore
    const child = drawnByParent(rom, stream, m, parentDraw, 1)
    expect(child!.drawnBy).toBeUndefined()
    expect(framesAnswer({ frames: [], reason: 'drew no tile' }, child)).toEqual({ status: 'ok', frames: [], reason: 'drew no tile' }) // prettier-ignore
  })

  it('a parent whose bit 2 the loader leaves alone still claims its child; an unreadable loader boxes the parent', () => {
    expect(drawnByParent(cart(), stream, m, parentDraw, 1)).toMatchObject({ status: 'drawn', drawnBy: 0 }) // prettier-ignore
    expect(drawnByParent(noLoader(), stream, m, parentDraw, 0)).toMatchObject({ reason: 'loaderUnreadable' }) // prettier-ignore
    expect(drawnByParent(noLoader(), stream, m, parentDraw, 1)!.drawnBy).toBeUndefined()
  })

  it('a child boxed for an unreadable loader stays boxed: its parent does not claim it', () => {
    const kid = { ...sprite(0x9b, 1), raw: [0x04, 0, 0x9b] } as LevelSprite
    const list = [sprite(0x10, 0), kid]
    expect(drawSprites(list, m, parentDraw)[1]).toMatchObject({ drawnBy: 0 }) // control: unrouted, the claim lands
    expect(drawSprites(list, m, parentDraw, undefined, 'unreadable')[1]).toMatchObject({ status: 'placeholder', reason: 'loaderUnreadable' }) // prettier-ignore
  })
})
