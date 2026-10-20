/**
 * Whether a cart's line-guided sprite ($62, $64-$68) still dispatches in the vanilla order: draw, then the
 * line step. A hack that rewrites the handler gets the runner's generic rule. The gate RUNS the handler
 * from its MAIN pointer and watches which routines it calls, naming each call target by a SHA-256 of the
 * routine's first bytes (the hook-signature style). The targets are read from the ROM's own operands, so no
 * routine address is written here (#1121); a call to a routine that is not a stock one is "unverified".
 *
 * Per .claude/rules/rom-interpretation.md stock-code exception (added in #1030): the entry is fixed, the run has a
 * step budget, and a refusal names why. The entry chain: HandleSprite (fixed) -> its JMP operand -> CallSpriteMain
 * -> the MAIN pointer table -> the handler for the sprite.
 */
import type { RomFile } from '../../RomFile'
import { mirror } from '../../addressing'
import { nativeReset, Refusal } from '../../cpu/call'
import { fingerprint } from '../../Fingerprint'
import { RunCache, smwMachine, watchSram } from './Machine'

/** A routine named by its first `len` bytes, hashed whole (SHA-256, lowercase hex). */
export interface Routine {
  len: number
  sha: string
}

/**
 * The stock routines the dispatch CODE_01D9A7 reaches, by what they do. Prefixes only: a patch past the prefix is
 * not seen, one at the entry (a JSL or JML hook) is. SMWDisX bank_01.asm: prelude CODE_018063 (4348), platform
 * draw CODE_01B2DF (4607), rope draw CODE_01DC54, $67 draw CODE_01DC0B, $68 draw CODE_01DBD4, interact
 * MarioSprInteractRt, chainsaw draw wrapper CODE_03C263, line step CODE_01D74D (11848). One cart (vanilla US),
 * one machine.
 */
const STOCK: Readonly<Record<string, Routine>> = {
  prelude: { len: 24, sha: '34f9a559dae471bcea605bddf17a1b54bd93b62d52c1f6fbf09e025e6ae7c913' },
  draw62: { len: 24, sha: 'dbcedc01c21b8d55f108d2fac950a74d7a6491f5f720c4a9fe2c30f7aad2eb95' },
  rope: { len: 24, sha: 'ad56ecf943c1e8d80b2a347ed672b00f58d5a6d2f53d04493d86813de7460601' },
  draw67: { len: 24, sha: '1fa7fe6fbdf86ec163e2af8d6853d945c3a7ba31eed327043e8eef260ac33bb3' },
  draw68: { len: 24, sha: '0b75ea74245060df91ba45e9debde04cc591ad12acda988bd9b89adf24a96524' },
  interact: { len: 24, sha: '831c0babe84a9aa671d2c5d57730fb42e2c564beb45a4b578a7f2a5950174c90' },
  chainsawDraw: { len: 8, sha: '2097718c005f9beebcf14222c37e509b19541828e008912d8a69ff8ee9122c5e' },
  step: { len: 24, sha: '023da48591bdff4aa0eed58c8c6ba2e769f13bd1dbe5a7021cff3720f268f747' },
}

/**
 * `routines`: what each role looks like; `arm`: the roles the dispatch calls, in order, for an id `byId` does not
 * name. The last is the line step, which ends the arm. The prelude call (LineRope_Chainsaw's, skipped by a branch
 * on some frames) may come anywhere and is not part of the order. Vanilla order (bank_01.asm:12182-12215, platform
 * arm 12323-12358): $62 draw, step; $64 rope, step; $65 and $66 interact, chainsaw draw, step; $67 and $68 draw,
 * interact, step. $63 is left out (owner ruling D85).
 */
export interface DispatchShape {
  routines: Readonly<Record<string, Routine>>
  arm: readonly string[]
  byId?: Readonly<Record<number, readonly string[]>>
}

export const VANILLA_DISPATCH: DispatchShape = {
  routines: STOCK,
  arm: ['draw67', 'interact', 'step'],
  byId: {
    0x62: ['draw62', 'step'],
    0x64: ['rope', 'step'],
    0x65: ['interact', 'chainsawDraw', 'step'],
    0x66: ['interact', 'chainsawDraw', 'step'],
    0x68: ['draw68', 'interact', 'step'],
  },
}

