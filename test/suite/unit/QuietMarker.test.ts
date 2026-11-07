/**
 * The quiet marker (#1011): a verdict, never an id list. All synthetic, so CI (no ROM) runs it; the vanilla
 * corpus cases are in QuietMarker.corpus.test.ts.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { composeScreen, DOOR_PART_BIT, DOOR_PART_ID } from '../../../src/rom/model/ColorMath'
import { FALLBACK_SCREENS } from '../../../src/rom/model/ScreenPlanes'
import { loadClasses, type LoadClass } from '../../../src/rom/sprites/interp/LoadClass'
import { withSeed } from '../../../src/rom/sprites/interp/SpriteSeed'
import type { SpriteModel } from '../../../src/rom/sprites/interp/SpriteRunner'
import {
  drawSprites,
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
const ROUTINE = 0x029000
const TABLE = 0x029100
const TABLE_BIT3 = 0x029200
const SCROLL_CELL = 0x143e
const GEN_CELL = 0x18b9
const SHOOT_SLOTS = 0x1783
const [NORMAL, SHOOT, GEN, SCROLL, SCROLL_OFFSET] = [0, 1, 2, 3, 4] // the last stores to the scroll cell, but a different value
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
function assemble(items: Item[]): number[] {
  const at = new Map<string, number>()
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
    ...value(plan.store?.[code] ?? (code === SCROLL_OFFSET ? 'offset' : 'id')),
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
      ...(plan.normal ?? NORMAL_PATH),
      { label: 'shoot' },
      ...tail(SHOOT, plan.shootCell ?? SHOOT_SLOTS + 2),
      { label: 'gen' },
      ...tail(GEN, GEN_CELL),
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
    0xa5,
    0x14,
    0xf0,
    0x45,
  ])
  put(ABOVE, [RTS])
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
    expect([0x50, 0x95, 0xa0].map(id => r.of(id, true))).toEqual(['normal', 'scroll', 'scroll'])
    expect([0x50, 0x95, 0xa0].map(id => r.of(id))).toEqual(['normal', 'scroll', 'scroll'])
  })

  it.each([
    ['a band the second sweep moved onto plain normal ids', moved, 0x15],
    ['a band the second sweep put on plain shooters', onShooters, 0x31],
  ])('%s gets no exemption: its sprite code does not run and the box stays', (_t, bit3, id) => {
    const r = classesWith(bit3)
    expect(r.of(id, true)).toBe('normal')
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
    expect([0x95, 0xa0].map(id => r.of(id, true))).toEqual(['normal', 'normal'])
    expect(r.of(0xa0)).toBe('scroll')
  })

  it('one scroll id the second sweep breaks takes every exemption with it, and the plain table still reads', () => {
    const r = classesWith(scrollHole)
    expect([0xc0, 0xa0].map(id => r.of(id, true))).toEqual(['normal', 'normal'])
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
    expect([0x90, 0xa0, 0xff].map(id => r.of(id, true))).toEqual(['normal', 'normal', 'normal'])
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
