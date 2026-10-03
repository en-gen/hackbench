import { describe, it, expect } from 'vitest'
import { ControllerSession } from '../../../theia/extension/src/browser/controller-session'
import type { PadLike } from '../../../theia/extension/src/browser/gamepad-input'

function pad(down: number[] = [], connected = true): PadLike {
  return {
    connected,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: down.includes(i) })),
  }
}

function make(languages: string[] = ['en-US']) {
  const sent: Array<[number, number, boolean]> = []
  const saved: unknown[] = []
  const listeners = new Map<string, () => void>()
  const env = { pads: [null, null] as Array<PadLike | null>, live: true, frame: undefined as any }
  const session = new ControllerSession({
    send: (port, b, p) => sent.push([port, b, p]),
    getPads: () => env.pads,
    languages,
    save: s => saved.push(s),
    isLive: () => env.live,
    requestFrame: cb => ((env.frame = cb), 1),
    cancelFrame: () => (env.frame = undefined),
    listen: (type, fn) => {
      listeners.set(type, fn)
      return () => listeners.delete(type)
    },
  })
  session.start()
  const frame = () => env.frame?.()
  return { session, sent, saved, listeners, env, frame }
}

describe('ControllerSession', () => {
  it('polls pads each frame while live, and keeps polling', () => {
    const { env, sent, frame } = make()
    env.pads = [pad([0]), null]
    frame()
    expect(sent).toEqual([[0, 0, true]])
    expect(env.frame).toBeDefined()
  })

  it('reads nothing, and releases what was held, when not live', () => {
    const { env, sent, frame } = make()
    env.pads = [pad([0]), null]
    frame()
    env.live = false
    frame()
    expect(sent).toEqual([
      [0, 0, true],
      [0, 0, false],
    ])
  })

  it('reads while the fly-out is open even if the game is not live', () => {
    const { env, session, sent, frame } = make()
    env.live = false
    session.togglePads(true)
    env.pads = [pad([9]), null]
    frame()
    expect(sent).toEqual([[0, 3, true]])
  })

  it('blur releases everything and polling stays quiet until focus returns', () => {
    const { env, sent, listeners, frame } = make()
    env.pads = [pad([0]), null]
    frame()
    listeners.get('blur')!()
    frame()
    expect(sent).toEqual([
      [0, 0, true],
      [0, 0, false],
    ])
    listeners.get('focus')!()
    frame()
    expect(sent.at(-1)).toEqual([0, 0, true])
  })

  it('routes the keyboard to the assigned player, and to nobody when unassigned', () => {
    const { session, sent } = make()
    expect(session.key('ArrowRight', true)).toBe(true)
    expect(session.key('ArrowRight', false)).toBe(true)
    session.setKeyboard(1, true)
    session.key('ArrowRight', true)
    session.setKeyboard(1, false)
    expect(sent).toEqual([
      [0, 7, true],
      [0, 7, false],
      [1, 7, true],
      [1, 7, false],
    ])
    expect(session.key('KeyP', true)).toBe(false)
  })

  it('moving the keyboard releases a held key on its old port', () => {
    const { session, sent } = make()
    session.key('KeyZ', true)
    session.setKeyboard(1, true)
    expect(sent).toEqual([
      [0, 0, true],
      [0, 0, false],
    ])
  })

  it('persists a change, and a late load does not overwrite it', () => {
    const { session, saved } = make()
    session.setPad(1, undefined)
    expect(saved).toHaveLength(1)
    session.load({ players: [{ keyboard: true, pad: 3 }, { keyboard: false }], style: 'pal' })
    expect(session.settings.players[1].pad).toBeUndefined()
    expect(session.settings.style).toBe('auto')
  })

  it('loads stored settings when nothing was changed first', () => {
    const { session } = make()
    session.load({ players: [{ keyboard: false, pad: 2 }, { keyboard: true }], style: 'pal' })
    expect(session.settings.style).toBe('pal')
    expect(session.settings.players[0].pad).toBe(2)
  })

  it('resolves the scheme from the region once, with the override on top', () => {
    const us = make(['en-US'])
    expect(us.session.scheme()).toBe('na')
    us.session.setStyle('pal')
    expect(us.session.scheme()).toBe('pal')
    expect(make(['ja-JP']).session.scheme()).toBe('pal')
    const jp = make(['ja-JP'])
    jp.session.setStyle('na')
    expect(jp.session.scheme()).toBe('na')
  })

  it('prefers the OS country over the languages, and falls back when it is empty', () => {
    const { session } = make(['ja-JP'])
    expect(session.scheme()).toBe('pal')
    session.setOsCountry('CA')
    expect(session.scheme()).toBe('na')
    session.setOsCountry('')
    expect(session.scheme()).toBe('pal')
    const us = make(['en-US'])
    us.session.setOsCountry('JP')
    expect(us.session.scheme()).toBe('pal')
    us.session.setStyle('na')
    expect(us.session.scheme()).toBe('na')
  })

  it('togglePads sets and flips, and notifies', () => {
    const { session } = make()
    let n = 0
    session.onChange = () => n++
    session.togglePads(true)
    session.togglePads(true)
    expect(session.padsOpen).toBe(true)
    session.togglePads()
    expect(session.padsOpen).toBe(false)
    expect(n).toBe(3)
  })

  it('dispose cancels the frame loop, drops the listeners and releases', () => {
    const { session, env, sent, listeners, frame } = make()
    env.pads = [pad([0]), null]
    frame()
    session.dispose()
    expect(env.frame).toBeUndefined()
    expect(listeners.size).toBe(0)
    expect(sent.at(-1)).toEqual([0, 0, false])
  })
})
