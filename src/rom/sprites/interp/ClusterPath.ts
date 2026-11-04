/**
 * ClusterPath.ts -- the call path from a level's sprite list to a cluster spawn and to its draw, CHECKED BY
 * RUNNING THE ROM'S OWN CODE on the core (D126, FINGERPRINT MINIMUM rule 3: no code bytes, no digest under
 * 24 unknown bytes). Shared by the castle flames ($E6, #894) and the rotating ring ($E2/$E3, #983).
 *
 * Runs, each over three WRAM states and each ended at a named address:
 * - the loader route (CODE_02A8C0, bank_02.asm:5348-5355), entered with the sprite id in A, a stream offset
 *   in Y and a hand-off in _0.._2, must reach the spawn dispatcher (CODE_02AAC0, :5631-5641) with the
 *   hand-off kept and `_3` set; the dispatcher must reach the spawn with the activate flag stored and the id
 *   still in A; the spawn must return into the route, which must hand back to LoadNextSprite (:5267) with
 *   the stack, X and Y as it found them. Every id of the cart is run.
 * - the cluster loop (CODE_02F808, :15942-15958), entered with DB wrong, must reach the draw of the type for
 *   a sprite in slot 0 and in slot 19, with DB = 2, X = the slot and CurSpriteProcess = the slot.
 * - the same loop with no cluster sprite must return and restore DB.
 *
 * Every instruction fetch between an entry and its target must lie in `ClusterLayout`'s spans (the route,
 * the dispatcher, the spawn, the loop, the dispatch block and ExecutePtr). A fetch anywhere else is a hook
 * or a wrapper: the stage is flagged and the address named. A hacked path is not followed past that point.
 * Evidence scope: vanilla USA ROM, one machine, 2026-11-03; the three corpus hacks that hook the loop are
 * pinned in ClusterPathGate.corpus.test.ts.
 */
import { formatAddr, mirror } from '../../addressing'
import { callSubroutine, nativeReset, Refusal, runUntil, type Regs } from '../../cpu/call'
import type { Cpu65816 } from '../../cpu/Cpu65816'
import type { RomFile } from '../../RomFile'
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
/** The ExecutePtr routine is a few instructions; its span is generous because its shape is checked on its own. */
const EXEC_SPAN = 0x30
/** Marks "this cell must be written by the code under test": a value no check expects. */
const UNSET = 0xa5
const HAND_OFF = [0x91, 0x42, 0x17]
const X0 = 5
const Y0 = 7

export type Span = readonly [from: number, to: number]

/**
 * Where a cart keeps the path code a run may fetch from. Addresses, not bytes; a test cart supplies its own.
 * `route` lists the route's spans, `entry` the dispatcher's, `loop` the cluster loop's, and `dispatch` is the
 * dispatch block: a long call to ExecutePtr, then the word table.
 */
export interface ClusterLayout {
  route: readonly Span[]
  entry: Span
  loop: Span
  dispatch: number
}
/** CODE_02A8C0.., CODE_02A89A, CODE_02AAC0.., CODE_02F808.. and CODE_02F821 (bank_02.asm:5348, 5631, 15942, 15962). */
export const VANILLA_LAYOUT: ClusterLayout = {
  // CODE_02A89A is the BRA the route's own BRA lands on, one hop short of LoadNextSprite (:5285-5290).
  route: [
    [0x02a8c0, 0x02a8d0],
    [0x02a89a, 0x02a89c],
  ],
  entry: [0x02aac0, 0x02aad5],
  loop: [0x02f808, 0x02f821],
  dispatch: 0x02f821,
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
  at: number
  what: string
  check?: (cpu: Cpu65816) => string | null
}
interface Failure {
  what: string
  why: string
}

/** Deterministic WRAM states: all zero, and two pseudo-random fills of the low pages (a route that depends on game state fails one). */
const SEEDS = [0, 1, 2] as const
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
const hex = (n: number): string => n.toString(16).toUpperCase()

const inSpans = (addr: number, spans: readonly Span[]): boolean => {
  const m = mirror(addr)
  return spans.some(([a, b]) => m >= mirror(a) && m < mirror(b))
}

/** Runs from `entry` until every stop is reached in order; the first thing that goes wrong is returned. */
function trace(
  bus: SpriteBus,
  cpu: Cpu65816,
  entry: number,
  regs: Regs,
  stops: readonly Stop[],
  spans: readonly Span[],
): Failure | null {
  const guard = bus.onInstruction
  let idx = 0
  let done = false
  let failure: Failure | null = null
  const fail = (why: string): never => {
    failure = { what: stops[idx]!.what, why }
    throw new Refusal(why)
  }
  bus.onInstruction = (addr, op) => {
    const stop = stops[idx]
    if (stop && mirror(addr) === mirror(stop.at)) {
      const bad = stop.check?.(cpu)
      if (bad) fail(bad)
      if (++idx === stops.length) {
        done = true
        throw new Refusal('path complete')
      }
    } else if (!inSpans(addr, spans)) fail(`runs code at ${formatAddr(addr)}`)
    guard?.(addr, op)
  }
  try {
    nativeReset(cpu)
    for (const k of ['a', 'x', 'y', 'db'] as const) if (regs[k] !== undefined) cpu[k] = regs[k]!
    cpu.pb = entry >>> 16
    cpu.pc = entry & 0xffff
    const r = runUntil(cpu, BUDGET, () => false)
    if (done) return null
    if (failure) return failure
    const stop = stops[idx]!
    if (r.kind === 'budget') {
      return { what: stop.what, why: `did not reach ${formatAddr(stop.at)} in ${BUDGET} steps` }
    }
    return {
      what: stop.what,
      why: r.kind === 'refused' ? r.reason : `ended before ${formatAddr(stop.at)}`,
    }
  } finally {
    bus.onInstruction = guard
  }
}

