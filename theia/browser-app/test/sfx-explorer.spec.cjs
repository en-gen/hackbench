/**
 * Sound effects in the audio explorer, end to end.
 *
 * The assertion that matters is the audio one. A player that loads a
 * snapshot and produces silence passes every "is the player there" check,
 * so playing an effect is checked by MEASURING THE SAMPLES it produces: an
 * AnalyserNode is spliced in after the engine's gain node and the peak
 * deviation from centre is read back.
 *
 * That also lets the converse be asserted, which is the more interesting
 * half. Port 0's $22 points at a phrase that is a bare end marker, so it
 * must be SILENT, and a player that made noise for it would be wrong in a
 * way no listing check could see.
 *
 * This runs in Playwright's headless Chromium, which has no audio output
 * device, so nothing here reaches speakers.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA, GPW2 } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
const ROM_ADDMUSICK = process.env.HB_ROM_UNREADABLE_BANK || romPath(GPW2)

/** Measured on the three stock-engine ROMs; see docs/sfx-tables.md. */
const STOCK = { port0: 42, port3: 52, total: 94 }

/**
 * Minimum peak, in byte units away from the 128 centre, for "audible".
 *
 * Not `> 0`: peak 1 is about 0.4% of full scale, so a regression leaving
 * playback at a thousandth of level would pass. Real effects measure
 * roughly 14 to 60 here, so 8 is well clear of both silence and of a
 * mis-resolved DSP volume table.
 */
const AUDIBLE_FLOOR = 8

/** Port 0 ids whose phrase is a bare end marker, so they render silent. */
const SILENT_IDS = ['$22', '$24']

