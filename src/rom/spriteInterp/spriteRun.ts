/**
 * spriteRun.ts -- SPIKE: run one sprite's own INIT and MAIN on the concrete
 * 65816 core and read back what it wrote to OAM. Seeds are RAM the game's own
 * spawn path would have set; every address cites rammap/SMWDisX names.
 * docs/ideas/sprite-gfx-interpreter.md has the measurements.
 */
import type { RomFile } from '../RomFile'
import { Cpu, type RunResult } from './Cpu65816'

/** SMW_U.sym addresses (asar build of SMWDisX, byte-identical to vanilla). */
export const ENTRY = {
  initSpriteTables: 0x07f7d2, // JSL: ZeroSpriteTables + LoadSpriteTables (bank_07.asm:1006)
  perSpriteSetup: 0x0180d2, // JSR: OAM index + timer decrements (bank_01.asm:139-171)
  handleSprite: 0x018127, // JSR: dispatch on status (bank_01.asm:174)
} as const

/** WRAM addresses (rammap.asm). */
export const RAM = {
  effFrame: 0x14,
  trueFrame: 0x13,
  camX: 0x1a,
  camY: 0x1c,
  marioX: 0x94,
  marioY: 0x96,
  marioXNow: 0xd1,
  marioYNow: 0xd3,
  curSpriteProcess: 0x15e9,
  spriteNumber: 0x9e,
  spriteXLow: 0xe4,
  spriteYLow: 0xd8,
  status: 0x14c8,
  yHigh: 0x14d4,
  xHigh: 0x14e0,
  oamIndex: 0x15ea,
  memorySetting: 0x1692,
} as const

export interface OamEntry {
  index: number
  x: number
  y: number
  tile: number
  prop: number
  large: boolean
  /** Address of the instruction that wrote the tile byte. */
  writer: number
}

export interface SpriteRun {
  oam: OamEntry[]
  /** Sprite origin on screen at the end of MAIN, the anchor dx/dy are measured from. */
  origin: { x: number; y: number }
  init: RunResult
  main: RunResult
  /** MAIN passes actually run. */
  passes: number
  ram: Uint8Array
  /** Sprite position right after the INIT pass (before any MAIN). */
  initPos: { x: number; y: number }
  /** Writes the run made to RAM that only exists to feed hardware uploads. */
  dynamic: { palette: number; gfx: number; writers: Set<number> }
  hwAt: Set<number>
  /** WRAM offsets INIT and MAIN read before anything wrote them: the inputs that must be seeded. */
  inputs: { init: Set<number>; main: Set<number> }
}

export interface SpriteSeed {
  /** OAM-visible frame counters ($13 and $14). The map's "first frame" is 0. */
  frame?: number
  /** Mario's level X; equal to the sprite's X means SubHorizPos reads "Mario at or right". */
  marioX?: number
  /** MAIN passes after INIT. The first pass is the first drawn frame. */
  mainPasses?: number
  /** Stop at the first pass that writes any OAM tile (for sprites that start hidden). */
  untilOam?: boolean
  /** Skip the INIT pass: status 8 straight after InitSpriteTables (measures what INIT contributes). */
  skipInit?: boolean
  slot?: number
  /** 16-bit level position of the sprite; default (128,128). */
  spriteX?: number
  spriteY?: number
}

const SPRITE_X = 0x80
const SPRITE_Y = 0x80

