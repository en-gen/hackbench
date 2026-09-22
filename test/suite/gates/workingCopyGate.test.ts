/**
 * Every view must read the project's WORKING COPY, not the base cartridge.
 * docs/glossary.md, "Working copy", is the rule this enforces: a `*-server.ts`
 * that calls `RomFile.load` directly bypasses every edit layer silently -
 * the view just renders the unedited cart and looks correct.
 *
 * `project-server.ts` is the sole exception: it is what RESOLVES the
 * cartridge in the first place (via WorkingRomRegistry, which itself calls
 * `RomFile.load` exactly once per project, on first access).
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const nodeDir = path.resolve(__dirname, '../../../theia/extension/src/node')
const EXEMPT = new Set(['project-server.ts'])

describe('working copy gate', () => {
  it('no backend server reads the base cartridge directly, except project-server.ts', () => {
    const files = fs.readdirSync(nodeDir).filter(f => f.endsWith('-server.ts'))
    // Tripwire: if the naming convention changes and this glob stops
    // matching anything, the gate would pass by finding nothing to check.
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of files) {
      if (EXEMPT.has(file)) continue
      const text = fs.readFileSync(path.join(nodeDir, file), 'utf8')
      if (text.includes('RomFile.load(')) offenders.push(file)
    }
    expect(offenders, `these bypass the working copy: ${offenders.join(', ')}`).toEqual([])
  })

  it('the exempt file is actually exempt because it still resolves a real cartridge', () => {
    // Guards the gate itself against someone widening EXEMPT to hide a
    // regression: project-server.ts must still be doing real ROM resolution
    // work, not merely be named as an escape hatch.
    const text = fs.readFileSync(path.join(nodeDir, 'project-server.ts'), 'utf8')
    expect(text).toContain('RomFile.load(')
  })
})
