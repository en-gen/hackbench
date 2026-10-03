/**
 * The Playwright suite, slowed down and narrated so it can be watched.
 *
 * Same actions and the same assertions as the specs, with a caption overlay
 * and pauses. It is not a substitute for the suite: it exists because several
 * of these assertions check things that are invisible by nature (a map COUNT,
 * a colour that has to move when the theme does, a tree node that exists in
 * the model but renders nowhere).
 *
 * Run with the dev server already up:
 *   node test/demo.cjs [pace-ms]
 *
 * HB_CHANNEL picks the browser. It defaults to msedge because Playwright's
 * bundled headed Chromium fails to start on this machine ("side-by-side
 * configuration is incorrect", a missing VC++ runtime); its headless shell is
 * a separate binary and is unaffected, which is why the suite itself runs.
 * HB_VIDEO=<dir> also records the run, so it can be watched afterwards or on
 * another machine.
 */
const { chromium } = require('@playwright/test')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const PACE = Number(process.argv[2] || 1600)
const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
const VANILLA_MAPS = 235

const sleep = ms => new Promise(r => setTimeout(r, ms))

const BOOT = `
function getSvc(n) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const x = typeof k === 'function' ? k.name : String(k)
    if (x === n) return window.theia.container.get(k)
  }
  return null
}
function getWidget(i) { return getSvc('WidgetManager').getOrCreateWidget(i) }
`

/** Caption overlay, injected into the page so it rides along with the UI. */
const OVERLAY = `
(() => {
  const el = document.createElement('div')
  el.id = '__demo_caption'
  el.style.cssText = [
    'position:fixed','left:0','right:0','bottom:0','z-index:2147483647',
    'background:rgba(12,12,12,.94)','color:#eaeaea','padding:14px 20px',
    'font:14px/1.5 "Segoe UI",system-ui,sans-serif','pointer-events:none',
    'border-top:2px solid #0078d4','white-space:pre-wrap',
  ].join(';')
  document.body.appendChild(el)
  window.__caption = (title, detail, verdict) => {
    el.innerHTML =
      '<div style="font-weight:600;color:#4ec9b0">' + title + '</div>' +
      '<div style="opacity:.85">' + detail + '</div>' +
      (verdict ? '<div style="margin-top:4px;color:#9cdcfe">' + verdict + '</div>' : '')
  }
})()
`

