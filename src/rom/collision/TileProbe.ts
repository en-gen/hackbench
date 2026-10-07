/**
 * TileProbe.ts -- what one Map16 tile does to Mario, found by running SMW's own
 * layer-1 block collision on the 65816 core over a synthetic level of air
 * (en-gen/hackbench#435; method, evidence and findings in
 * spikes/collision-probe/README.md). No shell imports.
 *
 * The routine is CODE_00EADB (SMWDisX bank_00.asm:11952), entered after the
 * per-frame reset CODE_00EAA6 (bank_00.asm:11921), with the setup between them
 * that CODE_00E92B does for layer 1 of a horizontal level (bank_00.asm:11723-11768).
 * Addresses below are SMWDisX rammap names; nothing is copied from the ROM.
 *
 * Evidence scope: vanilla US ROM, tilesets 7, 3 and 1, small Mario with the
 * silver P-switch off, palaces and blue P-switch as `ProbeState` says (only the all-off state was
 * compared with the spike's signed-off output), one machine; not compared with an emulator.
 */
import type { Cpu65816 } from '../cpu/Cpu65816'
import { callSubroutine, describe, Refusal } from '../cpu/call'
import type { RomFile } from '../RomFile'
import { SWITCH_BLOCK_ORDER } from '../objectHandlers/cursor'
import type { SpriteBus } from '../sprites/interp/SpriteBus'
import { smwMachine } from '../sprites/interp/Machine'
import { loadLevelState } from '../sprites/interp/LevelLoader'

const RAM = {
  xNext: 0x94, yNext: 0x96, xNow: 0xd1, yNow: 0xd3, xSpd: 0x7a, ySpd: 0x7c, air: 0x72, power: 0x19,
  duck: 0x73, dir: 0x76, blocked: 0x77, tAir: 0x8f, tGround: 0x8d, tScr: 0x8e, scr: 0x5b,
  scrLen: 0x5d, wall: 0x13e3, yoshi: 0x187a, carry: 0x148f, onGround: 0x13ef, layerProc: 0x1933,
  bluePs: 0x14ad, silverPs: 0x14ae, palaces: 0x1f27, noteBlk: 0x1402, onSprite: 0x1471,
  tileset: 0x1931, animation: 0x71, trueFrame: 0x13,
} // prettier-ignore
/** Map16TilesLow $7E:C800 and Map16TilesHigh $7F:C800 (rammap.asm:2114, 2138). */
const LOW = 0xc800
const ENTRY_RESET = 0x00eaa6
const ENTRY_COLLIDE = 0x00eadb
/** Instructions one call may spend; the routine needs a few hundred. */
const BUDGET = 20000
const AIR = 0x25
const CELL_AT = 8 * 16 + 8
/** WRAM offsets of the probed cell's low and high Map16 bytes. */
const CELL_LOW = LOW + CELL_AT
const CELL_HIGH = 0x10000 + LOW + CELL_AT
/** The synthetic cell the probed tile sits in, and its pixel origin (screen 0, 16 px cells). */
export const CELL = { col: 8, row: 8, px: 128, py: 128 }
/**
 * The game state a probe runs in, on top of the fixed small Mario with the silver P-switch off (not modelled):
 * the four switch palaces and the blue P-switch. Part of every cache key.
 */
export interface ProbeState {
  flags: { green: boolean; yellow: boolean; blue: boolean; red: boolean }
  bluePs: boolean
}
export const NEUTRAL: ProbeState = { flags: { green: false, yellow: false, blue: false, red: false }, bluePs: false } // prettier-ignore
const PALACE_ORDER = SWITCH_BLOCK_ORDER
export const stateKey = (s: ProbeState): string =>
  PALACE_ORDER.map(k => +s.flags[k]).join('') + `:${+s.bluePs}`

interface Setup {
  x: number
  y: number
  xSpd?: number
  ySpd?: number
  dir?: number
}
interface Result {
  blocked: number
  y: number
  ySpd: number
  ground: number
  /** $71 PlayerAnimation was set: the tile hurts or kills. */
  hurt: boolean
  /** The routine read the probed cell's Map16 bytes (only tracked when asked). */
  touched: boolean
}

/** Mario's reference points against a flat block, read from the first contact, never assumed. */
/**
 * What a result was computed from, besides the tile: the ROM bytes its runs read (flat sorted `[start, end)`
 * pairs of buffer indexes) and the seed WRAM bytes it read before writing them, with the values it saw.
 * The seed level's own data is not listed unless a run read it, so a level-data edit invalidates nothing here.
 */