export function runSprite(rom: RomFile, id: number, seed: SpriteSeed = {}): SpriteRun {
  const cpu = new Cpu(rom)
  const slot = seed.slot ?? 0
  const w = cpu.wram
  const oamWritten = new Map<number, number>() // OAM index -> address of the last writer
  const dynamic = { palette: 0, gfx: 0, writers: new Set<number>() }
  cpu.onWrite = a => {
    // DynPaletteIndex/Table (rammap.asm:1155,1164), DynGfxTilePtr/7FPtr (rammap.asm:1321,1326)
    if (a >= 0x681 && a < 0x702) dynamic.palette++
    else if (a >= 0xd85 && a < 0xd9b) dynamic.gfx++
    if ((a >= 0x681 && a < 0x702) || (a >= 0xd85 && a < 0xd9b)) dynamic.writers.add(cpu.at)
    if (a >= 0x300 && a < 0x400 && (a & 3) === 2) oamWritten.set((a - 0x300) >> 2, cpu.at)
  }
  for (let i = 0; i < 128; i++) w[0x301 + i * 4] = 0xf0 // cleared OAM is "offscreen"
  const frame = seed.frame ?? 0
  w[RAM.effFrame] = w[RAM.trueFrame] = frame
  const mx = seed.marioX ?? SPRITE_X
  // PlayerXPosNext ($94) and PlayerXPosNow ($D1): SubHorizPos reads Now (bank_01.asm:6124), others Next.
  for (const a of [RAM.marioX, RAM.marioXNow]) {
    w[a] = mx
    w[a + 1] = mx >> 8
  }
  w[RAM.marioY] = w[RAM.marioYNow] = SPRITE_Y
  w[RAM.curSpriteProcess] = slot // STX CurSpriteProcess, bank_01.asm:119
  w[RAM.spriteNumber + slot] = id
  const px = seed.spriteX ?? SPRITE_X
  const py = seed.spriteY ?? SPRITE_Y
  w[RAM.spriteXLow + slot] = px & 0xff
  w[RAM.xHigh + slot] = px >> 8
  w[RAM.spriteYLow + slot] = py & 0xff
  w[RAM.yHigh + slot] = py >> 8
  w[RAM.status + slot] = 1
  cpu.x = slot
  cpu.run(ENTRY.initSpriteTables, 'jsl')
  const pass = (): RunResult => {
    cpu.x = slot
    const a = cpu.run(ENTRY.perSpriteSetup, 'jsr')
    cpu.x = slot
    const b = cpu.run(ENTRY.handleSprite, 'jsr')
    // Merge so one census covers both calls.
    for (const [k, v] of a.ops) b.ops.set(k, (b.ops.get(k) ?? 0) + v)
    a.longCalls.forEach(t => b.longCalls.add(t))
    b.hwWrites += a.hwWrites
    b.steps += a.steps
    b.refusal ??= a.refusal
    return b
  }
  if (seed.skipInit) w[RAM.status + slot] = 8
  const init = seed.skipInit
    ? ({ steps: 0, ops: new Map(), longCalls: new Set(), hwWrites: 0, refusal: null } as RunResult)
    : pass() // status 1 -> CallSpriteInit (bank_01.asm:225), which sets status 8
  const pos = (): { x: number; y: number } => ({
    x: w[RAM.spriteXLow + slot] | (w[RAM.xHigh + slot] << 8),
    y: w[RAM.spriteYLow + slot] | (w[RAM.yHigh + slot] << 8),
  })
  const initPos = pos()
  const initInputs = cpu.extReads
  cpu.extReads = new Set()
  let main = init
  let passes = 0
  while (passes < (seed.mainPasses ?? 1)) {
    w[RAM.effFrame] = w[RAM.trueFrame] = (frame + passes) & 0xff // the game ticks both once per frame
    main = pass()
    passes++
    if (seed.untilOam && oamWritten.size > 0) break
  }
  const oam = [...oamWritten]
    .sort((p, q) => p[0] - q[0])
    .map(([index, writer]) => {
      const b = 0x300 + index * 4
      return {
        index,
        x: w[b],
        y: w[b + 1],
        tile: w[b + 2],
        prop: w[b + 3],
        large: (w[0x460 + index] & 2) !== 0,
        writer,
      }
    })
    .filter(e => e.y !== 0xf0)
  const sx = (w[RAM.spriteXLow + slot] - w[RAM.camX]) & 0xff
  const sy = (w[RAM.spriteYLow + slot] - w[RAM.camY]) & 0xff
  return {
    oam,
    origin: { x: sx, y: sy },
    init,
    main,
    passes,
    ram: w,
    initPos,
    dynamic,
    hwAt: cpu.hwAt,
    inputs: { init: initInputs, main: cpu.extReads },
  }
}

export interface Part {
  charNum: number
  palette: number
  flipX: boolean
  flipY: boolean
  dx: number
  dy: number
}

const s8 = (v: number) => (v > 127 ? v - 256 : v)

/** OAM -> the engine's 8x8 `EnginePart` shape (large OBJs split the way largeObj does). */
export function toParts(run: SpriteRun): Part[] {
  const out: Part[] = []
  for (const e of run.oam) {
    const flipX = (e.prop & 0x40) !== 0
    const flipY = (e.prop & 0x80) !== 0
    const base = 0x400 + ((e.prop & 1) << 8)
    const dx = s8((e.x - run.origin.x) & 0xff)
    const dy = s8((e.y - run.origin.y) & 0xff)
    const mk = (tile: number, ox: number, oy: number): Part => ({
      charNum: base + (tile & 0x1ff),
      palette: 8 + ((e.prop >> 1) & 7),
      flipX,
      flipY,
      dx: dx + ox,
      dy: dy + oy,
    })
    if (!e.large) out.push(mk(e.tile, 0, 0))
    else {
      const order =
        flipX && flipY ? [3, 2, 1, 0] : flipX ? [1, 0, 3, 2] : flipY ? [2, 3, 0, 1] : [0, 1, 2, 3]
      const corner = [0x00, 0x01, 0x10, 0x11]
      const off = [
        [0, 0],
        [8, 0],
        [0, 8],
        [8, 8],
      ]
      for (let c = 0; c < 4; c++) out.push(mk(e.tile + corner[order[c]], off[c][0], off[c][1]))
    }
  }
  return out
}

export const partKey = (p: Part): string =>
  `${p.charNum}:${p.palette}:${+p.flipX}${+p.flipY}@${p.dx},${p.dy}`
