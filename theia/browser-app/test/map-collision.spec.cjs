/**
 * The map tab's collision overlay, en-gen/hackbench#435: floors, ceilings, slopes and walls as SVG lines over
 * the map, from SMW's own block code run on the 65816 core.
 *
 * Coordinates below are map pixels of vanilla maps, measured by the spike's engine and kept in
 * test/suite/support/collisionBaseline.ts (counts and a checksum) and CollisionProbe.corpus.test.ts (the same
 * segments, asserted on the lines the server returns). Here they are asserted on what the view DRAWS, so a
 * correct reply that the overlay drops, mislays or hides fails. Presence is never the assertion: the lines
 * are also read back as pixels.
 *
 * `data-control="collision-overlay"` is the one SVG, `data-group` is `surfaces`, `walls` or `unknown`,
 * `data-kind` the line's kind, `data-revision` how many replies the tab has taken.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

let tmp
const opened = []

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-collision-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(async ({ page }) => {
  await page.evaluate(async ids => {
    const shell = getSvc('ApplicationShell')
    for (const id of ids) {
      try {
        await shell.closeWidget(id)
      } catch {
        /* already closed */
      }
    }
  }, opened.splice(0))
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

async function createProject(page, dir) {
  return page.evaluate(
    async ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: dir },
  )
}

const root = index => `[id="hackbench.map-view:${index}"]`
const toggle = (page, index) => page.locator(`${root(index)} [data-control="collision-toggle"]`)
const overlay = (page, index) => page.locator(`${root(index)} [data-control="collision-overlay"]`)

async function openMap(page, manifestPath, index) {
  await page.evaluate(
    async ({ mp, index }) => {
      const wm = getSvc('WidgetManager')
      const w = await wm.getOrCreateWidget('hackbench.map-view', { index })
      await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp: manifestPath, index },
  )
  opened.push(`hackbench.map-view:${index}`)
  await expect(
    page.locator(`${root(index)} canvas[data-screen="0"][data-plane="l1Low"]`),
  ).toHaveAttribute('data-drawn', /^\d+:\d{4}:\d{3}:0$/, { timeout: 30000 })
}

/** Turns the overlay on and waits for the lines (a cold map is probed on the backend: seconds). */
async function showOverlay(page, index) {
  await expect(toggle(page, index)).toBeEnabled({ timeout: 30000 })
  await toggle(page, index).click()
  await expect(toggle(page, index)).toHaveAttribute('aria-pressed', 'true')
  await expect(overlay(page, index)).toHaveCount(1, { timeout: 60000 })
}

/** Every line as `kind:points`, in document order. */
const linesOf = (page, index) =>
  page.evaluate(
    sel =>
      [...document.querySelectorAll(`${sel} [data-control="collision-overlay"] polyline`)].map(
        p => `${p.dataset.kind}:${p.getAttribute('points')}`,
      ),
    root(index),
  )

test('the toggle shows and hides the overlay, with aria-pressed and its tooltip following', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  const t = toggle(page, 0x105)
  await expect(t).toBeEnabled({ timeout: 30000 })
  // Off by default: nothing drawn, not pressed.
  await expect(t).toHaveAttribute('aria-pressed', 'false')
  await expect(t).toHaveAttribute('title', 'Show collision')
  await expect(overlay(page, 0x105)).toHaveCount(0)
  // After the layer group 1 | 2 | 3 | S, before the separator.
  const order = await page
    .locator(`${root(0x105)} .hb-map-view-toolbar > [data-control]`)
    .evaluateAll(bs => bs.map(b => b.dataset.control))
  expect(order.slice(0, 6)).toEqual([
    'layer-l1',
    'layer-l2',
    'layer-l3',
    'layer-sprites',
    'collision-toggle',
    'toolbar-sep',
  ])

  await showOverlay(page, 0x105)
  await expect(t).toHaveAttribute('title', 'Hide collision')
  const kinds = await page.evaluate(
    sel => ({
      surfaces: document.querySelectorAll(`${sel} [data-group="surfaces"] polyline`).length,
      walls: document.querySelectorAll(`${sel} [data-group="walls"] polyline`).length,
    }),
    root(0x105),
  )
  // Counts of the spike's signed-off output for $105: 48 floors + 28 ceilings, 60 walls.
  expect(kinds).toEqual({ surfaces: 76, walls: 60 })

  await t.click()
  await expect(t).toHaveAttribute('aria-pressed', 'false')
  await expect(overlay(page, 0x105)).toHaveCount(0)
})

test('$105 draws its known floor, slope and wall at their map coordinates', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await showOverlay(page, 0x105)
  const lines = await linesOf(page, 0x105)
  // A one-tile ledge, a slope joined across tiles (one line from 176,335 down to 224,288), a wall.
  expect(lines).toContain('floor:832,384 848,384')
  expect(lines).toContain('floor:176,335 176.5,335 223.5,288 224,288')
  expect(lines).toContain('wall:3344,240 3344,256')
  // The wall is in the walls group and the floor in the surfaces group.
  const groups = await page.evaluate(
    sel => ({
      wall: document.querySelector(`${sel} [data-group="walls"] polyline`).dataset.kind,
      floor: document.querySelector(`${sel} [data-group="surfaces"] polyline`).dataset.kind,
    }),
    root(0x105),
  )
  expect(groups.wall).toBe('wall')
  expect(['floor', 'ceiling']).toContain(groups.floor)
})