/** The route, dispatcher and spawn for sprite `id`: see the file comment. */
function routeRun(
  p: ClusterPath,
  id: number,
  seed: number,
  bus: SpriteBus,
  cpu: Cpu65816,
): Failure | null {
  const w = bus.wram
  seedWram(w, seed)
  clearCluster(w)
  w.set(HAND_OFF, 0)
  w[ACTIVATE_CLUSTER] = UNSET
  const handedOff = (c: Cpu65816): string | null =>
    HAND_OFF.some((v, i) => w[i] !== v)
      ? 'the hand-off cells _0.._2 changed'
      : w[3] !== Y0 - 1
        ? 'the hand-off cell _3 is not the stream offset'
        : (c.a & 0xff) !== id
          ? `A is $${hex(c.a & 0xff)}, not the sprite id`
          : null
  const stops: Stop[] = [
    { at: SPAWN_ENTRY, what: ROUTE_WHAT, check: handedOff },
    {
      at: p.spawn,
      what: p.dispatchWhat,
      check: c =>
        handedOff(c) ?? (w[ACTIVATE_CLUSTER] === 1 ? null : 'the activate flag is not stored'),
    },
    {
      at: LOAD_NEXT_SPRITE,
      what: ROUTE_WHAT,
      check: c =>
        c.s === 0x1ff && c.x === X0 && c.y === Y0 ? null : 'the stack, X or Y is not restored',
    },
  ]
  const l = p.layout
  const spans = [...l.route, l.entry, [p.spawn, p.spawn + p.spawnLength] as const]
  return trace(bus, cpu, l.route[0]![0], { a: id, x: X0, y: Y0, db: 2 }, stops, spans)
}

/** The loop with a sprite of the type in `slot`, or (slot < 0) with none, when it must simply return. */
function loopRun(
  p: ClusterPath,
  slot: number,
  seed: number,
  bus: SpriteBus,
  cpu: Cpu65816,
): Failure | null {
  const w = bus.wram
  const l = p.layout
  seedWram(w, seed)
  clearCluster(w)
  w[CUR_SPRITE_PROCESS] = UNSET
  if (slot >= 0) w[CLUSTER_NUMBER + slot] = p.type
  // Read through the bus so a cached verdict depends on these ROM bytes too.
  const exec =
    bus.read(l.dispatch + 1) | (bus.read(l.dispatch + 2) << 8) | (bus.read(l.dispatch + 3) << 16)
  const spans: Span[] = [l.loop, [l.dispatch, l.dispatch + 4], [exec, exec + EXEC_SPAN]]
  if (slot >= 0) {
    const check = (c: Cpu65816): string | null =>
      c.db !== 2
        ? `DB is $${hex(c.db)}, not 2`
        : c.x !== slot || w[CUR_SPRITE_PROCESS] !== slot
          ? `slot ${slot} is not the slot drawn`
          : null
    return trace(
      bus,
      cpu,
      l.loop[0],
      { a: 0, x: 0, y: 0, db: 0 },
      [{ at: p.draw, what: LOOP_WHAT, check }],
      spans,
    )
  }
  const guard = bus.onInstruction
  let foreign: string | null = null
  bus.onInstruction = (addr, op) => {
    if (!inSpans(addr, spans)) {
      foreign = `runs code at ${formatAddr(addr)}`
      throw new Refusal(foreign)
    }
    guard?.(addr, op)
  }
  try {
    const r = callSubroutine(cpu, l.loop[0], { kind: 'jsl', maxSteps: BUDGET, regs: { db: 0 } })
    if (foreign) return { what: LOOP_WHAT, why: foreign }
    if (r.kind !== 'returned')
      return { what: LOOP_WHAT, why: `an empty loop does not return (${r.kind})` }
    return cpu.db === 0 ? null : { what: LOOP_WHAT, why: 'DB is not restored' }
  } finally {
    bus.onInstruction = guard
  }
}

const cache = new RunCache<string[]>()

/** What of the path `p` is not the expected code, as stage names with the reason in parentheses; empty when it holds. */
export function pathMismatches(rom: RomFile, p: ClusterPath): string[] {
  const key = JSON.stringify(p)
  const hit = cache.lookup(rom, key)
  if (hit) return [...hit]
  let machine: ReturnType<typeof smwMachine>
  try {
    machine = smwMachine(rom)
  } catch (e) {
    if (e instanceof Refusal) return [ROUTE_WHAT, p.dispatchWhat, LOOP_WHAT]
    throw e
  }
  const { bus, cpu } = machine
  cache.track(bus, rom)
  const bad = new Map<string, string>()
  const note = (f: Failure | null): void => {
    if (f && !bad.has(f.what)) bad.set(f.what, f.why)
  }
  for (const seed of SEEDS) {
    for (const id of p.ids) note(routeRun(p, id, seed, bus, cpu))
    for (const slot of [0, CLUSTER_SLOTS - 1, -1]) note(loopRun(p, slot, seed, bus, cpu))
  }
  const out = [...bad].map(([what, why]) => `${what} (${why})`)
  // The caller appends to the verdict: hand out a copy, keep the cached one.
  return [...cache.store(rom, key, bus, out)]
}
