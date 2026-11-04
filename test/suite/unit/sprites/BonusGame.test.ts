/**
 * #998: the bonus game blocks ($82) on maps $000 and $100. The placed sprite is only the trigger: its INIT
 * (InitBonusGame, SMWDisX bank_01.asm:12675-12721) writes nine blocks into slots 9..1 at fixed spots of the level and
 * ignores the placed position. The level loader's image has already run that INIT once, so it holds the latch
 * DisableBonusSprite ($1B94) at 1, and a second INIT erases the sprite (12676-12679): the map showed a placeholder.
 * The per-sprite seed puts the latch back (InitLatches.ts) and the picture stays where the INIT put it (D158 /
 * Decision 124 A). The synthetic blocks need no ROM; the corpus block's reference is HackBench's ROM-run level
 * loader (the game's code on our emulated CPU; no hardware capture exists for $000 or $100).
 * Evidence scope: vanilla ROM, maps $000 and $100, one machine, emulated CPU only.
 */
import { describe, expect, it } from 'vitest'
import { fingerprint } from '../../../../src/rom/Fingerprint'
import { RomFile } from '../../../../src/rom/RomFile'
import { bytesAt } from '../../../../src/rom/sprites/interp/Guards'
import {
  type InitLatch,
  INIT_LATCHES,
  latchFor,
  placedSlot,
  withoutInitLatches,
} from '../../../../src/rom/sprites/interp/InitLatches'
import { levelSeed } from '../../../../src/rom/sprites/interp/LevelLoader'
import { runOnce } from '../../../../src/rom/sprites/interp/SpriteRunner'
import {
  SPRITE_SEED,
  withSeed,
  type SpriteSeed,
} from '../../../../src/rom/sprites/interp/SpriteSeed'
import { L1ModelCache } from '../../../../theia/extension/src/node/map-screen'
import { mapSprites } from '../../../../theia/extension/src/node/map-sprites'
import { freshRom, hasRom, romPath, VANILLA } from '../../support/corpus'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const LATCH = 0x1b94
const WRAM = 0x20000
const hash = (b: number[] | null) => fingerprint(Uint8Array.from(b!))

/** A headerless LoROM of zeros with `bytes` written at the SNES address. */
function cart(writes: [number, number[]][]): RomFile {
  const buf = Buffer.alloc(0x80000)
  for (const [snes, bytes] of writes) buf.set(bytes, (snes >>> 16) * 0x8000 + (snes & 0x7fff))
  return RomFile.fromBytes('synthetic.sfc', buf)
}

/** A row over a hand-written INIT at $01:9000: eight bytes of "guard" and two of "set", fingerprinted from the cart itself. */
const INIT_AT = 0x019000
const PTR = INIT_AT & 0xffff
const GUARD = [1, 2, 3, 4, 5, 6, 7, 8]
const SET = [9, 10]
function rowFor(rom: RomFile, absolute = true): InitLatch {
  return {
    initPointer: PTR,
    cell: LATCH,
    before: 0,
    code: [
      { at: 0, length: 8, sha256: hash(bytesAt(rom, INIT_AT, 8)) },
      { at: 0x20, length: 2, sha256: hash(bytesAt(rom, INIT_AT + 0x20, 2)) },
    ],
    absolute,
    why: 'synthetic',
  }
}
const initCart = (edit: (g: number[], s: number[]) => void = () => {}) => {
  const [g, s] = [[...GUARD], [...SET]]
  edit(g, s)
  return cart([[INIT_AT, g], [INIT_AT + 0x20, s]]) // prettier-ignore
}