test('$111 floor spikes carry a floor line along each spike cell', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x111)
  await showOverlay(page, 0x111)
  // Spike ids $159 at row 24 (y 384) under open air: columns 52-54 and 97-98 (x 832-880, 1552-1584).
  const covered = await page.evaluate(
    ({ sel, cells }) => {
      const floors = [...document.querySelectorAll(`${sel} [data-kind="floor"]`)].map(p =>
        p
          .getAttribute('points')
          .split(' ')
          .map(pt => pt.split(',').map(Number)),
      )
      return cells.map(([x, y]) =>
        floors.some(
          pts =>
            pts.every(([, py]) => py === y * 16) &&
            Math.min(...pts.map(p => p[0])) <= x * 16 &&
            Math.max(...pts.map(p => p[0])) >= x * 16 + 16,
        ),
      )
    },
    {
      sel: root(0x111),
      cells: [
        [52, 24],
        [53, 24],
        [54, 24],
        [97, 24],
        [98, 24],
      ],
    },
  )
  expect(covered).toEqual([true, true, true, true, true])
})

test('turning the overlay off and on again draws identical geometry', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await showOverlay(page, 0x105)
  const first = await linesOf(page, 0x105)
  expect(first.length).toBeGreaterThan(100)
  await toggle(page, 0x105).click()
  await expect(overlay(page, 0x105)).toHaveCount(0)
  await toggle(page, 0x105).click()
  await expect(overlay(page, 0x105)).toHaveCount(1, { timeout: 60000 })
  expect(await linesOf(page, 0x105)).toEqual(first)
})

/**
 * A wall's stroke as the user sees it: the number of purple pixels across the line, read from a screenshot
 * of the on-screen pixels (not from CSS, which a transform or a missing vector-effect would leave unchanged).
 */
async function strokePixels(page, index) {
  const at = await page.evaluate(sel => {
    const el = document.querySelector(`${sel} [data-group="walls"] polyline`)
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, h: r.height }
  }, root(index))
  const clip = { x: Math.floor(at.x) - 8, y: Math.floor(at.y), width: 16, height: 1 }
  const png = (await page.screenshot({ clip })).toString('base64')
  return page.evaluate(async b64 => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const row = g.getImageData(0, 0, img.width, 1).data
    // #d500f9 is (213, 0, 249): an edge pixel is a blend, so count anything leaning that way.
    let n = 0
    for (let i = 0; i < row.length; i += 4)
      if (row[i] > 110 && row[i + 1] < 110 && row[i + 2] > 140) n++
    return n
  }, png)
}

test('the lines paint, and zoom keeps a 2 CSS px stroke while the positions scale', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await showOverlay(page, 0x105)
  const zoomTo = async n => {
    await page.locator(`${root(0x105)} [data-control="zoom-actual"]`).click()
    for (let i = 0; i < n; i++)
      await page.locator(`${root(0x105)} [data-control="zoom-in"]`).click()
    await page.waitForTimeout(500)
  }
  const measure = () =>
    page.evaluate(sel => {
      const svg = document.querySelector(`${sel} [data-control="collision-overlay"]`)
      const line = svg.querySelector('[data-group="walls"] polyline')
      const cs = getComputedStyle(line)
      return {
        scale: svg.getScreenCTM().a,
        width: svg.getBoundingClientRect().width,
        strokeWidth: cs.strokeWidth,
        vectorEffect: cs.vectorEffect,
        points: line.getAttribute('points'),
      }
    }, root(0x105))

  await zoomTo(0)
  const one = await measure()
  const onePx = await strokePixels(page, 0x105)
  await zoomTo(3)
  const big = await measure()
  const bigPx = await strokePixels(page, 0x105)

  // Positions scale with the zoom: the SVG's box and its transform both grew by the same factor...
  expect(big.scale).toBeGreaterThan(one.scale * 1.5)
  expect(big.width / one.width).toBeCloseTo(big.scale / one.scale, 2)
  // ...in map coordinates, so the points themselves are unchanged...
  expect(big.points).toBe(one.points)
  // ...while the stroke stays 2 CSS px wide.
  for (const m of [one, big]) {
    expect(m.vectorEffect).toBe('non-scaling-stroke')
    expect(m.strokeWidth).toBe('2px')
  }
  // Read back as pixels: the lines really paint, 2 px wide (3 at most with an anti-aliased edge) at both zooms.
  expect(onePx).toBeGreaterThanOrEqual(2)
  expect(onePx).toBeLessThanOrEqual(3)
  expect(bigPx).toBeGreaterThanOrEqual(2)
  expect(bigPx).toBeLessThanOrEqual(3)
})

test('a working-copy edit refetches the open map and the overlay stays', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await showOverlay(page, 0x105)
  const revision = () => overlay(page, 0x105).getAttribute('data-revision').then(Number)
  const before = await linesOf(page, 0x105)
  const r0 = await revision()
  // A Map16 graphics edit: it moves no collision byte, so the lines must be the same, but the
  // working copy changed, so the view must ask again (the revision counts the replies it took).
  const edit = await page.evaluate(
    ({ mp }) =>
      getSvc('Symbol(Map16Service)').setQuadrantField(mp, 1, 'fg', { bg: 0, fg: 0 }, 349, 'tl', 'priority', true), // prettier-ignore
    { mp: project.manifestPath },
  )
  expect(edit.status).toBe('ok')
  await expect.poll(revision, { timeout: 60000 }).toBeGreaterThan(r0)
  await expect(overlay(page, 0x105)).toHaveCount(1)
  expect(await linesOf(page, 0x105)).toEqual(before)
})

test('a vertical level disables the toggle with the reason, never an empty overlay', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x109)
  const t = toggle(page, 0x109)
  await expect(t).toBeDisabled({ timeout: 60000 })
  await expect(t).toHaveAttribute('aria-pressed', 'false')
  await expect(t).toHaveAttribute('title', /^Collision unavailable: .*vertical/i)
  await expect(overlay(page, 0x109)).toHaveCount(0)
})
