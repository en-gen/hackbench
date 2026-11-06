/**
 * ClusterPath.ts -- the call path from a sprite list to a cluster spawn and its draw, CHECKED BY RUNNING THE
 * ROM'S OWN CODE (D126, FINGERPRINT MINIMUM rule 3: no code bytes, no digest under 24 unknown bytes).
 * Shared by the castle flames ($E6, #894) and the rotating ring ($E2/$E3, #983). Entries: the loader route
 * CODE_02A8C0 (bank_02.asm:5348-5355), the dispatcher CODE_02AAC0 (:5631-5641), the loop CODE_02F808 (:15942-15958).
 * GAP: the callers of these entries are not run (bank_01.asm:130, bank_02.asm:5290).
 * Stages, checks and evidence scope: docs/sprites/cluster-path-gate.md.
 */
import { formatAddr, mirror } from '../../addressing'
import { nativeReset, Refusal, runUntil, SENTINEL, type Regs } from '../../cpu/call'
import type { Cpu65816 } from '../../cpu/Cpu65816'
import { hex, hex4s } from '../../hex'
import type { RomFile } from '../../RomFile'
import { bytesAt, mapperProblem } from './Guards'
import { RunCache, smwMachine } from './Machine'
import type { SpriteBus } from './SpriteBus'

export const CLUSTER_NUMBER = 0x1892
const CLUSTER_SLOTS = 20
const ACTIVATE_CLUSTER = 0x18b8
const CUR_SPRITE_PROCESS = 0x15e9
/** CODE_02AAC0, the spawn dispatcher (bank_02.asm:5631). */
const SPAWN_ENTRY = 0x02aac0
/** LoadNextSprite (bank_02.asm:5267): where the route hands back to the loader's list loop. */
const LOAD_NEXT_SPRITE = 0x02a846
const BUDGET = 3000
/** The ExecutePtr routine is a few instructions; its span is generous because foreign code inside it is reported as a loop hook (a ROM that patches ExecutePtr gets the note). */
const EXEC_SPAN = 0x30
const OP_JSL = 0x22

/** The 3-byte call target of the dispatch JSL at `l.dispatch`; null when that byte is another opcode (no operand to read). */
export function dispatchTarget(rom: RomFile, l: ClusterLayout): number[] | null {
  const site = bytesAt(rom, l.dispatch, 4)
  return site && site[0] === OP_JSL ? site.slice(1) : null
}
/** Marks "this cell must be written by the code under test": a value no check expects. */
const UNSET = 0xa5
/** The eight conditional branches (BPL BMI BVC BVS BCC BCS BNE BEQ) are the opcodes with these five low bits; BRA is not. */
const isBranch = (op: number): boolean => (op & 0x1f) === 0x10

export type Span = readonly [from: number, to: number]

/**
 * Where a cart keeps the path code a run may fetch from. Addresses, not bytes; a test cart supplies its own.
 * `route` lists the route's spans, `entry` the dispatcher's, `loop` the cluster loop's, and `dispatch` is the
 * dispatch block: a long call to ExecutePtr, then the word table. `scratch` is the span of direct-page cells
 * ExecutePtr writes; `exits` the addresses a conditional branch may go to without the run fetching there
 * (the other spawns the dispatcher compares against, the next routine after the route's threshold).
 */
export interface ClusterLayout {
  route: readonly Span[]
  entry: Span
  loop: Span
  dispatch: number
  scratch: Span
  exits: readonly number[]
  /** The loop calls the dispatch block with a JSL (a mirror-bank test cart), so the draw ends in an RTL. */
  longCall?: boolean
}
/** CODE_02A8C0.., CODE_02A89A, CODE_02AAC0.., CODE_02F808.. and CODE_02F821 (bank_02.asm:5348, 5321-5322, 5631, 15942, 15962). */
export const VANILLA_LAYOUT: ClusterLayout = {
  // CODE_02A89A is the BRA the route's own BRA lands on, one hop short of LoadNextSprite (:5321-5322).
  route: [
    [0x02a8c0, 0x02a8d0],
    [0x02a89a, 0x02a89c],
  ],
  // Through the instruction after the last compare, which the last branch falls through to (ids below $E2).
  entry: [0x02aac0, 0x02aad7],
  loop: [0x02f808, 0x02f821],
  dispatch: 0x02f821,
  // ExecutePtr's _0.._3 (bank_00.asm:847-862).
  scratch: [0, 4],
  // CODE_02A8D0 (the route's `< $E1` branch); the dispatcher's targets that are not the sprite's own spawn: the
  // JMP before it (:5629), CODE_02AA6C, CODE_02AA8D and CODE_02AB11 (:5631-5641).
  exits: [0x02a8d0, 0x02aabd, 0x02aa6c, 0x02aa8d, 0x02ab11],
}

