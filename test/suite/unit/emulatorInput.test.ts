import { describe, it, expect } from 'vitest'
import { HeldButtons, KEY_TO_BUTTON } from '../../../theia/extension/src/browser/emulator-input'

function recorder() {
  const sent: Array<[number, boolean]> = []
  return { sent, buttons: new HeldButtons((b, p) => sent.push([b, p])) }
}

describe('HeldButtons', () => {
  it('sends a press and a release, and nothing for key repeat', () => {
    const { sent, buttons } = recorder()
    buttons.key('ArrowRight', true)
    buttons.key('ArrowRight', true)
    buttons.key('ArrowRight', true)
    buttons.key('ArrowRight', false)
    expect(sent).toEqual([
      [7, true],
      [7, false],
    ])
  })

  it('leaves keys that are not controller keys to the rest of the app', () => {
    const { sent, buttons } = recorder()
    expect(buttons.key('KeyP', true)).toBe(false)
    expect(buttons.key('F1', true)).toBe(false)
    expect(sent).toEqual([])
  })

  it('releaseAll lets go of everything held, once', () => {
    const { sent, buttons } = recorder()
    buttons.key('KeyZ', true)
    buttons.key('Enter', true)
    buttons.releaseAll()
    buttons.releaseAll()
    expect(sent).toEqual([
      [0, true],
      [3, true],
      [0, false],
      [3, false],
    ])
  })

  it('maps every SNES button exactly once', () => {
    const ids = Object.values(KEY_TO_BUTTON).sort((a, b) => a - b)
    expect(ids).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })
})
