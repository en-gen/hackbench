/**
 * The Maps tab's store (en-gen/hackbench#435): actions in, one event out per real change. Its logic is
 * `reduce` (MapViewState.test.ts, no Theia); this file covers the Emitter wiring and needs Theia, so it
 * imports the store dynamically and skips where Theia is not installed. CI's theia-typecheck job sets
 * HB_REQUIRE_THEIA, which turns a missing install into a failure here instead of a skip.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { MapViewChange } from '../../../theia/extension/src/browser/map-view-state'

const theiaInstalled = fs.existsSync(
  path.resolve(__dirname, '../../../theia/node_modules/@theia/core/package.json'),
)

it('Theia is installed wherever HB_REQUIRE_THEIA says it must be', () => {
  if (process.env.HB_REQUIRE_THEIA) expect(theiaInstalled).toBe(true)
})

describe.skipIf(!theiaInstalled)('MapViewStateStore', () => {
  let Store: typeof import('../../../theia/extension/src/browser/map-view-state-store').MapViewStateStore
  beforeAll(async () => {
    Store = (await import('../../../theia/extension/src/browser/map-view-state-store'))
      .MapViewStateStore
  }, 20000)
  const seen = (s: InstanceType<typeof Store>) => {
    const got: MapViewChange[] = []
    return { got, sub: s.onDidChange(c => got.push(c)) }
  }

  it('a dispatch changes the state and fires once, with the changed key', () => {
    const s = new Store()
    const { got } = seen(s)
    s.dispatch({ type: 'togglePalace', palace: 'yellow' })
    expect(s.state.flags.yellow).toBe(true)
    expect(got).toHaveLength(1)
    expect(got[0]!.changed).toEqual([{ group: 'flags', key: 'yellow' }])
    expect(got[0]!.state).toBe(s.state)
  })

  it('a dispatch that changes nothing fires nothing', () => {
    const s = new Store()
    const { got } = seen(s)
    s.dispatch({ type: 'toggleSwitch', key: 'nope' } as never)
    expect(got).toEqual([])
  })

  it('every subscriber receives one dispatch once; a disposed one receives nothing; a disposed store is silent', () => {
    const s = new Store()
    const [a, b, c] = [seen(s), seen(s), seen(s)]
    c.sub.dispose()
    s.dispatch({ type: 'toggleSwitch', key: 'onOff' })
    expect([a.got.length, b.got.length, c.got.length]).toEqual([1, 1, 0])
    s.dispose()
    s.dispatch({ type: 'toggleSwitch', key: 'onOff' })
    expect(a.got).toHaveLength(1)
  })
})
