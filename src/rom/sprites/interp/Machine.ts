/**
 * Machine.ts -- the pieces every caller of the 65816 core on SMW needs: a CPU
 * over a SpriteBus with the guard installed, a guard bound to one ROM, and a
 * write recorder. The call loop itself is src/rom/cpu/call.ts.
 */
import { Cpu65816 } from '../../cpu/Cpu65816'
import { Refusal } from '../../cpu/call'
import type { RomFile } from '../../RomFile'
import { mapperProblem, refusedOp } from './Guards'
import { romOffset, SpriteBus } from './SpriteBus'

const hex = (n: number): string => n.toString(16).toUpperCase().padStart(6, '0')

/** Bus `onInstruction` hook for one ROM: refuses BRK/COP/WDM/WAI/STP and any fetch the bus does not read from cart ROM (WRAM, registers, low halves, SRAM). */
export function romGuard(rom: RomFile): (addr: number, op: number) => void {
  const size = rom.romSize
  return (addr, op) => {
    if (romOffset(addr, size) === null)
      throw new Refusal(`execution left ROM code at $${hex(addr)}`)
    const bad = refusedOp(op)
    if (bad) throw new Refusal(`${bad} executed at $${hex(addr)}`)
  }
}

/** A SpriteBus over `rom` (LoROM only: a HiROM-flagged ROM throws `Refusal`) with the guard installed and `wram` copied in when given. */
export function smwMachine(rom: RomFile, wram?: Uint8Array): { bus: SpriteBus; cpu: Cpu65816 } {
  const problem = mapperProblem(rom)
  if (problem) throw new Refusal(problem)
  const bus = new SpriteBus(rom)
  bus.onInstruction = romGuard(rom)
  if (wram) bus.wram.set(wram.subarray(0, bus.wram.length))
  return { bus, cpu: new Cpu65816(bus) }
}

/**
 * Remembers the verdict of a sweep for one key, together with every ROM byte the sweep read, and answers again for
 * ANY ROM whose size and those bytes are the same (a run depends on nothing else, and the working copy hands out a
 * new `RomFile` per call, so identity is no key). A sweep takes hundreds of runs and a map asks for it once per
 * sprite, so without this the same answer is recomputed per sprite. At most `KEEP` distinct ROMs per key.
 */
export class RunCache<T> {
  private static readonly KEEP = 8
  private entries = new Map<string, { size: number; idx: number[]; vals: number[]; result: T }[]>()

  /** Starts recording the ROM bytes `bus` reads; call before the first run of the sweep. */
  track(bus: SpriteBus, rom: RomFile): void {
    bus.romSeen = new Uint8Array(rom.buffer.length)
    bus.romList = []
  }

  lookup(rom: RomFile, key: string): T | undefined {
    const hit = this.entries
      .get(key)
      ?.find(
        e => e.size === rom.buffer.length && e.idx.every((i, k) => rom.buffer[i] === e.vals[k]),
      )
    return hit?.result
  }

  store(rom: RomFile, key: string, bus: SpriteBus, result: T): T {
    const idx = [...bus.romList]
    const list = this.entries.get(key) ?? []
    list.push({ size: rom.buffer.length, idx, vals: idx.map(i => rom.buffer[i]!), result })
    if (list.length > RunCache.KEEP) list.shift()
    this.entries.set(key, list)
    return result
  }
}

const SRAM_MARK = 0xa5

/** Fills SRAM with a marker so `sramWritten` can see a store (the bus does not report SRAM writes to `recordWrites`). */
export function markSram(bus: SpriteBus): void {
  bus.sram.fill(SRAM_MARK)
}

/** True when a store put a byte other than the marker into SRAM since `markSram` (storing the marker itself is invisible). */
export function sramWritten(bus: SpriteBus): boolean {
  return bus.sram.some(v => v !== SRAM_MARK)
}

/**
 * Records the ordered writes a run makes as `address * 256 + value`: WRAM at
 * its 24-bit address ($7E0000 + offset), registers at their 16-bit address.
 * `keep` filters by that address. `stop()` puts the bus's hooks back.
 */
export function recordWrites(
  bus: SpriteBus,
  keep: (addr: number) => boolean = () => true,
): { log: number[]; stop(): void } {
  const log: number[] = []
  const prevW = bus.onWramWrite
  const prevH = bus.onHwWrite
  const add = (a: number, v: number) => {
    if (keep(a)) log.push(a * 256 + v)
  }
  bus.onWramWrite = (off, v) => {
    prevW?.(off, v)
    add(0x7e0000 + off, v)
  }
  bus.onHwWrite = (reg, v) => {
    prevH?.(reg, v)
    add(reg, v)
  }
  return {
    log,
    stop() {
      bus.onWramWrite = prevW
      bus.onHwWrite = prevH
    },
  }
}
