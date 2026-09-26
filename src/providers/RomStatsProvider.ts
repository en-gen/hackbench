/**
 * Custom editor provider for .smwinfo virtual files.
 *
 * Renders a read-only statistics dashboard for the open ROM:
 *   - ROM header metadata
 *   - Level counts and tileset distribution
 *   - LM extension detection
 *
 * Uses inline HTML/CSS (no separate webview bundle) since the page is
 * display-only with no interactive state beyond initial load.
 */

import * as vscode from 'vscode'
import { resolveRom } from '../RomSession'
import { parseLevelHeader } from '../rom/LevelParser'
import { buildLevelCatalog } from '../rom/LevelCatalog'
import { deriveOverworldEntrances } from '../rom/OverworldEntrances'
import { readDescriptor } from './webviewUtils'
import { hex2 } from '../rom/hex'

export class RomStatsProvider implements vscode.CustomReadonlyEditorProvider {
  async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => undefined }
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    panel.webview.options = { enableScripts: false }

    try {
      const descriptor = await readDescriptor<{ romPath: string }>(document.uri)
      const rom = resolveRom(descriptor.romPath)

      const stats = gatherStats(rom)
      panel.webview.html = renderHtml(stats)
    } catch (err) {
      panel.webview.html = errorHtml((err as Error).message)
    }
  }
}

// ── Stats collection ──────────────────────────────────────────────────────────

interface TilesetRow {
  id: number
  count: number
}

interface RomStats {
  name: string
  sizeKb: number
  isVanilla: boolean
  totalLevelsWithData: number
  overworldCount: number
  subareaCount: number
  catalogRealCount: number
  catalogParseableCount: number
  catalogNotes: string[]
  tilesetDist: TilesetRow[]
}

function gatherStats(rom: ReturnType<typeof resolveRom>): RomStats {
  const summary = rom.getSummary()
  const entrances = deriveOverworldEntrances(rom)
  const { overworld, subarea } = rom.classifyLevels(entrances.roots)
  const catalog = buildLevelCatalog(rom)
  const allSlots = rom.enumerateAllLevels(entrances)
  const validSlots = allSlots.filter(s => s.hasData)

  // Count levels per object tileset
  const tilesetCounts = new Map<number, number>()
  for (const slot of validSlots) {
    const raw = rom.getLevelRawData(slot.index)
    if (!raw) continue
    const header = parseLevelHeader(raw)
    const ts = header.objectTileset
    tilesetCounts.set(ts, (tilesetCounts.get(ts) ?? 0) + 1)
  }
  const tilesetDist: TilesetRow[] = Array.from(tilesetCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, count }))

  return {
    name: summary.internalName.trim(),
    sizeKb: summary.romSizeKb,
    isVanilla: summary.isVanilla,
    totalLevelsWithData: validSlots.length,
    overworldCount: overworld.length,
    subareaCount: subarea.length,
    catalogRealCount: catalog.realCount,
    catalogParseableCount: catalog.parseableCount,
    catalogNotes: catalog.notes,
    tilesetDist,
  }
}

// ── HTML rendering ────────────────────────────────────────────────────────────

function renderHtml(stats: RomStats): string {
  const mod = stats.isVanilla ? 'Unmodified (vanilla)' : 'Modified'

  const tilesetRows = stats.tilesetDist
    .map(row => `<tr><td>Tileset ${hex2(row.id)} (${row.id})</td><td>${row.count}</td></tr>`)
    .join('\n')

  const catalogNotesHtml = stats.catalogNotes.length
    ? `<h2>Catalog Notes</h2><ul>${stats.catalogNotes.map(n => `<li>${esc(n)}</li>`).join('\n')}</ul>`
    : ''

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ROM Statistics</title>
  <style>
    :root { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
    body { padding: 16px 24px; max-width: 640px; }
    h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 20px; }
    h2 { font-size: 1.05em; font-weight: 600; margin: 24px 0 8px; color: var(--vscode-textLink-foreground); }
    table { border-collapse: collapse; width: 100%; }
    td, th { padding: 4px 8px; text-align: left; border-bottom: 1px solid var(--vscode-editorGroup-border); }
    th { font-weight: 600; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
    .badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 0.85em; }
    .badge.vanilla { background: #c8a96e; color: #1a1008; }
    .badge.warn { background: var(--vscode-problemsWarningIcon-foreground); color: #fff; }
  </style>
</head>
<body>
  <h1>${esc(stats.name)}</h1>

  <h2>ROM</h2>
  <table>
    <tr><td>Size</td><td>${stats.sizeKb} KB</td></tr>
    <tr><td>Status</td><td><span class="badge ${stats.isVanilla ? 'vanilla' : 'warn'}">${esc(mod)}</span></td></tr>
  </table>

  <h2>Levels</h2>
  <table>
    <tr><td>Total with data</td><td>${stats.totalLevelsWithData}</td></tr>
    <tr><td>Overworld-linked</td><td>${stats.overworldCount}</td></tr>
    <tr><td>Sub-areas</td><td>${stats.subareaCount}</td></tr>
    <tr><td>Catalog: real slots</td><td>${stats.catalogRealCount}</td></tr>
    <tr><td>Catalog: parseable</td><td>${stats.catalogParseableCount}</td></tr>
  </table>

  ${catalogNotesHtml}

  <h2>Object Tileset Distribution</h2>
  <table>
    <tr><th>Tileset</th><th>Levels</th></tr>
    ${tilesetRows}
  </table>

</body>
</html>`
}

function errorHtml(message: string): string {
  return `<!DOCTYPE html><html><body><p style="color:red">${esc(message)}</p></body></html>`
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
