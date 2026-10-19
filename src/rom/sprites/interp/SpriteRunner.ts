/**
 * SpriteRunner.ts -- runs one sprite's own INIT and MAIN from the ROM on the
 * 65816 core and emits the v1 model: anchor after INIT, per-pass OAM parts,
 * a refusal or empty reason, and `dependsOn` found by a two-run diff.
 *
 * Nothing here knows a sprite id. Placement and drawing are whatever the
 * cart's bytes do; the only inputs are the seed (SpriteSeed.ts) and the ROM.
 * See docs/ideas/sprite-gfx-interpreter.md for measurements.
 */
import type { Cpu65816 } from '../../cpu/Cpu65816'
import { callSubroutine, describe, Refusal } from '../../cpu/call'
import type { RomFile } from '../../RomFile'
import { mapperProblem } from './Guards'
import { type DispatchShape, grinderDrawsBeforeSnap } from './LineGuided'
import { smwMachine } from './Machine'
import { type ShellLoad, shellLoad } from '../ShellSprites'
import {
  checkGetRand,
  checkInitTables,
  ENTRY,
  resolveLoop,
  resolveBlockSpawn,
  resolvePointer,
  resolveTables,
  type DispatcherSpan,
} from './SpriteDispatch'
import type { SpriteBus } from './SpriteBus'
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
  /** $0680 PaletteIndexTable: which palette source the next NMI uploads (rammap.asm:1143-1146). */
  paletteIndexTable: 0x680,
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
/**
 * Instruction cap for one whole sprite (setup, every INIT retry, every MAIN
 * pass). The per-call budget alone lets a sprite that never leaves INIT cost
 * 64 + 64 calls x 200k steps (~25.6M), which blocks the Theia RPC thread.
 * Vanilla's worst sprite over the maps measured is 234,924 steps (one
 * machine, 2026-10-05), so this is ~4x headroom.
 */
export const TOTAL_STEP_CAP = 1_000_000
/** Slots in the sprite tables. */
const SLOTS = 12
/** Slots the $9C scan covers, 0-9 (bank_02.asm:12118); neighbors go no further. */
const SCANNED_SLOTS = 10

/** INIT retries allowed while the routine leaves status 1. */
const MAX_INIT_FRAMES = 64

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
  /** Pixels from the pass's draw origin (`PassResult.origin`): the post-INIT position, except for $67 on a vanilla-shaped handler. */
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
  /** Where this pass's parts are measured from: `SpriteModel.anchor`, except for $67 on a vanilla-shaped handler (where the pass before left it). */
  origin: { x: number; y: number }
  parts: SpritePart[]
  /** Palette or graphics uploads the pass wrote registers for. */
  uploads: string[]
  /**
   * CGRAM colors the run has set by the end of this pass (cumulative from the
   * start of INIT), in application order. See `Machine.paletteWrites`.
   */
  palette: PaletteWrite[]
  /**
   * Neighbor run only, when the sprite's own code drew a neighbor: each neighbor it drew (`seed.neighbours[].index`)
   * with the OAM entries written for it, and how far the sprite had moved from `SpriteModel.anchor` when it did (0 when it draws
   * before it moves). The child is drawn at rest, so `runOnce` takes `shift` off the child's parts (D137).
   */
  drew?: { children: { index: number; oam: number[] }[]; shift: { x: number; y: number } }
}

export type DependsOn = 'marioX' | 'neighbours'

