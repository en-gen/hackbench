import { test, expect, quickInput, ROM_PATH, NO_ROM_REASON } from './fixtures/workbench'
import { sampleRender } from './fixtures/renderHash'

/**
 * The map editor toolbar, driven the way a user drives it: real VS Code, real
 * ROM, real webview. These assert that pressing a control changes what is on
 * the canvas, not that a CSS class flipped.
 */
test.describe('map editor toolbar', () => {
  test.skip(!ROM_PATH, NO_ROM_REASON)

  // One toggle per visual layer the toolbar can suppress. Sweeping these
  // rather than testing layer 1 alone is deliberate: a single-case pass here
  // would not distinguish "the toggle works" from "this one toggle works".
  const LAYER_TOGGLES = [
    { id: 'btn-l1', label: 'layer 1' },
    { id: 'btn-l2', label: 'layer 2' },
    { id: 'btn-sprites', label: 'sprites' },
  ] as const

  for (const toggle of LAYER_TOGGLES) {
    test(`hiding ${toggle.label} changes what is rendered`, async ({ mapEditor }) => {
      const { webview } = mapEditor
      const button = webview.locator(`#${toggle.id}`)
      await expect(button).toHaveClass(/\bon\b/)

      const shown = await sampleRender(webview)
      expect(shown.litPixels, 'the map should have drawn something to begin with').toBeGreaterThan(0)

      await button.click()
      await expect(button).not.toHaveClass(/\bon\b/)
      await expect
        .poll(async () => (await sampleRender(webview)).hash, { timeout: 15_000 })
        .not.toBe(shown.hash)
    })

    test(`showing ${toggle.label} again restores the original render`, async ({ mapEditor }) => {
      const { webview } = mapEditor
      const button = webview.locator(`#${toggle.id}`)
      const original = await sampleRender(webview)

      await button.click()
      await expect
        .poll(async () => (await sampleRender(webview)).hash, { timeout: 15_000 })
        .not.toBe(original.hash)

      // A toggle that cannot be undone is a state bug the one-way test above
      // would pass clean.
      await button.click()
      await expect(button).toHaveClass(/\bon\b/)
      await expect
        .poll(async () => (await sampleRender(webview)).hash, { timeout: 15_000 })
        .toBe(original.hash)
    })
  }

  test('zoom controls move the zoom label and the render', async ({ mapEditor }) => {
    const { webview } = mapEditor

    // Assert the label moves rather than pinning its exact glyph. It reads
    // "1×" with a multiplication sign, and a test that hard-codes that is a
    // test that breaks when someone edits the label and nothing else.
    const label = webview.locator('#zoom-label')
    const labelBefore = (await label.innerText()).trim()
    expect(labelBefore).not.toBe('')

    const before = await sampleRender(webview)
    await webview.locator('#zoom-in').click()

    await expect.poll(async () => (await label.innerText()).trim(), { timeout: 15_000 })
      .not.toBe(labelBefore)
    await expect
      .poll(async () => (await sampleRender(webview)).hash, { timeout: 15_000 })
      .not.toBe(before.hash)
  })
})

test.describe('extension host surfaces', () => {
  test('registers its commands', async ({ workbench }) => {
    const { win } = workbench
    await win.keyboard.press('Control+Shift+P')
    const widget = quickInput(win)
    await widget.waitFor({ state: 'visible', timeout: 20_000 })
    await win.keyboard.type('HackBench')
    await expect
      .poll(async () => await widget.locator('.monaco-list-row').allTextContents(),
        { timeout: 20_000 })
      .toEqual(expect.arrayContaining([
        expect.stringContaining('Open ROM'),
        expect.stringContaining('Close ROM'),
      ]))
    await win.keyboard.press('Escape')
  })

  test('the ROM opened from the Explorer populated the tree', async ({ workbench }) => {
    test.skip(!ROM_PATH, NO_ROM_REASON)
    const { win } = workbench

    // The worker fixture opened the ROM through the context menu, which hands
    // the command the clicked URI, so a populated tree proves
    // romPathFromCommandArg took the path rather than a dialog supplying it.
    const rows = win.locator('.pane-body .monaco-list-row')
    await expect.poll(async () => await rows.count(), { timeout: 60_000 }).toBeGreaterThan(1)
    await expect(rows.filter({ hasText: 'VANILLA SECRET 2' }).first()).toBeVisible()
  })
})
