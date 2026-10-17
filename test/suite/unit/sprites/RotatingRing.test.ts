/**
 * #983: the ring of sprites $E2 and $E3 comes from running the ROM's own spawn and draw routines
 * (RotatingRing.ts), never from a table or a circle formula in the editor. The synthetic block (no
 * ROM, so CI runs it) hand-assembles a spawn and a draw of our own into the synthetic cart, with
 * non-vanilla bytes and data, so a hardcoded vanilla position, tile or attribute goes red and no ROM
 * routine is committed. The corpus blocks run the real ROM: a sweep over all 10 vanilla placements,
 * and an exact comparison with the Mesen frames of map $107 (layers_v5 windows, hardware OAM).
 * Related: #839 (cluster OAM is the ring's own, never another sprite's part).
 *
 * Owner ruling D52 (option B): a changed routine or call-path part does not blank the ring; it is
 * drawn and `unverified` names what differs. Every check has a planted fixture that goes red when
 * the check is deleted.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { parseLevelSprites, type LevelSprite } from '../../../../src/rom/LevelParser'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { spanFingerprint } from '../../../../src/rom/SubmapFlagGate'
import { bytesAt } from '../../../../src/rom/sprites/interp/Guards'
import { levelSeed } from '../../../../src/rom/sprites/interp/LevelLoader'
import { runOnce } from '../../../../src/rom/sprites/interp/SpriteRunner'
import {
  ringGate,
  rotatingRing,
  RING_SPANS,
  type RingRoutines,
} from '../../../../src/rom/sprites/interp/RotatingRing'
import { getSpriteMetadata } from '../../../../src/rom/model/sprites/SpriteMetadata'
import { L1ModelCache } from '../../../../theia/extension/src/node/map-screen'
import {
  drawSprites,
  interpDrawer,
  mapSprites,
} from '../../../../theia/extension/src/node/map-sprites'
import { unzip } from '../../../../tools/scripts/capture_render'
import { COLORS } from '../../support/mapInputs'
import { CAPTURE_DIR, hasCaptures, hasRom, romPath, VANILLA } from '../../support/corpus'
import { buildSyntheticRom, type SyntheticOptions } from '../../support/syntheticSpriteRom'

const LEVEL = 0x105
const off = (snes: number) => (snes >>> 16) * 0x8000 + ((snes & 0xffff) - 0x8000)

/**
 * The spawn's effect, written for this cart: refuses at BooRingIndex 2 or more like the game's, stores A (the id), the
 * entry's X low byte ($00), the stream byte at [SpriteDataPtr] + $03 and the list index $02 in the cells the draw reads,
 * then makes cluster slots 19..10 type 4. 103 bytes like the game's, padded with NOPs.
 */
const spawnBody = [
  ...[0x8d, 0xbc, 0x0f], // STA $0FBC (BooRingLoadIndex cell)
  ...[0xa5, 0x00, 0x8d, 0xb2, 0x0f], // LDA $00 / STA $0FB2 (BooRingXPosLow cell)
  ...[0xa4, 0x03, 0xb7, 0xce, 0x8d, 0xb4, 0x0f], // LDY $03 / LDA [SpriteDataPtr],Y / STA $0FB4: the stream byte at the entry's offset
  ...[0xa5, 0x02, 0x8d, 0xb6, 0x0f], // LDA $02 / STA $0FB6: the entry's list index
  ...[0xa2, 0x13], // LDX #$13
  ...[0xa9, 0x04, 0x9d, 0x92, 0x18, 0xca, 0xe0, 0x09, 0xd0, 0xf6], // loop: type 4 into slot X, DEX, CPX #9, BNE
]
const spawn = [
  ...[0xac, 0xba, 0x18, 0xc0, 0x02, 0xb0, spawnBody.length], // LDY BooRingIndex / CPY #2 / BCS RTS: two rings at most
  ...spawnBody,
  0x60,
]
/**
 * The draw's effect: one 8 x 8 OAM entry per slot X (19..10) at index 76 + X - 10: x = X * 8 minus the camera low byte
 * plus the list index, y = Mario's X high byte plus the stream byte plus the ring angle high byte, tile = the stored X low
 * byte plus the angle low byte, attribute = the stored id. 291 bytes, padded with NOPs.
 */
