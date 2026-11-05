/**
 * D156 through the runner, on a synthetic cart (no ROM): where the line pick lands, when a sprite never appears, and what a
 * loader that cannot be read does. The cart's loader tables are bytes built here and named by a digest of their own
 * (`RunOptions.loader`), so the stock loader digest is exercised only by the corpus tests. Id 103 is the line-guided grinder.
 */
import { describe, expect, it } from 'vitest'
import { fingerprint } from '../../../../src/rom/Fingerprint'
import type { RomFile } from '../../../../src/rom/RomFile'
import { appears, loaderWindow } from '../../../../src/rom/sprites/interp/LineAppearance'
import { runOnce, type SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'
import {
  SPRITE_SEED,
  withSeed,
  type SpriteSeed,
} from '../../../../src/rom/sprites/interp/SpriteSeed'
import { shiftNote, spriteProps } from '../../../../theia/extension/src/browser/sprite-props'
import { interpRunner, modelResult } from '../../../../theia/extension/src/node/map-sprites'
import { grinderShape } from '../../support/syntheticGrinder'
import { buildSyntheticRom, type SyntheticOptions } from '../../support/syntheticSpriteRom'

const TABLES = 0x02a7f6
/** DATA_02A7F6 / DATA_02A7F9 as the loader holds them: three low bytes then three high bytes (index 0 left, 2 right). */
const tables = (left: number, right: number) => [
  left & 255,
  0,
  right & 255,
  (left >> 8) & 255,
  0,
  (right >> 8) & 255,
]

interface Cart {
  left?: number
  right?: number
  rom?: SyntheticOptions
  seed?: Partial<SpriteSeed>
  x?: number
  y?: number
  vertical?: boolean
  stockInits?: []
  tamper?: boolean
}
/** One at-rest run of id 103 with the cart's loader digest injected; `left`/`right` default to the stock +$120 and -$30. */
function run(c: Cart = {}): { m: SpriteModel; rom: RomFile } {
  const rom = buildSyntheticRom({ grinderWideX: true, ...c.rom })
  rom.writeAt(TABLES, tables(c.left ?? -0x30, c.right ?? 0x120))
  const loader = { at: TABLES, len: 6, sha: fingerprint(rom.readAt(TABLES, 6))! }
  if (c.tamper) rom.writeAt(TABLES + 2, [rom.readAt(TABLES + 2, 1)![0]! ^ 1])
  const seed = withSeed({ slot: 3, sprite: { x: c.x ?? 0x1090, y: c.y ?? 0x1090 }, level: { screenMode: c.vertical ? 1 : 0 }, ...c.seed }, SPRITE_SEED) // prettier-ignore
  const opts = { atRest: true, grinderDispatch: grinderShape(rom), loader, ...(c.stockInits ? { stockInits: c.stockInits } : {}) } // prettier-ignore
  return { m: runOnce(rom, 103, { ...seed, ...c.seed }, opts), rom }
}
const away = { grinderInitDelta: [-0x140, 0] as const }

describe('the loader window is read from the cart, signed, left before right', () => {
  it('-$30 to the left and +$120 to the right', () => {
    const { rom } = run()
    expect(loaderWindow(rom, { at: TABLES, len: 6, sha: fingerprint(rom.readAt(TABLES, 6))! })).toEqual({ left: -0x30, right: 0x120 }) // prettier-ignore
  })
  it('a cart whose bytes differ from the digest has no window', () => {
    const { rom } = run({ tamper: true })
    expect(loaderWindow(rom, { at: TABLES, len: 6, sha: '0'.repeat(64) })).toBeNull()
  })
})

describe('the picture is the pass after the line pass (D156)', () => {
  it.each([
    [1, 4, 'step'],
    [2, 8, 'step'],
    [3, 12, 'fell'],
  ] as const)('locking on call %i: drawn %i px on from where INIT left it', (n, dx, how) => {
    const { m } = run({ rom: { grinderInitShifts: true, grinderLocksOnPass: n } })
    expect(m.snaps).toBe(true)
    expect([m.chosen, m.anchor!.x - 0x1090 - 8, m.onLine]).toEqual([n, dx, how])
    expect(m.noLineReason).toBeUndefined()
  })
  it('a sprite that never locks is drawn where it first drew and is unverified, with no line wording', () => {
    const { m } = run({ rom: { grinderInitShifts: true } })
    expect(m.chosen).toBe(0)
    expect(m.onLine).toBeUndefined()
    expect(m.noLineReason).toMatch(/never reached its line/)
    expect(modelResult(m)).toMatchObject({
      ok: true,
      unverified: expect.stringMatching(/never reached its line/),
    })
    expect(modelResult(m)).not.toHaveProperty('onLine')
  })
  it('the shift note says "on its line" only for a sprite that got there, and a fall is not a first step', () => {
    const base = {
      x: 0x1098,
      y: 0x80,
      stored: { x: 0x1090, y: 0x80 },
      afterInit: { x: 0x1098, y: 0x80 },
    }
    expect(shiftNote({ ...base, x: 0x1099, y: 0x90, onLine: 'fell' })).toMatch(/falls .* onto its line.*where it first sits on its line/) // prettier-ignore
    expect(shiftNote({ ...base, x: 0x109c, onLine: 'step' })).toMatch(
      /first step 4 px to the right.*on its line/,
    )
    expect(shiftNote({ ...base, x: 0x109c })).not.toMatch(/on its line/)
  })
})

describe('never appears: every spawn the loader allows starts it behind the scroll', () => {
  // INIT moves it -$140. Right spawn: it lands wholly left of the screen. Left offset $240 lands it wholly right of the screen.
  it('stays on its stored tile, with the plain words, and is the first drawn pass', () => {
    const { m } = run({ rom: { ...away, grinderLocksOnPass: 3 }, left: 0x240 })
    expect(m.neverAppears).toBe(true)
    expect([m.anchor!.x, m.shifted, m.chosen]).toEqual([0x1090, undefined, 0])
    const res = modelResult(m)
    expect(res).toMatchObject({ ok: true, note: 'never appears in play' })
    expect(res).not.toHaveProperty('stored')
    expect(spriteProps({ ...res, status: 'drawn', id: 103, name: 'Grinder', x: 0x1090, y: 0x1090 } as never).notes).toContain('never appears in play') // prettier-ignore
  })
  it('a left spawn that puts it on the screen makes it appear (kills dropping the left spawn)', () => {
    expect(run({ rom: away, left: 0x1c0 }).m.neverAppears).toBeUndefined()
  })
  it('a right spawn that puts it on the screen makes it appear (kills dropping the right spawn)', () => {
    expect(run({ rom: away, left: 0x240, right: 0x1c0 }).m.neverAppears).toBeUndefined()
  })
  it('swapped offsets are not the same answer: the left offset is the left spawn', () => {
    // left $1c0 / right $120 appears (above); the same two numbers the other way round, left $120 / right $1c0, appears too
    // through the right spawn; with both at $240-style distances it never does.
    expect(run({ rom: away, left: 0x120, right: 0x1c0 }).m.neverAppears).toBeUndefined()
    expect(run({ rom: away, left: 0x240, right: 0x120 }).m.neverAppears).toBe(true)
  })
  it('a sprite INIT does not move spawns where the loader puts it and is not judged', () => {
    const { m } = run({ rom: { grinderLocksOnPass: 2 }, left: 0x240 })
    expect(m.neverAppears).toBeUndefined()
  })
  it('a patched INIT still shows its reason on a sprite that never appears', () => {
    const { m } = run({ rom: { ...away }, left: 0x240, stockInits: [] })
    expect(m.neverAppears).toBe(true)
    expect(m.lineInitReason).toMatch(/not a stock line-guided INIT/)
    expect(modelResult(m)).toMatchObject({ note: 'never appears in play', unverified: expect.stringMatching(/not a stock line-guided INIT/) }) // prettier-ignore
  })
  it('the map-load window counts: on the screen at the loader camera, it appears', () => {
    const cam = (x: number) => ({ camera: { x, y: 0 }, loaded: Object.assign(new Uint8Array(0x20000), { 0x1a: x & 255, 0x1b: x >> 8 }), opening: true }) // prettier-ignore
    // INIT leaves it at $1090 - $140 = $f50: a map-load camera at $f10 shows it, one at $1100 does not.
    expect(run({ rom: away, left: 0x240, seed: cam(0xf10) }).m.neverAppears).toBeUndefined()
    expect(run({ rom: away, left: 0x240, seed: cam(0x1100) }).m.neverAppears).toBe(true)
  })
})

describe('only spawns the camera can reach count', () => {
  // A right spawn needs camera = x - $120 >= 0 and <= the last camera ($1300 on the cart's 20 screens, 256 px each).
  // INIT moves it +$180: a right spawn shows it ahead of the scroll, a left spawn (offset -$30) leaves it wholly right of the screen.
  const edge = (x: number) =>
    run({ rom: { grinderInitDelta: [0x180, 0] }, x, y: 0x90 }).m.neverAppears
  it.each([0x100, 0x110, 0x11f])(
    'x = $%s: no right spawn, so only the left one (which does not show it) judges',
    x => {
      expect(edge(x)).toBe(true)
    },
  )
  it.each([0x120, 0x130])('x = $%s: a reachable right spawn shows it ahead of the scroll', x => {
    expect(edge(x)).toBeUndefined()
  })
  it.each([0x1300 + 0x120, 0x1300 + 0x120 - 0x10])(
    'x = $%s: the last camera is itself reachable',
    x => {
      expect(
        run({ rom: { grinderInitDelta: [0x180, 0] }, x, y: 0x90, left: 0x240 }).m.neverAppears,
      ).toBeUndefined()
    },
  )
  it.each([0x1300 + 0x130, 0x1300 + 0x140])(
    'x = $%s: past the last camera there is no right spawn',
    x => {
      // A left offset of $240 keeps a reachable left spawn (camera x - $240) that leaves it wholly right of the screen.
      expect(
        run({ rom: { grinderInitDelta: [0x180, 0] }, x, y: 0x90, left: 0x240 }).m.neverAppears,
      ).toBe(true)
    },
  )
  it('a vertical map judges along Y, with a 224 px screen', () => {
    // INIT drops it -$140 in Y. The up-spawn offset is chosen from the run's own part geometry so the part starts at y = 240:
    // beyond a 224 px screen (never), inside a 256 px one.
    const probe = run({ rom: { grinderInitDelta: [0, -0x140] }, vertical: true, left: 0x240 }).m
    const dy = probe.passes[0]!.parts[0]!.dy
    const left = 240 + 0x140 - dy
    expect(
      run({ rom: { grinderInitDelta: [0, -0x140] }, vertical: true, left }).m.neverAppears,
    ).toBe(true)
    expect(run({ rom: { grinderInitDelta: [0, -0x140] }, vertical: true, left: left - 40 }).m.neverAppears).toBeUndefined() // prettier-ignore
  })
})

describe('a loader that cannot be read fails closed', () => {
  it('draws the sprite on its line, as for a stock loader, but says it could not check', () => {
    const open = run({ rom: { grinderInitShifts: true, grinderLocksOnPass: 2 } }).m
    const shut = run({ rom: { grinderInitShifts: true, grinderLocksOnPass: 2 }, tamper: true }).m
    expect(shut.spawnUnchecked).toBe(true)
    expect(open.spawnUnchecked).toBeUndefined()
    expect([shut.anchor!.x, shut.shifted, shut.neverAppears]).toEqual([
      open.anchor!.x,
      true,
      undefined,
    ])
    expect(modelResult(shut)).toMatchObject({ ok: true, unverified: expect.stringMatching(/could not check whether this sprite appears in play/) }) // prettier-ignore
  })
  it('a sprite INIT does not move has nothing to check', () => {
    expect(run({ rom: { grinderLocksOnPass: 2 }, tamper: true }).m.spawnUnchecked).toBeUndefined()
  })
})

describe('the map-load window reaches the runner by what the ROM-run loader loaded', () => {
  it('a sprite whose SpriteLoadStatus byte is set at map load is run as an opening sprite, one that is not is not', () => {
    const w = Object.assign(new Uint8Array(0x20000), { [0x1938 + 3]: 1 })
    const seen: (boolean | undefined)[] = []
    const stub = ((_r: RomFile, _id: number, sd: SpriteSeed) => (
      seen.push(sd.opening),
      { chosen: undefined }
    )) as never
    const sprite = (index: number) => ({ screen: 0, x: 5, y: 5, spriteId: 103, extraBit: false, raw: [], index, streamOffset: 0 }) // prettier-ignore
    const draw = interpRunner(buildSyntheticRom(), 0, { isVertical: false, screenCount: 20 }, stub, () => ({ ...SPRITE_SEED, loaded: w })) // prettier-ignore
    draw(sprite(3))
    draw(sprite(4))
    expect(seen).toEqual([true, false])
  })
})

describe('appears: boundaries', () => {
  it('scrolling right, hi = 0 is behind and hi = 1 is not', () => {
    expect([appears({ dir: 1, extent: { lo: -16, hi: 0 } }, 256), appears({ dir: 1, extent: { lo: -15, hi: 1 } }, 256)]).toEqual([false, true]) // prettier-ignore
  })
  it('scrolling left, lo = screen is behind and lo = screen - 1 is not, for each screen size', () => {
    for (const s of [224, 256]) {
      expect([appears({ dir: -1, extent: { lo: s, hi: s + 16 } }, s), appears({ dir: -1, extent: { lo: s - 1, hi: s + 15 } }, s)]).toEqual([false, true]) // prettier-ignore
    }
    expect(appears({ dir: -1, extent: { lo: 240, hi: 256 } }, 256)).toBe(true)
    expect(appears({ dir: -1, extent: { lo: 240, hi: 256 } }, 224)).toBe(false)
  })
  it('at map load it needs both edges inside', () => {
    expect(appears({ dir: 0, extent: { lo: 255, hi: 271 } }, 256)).toBe(true)
    expect(appears({ dir: 0, extent: { lo: 256, hi: 272 } }, 256)).toBe(false)
    expect(appears({ dir: 0, extent: { lo: -16, hi: 0 } }, 256)).toBe(false)
    expect(appears({ dir: 0, extent: { lo: -15, hi: 1 } }, 256)).toBe(true)
  })
})