export interface SpriteModel {
  id: number
  /** Why nothing was emitted: the run was refused. */
  refusal?: string
  /** Why no part was drawn across all passes, when the run completed. */
  emptyReason?: string
  /** Position after INIT, and the raw placement it started from. For $67 on a vanilla-shaped handler: the position its drawn (chosen) pass drew at, after the line snap. */
  anchor?: { x: number; y: number; rawX: number; rawY: number }
  /**
   * Where the level state came from: the ROM's own level loader, or a generic
   * placement-only seed (no loader ran, or it refused: see `seedReason`). A
   * caller that shows sprites should mark generic-seeded ones unverified.
   */
  seedSource?: 'rom-level-load' | 'generic'
  seedReason?: string
  /** Frames INIT took: 1 unless it left status 1 and was re-run. */
  initFrames?: number
  /** $15EA after INIT: the OAM base the cart assigned. */
  oamBase?: number
  /** A spawn run: where the spawn code left the picked sprite, before any frame ran (D137: what a spawner's child is drawn at). */
  spawnPos?: { x: number; y: number }
  passes: PassResult[]
  /**
   * The frame policy: index of the first pass at or after INIT that draws at
   * least one tile (within the pass cap), absent when none does; for $67 on a vanilla-shaped
   * handler, the pass on the line: two after it when each step moved the sprite and draws (#126). A policy, not a claim about which
   * frame a map should show.
   */
  chosen?: number
  /** Why a $67 handler got the generic rule: the grinder gate ran it and it did not make the vanilla calls in order. */
  lineGateReason?: string
  /** Why a $67 on a vanilla-shaped handler stayed on its first drawn pass although the next one draws. */
  lineStepReason?: string
  /** True for $67 on a vanilla-shaped handler: each pass draws where the pass before left the sprite (`PassResult.origin`). */
  snaps?: boolean
  dependsOn: DependsOn[]
  /** Instruction counts: INIT, then each MAIN pass. */
  steps: number[]
  /** WRAM offsets read before anything wrote them, when `RunOptions.trackInputs` is set. */
  inputs?: number[]
  /** The sprite's own code read the number or status table at another slot (a scan for a companion). */
  scansSlots?: boolean
  /**
   * Set only when a second run put `seed.neighbours` in the other slots: 'adopted' when its parts (those
   * written while this sprite's slot ran) differed from the run alone and replaced it, 'same' when not, 'refused' when
   * the second run refused (the run alone stands in both).
   */
  neighbourRun?: 'adopted' | 'same' | 'refused'
}

/**
 * A sprite spawned by the game's own item block spawn (the dispatcher CODE_0288DC and
 * GenSpriteFromBlk, SMWDisX bank_02.asm:1097-1292, #566) instead of by the level loader: that
 * code runs on the core in place of the loader's INIT. The game picks the slot itself (a free
 * one, FindFreeSprSlot's for the egg, key, vine and balloon, SpriteMemorySetting from the
 * seeded level state), writes the status and number from its tables, calls InitSpriteTables
 * and writes the spawn cells; the sprite's INIT never runs, its status handler draws it.
 * `inputs` are the absolute WRAM offsets it reads (its content index, TouchBlockXPos and the
 * rest), seeded before it runs.
 */
export interface SpawnRun {
  inputs: Record<number, number>
  /** Replaces the real dispatcher build; for a synthetic ROM only. */
  dispatcher?: DispatcherSpan
  /**
   * Run this subroutine (JSR, DB = its bank) in place of the block spawn: a level-loader spawner that makes
   * several sprites (#1015). The caller has gated it; the block dispatcher is not read.
   */
  routine?: number
  /**
   * Which spawned sprite to draw, counting in the order the spawn filled its slots (default 0). When given, the others
   * are emptied so only the chosen one runs and writes OAM; when absent the block path is as it always was.
   */
  nth?: number
}

/** The refusal text when `SpawnRun.nth` names a sprite the spawn did not make; callers that ask for several count these. */
export const SPAWN_SHORT = 'the spawn made only '

export interface RunOptions {
  spawn?: SpawnRun
  probe?: Probe
  trackInputs?: boolean
  /** The dispatch shape the $67 gate accepts; a test hook, so a synthetic cart brings its own (default: vanilla's). */
  grinderDispatch?: DispatchShape
}

export { Refusal }

