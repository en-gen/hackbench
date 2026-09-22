/**
 * HackBench: painting GFX tiles, end to end against the shell.
 *
 * Every assertion here is about BEHAVIOUR, not presence. The two defects
 * this suite is shaped around are the ones a "did it render" check cannot
 * see: a swatch strip that draws sixteen colours for an eight-colour sheet
 * (so half of it paints something the cartridge cannot hold), and a save
 * that quietly does nothing on a cartridge with no room, leaving the user
 * believing their artwork shipped.
 *
 * The strongest case runs the whole round trip in Node: paint, save, export
 * an .ips, apply it to the base cartridge with the same decoder any patcher
 * uses, and read the painted pixel back out of the result.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROMS = process.env.HB_ROMS || 'C:/Projects/hackbench/test/roms'
const ROM = process.env.HB_ROM || path.join(ROMS, 'Super Mario World (USA).vanilla.sfc')
/** Measured zero-slack cartridge: its packed GFX region ends exactly where
 *  its last file does, so the first single-pixel edit overflows. See
 *  docs/gfx-arena-budget.md. */
const PACKED_ROM = path.join(ROMS, 'GrandPooWorld_V1.2.sfc')
/** Replaces the LC_LZ2 decompressor entry at $00B8DE. */
const INVICTUS_ROM = path.join(ROMS, 'Invictus 1.0.sfc')

const { decodeIps } = require('../../extension/lib/src/rom/Ips')
const { applyPatches } = require('../../extension/lib/src/rom/PatchLayer')
const { RomFile } = require('../../extension/lib/src/rom/RomFile')
const { GfxTable } = require('../../extension/lib/src/rom/GfxTable')

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}
function getWidget(id) {
  const wm = getSvc('WidgetManager')
  return wm.getOrCreateWidget(id)
}`

let tmp

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-paint-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

async function createProject(page, romPath, name) {
  return page.evaluate(
    async ({ rom, directory, projectName }) => {
      const svc = getSvc('Symbol(ProjectService)')
      return svc.createProject({ romPath: rom, name: projectName, directory })
    },
    { rom: romPath, directory: path.join(tmp, name), projectName: name },
  )
}

/**
 * Open GFX file `index` in a pinned painter tab and wait for its canvas.
 *
 * Goes through PreviewTabs, the same path the explorer's row handler takes,
 * so the widget is attached and keyed exactly as a real double-click leaves
 * it. Driving the tree itself is gfx-view.spec.cjs's job; this suite is
 * about what happens once a sheet is open.
 */
async function openSheet(page, manifestPath, index = 0) {
  await page.evaluate(
    async ({ mp, i }) => {
      const explorer = await getWidget('hackbench.gfx-explorer')
      await explorer.load(mp)
      const previews = getSvc('PreviewTabs')
      if (!previews) throw new Error('PreviewTabs is not bound; the painter cannot be opened')
      await previews.pin(
        'hackbench.gfx-view',
        { index: i },
        w => w.open({ manifestPath: mp, index: i, label: `GFX ${i}` }),
        p => p.shows(i),
      )
    },
    { mp: manifestPath, i: index },
  )
  await page.waitForSelector('#hb-gfx-canvas', { timeout: 15000 })
  await page.waitForTimeout(400)
}

/** The RGBA at one sheet pixel, read off the live canvas. */
async function pixelAt(page, px, py) {
  return page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector('#hb-gfx-canvas')
      const d = canvas.getContext('2d').getImageData(x, y, 1, 1).data
      return [d[0], d[1], d[2], d[3]]
    },
    { x: px, y: py },
  )
}

/** Paint through the widget's own coordinate entry point, so the test does
 *  not depend on how a pointer event maps onto a zoomed canvas. */
async function paint(page, px, py) {
  await page.evaluate(
    async ({ x, y }) => {
      const wm = getSvc('WidgetManager')
      const w = wm.getWidgets('hackbench.gfx-view')[0]
      await w.paintAt(x, y)
    },
    { x: px, y: py },
  )
  await page.waitForTimeout(200)
}

test('the swatch strip offers exactly the colours the depth can express', async ({ page }) => {
  // The defect: a fixed 16 swatches. Eight of them would paint indices a
  // 3bpp sheet cannot hold, and the server would refuse every stroke with
  // no hint from the UI about why.
  const project = await createProject(page, ROM, 'Swatches')
  await openSheet(page, project.manifestPath, 0)

  await expect(page.locator('#hb-gfx-swatches button')).toHaveCount(8)

  await page.selectOption('#hb-gfx-bpp-select', '4')
  await page.waitForTimeout(500)
  await expect(page.locator('#hb-gfx-swatches button')).toHaveCount(16)

  await page.selectOption('#hb-gfx-bpp-select', '2')
  await page.waitForTimeout(500)
  await expect(page.locator('#hb-gfx-swatches button')).toHaveCount(4)
})

test('clicking a swatch then a pixel paints that exact colour', async ({ page }) => {
  const project = await createProject(page, ROM, 'PaintOne')
  await openSheet(page, project.manifestPath, 0)

  // Pick an index the sheet is not already showing at this pixel, read from
  // the strip itself rather than assumed, so the assertion is "it became
  // THIS colour" and not the much weaker "it changed".
  const target = { x: 3, y: 5 }
  const before = await pixelAt(page, target.x, target.y)

  const swatch = await page.evaluate(() => {
    const wm = getSvc('WidgetManager')
    const w = wm.getWidgets('hackbench.gfx-view')[0]
    return w.sheet.paletteColors.map(c => [c.r, c.g, c.b, c.a])
  })
  const index = swatch.findIndex((c, i) => i > 0 && c[3] > 0 && c.join() !== before.join())
  expect(index, 'this sheet offers no second opaque colour to paint with').toBeGreaterThan(0)

  await page.click(`#hb-gfx-swatch-${index}`)
  await expect(page.locator(`#hb-gfx-swatch-${index}`)).toHaveAttribute('aria-pressed', 'true')

  // Captured BEFORE the stroke: comparing a neighbour against itself after
  // the fact is an assertion that cannot fail.
  const neighbourBefore = await pixelAt(page, target.x + 1, target.y)

  await paint(page, target.x, target.y)

  expect(await pixelAt(page, target.x, target.y)).toEqual(swatch[index])
  // And only that pixel: a bitplane write that spilled sideways would still
  // "change the colour" at the pixel under test.
  expect(await pixelAt(page, target.x + 1, target.y)).toEqual(neighbourBefore)
})