export interface Deps {
  rom: number[]
  wram: [offset: number, value: number][]
}

export interface Calibration {
  /** Landing: Mario's Y (cell-relative) when his feet meet a surface at the cell top, negated. */
  foot: number
  /** Head hit: Y + head is the underside's depth when his head first meets it. */
  head: number
}

/** The tile whose flat top and underside calibrate the offsets (the brown block, Map16 $130). */
const CALIBRATION_TILE = 0x130

export class Probe {
  private readonly bus: SpriteBus
  private readonly cpu: Cpu65816
  private readonly base: Uint8Array
  private readonly dirty: number[] = []
  private readonly reads = new Set<number>()
  private wramDeps: Set<number> | null = null
  private romSeenBuf: Uint8Array | null = null
  private readonly romLen: number
  readonly tileset: number
  steps = 0
  /** TrueFrame ($13) every run uses; 1 keeps the conveyor slopes from shoving Mario. A test seam otherwise. */
  trueFrame = 1
  /** The palaces and blue P-switch every run is set up with; see `ProbeState`. */
  state: ProbeState = NEUTRAL

  /**
   * Throws `Error` when the ROM's own level loader refuses (the message is the reason). `loaded` is a WRAM
   * image already made, so a test can run the routine without the loader's vanilla shape.
   */
  constructor(rom: RomFile, level: number, loaded?: Uint8Array) {
    if (loaded) this.base = loaded.slice()
    else {
      const l = loadLevelState(rom, level)
      if (!l.ok) throw new Error(l.reason)
      this.base = l.wram.slice()
    }
    // The level of air is the same for every run, so it is laid down once, in the base image.
    for (let i = 0; i < 256; i++) {
      this.base[LOW + i] = AIR
      this.base[0x10000 + LOW + i] = 0
    }
    // The shared machine: a CPU over the sprite bus with the ROM guard (BRK, leaving ROM) installed.
    const { bus, cpu } = smwMachine(rom, this.base)
    this.bus = bus
    this.cpu = cpu
    this.romLen = rom.buffer.length
    this.bus.onWramWrite = o => this.dirty.push(o)
    this.tileset = this.base[RAM.tileset]!
  }

  /** Starts listing the ROM and seed-WRAM bytes the runs read, until `takeDeps`. */
  startDeps(): void {
    this.bus.romSeen = this.romSeenBuf ??= new Uint8Array(this.romLen) // cleared by `takeDeps`, so reused
    this.bus.romList = []
    this.wramDeps = new Set()
  }

  takeDeps(): Deps {
    const { romSeen, romList } = this.bus
    const idx = [...romList].sort((a, b) => a - b)
    const rom: number[] = []
    for (const i of idx) {
      if (rom.length && rom[rom.length - 1] === i) rom[rom.length - 1] = i + 1
      else rom.push(i, i + 1)
      romSeen![i] = 0
    }
    const wram = [...this.wramDeps!].sort((a, b) => a - b).map((o): [number, number] => [o, this.base[o]!]) // prettier-ignore
    this.bus.romSeen = null
    this.wramDeps = null
    return { rom, wram }
  }

  /** The seed image's byte, to check a dependency against a newly loaded seed. */
  seed(offset: number): number {
    return this.base[offset]!
  }

  private w(a: number, v: number): void {
    this.bus.write(a, v)
  }
  private w16(a: number, v: number): void {
    this.w(a, v & 255)
    this.w(a + 1, (v >> 8) & 255)
  }

  /** Runs a routine to its return; throws `Refusal` when the budget is spent or the code leaves ROM. */
  private call(entry: number): void {
    const r = callSubroutine(this.cpu, entry, { kind: 'jsr', maxSteps: BUDGET })
    this.steps += r.steps
    const why = describe(r, BUDGET)
    if (why !== null) throw new Refusal(why)
  }

