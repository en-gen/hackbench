/**
 * Makes `workbench.colorTheme` support `system`: a preference value that
 * means "follow the OS", not a registered Theme (#665, #666).
 *
 * Two Theia internals fight this value, both in `@theia/core`:
 *
 * - `ThemeService.doUpdateColorThemePreference` (`theming.js`) rewrites the
 *   preference's `enum`/`enumItemLabels` from `getThemes()` alone, 500ms
 *   after every theme registration, dropping any id it does not know about.
 *   Rather than race that debounce once at startup, this contribution reacts
 *   to every schema change and reinserts `system` whenever it goes missing.
 * - A frontend app config that supplies its own `preferences` block (the
 *   Electron target's `window.titleBarStyle`, see `electron-app/package.json`)
 *   makes `FrontendConfigPreferenceContribution` register a static override
 *   for `workbench.colorTheme` at schema-init time, which out-ranks a plain
 *   schema default. Registering our own override once preferences are ready
 *   - after every `initSchema` contribution has already run - wins that
 *   race unconditionally instead of depending on binding order.
 *
 * The resolved theme itself is applied directly with
 * `ThemeService.setCurrentTheme(id, false)`, so it never depends on either
 * fight above: it is re-applied at startup, on every preference change, and
 * on every `prefers-color-scheme` change, as long as `system` is selected.
 */
import { injectable, inject } from '@theia/core/shared/inversify'
import { FrontendApplicationContribution } from '@theia/core/lib/browser'
import { ThemeService } from '@theia/core/lib/browser/theming'
import { PreferenceService, PreferenceSchemaService } from '@theia/core/lib/common/preferences'
import {
  SYSTEM_COLOR_THEME_ID,
  resolveSystemThemeId,
  systemDefaultThemeLabel,
} from './system-color-theme'

export const COLOR_THEME_PREFERENCE_KEY = 'workbench.colorTheme'

@injectable()
export class SystemColorThemeContribution implements FrontendApplicationContribution {
  @inject(PreferenceService)
  protected readonly preferences!: PreferenceService

  @inject(ThemeService)
  protected readonly themeService!: ThemeService

  @inject(PreferenceSchemaService)
  protected readonly schemaProvider!: PreferenceSchemaService

  protected readonly media = window.matchMedia('(prefers-color-scheme: dark)')

  onStart(): void {
    this.ensureSystemInSchema()
    this.schemaProvider.onDidChangeSchema(() => this.ensureSystemInSchema())
    this.media.addEventListener('change', () => this.followSystemIfSelected())

    this.preferences.ready.then(() => {
      this.schemaProvider.registerOverride(
        COLOR_THEME_PREFERENCE_KEY,
        undefined,
        SYSTEM_COLOR_THEME_ID,
      )
      this.followSystemIfSelected()
      this.preferences.onPreferencesChanged(changes => {
        if (COLOR_THEME_PREFERENCE_KEY in changes) this.followSystemIfSelected()
      })
    })
  }

  protected ensureSystemInSchema(): void {
    const property = this.schemaProvider.getSchemaProperty(COLOR_THEME_PREFERENCE_KEY)
    const enumValues = property?.enum as string[] | undefined
    if (!property || enumValues?.includes(SYSTEM_COLOR_THEME_ID)) return
    this.schemaProvider.updateSchemaProperty(COLOR_THEME_PREFERENCE_KEY, {
      ...property,
      default: SYSTEM_COLOR_THEME_ID,
      enum: [SYSTEM_COLOR_THEME_ID, ...(enumValues ?? [])],
      enumItemLabels: [
        systemDefaultThemeLabel(this.media.matches),
        ...((property.enumItemLabels as string[] | undefined) ?? []),
      ],
    })
  }

  protected followSystemIfSelected(): void {
    if (this.preferences.get<string>(COLOR_THEME_PREFERENCE_KEY) !== SYSTEM_COLOR_THEME_ID) return
    this.themeService.setCurrentTheme(resolveSystemThemeId(this.media.matches), false)
  }
}
