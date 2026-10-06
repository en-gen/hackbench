// The probe engine: SMW's own Mario-vs-layer-1 routine (README) run on the 65816 core over a synthetic level.
// Addresses are SMWDisX rammap/SMW_U.sym names; nothing here is copied from the ROM.
import type { Cpu65816 } from '../../src/rom/cpu/Cpu65816.ts'
import { callSubroutine, describe, Refusal } from '../../src/rom/cpu/call.ts'
import type { BusSnapshot, SpriteBus } from '../../src/rom/sprites/interp/SpriteBus.ts'
import { bytesAt, shapeMatches } from '../../src/rom/sprites/interp/Guards.ts'
import { smwMachine } from '../../src/rom/sprites/interp/Machine.ts'
import { loadLevelState } from '../../src/rom/sprites/interp/LevelLoader.ts'
import type { RomFile } from '../../src/rom/RomFile.ts'

const RAM = { xNext: 0x94, yNext: 0x96, xNow: 0xd1, yNow: 0xd3, xSpd: 0x7a, ySpd: 0x7c, air: 0x72, power: 0x19, duck: 0x73, dir: 0x76,
  blocked: 0x77, tAir: 0x8f, tGround: 0x8d, tScr: 0x8e, scr: 0x5b, scrLen: 0x5d, wall: 0x13e3, yoshi: 0x187a, carry: 0x148f,
  onGround: 0x13ef, layerProc: 0x1933, bluePs: 0x14ad, silverPs: 0x14ae, palaces: 0x1f27, palacePressed: 0x1423, noteBlk: 0x1402,
  onSprite: 0x1471, slopeType: 0x13e1, curSlope: 0x13ee, tileset: 0x1931, tileNo: 0x1693 }
const LOW = 0xc800 // Map16TilesLow $7E:C800, Map16TilesHigh $7F:C800 (rammap.asm:2114, 2138)
const ENTRY_RESET = 0x00eaa6, ENTRY_COLLIDE = 0x00eadb // SMWDisX bank_00.asm:11921, 11952
const BUDGET = 20000
/** The first opcodes each entry must start with (STZ abs, STZ dp ... / LDA dp, AND #$0F, STA dp; bank_00.asm:11921, 11952); null matches any operand. */
const ENTRY_SHAPES: { name: string; at: number; want: (number | null)[] }[] = [
  { name: 'CODE_00EAA6 (collision reset)', at: ENTRY_RESET, want: [0x9c, null, null, 0x64, null] },
  { name: 'CODE_00EADB (collision body)', at: ENTRY_COLLIDE, want: [0xa5, null, 0x29, 0x0f, 0x85] },
]
/** The first collision entry whose bytes differ from the shape the probe was written against, or null. */
export function collisionEntryProblem(rom: RomFile): string | null {
  for (const e of ENTRY_SHAPES)
    if (!shapeMatches(bytesAt(rom, e.at, e.want.length), e.want))
      return `${e.name} at $${e.at.toString(16).toUpperCase().padStart(6, '0')} is not the vanilla shape; the probe will not run it`
  return null
}
/** The synthetic cell the probed tile sits in, and its pixel origin (screen 0, 16 px cells). */
export const CELL = { col: 8, row: 8, px: 128, py: 128 }

export interface Setup { x: number; y: number; xSpd?: number; ySpd?: number; air?: number; power?: number; dir?: number; bluePs?: number; palaces?: number }
export interface Result { blocked: number; x: number; y: number; xSpd: number; ySpd: number; ground: number; slopeType: number; steps: number; tileNo: number }

