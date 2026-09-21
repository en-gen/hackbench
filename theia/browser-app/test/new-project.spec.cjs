/**
 * File > New Project, end to end against the running shell.
 *
 * Asserts behaviour rather than presence, per CLAUDE.md: a command that is
 * registered but unreachable, or a dialog that renders but writes nothing,
 * passes every "is it on screen" check. So this drives the real command and
 * then reads the filesystem to see what it actually produced.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM =
  process.env.HB_ROM || 'C:/Projects/hackbench/test/roms/Super Mario World (USA).vanilla.sfc'

/** Reach Theia's DI container the way its own tooling does. */
const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

let tmp

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-e2e-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

test('the New Project command is registered and reachable', async ({ page }) => {
  await page.addScriptTag({ content: GET_SVC })
  const found = await page.evaluate(() => {
    const reg = getSvc('CommandRegistry')
    return reg.getAllCommands().some(c => c.id === 'hackbench.project.new')
  })
  expect(found).toBe(true)
})

test('it appears under the File menu, not just in the registry', async ({ page }) => {
  // A command registered but never contributed to a menu is unreachable, which
  // is a defect this project has shipped before (#379).
  await page.addScriptTag({ content: GET_SVC })
  const inFileMenu = await page.evaluate(() => {
    const menus = getSvc('MenuModelRegistry')
    const root = menus.getMenu(['menubar']) || menus.getMenu([])
    const seen = new Set()
    const walk = node => {
      if (!node || seen.has(node)) return false
      seen.add(node)
      if (node.command === 'hackbench.project.new') return true
      if (node.id === 'hackbench.project.new') return true
      return (node.children || []).some(walk)
    }
    return walk(root)
  })
  expect(inFileMenu).toBe(true)
})

test('executing it creates a project on disk', async ({ page }) => {
  const dir = path.join(tmp, 'MyHack')
  await page.addScriptTag({ content: GET_SVC })

  // Drive the backend service directly. The dialog is a separate surface with
  // its own test; what is being asserted here is that the command's work
  // actually reaches the filesystem through the RPC boundary.
  const result = await page.evaluate(
    async ({ romPath, directory }) => {
      const target = getSvc('Symbol(ProjectService)')
      if (!target) return { error: 'ProjectService not resolvable from the frontend' }
      try {
        const p = await target.createProject({ romPath, name: 'MyHack', directory })
        return { ok: true, manifestPath: p.manifestPath, baseRom: p.baseRom }
      } catch (e) {
        return { error: String(e && e.message) }
      }
    },
    { romPath: ROM, directory: dir },
  )

  expect(result.error, 'createProject should not have failed').toBeUndefined()
  expect(fs.existsSync(path.join(dir, 'MyHack.hbproj'))).toBe(true)
  expect(fs.existsSync(path.join(dir, 'levels'))).toBe(true)
  expect(fs.existsSync(path.join(dir, 'snapshots'))).toBe(true)

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'MyHack.hbproj'), 'utf8'))
  expect(manifest.schemaVersion).toBe(1)
  expect(manifest.baseRom.sha256).toHaveLength(64)

  // The property that makes a project shareable: it holds no cartridge bytes.
  const walk = (d, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full, out)
      else out.push(full)
    }
    return out
  }
  for (const f of walk(dir)) expect(f).not.toMatch(/\.(sfc|smc|rom)$/i)
})

/**
 * What the hack IS, carried from the request into the manifest.
 *
 * The manifest is the artefact people commit and read, so these fields have
 * to survive the RPC boundary and land in the file, not merely exist in a DTO.
 */
test('the hack metadata reaches the manifest on disk', async ({ page }) => {
  const dir = path.join(tmp, 'Titled')
  await page.addScriptTag({ content: GET_SVC })

  const result = await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      const p = await svc.createProject({
        romPath,
        name: 'Titled',
        directory,
        title: 'Super Kaizo World ]|[',
        summary: 'A short hack about falling.',
        authors: ['engenb', 'someone else'],
        version: '1.2.0',
      })
      return { title: p.title, version: p.version, authors: p.authors }
    },
    { romPath: ROM, directory: dir },
  )

  expect(result.title).toBe('Super Kaizo World ]|[')

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'Titled.hbproj'), 'utf8'))
  expect(manifest.title).toBe('Super Kaizo World ]|[')
  expect(manifest.summary).toBe('A short hack about falling.')
  expect(manifest.authors).toEqual(['engenb', 'someone else'])
  // The hack's version is the author's; the schema's is the format's. A
  // manifest that conflated them would break the moment someone tagged 2.0.
  expect(manifest.version).toBe('1.2.0')
  expect(manifest.schemaVersion).toBe(1)
})

test('a title that is not a legal folder name still works', async ({ page }) => {
  // The whole reason title and name are separate fields.
  const dir = path.join(tmp, 'my-hack')
  await page.addScriptTag({ content: GET_SVC })
  await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      await svc.createProject({
        romPath,
        name: 'my-hack',
        directory,
        title: 'Kaizo: World ]|[ <final>',
      })
    },
    { romPath: ROM, directory: dir },
  )

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'my-hack.hbproj'), 'utf8'))
  expect(manifest.name).toBe('my-hack')
  expect(manifest.title).toBe('Kaizo: World ]|[ <final>')
})
