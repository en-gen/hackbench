/**
 * Runs one SingleStepTests 65816 case against Cpu65816 and returns the
 * mismatches. Compares registers, flags and every memory byte the case lists
 * or the CPU wrote; cycle / bus-line data is ignored (the core does not model
 * timing).
 */
import { Cpu65816 } from '../../../src/rom/cpu/Cpu65816'

export interface StepState {
  pc: number
  s: number
  p: number
  a: number
  x: number
  y: number
  dbr: number
  d: number
  pbr: number
  e: number
  ram: [number, number][]
}
export interface StepCase {
  name: string
  initial: StepState
  final: StepState
}

export function runCase(tc: StepCase, make: (bus: never) => Cpu65816 = defaultMake): string[] {
  const mem = new Map<number, number>(tc.initial.ram)
  const written = new Set<number>()
  const bus = {
    read: (a: number) => mem.get(a) ?? 0,
    write: (a: number, v: number) => {
      mem.set(a, v)
      written.add(a)
    },
  }
  const cpu = make(bus as never)
  const i = tc.initial
  cpu.e = !!i.e
  cpu.p = i.p
  cpu.a = i.a
  cpu.x = i.x
  cpu.y = i.y
  cpu.s = i.s
  cpu.d = i.d
  cpu.db = i.dbr
  cpu.pb = i.pbr
  cpu.pc = i.pc
  const opcode = mem.get((i.pbr << 16) | i.pc) ?? 0
  if (opcode === 0x44 || opcode === 0x54) {
    // The data cuts MVN/MVP at 100 bus cycles: 14 whole byte moves (7 cycles
    // each), then the 15th iteration has fetched only its opcode and first
    // operand (pc + 2). If A wraps first, the instruction completes (pc + 3).
    for (let n = 0; n < 14 && cpu.pc === i.pc; n++) cpu.step()
    if (cpu.pc === i.pc) cpu.pc = (i.pc + 2) & 0xffff
  } else cpu.step()
  const f = tc.final
  const got: Record<string, number> = {
    pc: cpu.pc,
    s: cpu.s,
    p: cpu.p,
    a: cpu.a,
    x: cpu.x,
    y: cpu.y,
    dbr: cpu.db,
    d: cpu.d,
    pbr: cpu.pb,
    e: +cpu.e,
  }
  const out: string[] = []
  for (const k of Object.keys(got) as (keyof StepState)[])
    if (got[k] !== f[k])
      out.push(`${k}: got ${got[k].toString(16)} want ${(f[k] as number).toString(16)}`)
  const want = new Map(f.ram)
  for (const [addr, v] of want)
    if ((mem.get(addr) ?? 0) !== v)
      out.push(
        `[${addr.toString(16)}]: got ${(mem.get(addr) ?? 0).toString(16)} want ${v.toString(16)}`,
      )
  for (const addr of written)
    if (!want.has(addr) && mem.get(addr) !== 0)
      out.push(`[${addr.toString(16)}]: written ${mem.get(addr)!.toString(16)} but not in final`)
  return out
}

function defaultMake(bus: never): Cpu65816 {
  return new Cpu65816(bus)
}
