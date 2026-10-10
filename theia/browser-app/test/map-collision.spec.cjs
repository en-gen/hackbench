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
const { startTestServer } = require('./start-test-server.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
// A named skip, not a createProject throw per case, when the ROM is not on this machine (docs/testing.md).
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

let tmp
let rpc
const opened = []

/**
 * Counts the page's RPC calls to `mapCollision` and `mapCollisionCheck` from the websocket frames it sends
 * (docs/testing.md, Playwright and RPC). Wrapping the proxy's methods in the page cannot work: the proxy builds
 * a fresh function per property access, so the widget never calls the wrapper. The frames are socket.io binary
 * attachments of msgpack, where a short string is one byte 0xa0 + length, then the characters. A name counts
 * only when that byte is its own, so `mapCollision` is never found inside `mapCollisionCheck` (0xb1 prefix).
 * Registered before the first goto. It sees only frames sent over the websocket: socket.io starts on HTTP long-polling
 * and upgrades, so a call sent before the upgrade is invisible here (docs/testing.md). Theia 1.75, one machine.
 */
function countRpc(page) {
  const counts = { mapCollision: 0, mapCollisionCheck: 0 }
  page.on('websocket', ws =>
    ws.on('framesent', ({ payload }) => {
      const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
      for (const name of Object.keys(counts)) {
        const needle = Buffer.from(name)
        for (let at = buf.indexOf(needle); at > 0; at = buf.indexOf(needle, at + 1))
          if (buf[at - 1] === 0xa0 + needle.length) counts[name]++
      }
    }),
  )
  return counts
}

async function boot(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
}

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-collision-'))
  rpc = countRpc(page)
  await boot(page, APP)
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
  // Enabled is not enough: the toggle is enabled until the cheap check answers. Wait for its verdict.
  await expect(toggle(page, index)).toHaveAttribute('data-collision-state', 'ready', {
    timeout: 30000,
  })
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
  await expect(t).toHaveAttribute('data-collision-state', 'ready', { timeout: 30000 })
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

test('opening a map with the toggle off probes nothing; pressing it does', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  // The counter must be proven before a zero means anything: opening a map asks the cheap check.
  await expect.poll(() => rpc.mapCollisionCheck, { timeout: 30000 }).toBeGreaterThan(0)
  await expect(toggle(page, 0x105)).toBeEnabled({ timeout: 30000 })
  await page.waitForTimeout(3000)
  expect(rpc.mapCollision).toBe(0)
  // And it rises on the press, the call this case is about.
  await showOverlay(page, 0x105)
  expect(rpc.mapCollision).toBeGreaterThan(0)
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

/** The view's generation: the first token of a drawn screen's `data-drawn`, bumped by every working-copy refresh. */
const generation = (page, index) =>
  page
    .locator(`${root(index)} canvas[data-screen="0"][data-plane="l1Low"]`)
    .getAttribute('data-drawn')
    .then(d => d && d.split(':')[0])

test('off and on again shows the same lines', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await showOverlay(page, 0x105)
  const first = await linesOf(page, 0x105)
  await toggle(page, 0x105).click()
  await expect(overlay(page, 0x105)).toHaveCount(0)
  await toggle(page, 0x105).click()
  await expect(overlay(page, 0x105)).toHaveCount(1)
  expect(await linesOf(page, 0x105)).toEqual(first)
})

test('off, a working-copy edit, then on draws identical geometry from a fresh fetch', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await showOverlay(page, 0x105)
  const first = await linesOf(page, 0x105)
  expect(first.length).toBeGreaterThan(100)
  const generationBefore = await generation(page, 0x105)
  await toggle(page, 0x105).click()
  await expect(overlay(page, 0x105)).toHaveCount(0)
  // An edit while off drops the stale lines (nothing in the view still holds them), so the next press
  // must fetch again: the geometry below is a new reply, not the object shown before.
  const edit = await page.evaluate(
    ({ mp }) =>
      getSvc('Symbol(Map16Service)').setQuadrantField(mp, 1, 'fg', { bg: 0, fg: 0 }, 349, 'tl', 'priority', true), // prettier-ignore
    { mp: project.manifestPath },
  )
  expect(edit.status).toBe('ok')
  // Wait for the view to have taken the edit: its screens repaint under a new generation.
  await expect.poll(() => generation(page, 0x105), { timeout: 30000 }).not.toBe(generationBefore)
  await toggle(page, 0x105).click()
  await expect(overlay(page, 0x105)).toHaveCount(1, { timeout: 60000 })
  expect(Number(await overlay(page, 0x105).getAttribute('data-revision'))).toBeGreaterThanOrEqual(2)
  expect(await linesOf(page, 0x105)).toEqual(first)
})

