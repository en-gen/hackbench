/**
 * Every view must read the project's WORKING COPY, not the base cartridge.
 * docs/glossary.md, "Working copy", is the rule this enforces: a `*-server.ts`
 * that reaches the base cartridge directly bypasses every edit layer
 * silently - the view just renders the unedited cart and looks correct.
 *
 * TWO bans, because checking one spelling was not enough. This gate
 * originally looked for `RomFile.load(` alone, and passed while
 * `emulator-server.ts` did `RomRegistry.resolve()` and then `fs.readFileSync`
 * on the result: the emulator booted the UNEDITED cart, so a palette edit
 * you had just made was invisible the moment you ran the game. Resolving a
 * base cartridge path is the precursor to reading it, so `RomRegistry` is
 * banned in a server too. A server with no way to resolve that path cannot
 * read it by any spelling.
 *
 * There is no exception. `project-server.ts` was one until #421 step 3: its
 * map tree and map details read the base cartridge, so a map view would
 * not have shown an edit. It now goes through WorkingRomRegistry like every
 * other server, and registering a ROM's location is WorkingRomRegistry's
 * `register`. WorkingRomRegistry itself (src/project/) is the one place
 * that loads the base bytes, once per project.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const nodeDir = path.resolve(__dirname, '../../../theia/extension/src/node')

/**
 * Matches an import OF `RomRegistry` without matching `WorkingRomRegistry`,
 * which contains it as a substring and is the legitimate neighbour.
 */
const BASE_ROM_REGISTRY_IMPORT = /from '[^']*\/RomRegistry'/

describe('working copy gate', () => {
  it('no backend server reads the base cartridge directly', () => {
    const files = fs.readdirSync(nodeDir).filter(f => f.endsWith('-server.ts'))
    // Tripwire: if the naming convention changes and this glob stops
    // matching anything, the gate would pass by finding nothing to check.
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of files) {
      const text = fs.readFileSync(path.join(nodeDir, file), 'utf8')
      if (text.includes('RomFile.load(')) offenders.push(`${file} (RomFile.load)`)
      if (BASE_ROM_REGISTRY_IMPORT.test(text)) offenders.push(`${file} (RomRegistry)`)
    }
    expect(offenders, `these bypass the working copy: ${offenders.join(', ')}`).toEqual([])
  })

  it('catches a server that resolves a cartridge path, not only one that loads it', () => {
    // The planted defect is the shape emulator-server.ts actually had:
    // resolve through RomRegistry, then read the file. `RomFile.load` never
    // appears anywhere in it, so the original single-spelling gate saw
    // nothing and passed.
    const planted = [
      "import { RomRegistry } from '../../../../src/project/RomRegistry'",
      'const roms = new RomRegistry()',
      'return new Uint8Array(fs.readFileSync(roms.resolve(sha)))',
    ].join('\n')
    expect(planted.includes('RomFile.load(')).toBe(false) // the old gate's only check
    expect(BASE_ROM_REGISTRY_IMPORT.test(planted)).toBe(true) // the new one catches it

    // And it must not fire on the legitimate neighbour, whose name contains
    // the banned one as a substring.
    const ok = "import { WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'"
    expect(BASE_ROM_REGISTRY_IMPORT.test(ok)).toBe(false)
  })

  it('checks project-server.ts, which used to be exempt', () => {
    // Guards against the exemption creeping back as a filename filter: the
    // project server must be among the files the first case scans.
    const files = fs.readdirSync(nodeDir).filter(f => f.endsWith('-server.ts'))
    expect(files).toContain('project-server.ts')
  })
})
