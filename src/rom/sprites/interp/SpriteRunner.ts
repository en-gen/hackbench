/**
 * SpriteRunner.ts -- runs one sprite's own INIT and MAIN from the ROM on the
 * 65816 core and emits the v1 model: anchor after INIT, per-pass OAM parts,
 * a refusal or empty reason, and `dependsOn` found by a two-run diff.
 *
 * Nothing here knows a sprite id. Placement and drawing are whatever the
 * cart's bytes do; the only inputs are the seed (SpriteSeed.ts) and the ROM.
 * See docs/ideas/sprite-gfx-interpreter.md for measurements.
 */
import { Cpu65816 } from '../../cpu/Cpu65816'
import type { RomFile } from '../../RomFile'
import { guardInstruction, Refusal } from './Guards'
import {
  checkGetRand,
  checkInitTables,
  ENTRY,
  resolveLoop,
  resolvePointer,
  resolveTables,
} from './SpriteDispatch'
import { SpriteBus } from './SpriteBus'
import { SPRITE_SEED, withSeed, type SpriteSeed } from './SpriteSeed'

/** SMWDisX rammap.asm names, offsets into WRAM. */
export const RAM = {
  trueFrame: 0x13,
  effFrame: 0x14,
  camX: 0x1a,
  camY: 0x1c,
  screenMode: 0x5b,
  levelScreens: 0x5d,
  spriteProps: 0x64,
  water: 0x85,
  slippery: 0x86,
  slopes: 0x82,
  buoyancy: 0x190e,
  spriteMemory: 0x1692,
  rng: 0x148b,
  marioDir: 0x76,
  marioXNext: 0x94,
  marioYNext: 0x96,
  marioXNow: 0xd1,
  marioYNow: 0xd3,
  spriteNumber: 0x9e,
  spriteYLow: 0xd8,
  spriteXLow: 0xe4,
  status: 0x14c8,
  yHigh: 0x14d4,
  xHigh: 0x14e0,
  curSprite: 0x15e9,
  oamIndex: 0x15ea,
  /** $0681 DynPaletteIndex: bytes used in the NMI colour-upload list at $0682 (rammap.asm:1152-1164). */
  dynPaletteIndex: 0x681,
  dynPaletteTable: 0x682,
  /** $0703 MainPalette: a RAM copy of all 256 CGRAM colors (rammap.asm:1172-1175). */
  mainPalette: 0x703,
  /** OAM mirror $0200-$03FF: 128 entries of 4 bytes; one size byte per entry at $0420. */
  oam: 0x200,
  oamSize: 0x420,
  oamEntries: 128,
} as const

/** Instruction budget for one call (INIT or one MAIN pass). */
const STEP_BUDGET = 200_000
/** INIT retries allowed while the routine leaves status 1. */
const MAX_INIT_FRAMES = 64
/** Return address pushed under each call; the call is done when it is popped. */
const SENTINEL = 0xff00

export interface SpritePart {
  /** Entry in the OAM mirror, 0-127 ($0200 page first, then $0300). */
  oam: number
  /** 9-bit tile number: tile byte plus the attribute's name-table bit. */
  char: number
  size: 8 | 16
  /** CGRAM sprite row 8-15, from the attribute the cart wrote. */
  palette: number
  priority: number
  flipX: boolean
  flipY: boolean
  /** Pixels from the post-INIT sprite position. */
  dx: number
  dy: number
  /** Raw attribute byte, for graders that compare it whole. */
  attr: number
  /** Raw OAM position: X is 9 bits (size-table bit 0 is bit 8), Y is the line. */
  ox: number
  oy: number
}

/** One CGRAM color a run set: index 0-255 (row * 16 + column) and its BGR555 value. */
export interface PaletteWrite {
  index: number
  bgr555: number
}

export interface PassResult {
  pass: number
  /** Level position of the sprite at the end of this pass. */
  pos: { x: number; y: number }
  parts: SpritePart[]
  /** Palette or graphics uploads the pass wrote registers for. */
  uploads: string[]
  /**
   * CGRAM colors the run has set by the end of this pass (cumulative from the
   * start of INIT), in application order. See `Machine.paletteWrites`.
   */
  palette: PaletteWrite[]
}