describe('withoutInitLatches and latchFor (no ROM)', () => {
  const seed = (): SpriteSeed => {
    const w = new Uint8Array(WRAM)
    w[LATCH] = 1
    return { ...withSeed({}), loaded: w }
  }
  const rom = initCart()
  const row = rowFor(rom)
  it('gives the sprite a copy with the latch back at 0 and leaves the shared image at 1', () => {
    const s = seed()
    const r = withoutInitLatches(s, row)
    expect(r.loaded![LATCH]).toBe(0)
    expect(s.loaded![LATCH]).toBe(1)
    expect(r.loaded).not.toBe(s.loaded)
  })
  it('returns the same seed with no row, no loaded image or a latch already at its before value', () => {
    const s = seed()
    expect(withoutInitLatches(s, undefined)).toBe(s)
    const bare = withSeed({})
    expect(withoutInitLatches(bare, row)).toBe(bare)
    s.loaded![LATCH] = 0
    expect(withoutInitLatches(s, row)).toBe(s)
  })
  it('finds the row only when the pointer and the fingerprinted INIT bytes are the ones it was read from (D51)', () => {
    const rows = { 0x82: row }
    expect(latchFor(rom, 0x82, PTR, rows)).toBe(row)
    expect(latchFor(rom, 0x82, 0x9001, rows)).toBeUndefined()
    expect(latchFor(rom, 0x81, PTR, rows)).toBeUndefined()
    expect(
      latchFor(
        initCart(g => (g[3] = 0)),
        0x82,
        PTR,
        rows,
      ),
    ).toBeUndefined()
    expect(
      latchFor(
        initCart((_g, s) => (s[1] = 0)),
        0x82,
        PTR,
        rows,
      ),
    ).toBeUndefined()
  })
  it('ships exactly one row, for $82, flagged absolute', () => {
    expect(Object.keys(INIT_LATCHES)).toEqual([String(0x82)])
    expect(INIT_LATCHES[0x82]!.absolute).toBe(true)
  })
})

describe('placedSlot (no ROM)', () => {
  const LOAD = 0x02a8dd
  const head = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  const spec = { at: LOAD, length: 11, sha256: hash(head) }
  const loader = (table: number, slots: number[]) =>
    cart([[LOAD, [...head, table & 0xff, table >> 8]], [0x020000 | table, slots]]) // prettier-ignore
  const img = (setting: number) => {
    const w = new Uint8Array(WRAM)
    w[0x1692] = setting
    return w
  }
  it('follows the loader operand to the table and indexes it by $1692', () => {
    const rom = loader(0xb123, [9, 7])
    expect(placedSlot(rom, img(0), spec)).toBe(9)
    expect(placedSlot(rom, img(1), spec)).toBe(7)
  })
  it('is slot 0 when the image shows $82 live there (the downward search landed low)', () => {
    const w = img(0)
    w[0x14c8] = 8
    w[0x9e] = 0x82
    expect(placedSlot(loader(0xb123, [9]), w, spec)).toBe(0)
  })
  it('is null when the loader is not the fingerprinted one, the entry is out of range or no image is given', () => {
    expect(placedSlot(loader(0xb123, [9]), img(0), { ...spec, sha256: 'x' })).toBeNull()
    expect(placedSlot(loader(0xb123, [12]), img(0), spec)).toBeNull()
    expect(placedSlot(loader(0xb123, [9]), undefined, spec)).toBeNull()
  })
})