const PANEL = '#hackbench\\.music-explorer'

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}
function getWidget(id) { return getSvc('WidgetManager').getOrCreateWidget(id) }`

let tmp

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sfx-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

async function load(page, dir, romPath = ROM) {
  return page.evaluate(
    async ({ romPath, directory }) => {
      const project = await getSvc('Symbol(ProjectService)').createProject({
        romPath,
        name: 'Sfx',
        directory,
      })
      const w = await getWidget('hackbench.music-explorer')
      await w.load(project.manifestPath)
      const group = (w.model.root.children || []).find(r => r.id === 'group:sfx')
      const ports = (group.children || []).map(p => ({
        name: p.name,
        kind: p.kind,
        count: (p.children || []).length,
        ids: (p.children || []).map(c => c.bgmHex),
        silent: (p.children || []).filter(c => c.silent).map(c => c.bgmHex),
      }))
      return {
        manifestPath: project.manifestPath,
        summary: group.summary,
        childNames: (group.children || []).map(c => c.name),
        ports,
        sfxRefusal: w.sfxRefusal,
      }
    },
    { romPath, directory: dir },
  )
}

/**
 * Play one effect and report the peak amplitude it produces.
 *
 * The analyser is spliced in after the engine's own gain node, so what is
 * measured is what would reach the speakers. Returns the largest deviation
 * from the 128 centre line seen over a short window, which is 0 for
 * silence.
 */
async function playAndMeasure(page, port, id) {
  return page.evaluate(
    async ({ port, id }) => {
      const w = await getWidget('hackbench.music-explorer')
      const group = (w.model.root.children || []).find(r => r.id === 'group:sfx')
      const folder = (group.children || []).find(p => p.name.includes(`port ${port}`))
      const node = (folder.children || []).find(n => n.bgmCommand === id)
      if (!node) return { error: `no entry for port ${port} id ${id}` }

      await w.playSfx(node)

      const backend = window.SMWCentral && window.SMWCentral.SPCPlayer.Backend
      if (!backend || !backend.context) return { error: 'no audio backend' }

      const ctx = backend.context
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      backend.gainNode.connect(analyser)

      const buf = new Uint8Array(analyser.fftSize)
      let peak = 0
      // Sample repeatedly: an effect is short, and one snapshot could land
      // between phrases and read silence for a sound that is not silent.
      for (let i = 0; i < 40; i++) {
        analyser.getByteTimeDomainData(buf)
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
        await new Promise(r => setTimeout(r, 25))
      }
      backend.gainNode.disconnect(analyser)
      return { peak, playing: w.playingTrack === node, error: w.playbackError }
    },
    { port, id },
  )
}

test('both port tables appear as folders with their own counts', async ({ page }) => {
  const result = await load(page, path.join(tmp, 'Sfx'))

  expect(result.summary).toBe(String(STOCK.total))
  expect(result.ports.map(p => p.count)).toEqual([STOCK.port0, STOCK.port3])
  expect(result.ports[0].name).toContain('$1DF9')
  expect(result.ports[1].name).toContain('$1DFC')
})

test('entries are labelled in hex only, never with a guessed name', async ({ page }) => {
  // A ROM holds no names for effects any more than it does for tracks, and
  // the id is the whole of an entry's ROM-derived identity.
  const result = await load(page, path.join(tmp, 'Sfx'))

  expect(result.ports[0].ids.slice(0, 3)).toEqual(['$01', '$02', '$03'])
  for (const id of result.ports[0].ids) expect(id).toMatch(/^\$[0-9A-F]{2}$/)
})

test('the empty phrases are flagged, and only those', async ({ page }) => {
  const result = await load(page, path.join(tmp, 'Sfx'))

  expect(result.ports[0].silent).toEqual(SILENT_IDS)
  expect(result.ports[1].silent).toEqual([])
})

test('playing an effect produces actual audio, not just a running player', async ({ page }) => {
  await load(page, path.join(tmp, 'Sfx'))

  const measured = await playAndMeasure(page, 0, 0x01)

  expect(measured.error).toBeFalsy()
  expect(measured.playing).toBe(true)
  // A loaded-but-frozen core reports a running player and renders nothing,
  // so the samples are what is checked, against a floor rather than zero.
  expect(measured.peak).toBeGreaterThan(AUDIBLE_FLOOR)
})

test('an empty phrase really is silent', async ({ page }) => {
  // Port 0's $22 points at a bare end marker. The panel says silent; the
  // samples have to agree, or the flag is decoration.
  await load(page, path.join(tmp, 'Sfx'))

  const measured = await playAndMeasure(page, 0, 0x22)

  expect(measured.error).toBeFalsy()
  expect(measured.peak).toBe(0)
})

test('a port 3 effect plays, so the port really is carried through', async ({ page }) => {
  // Port 3 writes a different input register than port 0. Getting that
  // wrong is silent: the snapshot still loads and simply does nothing.
  await load(page, path.join(tmp, 'Sfx'))

  const measured = await playAndMeasure(page, 3, 0x01)

  expect(measured.error).toBeFalsy()
  expect(measured.peak).toBeGreaterThan(AUDIBLE_FLOOR)
})

test('an AddmusicK ROM reports unavailable with a reason, not an empty folder', async ({
  page,
}) => {
  test.skip(
    !fs.existsSync(ROM_ADDMUSICK),
    `ROM fixture not present on this machine (${ROM_ADDMUSICK})`,
  )
  // The point of the whole feature. Listing the stock 42 and 52 here would
  // name effects this ROM does not have and play none of them.
  const result = await load(page, path.join(tmp, 'Amk'), ROM_ADDMUSICK)

  expect(result.summary).toBe('unavailable')
  expect(result.childNames.join(' ')).toMatch(/not readable/i)
  expect(result.sfxRefusal).toMatch(/could not be verified|no sound effect table reader/i)
  // Never the stock answer, in any form.
  expect(result.sfxRefusal).not.toContain('5683')
  expect(result.sfxRefusal).not.toContain('561B')
})

test('no snapshot is built for an unavailable ROM', async ({ page }) => {
  test.skip(
    !fs.existsSync(ROM_ADDMUSICK),
    `ROM fixture not present on this machine (${ROM_ADDMUSICK})`,
  )
  const result = await load(page, path.join(tmp, 'Amk'), ROM_ADDMUSICK)

  const built = await page.evaluate(
    async mp => getSvc('Symbol(MusicService)').sfxSpc(mp, 0, 0x01),
    result.manifestPath,
  )
  expect(built).toBeNull()
})

test('the sfx rows are reachable by a real click in the panel', async ({ page }) => {
  await load(page, path.join(tmp, 'Sfx'))
  await page.locator('#shell-tab-hackbench\\.map-explorer').click()
  await page.locator('#shell-tab-hackbench\\.music-explorer').click()
  await page.waitForSelector(`${PANEL} .theia-TreeNode`, { timeout: 15000 })

  await page.evaluate(async () => {
    const w = await getWidget('hackbench.music-explorer')
    await w.model.expandNode((w.model.root.children || []).find(r => r.id === 'group:sfx'))
  })

  // Wait for the row to paint rather than reading straight after the
  // expand: the tree re-renders asynchronously and a bare read races it.
  const portRow = page.locator(`${PANEL} .hb-music-groupname`, { hasText: 'port 0' })
  await expect(portRow).toBeVisible({ timeout: 15000 })
})