test('a palace toggle with the overlay on changes the collision lines and the layer 1 screens', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x15)
  await showOverlay(page, 0x15)
  const off = await linesOf(page, 0x15)
  // The "!" blocks of $015 sit at columns 118-121 (screen 7): scroll that screen in, so its layer 1 is drawn.
  const l1 = `${root(0x15)} canvas[data-screen="7"][data-plane="l1Low"]`
  await page.locator(l1).evaluate(el => el.scrollIntoView({ inline: 'start', block: 'nearest' }))
  await expect(page.locator(l1)).toHaveAttribute('data-drawn', /^\d+:0000:000:7$/, {
    timeout: 30000,
  })
  const revision = () => overlay(page, 0x15).getAttribute('data-revision').then(Number)
  const r0 = await revision()
  await page.locator(`${root(0x15)} [data-control="palace-yellow"]`).click()
  // Layer 1 for the new state (yellow pressed) and a new collision reply, both from the one toggle.
  await expect(page.locator(l1)).toHaveAttribute('data-drawn', /^\d+:1000:000:7$/, {
    timeout: 30000,
  })
  await expect.poll(revision, { timeout: 60000 }).toBeGreaterThan(r0)
  const on = await linesOf(page, 0x15)
  expect(on.length).toBeGreaterThan(off.length)
  // The ghost cells at columns 118-121, row 24 are solid now: a floor along their tops (y 384, x 1888-1952).
  const along = on.some(l => {
    if (!l.startsWith('floor:')) return false
    const pts = l
      .slice(6)
      .split(' ')
      .map(p => p.split(',').map(Number))
    return (
      pts.every(([, y]) => y === 384) &&
      Math.min(...pts.map(p => p[0])) <= 1888 &&
      Math.max(...pts.map(p => p[0])) >= 1952
    )
  })
  expect(along).toBe(true)
  // Off again: the first state's lines return.
  await page.locator(`${root(0x15)} [data-control="palace-yellow"]`).click()
  await expect
    .poll(async () => (await linesOf(page, 0x15)).length, { timeout: 60000 })
    .toBe(off.length)
  expect(await linesOf(page, 0x15)).toEqual(off)
})

async function holdFirstReply(page) {
  // Hold the first mapCollision reply: the widget's own `projects` property is swapped for a Proxy, since a
  // wrapper on the RPC proxy is never reached (docs/testing.md, Playwright and RPC).
  await page.evaluate(() => {
    const w = getSvc('WidgetManager')
      .getWidgets('hackbench.map-view')
      .find(x => x.id === 'hackbench.map-view:21')
    const real = w.projects
    window.__held = false
    window.__release = undefined
    w.projects = new Proxy(real, {
      get: (t, k) => {
        if (k !== 'mapCollision') return typeof t[k] === 'function' ? t[k].bind(t) : t[k]
        return async (...a) => {
          const r = await t.mapCollision(...a)
          if (!window.__held) {
            window.__held = true // only the first reply is held back
            await new Promise(res => (window.__release = res))
          }
          return r
        }
      },
    })
  })
}

async function yellowFloor(page) {
  const lines = await linesOf(page, 0x15)
  return lines.some(l => {
    if (!l.startsWith('floor:')) return false
    const pts = l
      .slice(6)
      .split(' ')
      .map(p => p.split(',').map(Number))
    return (
      pts.every(([, y]) => y === 384) &&
      Math.min(...pts.map(p => p[0])) <= 1888 &&
      Math.max(...pts.map(p => p[0])) >= 1952
    )
  })
}

/**
 * The race: the overlay on for the unpressed state, a reply held back, off, yellow pressed, the old reply
 * lands, on. The lines shown must be the yellow ones, not the old state's.
 */
test('off, a palace toggle, the old reply landing late, then on shows the new state', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x15)
  await holdFirstReply(page)
  await expect(toggle(page, 0x15)).toHaveAttribute('data-collision-state', 'ready', {
    timeout: 30000,
  })
  await toggle(page, 0x15).click() // asks for the unpressed state; the reply is held
  // Bounded: a hold that never engages (a swapped property the widget does not read) fails here, not hangs.
  await expect.poll(() => page.evaluate(() => !!window.__release), { timeout: 60000 }).toBe(true)
  await toggle(page, 0x15).click() // off
  await page.locator(`${root(0x15)} [data-control="palace-yellow"]`).click()
  await page.evaluate(() => window.__release()) // the old reply lands now
  await page.waitForTimeout(500)
  await toggle(page, 0x15).click() // on, for yellow
  await expect(overlay(page, 0x15)).toHaveCount(1, { timeout: 60000 })
  const along = await yellowFloor(page)
  expect(along, 'the yellow "!" blocks have a floor at y 384, x 1888-1952').toBe(true)
  // The held reply and the yellow one: two probe calls, so the "on" really asked again.
  expect(rpc.mapCollision).toBeGreaterThanOrEqual(2)
})

/**
 * The seq guard alone (#691, `seq !== this.collisionSeq`). The case above releases the held reply before the
 * second "on", so the palace drop and the collisionKey check force a fresh fetch with or without the guard. Here
 * the second "on" has already been answered when the stale reply lands: only the seq guard keeps it out.
 */
