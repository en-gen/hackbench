/**
 * HackBench: Export Patch, end to end against the shell.
 *
 * The acceptance case the owner cares about: change Mario's red through the
 * palette view, export, and the resulting BPS reproduces exactly that
 * change when applied to the base cartridge with HackBench's own applyBps.
 * IPS stays available as a second command for tools that still want it.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')
const ROM = process.env.HB_ROM || romPath(VANILLA)

const { applyBps } = require('../../extension/lib/src/rom/Bps')
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

function commandReachableFromFileMenu(commandId) {
  return page =>
    page.evaluate(id => {
      const menus = getSvc('MenuModelRegistry')
      const root = menus.getMenu(['menubar']) || menus.getMenu([])
      const seen = new Set()
      const walk = node => {
        if (!node || seen.has(node)) return false
        seen.add(node)
        if (node.command === id) return true
        if (node.id === id) return true
        return (node.children || []).some(walk)
      }
      return walk(root)
    }, commandId)
}

/** Polls the export directory instead of a fixed sleep, since the write is async from the command's return. */
async function waitForExportedFile(dir, extension) {
  await expect
    .poll(() => fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith(extension)))
    .toBe(true)
  return fs.readdirSync(dir).filter(f => f.endsWith(extension))
}

const EXPORT_COMMANDS = [
  ['Export Patch', 'hackbench.project.exportPatch'],
  ['Export Patch as IPS', 'hackbench.project.exportPatchAsIps'],
]

for (const [label, commandId] of EXPORT_COMMANDS) {
  test(`the ${label} command is registered and reachable from the File menu`, async ({ page }) => {
    // A command registered but never contributed to a menu is unreachable -
    // a defect this project has shipped before (#379, see new-project.spec.cjs).
    const found = await page.evaluate(
      id =>
        getSvc('CommandRegistry')
          .getAllCommands()
          .some(c => c.id === id),
      commandId,
    )
    expect(found).toBe(true)
    expect(await commandReachableFromFileMenu(commandId)(page)).toBe(true)
  })
}

test('both Export Patch commands are disabled with no project open', async ({ page }) => {
  const enabled = await page.evaluate(
    ids => {
      const reg = getSvc('CommandRegistry')
      return ids.map(id => reg.isEnabled(id))
    },
    EXPORT_COMMANDS.map(([, id]) => id),
  )
  expect(enabled).toEqual([false, false])
})

test('executing the command through CommandRegistry writes a BPS file by default', async ({
  page,
}) => {
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

  const exportDir = path.join(dir, 'export')
  const files = await waitForExportedFile(exportDir, '.bps')
  expect(files.length).toBe(1)
  const magic = fs.readFileSync(path.join(exportDir, files[0])).subarray(0, 4).toString('ascii')
  expect(magic).toBe('BPS1')
})

test('executing the IPS command through CommandRegistry writes a real .ips', async ({ page }) => {
  const dir = path.join(tmp, 'ViaIpsCommand')
  await page.evaluate(
    async ({ romPath, directory }) => {
      const projects = getSvc('Symbol(ProjectService)')
      const project = await projects.createProject({ romPath, name: 'ViaIpsCommand', directory })
      const ctx = getSvc('ProjectContext')
      ctx.current = project
    },
    { romPath: ROM, directory: dir },
  )

  await page.evaluate(async () => {
    const reg = getSvc('CommandRegistry')
    await reg.executeCommand('hackbench.project.exportPatchAsIps')
  })

  const exportDir = path.join(dir, 'export')
  const files = await waitForExportedFile(exportDir, '.ips')
  expect(files.length).toBe(1)
  const magic = fs.readFileSync(path.join(exportDir, files[0])).subarray(0, 5).toString('ascii')
  expect(magic).toBe('PATCH')
})

test('exporting after a palette edit produces a BPS patch that reproduces exactly that change', async ({
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
  expect(fs.existsSync(exportResult.path)).toBe(true)
  expect(exportResult.path).toContain(path.join(dir, 'export'))

  // Committed op file: address+old+new, never a raw cartridge byte.
  const opsDir = path.join(dir, 'ops')
  const opFiles = fs.readdirSync(opsDir).filter(f => f.endsWith('.json'))
  expect(opFiles.length).toBeGreaterThan(0)
  const layer = JSON.parse(fs.readFileSync(path.join(opsDir, opFiles[0]), 'utf8'))
  expect(layer.ops).toContainEqual({ address: '$00B2CE', old: '$391F', new: '$03E0' })

  // The real round trip: base cartridge + exported BPS = the working copy's
  // colour, applied with HackBench's own applyBps.
  const baseBytes = new Uint8Array(fs.readFileSync(ROM))
  const bpsBytes = new Uint8Array(fs.readFileSync(exportResult.path))
  expect(Buffer.from(bpsBytes.subarray(0, 4)).toString('ascii')).toBe('BPS1')

  const applied = applyBps(baseBytes, bpsBytes)
  expect(applied.ok, 'the exported file must apply back to the base ROM').toBe(true)
  const offset = loromToOffset(MARIO_RED_ADDR, baseBytes.length, false)
  const word = applied.bytes[offset] | (applied.bytes[offset + 1] << 8)
  expect(word).toBe(0x03e0)

  // And nothing else in the cartridge moved.
  let diffCount = 0
  for (let i = 0; i < baseBytes.length; i++) if (baseBytes[i] !== applied.bytes[i]) diffCount++
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
  const baseBytes = new Uint8Array(fs.readFileSync(ROM))
  const applied = applyBps(baseBytes, new Uint8Array(fs.readFileSync(exportResult.path)))
  expect(applied.ok && Array.from(applied.bytes)).toEqual(Array.from(baseBytes))
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