async function main() {
  const channel = process.env.HB_CHANNEL || 'msedge'
  const video = process.env.HB_VIDEO
  const browser = await chromium.launch({
    headless: process.env.HB_HEADLESS === '1',
    slowMo: 120,
    ...(channel === 'bundled' ? {} : { channel }),
  })
  const page = await browser.newPage({
    viewport: { width: 1360, height: 860 },
    ...(video ? { recordVideo: { dir: video, size: { width: 1360, height: 860 } } } : {}),
  })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-demo-'))

  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: BOOT })
  await page.evaluate(OVERLAY)

  const say = async (title, detail, verdict) => {
    await page.evaluate(({ t, d, v }) => window.__caption(t, d, v), {
      t: title,
      d: detail,
      v: verdict || '',
    })
    console.log(`\n${title}\n  ${detail}${verdict ? `\n  ${verdict}` : ''}`)
    await sleep(PACE)
  }
  const ok = c => (c ? 'PASS' : 'FAIL')

  // 1. Create a project, which is where a cartridge gets paired to this machine.
  await say(
    '1. Create a project',
    'A project names its cartridge by HASH and never by path, so it can be',
    'committed and shared. The path is recorded per-user, in the ROM registry.',
  )

  const created = await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      const proj = await svc.createProject({ romPath, name: 'MyHack', directory })
      return {
        manifestPath: proj.manifestPath,
        title: proj.baseRom.title,
        sha: proj.baseRom.sha256,
      }
    },
    { romPath: ROM, directory: path.join(tmp, 'MyHack') },
  )

  await say(
    '1. Create a project',
    `cart: ${created.title}`,
    `sha256 ${created.sha.slice(0, 16)}...  manifest written  ${ok(!!created.manifestPath)}`,
  )

  // 2. Load the maps. The count is the assertion, and it is derived per ROM.
  await say(
    '2. Load every map',
    'The count comes from the ROM, never from a constant: a hack with 354 maps',
    'reports 354. docs/glossary.md documents vanilla as 235.',
  )

  const loaded = await page.evaluate(async mp => {
    const w = await getWidget('hackbench.map-explorer')
    await w.load(mp)
    await getSvc('ApplicationShell').activateWidget('hackbench.map-explorer')
    const walk = n => [n, ...(n.children || []).flatMap(walk)]
    const roots = w.model.root.children
    return {
      mapCount: w.mapCount,
      distinct: new Set(roots.flatMap(r => r.children.flatMap(walk)).map(n => n.index)).size,
      groups: roots.map(r => r.name),
      overworld: roots[0].children.length,
      unassigned: roots[1].children.length,
    }
  }, created.manifestPath)
  await sleep(PACE)

  await say(
    '2. Load every map',
    `widget reports ${loaded.mapCount} maps; ${loaded.distinct} distinct slots are reachable in the tree`,
    `expected ${VANILLA_MAPS}  ${ok(loaded.mapCount === VANILLA_MAPS && loaded.distinct === VANILLA_MAPS)}`,
  )

  // 3. Grouping. A correct count with a flat tree passes every count check.
  await say(
    '3. Grouped, not dumped',
    `roots: ${loaded.groups.join(' / ')} -- ${loaded.overworld} levels, ${loaded.unassigned} unassigned`,
    'A flattening bug yields the right COUNT with everything at depth 0.',
  )

  const depth = await page.evaluate(async () => {
    const w = await getWidget('hackbench.map-explorer')
    const d = (n, k = 0) => (n.children.length ? Math.max(...n.children.map(c => d(c, k + 1))) : k)
    const roots = w.model.root.children[0].children
    for (const n of roots.slice(0, 8)) if (n.children.length) await w.model.expandNode(n)
    return Math.max(0, ...roots.map(n => d(n)))
  })
  await sleep(PACE)
  await say(
    '3. Grouped, not dumped',
    `deepest sub-area nesting under a level: ${depth}`,
    `needs > 0  ${ok(depth > 0)}`,
  )

  // 4. Rendered, not merely modelled. This one caught a real defect.
  await say(
    '4. Rows actually render',
    'The tree virtualises its rows, so a widget that is attached but NOT VISIBLE',
    'renders zero rows however full its model is. That shipped during this build.',
  )

  const rows = await page.locator('#hackbench\\.map-explorer .theia-TreeNode').count()
  const slots = await page.locator('#hackbench\\.map-explorer .hb-map-slot').allTextContents()
  const wellFormed = slots.every(s => /^\$[0-9A-F]{3}$/.test(s))
  await say(
    '4. Rows actually render',
    `${rows} rows in the DOM, ${slots.length} slot labels`,
    `all labels well-formed hex  ${ok(rows > 2 && slots.length > 0 && wellFormed)}`,
  )

  // 5. Theming. People customise the look; a pinned colour opts out of that.
  await say(
    '5. The theme is respected',
    'Nothing we render carries an inline style, because an inline style outranks',
    'every rule a theme contributes. Checked on our own elements.',
  )

  const inlined = await page
    .locator(
      '#hackbench\\.map-explorer .hb-map-slot[style], ' +
        '#hackbench\\.map-explorer .hb-map-name[style], ' +
        '#hackbench\\.map-explorer .hb-map-note[style]',
    )
    .count()
  await say(
    '5. The theme is respected',
    `inline styles on our elements: ${inlined}`,
    `needs 0  ${ok(inlined === 0)}`,
  )

  const sample = () =>
    page.evaluate(
      () =>
        getComputedStyle(document.querySelector('#hackbench\\.map-explorer .hb-map-slot')).color,
    )
  const setTheme = async t => {
    await page.evaluate(x => {
      getSvc('ThemeService').setCurrentTheme(x)
    }, t)
    await sleep(PACE)
  }

  await say(
    '6. Colours move with the theme',
    'Absence of inline styles is not enough: a rule that resolves to nothing',
    'would also pass. So switch the theme and watch the colour change.',
  )
  await setTheme('dark')
  const dark = await sample()
  await setTheme('light')
  const light = await sample()
  await say(
    '6. Colours move with the theme',
    `dark ${dark}  ->  light ${light}`,
    `must differ  ${ok(dark !== light)}`,
  )
  await setTheme('dark')

  // 7. The sharing case: a project whose cartridge this machine has never seen.
  await say(
    '7. A cartridge this machine has not seen',
    'What every collaborator hits after cloning a project. It must read as',
    '"locate it", not as an error and not as an empty tree.',
  )

  const sharedDir = path.join(tmp, 'Shared')
  await page.evaluate(
    async ({ romPath, directory }) => {
      await getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'Shared', directory })
    },
    { romPath: ROM, directory: sharedDir },
  )

  const manifestPath = path.join(sharedDir, 'Shared.hbproj')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.baseRom.sha256 = 'f'.repeat(64)
  manifest.baseRom.title = 'SOMEONE ELSES CART'
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const shared = await page.evaluate(async mp => {
    const res = await getSvc('Symbol(ProjectService)').loadMaps(mp)
    const w = await getWidget('hackbench.map-explorer')
    await w.load(mp)
    return { status: res.status, rows: w.model.root.children.map(n => n.name) }
  }, manifestPath)
  await sleep(PACE)
  await say(
    '7. A cartridge this machine has not seen',
    `status: ${shared.status} -- "${shared.rows.join(' ')}"`,
    `names the cart and asks for it  ${ok(shared.status === 'rom-not-located')}`,
  )

  // 8. Put the real project back so the window ends on something worth seeing.
  await page.evaluate(async mp => {
    const w = await getWidget('hackbench.map-explorer')
    await w.load(mp)
    const roots = w.model.root.children[0].children
    for (const n of roots.slice(0, 8)) if (n.children.length) await w.model.expandNode(n)
  }, created.manifestPath)

  await say(
    'Done',
    `${VANILLA_MAPS} maps, grouped, rendered and themed.`,
    'Every assertion above is in test/load-maps.spec.cjs, and each was proven to go red.',
  )
  await sleep(PACE * 3)

  fs.rmSync(tmp, { recursive: true, force: true })
  const clip = video ? page.video() : null
  await browser.close()
  if (clip)
    console.log(`
video: ${await clip.path()}`)
}

main().catch(e => {
  console.error('DEMO FAILED:', e.message)
  process.exit(1)
})