test('a stale reply landing after the yellow overlay is up does not replace it', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x15)
  await holdFirstReply(page)
  await expect(toggle(page, 0x15)).toHaveAttribute('data-collision-state', 'ready', {
    timeout: 30000,
  })
  await toggle(page, 0x15).click() // on, unpressed; the reply is held
  await expect.poll(() => page.evaluate(() => !!window.__release), { timeout: 60000 }).toBe(true)
  await toggle(page, 0x15).click() // off
  await page.locator(`${root(0x15)} [data-control="palace-yellow"]`).click()
  await toggle(page, 0x15).click() // on, for yellow: asks afresh, not held
  await expect(overlay(page, 0x15)).toHaveCount(1, { timeout: 60000 })
  expect(await yellowFloor(page), 'yellow overlay up before the stale reply').toBe(true)
  const revision = await overlay(page, 0x15).getAttribute('data-revision')
  await page.evaluate(() => window.__release()) // the stale reply lands now
  // A bounded settle, not a poll: the pass condition is that nothing changes, so there is no event to wait for.
  await page.waitForTimeout(500)
  await expect(overlay(page, 0x15)).toHaveCount(1)
  expect(await yellowFloor(page), 'the stale reply left the yellow floor').toBe(true)
  expect(await overlay(page, 0x15).getAttribute('data-revision')).toBe(revision)
})

test('the command toggles the overlay like the button, and is disabled where the button is', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await expect(toggle(page, 0x105)).toHaveAttribute('data-collision-state', 'ready', {
    timeout: 30000,
  })
  const run = () =>
    page.evaluate(() => getSvc('CommandRegistry').executeCommand('hackbench.maps.toggleCollision'))
  await run()
  await expect(toggle(page, 0x105)).toHaveAttribute('aria-pressed', 'true')
  await expect(overlay(page, 0x105)).toHaveCount(1, { timeout: 60000 })
  await run()
  await expect(toggle(page, 0x105)).toHaveAttribute('aria-pressed', 'false')
  await expect(overlay(page, 0x105)).toHaveCount(0)
  // A refused map: button disabled, command disabled with it.
  await openMap(page, project.manifestPath, 0x109)
  await expect(toggle(page, 0x109)).toHaveAttribute('data-collision-state', 'refused', {
    timeout: 60000,
  })
  const enabled = await page.evaluate(() =>
    getSvc('CommandRegistry').isEnabled('hackbench.maps.toggleCollision'),
  )
  expect(enabled).toBe(false)
})

test('a second visit to a map is served from the backend cache', async ({ page }) => {
  // Its own backend, started from this worktree's built lib/backend/main.js (own-backend.cjs), not the server
  // HB_APP_URL points at: the probe cache is process-wide and carries over per ROM path (map-collision.ts), so on the
  // shared server an earlier case's visit to $105 would make this one's "cold" visit warm.
  const server = await startTestServer({ wait: true })
  try {
    await boot(page, server.url)
    await cacheCase(page)
  } finally {
    server.stop()
  }
})

async function cacheCase(page) {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  const visit = async () => {
    await openMap(page, project.manifestPath, 0x105)
    await expect(toggle(page, 0x105)).toHaveAttribute('data-collision-state', 'ready', {
      timeout: 30000,
    })
    const t0 = Date.now()
    await toggle(page, 0x105).click()
    await expect(overlay(page, 0x105)).toHaveCount(1, { timeout: 60000 })
    const ms = Date.now() - t0
    await page.evaluate(
      async id => getSvc('ApplicationShell').closeWidget(id),
      'hackbench.map-view:261',
    )
    await expect(page.locator(root(0x105))).toHaveCount(0)
    return ms
  }
  const cold = await visit()
  const warm = await visit()
  // The cold visit probes tiles (seconds); the revisit is a cache hit and a render.
  expect(warm).toBeLessThan(cold / 2)
  expect(warm).toBeLessThan(1500)
  // Both visits asked the backend: the speed-up is its cache, not the view skipping the call.
  expect(rpc.mapCollision).toBe(2)
}

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
  const t0 = Date.now()
  await expect.poll(revision, { timeout: 60000 }).toBeGreaterThan(r0)
  // The edit touched no byte a probe read, so the cache is kept: the refresh is a recompose, not a re-probe
  // (a cold $105 probe took 3.4-5.8 s in 3 cache-case visits). Measured 368-958 ms over 5 runs on develop
  // 63bbfdd7 (a warm shared server, not in file order); in file order, after the 13 cases before it on a fresh
  // server, 872-950 ms over 5 runs on this branch (the 1,915 ms of #706 on 00911ba2 was also in file order, before
  // the cache case had its own server). One machine. The bound sits above those and below the cold probe, so a re-probe fails it.
  expect(Date.now() - t0).toBeLessThan(2500)
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
