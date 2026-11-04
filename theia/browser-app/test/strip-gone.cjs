/**
 * Shared by the specs that assert the map view's facts strip and Header panel are gone (#1008,
 * ruling D121). Plain CommonJS, run in the Playwright runner.
 */

/**
 * Waits until the map view tab `widgetId` has reached its end state for the current open, and
 * held it for 5 animation frames: the details, layout (or its screen error), sprites, block
 * contents and start have all answered and no screen request is in flight. An absence read
 * before this could pass only because a late note had not been drawn yet.
 */
async function viewSettled(page, widgetId) {
  await page.evaluate(() => {
    window.hbSettleStreak = 0
  })
  await page.waitForFunction(
    id => {
      const w = getSvc('ApplicationShell').getWidgetById(id)
      const done =
        !!w &&
        w.detailsGeneration === w.generation &&
        w.pending.size === 0 &&
        w.startState !== 'pending' &&
        !!(w.mapLayout || w.screenError) &&
        !!(w.sprites || w.spritesWhy) &&
        !!(w.blocks || w.blocksWhy)
      window.hbSettleStreak = done ? window.hbSettleStreak + 1 : 0
      return window.hbSettleStreak >= 5
    },
    widgetId,
    { polling: 'raf', timeout: 30000 },
  )
}

/**
 * What only the strip and the Header panel said, including the wordings the removed warnings
 * used. Counts are in the strip's own form (" · 3 objects", "20 screens, horizontal"), so the
 * kept "Unverified: 34 sprites" note and the toolbar's sprite tooltips cannot match. The
 * toolbar is still left out of the text it is run on.
 */
const STRIP_WORDS =
  /name unavailable|level data unavailable|orientation unavailable|objects unavailable|start unavailable|Header bytes|\d+ screens, (?:horizontal|vertical|orientation)| · \d+ (?:objects|sprites)\b|FG\/BG and sprite GFX files|This map's sprite list could not be read|Graphics may not match the game|The object list could not be read|Whether this map is vertical could not be read|details could not be read/i

module.exports = { viewSettled, STRIP_WORDS }