test('index 0 is the eraser: painting it makes the pixel transparent', async ({ page }) => {
  const project = await createProject(page, ROM, 'Erase')
  await openSheet(page, project.manifestPath, 0)

  // Find a pixel that is currently opaque, so erasing it is a visible change.
  const opaque = await page.evaluate(() => {
    const canvas = document.querySelector('#hb-gfx-canvas')
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0) {
        const p = i / 4
        return { x: p % canvas.width, y: Math.floor(p / canvas.width) }
      }
    }
    return null
  })
  expect(opaque, 'the sheet painted nothing opaque to erase').not.toBeNull()

  await page.click('#hb-gfx-swatch-0')
  await paint(page, opaque.x, opaque.y)

  const after = await pixelAt(page, opaque.x, opaque.y)
  expect(after[3]).toBe(0)
})

test('an unsaved edit says so, and reaches the cartridge only on save', async ({ page }) => {
  const project = await createProject(page, ROM, 'DirtyState')
  await openSheet(page, project.manifestPath, 0)

  await expect(page.locator('#hb-gfx-dirty')).toHaveAttribute('data-dirty', 'false')
  await expect(page.locator('#hb-gfx-save')).toBeDisabled()

  await page.click('#hb-gfx-swatch-1')
  await paint(page, 4, 4)

  await expect(page.locator('#hb-gfx-dirty')).toHaveAttribute('data-dirty', 'true')
  await expect(page.locator('#hb-gfx-dirty')).toContainText(/only when you save/i)
  await expect(page.locator('#hb-gfx-save')).toBeEnabled()

  // Not yet on the cartridge: an export taken now carries nothing, which is
  // the claim the dirty notice is making.
  const beforeSave = await page.evaluate(async mp => {
    const svc = getSvc('Symbol(ProjectService)')
    return svc.exportPatch(mp)
  }, project.manifestPath)
  expect(beforeSave.status).toBe('ok')
  expect(beforeSave.opCount).toBe(0)

  // The stroke IS on disk though, as intent rather than bytes.
  const opsFile = path.join(tmp, 'DirtyState', 'gfx', 'pixels.json')
  expect(fs.existsSync(opsFile)).toBe(true)
  const doc = JSON.parse(fs.readFileSync(opsFile, 'utf8'))
  expect(doc.ops.length).toBe(1)
  expect(doc.ops[0].kind).toBe('gfxPixel')
})

