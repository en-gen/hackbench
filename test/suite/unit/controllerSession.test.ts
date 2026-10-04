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

function make(initialLanguage = 'en-US') {
  const sent: Array<[number, number, boolean]> = []
  const saved: unknown[] = []
  const listeners = new Map<string, () => void>()
  const env = {
    pads: [null, null] as Array<PadLike | null>,
    live: true,
    focused: true,
    language: initialLanguage,
    frame: undefined as (() => void) | undefined,
    reads: 0,
  }
  const session = new ControllerSession({
    send: (port, b, p) => sent.push([port, b, p]),
    getPads: () => (env.reads++, env.pads),
    language: () => env.language,
    save: s => saved.push(s),
    isLive: () => env.live,
    hasFocus: () => env.focused,
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

  it('losing focus releases once and an unfocused window is not polled', () => {
    const { env, sent, frame } = make()
    env.pads = [pad([0]), null]
    frame()
    env.focused = false
    frame()
    frame()
    expect(sent).toEqual([
      [0, 0, true],
      [0, 0, false],
    ])
    env.focused = true
    frame()
    expect(sent.at(-1)).toEqual([0, 0, true])
  })

  it('a blur event alone (focus moving into an iframe) does not release', () => {
    const { listeners, env, sent, frame } = make()
    env.pads = [pad([0]), null]
    frame()
    expect(listeners.has('blur')).toBe(false)
    frame()
    expect(sent).toEqual([[0, 0, true]])
  })

  it('an already-unfocused window is not polled from the first frame', () => {
    const { env, sent, frame } = make()
    env.focused = false
    env.pads = [pad([0]), null]
    frame()
    expect(sent).toEqual([])
  })

  it('pausing or stopping (the game no longer live) releases a held pad button and a held key', () => {
    const { session, env, sent, frame } = make()
    env.pads = [pad([0]), null]
    frame()
    session.key('ArrowUp', true)
    env.live = false
    frame()
    expect(sent.filter(s => !s[2]).sort()).toEqual([
      [0, 0, false],
      [0, 4, false],
    ])
    sent.length = 0
    frame()
    expect(sent, 'released once, not every frame').toEqual([])
  })

  it('does no pad reads while idle', () => {
    const { env, frame } = make()
    env.live = false
    frame()
    frame()
    expect(env.reads).toBe(0)
  })

  it('does not poll a hidden panel (isLive false)', () => {
    const { env, sent, frame } = make()
    env.live = false
    env.pads = [pad([0]), null]
    frame()
    expect(sent).toEqual([])
  })

  it('setting a pressed pad to None releases its port', () => {
    const { session, env, sent, frame } = make()
    env.pads = [pad([0]), null]
    frame()
    session.setPad(0, undefined)
    frame()
    expect(sent).toEqual([
      [0, 0, true],
      [0, 0, false],
    ])
  })

  it('a pad on port 1 sends on port 1, not port 0', () => {
    const { env, sent, frame } = make()
    env.pads = [null, pad([1])]
    frame()
    expect(sent).toEqual([[1, 8, true]])
  })

  it('a key held while loaded settings move the keyboard to P2 is released on port 0', () => {
    const { session, sent } = make()
    session.key('KeyZ', true)
    session.load({
      players: [{ keyboard: false }, { keyboard: true }],
      style: 'auto',
    })
    expect(sent).toEqual([
      [0, 0, true],
      [0, 0, false],
    ])
    session.key('KeyZ', true)
    expect(sent.at(-1)).toEqual([1, 0, true])
  })

  it('a stored duplicate assignment is not applied twice', () => {
    const { session, env, sent, frame } = make()
    session.load({
      players: [
        { keyboard: true, pad: 0 },
        { keyboard: true, pad: 0 },
      ],
    })
    env.pads = [pad([0]), null]
    frame()
    expect(sent).toEqual([[0, 0, true]])
  })

  it('lists a non-standard pad, flagged', () => {
    const { env, session } = make()
    env.pads = [pad(), { ...pad(), mapping: '' }]
    expect(session.connectedPads().map(p => p.standard)).toEqual([true, false])
  })

  it('lists pads with their real array index', () => {
    const { env, session } = make()
    env.pads = [pad(), null, pad(), pad([], false)]
    expect(session.connectedPads().map(p => p.index)).toEqual([0, 2])
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

  it('persists a change after loading', () => {
    const { session, saved } = make()
    session.load(undefined)
    session.setPad(1, undefined)
    expect(saved).toHaveLength(1)
  })

  it('loads stored settings when nothing was changed first', () => {
    const { session } = make()
    session.load({ players: [{ keyboard: false, pad: 2 }, { keyboard: true }], style: 'pal' })
    expect(session.settings.style).toBe('pal')
    expect(session.settings.players[0].pad).toBe(2)
  })

  it('resolves the scheme from the region once, with the override on top', () => {
    const us = make('en-US')
    expect(us.session.scheme()).toBe('na')
    us.session.setStyle('pal')
    expect(us.session.scheme()).toBe('pal')
    expect(make('ja-JP').session.scheme()).toBe('pal')
    const jp = make('ja-JP')
    jp.session.setStyle('na')
    expect(jp.session.scheme()).toBe('na')
  })

  it('the fallback reads navigator.language only, not later languages', () => {
    expect(make('de').session.scheme()).toBe('pal')
    expect(make('en-CA').session.scheme()).toBe('na')
  })

  it('reads the language when the scheme is resolved, not once at construction', () => {
    const { session, env } = make('ja-JP')
    expect(session.scheme()).toBe('pal')
    env.language = 'en-US'
    expect(session.scheme()).toBe('na')
  })

  it('prefers the OS country over the languages, and falls back when it is empty', () => {
    const { session } = make('ja-JP')
    expect(session.scheme()).toBe('pal')
    session.setOsCountry('CA')
    expect(session.scheme()).toBe('na')
    session.setOsCountry('')
    expect(session.scheme()).toBe('pal')
    const us = make('en-US')
    us.session.setOsCountry('JP')
    expect(us.session.scheme()).toBe('pal')
    us.session.setStyle('na')
    expect(us.session.scheme()).toBe('na')
  })

  it('persists the selected tab and loads it back', () => {
    const { session, saved } = make()
    session.load(undefined)
    session.selectPlayer(1)
    expect(session.settings.selectedPlayer).toBe(1)
    expect((saved.at(-1) as { selectedPlayer: number }).selectedPlayer).toBe(1)
    session.selectPlayer(7)
    expect(session.settings.selectedPlayer).toBe(0)
    const fresh = make().session
    fresh.load({ players: [{ keyboard: true }, { keyboard: false }], selectedPlayer: 1 })
    expect(fresh.settings.selectedPlayer).toBe(1)
  })

  it('a tab picked before the stored settings load saves nothing, then wins over the stored tab', () => {
    const { session, saved } = make()
    session.selectPlayer(1)
    expect(session.settings.selectedPlayer).toBe(1)
    expect(saved, 'defaults were saved over unread settings').toEqual([])
    session.load({
      players: [{ keyboard: false, pad: 2 }, { keyboard: true }],
      style: 'pal',
      selectedPlayer: 0,
    })
    expect(session.settings.selectedPlayer).toBe(1)
    expect(session.settings.style).toBe('pal')
    expect(session.settings.players[0].pad).toBe(2)
    expect(saved).toHaveLength(1)
    expect((saved[0] as { style: string }).style).toBe('pal')
  })

  it('device and style changes before load are replayed over the stored settings, saved once', () => {
    const { session, saved } = make()
    const stored = {
      players: [
        { keyboard: false, pad: 2 },
        { keyboard: true, pad: 0 },
      ],
      style: 'pal',
      selectedPlayer: 0,
    }
    session.setPad(1, undefined)
    expect(saved, 'defaults saved over unread settings').toEqual([])
    session.load(stored)
    expect(saved).toHaveLength(1)
    session.selectPlayer(1)
    expect(saved).toHaveLength(2)
    for (const s of [session.settings, saved.at(-1) as typeof session.settings]) {
      expect(s.style).toBe('pal')
      expect(s.players[0].pad).toBe(2)
      expect(s.players[1].pad).toBeUndefined()
      expect(s.selectedPlayer).toBe(1)
    }
  })

  it('a failed read (load with undefined) still ends the loading state', () => {
    const { session, saved } = make()
    session.selectPlayer(1)
    session.load(undefined)
    session.selectPlayer(0)
    expect(saved).toHaveLength(2)
  })

  it('switching tabs sends nothing to the core and changes no assignment', () => {
    const { session, env, sent, frame } = make()
    session.load(undefined)
    env.pads = [pad([0]), null]
    frame()
    session.key('KeyZ', true)
    const before = JSON.stringify(session.settings.players)
    sent.length = 0
    session.selectPlayer(1)
    session.selectPlayer(0)
    frame()
    expect(sent).toEqual([])
    expect(JSON.stringify(session.settings.players)).toBe(before)
  })

  it('a tab picked after loading saves normally', () => {
    const { session, saved } = make()
    session.load(undefined)
    session.selectPlayer(1)
    expect(saved).toHaveLength(1)
  })

  it('a tab is active while its player holds a button, whichever tab is selected', () => {
    const { session, env, frame } = make()
    session.selectPlayer(1)
    expect([session.isActive(0), session.isActive(1)]).toEqual([false, false])
    env.pads = [pad([0]), null]
    frame()
    expect([session.isActive(0), session.isActive(1)]).toEqual([true, false])
    env.pads = [null, pad([1])]
    frame()
    expect([session.isActive(0), session.isActive(1)]).toEqual([false, true])
    env.pads = [null, null]
    frame()
    expect(session.isActive(1)).toBe(false)
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