  /**
   * One collision pass for Mario at (x, y) over a level of air with `tile` (9-bit id) in CELL. With `track`,
   * `touched` says whether the routine read the cell's bytes; a run that did not is the same for every tile.
   */
  run(tile: number, s: Setup, track = false): Result {
    const tracking = track || this.wramDeps !== null
    // Forget what earlier runs wrote, THEN let this run's setup stores mark their bytes: a byte read
    // after that is an input of the seed, not of the probe's own setup.
    if (tracking) this.bus.clearWritten()
    // Restores every WRAM byte the last run changed.
    const wram = this.bus.wram
    for (const o of this.dirty) wram[o] = this.base[o]!
    this.dirty.length = 0
    // Direct stores, not bus writes: the bus must not count the cell as written, or its reads go unseen.
    wram[CELL_LOW] = tile & 255
    wram[CELL_HIGH] = tile >> 8
    this.w(RAM.scr, 0)
    this.w(RAM.scrLen, 3)
    // Assumed state: small Mario, P-switches and palaces off, nothing carried, ridden or wall-running.
    for (const a of [RAM.power, RAM.duck, RAM.wall, RAM.yoshi, RAM.carry, RAM.bluePs, RAM.silverPs, RAM.noteBlk, RAM.onSprite, RAM.onGround]) this.w(a, 0) // prettier-ignore
    PALACE_ORDER.forEach((k, i) => this.w(RAM.palaces + i, +this.state.flags[k]))
    this.w(RAM.bluePs, this.state.bluePs ? 0x80 : 0)
    this.w16(RAM.xNext, s.x)
    this.w16(RAM.yNext, s.y)
    this.w16(RAM.xNow, s.x)
    this.w16(RAM.yNow, s.y)
    this.w16(RAM.xSpd, s.xSpd ?? 0)
    this.w16(RAM.ySpd, s.ySpd ?? 0)
    // PlayerAnimation: a loaded entrance (pipe, door) leaves it set, which would read as 'hurt' on every tile.
    this.w(RAM.animation, 0)
    // TrueFrame: the conveyor slopes ($1CE-$1D1, CODE_00EFCD) shove Mario only when it is a multiple of 4.
    this.w(RAM.trueFrame, this.trueFrame)
    this.w(RAM.air, 0x24)
    this.w(RAM.dir, s.dir ?? 0)
    this.reads.clear()
    // A byte an earlier run wrote (a coin collected rewrites the cell) would otherwise never be seen as read.
    // (the `written` flags were cleared at the top of the run, so this run's own setup stores count as writes)
    this.bus.inputs = tracking ? this.reads : null
    // Each run starts from the same machine: no multiplier result or register left over from the last tile.
    this.bus.resetUnits()
    this.cpu.a = this.cpu.x = this.cpu.y = 0
    this.call(ENTRY_RESET)
    this.w(RAM.tGround, 0)
    this.w(RAM.tAir, wram[RAM.air]!)
    this.w(RAM.tScr, 0)
    this.w(RAM.layerProc, 0)
    this.call(ENTRY_COLLIDE)
    this.bus.inputs = null
    if (this.wramDeps) for (const o of this.reads) if (o !== CELL_LOW && o !== CELL_HIGH) this.wramDeps.add(o) // prettier-ignore
    return {
      blocked: wram[RAM.blocked]!,
      y: wram[RAM.yNext]! | (wram[RAM.yNext + 1]! << 8),
      // The routine zeroes Y speed to bonk (the turn block), so it is read as well as `blocked`.
      ySpd: wram[RAM.ySpd + 1]!,
      ground: wram[RAM.onGround]!,
      hurt: wram[RAM.animation] !== 0,
      touched: track && (this.reads.has(CELL_LOW) || this.reads.has(CELL_HIGH)),
    }
  }
}

export interface TileProbe {
  /** Surface depth below the cell top per pixel column, null where Mario falls through. */
  floor: (number | null)[]
  /** Depth of the underside below the cell top per column, null where Mario passes up through. */
  ceil: (number | null)[]
  /** Blocks Mario moving right (a wall on the tile's left edge) / moving left (right edge). */
  wallL: boolean
  wallR: boolean
  /** $71 was set by some run: the tile hurts or kills. */
  hurt: boolean
  /** Why the tile cannot be classified: a run threw, spent its budget or left ROM. */
  unknown?: string
}

/**
 * What the sweeps found over a level of air, per Mario position. A position
 * whose run never read the probed cell is the same for every tile (the
 * routine is deterministic and everything else is equal), so a tile's sweep
 * takes its answer from here and runs only the positions that reach the cell.
 */
export type AirRuns = Map<string, Result>

const BODY_DY = [-24, -20, -16, -12]
const keyOf = (s: Setup): string => `${s.x},${s.y},${s.xSpd ?? 0},${s.ySpd ?? 0},${s.dir ?? 0}`

