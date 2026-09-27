import { describe, it, expect } from 'vitest'
import {
  SYSTEM_COLOR_THEME_ID,
  resolveSystemThemeId,
  systemDefaultThemeLabel,
  isFollowingSystemTheme,
} from '../../../theia/extension/src/browser/system-color-theme'

describe('system color theme resolution (#665, #666)', () => {
  it('resolves dark or light straight from the OS query, not from any stored theme', () => {
    expect(resolveSystemThemeId(true)).toBe('dark')
    expect(resolveSystemThemeId(false)).toBe('light')
  })

  it('labels the picker row with the mode it currently resolves to', () => {
    expect(systemDefaultThemeLabel(true)).toBe('System Default (Dark)')
    expect(systemDefaultThemeLabel(false)).toBe('System Default (Light)')
  })

  it('treats the system id, and an unset preference, as following the OS', () => {
    expect(isFollowingSystemTheme(SYSTEM_COLOR_THEME_ID)).toBe(true)
    expect(isFollowingSystemTheme(undefined)).toBe(true)
  })

  it('does not follow a pinned real theme', () => {
    expect(isFollowingSystemTheme('light')).toBe(false)
    expect(isFollowingSystemTheme('dark')).toBe(false)
    expect(isFollowingSystemTheme('hc-theia')).toBe(false)
  })
})
