/**
 * Bounded reachability walk over a 65816 handler.
 *
 * Answers one question: which shared routines can this handler reach? It
 * decodes instructions, follows branches both ways, follows `JSR`/`JSL` to a
 * bounded depth, and stops at every return and at every construct whose
 * successor is not derivable from the bytes alone.
 *
 * NOT an emulator. No condition is evaluated and no memory is modelled. The
 * only machine state tracked is the M and X flags, because they alone decide
 * an instruction's length, and even that is incomplete: see
 * `docs/sprite-gfx-routine-reading.md` section 9 for the flag-state holes
 * and the DBR assumption, both of which can in principle desync the decoder
 * into a fabricated answer.
 *
 * What it declines:
 *
 *   - A computed jump (`JMP (abs)`, `JMP (abs,X)`, `JML [abs]`,
 *     `JSR (abs,X)`) names a table this walk cannot bound.
 *   - A call whose callee can reach no `RTS`/`RTL`/`RTI`. Control does not
 *     come back, so the bytes after the call site are not code. SMW's
 *     `JSL ExecutePtr` (bank_00.asm:847) is exactly this: it ends
 *     `JML [_0]` and eats an inline `dw` table as its argument. Deciding
 *     this from the callee's own shape rather than from a list of known
 *     addresses is what makes a relocated or hand-written equivalent
 *     decline too.
 *   - A call the probe could not decide, because the callee outran a
 *     probe ceiling. Undecided is not evidence that control comes back.
 *
 * Every stop degrades to the frozen floor in `spriteGfxRoutine`, which is
 * what makes refusing cheaper than guessing. One hole stays open: reaching
 * a return is not resuming at `callAt + len`, so the inline-argument idiom
 * that rewrites its own return address passes the probe. Vanilla
 * `ExecutePtr` does not use it. `docs/sprite-gfx-routine-reading.md`
 * section 2, "What the probe assumes".
 *
 * Evidence scope: run against all six cart files in `test/roms/`. Static
 * reads only; no emulator was run.
 */

import type { RomFile } from '../RomFile'

/** Operand width follows the M flag (8-bit accumulator immediates). */
const M = -1
/** Operand width follows the X flag (8-bit index immediates). */
const X = -2

/**
 * Total instruction length per opcode, or `M`/`X` where the immediate's
 * width is flag-dependent. The 65816 defines all 256 opcodes, so a decode
 * never meets an unknown byte; the only way to lose sync is a wrong flag.
 *
 * Twenty-three entries are never read: the returns, halts, jumps, branches
 * and `REP`/`SEP` all set the next address or add a literal instead. They
 * are kept correct as documentation, and no test can see a mutation to any
 * of them. `docs/sprite-gfx-routine-reading.md` section 8 lists them.
 */
const INSN_LEN: readonly number[] = [
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  1,
  M,
  1,
  1,
  3,
  3,
  3,
  4,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  1,
  3,
  1,
  1,
  3,
  3,
  3,
  4,
  3,
  2,
  4,
  2,
  2,
  2,
  2,
  2,
  1,
  M,
  1,
  1,
  3,
  3,
  3,
  4,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  1,
  3,
  1,
  1,
  3,
  3,
  3,
  4,
  1,
  2,
  2,
  2,
  3,
  2,
  2,
  2,
  1,
  M,
  1,
  1,
  3,
  3,
  3,
  4,
  2,
  2,
  2,
  2,
  3,
  2,
  2,
  2,
  1,
  3,
  1,
  1,
  4,
  3,
  3,
  4,
  1,
  2,
  3,
  2,
  2,
  2,
  2,
  2,
  1,
  M,
  1,
  1,
  3,
  3,
  3,
  4,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  1,
  3,
  1,
  1,
  3,
  3,
  3,
  4,
  2,
  2,
  3,
  2,
  2,
  2,
  2,
  2,
  1,
  M,
  1,
  1,
  3,
  3,
  3,
  4,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  1,
  3,
  1,
  1,
  3,
  3,
  3,
  4,
  X,
  2,
  X,
  2,
  2,
  2,
  2,
  2,
  1,
  M,
  1,
  1,
  3,
  3,
  3,
  4,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  1,
  3,
  1,
  1,
  3,
  3,
  3,
  4,
  X,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  1,
  M,
  1,
  1,
  3,
  3,
  3,
  4,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  1,
  3,
  1,
  1,
  3,
  3,
  3,
  4,
  X,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  1,
  M,
  1,
  1,
  3,
  3,
  3,
  4,
  2,
  2,
  2,
  2,
  3,
  2,
  2,
  2,
  1,
  3,
  1,
  1,
  3,
  3,
  3,
  4,
]

