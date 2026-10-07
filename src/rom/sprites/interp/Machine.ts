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
