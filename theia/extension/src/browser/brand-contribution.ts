/**
 * The mushroom, in the window's top-left corner.
 *
 * Filled into Theia's OWN app-icon slot (`#theia:icon`) rather than added as a
 * sibling of the menu bar. The slot is empty by default but the shell already
 * positions it, and the two targets position it differently: in the Electron
 * window with a custom title bar, a sibling div lands to the RIGHT of the menu
 * rather than at the corner. Using the framework's slot means the icon is
 * where the shell says the icon goes, on both.
 *
 * Inlined as SVG rather than an <img>: the icon is a single unfilled path, so
 * an <img> would render it black on a dark title bar and could not be
 * recoloured. Inline, `fill="currentColor"` lets it take the theme's own
 * foreground, which is the difference between a logo that follows a theme
 * switch and one that disappears into it. That exact defect shipped in the
 * shell spike: present, on screen, and invisible.
 */
import { injectable } from '@theia/core/shared/inversify'
import { FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser'
import { LOGO_SVG } from './logo'

export const BRAND_CLASS = 'hb-brand'

/** Theia's app-icon slot in the top panel. */
const ICON_SLOT_ID = 'theia:icon'

@injectable()
export class BrandContribution implements FrontendApplicationContribution {
  onStart(_app: FrontendApplication): void {
    const attach = (): boolean => {
      const slot = document.getElementById(ICON_SLOT_ID)
      if (!slot) return false
      if (slot.querySelector(`.${BRAND_CLASS}`)) return true

      const brand = document.createElement('div')
      brand.className = BRAND_CLASS
      brand.title = 'HackBench'
      brand.innerHTML = LOGO_SVG
      slot.appendChild(brand)
      return true
    }

    if (attach()) return
    // The shell builds the top panel asynchronously on first launch, so the
    // slot may not exist yet when contributions start.
    const observer = new MutationObserver(() => {
      if (attach()) observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }
}