export type DependsOn = 'marioX'

export interface SpriteModel {
  id: number
  /** Why nothing was emitted: the run was refused. */
  refusal?: string
  /** Why no part was drawn across all passes, when the run completed. */
  emptyReason?: string
  /** Position after INIT, and the raw placement it started from. */
  anchor?: { x: number; y: number; rawX: number; rawY: number }
  /** Frames INIT took: 1 unless it left status 1 and was re-run. */
  initFrames?: number
  /** $15EA after INIT: the OAM base the cart assigned. */
  oamBase?: number
  passes: PassResult[]
  /**
   * The frame policy: index of the first pass at or after INIT that draws at
   * least one tile (within the pass cap), absent when none does. A policy, not
   * a claim about which frame a map should show.
   */
  chosen?: number
  dependsOn: DependsOn[]
  /** Instruction counts: INIT, then each MAIN pass. */
  steps: number[]
  /** WRAM offsets read before anything wrote them, when `RunOptions.trackInputs` is set. */
  inputs?: number[]
}

export interface RunOptions {
  probe?: Probe
  trackInputs?: boolean
}

export { Refusal }

export class Machine {
  readonly bus: SpriteBus
  readonly cpu: Cpu65816
  private touched = new Set<number>()
  /** Cumulative: MainPalette bytes written, and direct $2121/$2122 colors in write order. */
  private palTouched = new Set<number>()
  private direct: PaletteWrite[] = []
  private cgadd = 0
  private cgLow: number | null = null
  /** $0681 when the run began: entries the loader left in the upload list are not this sprite's. */
  private dynStart = 0
  steps = 0

  constructor(
    rom: RomFile,
    readonly seed: SpriteSeed,
    id: number,
  ) {
    this.bus = new SpriteBus(rom)
    this.cpu = new Cpu65816(this.bus)
    const cpu = this.cpu
    cpu.e = false
    cpu.p = 0x34 // native, 8-bit M and X, IRQ off
    cpu.s = 0x1ff
    cpu.d = 0
    cpu.db = 0
    this.bus.onInstruction = guardInstruction
    this.bus.onWramWrite = off => {
      this.touched.add(off)
      if (off >= RAM.mainPalette && off < RAM.mainPalette + 512) this.palTouched.add(off)
    }
    this.bus.onHwWrite = (reg, v) => {
      if (reg === 0x2121) {
        this.cgadd = v
        this.cgLow = null
      } else if (reg === 0x2122) {
        if (this.cgLow === null) this.cgLow = v
        else {
          this.direct.push({ index: this.cgadd, bgr555: ((v << 8) | this.cgLow) & 0x7fff })
          this.cgadd = (this.cgadd + 1) & 0xff
          this.cgLow = null
        }
      }
    }
    this.load(id)
    this.dynStart = this.bus.wram[RAM.dynPaletteIndex]
  }

  /**
   * CGRAM colors this run has set so far, three routes in this order (a later
   * route wins a color): (1) the NMI upload list at $0682, entries
   * `[bytes, CGRAM color index, colors...]` ended by a zero count, read from
   * where the run began (CODE_00A488, SMWDisX bank_00.asm:4714-4735, the
   * table `DynPaletteTable` of rammap.asm:1157-1164; no NMI runs here, so
   * entries pile up and a later one for the same index wins, as it would
   * after the earlier upload); (2) MainPalette colors whose BOTH bytes the run
   * wrote (a half-written color has no known other half); (3) direct
   * $2121/$2122 writes. Hardware's own consumption of (2) is the
   * whole-CGRAM upload of PaletteIndexTable 6 (bank_00.asm:4710).
   */
  paletteWrites(): PaletteWrite[] {
    const w = this.bus.wram
    const out: PaletteWrite[] = []
    let at = RAM.dynPaletteTable + this.dynStart
    while (at < RAM.dynPaletteTable + 0x7f && w[at] !== 0) {
      const n = w[at] & ~1
      const first = w[at + 1]
      for (let i = 0; i < n / 2 && first + i < 256; i++)
        out.push({
          index: first + i,
          bgr555: (w[at + 2 + i * 2] | (w[at + 3 + i * 2] << 8)) & 0x7fff,
        })
      at += 2 + w[at]
    }
    for (let i = 0; i < 256; i++) {
      const b = RAM.mainPalette + i * 2
      if (this.palTouched.has(b) && this.palTouched.has(b + 1))
        out.push({ index: i, bgr555: (w[b] | (w[b + 1] << 8)) & 0x7fff })
    }
    return [...out, ...this.direct]
  }