const OP_JSR = 0x20
const OP_JSL = 0x22
const OP_JMP_ABS = 0x4c
const OP_JML_LONG = 0x5c
const OP_BRA = 0x80
const OP_BRL = 0x82
const OP_REP = 0xc2
const OP_SEP = 0xe2
const OP_LDA_IMM = 0xa9
const OP_LDA_ABS_Y = 0xb9
const OP_LDA_ABS_X = 0xbd
const OP_LDA_ABS = 0xad
const OP_AND_IMM = 0x29
const OP_LDY_DP_X = 0xb4
const OP_STA_ABS = 0x8d
const OP_STA_ABS_X = 0x9d
const OP_STA_ABS_Y = 0x99
const CONDITIONAL_BRANCHES = [0x10, 0x30, 0x50, 0x70, 0x90, 0xb0, 0xd0, 0xf0]
/** `RTI`, `RTS`, `RTL`. Reaching one is what makes a call return. */
const RETURNS = [0x40, 0x60, 0x6b]
const COMPUTED_JUMPS = [0x6c, 0x7c, 0xdc, 0xfc]
/** `WAI`, `STP`. Neither comes back on its own. */
const HALTS = [0xcb, 0xdb]
/** Instructions that leave the accumulator holding something this walk
 *  cannot name. Anything not listed as a tracked load lands here. */
const A_CLOBBER_EXCEPTIONS = [OP_LDA_IMM, OP_LDA_ABS, OP_LDA_ABS_X, OP_LDA_ABS_Y, OP_AND_IMM]

/** Direct-page address of `SpriteNumber`. */
const SPRITE_NUMBER_DP = 0x9e

const DEFAULT_CALL_DEPTH = 3
export const DEFAULT_INSN_BUDGET = 6000
/** Distinct `(address, M, X)` states one probe may decode, counted across
 *  every branch side rather than along one line. Exhausting it REFUSES.
 *  The six carts need 159. */
export const DEFAULT_PROBE_BUDGET = 1500
/** Nested calls one probe may follow before refusing. Unbounded, this was
 *  the one recursion `callDepth` did not cover, and a 4000-call chain threw
 *  `RangeError` into the map build. The six carts need 5. */
export const DEFAULT_PROBE_DEPTH = 64

/** Why a path stopped without reaching a return. */
export type WalkStop =
  | 'nonReturningCall' // the callee reaches no RTS/RTL, so the next bytes are not code
  | 'computedJump' // JMP (abs) / JMP (abs,X) / JML [abs] / JSR (abs,X)
  | 'callDepth' // a JSR/JSL not descended into, depth budget spent
  | 'unreadable' // the address is not backed by ROM
  | 'insnBudget' // the whole walk hit its ceiling
  | 'probeBudget' // a call the probe ran out of instructions to decide
  | 'probeDepth' // a call nested past the probe's recursion bound

/** What the accumulator holds, where the walk can name it. */
export type AccumulatorSource =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'immediate'; readonly value: number }
  | { readonly kind: 'table'; readonly addr: number; readonly indexedByY: boolean }
  /** `LDA table,Y : AND #mask` - a one-bit test on a per-sprite table byte. */
  | {
      readonly kind: 'tableBitTest'
      readonly table: number
      readonly mask: number
      /** True when Y provably held `SpriteNumber` at the load. */
      readonly bySpriteNumber: boolean
    }

