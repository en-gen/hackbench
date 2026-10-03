/**
 * Gamepad to SNES controller. Pure, no Theia imports.
 *
 * Every input source (keyboard, a pad) feeds a ControllerHub, which owns what
 * each port is holding: a button is down while ANY source holds it, only
 * edges reach the core, and one releaseAll lets go of everything (disconnect,
 * blur and core restart all end there, as HeldButtons does for the keyboard).
 * Button numbers are libretro RETRO_DEVICE_ID_JOYPAD ids, as in emulator-input.
 */
import type { PlayerAssignment } from './controller-settings'

/**
 * Standard Gamepad mapping by position, not by label: the bottom face button
 * is SNES B on any pad (Xbox A, PlayStation Cross), right is A, left is Y,
 * top is X. Indexes 6, 7 (triggers), 10, 11 (sticks) and 16 (guide) are unused.
 */
export const PAD_TO_BUTTON: Readonly<Record<number, number>> = {
  0: 0, // bottom -> B
  1: 8, // right -> A
  2: 1, // left -> Y
  3: 9, // top -> X
  4: 10, // LB -> L
  5: 11, // RB -> R
  8: 2, // back -> Select
  9: 3, // start -> Start
  12: 4, // d-pad up
  13: 5, // d-pad down
  14: 6, // d-pad left
  15: 7, // d-pad right
}

const STICK_THRESHOLD = 0.5

/** The part of a Gamepad this reads, so tests build one without a browser. */
export interface PadLike {
  connected: boolean
  mapping: string
  buttons: ReadonlyArray<{ pressed: boolean }>
  axes: ReadonlyArray<number>
}

/**
 * The joypad ids a pad is holding. A pad without the standard mapping has no
 * known layout and holds nothing: guessing would send the wrong button.
 */
export function padButtons(pad: PadLike): Set<number> {
  const held = new Set<number>()
  if (pad.mapping !== 'standard') return held
  for (const [index, id] of Object.entries(PAD_TO_BUTTON)) {
    if (pad.buttons[Number(index)]?.pressed) held.add(id)
  }
  const [x = 0, y = 0] = pad.axes
  if (x <= -STICK_THRESHOLD) held.add(6)
  else if (x >= STICK_THRESHOLD) held.add(7)
  if (y <= -STICK_THRESHOLD) held.add(4)
  else if (y >= STICK_THRESHOLD) held.add(5)
  return held
}

export class ControllerHub {
  /** Called when what a port is sending changes, for the live drawing. */
  onChange: (() => void) | undefined
  private readonly held = new Map<number, Map<string, Set<number>>>()

  constructor(private readonly send: (port: number, button: number, pressed: boolean) => void) {}

  private source(port: number, name: string): Set<number> {
    let sources = this.held.get(port)
    if (!sources) this.held.set(port, (sources = new Map()))
    let set = sources.get(name)
    if (!set) sources.set(name, (set = new Set()))
    return set
  }

  private down(port: number, button: number): boolean {
    for (const set of this.held.get(port)?.values() ?? []) if (set.has(button)) return true
    return false
  }

  /** What `port` is sending now, after every source is combined. */
  pressed(port: number): ReadonlySet<number> {
    const all = new Set<number>()
    for (const set of this.held.get(port)?.values() ?? []) set.forEach(b => all.add(b))
    return all
  }

  set(port: number, name: string, button: number, pressed: boolean): void {
    const next = new Set(this.source(port, name))
    if (pressed) next.add(button)
    else next.delete(button)
    this.replace(port, name, next)
  }

  /** Make `next` exactly what one source holds, sending only the edges. */
  replace(port: number, name: string, next: ReadonlySet<number>): void {
    const cur = this.source(port, name)
    const touched = new Set([...cur, ...next])
    let changed = false
    for (const button of touched) {
      if (cur.has(button) === next.has(button)) continue
      const before = this.down(port, button)
      if (next.has(button)) cur.add(button)
      else cur.delete(button)
      const after = this.down(port, button)
      if (before !== after) {
        this.send(port, button, after)
        changed = true
      }
    }
    if (changed) this.onChange?.()
  }

  releaseAll(): void {
    for (const port of [...this.held.keys()]) {
      for (const name of [...(this.held.get(port)?.keys() ?? [])]) {
        this.replace(port, name, new Set())
      }
    }
  }
}

/** Reads the pads each frame and hands each player's assigned pad to the hub. */
export class PadPoller {
  constructor(private readonly hub: ControllerHub) {}

  poll(pads: ReadonlyArray<PadLike | null>, players: readonly PlayerAssignment[]): void {
    players.forEach((player, port) => {
      const pad = player.pad === undefined ? null : (pads[player.pad] ?? null)
      this.hub.replace(port, 'pad', pad?.connected ? padButtons(pad) : new Set())
    })
  }
}