  private w16(off: number, v: number): void {
    this.bus.wram[off] = v & 0xff
    this.bus.wram[off + 1] = (v >> 8) & 0xff
  }

  private load(id: number): void {
    const w = this.bus.wram
    const s = this.seed
    if (s.loaded) {
      w.set(s.loaded.subarray(0, w.length))
      // The loader also spawns the level's own sprite list (CODE_02A751); only the one sprite under test runs.
      for (let i = 0; i < 12; i++) w[RAM.status + i] = 0
    }
    for (let i = 0; i < RAM.oamEntries; i++) w[RAM.oam + 1 + i * 4] = 0xf0 // cleared OAM is offscreen
    w[RAM.trueFrame] = s.trueFrame
    w[RAM.effFrame] = s.effFrame
    this.w16(RAM.camX, s.camera.x)
    this.w16(RAM.camY, s.camera.y)
    // SubHorizPos reads Now ($D1), most others Next ($94): seed both.
    this.w16(RAM.marioXNext, s.mario.x)
    this.w16(RAM.marioXNow, s.mario.x)
    this.w16(RAM.marioYNext, s.mario.y)
    this.w16(RAM.marioYNow, s.mario.y)
    // $76 comes from the ROM's own entrance setup when a loaded image carries it.
    if (!s.loaded) w[RAM.marioDir] = s.mario.dir
    const lv = s.level
    if (!s.loaded) {
      w[RAM.screenMode] = lv.screenMode
      w[RAM.levelScreens] = lv.screens
      w[RAM.spriteProps] = lv.spriteProps
      w[RAM.water] = lv.water
      w[RAM.slippery] = lv.slippery
      w[RAM.buoyancy] = lv.buoyancy
      w[RAM.spriteMemory] = lv.spriteMemory
      this.w16(RAM.slopes, lv.slopes)
    }
    for (const [k, v] of Object.entries(s.ram)) w[Number(k)] = v
    const n = s.slot
    w[RAM.curSprite] = n
    w[RAM.spriteNumber + n] = id
    w[RAM.spriteXLow + n] = s.sprite.x & 0xff
    w[RAM.xHigh + n] = (s.sprite.x >> 8) & 0xff
    w[RAM.spriteYLow + n] = s.sprite.y & 0xff
    w[RAM.yHigh + n] = (s.sprite.y >> 8) & 0xff
    w[RAM.status + n] = 1
  }

  /** Runs a routine to its return; throws Refusal on a bad op, escape or budget. */
  call(entry: number, kind: 'jsr' | 'jsl'): void {
    const cpu = this.cpu
    cpu.x = this.seed.slot
    const s0 = cpu.s
    const wr = (v: number) => {
      this.bus.write(cpu.s, v)
      cpu.s = (cpu.s - 1) & 0xffff
    }
    if (kind === 'jsl') wr(0x00)
    wr((SENTINEL - 1) >> 8)
    wr((SENTINEL - 1) & 0xff)
    cpu.pb = entry >>> 16
    cpu.pc = entry & 0xffff
    for (let i = 0; i < STEP_BUDGET; i++) {
      cpu.step()
      this.steps++
      if (cpu.s === s0 && cpu.pc === SENTINEL) return
    }
    throw new Refusal(`step budget of ${STEP_BUDGET} spent; the routine waits on state the seed lacks`) // prettier-ignore
  }

