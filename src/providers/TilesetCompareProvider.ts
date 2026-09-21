/**
 * Custom editor provider for .smwtilecomp virtual files.
 *
 * Loads two tileset Map16 tables and sends the per-tile diff to the webview.
 * The webview renders a 16×16 grid for each tileset (page 0 = tiles $000-$0FF)
 * with tiles that differ highlighted in yellow.
 *
 * Each tile entry includes rendered RGBA pixel data for all animation frames:
 * static tiles get 1 frame, animated tiles get 4 frames (matching the SNES
 * ~7.5 fps animation cycle driven by GFX33).
 *
 * Message protocol:
 *   Extension → Webview:
 *     { type:'load', tilesetA, tilesetB, tiles: TileCompEntry[] }
 *     { type:'tilePreview', tileId, side, nativePalette, renders: {row, rgba}[] }
 *     { type:'error', message }
 *   Webview → Extension:
 *     { type:'ready' }
 *     { type:'compare', tilesetA, tilesetB }
 *     { type:'tilePreview', tileId, side }
 */

import * as vscode from 'vscode'
import { resolveRom } from '../RomSession'
import {
  getNonce,
  getWebviewUri,
  readDescriptor,
  postWebviewError,
  buildWebviewHtml,
} from './webviewUtils'
import { loadAllMap16, TILESET_COUNT, type Map16Tile } from '../rom/Map16'
import { loadVram, VRAM_CHAR_BASE, VRAM_SLOT_NAMES, type VramState } from '../rom/GfxLoader'
import { loadRomPalettes, buildLevelCgram } from '../rom/PaletteLoader'
import { renderMap16Tile } from '../rom/TileRenderer'
import { loadAnimationData, getAnimatedChars, type AnimFrameSlot } from '../rom/AnimationLoader'

function tilesEqual(
  a: ReturnType<typeof loadAllMap16>[0],
  b: ReturnType<typeof loadAllMap16>[0],
): boolean {
  const sameSub = (sa: typeof a.tl, sb: typeof b.tl) =>
    sa.charNum === sb.charNum &&
    sa.palette === sb.palette &&
    sa.flipX === sb.flipX &&
    sa.flipY === sb.flipY &&
    sa.priority === sb.priority
  return sameSub(a.tl, b.tl) && sameSub(a.tr, b.tr) && sameSub(a.bl, b.bl) && sameSub(a.br, b.br)
}

/**
 * Shallow-copy a VramState and replace specific char pixel arrays with
 * animation frame data. The base VramState is not mutated.
 */
function patchVramForFrame(base: VramState, frameSlots: AnimFrameSlot[]): VramState {
  const patched: VramState = { ...base }
  for (const { charBase, tiles } of frameSlots) {
    for (let i = 0; i < tiles.length; i++) {
      const charNum = charBase + i
      for (const slotName of VRAM_SLOT_NAMES) {
        const slotBase = VRAM_CHAR_BASE[slotName]
        const sheet = patched[slotName]
        if (!sheet) continue
        if (charNum >= slotBase && charNum < slotBase + sheet.length) {
          if (sheet === base[slotName]) patched[slotName] = sheet.slice()
          patched[slotName]![charNum - slotBase] = tiles[i]!
          break
        }
      }
    }
  }
  return patched
}

/** True if any subtile of this tile references an animated VRAM char. */
function tileIsAnimated(tile: Map16Tile, animChars: Set<number>): boolean {
  return [tile.tl, tile.tr, tile.bl, tile.br].some(st => animChars.has(st.charNum))
}

export class TilesetCompareProvider implements vscode.CustomReadonlyEditorProvider {
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

    let romPath = ''
    let currentTilesetA = 0
    let currentTilesetB = 1
    let cachedTilesA: Map16Tile[] = []
    let cachedTilesB: Map16Tile[] = []

