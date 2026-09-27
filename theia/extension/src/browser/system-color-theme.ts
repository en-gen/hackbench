/**
 * `workbench.colorTheme: 'system'` follows the OS instead of naming a Theme
 * (#665, #666). `SystemThemeService` teaches `ThemeService` the value at its
 * three seams (default resolution, persistence, its own enum rewrite);
 * `SystemColorThemePicker` only adds its row to the Color Theme picker.
 */
import { injectable } from '@theia/core/shared/inversify'
import { ThemeService } from '@theia/core/lib/browser/theming'
import { CommonFrontendContribution } from '@theia/core/lib/browser/common-frontend-contribution'
import {
  QuickInputService,
  QuickPickItem,
  QuickPickItemOrSeparator,
  QuickPickOptions,
} from '@theia/core/lib/browser/quick-input'
import { Theme } from '@theia/core/lib/common/theme'

export const SYSTEM_COLOR_THEME_ID = 'system'
const COLOR_THEME_PREFERENCE_KEY = 'workbench.colorTheme'
const media = () => window.matchMedia('(prefers-color-scheme: dark)')
const osThemeId = (): 'dark' | 'light' => (media().matches ? 'dark' : 'light')

@injectable()
export class SystemThemeService extends ThemeService {
  override init(): void {
    super.init()
    // Theia re-checks the preference on its own; `system` just needs a nudge
    // to re-check it whenever the OS mode itself changes.
    media().addEventListener('change', () => this.validateActiveTheme())
  }

  protected override getConfiguredTheme(): Theme | undefined {
    if (this.preferences.get<string>(COLOR_THEME_PREFERENCE_KEY) === SYSTEM_COLOR_THEME_ID) {
      return this.tryGetTheme(osThemeId())
    }
    return super.getConfiguredTheme()
  }

  override setCurrentTheme(themeId: string, persist = true): void {
    if (themeId !== SYSTEM_COLOR_THEME_ID) {
      super.setCurrentTheme(themeId, persist)
      return
    }
    // Apply the resolved mode immediately, rather than waiting on the
    // preference-changed round trip `persist` below queues up.
    super.setCurrentTheme(osThemeId(), false)
    if (persist) this.preferences.updateValue(COLOR_THEME_PREFERENCE_KEY, SYSTEM_COLOR_THEME_ID)
  }

  // `doUpdateColorThemePreference` rebuilds the preference's enum from
  // `getThemes()` alone, 500ms after every theme registration, dropping any
  // id it does not know about. `system` is never a registered Theme, so it
  // has to be reinserted after every one of those rewrites, not just once.
  protected override doUpdateColorThemePreference(): void {
    super.doUpdateColorThemePreference()
    const property = this.schemaProvider.getSchemaProperty(COLOR_THEME_PREFERENCE_KEY)
    if (!property || property.enum?.includes(SYSTEM_COLOR_THEME_ID)) return
    this.schemaProvider.updateSchemaProperty(COLOR_THEME_PREFERENCE_KEY, {
      ...property,
      enum: [SYSTEM_COLOR_THEME_ID, ...(property.enum ?? [])],
      // Plain label: Settings renders it once and does not re-render on an
      // OS change, so naming the mode here would go stale. The picker below
      // names it fresh every time it opens instead.
      enumItemLabels: ['System Default', ...(property.enumItemLabels ?? [])],
    })
  }
}

@injectable()
export class SystemColorThemePicker extends CommonFrontendContribution {
  // `selectColorTheme` has no seam to extend, so the row is spliced in by
  // proxying the one `showQuickPick` call it makes, for that call only, to
  // keep upstream's preview debounce, nls strings and theme grouping intact.
  protected override selectColorTheme(): void {
    const quickInput = this.quickInputService
    if (!quickInput) {
      super.selectColorTheme()
      return
    }
    const restore = quickInput.showQuickPick
    const original = restore as (
      this: QuickInputService,
      items: QuickPickItemOrSeparator[],
      options?: QuickPickOptions<QuickPickItem>,
    ) => Promise<QuickPickItem | undefined>
    const followingSystem =
      this.preferenceService.get(COLOR_THEME_PREFERENCE_KEY) === SYSTEM_COLOR_THEME_ID
    const systemItem: QuickPickItem = {
      id: SYSTEM_COLOR_THEME_ID,
      label: `System Default (${osThemeId() === 'dark' ? 'Dark' : 'Light'})`,
    }

    quickInput.showQuickPick = function (
      this: QuickInputService,
      items: QuickPickItemOrSeparator[],
      options?: QuickPickOptions<QuickPickItem>,
    ): Promise<QuickPickItem | undefined> {
      return original.call(
        this,
        [systemItem, ...items],
        followingSystem ? { ...options, activeItem: systemItem } : options,
      )
    } as QuickInputService['showQuickPick']

    try {
      super.selectColorTheme()
    } finally {
      quickInput.showQuickPick = restore
    }
  }
}