/**
 * A store to the OAM tile-number byte that the walk passed.
 *
 * `OAMTileNo` is $0202 and OAM entries are four bytes, so any absolute
 * store into $0200-$03FF at an offset congruent to 2 is a tile number.
 * Reported because the claim that `SPRITE_BASE_TILE_OVERRIDES` cannot be
 * derived this way is a measurement, and a measurement nobody can re-run
 * is just an assertion. `docs/sprite-gfx-routine-reading.md` section 6.
 */
export interface TileStore {
  readonly at: number
  readonly target: number
  readonly source: AccumulatorSource
}

/** A conditional branch the walk passed, with what the accumulator held. */
export interface BranchSite {
  /** Address of the branch opcode. */
  readonly at: number
  /** Address of the instruction after it: the not-taken path. */
  readonly notTakenAt: number
  /** Address the displacement names: the taken path. */
  readonly takenAt: number
  readonly accumulator: AccumulatorSource
}

/** A watched routine's first call site, and what A held when it was made. */
export interface CallSite {
  /** Address of the `JSR`/`JSL` opcode. */
  readonly at: number
  /** What the decoder could name in A at that instruction.
   *  `SubSprGfx0Entry1` (bank_01.asm:3855) reads A as its prop-group row.
   *  Taking it from the decoder rather than by matching `A9 xx` at
   *  `at - 2` is what stops `LDA $07A9` forging a row number. */
  readonly accumulator: AccumulatorSource
}

export interface WalkResult {
  /** Reached call targets that the caller asked to be watched for, keyed by
   *  the caller's own label, valued by the first call site that reached it. */
  readonly reached: ReadonlyMap<string, CallSite>
  readonly branches: readonly BranchSite[]
  /** In the order the walk passed them, which is the fall-through first. */
  readonly tileStores: readonly TileStore[]
  readonly stops: ReadonlySet<WalkStop>
  readonly instructionsDecoded: number
}

export interface WalkOptions {
  /** Call targets to report on. Keys and lookups are both folded to 23
   *  bits, so one entry per routine also matches its $80 bank mirror. */
  readonly watch: ReadonlyMap<number, string>
  /** How many `JSR`/`JSL` levels to descend. Exceeding it costs coverage,
   *  not soundness: the call is still probed for whether it returns. */
  readonly callDepth?: number
  readonly insnBudget?: number
  /** Per-call ceilings for the return-reachability probe. Exceeding either
   *  refuses the call rather than assuming it comes back. */
  readonly probeBudget?: number
  readonly probeDepth?: number
  /** Addresses the walk must not enter, folded the same way as `watch`.
   *  Used to cut one side of a branch. */
  readonly blocked?: ReadonlySet<number>
}

/** Bank-mirror-insensitive key: $83:A118 and $03:A118 are the same code.
 *  It also merges $7E/$7F with $FE/$FF, which is NOT a mirror pair
 *  (`loromToOffset` rejects the first as WRAM and maps the second as ROM).
 *  Nothing executes from $FE/$FF, so the collision is theoretical. */
const fold = (addr: number) => addr & 0x7fffff

const signed8 = (b: number) => (b > 0x7f ? b - 0x100 : b)
/** `BRL`'s displacement needs no sign extension: the sum is masked to 16
 *  bits, and a negative 16-bit displacement is congruent to its unsigned
 *  reading modulo $10000. An earlier sign-extending helper here could be
 *  removed without any test noticing, because it could not matter. */
const relative16 = (lo: number, hi: number) => lo | (hi << 8)
const stateKey = (addr: number, m: boolean, x: boolean) =>
  fold(addr) * 4 + (m ? 2 : 0) + (x ? 1 : 0)

interface Decoded {
  readonly op: number
  readonly len: number
  readonly bytes: Uint8Array
}

function decode(rom: RomFile, addr: number, m: boolean, x: boolean): Decoded | null {
  const bytes = rom.readAt(addr, 4)
  if (!bytes) return null
  const op = bytes[0]
  const raw = INSN_LEN[op]
  return { op, len: raw === M ? (m ? 2 : 3) : raw === X ? (x ? 2 : 3) : raw, bytes }
}

/** `JSR abs` stays in the current bank; `JSL long` names its own. */
function callTarget(op: number, addr: number, b: Uint8Array): number {
  return op === OP_JSR ? (addr & 0xff0000) | b[1] | (b[2] << 8) : b[1] | (b[2] << 8) | (b[3] << 16)
}

