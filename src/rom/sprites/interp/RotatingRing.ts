/**
 * RotatingRing.ts -- sprites $E2 and $E3, a ring of 10 cluster sprites round the list entry's
 * position, drawn by the ROM's own spawn and draw routines run on the core (#983). Nothing is
 * written here: the spawn makes the slots, the draw makes the OAM entries, we read them back.
 * Like CastleFlames.ts (same mechanism, #894); the ring stands in the level, not on Layer 2.
 * Related: #839 (cluster OAM must never be counted as another sprite's parts).
 *
 * - Spawn: CODE_02AB11 (SMWDisX bank_02.asm:5669-5719), reached from CODE_02AAC0 on ids $E2/$E3
 *   (5640-5641): 10 cluster sprites of type 4; the first carries the rotation (+1 for $E2,
 *   -1 for $E3) and the ring's centre.
 * - Draw: CODE_02FA98 (16290-16429), the cluster dispatch's type 4 entry (15965-15972), then
 *   CODE_02FC8D / CODE_02FD48 (16531-16686): 16 x 16 pieces, 80 px from the centre, 40/512 of a turn
 *   (28.1 degrees) apart, so the 10 make an open arc of about 253 degrees, not a closed circle (DATA_02FA84, 16282-16288).
 * - Frame policy: SpriteLock is set, so the angle is the spawn state (0, the value the level load
 *   leaves; #983 owner call A) and does not turn. Mario is put far away: the draw's contact test
 *   (CODE_02FE71, 16781-16821) then never fires. docs/sprites/sprite-e2-e3-ring.md has the derivation.
 *
 * Evidence scope: vanilla USA ROM; 10 of 10 OAM entries equal the hardware ones in the layers_v5
 * captures of map $107 at the angle those frames held (test/suite/unit/sprites/RotatingRing.test.ts).
 * Viewers draw, they do not blank (owner ruling D52, option B): a routine or call-path byte that is
 * not the vanilla one is named in `unverified`; only what cannot draw refuses.
 */
import { callSubroutine, describe, Refusal } from '../../cpu/call'
import { spanFingerprint } from '../../SubmapFlagGate'
import type { RomFile } from '../../RomFile'
import { bytesAt, shapeMatches } from './Guards'
import { smwMachine } from './Machine'
import { checkExecutePtr } from './SpriteDispatch'
import { CLUSTER_PATH } from './CastleFlames'
import { RAM, type SpritePart } from './SpriteRunner'
import type { SpriteSeed } from './SpriteSeed'

const SPAWN = 0x02ab11
const DRAW = 0x02fa98
/** CMP #$E2 / BCS CODE_02AB11 (bank_02.asm:5640-5641) and the cluster dispatch's type 4 entry (5th dw of the table at $02:F825). */
const PATH = [
  // CastleFlames names the AAC0 entry for $E6; here it is shared by every cluster id.
  ...CLUSTER_PATH.map(c => (c.at === 0x02aac0 ? { ...c, what: 'the cluster spawn entry' } : c)),
  { what: 'the $E2/$E3 branch to the ring spawn', at: 0x02aad1, want: [0xc9, 0xe2, 0xb0, 0x3c] },
  { what: 'the cluster dispatch entry for type 4', at: 0x02f82d, want: [0x98, 0xfa] },
]

/** SHA-256 of the spawn (103 bytes), the draw (291) and the two draw helpers (85 + 112), each span ending in RTS; data tables are not part. */
export interface RingRoutines {
  spawn: string
  draw: string
  helpers: string
}
export const VANILLA_RING_ROUTINES: RingRoutines = {
  spawn: '6c4c591c502ae9ebb9e48d14a6d6583f75069c2001a8aa6c1a3683e5504c9540',
  draw: '99d5589cf4ad06fcc69a17ff7257eb51131d23eea6e5f76142ac58c6fbfe3da2',
  helpers: 'ace622f06ed6f86fc473ce4ce0750eb5cfdd82dae5d8a858ab60910347f1de1c',
}
/** Spans: the spawn, the draw, and the helpers CODE_02FC8D..(CODE_02FCD9's RTS) and CODE_02FD48..its RTS. */
export const RING_SPANS = { spawn: [[SPAWN, 103]], draw: [[DRAW, 291]], helpers: [[0x02fc8d, 85], [0x02fd48, 112]] } as const // prettier-ignore

const CLUSTER_NUMBER = 0x1892
const CLUSTER_SLOTS = 20
const CUR_SPRITE_PROCESS = 0x15e9
const SPRITE_LOCK = 0x9d
const EFF_FRAME = 0x14
const BOO_RING_INDEX = 0x18ba
/** BooRingAngle through BooRingLoadIndex, 16 bytes (rammap.asm:1435-1442): zero is the level load's state. */
const RING_STATE = 0x0fae
/** PlayerXPosNext / PlayerYPosNext ($94 / $96, rammap.asm:860, 866): far from any ring, so the contact test misses. */
const MARIO_POS = 0x94

/** The ring's list entry: the id, its map position in px, its index in the stream and the offset of its first byte. */
export interface RingEntry {
  id: number
  x: number
  y: number
  index: number
  streamOffset: number
  /** The ring's angle, 0-511 (512 per turn). The map view leaves it 0, the spawn state; a test sets a hardware frame's. */
  angle?: number
  /** EffFrame ($14), which picks the tile of each piece's two-frame animation; the map view holds the image's. */
  effFrame?: number
}

