import { describe, it, expect } from 'vitest'
import * as vscode from 'vscode'
import { staleRomTabs } from '../../../src/romTabs'

/**
 * VS Code restores editor tabs across restarts, including tabs on virtual
 * files. Ours are backed by a ROM that is no longer loaded, so a restored
 * `smwrom://` tab points at nothing: the filesystem provider is not mounted
 * and the editor cannot resolve its descriptor. `activate` closes them, and
 * this is the selection it closes.
 */
const tab = (input: unknown): vscode.Tab => ({ input } as vscode.Tab)
const group = (...tabs: vscode.Tab[]): vscode.TabGroup => ({ tabs } as vscode.TabGroup)

const smwmap = (n: string) => vscode.Uri.parse(`smwrom://vanilla/maps/${n}.smwmap`)

describe('staleRomTabs', () => {
  it('selects a custom-editor tab on a smwrom URI', () => {
    const stale = tab(new vscode.TabInputCustom(smwmap('000'), 'hackbench.mapEditor'))
    expect(staleRomTabs([group(stale)])).toEqual([stale])
  })

  // The descriptors are JSON, so "Open With... Text Editor" produces a text
  // tab on the same dead URI. It restores just as broken.
  it('selects a text tab on a smwrom URI', () => {
    const stale = tab(new vscode.TabInputText(smwmap('105')))
    expect(staleRomTabs([group(stale)])).toEqual([stale])
  })

  it('leaves tabs on real files alone', () => {
    const keep = tab(new vscode.TabInputText(vscode.Uri.file('C:/roms/notes.md')))
    expect(staleRomTabs([group(keep)])).toEqual([])
  })

  // Terminals, diffs and webview panels have inputs with no `uri` at all.
  // Reading one blindly would throw during activation, which is the worst
  // possible time.
  it('ignores inputs that carry no uri, without throwing', () => {
    expect(staleRomTabs([group(tab({ kind: 'terminal' }), tab(undefined), tab(null))])).toEqual([])
  })

  it('collects across every tab group', () => {
    const a = tab(new vscode.TabInputCustom(smwmap('000'), 'hackbench.mapEditor'))
    const keep = tab(new vscode.TabInputText(vscode.Uri.file('C:/x.md')))
    const b = tab(new vscode.TabInputCustom(smwmap('001'), 'hackbench.mapEditor'))
    expect(staleRomTabs([group(a, keep), group(b)])).toEqual([a, b])
  })

  it('returns nothing when there are no tabs', () => {
    expect(staleRomTabs([])).toEqual([])
    expect(staleRomTabs([group()])).toEqual([])
  })
})