/** The ids the draw-before-step rule is for: the ones `VANILLA_DISPATCH` gives an arm (#792). */
export const LINE_GUIDED_IDS: ReadonlySet<number> = new Set([0x62, 0x64, 0x65, 0x66, 0x67, 0x68])

/**
 * InitLineGuidedSpr, whole (INC SpriteMisc187B; the even-column branch subtracts $140 from X, the odd one adds $0F and
 * flips; then SpriteMisc1540 = 2 and RTS): 42 bytes, bank_01.asm:11788-11809. The shift is what the sprite does before
 * its first drawn frame, so a patched copy is flagged unverified (the interpreter still runs it). Covers the span
 * $01D6F9-$01D701 that holds the two constants (D110 call 4) and the rest of the routine around it. One cart, one machine.
 */
export const STOCK_INIT_LINE_GUIDED: Routine = {
  len: 42,
  sha: '7ccee5c902300dbb8daee9323528d7c8c3db9bc76c4c881ed2ffaa80f0077f42',
}
/** The ids whose INIT is InitLineGuidedSpr in the stock table (bank_01.asm:332-335). */
export const INIT_SHIFT_IDS: ReadonlySet<number> = new Set([0x65, 0x66, 0x67, 0x68])

/** Whether the routine at `at` is `stock`, by SHA-256 of its bytes. */
export const isStockRoutine = (rom: RomFile, at: number, stock: Routine): boolean =>
  fingerprint(rom.readAt(at, stock.len)) === stock.sha

export type GrinderGate = { ok: true } | { ok: false; reason: string }

/**
 * Instructions one run may take. Vanilla LineGrinder is 8 instructions or fewer (bank_01.asm:11837-11846) and
 * the dispatch to the end of the $67 arm adds about as many compares and branches, so 64 leaves room for a
 * hook; the calls count as one step each because their bodies are not run.
 */
const RUN_STEPS = 64
/** Distinct WRAM cells the handler may read before the sweep gives up: vanilla reads three, plus the sprite number. */
const MAX_CELLS = 16
const JSR = 0x20
const JSL = 0x22
const JMP = 0x4c
const JML = 0x5c
const hex = (n: number): string => n.toString(16).toUpperCase().padStart(6, '0')

type Bus = ReturnType<typeof smwMachine>['bus']

/** Names the routine at `at` by its bytes (read through the bus, so the run cache sees them); null when it is none of `routines`. */
function roleAt(bus: Bus, routines: DispatchShape['routines'], at: number): string | null {
  for (const [role, r] of Object.entries(routines)) {
    const bytes = Uint8Array.from({ length: r.len }, (_, i) => bus.read((at + i) & 0xffffff))
    if (fingerprint(bytes) === r.sha) return role
  }
  return null
}

/** Runs from `handler` in `slot` until the line step; null when the calls before it were `expect`'s, else why not. A call is stepped over. */
function drive(
  m: ReturnType<typeof smwMachine>,
  handler: number,
  slot: number,
  shape: DispatchShape,
  expect: readonly string[],
  lastOp: () => number,
  names: Map<number, string | null>,
): string | null {
  const { cpu, bus } = m
  nativeReset(cpu)
  cpu.x = slot
  cpu.pb = handler >>> 16
  cpu.pc = handler & 0xffff
  const seen: string[] = []
  const want = expect.slice(0, -1)
  for (let steps = 0; steps < RUN_STEPS; steps++) {
    try {
      cpu.step()
    } catch (e) {
      if (e instanceof Refusal) return e.message
      throw e
    }
    const op = lastOp()
    if (op !== JSR && op !== JSL && op !== JMP && op !== JML) continue
    const to = (cpu.pb << 16) | cpu.pc
    const at = mirror(to)
    if (!names.has(at)) names.set(at, roleAt(bus, shape.routines, to))
    const role = names.get(at)
    const call = op === JSR || op === JSL
    if (!role) {
      if (call) return `it calls $${hex(at)}, which is not a stock routine (unverified)`
      continue
    }
    if (role === 'step')
      return seen.join() === want.join() ? null : `it calls ${seen.join(', ') || 'nothing'} before the line step, out of order or missing: expected ${want.join(', ')}` // prettier-ignore
    if (!call) return `it jumps to the ${role} routine instead of calling it`
    // A call: take its return by hand, since the routine's own body is not part of this check.
    if (role !== 'prelude') seen.push(role)
    const ret = bus.read(cpu.s + 1) | (bus.read(cpu.s + 2) << 8)
    if (op === JSL) cpu.pb = bus.read(cpu.s + 3)
    cpu.s = (cpu.s + (op === JSL ? 3 : 2)) & 0xffff
    cpu.pc = (ret + 1) & 0xffff
  }
  return 'it did not reach the line step within the step budget'
}

