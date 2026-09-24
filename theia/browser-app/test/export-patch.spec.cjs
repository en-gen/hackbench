/**
 * HackBench: Export Patch, end to end against the shell.
 *
 * The acceptance case the owner cares about: change Mario's red through the
 * palette view, export, and the resulting .ips reproduces exactly that
 * change when applied to the base cartridge - the same round trip Mesen (or
 * any IPS patcher) would perform.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')
const ROM = process.env.HB_ROM || romPath(VANILLA)

const { decodeIps } = require('../../extension/lib/src/rom/Ips')
const { applyPatches } = require('../../extension/lib/src/rom/PatchLayer')
const { loromToOffset } = require('../../extension/lib/src/rom/addressing')

const MARIO_RED_ADDR = 0x00b2ce // SMWDisX/bank_00.asm:11257, :11324-11332

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-export-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

test('the Export Patch command is registered and reachable from the File menu', async ({
  page,
}) => {
  // A command registered but never contributed to a menu is unreachable -
  // a defect this project has shipped before (#379, see new-project.spec.cjs).
  const found = await page.evaluate(() => {
    const reg = getSvc('CommandRegistry')
    return reg.getAllCommands().some(c => c.id === 'hackbench.project.exportPatch')
  })
  expect(found).toBe(true)

  const inFileMenu = await page.evaluate(() => {
    const menus = getSvc('MenuModelRegistry')
    const root = menus.getMenu(['menubar']) || menus.getMenu([])
    const seen = new Set()
    const walk = node => {
      if (!node || seen.has(node)) return false
      seen.add(node)
      if (node.command === 'hackbench.project.exportPatch') return true
      if (node.id === 'hackbench.project.exportPatch') return true
      return (node.children || []).some(walk)
    }
    return walk(root)
  })
  expect(inFileMenu).toBe(true)
})

test('executing the command through CommandRegistry performs a real export', async ({ page }) => {
  const dir = path.join(tmp, 'ViaCommand')
  await page.evaluate(
    async ({ romPath, directory }) => {
      const projects = getSvc('Symbol(ProjectService)')
      const project = await projects.createProject({ romPath, name: 'ViaCommand', directory })
      // ProjectContext is what the command reads to know which project is open.
      const ctx = getSvc('ProjectContext')
      ctx.current = project
    },
    { romPath: ROM, directory: dir },
  )

  await page.evaluate(async () => {
    const reg = getSvc('CommandRegistry')
    await reg.executeCommand('hackbench.project.exportPatch')
  })
  await page.waitForTimeout(300)

  const exportDir = path.join(dir, 'export')
  expect(fs.existsSync(exportDir)).toBe(true)
  const files = fs.readdirSync(exportDir).filter(f => f.endsWith('.ips'))
  expect(files.length).toBe(1)
})

test('exporting after a palette edit produces an .ips that reproduces exactly that change', async ({
  page,
}) => {
  const dir = path.join(tmp, 'MyHack')
  const manifestPath = await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      const project = await svc.createProject({ romPath, name: 'MyHack', directory })
      return project.manifestPath
    },
    { romPath: ROM, directory: dir },
  )

  const setColorResult = await page.evaluate(async mp => {
    const svc = getSvc('Symbol(PaletteService)')
    return svc.setColor(mp, 0x00b2ce, '$391F', '$03E0')
  }, manifestPath)
  expect(setColorResult.status).toBe('ok')

  const exportResult = await page.evaluate(async mp => {
    const svc = getSvc('Symbol(ProjectService)')
    return svc.exportPatch(mp)
  }, manifestPath)

  expect(exportResult.status).toBe('ok')
  expect(exportResult.opCount).toBeGreaterThan(0)
  expect(exportResult.hasCopierHeader).toBe(false) // this fixture ships headerless
  expect(fs.existsSync(exportResult.path)).toBe(true)
  expect(exportResult.path).toContain(path.join(dir, 'export'))

  // Committed op file: address+old+new, never a raw cartridge byte.
  const opsDir = path.join(dir, 'ops')
  const opFiles = fs.readdirSync(opsDir).filter(f => f.endsWith('.json'))
  expect(opFiles.length).toBeGreaterThan(0)
  const layer = JSON.parse(fs.readFileSync(path.join(opsDir, opFiles[0]), 'utf8'))
  expect(layer.ops).toContainEqual({ address: '$00B2CE', old: '$391F', new: '$03E0' })

  // The real round trip: base cartridge + exported .ips = the working copy's
  // colour, applied with the SAME decoder Mesen or any other patcher uses.
  const baseBytes = new Uint8Array(fs.readFileSync(ROM))
  const ipsBytes = new Uint8Array(fs.readFileSync(exportResult.path))
  const patches = decodeIps(ipsBytes)
  expect(patches, 'the exported file must decode as a valid IPS').not.toBeNull()

  const patched = applyPatches(baseBytes, patches)
  const offset = loromToOffset(MARIO_RED_ADDR, baseBytes.length, false)
  const word = patched[offset] | (patched[offset + 1] << 8)
  expect(word).toBe(0x03e0)

  // And nothing else in the cartridge moved.
  let diffCount = 0
  for (let i = 0; i < baseBytes.length; i++) if (baseBytes[i] !== patched[i]) diffCount++
  expect(diffCount).toBe(2)
})

test('exporting with no edits still succeeds, with an empty patch', async ({ page }) => {
  const dir = path.join(tmp, 'Untouched')
  const manifestPath = await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      const project = await svc.createProject({ romPath, name: 'Untouched', directory })
      return project.manifestPath
    },
    { romPath: ROM, directory: dir },
  )

  const exportResult = await page.evaluate(async mp => {
    const svc = getSvc('Symbol(ProjectService)')
    return svc.exportPatch(mp)
  }, manifestPath)

  expect(exportResult.status).toBe('ok')
  expect(exportResult.opCount).toBe(0)
  const patches = decodeIps(new Uint8Array(fs.readFileSync(exportResult.path)))
  expect(patches).toEqual([])
})

test('a project whose cartridge is not on this machine cannot export', async ({ page }) => {
  const dir = path.join(tmp, 'Shared')
  const manifestPath = path.join(dir, 'Shared.hbproj')

  await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      await svc.createProject({ romPath, name: 'Shared', directory })
    },
    { romPath: ROM, directory: dir },
  )

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.baseRom.sha256 = 'f'.repeat(64)
  manifest.baseRom.title = 'SOMEONE ELSES CART'
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const exportResult = await page.evaluate(async mp => {
    const svc = getSvc('Symbol(ProjectService)')
    return svc.exportPatch(mp)
  }, manifestPath)

  expect(exportResult.status).toBe('rom-not-located')
  expect(exportResult.baseRom.title).toBe('SOMEONE ELSES CART')
})
