/**
 * The Objects activity (#1236), end to end: real clicks on the real sheet.
 *
 * Every assertion is on BEHAVIOUR, not presence. "No tile can be tagged" is
 * proved by the sheet having no tile cells at all, then by a tagged tile
 * appearing in the right list; the sheet is proved to be the tileset's by
 * comparing its canvas pixels with what Map16Service.loadMap16 returns for
 * that tileset; a palette change is proved by the pixels changing WHILE the
 * saved file stays byte-identical.
 *
 * "The working copy bytes are identical" is checked through what the working
 * copy is made of: the base ROM file, every file under ops/ (the layers
 * applied on it), and the decoded Map16 sheet of every tileset, hashed before
 * and after. A save, rename or delete may change none of them.
 *
 * Needs the vanilla corpus ROM; skipped without it.
 */
const { test, expect } = require('@playwright/test')
const nodeCrypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const ROM = process.env.HB_ROM || romPath(VANILLA)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

const VIEW = '.hb-objects-view'
const ctl = name => `${VIEW} [data-control="${name}"]`

let tmp

test.skip(!fs.existsSync(ROM), 'needs the vanilla corpus ROM')

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-objects-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** Creates the project (optionally planting files first), makes it current and shows the activity. */
async function openProject(page, dir, { plant } = {}) {
  const project = await page.evaluate(
    async ({ romPath: rom, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath: rom, name: 'MyHack', directory }),
    { romPath: ROM, directory: dir },
  )
  if (plant) plant(path.join(dir, 'meta', 'objects'))
  await showActivity(page, project)
  return project.manifestPath
}

async function showActivity(page, project) {
  await page.evaluate(async p => {
    getSvc('ProjectContext').current = p
    await getSvc('ApplicationShell').activateWidget('hackbench.objects')
  }, project)
  await page.waitForSelector(ctl('tileset-select'))
}

function objectsDir(manifestPath) {
  return path.join(path.dirname(manifestPath), 'meta', 'objects')
}

function savedFiles(manifestPath) {
  const dir = objectsDir(manifestPath)
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
}

async function pickTileset(page, n) {
  await page.selectOption(ctl('tileset-select'), String(n))
  await page.waitForSelector(`${ctl('sheet')}[data-tileset="${n}"]`)
  await page.waitForSelector(ctl('tile'))
}

const tile = (page, n) => page.locator(`${ctl('tile')}[data-tile="${n}"]`)
const items = (page, role) => page.locator(`${ctl(`${role}-item`)}`)
const itemNumbers = async (page, role) =>
  (await items(page, role).evaluateAll(els => els.map(e => Number(e.dataset.tile)))).sort(
    (a, b) => a - b,
  )

/** Position-weighted, so a mirrored or shifted image does not hash like the original. */
async function sheetChecksum(page) {
  return page.evaluate(sel => {
    const c = document.querySelector(sel)
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let h = 0
    for (let i = 0; i < d.length; i++) h = (h * 31 + d[i] * (i % 251) + i) >>> 0
    return h
  }, ctl('sheet-canvas'))
}

async function nameAndSave(page, name) {
  await page.fill(ctl('name-input'), name)
  await page.click(ctl('save'))
  await expect(page.locator(ctl('message'))).toContainText(`Saved "${name}"`)
}

function sha(bytes) {
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex')
}

function treeBytes(dir) {
  const h = nodeCrypto.createHash('sha256')
  if (!fs.existsSync(dir)) return h.digest('hex')
  const walk = d =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .forEach(e => {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else h.update(path.relative(dir, p)).update(fs.readFileSync(p))
      })
  walk(dir)
  return h.digest('hex')
}

/** Base ROM + ops/ + every tileset's decoded sheet: what the working copy is made of. */
async function workingCopyFingerprint(page, manifestPath) {
  const sheets = await page.evaluate(async mp => {
    const svc = getSvc('Symbol(Map16Service)')
    const out = []
    for (let t = 0; t < 15; t++) {
      const r = await svc.loadMap16(mp, t, 'fg', { bg: 0, fg: 0 })
      out.push(r.status === 'ok' ? r.sheet.rgbaBase64 : r.status)
    }
    return out
  }, manifestPath)
  return {
    rom: sha(fs.readFileSync(ROM)),
    ops: treeBytes(path.join(path.dirname(manifestPath), 'ops')),
    sheets: sha(sheets.join('|')),
  }
}

