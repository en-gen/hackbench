import { describe, expect, it } from 'vitest'
import { orderSpecials } from '../../../theia/extension/src/browser/map-explorer-order'

describe('orderSpecials', () => {
  it('puts Title Screen before New Game whichever order they arrive in', () => {
    const a = { role: 'title-screen' }
    const b = { role: 'new-game' }
    expect(orderSpecials([b, a])).toEqual([a, b])
    expect(orderSpecials([a, b])).toEqual([a, b])
  })

  it('does not mutate its input and keeps unknown roles last, in arrival order', () => {
    const input = [{ role: 'x1' }, { role: 'new-game' }, { role: 'x2' }, { role: 'title-screen' }]
    const out = orderSpecials(input)
    expect(out.map(s => s.role)).toEqual(['title-screen', 'new-game', 'x1', 'x2'])
    expect(input[0]!.role).toBe('x1')
  })
})