const draw = [
  ...[0xad, 0xe9, 0x15, 0x38, 0xe9, 0x0a, 0x0a, 0x0a, 0xa8], // LDA CurSpriteProcess / SEC / SBC #10 / ASL ASL / TAY
  ...[
    0xad, 0xe9, 0x15, 0x0a, 0x0a, 0x0a, 0x38, 0xe5, 0x1a, 0x18, 0x6d, 0xb6, 0x0f, 0x99, 0x30, 0x03,
  ], // X * 8 - Layer1XPos + index -> OAM X
  ...[0xa5, 0x95, 0x18, 0x6d, 0xb4, 0x0f, 0x6d, 0xb0, 0x0f, 0x99, 0x31, 0x03], // OAM Y = Mario's X high byte ($95, $7F: the run puts Mario far away) + stream byte + angle high
  ...[0xad, 0xb2, 0x0f, 0x18, 0x6d, 0xae, 0x0f, 0x99, 0x32, 0x03], // tile = X low + angle low
  ...[0xad, 0xbc, 0x0f, 0x99, 0x33, 0x03, 0x60], // attribute, RTS
]
/** A draw that puts the pieces round the screen centre (128, 112), 8 px apart and centred on slot 15, whatever the camera: the geometry of a real ring. */
const screenDraw = [
  ...[0xad, 0xe9, 0x15, 0x38, 0xe9, 0x0a, 0x0a, 0x0a, 0xa8],
  ...[0xad, 0xe9, 0x15, 0x0a, 0x0a, 0x0a, 0x18, 0x69, 0x08, 0x99, 0x30, 0x03], // OAM X = 8 * X + 8 (88..160: dx -40..32)
  ...[0xad, 0xe9, 0x15, 0x0a, 0x0a, 0x0a, 0x38, 0xe9, 0x08, 0x99, 0x31, 0x03], // OAM Y = 8 * X - 8 (72..144: dy -40..32)
  ...[0xad, 0xb2, 0x0f, 0x99, 0x32, 0x03],
  ...[0xad, 0xbc, 0x0f, 0x99, 0x33, 0x03, 0x60],
]
const pad = (b: number[], n: number) => [
  ...b.slice(0, -1),
  ...Array(n - b.length).fill(0xea),
  b[b.length - 1]!,
]

/** The call path to the ring, hand-written with the vanilla shape (see PATH in RotatingRing.ts); operands that do not matter are made up. */
// prettier-ignore
const PATH_BYTES: [number, number[]][] = [
  [0x02a8c0, [0xc9, 0xe1, 0x90, 0x0c, 0xda, 0x5a, 0x88, 0x84, 0x03, 0x20, 0xc0, 0xaa]], // loader route
  [0x02aac0, [0xa0, 0x01, 0x8c, 0x34, 0x12, 0xc9, 0xe4, 0xf0, 0x7f]], // spawn entry
  [0x02aad1, [0xc9, 0xe2, 0xb0, 0x3c]], // $E2/$E3 branch
  [0x02f808, [0x8b, 0x4b, 0xab, 0x20, 0x10, 0xf8, 0xab, 0x6b, 0xa2, 0x13, 0x8e, 0x77, 0x15, 0xbd, 0x92, 0x18, 0xf0, 0x03, 0x20, 0x21, 0xf8, 0xca, 0x10, 0xf2]], // cluster loop
  [0x02f821, [0x22, 0xfa, 0x86, 0x00]], // JSL ExecutePtr (the synthetic cart's, $00:86FA)
  [0x02f82d, [0x98, 0xfa]], // type 4 entry
]

function ringRom(tweak: (bytes: Uint8Array) => void = () => {}, cart: SyntheticOptions = {}) {
  const bytes = new Uint8Array(buildSyntheticRom(cart).buffer)
  const put = (snes: number, b: number[]) => {
    expect(bytes.subarray(off(snes), off(snes) + b.length).every(v => v === 0)).toBe(true)
    bytes.set(b, off(snes))
  }
  put(0x02ab11, pad(spawn, 103))
  put(0x02fa98, pad(draw, 291))
  for (const [at, b] of PATH_BYTES) put(at, b)
  tweak(bytes)
  return RomFile.fromBytes('ring.sfc', bytes)
}