test('no tile can be tagged before a tileset is picked, and the sheet is that tileset after', async ({
  page,
}) => {
  const manifestPath = await openProject(page, path.join(tmp, 'Pick'))

  expect(await page.locator(ctl('tile')).count()).toBe(0)
  await expect(page.locator(ctl('sheet-empty'))).toBeVisible()
  await expect(page.locator(ctl('role-edge'))).toBeDisabled()
  await expect(page.locator(ctl('role-fill'))).toBeDisabled()
  await expect(page.locator(ctl('save'))).toBeDisabled()

  await pickTileset(page, 3)

  const expected = await page.evaluate(async mp => {
    const r = await getSvc('Symbol(Map16Service)').loadMap16(mp, 3, 'fg', { bg: 0, fg: 0 })
    return { count: r.sheet.tiles.length, rgba: r.sheet.rgbaBase64, w: r.sheet.width }
  }, manifestPath)
  expect(await page.locator(ctl('tile')).count()).toBe(expected.count)
  expect(expected.count).toBe(512)
  const drawn = await page.evaluate(sel => {
    const c = document.querySelector(sel)
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let bin = ''
    for (let i = 0; i < d.length; i++) bin += String.fromCharCode(d[i])
    return btoa(bin)
  }, ctl('sheet-canvas'))
  expect(drawn).toBe(expected.rgba)

  // Another tileset draws other pixels; the sheet follows the pick.
  const before = await sheetChecksum(page)
  await pickTileset(page, 7)
  expect(await sheetChecksum(page)).not.toBe(before)
})

test('a tile has one role: edge then fill leaves it in the fill list, and a second click untags it', async ({
  page,
}) => {
  await openProject(page, path.join(tmp, 'Roles'))
  await pickTileset(page, 1)

  await page.click(ctl('role-edge'))
  await tile(page, 256).click()
  expect(await itemNumbers(page, 'edge')).toEqual([256])
  expect(await itemNumbers(page, 'fill')).toEqual([])
  await expect(tile(page, 256)).toHaveAttribute('data-role', 'edge')

  await page.click(ctl('role-fill'))
  await tile(page, 256).click()
  expect(await itemNumbers(page, 'edge')).toEqual([])
  expect(await itemNumbers(page, 'fill')).toEqual([256])
  await expect(tile(page, 256)).toHaveAttribute('data-role', 'fill')

  await tile(page, 256).click()
  expect(await itemNumbers(page, 'edge')).toEqual([])
  expect(await itemNumbers(page, 'fill')).toEqual([])
  await expect(tile(page, 256)).toHaveAttribute('data-role', 'none')
})

test('a definition saves, survives a reload with the same tileset and tags, renames and deletes', async ({
  page,
}) => {
  const dir = path.join(tmp, 'Persist')
  const manifestPath = await openProject(page, dir)
  await pickTileset(page, 2)
  await page.click(ctl('role-edge'))
  await tile(page, 258).click()
  await page.click(ctl('role-fill'))
  await tile(page, 300).click()
  await tile(page, 259).click()
  await nameAndSave(page, 'Ledge')

  const files = savedFiles(manifestPath)
  expect(files).toHaveLength(1)
  const file = path.join(objectsDir(manifestPath), files[0])
  const id = files[0].replace(/\.json$/, '')
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
    version: 1,
    id,
    name: 'Ledge',
    tileset: 2,
    edge: [258],
    fill: [259, 300],
  })

  // Reload the whole app and reopen the project: nothing in memory survives.
  const project = await page.evaluate(
    mp => getSvc('Symbol(ProjectService)').openProject(mp),
    manifestPath,
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  await showActivity(page, project)

  await page.click(`${ctl('definition-row')}[data-id="${id}"]`)
  await page.waitForSelector(`${ctl('sheet')}[data-tileset="2"]`)
  await expect(page.locator(ctl('tileset-select'))).toHaveValue('2')
  await expect(page.locator(ctl('name-input'))).toHaveValue('Ledge')
  expect(await itemNumbers(page, 'edge')).toEqual([258])
  expect(await itemNumbers(page, 'fill')).toEqual([259, 300])

  // Rename: same file, same id, new name, tags as saved.
  await page.fill(ctl('name-input'), 'Long ledge')
  await page.click(ctl('rename'))
  await expect(page.locator(ctl('message'))).toContainText('Renamed to "Long ledge"')
  expect(savedFiles(manifestPath)).toEqual([`${id}.json`])
  const renamed = JSON.parse(fs.readFileSync(file, 'utf8'))
  expect(renamed).toMatchObject({
    id,
    name: 'Long ledge',
    tileset: 2,
    edge: [258],
    fill: [259, 300],
  })

  // Delete takes two clicks, then the file is gone.
  await page.click(ctl('delete'))
  expect(fs.existsSync(file)).toBe(true)
  await page.click(ctl('delete-confirm'))
  await expect(page.locator(ctl('message'))).toContainText('Deleted')
  expect(fs.existsSync(file)).toBe(false)
  expect(await page.locator(ctl('definition-row')).count()).toBe(0)
})