export class Machine {
  readonly bus: SpriteBus
  readonly cpu: Cpu65816
  private touched = new Set<number>()
  /** Colors set so far, in the order they took effect (cumulative; see `nmi`). */
  private applied: PaletteWrite[] = []
  /** The run itself wrote $0680 PaletteIndexTable since the last NMI (a loaded image's value is not the sprite's). */
  private modeWritten = false
  private cgadd = 0
  private cgLow: number | null = null
  /** $0681 when the run began: entries the loader left in the upload list are not this sprite's. */
  private dynStart = 0
  steps = 0
  /** The sprite's own code read another slot's number or status cell. */
  scanned = false
  /** Slots `load` put neighbors in (their InitSpriteTables still has to run). */
  readonly neighbourSlots: number[] = []
  /** Slot to list index of each neighbor `load` placed (undefined when the seed gave none). */
  private readonly placed = new Map<number, number | undefined>()
  /** Neighbor slots whose OAM index ($15EA) the sprite's own code read this pass. */
  private drewSlots = new Set<number>()
  /** The neighbor slot whose draw is running (its `$15EA` was the last one read). */
  private drawingFor: number | undefined
  /** OAM tile bytes written while each neighbor slot was `drawingFor`. */
  private readonly childTiles = new Map<number, Set<number>>()
  /** Where the sprite stood at the first such read. */
  private drewAt: { x: number; y: number } | undefined
  /** OAM tile bytes written while `$15E9` named this sprite's slot; read instead of `touched` in a neighbor run. */
  private own = new Set<number>()

  constructor(
    private readonly rom: RomFile,
    readonly seed: SpriteSeed,
    id: number,
    shell?: ShellLoad,
    private readonly neighbourRun = false,
  ) {
    const m = smwMachine(rom)
    this.bus = m.bus
    this.cpu = m.cpu
    this.bus.onWramWrite = off => {
      this.touched.add(off)
      if (this.bus.wram[RAM.curSprite] === this.seed.slot) {
        this.own.add(off)
        if (this.drawingFor !== undefined) {
          const set = this.childTiles.get(this.drawingFor) ?? new Set<number>()
          this.childTiles.set(this.drawingFor, set.add(off))
        }
      }
      if (off === RAM.paletteIndexTable) this.modeWritten = true
    }
    this.bus.onHwWrite = (reg, v) => {
      if (reg === 0x2121) {
        this.cgadd = v
        this.cgLow = null
      } else if (reg === 0x2122) {
        if (this.cgLow === null) this.cgLow = v
        else {
          this.applied.push({ index: this.cgadd, bgr555: ((v << 8) | this.cgLow) & 0x7fff })
          this.cgadd = (this.cgadd + 1) & 0xff
          this.cgLow = null
        }
      }
    }
    // The gate for the neighbor run: a read of the number ($9E) or status ($14C8) table at a slot other than
    // this sprite's, made while the loop is on this sprite's slot ($15E9 is stored before the loop's own reads
    // of its slot). The loop's reads of the other slots happen under their own $15E9.
    if (seed.neighbours?.length)
      this.bus.onRead = off => {
        // A draw routine reads the OAM index of the slot it draws; read on this sprite's turn, that slot is its child.
        if (off >= RAM.oamIndex && off < RAM.oamIndex + SLOTS) {
          const j = off - RAM.oamIndex
          if (this.bus.wram[RAM.curSprite] === this.seed.slot) {
            const child = this.placed.has(j)
            this.drawingFor = child ? j : undefined
            if (child) {
              this.drewSlots.add(j)
              this.drewAt ??= this.pos()
            }
          }
          return
        }
        const inStatus = off >= RAM.status && off < RAM.status + SLOTS
        const inNumber = off >= RAM.spriteNumber && off < RAM.spriteNumber + SLOTS
        if (!inStatus && !inNumber) return
        const j = off - (inStatus ? RAM.status : RAM.spriteNumber)
        if (j !== this.seed.slot && this.bus.wram[RAM.curSprite] === this.seed.slot)
          this.scanned = true
      }
    this.load(id, shell)
    this.dynStart = this.bus.wram[RAM.dynPaletteIndex]
  }

  /** CGRAM colors this run has set so far, in the order they took effect. */
  paletteWrites(): PaletteWrite[] {
    return [...this.applied]
  }

