/**
 * call.ts -- run one routine on the 65816 core to its return, and say how it
 * ended. One loop for every caller (level loader, sprite runner, collision
 * probe, replay tests) so the sentinel, stack and budget checks cannot drift.
 * No SMW knowledge, no shell.
 *
 * Evidence scope: exercised by synthetic code in
 * test/suite/unit/sprites/callHelpers.test.ts.
 */
import type { Cpu65816 } from './Cpu65816'

/** Thrown from a bus `onInstruction` hook to stop a run; the message is the reason shown to the user. */
export class Refusal extends Error {}

/** Register values a call starts from; omitted fields keep the CPU's current value (P and D/DB are reset by `nativeReset`). */
export interface Regs {
  a?: number
  x?: number
  y?: number
  d?: number
  db?: number
  p?: number
}

/** How one routine ended. `steps` is the number of instructions executed. */
export type CallResult =
  | { kind: 'returned'; steps: number }
  | { kind: 'budget'; steps: number }
  | { kind: 'refused'; reason: string; at: number; steps: number }
  | { kind: 'unbalanced'; s: number; expected: number; pb: number; expectedPb: number; steps: number } // prettier-ignore

/**
 * Return address pushed under each call; the call is done when it is popped. In
 * the low half of a bank, which no cart code executes (the guard refuses it), so
 * legitimate code cannot be mistaken for a return: $FF00 is real code in some
 * banks (one run of sprite $29 INIT reached PC=$FF00 at S=$01F4, vanilla, one machine).
 */
const SENTINEL = 0x7f00

/** Native mode, P (default $34: 8-bit M and X, IRQ off), S=$01FF, D=DB=0, not halted: the state every SMW caller starts from. */
export function nativeReset(cpu: Cpu65816, p = 0x34): void {
  cpu.e = false
  cpu.p = p
  cpu.s = 0x1ff
  cpu.d = 0
  cpu.db = 0
  cpu.stopped = false
  cpu.waiting = false
}

/**
 * Steps until `until(cpu)` holds after an instruction, `maxSteps` is spent, or
 * a bus hook throws `Refusal`. For code entered mid-routine from a recorded
 * register set, where no return frame exists. Never throws a Refusal.
 */
export function runUntil(
  cpu: Cpu65816,
  maxSteps: number,
  until: (cpu: Cpu65816) => boolean,
  stop?: (cpu: Cpu65816) => CallResult | null,
): CallResult {
  let steps = 0
  while (steps < maxSteps) {
    try {
      cpu.step()
    } catch (e) {
      if (e instanceof Refusal) return { kind: 'refused', reason: e.message, at: (cpu.pb << 16) | cpu.pc, steps } // prettier-ignore
      throw e
    }
    steps++
    if (until(cpu)) return { kind: 'returned', steps }
    const bad = stop?.(cpu)
    if (bad) return { ...bad, steps }
  }
  return { kind: 'budget', steps }
}

/**
 * Pushes a sentinel return (a JSR or JSL frame, then `extra` bytes such as a
 * PHB), applies `regs` after `nativeReset`, and runs `entry` to its return or
 * `maxSteps`. Checks PC, PB and S when the sentinel is reached; a return of the
 * wrong kind (RTS from a JSL frame) or an unbalanced stack is `unbalanced`, and
 * so is any pop above the frame before the sentinel is reached (PHA then RTS
 * would otherwise run whatever sits at the stray address). Never throws a
 * Refusal.
 */
export function callSubroutine(
  cpu: Cpu65816,
  entry: number,
  opts: {
    kind: 'jsr' | 'jsl'
    maxSteps: number
    regs?: Regs
    extra?: number[]
  },
): CallResult {
  const r = opts.regs ?? {}
  nativeReset(cpu, r.p)
  if (r.a !== undefined) cpu.a = r.a
  if (r.x !== undefined) cpu.x = r.x
  if (r.y !== undefined) cpu.y = r.y
  if (r.d !== undefined) cpu.d = r.d
  if (r.db !== undefined) cpu.db = r.db
  const push = (v: number) => {
    cpu.bus.write(cpu.s, v)
    cpu.s = (cpu.s - 1) & 0xffff
  }
  const s0 = cpu.s
  const pb = entry >>> 16
  // RTS keeps the entry's bank; RTL pulls the bank byte pushed here.
  const returnPb = opts.kind === 'jsl' ? 0 : pb
  if (opts.kind === 'jsl') push(0x00)
  push((SENTINEL - 1) >> 8)
  push((SENTINEL - 1) & 0xff)
  const sFrame = cpu.s
  for (const b of opts.extra ?? []) push(b)
  cpu.pb = pb
  cpu.pc = entry & 0xffff
  const unbalanced = (c: Cpu65816): CallResult => ({ kind: 'unbalanced', s: c.s, expected: s0, pb: c.pb, expectedPb: returnPb, steps: 0 }) // prettier-ignore
  const done = (c: Cpu65816): boolean => c.pc === SENTINEL && c.s === s0 && c.pb === returnPb
  return runUntil(cpu, opts.maxSteps, done, c => {
    const atSentinel = c.pc === SENTINEL && (c.s !== s0 || c.pb !== returnPb)
    return atSentinel || c.s > sFrame ? unbalanced(c) : null
  })
}

const hex = (n: number, w: number): string => n.toString(16).toUpperCase().padStart(w, '0')

/** The reason text for a result that did not return, or null when it returned; one wording for every caller. */
export function describe(r: CallResult, budget: number): string | null {
  switch (r.kind) {
    case 'returned':
      return null
    case 'budget':
      return `step budget of ${budget} spent; the routine waits on state the seed lacks`
    case 'refused':
      return r.reason
    case 'unbalanced':
      if (r.s === r.expected && r.pb === r.expectedPb)
        return 'the routine popped its own return address and kept running'
      return r.s === r.expected
        ? `returned into bank $${hex(r.pb, 2)} instead of $${hex(r.expectedPb, 2)}; the call frame was not unwound`
        : `stack unbalanced at return (S=$${hex(r.s, 4)}, expected $${hex(r.expected, 4)})`
  }
}