    panel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'ready') {
        try {
          const descriptor = await readDescriptor<{ romPath: string }>(document.uri)
          romPath = descriptor.romPath
          const a = Math.max(0, Math.min(TILESET_COUNT - 1, Number(msg.tilesetA) || 0))
          const b = Math.max(0, Math.min(TILESET_COUNT - 1, Number(msg.tilesetB) || 0))
          currentTilesetA = a
          currentTilesetB = b
          const result = await this._sendComparison(panel.webview, romPath, a, b)
          cachedTilesA = result.tilesA
          cachedTilesB = result.tilesB
        } catch (err) {
          postWebviewError(panel.webview, err)
        }
      }
      if (msg.type === 'compare' && romPath) {
        const a = Math.max(0, Math.min(TILESET_COUNT - 1, Number(msg.tilesetA) || 0))
        const b = Math.max(0, Math.min(TILESET_COUNT - 1, Number(msg.tilesetB) || 0))
        currentTilesetA = a
        currentTilesetB = b
        const result = await this._sendComparison(panel.webview, romPath, a, b)
        cachedTilesA = result.tilesA
        cachedTilesB = result.tilesB
      }
      if (msg.type === 'tilePreview' && romPath) {
        const side = msg.side as 'a' | 'b'
        const tileId = Math.max(0, Math.min(255, Number(msg.tileId) || 0))
        const tilesetId = side === 'a' ? currentTilesetA : currentTilesetB
        const tiles = side === 'a' ? cachedTilesA : cachedTilesB
        await this._sendTilePreview(panel.webview, romPath, side, tileId, tilesetId, tiles)
      }
    })
  }

  private async _sendComparison(
    webview: vscode.Webview,
    romPath: string,
    tilesetA: number,
    tilesetB: number,
  ): Promise<{ tilesA: Map16Tile[]; tilesB: Map16Tile[] }> {
    try {
      const rom = resolveRom(romPath)
      const tilesA = loadAllMap16(rom.rom, tilesetA)
      const tilesB = loadAllMap16(rom.rom, tilesetB)
      const palettes = loadRomPalettes(rom.rom)
      const cgram = buildLevelCgram(palettes, 0, 0, 0)

      const baseVramA = loadVram(rom.rom, tilesetA)
      const baseVramB = loadVram(rom.rom, tilesetB)

      const animA = loadAnimationData(rom.rom, tilesetA)
      const animB = loadAnimationData(rom.rom, tilesetB)

      const animCharsA = animA ? getAnimatedChars(animA) : new Set<number>()
      const animCharsB = animB ? getAnimatedChars(animB) : new Set<number>()

      // Build a patched VramState for each of the 4 animation frames.
      const FRAME_COUNT = 4
      const vramFramesA = Array.from({ length: FRAME_COUNT }, (_, f) =>
        animA ? patchVramForFrame(baseVramA, animA.frames[f] ?? []) : baseVramA,
      )
      const vramFramesB = Array.from({ length: FRAME_COUNT }, (_, f) =>
        animB ? patchVramForFrame(baseVramB, animB.frames[f] ?? []) : baseVramB,
      )

      const PAGE0 = 256
      const tiles = Array.from({ length: PAGE0 }, (_, i) => {
        const ta = tilesA[i]
        const tb = tilesB[i]
        const toSub = (st: typeof ta.tl) => ({
          charNum: st.charNum,
          palette: st.palette,
          flipX: st.flipX,
          flipY: st.flipY,
          priority: st.priority,
        })

        const animA_ = tileIsAnimated(ta, animCharsA)
        const animB_ = tileIsAnimated(tb, animCharsB)

        // Animated tiles: 4 base64-encoded RGBA frames. Static: 1 frame.
        const rgbaA = (animA_ ? vramFramesA : [vramFramesA[0]!]).map(vram =>
          Buffer.from(renderMap16Tile(ta, vram, cgram)).toString('base64'),
        )
        const rgbaB = (animB_ ? vramFramesB : [vramFramesB[0]!]).map(vram =>
          Buffer.from(renderMap16Tile(tb, vram, cgram)).toString('base64'),
        )

        return {
          id: i,
          equal: tilesEqual(ta, tb),
          a: {
            tl: toSub(ta.tl),
            tr: toSub(ta.tr),
            bl: toSub(ta.bl),
            br: toSub(ta.br),
            rgbaFrames: rgbaA,
          },
          b: {
            tl: toSub(tb.tl),
            tr: toSub(tb.tr),
            bl: toSub(tb.bl),
            br: toSub(tb.br),
            rgbaFrames: rgbaB,
          },
        }
      })

      webview.postMessage({ type: 'load', tilesetA, tilesetB, tiles })
      return { tilesA, tilesB }
    } catch (err) {
      postWebviewError(webview, err)
      return { tilesA: [], tilesB: [] }
    }
  }

  private async _sendTilePreview(
    webview: vscode.Webview,
    romPath: string,
    side: 'a' | 'b',
    tileId: number,
    tilesetId: number,
    tiles: Map16Tile[],
  ): Promise<void> {
    try {
      const tile = tiles[tileId]
      if (!tile) return

      const rom = resolveRom(romPath)
      // Apply animation frame 0 so animated chars render correctly.
      const baseVram = loadVram(rom.rom, tilesetId)
      const animData = loadAnimationData(rom.rom, tilesetId)
      const vram = animData ? patchVramForFrame(baseVram, animData.frames[0] ?? []) : baseVram
      const palettes = loadRomPalettes(rom.rom)
      const cgram = buildLevelCgram(palettes, 0, 0, 0)

      const renders: { row: number; rgba: number[] }[] = []
      for (let row = 0; row < 8; row++) {
        const paletteTile: Map16Tile = {
          ...tile,
          tl: { ...tile.tl, palette: row },
          tr: { ...tile.tr, palette: row },
          bl: { ...tile.bl, palette: row },
          br: { ...tile.br, palette: row },
        }
        renders.push({ row, rgba: Array.from(renderMap16Tile(paletteTile, vram, cgram)) })
      }

      webview.postMessage({
        type: 'tilePreview',
        tileId,
        side,
        nativePalette: tile.tl.palette,
        renders,
      })
    } catch {
      // Silently ignore preview errors
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    return buildWebviewHtml({
      title: 'Tileset Compare',
      nonce: getNonce(),
      scriptUri: getWebviewUri(webview, this.context.extensionUri, 'tilesetCompare.js'),
      cspSource: webview.cspSource,
      styles:
        'html,body{margin:0;padding:0;background:var(--vscode-editor-background,#1e1e1e);overflow-y:auto;}#app{padding:12px 16px;}',
    })
  }
}