/** The fingerprints of this cart's own routines (the vanilla ones are for the vanilla bytes). */
const routinesOf = (rom: RomFile): RingRoutines => {
  const sha = (spans: readonly (readonly [number, number])[]) =>
    spanFingerprint(Uint8Array.from(spans.flatMap(([at, n]) => bytesAt(rom, at, n)!)))!
  return {
    spawn: sha(RING_SPANS.spawn),
    draw: sha(RING_SPANS.draw),
    helpers: sha(RING_SPANS.helpers),
    contact: sha(RING_SPANS.contact),
  }
}

/** WRAM offset of the synthetic stream: byte i holds $40 + i, except offset 7 (the ENTRY's), which holds 5. */
const STREAM_AT = 0xf000
const STREAM_BYTE = 5
/** The level's loaded image with SpriteDataPtr pointing at a known stream in WRAM, so the hand-off is checkable without the corpus. */
function seedOf(rom: RomFile, patch: (w: Uint8Array) => void = () => {}) {
  const s = levelSeed(rom, LEVEL)
  const w = Uint8Array.from(s.loaded!)
  w.set([STREAM_AT & 255, STREAM_AT >> 8, 0x7e], 0xce)
  for (let i = 0; i < 32; i++) w[STREAM_AT + i] = 0x40 + i
  w[STREAM_AT + ENTRY.streamOffset] = STREAM_BYTE
  patch(w)
  return { ...s, loaded: w }
}

const ENTRY = { id: 0xe3, x: 416, y: 320, index: 2, streamOffset: 7 }
const run = (rom: RomFile, e = ENTRY, routines = routinesOf(rom)) => rotatingRing(rom, seedOf(rom), e, routines) // prettier-ignore
const parts = (rom: RomFile, e = ENTRY) => {
  const r = run(rom, e)
  if (!r.ok) throw new Error(r.reason)
  return r
}

