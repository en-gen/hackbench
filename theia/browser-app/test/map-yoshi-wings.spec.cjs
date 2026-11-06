/**
 * Yoshi Heaven in the Maps tree (#1229): it lists as a sub area of the map that holds the Yoshi wings
 * block, in that map's submap half, and follows the block when the working copy moves it.
 *
 * Needs the vanilla ROM (skips without it; CI has none, the synthetic cases are in
 * MapTree.wings.synthetic.test.ts). The edits are real working-copy layers: ops/ files the server
 * replays, the same bytes an edit writes (no object-move command exists yet to drive instead).
 * Evidence scope: vanilla US ROM, one machine; the block positions are the static read in the
 * issue, not a played run.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), 'needs the vanilla ROM')

/** Where each wings block's object sits: byte 1 of the single-tile object, with the object number after it (SNES address). */
const OBJECT_AT = { 0x00f: 0x06c096, 0x12c: 0x07b744 }

/** The little-endian word the ROM holds at a SNES address, read here so no ROM word is written into the spec. */
function wordAt(snes) {
  const bytes = fs.readFileSync(ROM)
  const header = bytes.length % 1024 === 512 ? 512 : 0
  const at = header + ((snes >> 16) & 0x7f) * 0x8000 + (snes & 0x7fff)
  return bytes[at] | (bytes[at + 1] << 8)
}
const hex = n => '$' + n.toString(16).toUpperCase().padStart(4, '0')
/** An op moving the object `by` columns: the column nibble is the low byte's low bits, so the word moves by `by`. */
function moveOp(slot, from, by) {
  const old = wordAt(OBJECT_AT[slot]) + from
  return {
    address: '$' + OBJECT_AT[slot].toString(16).toUpperCase().padStart(6, '0'),
    old: hex(old),
    new: hex(old + by),
  }
}
const YOSHI_HEAVEN = { icon: 'codicon-arrow-up', title: 'Entered by flying up on Yoshi wings' }

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}
function getWidget(id) {
  return getSvc('WidgetManager').getOrCreateWidget(id)
}`

let tmp
test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-wings-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})
test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** A project on vanilla with no seeded groups, the Maps tree loaded. */
async function load(page) {
  const dir = path.join(tmp, 'MyHack')
  const manifestPath = await page.evaluate(
    async ({ romPath: rom, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      const project = await svc.createProject({ romPath: rom, name: 'MyHack', directory })
      return project.manifestPath
    },
    { romPath: ROM, directory: dir },
  )
  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta', 'groups.json'), '[]\n')
  await page.evaluate(mp => getSvc('HackBenchContribution').openPath(mp), manifestPath)
  await reload(page, manifestPath)
  return { dir, manifestPath }
}

async function reload(page, manifestPath) {
  await page.evaluate(async mp => {
    const w = await getWidget('hackbench.map-explorer')
    await w.load(mp)
    await getSvc('ApplicationShell').activateWidget('hackbench.map-explorer')
  }, manifestPath)
  await page.waitForTimeout(800)
}

/** Writes working-copy layers the server replays: one word op each, stack order by file name. */
function writeLayers(dir, ops) {
  const folder = path.join(dir, 'ops')
  fs.rmSync(folder, { recursive: true, force: true })
  fs.mkdirSync(folder, { recursive: true })
  ops.forEach((op, i) => {
    const body = JSON.stringify({ id: 'wings-' + i, label: 'Move wings block', ops: [op] }, null, 2)
    fs.writeFileSync(path.join(folder, String(i + 1).padStart(4, '0') + '.json'), body + '\n')
  })
}

/** Slots listed under each top-level map, and the Unassigned rows, read from the model. */
async function snapshot(page) {
  return page.evaluate(async () => {
    const w = await getWidget('hackbench.map-explorer')
    const group = w.model.root.children.find(r => r.id === 'group:unassigned')
    const kids = n =>
      n ? n.children.map(c => ({ index: c.index, role: c.role ?? null, category: c.category })) : []
    const top = i => group.children.find(n => n.index === i)
    return {
      under: Object.fromEntries([0x00f, 0x115, 0x12c].map(i => [i, kids(top(i))])),
      unassigned: group.children.map(n => ({ index: n.index, category: n.category })),
    }
  })
}

const yoshiUnder = (snap, root) =>
  snap.under[root].filter(c => c.role === 'yoshi-heaven').map(c => c.index)

test('Yoshi Heaven lists under the three maps that hold the wings, not in Unassigned', async ({
  page,
}) => {
  await load(page)
  const snap = await snapshot(page)
  expect(yoshiUnder(snap, 0x00f)).toEqual([0x0c8])
  expect(yoshiUnder(snap, 0x115)).toEqual([0x1c8])
  expect(yoshiUnder(snap, 0x12c)).toEqual([0x1c8])
  expect(snap.unassigned.filter(n => [0x0c8, 0x1c8].includes(n.index))).toEqual([])
  expect(snap.under[0x00f].map(c => c.category)).toContain('subarea')
})

test('the Yoshi Heaven sub area row keeps its icon and its tooltip', async ({ page }) => {
  await load(page)
  const id = await page.evaluate(async () => {
    const w = await getWidget('hackbench.map-explorer')
    const group = w.model.root.children.find(r => r.id === 'group:unassigned')
    const parent = group.children.find(n => n.index === 0x00f)
    w.model.expandNode(parent)
    const node = parent.children.find(c => c.index === 0x0c8)
    w.focusService.setFocus(undefined)
    w.focusService.setFocus(node)
    w.updateScrollToRow()
    return node.id
  })
  await page.waitForTimeout(500)
  const row = page.locator(`[id="hackbench.map-explorer"] .theia-TreeNode[data-node-id="${id}"]`)
  await expect(row).toBeVisible()
  expect(await row.getAttribute('title')).toBe(YOSHI_HEAVEN.title)
  expect(await row.locator('.hb-map-icon').evaluate(e => [...e.classList])).toContain(
    YOSHI_HEAVEN.icon,
  )
})

test('moving the block in the working copy moves or removes the sub area', async ({ page }) => {
  const { dir, manifestPath } = await load(page)
  // $00F's block from column 161 to 162: the spawn there is not the wings, so $0C8 is no sub area of $00F.
  writeLayers(dir, [moveOp(0x00f, 0, 1)])
  await reload(page, manifestPath)
  let snap = await snapshot(page)
  expect(yoshiUnder(snap, 0x00f)).toEqual([])
  expect(yoshiUnder(snap, 0x115)).toEqual([0x1c8]) // the other half is untouched
  // Reached by no map now, it is a bonus row again, in Unassigned.
  expect(snap.unassigned.find(n => n.index === 0x0c8)).toEqual({ index: 0x0c8, category: 'bonus' })

  // Then to column 165, another column that gives the wings: the link is back.
  writeLayers(dir, [moveOp(0x00f, 0, 1), moveOp(0x00f, 1, 3)])
  await reload(page, manifestPath)
  snap = await snapshot(page)
  expect(yoshiUnder(snap, 0x00f)).toEqual([0x0c8])
  expect(snap.unassigned.find(n => n.index === 0x0c8)).toBeUndefined()

  // $12C's block off the wings column: $1C8 leaves $12C and stays under $115 (via $1E3).
  writeLayers(dir, [moveOp(0x12c, 0, 1)])
  await reload(page, manifestPath)
  snap = await snapshot(page)
  expect(yoshiUnder(snap, 0x12c)).toEqual([])
  expect(yoshiUnder(snap, 0x115)).toEqual([0x1c8])
  expect(yoshiUnder(snap, 0x00f)).toEqual([0x0c8])
})
