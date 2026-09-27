/**
 * Pure resolution logic for the "System Default" color theme option
 * (#665, #666). Kept apart from the Theia contributions that use it so the
 * mapping from the OS's `prefers-color-scheme` to a theme id is unit tested
 * without a shell.
 */

/** The `workbench.colorTheme` value that means "follow the OS". Never a registered Theme id. */
export const SYSTEM_COLOR_THEME_ID = 'system'

export type ResolvedColorThemeId = 'dark' | 'light'

/** The concrete Theia theme id the System Default option resolves to right now. */
export function resolveSystemThemeId(prefersDark: boolean): ResolvedColorThemeId {
  return prefersDark ? 'dark' : 'light'
}

/** The picker row's label, naming the mode it currently resolves to. */
export function systemDefaultThemeLabel(prefersDark: boolean): string {
  return `System Default (${prefersDark ? 'Dark' : 'Light'})`
}

/**
 * Whether `workbench.colorTheme` should keep following the OS: `system`,
 * or unset (defensive - the schema default is `system` once installed, but
 * a preference store never seen by this contribution reads as undefined).
 */
export function isFollowingSystemTheme(preferenceValue: string | undefined): boolean {
  return preferenceValue === undefined || preferenceValue === SYSTEM_COLOR_THEME_ID
}
