/**
 * Replays every hardware-witnessed vanilla line-guided placement ($62-$68) from the layers_v5 captures
 * (`sprite_spawns.json`) through the runner and compares the sprite's position at the frame Mesen caught it
 * (#1029). Evidence scope: 101 records in 6 maps, vanilla ROM, Mesen 2.x level-load captures, one machine; not a
 * sweep of every placement (the unwitnessed ones are in the PR body).
 *
 * Method: k = drawnFrame - initFrame. Pass p runs on frame initFrame + 1 + p with TrueFrame seed + 1 + p (this
 * premise needs firstRealFrame === initFrame + 1; moving records are asserted to satisfy it). The seed is hw
 * trueFrame - k and the draw of frame k is pass k-1. The ids draw before their line step (SMWDisX
 * bank_01.asm:12194-12204 for $67; the others read the position the pass before left), so the recorded X, Y is
 * the position after pass k-2. $62 and $63 are platforms: CODE_01DAA2 (bank_01.asm:12323-12347) moves $E4 left
 * by $18 (or $28 when $1602 is nonzero) and $D8 up by 8 before CODE_01B2DF draws, and restores at 12348-12355;
 * the capture snapshots $E4/$D8 at the slot's first OAM write, so the record is the moved sprite position.
 *
 * What this tests: 84 of 101 records ($62, $65, $66, $67, $68) move and so test timing. The other 17 are
 * stationary and do not: $64 (11) never moves, $63 (6) matches at k-0, k-1 and k-2.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unzip } from '../../../../tools/scripts/capture_render'
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { runOnce } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { CAPTURE_DIR, freshRom, hasCaptures, hasRom, VANILLA } from '../../support/corpus'

interface Rec {
  map: string
  id: number
  x: number
  y: number
  listX: number
  listY: number
  slot: number
  cameraX: number
  cameraY: number
  trueFrame: number
  effFrame: number
  initFrame: number
  firstRealFrame: number
  spriteMisc1602: number
  drawnFrame: number
  marioAtInit: { x: number; y: number }
}

/** The maps that hold a witnessed $62-$68; the sweep needs all of them to mean what its counts say. */
const MAPS = ['005', '00f', '01a', '01f', '12a', '12c']

function records(): Rec[] {
  const out: Rec[] = []
  for (const map of MAPS) {
    const entries = unzip(readFileSync(join(CAPTURE_DIR, `${map}.zip`)))
    const key = [...entries.keys()].find(k => k.endsWith('sprite_spawns.json'))
    if (!key) throw new Error(`map ${map}: no sprite_spawns.json`)
    const j = JSON.parse(entries.get(key)!().toString('utf8')) as { spawns?: (Rec & { id: string })[] } // prettier-ignore
    for (const r of j.spawns ?? []) {
      const id = parseInt(r.id.slice(1), 16)
      if (id >= 0x62 && id <= 0x68) out.push({ ...r, map, id })
    }
  }
  return out
}

/** $64 never moves and $63 matches at k-0..k-2: neither can tell a timing error from none. */
const STATIONARY = new Set([0x63, 0x64])

/** Moving records whose first real frame is not INIT + 1, which breaks the replay's pass-to-frame premise. */
const premiseBreakers = (recs: Rec[]) =>
  recs.filter(r => !STATIONARY.has(r.id) && r.firstRealFrame !== r.initFrame + 1)

/** Records the model reproduces, by id; `flip` plants a TrueFrame parity error in the seed. */
function replay(
  recs: Rec[],
  flip = 0,
): { matched: Record<string, number>; total: number; initRetries: number } {
  const rom = freshRom()
  const loaded = new Map<string, Uint8Array | undefined>()
  const matched: Record<string, number> = {}
  let initRetries = 0
  for (const r of recs) {
    if (!loaded.has(r.map)) {
      const l = loadLevelState(rom, parseInt(r.map, 16))
      expect(l.ok, `level load for map ${r.map}`).toBe(true)
      loaded.set(r.map, l.ok ? l.wram : undefined)
    }
    const k = r.drawnFrame - r.initFrame
    const seed = withSeed({
      loaded: loaded.get(r.map),
      slot: r.slot,
      mainPasses: k + 1,
      trueFrame: ((r.trueFrame - k) & 0xff) ^ flip,
      effFrame: (r.effFrame - k) & 0xff,
      sprite: { x: r.listX, y: r.listY },
      camera: { x: r.cameraX, y: r.cameraY },
      mario: r.marioAtInit,
    })
    const m = runOnce(rom, r.id, seed)
    if (m.initFrames !== 1) initRetries++
    const pos = m.passes[k - 2]?.pos
    const dx = r.id === 0x62 || r.id === 0x63 ? (r.spriteMisc1602 ? 0x28 : 0x18) : 0
    const got = pos && { x: pos.x - dx, y: pos.y - (dx ? 8 : 0) }
    const key = `$${r.id.toString(16)}`
    matched[key] ??= 0
    if (got?.x === r.x && got.y === r.y) matched[key]++
  }
  return { matched, total: recs.length, initRetries }
}

describe.skipIf(
  !hasRom(VANILLA) ||
    !hasCaptures() ||
    !MAPS.every(m => hasCaptures(join(CAPTURE_DIR, `${m}.zip`))),
)('line-guided replay against the hardware captures (#1029)', () => {
  it('reproduces every witnessed $62-$68 position: 101 of 101, per id', () => {
    const recs = records()
    // The expected totals come from the captures read above, so a vanishing record or map goes red here.
    expect(recs).toHaveLength(101)
    const got = replay(recs)
    // Named exceptions: none. 17 of the 101 are stationary ($63, $64) and match whatever the timing.
    expect(recs.filter(r => STATIONARY.has(r.id))).toHaveLength(17)
    expect(recs.filter(r => !STATIONARY.has(r.id))).toHaveLength(84)
    expect(premiseBreakers(recs)).toEqual([])
    expect(got.matched).toEqual({ $62: 6, $63: 6, $64: 11, $65: 25, $66: 1, $67: 17, $68: 35 })
    expect(got.initRetries).toBe(0)
  }, 120_000)

  it('goes red when the TrueFrame seed has the wrong parity', () => {
    const planted = replay(records(), 1)
    expect(planted.total).toBe(101)
    // Measured on this machine: $62-$64 do not use the frame counter for their travel; of the 78 $187B ids
    // ($65-$68) 34 still match and 44 of 78 go red, because a flipped parity leaves the sum of the steps
    // unchanged on some runs. The exact counts below are the assertion; "44 of 78" is the discrimination.
    expect(planted.matched).toEqual({ $62: 6, $63: 6, $64: 11, $65: 21, $66: 1, $67: 4, $68: 8 })
    expect(Object.values(planted.matched).reduce((a, b) => a + b, 0)).toBe(57)
  }, 120_000)

  it('the premise tripwire goes red on a moving record whose first real frame is not INIT + 1', () => {
    const recs = records()
    const moving = recs.findIndex(r => !STATIONARY.has(r.id))
    const planted = recs.map((r, i) =>
      i === moving ? { ...r, firstRealFrame: r.initFrame + 2 } : r,
    )
    expect(premiseBreakers(planted)).toHaveLength(1)
    // Stationary records are exempt: the three long $63/$64 runs sit at firstRealFrame - initFrame of 20-25.
    const long = recs.filter(r => STATIONARY.has(r.id) && r.firstRealFrame - r.initFrame > 1)
    expect(long.map(r => r.firstRealFrame - r.initFrame).sort()).toEqual([20, 21, 25])
  })
})