export interface ClusterPath {
  ids: readonly number[]
  spawn: number
  spawnLength: number
  type: number
  draw: number
  /** The name of the dispatcher stage (it differs per sprite). */
  dispatchWhat: string
  layout: ClusterLayout
}

export const ROUTE_WHAT = 'the loader route to the sprite spawn'
export const LOOP_WHAT = 'the cluster loop'

export function clusterPath(
  p: Omit<ClusterPath, 'layout'> & { layout?: ClusterLayout },
): ClusterPath {
  return { ...p, layout: p.layout ?? VANILLA_LAYOUT }
}

interface Stop {
  /** One address, or several of which any ends the stop (the loop's draw, or its return). */
  at: number | readonly number[]
  what: string
  check?: (cpu: Cpu65816, addr: number) => string | null
}
interface Failure {
  what: string
  why: string
}
interface Limits {
  spans: readonly Span[]
  /** Spans whose conditional branches are checked (not the spawn: its branches are its own). */
  checked: readonly Span[]
  exits: readonly number[]
  /** The WRAM offsets the code may write now. */
  allow: (off: number) => boolean
  /** The stage name for a failure right after a fetch at `addr`, when it is not the stop's. */
  stageAt?: (addr: number) => string | undefined
  /** Enter through a JSL frame whose return is SENTINEL. */
  frame?: boolean
  /** Continue from the CPU as it is. */
  resume?: boolean
}

/**
 * Deterministic WRAM states: seed 0 is all zero, the others pseudo-random fills of $0000-$1FFF (a route that
 * reads a cell the seeds differ on may fail one).
 */
function seedWram(w: Uint8Array, k: number): void {
  w.fill(0)
  if (k === 0) return
  let s = Math.imul(k, 0x9e3779b9) >>> 0
  for (let i = 0; i < 0x2000; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    w[i] = s >>> 24
  }
}
function clearCluster(w: Uint8Array): void {
  w.fill(0, CLUSTER_NUMBER, CLUSTER_NUMBER + CLUSTER_SLOTS)
}

const inSpans = (addr: number, spans: readonly Span[]): boolean => {
  const m = mirror(addr)
  return spans.some(([a, b]) => m >= mirror(a) && m < mirror(b))
}
const isStack = (off: number): boolean => off >= 0x100 && off < 0x200
const first = (at: number | readonly number[]): number => (typeof at === 'number' ? at : at[0]!)

