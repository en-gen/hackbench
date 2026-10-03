import { describe, it, expect } from 'vitest'
import {
  ControllerHub,
  PAD_TO_BUTTON,
  PadLike,
  PadPoller,
  padButtons,
} from '../../../theia/extension/src/browser/gamepad-input'
import { DEFAULT_ASSIGNMENTS } from '../../../theia/extension/src/browser/controller-settings'

type Sent = [number, number, boolean]

function hub() {
  const sent: Sent[] = []
  return { sent, hub: new ControllerHub((port, b, p) => sent.push([port, b, p])) }
}

/** A standard-mapping pad with the given button indexes down and stick axes. */
function pad(down: number[] = [], axes: number[] = [0, 0, 0, 0], connected = true): PadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: down.includes(i) }))
  return { connected, mapping: 'standard', buttons, axes }
}

describe('padButtons: standard mapping by position', () => {
  // libretro ids: B0 Y1 Select2 Start3 Up4 Down5 Left6 Right7 A8 X9 L10 R11
  it.each([
    [0, 0, 'bottom face -> B'],
    [1, 8, 'right face -> A'],
    [2, 1, 'left face -> Y'],
    [3, 9, 'top face -> X'],
    [4, 10, 'LB -> L'],
    [5, 11, 'RB -> R'],
    [8, 2, 'back -> Select'],
    [9, 3, 'start -> Start'],
    [12, 4, 'dpad up'],
    [13, 5, 'dpad down'],
    [14, 6, 'dpad left'],
    [15, 7, 'dpad right'],
  ])('index %i sends joypad id %i (%s)', (index, id) => {
    expect([...padButtons(pad([index]))]).toEqual([id])
  })

  it('maps no index twice and ignores triggers, sticks and the guide button', () => {
    const ids = Object.values(PAD_TO_BUTTON)
    expect(new Set(ids).size).toBe(ids.length)
    for (const i of [6, 7, 10, 11, 16]) expect(padButtons(pad([i])).size).toBe(0)
  })

  it('reads the left stick as the d-pad only past the threshold', () => {
    expect([...padButtons(pad([], [-0.9, 0]))]).toEqual([6])
    expect([...padButtons(pad([], [0.9, 0]))]).toEqual([7])
    expect([...padButtons(pad([], [0, -0.9]))]).toEqual([4])
    expect([...padButtons(pad([], [0, 0.9]))]).toEqual([5])
    expect(padButtons(pad([], [0.4, -0.4])).size).toBe(0)
  })

  it('leaves a non-standard pad alone rather than guess its layout', () => {
    expect(padButtons({ ...pad([0, 1]), mapping: '' }).size).toBe(0)
  })
})

describe('ControllerHub', () => {
  it('sends only edges, per port', () => {
    const { sent, hub: h } = hub()
    h.replace(0, 'pad', new Set([0, 4]))
    h.replace(0, 'pad', new Set([0, 4]))
    h.replace(0, 'pad', new Set([0]))
    h.replace(1, 'pad', new Set([8]))
    expect(sent).toEqual([
      [0, 0, true],
      [0, 4, true],
      [0, 4, false],
      [1, 8, true],
    ])
  })

  it('keeps a button down while any source holds it', () => {
    const { sent, hub: h } = hub()
    h.set(0, 'kb', 0, true)
    h.replace(0, 'pad', new Set([0]))
    h.replace(0, 'pad', new Set())
    expect(sent).toEqual([[0, 0, true]])
    h.set(0, 'kb', 0, false)
    expect(sent).toEqual([
      [0, 0, true],
      [0, 0, false],
    ])
  })

  it('releases a pad that disconnects', () => {
    const { sent, hub: h } = hub()
    const poller = new PadPoller(h)
    poller.poll([pad([0])], DEFAULT_ASSIGNMENTS)
    poller.poll([null], DEFAULT_ASSIGNMENTS)
    expect(sent).toEqual([
      [0, 0, true],
      [0, 0, false],
    ])
  })

  it('releaseAll lets go of every port and source once, and drawing state clears', () => {
    const { sent, hub: h } = hub()
    h.set(0, 'kb', 3, true)
    h.replace(1, 'pad', new Set([8, 9]))
    sent.length = 0
    h.releaseAll()
    h.releaseAll()
    expect([...sent].sort()).toEqual(
      [
        [0, 3, false],
        [1, 8, false],
        [1, 9, false],
      ].sort(),
    )
    expect(h.pressed(0).size + h.pressed(1).size).toBe(0)
  })

  it('reports the post-mapping buttons a port is sending, and notifies on change only', () => {
    const { hub: h } = hub()
    let n = 0
    h.onChange = () => n++
    h.replace(0, 'pad', new Set([4, 8]))
    h.replace(0, 'pad', new Set([4, 8]))
    expect([...h.pressed(0)].sort()).toEqual([4, 8])
    expect(n).toBe(1)
  })
})

describe('PadPoller port routing', () => {
  it('sends pad 0 to port 0 and pad 1 to port 1 by default', () => {
    const { sent, hub: h } = hub()
    new PadPoller(h).poll([pad([0]), pad([1])], DEFAULT_ASSIGNMENTS)
    expect(sent).toEqual([
      [0, 0, true],
      [1, 8, true],
    ])
  })

  it('follows a reassignment and ignores an unassigned pad', () => {
    const { sent, hub: h } = hub()
    const swapped = [
      { keyboard: true, pad: 1 },
      { keyboard: false, pad: undefined },
    ]
    new PadPoller(h).poll([pad([0]), pad([1])], swapped)
    expect(sent).toEqual([[0, 8, true]])
  })

  it('treats a pad reporting connected=false as absent', () => {
    const { sent, hub: h } = hub()
    new PadPoller(h).poll([pad([0], [0, 0, 0, 0], false)], DEFAULT_ASSIGNMENTS)
    expect(sent).toEqual([])
  })
})