describe('the rotating ring from the routines (synthetic cart)', () => {
  it('the hand-assembled routines are the lengths the gate hashes', () => {
    expect([pad(spawn, 103).length, pad(draw, 291).length]).toEqual([103, 291])
  })

  it("10 pieces at the OAM the cart's own spawn and draw wrote, mapped back by the camera, verified", () => {
    // Camera = centre - (128, 112) = (288, 208). OAM x = X * 8 - $20 (camera low) + 2 (the list index), so dx = that - 128;
    // OAM y = $7F (the Mario position the run sets) + 5 (the stream byte at the entry's offset), so dy = that - 112;
    // tile = the entry's X low byte ($A0, name table from the attribute), attribute = the id ($E3).
    const r = parts(ringRom())
    expect(r.unverified).toEqual([])
    expect(r.parts.length).toBe(10)
    r.parts.forEach((p, k) => {
      const X = 10 + k
      expect([p.oam, p.dx, p.dy, p.char, p.attr, p.size]).toEqual([76 + k, 8 * X - 30 - 128, 0x7f + STREAM_BYTE - 112, 0xa0 | (1 << 8), 0xe3, 8]) // prettier-ignore
    })
  })

  it('the id reaches the spawn in A, and the entry X in $00: $E2 and $E3 differ only by what the cart did with A', () => {
    const rom = ringRom()
    const attrs = (id: number) => parts(rom, { ...ENTRY, id }).parts.map(p => p.attr)
    expect(new Set(attrs(0xe2))).toEqual(new Set([0xe2]))
    expect(new Set(attrs(0xe3))).toEqual(new Set([0xe3]))
    const x = (e: number) => parts(rom, { ...ENTRY, x: e }).parts[0]!.char & 0xff
    expect([x(416), x(2560 + 0x30)]).toEqual([0xa0, 0x30])
  })

  it('palette, priority and flips come from the attribute the draw wrote', () => {
    // $E3 = 1110 0011: flipY, flipX, priority 2, palette bits 1, name table 1.
    expect(parts(ringRom()).parts[0]).toMatchObject({
      flipX: true,
      flipY: true,
      priority: 2,
      palette: 9,
    })
  })

  it('an entry near the map origin (negative camera) maps back to its own position', () => {
    // Camera (-64, -64): the cart's OAM x = X * 8 - $C0 + 2 wraps to a byte; its offset from the centre (screen 128) is the same as ever.
    const r = parts(ringRom(), { ...ENTRY, x: 64, y: 48 })
    expect(r.parts.map(p => [p.dx, p.dy])).toEqual(
      Array.from({ length: 10 }, (_, k) => [8 * (10 + k) - 64 + 2, 0x7f + STREAM_BYTE - 112]),
    )
  })

  it('the loader hand-off reaches the spawn: list index in $02, stream offset in $03, read through SpriteDataPtr', () => {
    const rom = ringRom()
    const at = (e: Partial<typeof ENTRY>) => parts(rom, { ...ENTRY, ...e }).parts[0]!
    const base = at({})
    expect(at({ index: 3 }).dx).toBe(base.dx + 1) // the index is added to the OAM x
    // The stream byte at offset 9 is $40 + 9 = $49 instead of 5: a swapped or ignored offset reads the wrong byte.
    expect(at({ streamOffset: 9 }).dy).toBe(base.dy + (0x49 - STREAM_BYTE))
  })

  it('the spawn is a fresh one: ring state left in the image (BooRingIndex 2, a turned angle) is cleared, and the requested angle is the ring state', () => {
    const rom = ringRom()
    const dirty = seedOf(rom, w => {
      w[0x18ba] = 2 // a game that already holds two rings: the spawn would refuse
      w.fill(0x55, 0x0fae, 0x0fae + 16)
    })
    const r = rotatingRing(rom, dirty, { ...ENTRY, angle: 0x103 }, routinesOf(rom))
    if (!r.ok) throw new Error(r.reason)
    expect(r.parts.length).toBe(10)
    // Angle $103: low byte 3 added to the tile, high byte 1 added to OAM y.
    expect(r.parts.every(p => (p.char & 0xff) === 0xa3 && p.dy === 0x7f + STREAM_BYTE + 1 - 112)).toBe(true) // prettier-ignore
  })

  describe('pieces at negative map coordinates (a centre near the map origin, M1)', () => {
    const screenRom = () => ringRom(b => b.set(pad(screenDraw, 291), off(0x02fa98)))
    const centres = [0, 32, 64]
    it.each(centres.flatMap(x => centres.map(y => ({ x, y }))))(
      'a centre at $x,$y: every piece within 80 px of it',
      ({ x, y }) => {
        const r = parts(screenRom(), { ...ENTRY, x, y })
        expect(r.parts.length).toBe(10)
        r.parts.forEach((p, k) => {
          expect([p.dx, p.dy]).toEqual([8 * (k - 5), 8 * (k - 5)]) // 8 * (X - 15), X = 10 + k
          expect(Math.abs(p.dx)).toBeLessThanOrEqual(80)
          expect(Math.abs(p.dy)).toBeLessThanOrEqual(80)
        })
      },
    )
    it.each(centres.map(c => ({ c })))(
      'drawn on the map at centre $c,$c the box is the pieces, a few hundred px at most',
      ({ c }) => {
        const rom = screenRom()
        const solid = Array.from({ length: 128 }, () => new Uint8Array(64).fill(3))
        const m = { vram: { sp1: solid, sp2: solid, sp3: solid, sp4: solid }, colors: COLORS, isVertical: false, screenCount: 3 } // prettier-ignore
        const s: LevelSprite = { index: 2, x: c / 16, y: c / 16, spriteId: 0xe3, screen: 0, extraBit: false, raw: [0x41, 0xa1, 0xe3], streamOffset: 7 } // prettier-ignore
        const d = drawSprites([s], m, interpDrawer(rom, LEVEL, m, runOnce, () => seedOf(rom), routinesOf(rom)))[0]! // prettier-ignore
        expect([d.status, d.reason]).toEqual(['drawn', undefined])
        expect(d.box).toEqual({ x0: c - 40, y0: c - 40, x1: c + 40, y1: c + 40 })
      },
    )
  })

  describe('the gate (D52: drawn, flagged, never blank)', () => {
    const clean = routinesOf(ringRom())
    const changed = (at: number, to: number) => ringRom(b => (b[off(at)] = to))
    it('an untouched cart has no flags', () => expect(ringGate(ringRom(), clean)).toEqual([]))
    it.each([
      [0x02ab11, 0x42, 'the ring spawn routine'], // first byte of the span
      [0x02ab11 + 102, 0x42, 'the ring spawn routine'], // last byte of the span
      [0x02fa98, 0x42, 'the ring draw routine'],
      [0x02fa98 + 290, 0x42, 'the ring draw routine'],
    ])('a changed byte at $%s names %s, and only it', (at, to, what) => {
      expect(ringGate(changed(at, to), clean)).toEqual([what])
    })
    it.each([
      [0x02ab11 + 50, 'the ring spawn routine'],
      [0x02fa98 + 200, 'the ring draw routine'],
    ])('a harmless change inside the routine at $%s is still drawn, flagged', (at, what) => {
      const rom = changed(at, 0x1a) // INC A in the NOP run: nothing reads it
      const r = rotatingRing(rom, seedOf(rom), ENTRY, clean)
      expect(r.ok && r.unverified).toEqual([what])
      expect(r.ok && r.parts.length).toBe(10)
    })
    it.each([
      [0x02fc8d, 'the ring draw helpers'],
      [0x02fc8d + 84, 'the ring draw helpers'],
      [0x02fd48, 'the ring draw helpers'],
      [0x02fd48 + 111, 'the ring draw helpers'],
      [0x02fe71, 'the ring contact test'],
      [0x02fe71 + 83, 'the ring contact test'],
      [0x02f821, 'the cluster dispatch call'],
      [0x02a8c0, 'the loader route to the sprite spawn'],
      [0x02aac0, 'the cluster spawn entry'],
      [0x02aad1, 'the $E2/$E3 branch to the ring spawn'],
      [0x02aad3, 'the $E2/$E3 branch to the ring spawn'],
      [0x02f808, 'the cluster loop'],
      [0x02f82d, 'the cluster dispatch entry for type 4'],
      [0x02f82e, 'the cluster dispatch entry for type 4'],
    ])('a changed byte at $%s names %s', (at, what) => {
      const rom = ringRom(b => (b[off(at)] = (b[off(at)]! + 1) & 0xff))
      expect(ringGate(rom, clean)).toEqual([what])
    })
    it('a changed dispatch call target is named', () => {
      const rom = changed(0x02f822, 0x00)
      expect(ringGate(rom, clean)).toContain('the cluster dispatch call target')
    })
  })

  it('a hard failure is a refusal with its reason, not a flagged draw', () => {
    // The draw jumps out of ROM: BRK (00) as its first instruction.
    const r = run(ringRom(b => (b[off(0x02fa98)] = 0x00)))
    expect(r.ok).toBe(false)
  })

  it('a level the loader refused has no ring, and says why', () => {
    const rom = ringRom()
    const seed = { ...seedOf(rom), loaded: undefined, loadRefusal: 'loader said no' }
    expect(rotatingRing(rom, seed as never, ENTRY, routinesOf(rom))).toEqual({
      ok: false,
      reason: 'loader said no',
    })
  })
})

