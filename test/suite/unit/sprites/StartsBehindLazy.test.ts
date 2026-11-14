/**
 * `startsBehind` on a synthetic cart (no ROM), with a non-line-guided id so only the probe is under test (#1231):
 * the lazy probe judges a sprite from its first drawn pass, a refused spawn run is unchecked rather than evidence, and
 * a map with no spawn the loader allows has nothing to call hidden.
 */
import { describe, expect, it } from 'vitest'
import { fingerprint } from '../../../../src/rom/Fingerprint'
import { RomFile } from '../../../../src/rom/RomFile'
import { startsBehind } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const TABLES = 0x02a7f6
const word = (v: number) => [v & 255, 0, (v >> 8) & 255]
const X = 0x1090
/** A loader offset whose camera lies past the map's end, so that spawn is not allowed. */
const FAR = -0x2000
const QUIET = 51
const ID = 70

const off = (snes: number) => (snes >>> 16) * 0x8000 + ((snes & 0xffff) - 0x8000)

/** A synthetic cart whose id `ID` runs `code` at $01:9800, with the loader window `left` / `right`. */
function cart(code: number[], left: number, right: number) {
  const bytes = new Uint8Array(buildSyntheticRom().buffer)
  expect(bytes.subarray(off(0x019800), off(0x019800) + code.length).every(v => v === 0)).toBe(true)
  bytes.set(code, off(0x019800))
  bytes[off(0x018320 + 9 + ID * 2)] = 0x00
  bytes[off(0x018320 + 9 + ID * 2) + 1] = 0x98
  const [l, r] = [word(left), word(right)]
  bytes.set([l[0]!, 0, r[0]!, l[2]!, 0, r[2]!], off(TABLES))
  const rom = RomFile.fromBytes('lazy.sfc', bytes)
  return { rom, loader: { at: TABLES, len: 6, sha: fingerprint(rom.readAt(TABLES, 6))! } }
}

const seed = (neighbours?: { id: number; x: number; y: number }[]) =>
  withSeed({ slot: 3, sprite: { x: X, y: X }, level: { screenMode: 0, screens: 32 }, ...(neighbours ? { neighbours } : {}) }, SPRITE_SEED) // prettier-ignore

// Pass 0: INC $1594,X, draw its own piece (JSR $8640), then scan the sprite table for number QUIET and draw it (the
// NeighbourScan shape). Later passes: become $FF, which is past the sprite table: a refusal.
const DRAW_THEN_REFUSE = [
  0xbd, 0x94, 0x15, 0xf0, 0x05, 0xa9, 0xff, 0x95, 0x9e, 0x60, 0xfe, 0x94, 0x15,
  0x20, 0x40, 0x86, 0xa0, 0x09, 0xb9, 0xc8, 0x14, 0x49, 0x08, 0xd0, 0x07, 0xb9, 0x9e, 0x00,
  0x49, QUIET, 0xf0, 0x04, 0x88, 0x10, 0xef, 0x60, 0xda, 0xbb, 0x20, 0x40, 0x86, 0xfa, 0x60,
] // prettier-ignore
// Pass 0 draws nothing; pass 1 becomes $FF (refused).
const QUIET_THEN_REFUSE = [0xbd, 0x94, 0x15, 0xf0, 0x05, 0xa9, 0xff, 0x95, 0x9e, 0x60, 0xfe, 0x94, 0x15, 0x60] // prettier-ignore

describe('startsBehind probe', () => {
  it('a sprite that draws on pass 0 is judged from that pass: a later refusal does not hide it (the lazy rule)', () => {
    // Scrolling right its own piece is at -$40 (behind) but the neighbour it draws is in view. Run to the end, the
    // spawn is refused on pass 1 after its first draw (unchecked, never a verdict); the run that stops at its first
    // drawn pass adopts the neighbour (verdict false), which is what the game shows at the spawn.
    const { rom, loader } = cart(DRAW_THEN_REFUSE, FAR, -0x40)
    const s = seed([{ id: QUIET, x: X + 0x60, y: X }])
    expect(startsBehind(rom, ID, s, { loader }, { x: X, y: X })).toBe(false)
  })

  it('a refused spawn run is unchecked, not evidence the sprite is hidden (fail closed)', () => {
    // The run draws nothing on pass 0 and is refused on pass 1; its position alone (-$40) would read as behind the scroll.
    const { rom, loader } = cart(QUIET_THEN_REFUSE, FAR, -0x40)
    expect(startsBehind(rom, ID, seed(), { loader }, { x: X, y: X })).toBe('refused')
  })

  it('a loader whose window cannot be read is unchecked for that reason', () => {
    const { rom } = cart(QUIET_THEN_REFUSE, FAR, -0x40)
    const loader = { at: TABLES, len: 6, sha: '0'.repeat(64) }
    expect(startsBehind(rom, ID, seed(), { loader }, { x: X, y: X })).toBe('loader')
  })

  // Refuses when the camera's low byte is 0, otherwise draws its own piece at its position.
  const REFUSE_AT_CAM_0 = [0xa5, 0x1a, 0xd0, 0x05, 0xa9, 0xff, 0x95, 0x9e, 0x60, 0x20, 0x40, 0x86, 0x60] // prettier-ignore
  const opening = (cam: number) => ({ ...seed(), opening: true, loaded: Object.assign(new Uint8Array(0x20000), { 0x1a: cam & 255, 0x1b: cam >> 8 }) }) // prettier-ignore

  it('a refused spawn does not end the probe: a later spawn that shows the sprite settles it as false', () => {
    // Map-load camera $1000 is refused; the scroll-right spawn (camera $1070) shows the piece 32 px in.
    const { rom, loader } = cart(REFUSE_AT_CAM_0, FAR, 0x20)
    expect(startsBehind(rom, ID, opening(0x1000), { loader }, { x: X, y: X })).toBe(false)
  })

  it('an early spawn that shows the sprite settles it before a later refused one is run', () => {
    // Map-load camera $1070 shows it; the scroll-right camera ($1100) would be refused and is never reached.
    const { rom, loader } = cart(REFUSE_AT_CAM_0, FAR, -0x70)
    expect(startsBehind(rom, ID, opening(0x1070), { loader }, { x: X, y: X })).toBe(false)
  })

  it('every spawn refused stays unchecked', () => {
    const { rom, loader } = cart(REFUSE_AT_CAM_0, FAR, -0x70)
    expect(startsBehind(rom, ID, opening(0x1000), { loader }, { x: X, y: X })).toBe('refused')
  })

  it('no spawn the loader allows: nothing was shown hidden, so not "never appears"', () => {
    // Both scroll cameras lie past the map's end, there is no map-load opening: no run at all.
    const { rom, loader } = cart(DRAW_THEN_REFUSE, FAR, FAR)
    expect(startsBehind(rom, ID, seed(), { loader }, { x: X, y: X })).toBe(false)
  })
})