  pos(): { x: number; y: number } {
    const w = this.bus.wram
    const n = this.seed.slot
    return {
      x: w[RAM.spriteXLow + n] | (w[RAM.xHigh + n] << 8),
      y: w[RAM.spriteYLow + n] | (w[RAM.yHigh + n] << 8),
    }
  }

  /** One frame: the game's own sprite loop over all twelve slots (the others are empty). */
  frame(): void {
    this.call(ENTRY.spriteLoop, 'jsl')
  }

  clearOamWrites(): void {
    this.touched.clear()
  }

  /** OAM mirror indices whose tile byte this pass wrote. */
  writtenOam(): number[] {
    const out: number[] = []
    for (let i = 0; i < RAM.oamEntries; i++) if (this.touched.has(RAM.oam + 2 + i * 4)) out.push(i)
    return out
  }
}

const s8 = (v: number) => (v > 127 ? v - 256 : v)

/** Parts the pass wrote, relative to `anchor`, in screen terms (camera removed). */
function readParts(m: Machine, anchor: { x: number; y: number }): SpritePart[] {
  const w = m.bus.wram
  const cam = m.seed.camera
  const out: SpritePart[] = []
  for (const i of m.writtenOam()) {
    const b = RAM.oam + i * 4
    const y = w[b + 1]
    if (y === 0xf0) continue
    const attr = w[b + 3]
    const hi = w[RAM.oamSize + i]
    // OAM X is 9 bits (size-table bit 0); the offset wraps into -256..255.
    const x9 = w[b] | ((hi & 1) << 8)
    const rel = (((x9 - (anchor.x - cam.x)) % 512) + 512) % 512
    out.push({
      oam: i,
      char: w[b + 2] | ((attr & 1) << 8),
      size: hi & 2 ? 16 : 8,
      palette: 8 + ((attr >> 1) & 7),
      priority: (attr >> 4) & 3,
      flipX: !!(attr & 0x40),
      flipY: !!(attr & 0x80),
      dx: rel > 255 ? rel - 512 : rel,
      dy: s8((y - (anchor.y - cam.y)) & 0xff),
      attr,
      ox: x9,
      oy: y,
    })
  }
  return out
}

function uploadsOf(m: Machine, before: Map<number, number>): string[] {
  const out = new Set<string>()
  for (const [a, n] of m.bus.hwWrites) {
    if (n === (before.get(a) ?? 0)) continue
    if (a === 0x2121 || a === 0x2122) out.add('cgram')
    else if (a >= 0x2115 && a <= 0x2119) out.add('vram')
    else if (a >= 0x4300 && a <= 0x437f) out.add('dma')
  }
  return [...out]
}

/** Debug hook: sees WRAM after INIT (pass -1) and after each MAIN pass. */
export type Probe = (pass: number, wram: Uint8Array) => void