describe('the rotating ring on the map (synthetic cart)', () => {
  const rom = ringRom()
  // Every OBJ char of SP4 solid, so any ring char is "loaded".
  const solid = Array.from({ length: 128 }, () => new Uint8Array(64).fill(3))
  const model = { vram: { sp4: solid }, colors: COLORS, isVertical: false, screenCount: 3 }
  const sprite = (o: Partial<LevelSprite> = {}): LevelSprite => ({ index: 2, x: 26, y: 20, spriteId: 0xe3, screen: 1, extraBit: false, raw: [0x41, 0xa1, 0xe3], streamOffset: 7, ...o }) // prettier-ignore
  const draw = (s: LevelSprite, m = model, routines = routinesOf(rom)) =>
    drawSprites(
      [s],
      m,
      interpDrawer(rom, LEVEL, m, runOnce, () => seedOf(rom), routines),
    )[0]!

  it('one sprite at its real stream index, drawn from the ring pieces, never a marker', () => {
    const d = draw(sprite())
    expect(d).toMatchObject({ index: 2, id: 0xe3, x: 416, y: 320, status: 'drawn' })
    expect(d.unverified).toBeUndefined()
    // Pieces 8 wide at dx 8 * X - 158 (X 10..19: -78..-6) and dy 20 (see the first test): the box spans them.
    expect(d.box).toEqual({ x0: 338, y0: 340, x1: 418, y1: 348 })
  })

  it('$E2 is drawn the same way', () => {
    // The cart's attribute is the id, $E2 has no name-table bit: its chars are in the low pages, so all four are solid here.
    const all = { ...model, vram: { sp1: solid, sp2: solid, sp3: solid, sp4: solid } }
    expect(draw(sprite({ spriteId: 0xe2 }), all)).toMatchObject({ id: 0xe2, status: 'drawn' })
  })

  it('a vertical level keeps the marker and says why (owner call B)', () => {
    const d = draw(sprite(), { ...model, isVertical: true })
    expect(d).toMatchObject({ status: 'placeholder', index: 2 })
    expect(d.reason).toMatch(/vertical/)
  })

  it('the extra-bits flag keeps the marker (a custom sprite is never given the ring)', () => {
    expect(draw(sprite({ raw: [0x49, 0xa1, 0xe3] })).status).toBe('placeholder')
  })

  it('a changed routine still draws the ring, flagged unverified, naming the part', () => {
    const d = draw(sprite(), model, { ...routinesOf(rom), draw: '0'.repeat(64) })
    expect(d.status).toBe('drawn')
    expect(d.unverified).toBe('the rotating ring is drawn from the code at the vanilla address, and the ring draw routine is not the vanilla shape') // prettier-ignore
  })

  it('a run that does not return keeps the marker with the reason', () => {
    const broken = ringRom(b => (b[off(0x02fa98)] = 0x00))
    const d = drawSprites([sprite()], model, interpDrawer(broken, LEVEL, model, runOnce, () => seedOf(broken), routinesOf(broken)))[0]! // prettier-ignore
    expect(d.status).toBe('placeholder')
    expect(d.reason).toMatch(/^refused: /)
  })

  it('chars that are not loaded keep the marker (D52)', () => {
    expect(draw(sprite(), { ...model, vram: {} }).reason).toBe('charsNotLoaded')
  })

  it('the names say what the code does, in plain words', () => {
    expect(getSpriteMetadata(0xe2)?.displayName).toBe('Rotating ring of 10, counter-clockwise')
    expect(getSpriteMetadata(0xe3)?.displayName).toBe('Rotating ring of 10, clockwise')
  })
})

