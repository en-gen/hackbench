import { describe, it, expect } from 'vitest'
import { Uri } from 'vscode'
import { romPathFromCommandArg } from '../../../src/romPathFromCommandArg'

/**
 * `hackbench.openRom` is reachable three ways, and only one of them supplies
 * a file: the Explorer context menu, which VS Code invokes with the URI of the
 * resource that was right-clicked. The command palette and the welcome-view
 * link both invoke it bare.
 *
 * This is the whole decision: given whatever the command handler was handed,
 * do we already know which ROM to open, or do we have to ask?
 */
describe('romPathFromCommandArg', () => {
  it('takes the path from a file URI, so the context menu opens what was clicked', () => {
    const uri = Uri.file('C:/roms/Super Mario World.sfc')
    expect(romPathFromCommandArg(uri)).toBe(uri.fsPath)
  })

  it('returns undefined when invoked bare, so the palette still gets a dialog', () => {
    expect(romPathFromCommandArg(undefined)).toBeUndefined()
  })

  // A non-file URI has no meaningful fsPath. smwrom:// is the realistic case:
  // it is our own scheme, and a menu contribution pointed at the wrong view
  // would hand us one.
  it('refuses a non-file scheme rather than inventing a path from it', () => {
    expect(romPathFromCommandArg(Uri.parse('smwrom://vanilla/maps/000.smwmap'))).toBeUndefined()
  })

  it('refuses a bare string, since VS Code passes URIs and not paths', () => {
    expect(romPathFromCommandArg('C:/roms/Super Mario World.sfc')).toBeUndefined()
  })

  it('refuses an object that merely looks URI-shaped', () => {
    expect(romPathFromCommandArg({ scheme: 'file', fsPath: 'C:/roms/x.sfc' })).toBeUndefined()
  })
})
