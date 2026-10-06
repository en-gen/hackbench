/**
 * The Maps tab's switch-state store (en-gen/hackbench#435): actions in, one event out per real change.
 * No DOM. The consumers' decisions (refetch or mark stale) are in the widget; their contract is
 * `MapViewChange`, tested here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  MapViewStateStore,
  type MapViewAction,
  type MapViewChange,
  collisionReaction,
} from '../../../theia/extension/src/browser/map-view-state-store'

const theiaInstalled = fs.existsSync(
  path.resolve(__dirname, '../../../theia/node_modules/@theia/core/package.json'),
)
const seen = (s: MapViewStateStore) => {
  const got: MapViewChange[] = []
  const sub = s.onDidChange(c => got.push(c))
  return { got, sub }
}

describe.skipIf(!theiaInstalled)('MapViewStateStore', () => {
  it('starts with every palace and switch off', () => {
    const { flags, switches } = new MapViewStateStore().state
    expect(Object.values(flags).concat(Object.values(switches))).toEqual(Array(7).fill(false))
  })

  it('a dispatch changes the state and fires once, with the changed key', () => {
    const s = new MapViewStateStore()
    const { got } = seen(s)
    s.dispatch({ type: 'togglePalace', palace: 'yellow' })
    expect(s.state.flags.yellow).toBe(true)
    expect(got).toHaveLength(1)
    expect(got[0]!.changed).toEqual([{ group: 'flags', key: 'yellow' }])
    s.dispatch({ type: 'toggleSwitch', key: 'blue' })
    expect(got.map(c => c.changed)).toEqual([
      [{ group: 'flags', key: 'yellow' }],
      [{ group: 'switches', key: 'blue' }],
    ])
    expect(got[1]!.state).toBe(s.state)
    s.dispatch({ type: 'togglePalace', palace: 'yellow' }) // toggles back
    expect(s.state.flags.yellow).toBe(false)
  })

  it('replaces state instead of mutating it: a held snapshot stays as it was', () => {
    const s = new MapViewStateStore()
    const before = s.state
    s.dispatch({ type: 'toggleSwitch', key: 'silver' })
    expect(before.switches.silver).toBe(false)
    expect(s.state).not.toBe(before)
    expect(s.state.flags).toBe(before.flags) // the untouched half is shared
  })

  it('a dispatch that changes nothing fires nothing', () => {
    const s = new MapViewStateStore()
    const { got } = seen(s)
    s.dispatch({ type: 'togglePalace', palace: 'purple' } as unknown as MapViewAction)
    s.dispatch({ type: 'toggleSwitch', key: 'nope' } as unknown as MapViewAction)
    expect(got).toEqual([])
    expect(Object.values(s.state.flags)).toEqual([false, false, false, false])
  })

  it('every subscriber receives one dispatch once; a disposed one receives nothing', () => {
    const s = new MapViewStateStore()
    const [a, b, c] = [seen(s), seen(s), seen(s)]
    c.sub.dispose()
    s.dispatch({ type: 'toggleSwitch', key: 'onOff' })
    expect([a.got.length, b.got.length, c.got.length]).toEqual([1, 1, 0])
    s.dispose()
    s.dispatch({ type: 'toggleSwitch', key: 'onOff' })
    expect(a.got).toHaveLength(1)
  })

  it('the collision overlay refetches on a palace or blue P-switch change when on, marks stale when off, ignores the rest', () => {
    const change = (action: MapViewAction) => {
      const s = new MapViewStateStore()
      const { got } = seen(s)
      s.dispatch(action)
      return got[0]!
    }
    const yellow = change({ type: 'togglePalace', palace: 'yellow' })
    const blue = change({ type: 'toggleSwitch', key: 'blue' })
    expect([collisionReaction(yellow, true), collisionReaction(blue, true)]).toEqual([
      'refetch',
      'refetch',
    ])
    expect([collisionReaction(yellow, false), collisionReaction(blue, false)]).toEqual([
      'stale',
      'stale',
    ])
    for (const key of ['silver', 'onOff'] as const) {
      const c = change({ type: 'toggleSwitch', key })
      expect([collisionReaction(c, true), collisionReaction(c, false)]).toEqual(['none', 'none'])
    }
  })
})