/**
 * A sweep of one flat block from above and below fixes Mario's foot and head
 * offsets; throws `Refusal` when it finds no surface (a hack that changed the
 * calibration block, or the routine did not run).
 */
export function calibrate(p: Probe): Calibration {
  const x = CELL.px
  let foot: number | null = null
  for (let dy = -40; dy <= 8 && foot === null; dy++) {
    const r = p.run(CALIBRATION_TILE, { x, y: CELL.py + dy, ySpd: 0x1000 })
    if (r.blocked & 4 && r.ground) foot = CELL.py - r.y
  }
  let head: number | null = null
  for (let dy = 24; dy >= -24 && head === null; dy--) {
    const r = p.run(CALIBRATION_TILE, { x, y: CELL.py + dy, ySpd: -0x1000 })
    if (r.blocked & 8 || r.ySpd === 0) head = 16 - dy
  }
  if (foot === null || head === null)
    throw new Refusal(`calibration block $${CALIBRATION_TILE.toString(16)} gave no surface`)
  return { foot, head }
}

/** The sweeps, from above, below, left and right a pixel at a time; `run` answers each position. */
function sweep(run: (s: Setup) => Result, cal: Calibration): TileProbe {
  const out: TileProbe = { floor: [], ceil: [], wallL: false, wallR: false, hurt: false }
  const note = (s: Setup): Result => {
    const r = run(s)
    if (r.hurt) out.hurt = true
    return r
  }
  for (let c = 0; c < 16; c++) {
    const x = CELL.px + c - 8
    let f: number | null = null
    let landed = false
    for (let dy = -40; dy <= 8 && !landed; dy++) {
      const r = note({ x, y: CELL.py + dy, ySpd: 0x1000 })
      // A tile that kills small Mario on touch never reaches the landing flag: HurtMario leaves Y speed
      // negative and CODE_00EE85 returns early (bank_00.asm:12482-12488). Its first contact is the surface,
      // at the same foot offset (the sweep steps 1 px, so no snap is lost).
      if ((r.blocked & 4 && r.ground) || r.hurt) {
        landed = true
        const d = (r.hurt ? dy : r.y - CELL.py) + cal.foot
        // A landing ABOVE the cell top (signed slope heights on ceiling-slope halves) is no floor.
        if (d >= 0) f = d
      }
    }
    out.floor.push(f)
    let cl: number | null = null
    for (let dy = 24; dy >= -24 && cl === null; dy--) {
      const r = note({ x, y: CELL.py + dy, ySpd: -0x1000 })
      if (r.blocked & 8 || r.ySpd === 0) cl = dy + cal.head
    }
    out.ceil.push(cl)
  }
  for (const dy of BODY_DY) {
    for (let dx = -28; dx <= 0 && !out.wallL; dx++)
      if (note({ x: CELL.px + dx, y: CELL.py + dy, xSpd: 0x1000, dir: 1, ySpd: 0 }).blocked & 3) out.wallL = true // prettier-ignore
    for (let dx = 28; dx >= 0 && !out.wallR; dx--)
      if (note({ x: CELL.px + dx, y: CELL.py + dy, xSpd: -0x1000, dir: 0, ySpd: 0 }).blocked & 3) out.wallR = true // prettier-ignore
  }
  return out
}

/** Every position the sweeps visit over a level of air, with whether it reached the cell. Throws `Refusal`. */
export function probeAir(p: Probe): AirRuns {
  const air: AirRuns = new Map()
  sweep(
    s => {
      const r = p.run(AIR, s, true)
      air.set(keyOf(s), r)
      return r
    },
    { foot: 0, head: 0 },
  )
  // Every tile would read as air: refuse rather than draw an empty overlay.
  if (![...air.values()].some(r => r.touched)) throw new Refusal('no probe position reached the tile cell') // prettier-ignore
  return air
}

/** Everything one tile does to Mario in this level; a run that throws or leaves ROM makes it `unknown`. */
export function measureTile(p: Probe, tile: number, cal: Calibration, air?: AirRuns): TileProbe {
  const run = (s: Setup): Result => {
    const a = air?.get(keyOf(s))
    return a && !a.touched ? a : p.run(tile, s)
  }
  try {
    return sweep(run, cal)
  } catch (e) {
    if (!(e instanceof Refusal)) throw e
    return { floor: [], ceil: [], wallL: false, wallR: false, hurt: false, unknown: e.message }
  }
}
