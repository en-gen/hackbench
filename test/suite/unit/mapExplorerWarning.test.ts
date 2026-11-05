import { describe, expect, it } from 'vitest'
import {
  UNREADABLE_TITLE,
  titleWithWarning,
} from '../../../theia/extension/src/browser/map-explorer-warning'

describe('titleWithWarning', () => {
  it('leaves a healthy row alone, with or without a title', () => {
    expect(titleWithWarning('Bonus Game')).toBe('Bonus Game')
    expect(titleWithWarning(undefined, false)).toBeUndefined()
  })

  it('shows the warning alone on a plain row', () => {
    expect(titleWithWarning(undefined, true)).toBe(UNREADABLE_TITLE)
  })

  it('keeps a role title and the warning together, so the role never hides it', () => {
    const t = titleWithWarning('Bonus Game', true)!
    expect(t).toContain('Bonus Game')
    expect(t).toContain(UNREADABLE_TITLE)
  })
})