export type RingResult =
  { ok: true; parts: SpritePart[]; unverified: string[] } | { ok: false; reason: string }

/** `unverified` names each routine or call-path part that is not the vanilla shape (empty when all match). */
export function ringGate(rom: RomFile, routines: RingRoutines = VANILLA_RING_ROUTINES): string[] {
  const out = PATH.filter(c => !shapeMatches(bytesAt(rom, c.at, c.want.length), c.want)).map(c => c.what) // prettier-ignore
  const callee = bytesAt(rom, 0x02f822, 3)
  if (!callee || !checkExecutePtr(rom, [callee]).ok) out.push('the cluster dispatch call target')
  const sha = (spans: readonly (readonly [number, number])[]) =>
    spanFingerprint(Uint8Array.from(spans.flatMap(([at, n]) => bytesAt(rom, at, n) ?? [])))
  if (sha(RING_SPANS.spawn) !== routines.spawn) out.push('the ring spawn routine')
  if (sha(RING_SPANS.draw) !== routines.draw) out.push('the ring draw routine')
  if (sha(RING_SPANS.helpers) !== routines.helpers) out.push('the ring draw helpers')
  return out
}

/**
 * The ring of one $E2/$E3 entry as OAM parts, `dx`/`dy` from the entry's position (`ox`/`oy` are the OAM values).
 * `seed` is `levelSeed`'s: its loaded image holds the level's sprite stream pointer and the cleared
 * ring state; a fresh machine per call draws each ring alone (#983 owner call C).
 */
export function rotatingRing(
  rom: RomFile,
  seed: SpriteSeed,
  e: RingEntry,
  routines: RingRoutines = VANILLA_RING_ROUTINES,
): RingResult {
  if (!seed.loaded) return { ok: false, reason: seed.loadRefusal ?? 'no level image' }
  const unverified = ringGate(rom, routines)
  try {
    const { bus, cpu } = smwMachine(rom, seed.loaded)
    const w = bus.wram
    for (const [k, v] of Object.entries(seed.ram)) w[Number(k)] = v
    // Camera on the centre so all 10 pieces (80 px out, 16 wide) are on screen; the 16-bit wrap is the game's own.
    const cam = { x: (e.x - 128) & 0xffff, y: (e.y - 112) & 0xffff }
    w.set([cam.x & 255, cam.x >> 8, cam.y & 255, cam.y >> 8], 0x1a)
    w[BOO_RING_INDEX] = 0
    w.fill(0, RING_STATE, RING_STATE + 16)
    const angle = (e.angle ?? 0) & 0x1ff
    w[RING_STATE] = angle & 255 // BooRingAngleLow, ring 0 (the ring is the first, BooRingIndex 0)
    w[RING_STATE + 2] = angle >> 8 // BooRingAngleHigh, ring 0
    w.set([0xf0, 0x7f, 0xf0, 0x7f], MARIO_POS)
    if (e.effFrame !== undefined) w[EFF_FRAME] = e.effFrame
    w[SPRITE_LOCK] = 1
    // The loader's hand-off to the spawn: _0/_1 the entry's X, _2 its list index, _3 the offset of its first byte (CODE_02A8C0, 5351-5355).
    w.set([e.x & 255, e.x >> 8, e.index, e.streamOffset], 0)
    const run = (entry: number, regs: { a?: number; x?: number }) => {
      const r = callSubroutine(cpu, entry, {
        kind: 'jsr',
        maxSteps: 20_000,
        regs: { db: 2, ...regs },
      })
      if (r.kind !== 'returned') throw new Refusal(describe(r, 20_000)!)
    }
    run(SPAWN, { a: e.id })
    const touched = new Set<number>()
    bus.onWramWrite = off => touched.add(off)
    // The cluster loop descends from slot 19 and sets CurSpriteProcess, which the draw reloads X from (bank_02.asm:15951-15953, 16400).
    for (let x = CLUSTER_SLOTS - 1; x >= 0; x--) {
      if (w[CLUSTER_NUMBER + x] !== 4) continue
      w[CUR_SPRITE_PROCESS] = x
      run(DRAW, { x })
    }
    const parts: SpritePart[] = []
    for (let i = 0; i < RAM.oamEntries; i++) {
      const b = RAM.oam + i * 4
      if (!touched.has(b + 2)) continue
      const attr = w[b + 3]!
      const hi = w[RAM.oamSize + i]!
      const x9 = w[b]! | ((hi & 1) << 8)
      parts.push({
        oam: i,
        char: w[b + 2]! | ((attr & 1) << 8),
        size: hi & 2 ? 16 : 8,
        palette: 8 + ((attr >> 1) & 7),
        priority: (attr >> 4) & 3,
        flipX: !!(attr & 0x40),
        flipY: !!(attr & 0x80),
        // Screen to map: add the camera back (16-bit, so a ring near the map's left or top edge is fine).
        dx: ((cam.x + x9) & 0xffff) - e.x,
        dy: ((cam.y + w[b + 1]!) & 0xffff) - e.y,
        attr,
        ox: x9,
        oy: w[b + 1]!,
      })
    }
    return { ok: true, parts, unverified }
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, reason: err.message }
    throw err
  }
}
