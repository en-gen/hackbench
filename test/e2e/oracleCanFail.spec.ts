import { test, expect, ROM_PATH, NO_ROM_REASON } from './fixtures/workbench'
import { sampleRender } from './fixtures/renderHash'

/**
 * Proof that the toolbar suite's verdict can go red, and that the obvious
 * alternative cannot.
 *
 * A verdict nothing can falsify is worse than no verdict, so the planted
 * defect lives here rather than in a one-off script. It is the real bug:
 * `wireLayerBtn` (src/webview/mapEditor/main.ts) flips the backing checkbox,
 * dispatches `change` so the store learns about it, and toggles the button's
 * own `on` class from the checkbox. Sever the middle step and layer 1 keeps
 * drawing while the button still looks switched off.
 *
 * The defect is planted in the live page rather than in the build, so this
 * runs in CI with no second bundle and no build-step trickery.
 *
 * This test is only meaningful alongside `hiding layer 1 changes what is
 * rendered`: that one establishes the hash DOES move on a real click, so the
 * unchanged hash here is evidence of the planted defect rather than of a
 * sampler that never changes.
 */
test.describe('the render oracle can fail', () => {
  test.skip(!ROM_PATH, NO_ROM_REASON)

  test('an unwired toggle fools the button class but not the canvas', async ({ mapEditor }) => {
    const { webview } = mapEditor

    const original = await sampleRender(webview)
    expect(original.litPixels, 'the map should have drawn something first').toBeGreaterThan(0)

    // PLANT THE DEFECT. Replacing the node with a clone drops every listener
    // wireLayerBtn attached; re-adding only the cosmetic half reproduces
    // "the button responds, the store never hears about it".
    await webview.locator('#btn-l1').evaluate((el) => {
      const broken = el.cloneNode(true) as HTMLElement
      el.replaceWith(broken)
      broken.addEventListener('click', () => broken.classList.toggle('on'))
    })

    const button = webview.locator('#btn-l1')
    await button.click()

    // The hollow oracle is satisfied. This assertion documents that a suite
    // asserting only on the class would report a clean pass on broken code.
    await expect(button, 'the class oracle cannot tell the difference')
      .not.toHaveClass(/\bon\b/)

    // The oracle the suite actually uses is not.
    const afterBreak = await sampleRender(webview)
    expect(afterBreak.hash, 'the render oracle must notice that nothing was hidden')
      .toBe(original.hash)
    expect(afterBreak.litPixels).toBe(original.litPixels)
  })
})