  /**
   * The NMI's palette work after one frame of sprite code (CODE_00A488 and
   * CODE_00A4CF, SMWDisX bank_00.asm:4714-4757), since no NMI runs here.
   * Direct $2121/$2122 writes already took effect, in order, during the
   * frame. Then CODE_00A488 walks ONE list, the same shape for every source
   * (bank_00.asm:4726-4748): `[byte count, CGRAM color index, count bytes of
   * colors...]` repeated until a zero count, each entry DMA'd to CGRAM from
   * that index. The source is `PaletteIndexTable` ($0680, rammap.asm:1143-1146,
   * an index into the three-entry table at bank_00.asm:4709-4712):
   * - 0, the default: `DynPaletteTable` ($0682), from where the run began on
   *   the first frame (what the loader left is not this sprite's); then `$0681`
   *   and the first list byte are cleared (bank_00.asm:4753-4756), so the list
   *   does not pile up. Nothing bounds an entry to the 127-byte table: the DMA
   *   reads on past it, as hardware does (only the end of WRAM stops the walk).
   * - 6: the list starts at `MainPalette` ($0703, rammap.asm:1172-1175), whose
   *   first bytes are a header, not color 0 (the overworld writes `$FE, $01` and
   *   a terminator at +$100, bank_04.asm:5585-5590; the level upload zeroes
   *   them, bank_00.asm:2047-2048). The list is not cleared. No vanilla sprite
   *   bank writes $0680, so this is reached only by a hack's own sprite, and
   *   only when the run wrote it.
   * - 3, CopyPalette (level-end fades): not modelled.
   * Then $0680 is cleared (bank_00.asm:4757).
   */
  nmi(): void {
    const w = this.bus.wram
    const mode = w[RAM.paletteIndexTable]
    if (mode === 0) {
      this.uploadList(RAM.dynPaletteTable + this.dynStart)
      w[RAM.dynPaletteIndex] = 0
      w[RAM.dynPaletteTable] = 0
      this.dynStart = 0
    } else if (mode === 6 && this.modeWritten) {
      this.uploadList(RAM.mainPalette)
    }
    w[RAM.paletteIndexTable] = 0
    this.modeWritten = false
  }

  /**
   * CODE_00A4A0's walk: entries to their CGRAM colors. A list that runs off
   * the end of WRAM (a count byte with no header after it, data past the end,
   * or no terminator) is refused: hardware would read other memory, which this
   * machine does not have, so any colors it applied would be guesses.
   */
  private uploadList(start: number): void {
    const w = this.bus.wram
    let at = start
    for (;;) {
      if (at >= w.length) throw new Refusal('palette list runs off the end of WRAM without a terminator') // prettier-ignore
      const count = w[at]
      if (count === 0) return
      if (at + 1 >= w.length) throw new Refusal('palette list is truncated: an entry header is cut off by the end of WRAM') // prettier-ignore
      const first = w[at + 1]
      if (at + 2 + count > w.length) throw new Refusal('palette list is truncated: an entry runs past the end of WRAM') // prettier-ignore
      // CGADD counts colors and wraps at 256; an odd count leaves a half color the DMA still writes.
      for (let i = 0; i + 1 < count; i += 2)
        this.applied.push({
          index: (first + (i >> 1)) & 0xff,
          bgr555: (w[at + 2 + i] | (w[at + 3 + i] << 8)) & 0x7fff,
        })
      at += 2 + count
    }
  }

  private w16(off: number, v: number): void {
    this.bus.wram[off] = v & 0xff
    this.bus.wram[off + 1] = (v >> 8) & 0xff
  }

