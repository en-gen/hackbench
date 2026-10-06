/**
 * One Maps tab's switch-state store (#435): a small flux-style store over `map-view-state.ts`. The
 * toolbar buttons only `dispatch`; every consumer (the screen renderer, the collision overlay, the
 * toolbar) subscribes to `onDidChange` and decides for itself what a change means to it. One instance
 * per tab, never shared: two open maps keep their own toggles. State is replaced, never mutated.
 *
 * Layers 1|2|3|S, the grid and the collision toggle are not in here yet.
 */
import { Emitter, Event } from '@theia/core/lib/common/event'
import {
  initialSwitchState,
  reduce,
  type MapViewAction,
  type MapViewChange,
  type SwitchState,
} from './map-view-state'

export class MapViewStateStore {
  private current: SwitchState = initialSwitchState()
  private readonly emitter = new Emitter<MapViewChange>()
  readonly onDidChange: Event<MapViewChange> = this.emitter.event

  get state(): SwitchState {
    return this.current
  }

  dispatch(action: MapViewAction): void {
    const change = reduce(this.current, action)
    if (!change) return
    this.current = change.state
    this.emitter.fire(change)
  }

  dispose(): void {
    this.emitter.dispose()
  }
}