export class Probe {
  readonly bus: SpriteBus
  private readonly cpu: Cpu65816
  private readonly base: BusSnapshot
  readonly tileset: number
  steps = 0
  constructor(rom: RomFile, map: number) {
    const problem = collisionEntryProblem(rom)
    if (problem) throw new Refusal(problem)
    const l = loadLevelState(rom, map)
    if (!l.ok) throw new Error('level load refused: ' + l.reason)
    const m = smwMachine(rom, l.wram)
    this.bus = m.bus
    this.cpu = m.cpu
    this.base = this.bus.snapshot()
    this.tileset = this.base.wram[RAM.tileset]!
  }
  private w(a: number, v: number) { this.bus.write(a, v) }
  private w16(a: number, v: number) { this.w(a, v & 255); this.w(a + 1, (v >> 8) & 255) }
  private call(entry: number) {
    // P=$30 (IRQ flag clear), the state the collision body was probed under.
    const r = callSubroutine(this.cpu, entry, { kind: 'jsr', maxSteps: BUDGET, regs: { p: 0x30 } })
    this.steps += r.steps
    if (r.kind !== 'returned') throw new Refusal(describe(r, BUDGET)!)
  }
  /** One collision pass for Mario at (x,y) over a level of air with `tile` (9-bit Map16 id) in CELL; throws Refusal on budget/escape. */
  run(tile: number, s: Setup): Result {
    this.bus.restore(this.base)
    const b = this.bus
    const set = (c: number, r: number, id: number) => {
      const off = LOW + (r & 15) * 16 + c; this.w(0x7e0000 + off, id & 255); this.w(0x7f0000 + off, id >> 8)
    }
    for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) set(c, r, 0x25) // air; screen 0 rows 0-15 (CODE_00F465 horizontal layout)
    set(CELL.col, CELL.row, tile)
    this.w(RAM.scr, 0); this.w(RAM.scrLen, 3)
    // assumed state (README): small, P-switches and palaces off, nothing carried/ridden/wallrunning
    this.w(RAM.power, s.power ?? 0); this.w(RAM.duck, 0); this.w(RAM.wall, 0); this.w(RAM.yoshi, 0); this.w(RAM.carry, 0)
    this.w(RAM.bluePs, s.bluePs ?? 0); this.w(RAM.silverPs, 0); this.w(RAM.noteBlk, 0); this.w(RAM.onSprite, 0)
    for (let i = 0; i < 4; i++) this.w(RAM.palaces + i, (s.palaces ?? 0) >> i & 1)
    this.w16(RAM.xNext, s.x); this.w16(RAM.yNext, s.y); this.w16(RAM.xNow, s.x); this.w16(RAM.yNow, s.y)
    this.w16(RAM.xSpd, s.xSpd ?? 0); this.w16(RAM.ySpd, s.ySpd ?? 0)
    this.w(0x71, 0) // PlayerAnimation: a loaded entrance (pipe, door) leaves it set, which would read as 'hurt' on every tile
    this.w(0x13, 1) // TrueFrame: the conveyor slopes ($CE-$D1, CODE_00EFCD) shove Mario only when it is a multiple of 4
    this.w(RAM.air, s.air ?? 0x24); this.w(RAM.dir, s.dir ?? 0); this.w(RAM.onGround, 0)
    // CODE_00E92B's setup for layer 1 of a horizontal level (bank_00.asm:11723-11768), then the collision body.
    this.call(ENTRY_RESET)
    this.w(RAM.tGround, 0); this.w(RAM.tAir, b.wram[RAM.air]!); this.w(RAM.tScr, 0); this.w(RAM.layerProc, 0)
    this.call(ENTRY_COLLIDE)
    const g = (a: number) => b.wram[a]!, g16 = (a: number) => g(a) | (g(a + 1) << 8)
    const sg = (v: number) => (v & 0x8000 ? v - 0x10000 : v)
    return { blocked: g(RAM.blocked), x: g16(RAM.xNext), y: g16(RAM.yNext), xSpd: g(RAM.xSpd + 1), ySpd: g(RAM.ySpd + 1), ground: g(RAM.onGround), slopeType: g(RAM.slopeType), steps: this.steps, tileNo: sg(g16(RAM.tileNo)) & 0xff }
  }
}

export interface TileProbe {
  /** Surface depth below the cell top per pixel column, null where Mario falls through. */
  floor: (number | null)[]
  /** Depth of the underside below the cell top per column, null where Mario passes up through. */
  ceil: (number | null)[]
  wallL: boolean
  wallR: boolean
  /** $71 PlayerAnimation was set by some run: the tile hurts or kills. */
  hurt: boolean
  /** Columns where Mario landed ABOVE the cell top (a quirk of the signed slope heights on ceiling-slope halves); treated as no floor. */
  above: number
  /** Why the tile cannot be classified: a run threw, spent its budget or left ROM. */
  unknown?: string
  /** WRAM offsets read before anything wrote them, over every run of this tile. */
  inputs: number[]
}
// Mario's small-form reference points, measured from the first contact rather than assumed: the foot lands when YPosNext = surface - 32
// and the head hits when YPosNext + 17 passes the underside (calibration table in the README).
const FOOT = 32, HEAD = 17
const BODY_DY = [-24, -20, -16, -12]
/** Everything one tile does to Mario in `state`, by sweeping him toward it from above, below, left and right a pixel at a time. */
export function measureTile(p: Probe, tile: number, state: Partial<Setup> = {}): TileProbe {
  const out: TileProbe = { floor: [], ceil: [], wallL: false, wallR: false, hurt: false, above: 0, inputs: [] }
  const ins = new Set<number>()
  p.bus.inputs = ins
  const run = (s: Setup) => { const r = p.run(tile, { ...state, ...s }); if (p.bus.wram[0x71]) out.hurt = true; return r }
  try {
    for (let c = 0; c < 16; c++) {
      const x = CELL.px + c - 8
      let f: number | null = null, landed = false
      for (let dy = -40; dy <= 8 && !landed; dy++) {
        const r = run({ x, y: CELL.py + dy, ySpd: 0x1000 })
        // A tile that kills small Mario on touch never reaches the landing flag: HurtMario leaves Y speed negative and
        // CODE_00EE85 returns early (bank_00.asm:12482-12488). Its first contact is the surface, as for a landing,
        // because contact starts at the same foot offset (the sweep steps 1 px, so no snap is lost).
        const killed = p.bus.wram[0x71] !== 0
        if ((r.blocked & 4 && r.ground) || killed) { landed = true; const d = (killed ? dy : r.y - CELL.py) + FOOT; if (d < 0) out.above++; else f = d }
      }
      out.floor.push(f)
      let cl: number | null = null
      for (let dy = 24; dy >= -24 && cl === null; dy--) { const r = run({ x, y: CELL.py + dy, ySpd: -0x1000 }); if (r.blocked & 8 || r.ySpd === 0) cl = dy + HEAD }
      out.ceil.push(cl)
    }
    for (const dy of BODY_DY) {
      for (let dx = -28; dx <= 0 && !out.wallL; dx++) if (run({ x: CELL.px + dx, y: CELL.py + dy, xSpd: 0x1000, dir: 1, ySpd: 0 }).blocked & 3) out.wallL = true
      for (let dx = 28; dx >= 0 && !out.wallR; dx--) if (run({ x: CELL.px + dx, y: CELL.py + dy, xSpd: -0x1000, dir: 0, ySpd: 0 }).blocked & 3) out.wallR = true
    }
  } catch (e) {
    if (!(e instanceof Refusal)) throw e
    out.unknown = e.message
  }
  p.bus.inputs = null
  out.inputs = [...ins].sort((a, b) => a - b)
  return out
}
