/**
 * Custom editor provider for .smwrommap virtual files.
 *
 * Renders a 16x16 visualization of the 512 KB LoROM address space, with
 * each cell representing 2 KB. Clicking a cell opens a detail panel showing
 * the 16-byte sub-grid and region schema. When the cell holds level data
 * (banks $06-$07), the sub-grid is painted with real block boundaries
 * walked from the L1 / L2 / sprite pointer tables.
 *
 * Message protocol:
 *   Extension → Webview:
 *     { type: 'load', romSize, hasHeader, blocks: [...] }
 *     { type: 'error', message }
 *   Webview → Extension:
 *     { type: 'ready' }
 *
 * Block format:
 *   { kind: 'L1' | 'L2' | 'Sprite',
 *     snes: number,       // 24-bit SNES address of the block start
 *     fileStart: number,  // file offset (header-stripped) of block start
 *     fileEnd: number,    // file offset (exclusive) of byte after $FF terminator
 *     size: number,       // fileEnd - fileStart
 *     indices: number[]   // level slot indices that share this pointer
 *   }
 */

import * as vscode from 'vscode'
import { resolveRom } from '../RomSession'
import { LEVEL_COUNT } from '../rom/SmwRom'
import {
  getNonce,
  getWebviewUri,
  readDescriptor,
  postWebviewError,
  buildWebviewHtml,
} from './webviewUtils'
import { COPIER_HEADER_SIZE, loromToOffset } from '../rom/addressing'
import { RomFile } from '../rom/RomFile'
import { getObjectStreamLength, getSpriteStreamLength } from '../rom/LevelParser'

interface Block {
  kind: 'L1' | 'L2' | 'Sprite'
  snes: number
  fileStart: number
  fileEnd: number
  size: number
  indices: number[]
}

const MAX_BLOCK_SCAN = 0x10000 // 64 KB cap per block walk; real levels are far smaller

export class RomMapProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => undefined }
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
    }
    panel.webview.html = this._buildHtml(panel.webview)

    panel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'ready') {
        await this._sendData(document.uri, panel.webview)
      }
    })
  }

  private async _sendData(uri: vscode.Uri, webview: vscode.Webview): Promise<void> {
    try {
      const descriptor = await readDescriptor<{ romPath: string }>(uri)
      const smwRom = resolveRom(descriptor.romPath)

      const blocks = computeBlocks(smwRom.rom, smwRom)
      webview.postMessage({
        type: 'load',
        romSize: smwRom.rom.romSize,
        hasHeader: smwRom.rom.hasHeader,
        blocks,
      })
    } catch (err) {
      postWebviewError(webview, err)
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    return buildWebviewHtml({
      title: 'SMW ROM Map',
      nonce: getNonce(),
      scriptUri: getWebviewUri(webview, this.context.extensionUri, 'romMap.js'),
      cspSource: webview.cspSource,
      styles: 'html,body{height:100%;margin:0;padding:0;overflow:auto;}#app{min-height:100%;}',
    })
  }
}

// ── Block computation ─────────────────────────────────────────────────────────

/**
 * Walk every L1, L2, and sprite pointer in the ROM and return a deduplicated
 * list of level blocks with their exact file ranges. Level slots that share a
 * pointer (common in vanilla) are grouped under a single block with multiple
 * `indices`.
 *
 * Parsing mirrors src/rom/LevelParser.ts exactly (`getObjectStreamLength`,
 * `getSpriteStreamLength`), which is in turn derived from bank_05.asm
 * LoadLevelData (lines 677-808) and bank_02.asm LoadSprFromLevel.
 */
function computeBlocks(
  rom: RomFile,
  smwRom: {
    getLevelL1Pointer: (i: number) => number | null
    getLevelL2Pointer: (i: number) => number | null
    getLevelSpritePointer: (i: number) => number | null
  },
): Block[] {
  const headerBytes = rom.hasHeader ? COPIER_HEADER_SIZE : 0
  const romEnd = rom.buffer.length - headerBytes

  const sliceAt = (fileOffset: number): Buffer | null => {
    if (fileOffset < 0 || fileOffset >= romEnd) return null
    const start = headerBytes + fileOffset
    const end = Math.min(headerBytes + fileOffset + MAX_BLOCK_SCAN, headerBytes + romEnd)
    return rom.buffer.subarray(start, end)
  }

  const byKey = new Map<string, Block>()
  const register = (
    kind: Block['kind'],
    snes: number,
    fileStart: number,
    fileEnd: number,
    index: number,
  ): void => {
    const key = `${kind}:${fileStart}`
    const existing = byKey.get(key)
    if (existing) {
      existing.indices.push(index)
      return
    }
    byKey.set(key, { kind, snes, fileStart, fileEnd, size: fileEnd - fileStart, indices: [index] })
  }

  for (let i = 0; i < LEVEL_COUNT; i++) {
    // L1: 3-byte pointer, 5-byte header + object stream + $FF
    const p1 = smwRom.getLevelL1Pointer(i)
    if (p1 !== null && p1 >>> 16 !== 0xff) {
      const fs = loromToOffset(p1, rom.romSize, false)
      if (fs !== null && fs < rom.romSize) {
        const data = sliceAt(fs)
        if (data) register('L1', p1, fs, fs + getObjectStreamLength(data, true), i)
      }
    }

    // L2: 3-byte pointer, no header; bank $FF = preset BG (skip).
    const p2 = smwRom.getLevelL2Pointer(i)
    if (p2 !== null && p2 >>> 16 !== 0xff) {
      const fs = loromToOffset(p2, rom.romSize, false)
      if (fs !== null && fs < rom.romSize) {
        const data = sliceAt(fs)
        if (data) register('L2', p2, fs, fs + getObjectStreamLength(data, false), i)
      }
    }

    // Sprite: 2-byte pointer (bank $07 implicit), 1-byte header + 3-byte sprites + $FF.
    const ps = smwRom.getLevelSpritePointer(i)
    if (ps !== null) {
      const fs = loromToOffset(ps, rom.romSize, false)
      if (fs !== null && fs < rom.romSize) {
        const data = sliceAt(fs)
        if (data) register('Sprite', ps, fs, fs + getSpriteStreamLength(data), i)
      }
    }
  }

  return [...byKey.values()].sort((a, b) => a.fileStart - b.fileStart)
}