test('the preview palette changes the drawn colors and leaves the saved file byte-identical', async ({
  page,
}) => {
  const manifestPath = await openProject(page, path.join(tmp, 'Preview'))
  await pickTileset(page, 1)
  await page.click(ctl('role-edge'))
  await tile(page, 270).click()
  await nameAndSave(page, 'Tinted')
  const file = path.join(objectsDir(manifestPath), savedFiles(manifestPath)[0])
  const saved = fs.readFileSync(file)

  const before = await sheetChecksum(page)
  await page.selectOption(ctl('fg-variant-select'), '3')
  await expect.poll(() => sheetChecksum(page)).not.toBe(before)
  await page.selectOption(ctl('bg-variant-select'), '5')
  expect(fs.readFileSync(file).equals(saved)).toBe(true)

  // Saving again under the other colors writes the same bytes: no palette is stored.
  await page.click(ctl('save'))
  await expect(page.locator(ctl('message'))).toContainText('Saved "Tinted"')
  expect(fs.readFileSync(file).equals(saved)).toBe(true)
  expect(fs.readFileSync(file, 'utf8')).not.toMatch(/palette|variant|color/i)
})

test('save, rename and delete leave the working copy bytes identical', async ({ page }) => {
  const manifestPath = await openProject(page, path.join(tmp, 'Bytes'))
  const before = await workingCopyFingerprint(page, manifestPath)

  await pickTileset(page, 4)
  await tile(page, 260).click()
  await nameAndSave(page, 'Bytes check')
  expect(await workingCopyFingerprint(page, manifestPath)).toEqual(before)

  await page.fill(ctl('name-input'), 'Bytes check 2')
  await page.click(ctl('rename'))
  await expect(page.locator(ctl('message'))).toContainText('Renamed')
  expect(await workingCopyFingerprint(page, manifestPath)).toEqual(before)

  await page.click(ctl('delete'))
  await page.click(ctl('delete-confirm'))
  await expect(page.locator(ctl('message'))).toContainText('Deleted')
  expect(await workingCopyFingerprint(page, manifestPath)).toEqual(before)
})

test('a damaged file and a file from another tileset show a note, and the activity still works', async ({
  page,
}) => {
  const dir = path.join(tmp, 'Damaged')
  const manifestPath = await openProject(page, dir, {
    plant(objects) {
      fs.mkdirSync(objects, { recursive: true })
      fs.writeFileSync(path.join(objects, 'broken.json'), '{ nope')
      fs.writeFileSync(
        path.join(objects, 'elsewhere.json'),
        JSON.stringify({
          version: 1,
          id: 'elsewhere',
          name: 'Other ROM',
          tileset: 99,
          edge: [1],
          fill: [2],
        }),
      )
      fs.writeFileSync(
        path.join(objects, 'good0001.json'),
        JSON.stringify({
          version: 1,
          id: 'good0001',
          name: 'Fine',
          tileset: 1,
          edge: [256],
          fill: [257],
        }),
      )
    },
  })
  const notes = page.locator(ctl('skipped-note'))
  await expect(notes).toHaveCount(2)
  const text = (await notes.allTextContents()).join('\n')
  expect(text).toContain('This Object file could not be read:')
  expect(text).toContain('not readable JSON')
  expect(text).toContain('not one this ROM has')
  await expect(page.locator(ctl('definition-row'))).toHaveCount(1)

  // The good one opens and the activity still tags and saves.
  await page.click(`${ctl('definition-row')}[data-id="good0001"]`)
  await page.waitForSelector(`${ctl('sheet')}[data-tileset="1"]`)
  expect(await itemNumbers(page, 'edge')).toEqual([256])
  await page.click(ctl('role-fill'))
  await tile(page, 300).click()
  await nameAndSave(page, 'Fine')
  expect(
    JSON.parse(fs.readFileSync(path.join(objectsDir(manifestPath), 'good0001.json'), 'utf8')).fill,
  ).toEqual([257, 300])

  // The damaged files are exactly as planted.
  expect(fs.readFileSync(path.join(objectsDir(manifestPath), 'broken.json'), 'utf8')).toBe('{ nope')
})
