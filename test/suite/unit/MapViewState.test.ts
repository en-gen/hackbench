/**
 * The Maps tab's switch state and the collision overlay's reading of its changes (en-gen/hackbench#435).
 * Pure module, no Theia import: this file runs everywhere, CI's no-Theia `unit` job included.
 */
import { describe, it, expect } from 'vitest'
import {
  collisionKey,
  collisionPlan,
  initialSwitchState,
  reduce,
  type MapViewAction,
} from '../../../theia/extension/src/browser/map-view-state'

const step = (a: MapViewAction) => reduce(initialSwitchState(), a)!

describe('reduce', () => {
  it('flips the named palace or switch, names it, and replaces state without mutating', () => {
    const s0 = initialSwitchState()
    const c = reduce(s0, { type: 'togglePalace', palace: 'yellow' })!
    expect(c.state.flags.yellow).toBe(true)
    expect(c.changed).toEqual([{ group: 'flags', key: 'yellow' }])
    expect(s0.flags.yellow).toBe(false)
    expect(c.state.switches).toBe(s0.switches)
    const d = reduce(c.state, { type: 'toggleSwitch', key: 'silver' })!
    expect(d.changed).toEqual([{ group: 'switches', key: 'silver' }])
    expect(d.state.flags).toBe(c.state.flags)
    expect(reduce(c.state, { type: 'togglePalace', palace: 'yellow' })!.state.flags.yellow).toBe(
      false,
    )
  })

  it('a key the state does not have changes nothing', () => {
    const s = initialSwitchState()
    expect(reduce(s, { type: 'togglePalace', palace: 'purple' } as unknown as MapViewAction)).toBeUndefined() // prettier-ignore
    expect(reduce(s, { type: 'toggleSwitch', key: 'nope' } as unknown as MapViewAction)).toBeUndefined() // prettier-ignore
  })
})

describe('collisionKey', () => {
  it('follows the palaces and the blue P-switch, and not silver or ON/OFF', () => {
    const key = (a: MapViewAction) => collisionKey(step(a).state)
    const base = collisionKey(initialSwitchState())
    for (const palace of ['green', 'yellow', 'blue', 'red'] as const)
      expect(key({ type: 'togglePalace', palace }), palace).not.toBe(base)
    expect(key({ type: 'toggleSwitch', key: 'blue' })).not.toBe(base)
    expect(key({ type: 'toggleSwitch', key: 'silver' })).toBe(base)
    expect(key({ type: 'toggleSwitch', key: 'onOff' })).toBe(base)
    // Each palace has its own place in the key.
    expect(new Set(['green', 'yellow', 'blue', 'red'].map(p => key({ type: 'togglePalace', palace: p } as MapViewAction))).size).toBe(4) // prettier-ignore
  })
})

describe('collisionPlan', () => {
  const plan = (a: MapViewAction, on: boolean, refused = false) =>
    collisionPlan(step(a), on, refused)
  const yellow: MapViewAction = { type: 'togglePalace', palace: 'yellow' }

  it('drops the old lines on a palace or blue P-switch change, and asks again only when the overlay is on', () => {
    expect(plan(yellow, true)).toEqual({ drop: true, refetch: true, recheck: false })
    expect(plan(yellow, false)).toEqual({ drop: true, refetch: false, recheck: false })
    expect(plan({ type: 'toggleSwitch', key: 'blue' }, true).refetch).toBe(true)
  })

  it('does nothing for silver and ON/OFF', () => {
    for (const key of ['silver', 'onOff'] as const)
      expect(plan({ type: 'toggleSwitch', key }, true, true)).toEqual({
        drop: false,
        refetch: false,
        recheck: false,
      })
  })

  it('re-checks when the toggle was disabled by a probe refusal for the old state, so it does not stay stuck', () => {
    expect(plan(yellow, false, true).recheck).toBe(true)
    expect(plan(yellow, false, false).recheck).toBe(false)
  })
})