/** What a return-reachability probe concluded about one call. */
type ProbeVerdict =
  | 'returns' // some path from the callee reaches an RTS, RTL or RTI
  | 'noReturn' // every path ends somewhere else, so the call does not come back
  | 'budget' // undecided: the callee outran the probe's state budget
  | 'depth' // undecided: the callee nested past the probe's recursion bound

/** A verdict, and whether producing it consumed an unresolved assumption. */
interface ProbeResult {
  readonly verdict: ProbeVerdict
  /** True when the verdict rests on a call still being decided further up
   *  the stack. Such a verdict is correct for THIS caller and not for the
   *  next one, so it is never memoised. */
  readonly provisional: boolean
}

interface ProbeCtx {
  readonly rom: RomFile
  readonly memo: Map<number, ProbeVerdict>
  /** Keys whose verdict is currently being computed, i.e. the recursion
   *  stack. Meeting one is a cycle. */
  readonly onStack: Set<number>
  readonly budget: number
  readonly maxDepth: number
}

/**
 * Can control return from a call to `target`?
 *
 * Structural, not a list of addresses: a callee that reaches no `RTS`,
 * `RTL` or `RTI` transferred control somewhere else, so whatever follows
 * the call site is not the next instruction.
 *
 * A call already on the stack is ASSUMED to return, as a recursive
 * subroutine does, and every verdict resting on that assumption is left
 * out of the memo so the answer cannot depend on call order. A cycle that
 * closes WITHIN one probe is not a return; `seen` breaks it without one.
 * Both ceilings refuse rather than decide.
 * `docs/sprite-gfx-routine-reading.md` section 2.
 */
function probeReturns(
  ctx: ProbeCtx,
  target: number,
  m0: boolean,
  x0: boolean,
  depth: number,
): ProbeResult {
  const key = stateKey(target, m0, x0)
  const cached = ctx.memo.get(key)
  if (cached !== undefined) return { verdict: cached, provisional: false }
  if (ctx.onStack.has(key)) return { verdict: 'returns', provisional: true }
  // A depth refusal depends on how deep the caller already was, so it is
  // as context-bound as a cycle assumption and is memoised no more.
  if (depth >= ctx.maxDepth) return { verdict: 'depth', provisional: true }

  ctx.onStack.add(key)
  const seen = new Set<number>()
  const queue: Array<[number, boolean, boolean]> = [[target, m0, x0]]
  let steps = 0
  let provisional = false
  let sawReturn = false
  /** The first refusal met. Held rather than returned so that a return
   *  found on some other branch still wins: a refusal only decides the
   *  verdict when nothing was proved. */
  let refusal: ProbeVerdict | null = null

  outer: while (queue.length > 0) {
    let [addr, m, x] = queue.shift()!
    for (;;) {
      if (steps++ >= ctx.budget) {
        refusal ??= 'budget'
        break outer
      }
      const k = stateKey(addr, m, x)
      if (seen.has(k)) break
      seen.add(k)
      const d = decode(ctx.rom, addr, m, x)
      if (!d) break
      const { op, len, bytes } = d
      const bank = addr & 0xff0000

      if (RETURNS.includes(op)) {
        sawReturn = true
        break outer
      }
      if (HALTS.includes(op) || COMPUTED_JUMPS.includes(op)) break
      if (op === OP_REP || op === OP_SEP) {
        const set = op === OP_SEP
        if (bytes[1] & 0x20) m = set
        if (bytes[1] & 0x10) x = set
        addr += 2
        continue
      }
      if (op === OP_JSR || op === OP_JSL) {
        // The flags handed down are the ones in force AT the call, not the
        // ones the outermost caller had: the callee's own decode depends
        // on them exactly as this one does.
        const r = probeReturns(ctx, callTarget(op, addr, bytes), m, x, depth + 1)
        provisional ||= r.provisional
        if (r.verdict !== 'returns') {
          if (r.verdict !== 'noReturn') refusal ??= r.verdict
          break
        }
        addr += len
        continue
      }
      if (CONDITIONAL_BRANCHES.includes(op)) {
        queue.push([bank | ((addr + 2 + signed8(bytes[1])) & 0xffff), m, x])
        addr += 2
        continue
      }
      if (op === OP_BRA) {
        addr = bank | ((addr + 2 + signed8(bytes[1])) & 0xffff)
        continue
      }
      if (op === OP_BRL) {
        addr = bank | ((addr + 3 + relative16(bytes[1], bytes[2])) & 0xffff)
        continue
      }
      if (op === OP_JMP_ABS) {
        addr = bank | bytes[1] | (bytes[2] << 8)
        continue
      }
      if (op === OP_JML_LONG) {
        addr = bytes[1] | (bytes[2] << 8) | (bytes[3] << 16)
        continue
      }
      addr += len
    }
  }

  ctx.onStack.delete(key)
  const verdict: ProbeVerdict = sawReturn ? 'returns' : (refusal ?? 'noReturn')
  if (!provisional) ctx.memo.set(key, verdict)
  return { verdict, provisional }
}

