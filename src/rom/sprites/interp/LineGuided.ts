/**
 * Whether a cart's line-guided grinder ($67) still dispatches in the vanilla order: draw, then the
 * line step. A hack that rewrites the handler gets the runner's generic rule. The gate RUNS the handler
 * from its MAIN pointer and watches which routines it calls; it does not read those routines' bodies.
 *
 * Per .claude/rules/rom-interpretation.md stock-code exception (added in #1030): the entry is fixed, the run has a
 * step budget, and a refusal names why. The entry chain: HandleSprite (fixed) -> its JMP operand -> CallSpriteMain
 * -> the MAIN pointer table -> the handler for sprite $67.
 */
import type { RomFile } from '../../RomFile'
import { mirror } from '../../addressing'
import { nativeReset, Refusal } from '../../cpu/call'
import { RunCache, smwMachine, watchSram } from './Machine'

/**
 * The routines the $67 arm calls or jumps to, in order, as FastROM-folded 24-bit addresses: the draw (CODE_01DC0B,
 * a call), the interact (MarioSprInteractRt, $01A7E4, a call) and the line step (CODE_01D74D, the jump that ends
 * the arm). SMWDisX bank_01.asm:12190-12204; label at 5385 for the interact.
 */
export interface DispatchShape {
  arm: readonly number[]
}

export const VANILLA_DISPATCH: DispatchShape = { arm: [0x01dc0b, 0x01a7e4, 0x01d74d] }

export type GrinderGate = { ok: true } | { ok: false; reason: string }

/**
 * Instructions one run may take. Vanilla LineGrinder is 8 instructions or fewer (bank_01.asm:11837-11846) and
 * the dispatch to the end of the $67 arm adds about as many compares and branches, so 64 leaves room for a
 * hook; the two calls count as one step each because their bodies are not run.
 */
const RUN_STEPS = 64
/** Distinct WRAM cells the handler may read before the sweep gives up: vanilla reads three, plus the sprite number. */
const MAX_CELLS = 16
const JSR = 0x20
const JSL = 0x22
const hex = (n: number): string => n.toString(16).toUpperCase().padStart(6, '0')

/** Runs from `handler` in `slot` until the arm is complete; null when it is, else why not. A call into the arm is stepped over. */
function drive(
  rom: RomFile,
  m: ReturnType<typeof smwMachine>,
  handler: number,
  slot: number,
  arm: readonly number[],
  lastOp: () => number,
): string | null {
  const { cpu, bus } = m
  nativeReset(cpu)
  cpu.x = slot
  cpu.pb = handler >>> 16
  cpu.pc = handler & 0xffff
  let k = 0
  for (let steps = 0; steps < RUN_STEPS; steps++) {
    try {
      cpu.step()
    } catch (e) {
      if (e instanceof Refusal) return e.message
      throw e
    }
    const at = mirror((cpu.pb << 16) | cpu.pc)
    const i = arm.indexOf(at)
    if (i < 0) continue
    if (i !== k) return `it reaches $${hex(at)} out of order`
    if (k === arm.length - 1)
      return rom.readByte((cpu.pb << 16) | cpu.pc) === null ? 'the line step is not in ROM' : null
    // A call: take its return by hand, since the routine's own body is not part of this check.
    const op = lastOp()
    if (op !== JSR && op !== JSL) return `it jumps to $${hex(at)} instead of calling it`
    const ret = bus.read(cpu.s + 1) | (bus.read(cpu.s + 2) << 8)
    if (op === JSL) cpu.pb = bus.read(cpu.s + 3)
    cpu.s = (cpu.s + (op === JSL ? 3 : 2)) & 0xffff
    cpu.pc = (ret + 1) & 0xffff
    k++
  }
  return 'it did not finish the arm within the step budget'
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
  const key = [handler, number, numberCell, ...shape.arm].join(',')
  return cache.lookup(rom, key) ?? sweep(rom, handler, number, numberCell, shape, key)
}

const cache = new RunCache<GrinderGate>()

function sweep(
  rom: RomFile,
  handler: number,
  number: number,
  numberCell: number,
  shape: DispatchShape,
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
  const clean = bus.snapshot()
  /** One run; returns why not, and the cells it read. */
  const exec = (slot: number, poke?: [number, number]): { why: string | null; reads: number[] } => {
    bus.restore(clean)
    sram.writes = 0
    bus.inputs = new Set()
    bus.wram[numberCell + slot] = number
    if (poke) bus.wram[poke[0]] = poke[1]
    let why = drive(rom, m, handler, slot, shape.arm, () => last)
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
      for (const c of r.reads) cells.add(c)
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