/** Run once with a seed; no dependsOn analysis (half the cost of `runSprite`). */
export function runOnce(
  rom: RomFile,
  id: number,
  seed: SpriteSeed,
  opts: RunOptions = {},
): SpriteModel {
  const probe = opts.probe
  const model: SpriteModel = { id, passes: [], dependsOn: [], steps: [] }
  const loop = resolveLoop(rom)
  if (!loop.ok) return { ...model, refusal: loop.reason }
  const tables = resolveTables(rom, loop.handle)
  if (!tables.ok) return { ...model, refusal: tables.reason }
  const inits = resolvePointer(rom, tables.tables.initTable, id)
  if (!inits.ok) return { ...model, refusal: `INIT: ${inits.reason}` }
  const mains = resolvePointer(rom, tables.tables.mainTable, id)
  if (!mains.ok) return { ...model, refusal: `MAIN: ${mains.reason}` }
  const init = checkInitTables(rom)
  if (!init.ok) return { ...model, refusal: init.reason }
  const rand = checkGetRand(rom)
  if (!rand.ok) return { ...model, refusal: rand.reason }
  const m = new Machine(rom, seed, id)
  if (opts.trackInputs) m.bus.inputs = new Set()
  try {
    // RNGCalc ($148B/C) is zero until the game first calls GetRand, its only
    // writer (CODE_01AD07, bank_01.asm:6101-6121); one call from zero is what
    // frame 0 of a level has run, so run the ROM's own GetRand once.
    const rngCells = m.bus.wram.subarray(RAM.rng, RAM.rng + 2)
    if (rngCells[0] === 0 && rngCells[1] === 0) m.call(ENTRY.getRand, 'jsl')
    m.call(ENTRY.initSpriteTables, 'jsl')
    let n = m.steps
    const w = m.bus.wram
    // Status 1 -> CallSpriteInit, which sets status 8 and runs INIT. An INIT
    // that leaves status 1 runs again next frame, as the game does (the floating
    // platforms sink a few pixels per frame until they reach water).
    let frameNo = 0
    m.frame()
    while (w[RAM.status + seed.slot] === 1 && frameNo < MAX_INIT_FRAMES) {
      frameNo++
      w[RAM.trueFrame] = (seed.trueFrame + frameNo) & 0xff
      w[RAM.effFrame] = (seed.effFrame + frameNo) & 0xff
      m.frame()
    }
    model.steps.push(m.steps - n)
    model.initFrames = frameNo + 1
    const st = w[RAM.status + seed.slot]
    if (st === 0) return { ...model, emptyReason: 'INIT erased the sprite (status 0)' }
    if (st === 1)
      return { ...model, refusal: `INIT did not complete in ${MAX_INIT_FRAMES} frames: status stays 1, waiting on state the seed lacks` } // prettier-ignore
    const anchor = m.pos()
    model.anchor = { ...anchor, rawX: seed.sprite.x, rawY: seed.sprite.y }
    model.oamBase = w[RAM.oamIndex + seed.slot]
    probe?.(-1, w)
    for (let p = 0; p < seed.mainPasses; p++) {
      w[RAM.trueFrame] = (seed.trueFrame + frameNo + 1 + p) & 0xff
      w[RAM.effFrame] = (seed.effFrame + frameNo + 1 + p) & 0xff
      for (let i = 0; i < RAM.oamEntries; i++) w[RAM.oam + 1 + i * 4] = 0xf0
      m.clearOamWrites()
      n = m.steps
      const hw = new Map(m.bus.hwWrites)
      m.frame()
      model.steps.push(m.steps - n)
      probe?.(p, w)
      model.passes.push({
        pass: p,
        pos: m.pos(),
        parts: readParts(m, anchor),
        uploads: uploadsOf(m, hw),
        palette: m.paletteWrites(),
      })
    }
    if (m.bus.inputs) model.inputs = [...m.bus.inputs].sort((a, b) => a - b)
    const first = model.passes.findIndex(p => p.parts.length > 0)
    if (first >= 0) model.chosen = first
    if (model.passes.every(p => p.parts.length === 0))
      model.emptyReason = `drew no OAM tile in ${seed.mainPasses} passes (invisible by design, or the seed lacks state)` // prettier-ignore
  } catch (e) {
    if (e instanceof Refusal) return { ...model, refusal: e.message }
    throw e
  }
  return model
}

const partsKey = (m: SpriteModel): string =>
  m.passes
    .map(p =>
      p.parts
        .map(q => [q.char, q.palette, +q.flipX, +q.flipY, q.dx, q.dy, q.size].join(','))
        .sort()
        .join(';'),
    )
    .join('|')

/**
 * The v1 model for one id. `dependsOn` is filled by running a second time with
 * Mario on the other side of the sprite and diffing the parts, so a future
 * input is flagged by the same method and never by a per-id list.
 */
export function runSprite(
  rom: RomFile,
  id: number,
  seed: SpriteSeed = SPRITE_SEED,
  opts: RunOptions = {},
): SpriteModel {
  const a = runOnce(rom, id, seed, opts)
  if (a.refusal) return a
  const other = seed.mario.x >= seed.sprite.x ? seed.sprite.x - 0x40 : seed.sprite.x + 0x40
  const b = runOnce(rom, id, withSeed({ mario: { x: other, y: seed.mario.y } }, seed))
  if (!b.refusal && partsKey(a) !== partsKey(b)) a.dependsOn.push('marioX')
  return a
}