/** Runs from `entry` until every stop is reached in order; the first thing that goes wrong is returned. */
function trace(
  bus: SpriteBus,
  cpu: Cpu65816,
  entry: number,
  regs: Regs,
  stops: readonly Stop[],
  o: Limits,
): Failure | null {
  const guard = bus.onInstruction
  const wguard = bus.onWramWrite
  const ats = stops.map(s => (typeof s.at === 'number' ? [s.at] : s.at).map(mirror))
  let idx = 0
  let done = false
  let prev = entry
  let failure: Failure | null = null
  const stage = (): string => o.stageAt?.(prev) ?? stops[idx]!.what
  const fail = (why: string): never => {
    failure = { what: stage(), why }
    throw new Refusal(why)
  }
  bus.onWramWrite = (off, v) => {
    if (!o.allow(off)) fail(`writes WRAM ${hex4s(off)}`)
    wguard?.(off, v)
  }
  bus.onInstruction = (addr, op) => {
    if (ats[idx]?.includes(mirror(addr))) {
      const bad = stops[idx]!.check?.(cpu, addr)
      if (bad) {
        failure = { what: stops[idx]!.what, why: bad }
        throw new Refusal(bad)
      }
      if (++idx === stops.length) {
        done = true
        throw new Refusal('path complete')
      }
    } else if (!inSpans(addr, o.spans)) fail(`runs code at ${formatAddr(addr)}`)
    else if (isBranch(op) && inSpans(addr, o.checked)) {
      const bank = addr & 0xff0000
      const next = bank | ((addr + 2) & 0xffff)
      const to = bank | ((addr + 2 + ((bus.read(addr + 1) << 24) >> 24)) & 0xffff)
      if (!inSpans(next, o.spans))
        fail(`a branch at ${formatAddr(addr)} falls through to ${formatAddr(next)}`)
      if (!inSpans(to, o.spans) && !o.exits.some(e => mirror(e) === mirror(to)))
        fail(`a branch at ${formatAddr(addr)} goes to ${formatAddr(to)}`)
    }
    prev = addr
    guard?.(addr, op)
  }
  try {
    if (!o.resume) {
      nativeReset(cpu)
      for (const k of ['a', 'x', 'y', 'db'] as const) if (regs[k] !== undefined) cpu[k] = regs[k]!
      if (o.frame) {
        for (const b of [0, (SENTINEL - 1) >> 8, (SENTINEL - 1) & 0xff]) {
          bus.write(cpu.s, b)
          cpu.s = (cpu.s - 1) & 0xffff
        }
      }
      cpu.pb = entry >>> 16
      cpu.pc = entry & 0xffff
    }
    const r = runUntil(cpu, BUDGET, () => false)
    if (done) return null
    if (failure) return failure
    const to = formatAddr(first(stops[idx]!.at))
    return {
      what: stage(),
      why:
        r.kind === 'budget'
          ? `did not reach ${to} in ${BUDGET} steps`
          : r.kind === 'refused'
            ? r.reason
            : `ended before ${to}`,
    }
  } finally {
    bus.onInstruction = guard
    bus.onWramWrite = wguard
  }
}

/** One setting of a run: the WRAM seed, X and Y at the route's entry, and what the activate flag holds before. */
type Setting = readonly [seed: number, x: number, y: number, marker: number]
/**
 * X is 0, low, $80 and up, and Y 0, 1, low and $80 and up, so a branch on a register flag goes both ways; the
 * marker is 0 and $FF (only a store makes either 1). The first is the baseline; seed 2, X 0, X $80 and Y 1 each have a PATH_HACKS row.
 */
const SETTINGS: readonly Setting[] = [
  [0, 5, 7, 0],
  [1, 0, 128, 255],
  [2, 128, 0, 0],
  [0, 5, 1, 255],
]

/** The route, dispatcher and spawn for sprite `id`: see the file comment. */
function routeRun(
  p: ClusterPath,
  id: number,
  [seed, x0, y0, marker]: Setting,
  bus: SpriteBus,
  cpu: Cpu65816,
): Failure | null {
  const w = bus.wram
  seedWram(w, seed)
  clearCluster(w)
  w[ACTIVATE_CLUSTER] = marker
  // Until the spawn runs, only the stack, the stream offset the route hands over and the flag may be written.
  let spawned = false
  const handedOff = (c: Cpu65816): string | null =>
    w[3] !== ((y0 - 1) & 0xff)
      ? 'the hand-off cell _3 is not the stream offset'
      : (c.a & 0xff) !== id
        ? `A is $${hex(c.a & 0xff)}, not the sprite id`
        : null
  const stops: Stop[] = [
    { at: SPAWN_ENTRY, what: ROUTE_WHAT, check: handedOff },
    {
      at: p.spawn,
      what: p.dispatchWhat,
      check: c => {
        spawned = true
        return (
          handedOff(c) ?? (w[ACTIVATE_CLUSTER] === 1 ? null : 'the activate flag is not stored')
        )
      },
    },
    {
      at: LOAD_NEXT_SPRITE,
      what: ROUTE_WHAT,
      check: c =>
        c.s === 0x1ff && c.x === x0 && c.y === y0 ? null : 'the stack, X or Y is not restored',
    },
  ]
  const l = p.layout
  const own = [p.spawn, p.spawn + p.spawnLength] as const
  const o: Limits = {
    spans: [...l.route, l.entry, own],
    checked: [...l.route, l.entry],
    exits: l.exits,
    allow: off => spawned || isStack(off) || off === 3 || off === ACTIVATE_CLUSTER,
    // A failure inside the spawn is the spawn's, not the loader route's.
    stageAt: a => (inSpans(a, [own]) ? p.dispatchWhat : undefined),
  }
  return trace(bus, cpu, l.route[0]![0], { a: id, x: x0, y: y0, db: 2 }, stops, o)
}