describe('the at-rest re-base exemption (synthetic cart, no ROM)', () => {
  // Id 0's INIT adds 8 to X on the synthetic cart, so its post-INIT spot is 8 px right of the placed one.
  const rom = buildSyntheticRom()
  const ptr = 0x8610
  const initRow = (absolute: boolean): InitLatch => ({
    initPointer: ptr,
    cell: LATCH,
    before: 0,
    code: [{ at: 0, length: 7, sha256: hash(bytesAt(rom, 0x010000 | ptr, 7)) }],
    absolute,
    why: 'synthetic',
  })
  const run = (id: number, latches: Record<number, InitLatch>, cartRom = rom) =>
    runOnce(cartRom, id, SPRITE_SEED, { atRest: true, latches })
  it('the latched row is drawn where INIT put it, not re-based onto the placed spot', () => {
    const m = run(0, { 0: initRow(true) })
    expect(m.absolutePlacement).toBe(true)
    expect(m.anchor).toMatchObject({ x: 0x88, rawX: 0x80 })
  })
  it('the run starts from a copy of the loader image with the latch back, and says so', () => {
    const loaded = new Uint8Array(WRAM)
    loaded[LATCH] = 1
    const m = runOnce(
      rom,
      0,
      { ...SPRITE_SEED, loaded },
      { atRest: true, latches: { 0: initRow(false) } },
    )
    expect(m.initLatched).toBe(true)
    expect(loaded[LATCH]).toBe(1)
    expect(
      runOnce(rom, 0, { ...SPRITE_SEED, loaded }, { atRest: true, latches: {} }).initLatched,
    ).toBeUndefined()
  })
  it('a sprite with no row still re-bases, and so does a row that is not absolute', () => {
    expect(run(1, { 0: initRow(true) }).anchor).toMatchObject({ x: 0x80, rawX: 0x80 })
    expect(run(0, { 0: initRow(false) }).anchor).toMatchObject({ x: 0x80, rawX: 0x80 })
    expect(run(0, {}).anchor).toMatchObject({ x: 0x80 })
  })
  it('an absolute row on a loader the slot search cannot read is refused, not drawn at a guessed slot', () => {
    const loaded = new Uint8Array(WRAM)
    expect(runOnce(rom, 0, { ...SPRITE_SEED, loaded }, { atRest: true, latches: { 0: initRow(true) } }).refusal).toMatch(/slot/) // prettier-ignore
  })
  it('an INIT that is not the fingerprinted one re-bases as before (D51)', () => {
    const other = buildSyntheticRom({ initShift: 4 })
    expect(run(0, { 0: initRow(true) }, other).anchor).toMatchObject({ x: 0x80 })
  })
})

describe.skipIf(!hasRom(VANILLA))('bonus game blocks, vanilla ROM', () => {
  const MAPS: [string, number][] = [['$000', 0x000], ['$100', 0x100]] // prettier-ignore
  const served = (map: number) => {
    const bytes = new Uint8Array(freshRom().buffer)
    const r = mapSprites(new L1ModelCache(), bytes, romPath(VANILLA), map)
    if (r.status !== 'ok') throw new Error(r.status)
    return r.sprites.filter(s => s.id === 0x82)
  }
  it.each(MAPS)(
    'map %s: the vanilla INIT matches its row and the loader image holds the latch at 1',
    (_n, map) => {
      const rom = freshRom()
      const w = levelSeed(rom, map).loaded!
      expect(w[LATCH]).toBe(1)
      expect(latchFor(rom, 0x82, INIT_LATCHES[0x82]!.initPointer)).toBe(INIT_LATCHES[0x82])
      expect(placedSlot(rom, w)).toBe(9)
    },
  )
  it.each(MAPS)(
    'map %s: drawn as 72 cells at the fixed spots of the level, nothing at the list spot',
    (_n, map) => {
      const all = served(map)
      expect(all).toHaveLength(1)
      const s = all[0]!
      expect(s.status).toBe('drawn')
      expect(s.parts).toHaveLength(72)
      expect(s.box.x0).toBeGreaterThanOrEqual(78)
      expect(s.box.x1).toBeLessThanOrEqual(178)
      expect(s.box.y0).toBeGreaterThanOrEqual(238)
      expect(s.box.y1).toBeLessThanOrEqual(338)
      // The DTO keeps the list spot for hover and drag; the picture stands elsewhere (D158).
      expect([s.x, s.y]).toEqual([80, 112])
    },
  )
  it.each(MAPS)('map %s: the run is the latched one, takes the top slot and draws', (_n, map) => {
    const rom = freshRom()
    const seed = withSeed({ sprite: { x: 80, y: 112 } }, levelSeed(rom, map))
    const m = runOnce(rom, 0x82, seed, { atRest: true })
    expect(m.initLatched).toBe(true)
    expect(m.refusal).toBeUndefined()
    expect(m.absolutePlacement).toBe(true)
    expect(m.passes[m.chosen!]!.parts.length).toBeGreaterThan(0)
  })
  it('without the latch row the sprite is erased, as before the fix', () => {
    const rom = freshRom()
    const seed = withSeed({ sprite: { x: 80, y: 112 } }, levelSeed(rom, 0))
    expect(runOnce(rom, 0x82, seed, { atRest: true, latches: {} }).emptyReason).toMatch(
      /INIT erased/,
    )
  })
})