  private load(id: number, shell?: ShellLoad): void {
    const w = this.bus.wram
    const s = this.seed
    if (s.loaded) {
      w.set(s.loaded.subarray(0, w.length))
      // The loader also spawns the level's own sprite list (CODE_02A751); only the sprite under test is active,
      // unless a neighbor run places the list's other sprites afterwards (placeNeighbours).
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
    // A shell list id loads as the loader's rebased number in its status (ShellSprites.ts); the rest as itself in status 1.
    w[RAM.spriteNumber + n] = shell?.number ?? id
    w[RAM.spriteXLow + n] = s.sprite.x & 0xff
    w[RAM.xHigh + n] = (s.sprite.x >> 8) & 0xff
    w[RAM.spriteYLow + n] = s.sprite.y & 0xff
    w[RAM.yHigh + n] = (s.sprite.y >> 8) & 0xff
    w[RAM.status + n] = shell?.status ?? 1
    if (this.neighbourRun) this.placeNeighbours()
  }

  /**
   * The list's other sprites in free slots 0-9 (the scan covers those, bank_02.asm:12118), each loaded the
   * way the level loader would load that id: a shell id (ShellSprites.ts) takes its rebased number and status,
   * the rest status 1 so the game's own loop runs their INIT. This is a derivation from the list, not a trace
   * of the loader: the loader's slot order and which sprites it had loaded by then are not modelled.
   */
  private placeNeighbours(): void {
    const w = this.bus.wram
    if (!this.seed.neighbours?.length)
      throw new Refusal('neighbour run: the seed lists no neighbours to place')
    const list = [...this.seed.neighbours]
    for (let k = 0; k < SCANNED_SLOTS && list.length; k++) {
      if (k === this.seed.slot) continue
      const nb = list.shift()!
      const loaded = shellLoad(this.rom, nb.id)
      // A loader the shell reader cannot parse: the id's load is unknowable, so it is not placed.
      if (loaded.refusal) {
        k--
        continue
      }
      w[RAM.spriteNumber + k] = loaded.shell?.number ?? nb.id
      w[RAM.spriteXLow + k] = nb.x & 0xff
      w[RAM.xHigh + k] = (nb.x >> 8) & 0xff
      w[RAM.spriteYLow + k] = nb.y & 0xff
      w[RAM.yHigh + k] = (nb.y >> 8) & 0xff
      w[RAM.status + k] = loaded.shell?.status ?? 1
      this.neighbourSlots.push(k)
      this.placed.set(k, nb.index)
    }
  }

  /** Runs a routine to its return, from the native reset state with X = the slot; throws Refusal on a bad op, escape, unbalanced return or budget. */
  call(entry: number, kind: 'jsr' | 'jsl', db?: number, x: number = this.seed.slot): void {
    const left = TOTAL_STEP_CAP - this.steps
    const capMsg = `total step cap of ${TOTAL_STEP_CAP} spent across INIT and MAIN; the sprite does not settle`
    if (left <= 0) throw new Refusal(capMsg)
    const room = Math.min(STEP_BUDGET, left)
    const r = callSubroutine(this.cpu, entry, {
      kind,
      maxSteps: room,
      regs: { x, ...(db === undefined ? {} : { db }) },
    })
    this.steps += r.steps
    if (r.kind === 'returned') return
    throw new Refusal(
      r.kind === 'budget' && room < STEP_BUDGET ? capMsg : describe(r, STEP_BUDGET)!,
    )
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
    this.nmi()
  }

  clearOamWrites(): void {
    this.touched.clear()
    this.own.clear()
    this.drewSlots.clear()
    this.childTiles.clear()
    this.drawingFor = undefined
    this.drewAt = undefined
  }

  /** What `PassResult.drew` says for the pass just run, or undefined when the sprite drew no neighbor. */
  drew(anchor: { x: number; y: number }): PassResult['drew'] {
    const children = [...this.drewSlots].flatMap(j => {
      const index = this.placed.get(j)
      const oam = [...(this.childTiles.get(j) ?? [])]
        .filter(
          o => o >= RAM.oam && o < RAM.oam + RAM.oamEntries * 4 && (o - RAM.oam - 2) % 4 === 0,
        )
        .map(o => (o - RAM.oam - 2) / 4)
      return index === undefined ? [] : [{ index, oam }]
    })
    if (!this.drewAt || !children.length) return undefined
    return { children, shift: { x: this.drewAt.x - anchor.x, y: this.drewAt.y - anchor.y } }
  }

  /** OAM mirror indices whose tile byte this pass wrote. */
  writtenOam(): number[] {
    const out: number[] = []
    const seen = this.neighbourRun ? this.own : this.touched
    for (let i = 0; i < RAM.oamEntries; i++) if (seen.has(RAM.oam + 2 + i * 4)) out.push(i)
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

/**
 * The grinder draws, then its line step moves it (SMWDisX bank_01.asm:12194-12204, corner stores 12054-12061),
 * so it draws three different spots: the off-track INIT spot, the probe corner the first MAIN snapped to, and the
 * line point the walk then set. The editor draws the third (#126).
 * $67 only: the other line-guided ids share the order; that family is follow-up #792.
 */
const DRAWS_BEFORE_LINE_SNAP: ReadonlySet<number> = new Set([0x67])

/**
 * Run with a seed; no marioX analysis (half the cost of `runSprite`). The run is alone. When the sprite's own
 * code scanned the slot tables for a companion (`scansSlots`) and the seed lists `neighbours`, a second run puts
 * them in the other slots and counts only the OAM written under this sprite's slot (as the capture does: a
 * neighbor's own draw is not this sprite's). It replaces the first only when its parts differ (#841).
 */
export function runOnce(
  rom: RomFile,
  id: number,
  seed: SpriteSeed,
  opts: RunOptions = {},
): SpriteModel {
  const a = runCore(rom, id, seed, opts, false)
  if (!seed.neighbours?.length || opts.spawn || a.refusal || !a.scansSlots) return a
  const b = runCore(rom, id, seed, opts, true)
  if (b.refusal) return { ...a, neighbourRun: 'refused' }
  if (b.chosen === undefined || !addsOnly(a, b)) return { ...a, neighbourRun: 'same' }
  return { ...childrenAtRest(b), dependsOn: [...a.dependsOn, 'neighbours'], scansSlots: true, neighbourRun: 'adopted' } // prettier-ignore
}

/**
 * The neighbor run is taken only when it ADDS parts to the pass the run alone chose and leaves the ones it
 * had: a companion the sprite draws on itself. A neighbor that merely changes how the sprite behaves (a collision
 * scan, a kick) is not a part of its picture (#841).
 */
function addsOnly(a: SpriteModel, b: SpriteModel): boolean {
  const mine = a.chosen === undefined ? [] : a.passes[a.chosen]!.parts.map(partKey)
  const theirs = new Set(b.passes[b.chosen!]!.parts.map(partKey))
  return theirs.size > mine.length && mine.every(k => theirs.has(k))
}

const partKey = (q: SpritePart) => [q.oam, q.char, q.palette, +q.flipX, +q.flipY, q.dx, q.dy, q.size].join(',') // prettier-ignore

/**
 * A parent that draws children is drawn with them at its spawn frame (D137): however far it had moved from its anchor
 * when it drew them comes off every part of the pass, so the group keeps the offsets the parent's code gives it. A
 * parent that draws before it moves (the platform, bank_02.asm:12115-12148) has no shift and is unchanged.
 */
function childrenAtRest(b: SpriteModel): SpriteModel {
  const pass = b.passes[b.chosen!]!
  const shift = pass.drew?.shift
  if (!shift || (!shift.x && !shift.y)) return b
  const parts = pass.parts.map(q => ({ ...q, dx: q.dx - shift.x, dy: q.dy - shift.y }))
  return { ...b, passes: b.passes.map(p => (p === pass ? { ...p, parts } : p)) }
}

function runCore(
  rom: RomFile,
  id: number,
  seed: SpriteSeed,
  opts: RunOptions,
  neighbourRun: boolean,
): SpriteModel {
  const probe = opts.probe
  const model: SpriteModel = {
    id,
    passes: [],
    dependsOn: [],
    steps: [],
    seedSource: seed.loaded ? 'rom-level-load' : 'generic',
    ...(seed.loaded ? {} : { seedReason: seed.loadRefusal ?? 'no level image was given' }),
  }
  const mapper = mapperProblem(rom)
  if (mapper) return { ...model, refusal: mapper }
  const loop = resolveLoop(rom)
  if (!loop.ok) return { ...model, refusal: loop.reason }
  const tables = resolveTables(rom, loop.handle)
  if (!tables.ok) return { ...model, refusal: tables.reason }
  // The tables are indexed by the sprite number the loader stores, not the list id.
  const loaded = shellLoad(rom, id)
  if (loaded.refusal) return { ...model, refusal: loaded.refusal }
  const shell = loaded.shell
  // INIT runs only for a sprite the loader leaves in status 1.
  let runsInit = (shell?.status ?? 1) === 1
  const num = shell?.number ?? id
  // A sprite the loader does not leave in status 1 never runs INIT, so its INIT pointer is not read.
  const inits = runsInit ? resolvePointer(rom, tables.tables.initTable, num) : undefined
  if (inits && !inits.ok) return { ...model, refusal: `INIT: ${inits.reason}` }
  const mains = resolvePointer(rom, tables.tables.mainTable, num)
  if (!mains.ok) return { ...model, refusal: `MAIN: ${mains.reason}` }
  const init = checkInitTables(rom)
  if (!init.ok) return { ...model, refusal: init.reason }
  const rand = checkGetRand(rom)
  if (!rand.ok) return { ...model, refusal: rand.reason }
  // A spawn finds its own slot, so the machine owns a copy of the seed whose slot it may update.
  try {
    const m = new Machine(rom, opts.spawn ? { ...seed } : seed, id, shell, neighbourRun)
    if (opts.trackInputs) m.bus.inputs = new Set()
    // RNGCalc ($148B/C) is zero until the game first calls GetRand, its only
    // writer (CODE_01AD07, bank_01.asm:6101-6121); one call from zero is what
    // frame 0 of a level has run, so run the ROM's own GetRand once.
    const rngCells = m.bus.wram.subarray(RAM.rng, RAM.rng + 2)
    if (rngCells[0] === 0 && rngCells[1] === 0) m.call(ENTRY.getRand, 'jsl')
    const w = m.bus.wram
    if (opts.spawn) {
      const own = opts.spawn.routine
      const spawn = own === undefined ? resolveBlockSpawn(rom, opts.spawn.dispatcher) : { ok: true as const, entry: own } // prettier-ignore
      if (!spawn.ok) return { ...model, refusal: spawn.reason }
      // Every slot empty, so the game's own search decides where the sprite goes.
      for (let i = 0; i < 12; i++) w[RAM.status + i] = 0
      for (const [k, v] of Object.entries(opts.spawn.inputs)) w[Number(k)] = v
      // The code reads its tables through DB: the game reaches it from its own bank (PHK PLB), so enter it with DB = its bank.
      // Slots in the order the spawn first filled them: that is its spawn order, whichever way its search runs.
      const order: number[] = []
      const before = m.bus.onWramWrite
      m.bus.onWramWrite = (off, v) => {
        before?.(off, v)
        const i = off - RAM.status
        if (i >= 0 && i < 12 && v !== 0 && !order.includes(i)) order.push(i)
      }
      try {
        m.call(spawn.entry, own === undefined ? 'jsl' : 'jsr', spawn.entry >>> 16)
      } finally {
        m.bus.onWramWrite = before
      }
      const made = order.filter(i => w[RAM.status + i] !== 0)
      const nth = opts.spawn.nth
      const picked = made[nth ?? 0]
      if (picked === undefined)
        return { ...model, refusal: nth === undefined ? 'the item block spawn found no free slot and spawned nothing' : `${SPAWN_SHORT}${made.length} sprites, not ${nth + 1}` } // prettier-ignore
      // One sprite runs and draws; the rest the spawn made would add their own OAM entries to its parts.
      if (nth !== undefined) for (const i of made) if (i !== picked) w[RAM.status + i] = 0
      // From here the sprite is wherever the game put it.
      m.seed.slot = picked
      w[RAM.curSprite] = picked
      model.spawnPos = m.pos()
      // An own spawner leaves the status it chose: only status 1 runs INIT, so a status-8 sprite has no frame before pass 0
      // (a frame there would move it before it is first drawn). The block path is as it always was.
      if (own !== undefined) runsInit = w[RAM.status + picked] === 1
    } else {
      m.call(ENTRY.initSpriteTables, 'jsl')
      for (const k of m.neighbourSlots) m.call(ENTRY.initSpriteTables, 'jsl', undefined, k)
    }
    let n = m.steps
    // Status 1 -> CallSpriteInit, which sets status 8 and runs INIT. An INIT
    // that leaves status 1 runs again next frame, as the game does (the floating
    // platforms sink a few pixels per frame until they reach water).
    // A shell starts in status 9 with no INIT frame, so MAIN's first pass follows the loader directly.
    let frameNo = 0
    if (runsInit) m.frame()
    while (runsInit && w[RAM.status + m.seed.slot] === 1 && frameNo < MAX_INIT_FRAMES) {
      frameNo++
      w[RAM.trueFrame] = (m.seed.trueFrame + frameNo) & 0xff
      w[RAM.effFrame] = (m.seed.effFrame + frameNo) & 0xff
      m.frame()
    }
    model.steps.push(m.steps - n)
    model.initFrames = runsInit ? frameNo + 1 : 0
    const st = w[RAM.status + m.seed.slot]
    if (st === 0) return { ...model, emptyReason: 'INIT erased the sprite (status 0)' }
    if (st === 1)
      return { ...model, refusal: `INIT did not complete in ${MAX_INIT_FRAMES} frames: status stays 1, waiting on state the seed lacks` } // prettier-ignore
    const anchor = m.pos()
    const gate = DRAWS_BEFORE_LINE_SNAP.has(num)
      ? grinderDrawsBeforeSnap(
          rom,
          mains.handler.address,
          num,
          RAM.spriteNumber,
          opts.grinderDispatch,
        )
      : null
    const snaps = gate?.ok === true
    if (gate && !gate.ok) model.lineGateReason = gate.reason
    model.anchor = { ...anchor, rawX: m.seed.sprite.x, rawY: m.seed.sprite.y }
    if (snaps) model.snaps = true
    model.oamBase = w[RAM.oamIndex + m.seed.slot]
    probe?.(-1, w)
    for (let p = 0; p < m.seed.mainPasses; p++) {
      w[RAM.trueFrame] = (m.seed.trueFrame + frameNo + 1 + p) & 0xff
      w[RAM.effFrame] = (m.seed.effFrame + frameNo + 1 + p) & 0xff
      for (let i = 0; i < RAM.oamEntries; i++) w[RAM.oam + 1 + i * 4] = 0xf0
      m.clearOamWrites()
      n = m.steps
      const hw = new Map(m.bus.hwWrites)
      m.frame()
      model.steps.push(m.steps - n)
      probe?.(p, w)
      // The draw ran before this pass's own move, so for $67 it ran where the pass before left it.
      const origin = snaps ? (model.passes[p - 1]?.pos ?? anchor) : anchor
      const drew = neighbourRun ? m.drew(anchor) : undefined
      model.passes.push({
        pass: p,
        pos: m.pos(),
        origin: { x: origin.x, y: origin.y },
        parts: readParts(m, origin),
        uploads: uploadsOf(m, hw),
        palette: m.paletteWrites(),
        ...(drew ? { drew } : {}),
      })
    }
    if (m.scanned) model.scansSlots = true
    if (m.bus.inputs) model.inputs = [...m.bus.inputs].sort((a, b) => a - b)
    const first = model.passes.findIndex(p => p.parts.length > 0)
    if (first >= 0) model.chosen = first
    // $67 draws before its own move (SMWDisX bank_01.asm:12194-12204). Pass 0 draws at the off-track INIT spot,
    // pass 1 at the probe-corner spot the first MAIN snapped to (CODE_01D8A4, 12045-12061), pass 2 at the spot the
    // line walk then set, which is on the line (CODE_01D768 / CODE_01D7B0, 11863-11930; Mesen capture 6b47bb75 slot
    // $1F: (415,336) -> (419,340) -> (431,336)). Each step is only taken if the pass before it moved the sprite
    // and the next pass draws; a fingerprint match cannot prove that. A first draw after pass 0 is already on track.
    if (snaps && first === 0 && model.passes[1]?.parts.length) {
      const [q0, q1] = [model.passes[0]!.pos, model.passes[1]!.pos]
      const moved = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        a.x !== b.x || a.y !== b.y
      if (!moved(q0, anchor))
        model.lineStepReason = 'the line step did not move the sprite on pass 0: kept the first drawn pass' // prettier-ignore
      else model.chosen = model.passes[2]?.parts.length && moved(q0, q1) ? 2 : 1
    }
    if (snaps && model.chosen !== undefined)
      model.anchor = { ...model.anchor!, ...model.passes[model.chosen]!.origin }
    if (model.passes.every(p => p.parts.length === 0))
      model.emptyReason = `drew no OAM tile in ${m.seed.mainPasses} passes (invisible by design, or the seed lacks state)` // prettier-ignore
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
  // opts carry over, but not `probe`: a caller's probe watches the real run, not the mirrored one.
  const b = runOnce(rom, id, withSeed({ mario: { x: other, y: seed.mario.y } }, seed), { ...opts, probe: undefined }) // prettier-ignore
  if (!b.refusal && partsKey(a) !== partsKey(b)) a.dependsOn.push('marioX')
  return a
}