/** The 10 vanilla placements: $E3 on $013 $0EC $0EE $107 $1FB, $E2 on $0ED $0F2 $0F8 $107 $1FB. A literal list: it cannot register zero cases. */
const PLACEMENTS: [number, number][] = [
  ...[0x13, 0xec, 0xee, 0x107, 0x1fb].map(m => [m, 0xe3] as [number, number]),
  ...[0xed, 0xf2, 0xf8, 0x107, 0x1fb].map(m => [m, 0xe2] as [number, number]),
]

describe.skipIf(!hasRom(VANILLA))('the rotating ring, vanilla ROM', () => {
  it.each(
    PLACEMENTS.map(([map, id]) => ({
      map,
      id,
      name: `map $${map.toString(16)} sprite $${id.toString(16)}`,
    })),
  )(
    '$name: one drawn sprite, 10 verified pieces 80 px round its position, 40/512 of a turn apart',
    ({ map, id }) => {
      // prettier-ignore
      const bytes = new Uint8Array(readFileSync(romPath(VANILLA)))
      const r = mapSprites(new L1ModelCache(), bytes, romPath(VANILLA), map)
      if (r.status !== 'ok') throw new Error(JSON.stringify(r))
      const rings = r.sprites.filter(s => s.id === id)
      expect(rings.length).toBeGreaterThan(0)
      for (const s of rings) {
        expect(s).toMatchObject({ status: 'drawn' })
        expect(s.index).toBeGreaterThanOrEqual(0)
        expect(s.unverified).toBeUndefined()
      }
      // The pieces, from the same run the reply draws (the reply holds one bitmap).
      const rom = RomFile.load(romPath(VANILLA))
      const smw = new SmwRom(rom)
      const stream = parseLevelSprites(rom.readUpTo(smw.getLevelSpritePointer(map)!, 0x200)!, false)
      for (const e of stream.filter(s => s.spriteId === id)) {
        const ring = rotatingRing(rom, levelSeed(rom, map), { id, x: e.x * 16, y: e.y * 16, index: e.index, streamOffset: e.streamOffset }) // prettier-ignore
        if (!ring.ok) throw new Error(ring.reason)
        expect(ring.unverified).toEqual([])
        expect(ring.parts.length).toBe(10)
        expect(new Set(ring.parts.map(p => p.oam)).size).toBe(10)
        expect(ring.parts.every(p => p.size === 16 && p.palette === 9 && p.priority === 3)).toBe(
          true,
        )
        for (const p of ring.parts)
          expect(Math.abs(Math.hypot(p.dx, p.dy) - 80)).toBeLessThanOrEqual(1.5)
        // In OAM order (slot 19 first) the pieces step 40/512 of a turn = 28.125 degrees, all the same way round.
        const deg = ring.parts.map(p => (Math.atan2(p.dx, p.dy) * 180) / Math.PI)
        const step = (k: number) => ((((deg[k + 1]! - deg[k]!) % 360) + 540) % 360) - 180
        const steps = Array.from({ length: 9 }, (_, k) => step(k))
        expect(steps.every(d => Math.abs(Math.abs(d) - 28.125) <= 2)).toBe(true)
        expect(new Set(steps.map(Math.sign)).size).toBe(1)
      }
    },
  )
})

