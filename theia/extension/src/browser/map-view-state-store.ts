/**
 * One Maps tab's switch state (#435): the four switch palaces and the blue, silver and ON/OFF
 * switches, as a small flux-style store. The toolbar buttons only `dispatch`; every consumer
 * (the screen renderer, the collision overlay, the toolbar) subscribes to `onDidChange` and
 * decides for itself what a change means to it. One instance per tab, never shared: two open
 * maps keep their own toggles. State is replaced, never mutated, so a held `state` is a snapshot.
 *
 * Layers 1|2|3|S, the grid and the collision toggle are not in here yet.
 */
import { Emitter, Event } from '@theia/core/lib/common/event'
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

/**
 * What the collision overlay does with a change: the palaces and the blue P-switch change the map's
 * tiles, so its lines; the silver P-switch (not modelled) and ON/OFF (a char swap) do not.
 * On: ask again. Off: drop the lines as stale, so the next press fetches.
 */
export function collisionReaction(
  c: MapViewChange,
  overlayOn: boolean,
): 'none' | 'refetch' | 'stale' {
  if (!c.changed.some(k => k.group === 'flags' || k.key === 'blue')) return 'none'
  return overlayOn ? 'refetch' : 'stale'
}

export class MapViewStateStore {
  private current: SwitchState = {
    flags: { yellow: false, green: false, red: false, blue: false },
    switches: { blue: false, silver: false, onOff: false },
  }
  private readonly emitter = new Emitter<MapViewChange>()
  readonly onDidChange: Event<MapViewChange> = this.emitter.event

  get state(): SwitchState {
    return this.current
  }

  dispatch(action: MapViewAction): void {
    const { flags, switches } = this.current
    // A key the state does not have changes nothing, so nothing is announced.
    if (action.type === 'togglePalace' ? !(action.palace in flags) : !(action.key in switches))
      return
    const [next, changed]: [SwitchState, MapViewChange['changed']] =
      action.type === 'togglePalace'
        ? [
            { flags: { ...flags, [action.palace]: !flags[action.palace] }, switches },
            [{ group: 'flags', key: action.palace }],
          ]
        : [
            { flags, switches: { ...switches, [action.key]: !switches[action.key] } },
            [{ group: 'switches', key: action.key }],
          ]
    this.current = next
    this.emitter.fire({ state: next, changed })
  }

  dispose(): void {
    this.emitter.dispose()
  }
}