/** The loop with `filled` slots holding the type (all of them, or none), drawing each slot once; see the file comment. */
function loopRun(
  p: ClusterPath,
  filled: number,
  seed: number,
  bus: SpriteBus,
  cpu: Cpu65816,
): Failure | null {
  const w = bus.wram
  const l = p.layout
  seedWram(w, seed)
  clearCluster(w)
  w[CUR_SPRITE_PROCESS] = UNSET
  w.fill(p.type, CLUSTER_NUMBER, CLUSTER_NUMBER + filled)
  // Read through the bus so a cached verdict depends on these ROM bytes too.
  const isJsl = bus.read(l.dispatch) === OP_JSL
  const exec = isJsl
    ? bus.read(l.dispatch + 1) | (bus.read(l.dispatch + 2) << 8) | (bus.read(l.dispatch + 3) << 16)
    : 0
  const drawn: number[] = []
  let ended = false
  const stop: Stop = {
    at: [p.draw, SENTINEL],
    what: LOOP_WHAT,
    check: (c, addr) => {
      if (mirror(addr) !== SENTINEL) {
        drawn.push(c.x)
        return c.db !== 2
          ? `DB is $${hex(c.db)}, not 2`
          : w[CUR_SPRITE_PROCESS] !== c.x
            ? `slot ${c.x} is not the slot drawn`
            : drawn.length > filled
              ? 'the loop draws more slots than it has'
              : null
      }
      ended = true
      // Up from slot 0 or down from the last, each once.
      const down = drawn[0] !== 0
      return drawn.length !== filled || drawn.some((v, i) => v !== (down ? filled - 1 - i : i))
        ? `drew slots ${drawn.join(' ') || 'none'}`
        : c.db !== 0
          ? 'DB is not restored'
          : c.s !== 0x1ff
            ? 'the stack is not restored'
            : null
    },
  }
  const o: Limits = {
    spans: [
      l.loop,
      [l.dispatch, l.dispatch + 4],
      ...(isJsl ? [[exec, exec + EXEC_SPAN] as const] : []),
    ],
    checked: [l.loop],
    exits: l.exits,
    allow: off =>
      isStack(off) || off === CUR_SPRITE_PROCESS || (off >= l.scratch[0] && off < l.scratch[1]),
    frame: true,
  }
  let f = trace(bus, cpu, l.loop[0], { a: 0, x: 0x0b, y: 0x0c, db: 0 }, [stop], o)
  while (!f && !ended) {
    // The draw is not run; its RTS is, so the loop's own path back is.
    const at = cpu.s + 1
    cpu.pc = (bus.read(at) | (bus.read(at + 1) << 8)) + 1
    if (l.longCall) cpu.pb = bus.read(at + 2)
    cpu.s = (cpu.s + (l.longCall ? 3 : 2)) & 0xffff
    f = trace(bus, cpu, l.loop[0], {}, [stop], { ...o, resume: true })
  }
  return f
}

const cache = new RunCache<string[]>()

/** What of the path `p` is not the expected code, as stage names with the reason in parentheses; empty when it holds. */
export function pathMismatches(rom: RomFile, p: ClusterPath): string[] {
  // The mapper byte is not a ROM read of the run, so a cached verdict must not stand in for it.
  if (mapperProblem(rom)) return [ROUTE_WHAT, p.dispatchWhat, LOOP_WHAT]
  const key = JSON.stringify(p)
  const hit = cache.lookup(rom, key)
  if (hit) return [...hit]
  const { bus, cpu } = smwMachine(rom)
  cache.track(bus, rom)
  const bad = new Map<string, string>()
  const note = (f: Failure | null): void => {
    if (f && !bad.has(f.what)) bad.set(f.what, f.why)
  }
  for (const st of SETTINGS) {
    for (const id of p.ids) note(routeRun(p, id, st, bus, cpu))
    for (const filled of [CLUSTER_SLOTS, 0]) note(loopRun(p, filled, st[0], bus, cpu))
  }
  const out = [...bad].map(([what, why]) => `${what} (${why})`)
  // The caller appends to the verdict: hand out a copy, keep the cached one.
  return [...cache.store(rom, key, bus, out)]
}