const ZIP = join(CAPTURE_DIR, '107.zip')
/** A hardware window of map $107: the PPU OAM and the BG1 scroll it was taken at. */
const windowOf = (n: string) => {
  const files = unzip(readFileSync(ZIP))
  const get = (name: string) => files.get(`107/windows/${n}/${name}`)!()
  const ppu = JSON.parse(get('layer_obj.json').toString()).ppu
  const eff = JSON.parse(get('layer_obj.json').toString()).effFrame as number
  return { oam: get('layer_obj_oam.bin'), eff, cam: { x: ppu.BG1HOFS_210D as number, y: ppu.BG1VOFS_210E as number } } // prettier-ignore
}

// The ring turned during the capture (frames 1077 and 1119, 42 apart): the angles are those the frames held,
// found as the angle at which the ROM-run ring equals the hardware ring (-1 per frame for $E3: 501 - 42 = 459).
describe.skipIf(!hasCaptures() || !hasRom(VANILLA))(
  'the rotating ring vs hardware (map $107, layers_v5 windows)',
  () => {
    it.each([
      ['screen_01', 501],
      ['screen_02', 459],
    ])(
      '%s: OAM 76-85 equal the hardware entries (position, tile, attribute, size) at angle %i',
      (screen, angle) => {
        const rom = RomFile.load(romPath(VANILLA))
        const win = windowOf(screen)
        const ring = rotatingRing(rom, levelSeed(rom, 0x107), { id: 0xe3, x: 496, y: 320, index: 2, streamOffset: 7, angle, effFrame: win.eff }) // prettier-ignore
        if (!ring.ok) throw new Error(ring.reason)
        expect(ring.parts.length).toBe(10)
        for (const p of ring.parts) {
          const x9 =
            win.oam[p.oam * 4]! | (((win.oam[512 + (p.oam >> 2)]! >> ((p.oam & 3) * 2)) & 1) << 8)
          const hi = (win.oam[512 + (p.oam >> 2)]! >> ((p.oam & 3) * 2)) & 3
          // The OAM holds the 9-bit screen X and the byte Y of the map position; the piece's map position gives the same.
          const hw = {
            x9,
            y: win.oam[p.oam * 4 + 1]!,
            char: win.oam[p.oam * 4 + 2]! | ((win.oam[p.oam * 4 + 3]! & 1) << 8),
            attr: win.oam[p.oam * 4 + 3]!,
            size: hi & 2 ? 16 : 8,
          }
          const ours = { x9: (496 + p.dx - win.cam.x) & 511, y: (320 + p.dy - win.cam.y) & 255, char: p.char, attr: p.attr, size: p.size } // prettier-ignore
          expect(ours).toEqual(hw)
        }
      },
    )

    it('planted: the wrong angle is not equal (the comparison can fail)', () => {
      const rom = RomFile.load(romPath(VANILLA))
      const win = windowOf('screen_01')
      const ring = rotatingRing(rom, levelSeed(rom, 0x107), { id: 0xe3, x: 496, y: 320, index: 2, streamOffset: 7, angle: 480 }) // prettier-ignore
      if (!ring.ok) throw new Error(ring.reason)
      const p = ring.parts[0]!
      expect((496 + p.dx - win.cam.x) & 511).not.toBe(win.oam[p.oam * 4]!)
    })
  },
)
