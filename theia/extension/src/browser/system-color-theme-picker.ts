/**
 * Inserts "System Default (<mode>)" as the first row of the Color Theme
 * picker (`workbench.action.selectTheme`, #666). `selectColorTheme` builds
 * and shows its quick pick in one private method with no seam to extend, so
 * this reimplements it rather than composing with the original; the grouping
 * of real themes below is otherwise unchanged from
 * `CommonFrontendContribution.selectColorTheme` (`common-frontend-contribution.js`).
 */
import { injectable } from '@theia/core/shared/inversify'
import { CommonFrontendContribution } from '@theia/core/lib/browser/common-frontend-contribution'
import { QuickPickItem, QuickPickItemOrSeparator } from '@theia/core/lib/browser/quick-input'
import { Theme } from '@theia/core/lib/common/theme'
import { COLOR_THEME_PREFERENCE_KEY } from './system-color-theme-contribution'
import {
  SYSTEM_COLOR_THEME_ID,
  resolveSystemThemeId,
  systemDefaultThemeLabel,
} from './system-color-theme'

@injectable()
export class SystemColorThemePicker extends CommonFrontendContribution {
  protected override selectColorTheme(): void {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const systemItem: QuickPickItem = {
      id: SYSTEM_COLOR_THEME_ID,
      label: systemDefaultThemeLabel(prefersDark),
    }
    const followingSystem =
      this.preferenceService.get(COLOR_THEME_PREFERENCE_KEY) === SYSTEM_COLOR_THEME_ID
    let resetTo: string | undefined = this.themeService.getCurrentTheme().id

    const setTheme = (id: string, persist: boolean): void => {
      if (id === SYSTEM_COLOR_THEME_ID) {
        if (persist) {
          this.preferenceService.updateValue(COLOR_THEME_PREFERENCE_KEY, SYSTEM_COLOR_THEME_ID)
        } else {
          // Preview: show what System Default currently resolves to without
          // touching the preference, matching what selecting it will apply.
          this.themeService.setCurrentTheme(resolveSystemThemeId(prefersDark), false)
        }
        return
      }
      this.themeService.setCurrentTheme(id, persist)
    }

    const themeItems: QuickPickItem[] = []
    const itemsByType: Record<Theme['type'], QuickPickItemOrSeparator[]> = {
      light: [],
      dark: [],
      hc: [],
      hcLight: [],
    }
    for (const theme of this.themeService
      .getThemes()
      .sort((a, b) => a.label.localeCompare(b.label))) {
      const group = itemsByType[theme.type]
      if (group.length === 0 && theme.type !== 'hcLight') {
        const label =
          theme.type === 'light'
            ? 'light themes'
            : theme.type === 'dark'
              ? 'dark themes'
              : 'high contrast themes'
        group.push({ type: 'separator', label })
      }
      const item: QuickPickItem = {
        id: theme.id,
        label: theme.label,
        description: theme.description,
      }
      group.push(item)
      themeItems.push(item)
    }
    const items: QuickPickItemOrSeparator[] = [
      systemItem,
      ...itemsByType.light,
      ...itemsByType.dark,
      ...itemsByType.hc,
      ...itemsByType.hcLight,
    ]

    this.quickInputService?.showQuickPick<QuickPickItem>(items, {
      placeholder: 'Select Color Theme',
      activeItem: followingSystem ? systemItem : themeItems.find(item => item.id === resetTo),
      onDidChangeSelection: (_, selectedItems) => {
        resetTo = undefined
        setTheme(selectedItems[0].id!, true)
      },
      onDidChangeActive: (_, activeItems) => setTheme(activeItems[0].id!, false),
      onDidHide: () => {
        if (resetTo) setTheme(resetTo, false)
      },
    })
  }
}
