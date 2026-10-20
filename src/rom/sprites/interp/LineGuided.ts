/**
 * Whether a cart's line-guided sprite ($62, $64-$68) still dispatches in the vanilla order: draw, then the
 * line step. A hack that rewrites the handler gets the runner's generic rule. The gate RUNS the handler
 * from its MAIN pointer and watches which routines it calls, naming each call target by a SHA-256 of the
 * routine's code (the hook-signature style). The targets are read from the ROM's own operands, so no
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

/** A routine named by its first `len` bytes, hashed whole in one digest (SHA-256, lowercase hex). */
export interface Routine {
  len: number
  sha: string
  /**
   * Offsets of the bank byte of each long operand (JSL, JML, long loads) in the span. Before hashing, bit 7 of those bytes is
   * folded away, as `mirror` does for an address, so a ROM moved to FastROM banks ($81 for $01) is the same routine.
   */
  norm?: readonly number[]
}

/** SHA-256 of `bytes` with the FastROM bit of each long operand's bank byte folded, or null for a failed read. */
export function routineSha(bytes: Uint8Array | null, norm: readonly number[] = []): string | null {
  if (!bytes) return null
  const folded = Uint8Array.from(bytes)
  for (const o of norm) folded[o]! &= 0x7f
  return fingerprint(folded)
}

/**
 * The stock routines the dispatch CODE_01D9A7 reaches, by role, each hashed whole in one digest: the prelude
 * CODE_018063, platform draw CODE_01B2DF, rope draw CODE_01DC54, $67 draw CODE_01DC0B, $68 draw CODE_01DBD4, the
 * chainsaw draw (CODE_03C263 and the routine after it) and the line step CODE_01D74D. Code and the tables inside the
 * span are hashed; a table outside it is not. MarioSprInteractRt is not hashed: its slot takes any callee that is not
 * one of these. One cart (vanilla US), one machine.
 */
const STOCK: Readonly<Record<string, Routine>> = {
  prelude: { len: 41, sha: 'ee69fb268a54310db915010517a1018892562de721524bebb396d4fdc09a6fa9' },
  draw62: { len: 164, sha: '2554a26d468fd57bcb9b73c5f04b2667c0b1ef8d8ecb48e9c09ef7b18ca27604' },
  rope: { len: 125, sha: '7440e348ecf1b1bb0d1307252e3b649cb710f444fb90990e7907e39961232090' },
  draw67: { len: 48, sha: '5bf4e097322aa8b524cfb6671299ba6f1096aa6dbdf852a8c2ce6b09bdaa1827' },
  draw68: { len: 53, sha: 'e8accbeabae8d1be0c8dce077c50eb66b565088e0508438ce7e3f56eef7bb8aa' },
  chainsawDraw: {
    len: 118,
    sha: '7de4f593b0cbad322e3273a6c5663485b704cb849ae48334b4e24ec9a6f4a75d',
    norm: [116],
  },
  step: {
    len: 99,
    sha: 'a9ef48ec9b830805fd5532ab361e1fd0e59e1319c6b12426523a0fa6e77493f4',
    norm: [20],
  },
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
 * InitLineGuidedSpr, whole, one digest: bank_01.asm:11788-11809 ($01D6ED). A patched copy is flagged unverified (the
 * interpreter still runs it). Covers the span $01D6F9-$01D701 (D110 call 4) and the rest of the routine. One cart, one machine.
 */
export const STOCK_INIT_LINE_GUIDED: Routine = {
  len: 42,
  sha: '7ccee5c902300dbb8daee9323528d7c8c3db9bc76c4c881ed2ffaa80f0077f42',
}
/**
 * InitLineRope into InitLinePlat's tail, whole, one digest (bank_01.asm:11766-11783, $01D6C4): the INIT of $64.
 * One cart, one machine. $62's INIT is six bytes, too short for a digest of its own; one that moves it is unverified.
 */
export const STOCK_INIT_LINE_ROPE: Routine = {
  len: 41,
  sha: '1174e6fdaa0ab70c43b29a0e96692295f24fe789b6254fb9abf4bda8272950bd',
}

/** The INITs a line-guided sprite that moves at start-up may have; any other is unverified, whatever the id. */
export const STOCK_INITS: readonly Routine[] = [STOCK_INIT_LINE_GUIDED, STOCK_INIT_LINE_ROPE]

/** Whether the routine at `at` is one of `stocks`, by SHA-256 of its bytes. */
export const isStockRoutine = (rom: RomFile, at: number, stocks: readonly Routine[]): boolean =>
  stocks.some(r => routineSha(rom.readAt(at, r.len), r.norm) === r.sha)

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
    if (routineSha(bytes, r.norm) === r.sha) return role
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
      if (!call) continue
      // MarioSprInteractRt is not hashed (D126): whatever the interact slot calls, if it is not a routine named here,
      // fills the slot. A draw or the step placed there is a known role and fails the order check below.
      if (want[seen.length] !== 'interact' || shape.routines.interact)
        return `it calls $${hex(at)}, which is not a stock routine here (out of order, or unverified)`
      seen.push('interact')
      const back = bus.read(cpu.s + 1) | (bus.read(cpu.s + 2) << 8)
      if (op === JSL) cpu.pb = bus.read(cpu.s + 3)
      cpu.s = (cpu.s + (op === JSL ? 3 : 2)) & 0xffff
      cpu.pc = (back + 1) & 0xffff
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
