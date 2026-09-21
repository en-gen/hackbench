import * as fs from 'fs'
import * as path from 'path'
import { test, expect, ROM_PATH, NO_ROM_REASON, webviewOf, quickInput } from './fixtures/workbench'

/**
 * Diagnostic smoke test for the emulator preview panel. Opens it once, waits
 * for main.ts to settle on a terminal status line, and prints that line.
 *
 * The status line is the whole point: it reports which path the panel took.
 * "playable" plus geometry means the WRAM locate and the GameMode drive both
 * worked; "stuck at GameMode 0xNN" or "WRAM not found" name the exact failure
 * instead of leaving it to be inferred from what the picture looks like.
 */
const EVIDENCE_DIR = path.join(__dirname, '../../spike/t15/evidence')
fs.mkdirSync(EVIDENCE_DIR, { recursive: true })

test.describe('emulator preview smoke', () => {
  test.skip(!ROM_PATH, NO_ROM_REASON)

  test('reports which load path it took', async ({ workbench }) => {
    test.setTimeout(6 * 60_000)
    const { win } = workbench

    const logs: string[] = []
    win.on('console', msg => {
      const t = msg.text()
      if (t.includes('[core]') || t.includes('[wram]') || t.includes('emulatorPreview')) logs.push(t)
    })

    // Open twice. The first open boots the core from power-on and snapshots the
    // title screen; the second should restore that snapshot and skip the boot
    // (the Nintendo Presents logo and title fade, roughly 230 emulated frames).
    // The timing difference between the two is the whole point of the cache.
    async function openOnce(label: string): Promise<{ text: string, ms: number }> {
      const started = Date.now()
      await win.keyboard.press('Control+Shift+P')
      await quickInput(win).waitFor({ state: 'visible', timeout: 20_000 })
      await win.keyboard.type('HackBench: Open Emulator Preview')
      await win.keyboard.press('Enter')

      const status = webviewOf(win).locator('#status')
      await status.waitFor({ timeout: 60_000 })

      // Terminal states, all set by onLoad(): success carries "playable",
      // the two fallbacks carry "fallback", a throw carries "error".
      let text = ''
      await expect(async () => {
        text = (await status.textContent()) ?? ''
        expect(text).toMatch(/playable|fallback|error/)
      }).toPass({ timeout: 5 * 60_000, intervals: [500] })
      const ms = Date.now() - started
      console.log(`\n=== ${label} (${ms}ms) ===\n${text}\n`)
      return { text, ms }
    }

    const first = await openOnce('FIRST OPEN, cold boot')

    const png = await webviewOf(win).locator('body').evaluate(async () => {
      const hook = (window as unknown as { __hackbenchTest: { screenshotPng: () => Promise<number[]> } }).__hackbenchTest
      return hook.screenshotPng()
    })
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'panel.png'), Buffer.from(png))

    const tab = win.locator('.tabs-container .tab', { hasText: 'Emulator Preview' })
    await tab.first().click({ button: 'middle' })
    await expect(tab).toHaveCount(0, { timeout: 20_000 })

    const second = await openOnce('SECOND OPEN, cached title state')

    console.log('=== WEBVIEW LOGS ===\n' + logs.slice(-20).join('\n') + '\n')
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'status.txt'),
      `first (${first.ms}ms): ${first.text}\nsecond (${second.ms}ms): ${second.text}\n\n${logs.join('\n')}`,
    )
    expect(second.text).toContain('playable')
  })
})
