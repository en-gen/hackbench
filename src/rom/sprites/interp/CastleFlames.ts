/**
 * CastleFlames.ts -- the candle flames sprite $E6 puts on Layer 2, drawn by the
 * ROM's own cluster code run on the core (#894). No position, tile or attribute
 * is written here: the spawn routine and the draw routine make them.
 *
 * - Spawn: CODE_02AA6C (SMWDisX bank_02.asm:5576-5592), reached from
 *   CODE_02AAC0 on id $E6 (bank_02.asm:5631-5637): four cluster sprites of type 5.
 * - Draw: CODE_02FA16 (bank_02.asm:16230-16280), the cluster dispatch's type 5
 *   entry (dw table after the JSL at CODE_02F821, bank_02.asm:15962-15972). It
 *   draws each flame at its position minus Layer2XPos/Layer2YPos, so with both at
 *   zero the OAM position IS the flame's Layer 2 position, wrapped to a byte.
 *
 * SpriteLock ($9D) is set for the draw: the routine then skips its random
 * flicker step (bank_02.asm:16231-16232) and shows the first frame, which is the
 * map view's frame policy. A flame's Y is $F0 in Layer 2 space; the sprite loop's
 * "offscreen" fill (Y = $F0) is not applied, so it is not mistaken for one.
 *
 * Evidence scope: vanilla USA ROM, map $01F and the other maps with $E6, one run
 * each (docs/sprites/sprite-e6-castle-flames.md). A ROM whose routines differ in
 * any byte is refused with a reason (SHA-256 of each routine).
 */
import { callSubroutine, describe, Refusal } from '../../cpu/call'
import { spanFingerprint } from '../../SubmapFlagGate'
import type { RomFile } from '../../RomFile'
import { bytesAt, shapeMatches } from './Guards'
import { smwMachine } from './Machine'
import { checkGetRand } from './SpriteDispatch'
import { RAM, type SpritePart } from './SpriteRunner'
import { levelSeed } from './LevelLoader'
import type { SpriteSeed } from './SpriteSeed'

const SPAWN = 0x02aa6c
const DRAW = 0x02fa16
/** The cluster dispatch's type-5 entry (6th dw of the table at $02:F825) and the $E6 branch to the spawn. */
const DISPATCH_TYPE5 = { at: 0x02f82f, want: [0x16, 0xfa] }
const E6_BRANCH = { at: 0x02aac9, want: [0xc9, 0xe6, 0xf0, 0x9f] } // CMP #$E6 / BEQ CODE_02AA6C

/** SHA-256 of the whole routine (33 and 110 bytes, ending in RTS); the data tables they read are NOT part of it. */
export interface FlameRoutines {
  spawn: string
  draw: string
}
export const VANILLA_FLAME_ROUTINES: FlameRoutines = {
  spawn: '53bb50d4f6e9d3227864671530ed91f48d30d45cf86ca293fe26db047437fc36',
  draw: 'ac4cb045da54628d8e0bae9ea55d73d460b18c8514dba7ba6c4028c320bfe6b8',
}

const CLUSTER_NUMBER = 0x1892
const CLUSTER_SLOTS = 4
const LAYER2_POS = 0x1e
const SPRITE_LOCK = 0x9d

export type FlamesResult = { ok: true; parts: SpritePart[] } | { ok: false; reason: string }

/**
 * The flames as OAM parts in Layer 2 space (`ox`/`oy`, and `dx`/`dy` equal to them), for the level
 * `seed` belongs to. `seed` is `levelSeed`'s: its loaded image is the level's state, and its
 * cluster numbers stay cleared for every other sprite's run (#809); only these runs set them.
 */
export function castleFlames(
  rom: RomFile,
  seed: SpriteSeed,
  routines: FlameRoutines = VANILLA_FLAME_ROUTINES,
): FlamesResult {
  if (!seed.loaded) return { ok: false, reason: seed.loadRefusal ?? 'no level image' }
  const bad = (what: string) => ({ ok: false as const, reason: `${what} is not the vanilla shape; the flames are not drawn` }) // prettier-ignore
  if (!shapeMatches(bytesAt(rom, E6_BRANCH.at, 4), E6_BRANCH.want)) return bad('the $E6 branch to the flame spawn') // prettier-ignore
  if (!shapeMatches(bytesAt(rom, DISPATCH_TYPE5.at, 2), DISPATCH_TYPE5.want)) return bad('the cluster dispatch entry for type 5') // prettier-ignore
  const sha = (at: number, n: number) => spanFingerprint(Uint8Array.from(bytesAt(rom, at, n) ?? []))
  if (sha(SPAWN, 33) !== routines.spawn) return bad('the flame spawn routine')
  if (sha(DRAW, 110) !== routines.draw) return bad('the flame draw routine')
  const rand = checkGetRand(rom)
  if (!rand.ok) return { ok: false, reason: rand.reason }
  try {
    const { bus, cpu } = smwMachine(rom, seed.loaded)
    const w = bus.wram
    for (const [k, v] of Object.entries(seed.ram)) w[Number(k)] = v
    w.fill(0, LAYER2_POS, LAYER2_POS + 4)
    w[SPRITE_LOCK] = 1
    const touched = new Set<number>()
    bus.onWramWrite = off => touched.add(off)
    // The game enters both from bank 2 (PHK PLB in the cluster loop), so its tables read through DB = 2.
    const run = (entry: number, x?: number) => {
      const r = callSubroutine(cpu, entry, { kind: 'jsr', maxSteps: 20_000, regs: { db: 2, ...(x === undefined ? {} : { x }) } }) // prettier-ignore
      if (r.kind !== 'returned') throw new Refusal(describe(r, 20_000)!)
    }
    run(SPAWN)
    for (let x = 0; x < CLUSTER_SLOTS; x++) {
      if (w[CLUSTER_NUMBER + x] !== 5) continue
      run(DRAW, x)
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
        dx: x9,
        dy: w[b + 1]!,
        attr,
        ox: x9,
        oy: w[b + 1]!,
      })
    }
    return { ok: true, parts }
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.message }
    throw e
  }
}

/** The flames of `level`, from the ROM's own level state. */
export const castleFlamesOf = (rom: RomFile, level: number): FlamesResult =>
  castleFlames(rom, levelSeed(rom, level))
