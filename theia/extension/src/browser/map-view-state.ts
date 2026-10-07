/**
 * The Maps tab's switch state and what its changes mean to the collision overlay (#435): types and
 * pure functions, no Theia import, so they are tested everywhere (the store that fires the events is
 * in `map-view-state-store.ts`, which needs Theia's `Emitter`).
 */
import type { SwitchFlagsDto, SwitchStateDto } from '../common/project-protocol'

export interface SwitchState {
  flags: SwitchFlagsDto
  switches: SwitchStateDto
}

export type MapViewAction =
  | { type: 'togglePalace'; palace: keyof SwitchFlagsDto }
  | { type: 'toggleSwitch'; key: keyof SwitchStateDto }

/** What changed: the new state and which keys flipped, tagged by which group they belong to. */
export interface MapViewChange {
  state: SwitchState
  changed: (
    { group: 'flags'; key: keyof SwitchFlagsDto } | { group: 'switches'; key: keyof SwitchStateDto }
  )[]
}

export const initialSwitchState = (): SwitchState => ({
  flags: { yellow: false, green: false, red: false, blue: false },
  switches: { blue: false, silver: false, onOff: false },
})

/** The next state and what flipped, or undefined when the action changes nothing (a key the state lacks). */
export function reduce(s: SwitchState, a: MapViewAction): MapViewChange | undefined {
  if (a.type === 'togglePalace') {
    if (!(a.palace in s.flags)) return undefined
    const state = { flags: { ...s.flags, [a.palace]: !s.flags[a.palace] }, switches: s.switches }
    return { state, changed: [{ group: 'flags', key: a.palace }] }
  }
  if (!(a.key in s.switches)) return undefined
  const state = { flags: s.flags, switches: { ...s.switches, [a.key]: !s.switches[a.key] } }
  return { state, changed: [{ group: 'switches', key: a.key }] }
}

/**
 * The part of the state the collision lines depend on: the palaces and the blue P-switch. The silver
 * P-switch also changes tiles ($12F becomes coin $2B under it) but is not modelled, so the overlay
 * does not follow it; ON/OFF swaps chars, not tiles.
 */
export const collisionKey = (s: SwitchState): string =>
  [s.flags.green, s.flags.yellow, s.flags.blue, s.flags.red, s.switches.blue].map(Number).join('')

/**
 * What the collision overlay does with a change that touches its key: drop the lines it holds (they
 * are for another state, and a reply still in flight is dropped too), ask again if the overlay is on,
 * and, when the toggle is disabled by a probe's refusal for the old state, re-run the cheap check
 * (that refusal was for a state that no longer is).
 */
export function collisionPlan(
  c: MapViewChange,
  overlayOn: boolean,
  refusedByProbe: boolean,
): { drop: boolean; refetch: boolean; recheck: boolean } {
  const relevant = c.changed.some(k => k.group === 'flags' || k.key === 'blue')
  return { drop: relevant, refetch: relevant && overlayOn, recheck: relevant && refusedByProbe }
}
