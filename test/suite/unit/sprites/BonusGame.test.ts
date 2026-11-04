/**
 * #998: the bonus game blocks ($82) on maps $000 and $100. The placed sprite is only the trigger: its INIT
 * (InitBonusGame, SMWDisX bank_01.asm:12675-12721) writes nine blocks into slots 9..1 at fixed spots of the map and
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
import { loromToOffset } from '../../../../src/rom/addressing'
import { parseLevelSprites } from '../../../../src/rom/LevelParser'
import { SmwRom } from '../../../../src/rom/SmwRom'
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
import {
  drawSprites,
  interpParts,
  mapSprites,
  modelResult,
} from '../../../../theia/extension/src/node/map-sprites'
import { COLORS } from '../../support/mapInputs'
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

/** A row over a hand-written INIT at $01:9000, fingerprinted whole from the cart itself (the vanilla row hashes the whole INIT). */
const INIT_AT = 0x019000
const PTR = INIT_AT & 0xffff
const BODY = Array.from({ length: 0x30 }, (_, i) => i + 1)
function rowFor(rom: RomFile, absolute = true): InitLatch {
  return {
    initPointer: PTR,
    cell: LATCH,
    before: 0,
    code: [{ at: 0, length: BODY.length, sha256: hash(bytesAt(rom, INIT_AT, BODY.length)) }],
    absolute,
    why: 'synthetic',
  }
}
const initCart = (edit: (body: number[]) => void = () => {}) => {
  const body = [...BODY]
  edit(body)
  return cart([[INIT_AT, body]])
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
    // An edit anywhere in the INIT, the spawn loop in the middle included, drops the row (F5).
    for (const at of [0, 11, BODY.length - 1])
      expect(
        latchFor(
          initCart(b => (b[at] = 0xff)),
          0x82,
          PTR,
          rows,
        ),
        `byte ${at}`,
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
  it('is null when the image shows $82 live in slot 0: that edited map keeps today behavior (D51), no tenth block', () => {
    const w = img(0)
    w[0x14c8] = 8
    w[0x9e] = 0x82
    expect(placedSlot(loader(0xb123, [9]), w, spec)).toBeNull()
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
  // The slot search as a synthetic cart holds it: a fingerprinted head, then the table operand, then the table.
  const LOAD = 0x02a8dd
  const HEAD = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  const slotSearch = { at: LOAD, length: 11, sha256: hash(HEAD) }
  it('the latched row runs in the loader slot and with a camera that follows the grid, not the list spot', () => {
    const r = buildSyntheticRom()
    const o = 0x02 * 0x8000 + (LOAD & 0x7fff)
    r.buffer.set([...HEAD, 0x23, 0xb1], o)
    r.buffer[2 * 0x8000 + (0xb123 & 0x7fff)] = 3
    const loaded = new Uint8Array(WRAM)
    const go = (sprite: { x: number; y: number }) =>
      runOnce(r, 0, withSeed({ sprite, loaded }), { atRest: true, latches: { 0: initRow(true) }, slotSearch }) // prettier-ignore
    const a = go({ x: 0x80, y: 0x80 })
    expect(a.refusal).toBeUndefined()
    // Slot 3: its own OAM entries, not slot 0's (the synthetic draw writes entry 4 * slot).
    const plain = runOnce(r, 0, withSeed({ sprite: { x: 0x80, y: 0x80 }, loaded }), { atRest: true, latches: { 0: initRow(false) } }) // prettier-ignore
    expect(a.passes[0]!.parts[0]!.oam).not.toBe(plain.passes[0]!.parts[0]!.oam)
    // The camera is centred on the post-INIT spot (screen 128, 112), wherever the list put the sprite.
    for (const sp of [
      { x: 0x80, y: 0x80 },
      { x: 0x1c0, y: 0x40 },
    ]) {
      const m = go(sp)
      expect([m.passes[0]!.parts[0]!.ox, m.passes[0]!.parts[0]!.oy]).toEqual([128, 112])
      expect(m.anchor).toMatchObject({ x: sp.x + 8, y: sp.y })
    }
  })
  it('a spawn run of the same sprite keeps the seed as it is: no row, no slot, no exemption', () => {
    const loaded = new Uint8Array(WRAM)
    loaded[LATCH] = 1
    const m = runOnce(
      rom,
      0,
      { ...SPRITE_SEED, loaded },
      { spawn: { inputs: {} }, latches: { 0: initRow(true) } },
    )
    expect(m.refusal).toMatch(/dispatcher/)
    expect(m.absolutePlacement).toBeUndefined()
    expect(m.initLatched).toBeUndefined()
  })
  it('a generic seed (no loader image) takes the old path', () => {
    const m = run(0, { 0: initRow(true) })
    expect(m.absolutePlacement).toBeUndefined()
    expect(m.refusal).toBeUndefined()
    expect(m.anchor).toMatchObject({ x: 0x80 })
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
    'map %s: drawn as 72 cells at the fixed spots of the map, nothing at the list spot',
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
  // F1: the game draws these blocks with 8-bit OAM, so a camera chosen from the list spot wrapped or culled blocks.
  // Every spot of the list entry must give the same picture, none lost.
  it('the picture is the same wherever the list places the sprite (sweep of columns and rows, map $000)', () => {
    const rom = freshRom()
    const ptr = new SmwRom(rom).getLevelSpritePointer(0)!
    const at = loromToOffset(ptr, rom.buffer.length)!
    const base = new Uint8Array(rom.buffer)
    const entry = parseLevelSprites(base.subarray(at, at + 0x200), false).find(
      e => e.spriteId === 0x82,
    )!
    const draw = (col: number, row: number) => {
      const b = Uint8Array.from(base)
      const o = at + entry.streamOffset
      const screen = col >> 4
      b[o] = ((row & 15) << 4) | (b[o]! & 0x0c) | ((screen >> 4) << 1) | ((row >> 4) & 1)
      b[o + 1] = ((col & 15) << 4) | (screen & 15)
      const moved = parseLevelSprites(b.subarray(at, at + 0x200), false).find(
        e => e.spriteId === 0x82,
      )!
      expect([moved.x, moved.y]).toEqual([col, row])
      const r = mapSprites(new L1ModelCache(), b, romPath(VANILLA), 0)
      if (r.status !== 'ok') throw new Error(r.status)
      const d = r.sprites.find(x => x.id === 0x82)!
      return { status: d.status, box: d.box, parts: d.parts, xy: [d.x, d.y] }
    }
    const ref = draw(5, 7)
    expect(ref.parts).toHaveLength(72)
    for (const col of [0, 1, 2, 13, 15, 16, 33])
      for (const row of [1, 7, 15, 25]) {
        const d = draw(col, row)
        expect(d, `col ${col} row ${row}`).toEqual({ ...ref, xy: [col * 16, row * 16] })
      }
  }, 120_000)
  it('without the latch row the sprite is erased, as before the fix', () => {
    const rom = freshRom()
    const seed = withSeed({ sprite: { x: 80, y: 112 } }, levelSeed(rom, 0))
    expect(runOnce(rom, 0x82, seed, { atRest: true, latches: {} }).emptyReason).toMatch(
      /INIT erased/,
    )
  })
})

describe('how the grid reaches the view (no ROM)', () => {
  const NOTE =
    'The game lays this sprite out itself, at fixed spots of the map; it does not follow where the list places it.'
  const model = (absolutePlacement: boolean) =>
    ({
      id: 0x82,
      absolutePlacement,
      anchor: { x: 120, y: 280, rawX: 80, rawY: 112 },
      chosen: 0,
      passes: [{ pass: 0, pos: { x: 120, y: 280 }, origin: { x: 120, y: 280 }, parts: [{ oam: 0, char: 0, size: 8, palette: 9, priority: 2, flipX: false, flipY: false, dx: -40, dy: -40, attr: 0, ox: 0, oy: 0 }], palette: [], uploads: [] }], // prettier-ignore
    }) as never
  it('an absolute run answers with the list spot and the plain-words note; any other run does not', () => {
    const r = modelResult(model(true))
    expect(r).toMatchObject({
      ok: true,
      anchor: { x: 120, y: 280 },
      listPos: { x: 80, y: 112 },
      note: NOTE,
    })
    const other = modelResult(model(false)) as Record<string, unknown>
    expect(other.listPos).toBeUndefined()
    expect(other.note).toBeUndefined()
  })
  it('the view sprite reports the list spot while its picture stands at the anchor (hover, selection, drag)', () => {
    const sp1 = [new Uint8Array(64).fill(3)]
    const lvl = { vram: { sp1 }, colors: COLORS } as never
    const list = [
      {
        index: 0,
        x: 5,
        y: 7,
        spriteId: 0x82,
        screen: 0,
        extraBit: false,
        raw: [],
        streamOffset: 0,
      },
    ] as never
    const [d] = drawSprites(list, lvl, () => modelResult(model(true)))
    expect([d!.x, d!.y]).toEqual([80, 112])
    expect(d!.box).toEqual({ x0: 80, y0: 240, x1: 88, y1: 248 })
    expect(d!.note).toBe(NOTE)
  })
  it('interpParts keeps the part count a 16 px piece expands to', () => {
    expect(interpParts([{ oam: 0, char: 0, size: 16, palette: 9, priority: 2, flipX: false, flipY: false, dx: 0, dy: 0, attr: 0, ox: 0, oy: 0 }] as never)).toHaveLength(4) // prettier-ignore
  })
})