test('a saved edit survives export, apply and re-decode', async ({ page }) => {
  // The full round trip, the acceptance the spec asks for: set a pixel,
  // save, reload from the resulting bytes, read the same pixel back.
  const project = await createProject(page, ROM, 'RoundTrip')
  await openSheet(page, project.manifestPath, 0)

  const value = 5
  const op = { file: 0, tile: 9, x: 2, y: 6 }
  const set = await page.evaluate(
    async ({ mp, pixel }) => {
      const svc = getSvc('Symbol(GfxService)')
      return svc.setGfxPixel(mp, pixel)
    },
    { mp: project.manifestPath, pixel: { ...op, value } },
  )
  expect(set.status).toBe('ok')

  const save = await page.evaluate(async mp => {
    const svc = getSvc('Symbol(GfxService)')
    return svc.saveGfx(mp)
  }, project.manifestPath)
  expect(save.status).toBe('ok')
  expect(save.bytesChanged).toBeGreaterThan(0)

  const exported = await page.evaluate(async mp => {
    const svc = getSvc('Symbol(ProjectService)')
    return svc.exportPatch(mp)
  }, project.manifestPath)
  expect(exported.status).toBe('ok')
  expect(exported.opCount).toBeGreaterThan(0)

  const base = new Uint8Array(fs.readFileSync(ROM))
  const patches = decodeIps(new Uint8Array(fs.readFileSync(exported.path)))
  expect(patches, 'the exported file must decode as a valid IPS').not.toBeNull()
  const patched = applyPatches(base, patches)

  const table = GfxTable.load(new RomFile('patched.sfc', Buffer.from(patched)))
  expect(table.tile(op.file, op.tile)[op.y * 8 + op.x]).toBe(value)

  // The other 49 files still decode: a pointer rewrite that dropped one
  // would leave the cartridge booting to garbage graphics.
  for (let i = 0; i < 50; i++) {
    expect(table.files[i].template.length, `GFX ${i} stream`).toBeGreaterThan(0)
  }
})

test('a save that cannot fit surfaces the overage instead of failing silently', async ({
  page,
}) => {
  test.skip(!fs.existsSync(PACKED_ROM), 'the packed-cartridge fixture is not on this machine')

  const project = await createProject(page, PACKED_ROM, 'Packed')
  await openSheet(page, project.manifestPath, 0)

  await page.click('#hb-gfx-swatch-1')
  await paint(page, 4, 4)
  await page.click('#hb-gfx-save')
  await page.waitForSelector('#hb-gfx-save-message', { timeout: 15000 })

  const message = page.locator('#hb-gfx-save-message')
  await expect(message).toHaveAttribute('data-status', 'overflow')
  // The number, not just the word: "cannot save" with no size tells the user
  // nothing about whether they are 3 bytes over or 3000.
  const overage = Number(await message.getAttribute('data-overage'))
  expect(overage).toBeGreaterThan(0)
  await expect(message).toContainText(/bytes too big/i)
  await expect(message).toContainText('446')

  // Nothing was written: a refusal that half-applied would be worse than
  // one that reported the overage.
  const exported = await page.evaluate(async mp => {
    const svc = getSvc('Symbol(ProjectService)')
    return svc.exportPatch(mp)
  }, project.manifestPath)
  expect(exported.status).toBe('ok')
  expect(exported.opCount).toBe(0)
})

test('a cartridge with a replaced decompressor is refused, not corrupted', async ({ page }) => {
  test.skip(!fs.existsSync(INVICTUS_ROM), 'the Invictus fixture is not on this machine')

  const project = await createProject(page, INVICTUS_ROM, 'Patched')
  const save = await page.evaluate(async mp => {
    const svc = getSvc('Symbol(GfxService)')
    return svc.saveGfx(mp)
  }, project.manifestPath)

  expect(save.status).toBe('unavailable')
  expect(save.reason).toMatch(/LC_LZ2/i)

  const exported = await page.evaluate(async mp => {
    const svc = getSvc('Symbol(ProjectService)')
    return svc.exportPatch(mp)
  }, project.manifestPath)
  expect(exported.opCount).toBe(0)
})

test('a painted pixel is still there after the tab is closed and reopened', async ({ page }) => {
  // Replay, not memory: the widget is thrown away and the ops come back off
  // disk into a rebuilt table.
  const project = await createProject(page, ROM, 'Reopen')
  await openSheet(page, project.manifestPath, 0)
  await page.click('#hb-gfx-swatch-1')
  await paint(page, 3, 3)
  const painted = await pixelAt(page, 3, 3)

  await page.evaluate(() => {
    const wm = getSvc('WidgetManager')
    wm.getWidgets('hackbench.gfx-view').forEach(w => w.close())
  })
  await page.waitForTimeout(500)
  await openSheet(page, project.manifestPath, 0)

  expect(await pixelAt(page, 3, 3)).toEqual(painted)
  await expect(page.locator('#hb-gfx-dirty')).toHaveAttribute('data-dirty', 'true')
})