/** The stop a refused or negative verdict becomes. */
const STOP_FOR: Readonly<Record<Exclude<ProbeVerdict, 'returns'>, WalkStop>> = {
  noReturn: 'nonReturningCall',
  budget: 'probeBudget',
  depth: 'probeDepth',
}

/**
 * Walk `entry` and report which watched routines it can reach.
 *
 * Paths are explored breadth-first from the fall-through, so a caller
 * reading `branches` sees them in the order a straight-line reader would.
 */
export function walkHandler(rom: RomFile, entry: number, opts: WalkOptions): WalkResult {
  const callDepth = opts.callDepth ?? DEFAULT_CALL_DEPTH
  const insnBudget = opts.insnBudget ?? DEFAULT_INSN_BUDGET
  const blocked = new Set([...(opts.blocked ?? [])].map(fold))

  const reached = new Map<string, CallSite>()
  const branches: BranchSite[] = []
  const tileStores: TileStore[] = []
  const stops = new Set<WalkStop>()
  const probeCtx: ProbeCtx = {
    rom,
    memo: new Map<number, ProbeVerdict>(),
    onStack: new Set<number>(),
    budget: opts.probeBudget ?? DEFAULT_PROBE_BUDGET,
    maxDepth: opts.probeDepth ?? DEFAULT_PROBE_DEPTH,
  }
  // Keyed on address AND flag state: the same bytes decoded under a
  // different M/X are a different instruction stream.
  const visited = new Set<number>()
  const pending: Array<[number, boolean, boolean, number]> = []
  let decoded = 0

  function path(start: number, m: boolean, x: boolean, depth: number): void {
    let addr = start
    let acc: AccumulatorSource = { kind: 'unknown' }
    let yHoldsSpriteNumber = false

    for (;;) {
      if (decoded >= insnBudget) {
        stops.add('insnBudget')
        return
      }
      if (blocked.has(fold(addr))) return
      const key = stateKey(addr, m, x)
      if (visited.has(key)) return
      visited.add(key)

      const d = decode(rom, addr, m, x)
      if (!d) {
        stops.add('unreadable')
        return
      }
      decoded++
      const { op, len, bytes } = d
      const bank = addr & 0xff0000

      if (op === OP_REP || op === OP_SEP) {
        const set = op === OP_SEP
        if (bytes[1] & 0x20) m = set
        if (bytes[1] & 0x10) x = set
        acc = { kind: 'unknown' }
        addr += 2
        continue
      }

      if (op === OP_JSR || op === OP_JSL) {
        const target = callTarget(op, addr, bytes)
        const label = opts.watch.get(fold(target))
        if (label !== undefined) {
          if (!reached.has(label)) reached.set(label, { at: addr, accumulator: acc })
        } else {
          if (depth < callDepth) path(target, m, x, depth + 1)
          else stops.add('callDepth')
          // Asked after the descent, so a callee that never comes back
          // still contributes whatever it reached before control left.
          const { verdict } = probeReturns(probeCtx, target, m, x, 0)
          if (verdict !== 'returns') {
            stops.add(STOP_FOR[verdict])
            return
          }
        }
        acc = { kind: 'unknown' }
        // A callee is free to reload Y, and this walk does not follow what
        // it did with it.
        yHoldsSpriteNumber = false
        addr += len
        continue
      }

      if (CONDITIONAL_BRANCHES.includes(op)) {
        const taken = bank | ((addr + 2 + signed8(bytes[1])) & 0xffff)
        branches.push({ at: addr, notTakenAt: addr + 2, takenAt: taken, accumulator: acc })
        // A cheap early-out only: `path` re-checks `blocked` on entry, so
        // dropping this line, or its `fold`, changes nothing a test can
        // see. Both mutations were planted and both survived.
        if (!blocked.has(fold(taken))) pending.push([taken, m, x, depth])
        addr += 2
        continue
      }

      if (op === OP_BRA) {
        addr = bank | ((addr + 2 + signed8(bytes[1])) & 0xffff)
        continue
      }
      if (op === OP_BRL) {
        addr = bank | ((addr + 3 + relative16(bytes[1], bytes[2])) & 0xffff)
        continue
      }
      if (op === OP_JMP_ABS) {
        addr = bank | bytes[1] | (bytes[2] << 8)
        continue
      }
      if (op === OP_JML_LONG) {
        addr = bytes[1] | (bytes[2] << 8) | (bytes[3] << 16)
        continue
      }
      if (RETURNS.includes(op) || HALTS.includes(op)) return
      if (COMPUTED_JUMPS.includes(op)) {
        stops.add('computedJump')
        return
      }

      if (op === OP_STA_ABS || op === OP_STA_ABS_X || op === OP_STA_ABS_Y) {
        const target = bytes[1] | (bytes[2] << 8)
        if (target >= 0x0200 && target < 0x0400 && (target & 3) === 2 && acc.kind !== 'unknown') {
          tileStores.push({ at: addr, target, source: acc })
        }
      }

      if (op === OP_LDY_DP_X && bytes[1] === SPRITE_NUMBER_DP) {
        yHoldsSpriteNumber = true
        addr += len
        continue
      }
      if (writesY(op)) yHoldsSpriteNumber = false

      if (op === OP_AND_IMM && m && acc.kind === 'table') {
        acc = {
          kind: 'tableBitTest',
          table: acc.addr,
          mask: bytes[1],
          bySpriteNumber: acc.indexedByY && yHoldsSpriteNumber,
        }
      } else if (op === OP_LDA_IMM && m) {
        acc = { kind: 'immediate', value: bytes[1] }
      } else if (op === OP_LDA_ABS || op === OP_LDA_ABS_X || op === OP_LDA_ABS_Y) {
        // Bank taken from the program counter, not from DBR, which this
        // walk does not model. See the doc's section 9.
        acc = {
          kind: 'table',
          addr: bank | bytes[1] | (bytes[2] << 8),
          indexedByY: op === OP_LDA_ABS_Y,
        }
      } else if (!A_CLOBBER_EXCEPTIONS.includes(op)) {
        // Conservative: anything not recognised as a tracked load is assumed
        // to leave the accumulator holding something unnameable. Overshooting
        // here costs coverage; undershooting would invent a value.
        acc = { kind: 'unknown' }
      }

      addr += len
    }
  }

  pending.push([entry, true, true, 0])
  for (let head = 0; head < pending.length; head++) {
    const [a, m, x, d] = pending[head]
    path(a, m, x, d)
  }

  return { reached, branches, tileStores, stops, instructionsDecoded: decoded }
}

/**
 * Opcodes that leave Y holding something other than what it held.
 *
 * `TXY` is $9B and writes Y; `TYX` is $BB and writes X. The two were
 * swapped here once, which let a `TXY` pass unnoticed and a bit test be
 * indexed by something that was not the sprite id.
 */
function writesY(op: number): boolean {
  return (
    op === 0xa0 ||
    op === 0xa4 ||
    op === 0xb4 ||
    op === 0xac ||
    op === 0xbc || // LDY
    op === 0xa8 ||
    op === 0xc8 ||
    op === 0x88 ||
    op === 0x7a ||
    op === 0x9b
  ) // TAY INY DEY PLY TXY
}