/**
 * `number`: the sprite number the handler is for, seeded into `numberCell`,X; `shape`: the calls to expect.
 * Runs the handler in every slot, then again with each WRAM cell it read (found as it goes) set to every value,
 * so a hook that depends on a lock, a timer or a flag shows; every run must make the same calls in the same
 * order and write no register or SRAM.
 */
export function grinderDrawsBeforeSnap(
  rom: RomFile,
  handler: number,
  number: number,
  numberCell: number,
  shape: DispatchShape = VANILLA_DISPATCH,
): GrinderGate {
  const arm = shape.byId?.[number] ?? shape.arm
  const key = [handler, number, numberCell, ...arm, JSON.stringify(shape.routines)].join(',')
  return cache.lookup(rom, key) ?? sweep(rom, handler, number, numberCell, shape, arm, key)
}

const cache = new RunCache<GrinderGate>()

function sweep(
  rom: RomFile,
  handler: number,
  number: number,
  numberCell: number,
  shape: DispatchShape,
  arm: readonly string[],
  key: string,
): GrinderGate {
  let m: ReturnType<typeof smwMachine>
  try {
    m = smwMachine(rom)
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.message }
    throw e
  }
  const { bus } = m
  cache.track(bus, rom)
  const guard = bus.onInstruction
  let last = 0
  bus.onInstruction = (addr, op) => {
    guard?.(addr, op)
    last = op
  }
  const sram = watchSram(bus)
  const names = new Map<number, string | null>()
  const clean = bus.snapshot()
  /** One run; returns why not, and the cells it read. */
  const exec = (slot: number, poke?: [number, number]): { why: string | null; reads: number[] } => {
    bus.restore(clean)
    sram.writes = 0
    bus.inputs = new Set()
    bus.wram[numberCell + slot] = number
    if (poke) bus.wram[poke[0]] = poke[1]
    let why = drive(m, handler, slot, shape, arm, () => last, names)
    if (!why && bus.hwWrites.size) why = 'it writes a hardware register'
    if (!why && sram.writes > 0) why = 'it writes SRAM'
    const reads = [...bus.inputs].filter(c => c !== numberCell + slot)
    bus.inputs = null
    return { why, reads }
  }
  const verdict = (): GrinderGate => {
    const cells = new Set<number>()
    for (let slot = 0; slot < 12; slot++) {
      const r = exec(slot)
      if (r.why) return { ok: false, reason: `slot ${slot}: ${r.why}` }
      // Per-slot tables hold one cell per slot, so only the slot the sweep pokes (3) names its cells.
      if (slot === 3) for (const c of r.reads) cells.add(c)
    }
    const done = new Set<number>()
    while (done.size < cells.size) {
      if (cells.size > MAX_CELLS)
        return {
          ok: false,
          reason: `it reads more than ${MAX_CELLS} cells of WRAM before the line step`,
        }
      const cell = [...cells].find(c => !done.has(c))!
      done.add(cell)
      for (let v = 0; v < 256; v++) {
        const r = exec(3, [cell, v])
        if (r.why)
          return { ok: false, reason: `WRAM $${cell.toString(16)} = $${v.toString(16)}: ${r.why}` }
        for (const c of r.reads) cells.add(c)
      }
    }
    return { ok: true }
  }
  return cache.store(rom, key, bus, verdict())
}
