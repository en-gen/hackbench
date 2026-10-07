/**
 * Runs one SingleStepTests 65816 case against Cpu65816 and returns the
 * mismatches. Compares registers, flags and every memory byte the case lists
 * or the CPU wrote, and the ordered (address, value) bus writes against the
 * case's write cycles (MVN/MVP excepted). Reads, dummy cycles, timing and the
 * other bus lines are not compared (the core does not model them). Concessions:
 * MVN/MVP (data cut at 100 cycles) and, in emulation mode, an 8-bit RMW's
 * old-value write is collapsed. DISPUTED lists vectors excused for one named diff.
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
  /** [address, value | null, bus flags]; flags[3] is 'w' on a write cycle. */
  cycles?: [number, number | null, string][]
}

/**
 * Vectors the core deliberately disagrees with: Clark and Snes9x contradict
 * the data (see Cpu65816.push). SingleStep.test.ts skips them in the main run
 * and, when the data is present, asserts each one still MISMATCHES the core,
 * so an exception that stops being needed goes red.
 */
export interface Disputed {
  id: string
  /** Upstream SingleStepTests/65816 issue numbers. */
  issues: string
  /** Vector file (`{op}.e`) the exception applies to; `matches` also checks it via the vector name. */
  file: string
  expected: number
  matches(tc: StepCase): boolean
  /** True only when EVERY diff line is of the disputed kind; any other line is a real failure. */
  isDisputedDiff(diff: string[]): boolean
}
export const DISPUTED: Disputed[] = [
  {
    id: '(dp,X) pointer wrap, emulation, DL=0',
    issues: 'issue 3',
    file: 'e1.e',
    expected: 1,
    matches: tc => tc.name === 'e1 e 8669', // index 8668 in the file
    // The pointer is read from a different place, so A and its flags differ, nothing else.
    isDisputedDiff: diff =>
      diff.some(l => l.startsWith('a: ')) && diff.every(l => /^[ap]: /.test(l)),
  },
  {
    id: 'JSR (a,X) push wrap, emulation',
    issues: 'issues 6 and 7',
    file: 'fc.e',
    expected: 43,
    // The push of S and S-1 only differs when it crosses the page edge.
    matches: tc => tc.name.startsWith('fc e ') && (tc.initial.s & 0xff) === 0,
    // The low return byte lands at $00FF instead of $01FF: write order, and those two bytes only.
    isDisputedDiff: diff =>
      diff.some(l => l.startsWith('write order')) &&
      diff.every(l => l.startsWith('write order') || /^\[(ff|1ff)\]: /.test(l)),
  },
]

export function runCase(tc: StepCase, make: (bus: never) => Cpu65816 = defaultMake): string[] {
  const mem = new Map<number, number>(tc.initial.ram)
  const written = new Set<number>()
  const log: [number, number][] = []
  const bus = {
    read: (a: number) => mem.get(a) ?? 0,
    write: (a: number, v: number) => {
      mem.set(a, v)
      written.add(a)
      log.push([a, v])
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
    if (!want.has(addr))
      out.push(`[${addr.toString(16)}]: written ${mem.get(addr)!.toString(16)} but not in final`)
  if (tc.cycles && opcode !== 0x44 && opcode !== 0x54) {
    let w = tc.cycles.filter(c => c[2][3] === 'w').map(c => [c[0], c[1]] as [number, number])
    // Out of scope: in emulation mode an 8-bit RMW writes the old value, then
    // the new one, to the same address; the core writes only the new one.
    // Collapse any consecutive same-address pair there (emulation mode only).
    if (i.e) w = w.filter((c, k) => !(k + 1 < w.length && w[k + 1][0] === c[0]))
    const fmt = (l: [number, number][]) =>
      l.map(([a, v]) => `${a.toString(16)}=${v.toString(16)}`).join(' ')
    if (fmt(log) !== fmt(w)) out.push(`write order: got [${fmt(log)}] want [${fmt(w)}]`)
  }
  return out
}

function defaultMake(bus: never): Cpu65816 {
  return new Cpu65816(bus)
}

/**
 * Runs every case of one vector file; a DISPUTED vector is excused only for its disputed diff; a case that
 * throws counts as a failure, never as a pass.
 */
export function tally(
  cases: StepCase[],
  run: (tc: StepCase) => string[] = runCase,
): { failed: number; first: string[] } {
  let failed = 0
  const first: string[] = []
  for (const tc of cases) {
    let diff: string[]
    try {
      diff = run(tc)
    } catch (e) {
      diff = [String(e)]
    }
    // A disputed vector may differ from the core, but only in its disputed kind.
    if (DISPUTED.some(d => d.matches(tc) && d.isDisputedDiff(diff))) continue
    if (diff.length) {
      failed++
      if (first.length < 3) first.push(`${tc.name}: ${diff.join('; ')}`)
    }
  }
  return { failed, first }
}
