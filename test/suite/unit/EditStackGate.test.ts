/**
 * The guard that decides whether HackBench's undo/redo takes over Theia's
 * `core.undo` / `core.redo`, or lets the built-in handler have them.
 *
 * Its own file, with no Theia import, because it is the one part of the
 * command wiring that can be tested without standing up DI - and it is the
 * part that actually matters: get it wrong in the permissive direction and
 * Ctrl+Z in the preferences editor stops undoing text and starts undoing
 * the user's ROM edits instead.
 */
import { describe, it, expect } from 'vitest'
import { handlesEditStack } from '../../../theia/extension/src/browser/edit-stack-gate'

describe('handlesEditStack', () => {
  it('takes over when a project is open and a HackBench view has focus', () => {
    expect(handlesEditStack('hackbench.palette-view', true)).toBe(true)
    expect(handlesEditStack('hackbench.map-view', true)).toBe(true)
  })

  it('declines with no project open: there is no layer stack to act on', () => {
    expect(handlesEditStack('hackbench.palette-view', false)).toBe(false)
  })

  /**
   * The case this guard exists for. Theia's own Undo still has to reach
   * Monaco when the user is typing in the preferences JSON, and a handler
   * that claimed `core.undo` unconditionally would silently swallow it.
   */
  it('declines when a text editor has focus, so Ctrl+Z still undoes text', () => {
    expect(handlesEditStack('code-editor-opener:file:///settings.json', true)).toBe(false)
    expect(handlesEditStack('preferences_view_widget', true)).toBe(false)
  })

  it('declines when nothing is focused rather than guessing', () => {
    expect(handlesEditStack(undefined, true)).toBe(false)
  })

  it('matches on prefix, not substring: a foreign widget naming us is not us', () => {
    expect(handlesEditStack('other.embeds.hackbench.palette-view', true)).toBe(false)
  })
})
