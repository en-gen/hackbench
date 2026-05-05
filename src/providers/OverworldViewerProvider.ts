/**
 * Custom editor provider for `.smwoverworld` virtual files.
 *
 * Each `.smwoverworld` descriptor names ONE area (`areaIndex`) by index;
 * the viewer renders just that area's region of the shared overworld
 * staging buffer. Per `bank_04/MEMO.md`, the L2 staging buffer at
 * `$7F4000` holds two 64x64 BG layouts in standard SNES 4-screen quadrant
 * memory order; this viewer addresses it via `tilemapByteOffset`.
 *
 * Message protocol:
 *   Extension -> Webview:
 *     { type:'load', area, l2Tilemap, l1Map16Indices, l1CharData,
 *       vramTiles, paletteRows, animation, events, warpStarts,
 *       l2Layouts, l2LayoutBytes, l2ScreenBytes }
 *     { type:'error', message }
 *   Webview -> Extension:
 *     { type:'ready' }
 */

import * as vscode from 'vscode'
import { resolveRom } from '../RomSession'
import {
  loadOverworld,
  loadOverworldAreas,
  loadAreaPalette,
  loadAreaWarpStarts,
  areaBufferRegion,
  readOwBaselineLevelIndex,
  OW_BG_LAYOUT_BYTES,
  OW_BG_SCREEN_BYTES,
  l3MaskForArea,
  OwArea,
  OwPosition,
} from '../rom/OverworldLoader'
import { loadOverworldAnimation } from '../rom/OverworldAnimation'
import { loadOverworldEvents } from '../rom/OverworldEvents'
import { parseLevelHeader } from '../rom/LevelParser'
import {
  loadPaletteAnimData,
  serializePaletteAnimData,
} from '../rom/PaletteAnimationLoader'
import {
  loadVram,
  VRAM_SLOT_NAMES,
  VRAM_CHAR_BASE,
  VramSlotName,
} from '../rom/GfxLoader'
import { loadRomPalettes, buildLevelCgram, RgbaRow } from '../rom/PaletteLoader'

/** Pack the loaded VRAM into one flat tile array indexed by SNES char number. */
function buildVramTileArray(vram: Partial<Record<VramSlotName, Uint8Array[]>>): number[][] {
  const TOTAL_CHARS = 0x600
  const out: number[][] = Array.from({ length: TOTAL_CHARS }, () => [])
  for (const slot of VRAM_SLOT_NAMES) {
    const sheet = vram[slot]
    if (!sheet) continue
    const base = VRAM_CHAR_BASE[slot]
    for (let i = 0; i < sheet.length && base + i < TOTAL_CHARS; i++) {
      out[base + i] = Array.from(sheet[i])
    }
  }
  return out
}

export class OverworldViewerProvider implements vscode.CustomReadonlyEditorProvider {
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
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
      ],
    }
    panel.webview.html = this._buildHtml(panel.webview)

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        await this._send(document.uri, panel.webview)
      }
    })
  }

  private async _send(uri: vscode.Uri, webview: vscode.Webview): Promise<void> {
    try {
      const raw = await vscode.workspace.fs.readFile(uri)
      const descriptor = JSON.parse(Buffer.from(raw).toString('utf8')) as {
        romPath: string
        areaIndex: number
      }

      const session = resolveRom(descriptor.romPath)
      const rom = session.rom
      const overworld = loadOverworld(rom)
      const areas = loadOverworldAreas(rom)
      const area: OwArea | undefined = areas[descriptor.areaIndex]
      if (!area) {
        webview.postMessage({
          type: 'error',
          message: `Invalid area index ${descriptor.areaIndex}`,
        })
        return
      }

      // GFX assignment per CODE_04DC09 (bank_04.asm:5637): ObjectTileset from
      // DATA_04DC02, SpriteTileset hardcoded to $11. Reuse the shared
      // `loadVram` from GfxLoader so the FilterSomeRAM upload variant
      // (bank_00.asm:5480) is applied consistently with the level path
      // — without it, OW AN1 chars (file $1E) miss plane 3 and fall
      // back to palette indices 0..7 instead of 0/9..15.
      const SPRITE_TILESET = 0x11
      const vram = loadVram(rom, area.objectTileset, SPRITE_TILESET)

      // Build CGRAM in two passes to mirror real-hardware OW behavior:
      //
      //   Pass 1 — title-screen level baseline. `CODE_00AD25`
      //   (`bank_00.asm:5736`) only writes four small CGRAM rectangles
      //   (HUD, OWStdColors, area-specific, OWStdColors2). It does NOT
      //   clear CGRAM first, and the OW init path
      //   (`GM0CLoadOverworld`, `bank_00.asm:4250`) does NOT call
      //   `LoadPalette` before it. So at runtime the cells outside the
      //   four blocks carry whatever the previous game state left there.
      //   For the boot→title→OW path that's the title-screen level's
      //   `LoadPalette` result (driven by `GM12PrepLevel`'s
      //   `JSR LoadPalette` at `bank_00.asm:4868`, using the
      //   FG/BG/sprite palette indices loaded from the title-screen
      //   level's header). Reading those header bytes from the title
      //   level (whose number we read from the `LDA #imm` operand at
      //   `$0096CC`) keeps the baseline ROM-derived: hacks that
      //   change either the title level or its palette indices flow
      //   through automatically.
      //
      //   Pass 2 — OW overlays. `loadAreaPalette` already reads the four
      //   OW blocks per CODE_00AD25; we copy ONLY the cells that load
      //   actually writes onto the title-baseline.
      //
      //     HUD            → rows 0-1 cols 8-15
      //     OWStdColors    → rows 2-7 cols 9-15
      //     area-specific  → rows 4-7 cols 1-7
      //     OWStdColors2   → rows 8-15 cols 1-7
      const romPalettes = loadRomPalettes(rom)
      const baselineLevel = readOwBaselineLevelIndex(rom)
      const baselineHeader = (() => {
        const data = session.getLevelRawData(baselineLevel)
        return data ? parseLevelHeader(data) : null
      })()
      const baseCgram = buildLevelCgram(
        romPalettes,
        baselineHeader?.bgPalette     ?? 0,
        baselineHeader?.fgPalette     ?? 0,
        baselineHeader?.spritePalette ?? 0,
      ).rows
      const owCgram = loadAreaPalette(rom, area, false)

      // HUD: rows 0-1 cols 8-15
      for (let r = 0; r <= 1; r++) {
        for (let c = 8; c <= 15; c++) baseCgram[r][c] = owCgram[r][c]
      }
      // OWStdColors: rows 2-7 cols 9-15
      for (let r = 2; r <= 7; r++) {
        for (let c = 9; c <= 15; c++) baseCgram[r][c] = owCgram[r][c]
      }
      // Area-specific: rows 4-7 cols 1-7
      for (let r = 4; r <= 7; r++) {
        for (let c = 1; c <= 7; c++) baseCgram[r][c] = owCgram[r][c]
      }
      // OWStdColors2: rows 8-15 cols 1-7
      for (let r = 8; r <= 15; r++) {
        for (let c = 1; c <= 7; c++) baseCgram[r][c] = owCgram[r][c]
      }
      const paletteRows = baseCgram.map((row: RgbaRow) =>
        row.map(c => Array.from(c)),
      )

      const animation = loadOverworldAnimation(rom)
      const events    = loadOverworldEvents(rom)
      const warpStarts = loadAreaWarpStarts(rom, descriptor.areaIndex)

      // Palette animation — same loader the level path uses, with
      // 'overworld' mode selecting the OW NMI's CGRAM $6D + $7D cycle
      // (`bank_00.asm:80/A4E3-A51E`). Returns null only on bad ROM data;
      // the webview gates its timer on the presence of a non-null
      // `paletteAnimation` field.
      const palAnim = loadPaletteAnimData(rom, 'overworld')
      const paletteAnimation = palAnim ? serializePaletteAnimData(palAnim) : null

      webview.postMessage({
        type: 'load',
        area,
        region: areaBufferRegion(area),
        // Whole staging buffer goes over so the webview can address any
        // layout/quadrant — the area's own region is just one slice.
        l2Tilemap:      Array.from(overworld.l2Tilemap),
        l1Map16Indices: Array.from(overworld.l1Map16Indices),
        l1CharData:     Array.from(overworld.l1CharData),
        vramTiles:      buildVramTileArray(vram),
        paletteRows,
        animation,
        paletteAnimation,
        events,
        warpStarts,
        l2LayoutBytes: OW_BG_LAYOUT_BYTES,
        l2ScreenBytes: OW_BG_SCREEN_BYTES,
        // L3 row-mask hides the vertical overlap each sub-area shares
        // with its neighbors. Top-row sub-areas (cam Y = -40) author
        // 22 rows so mask top=4; the others author 21 rows so mask
        // top=5. All sub-areas mask bottom=2. Main map has no mask.
        l3Mask: l3MaskForArea(area),
        // Ship the warp positions as plain objects already; OwPosition is small.
        marioStart: area.marioStart as OwPosition | null,
        luigiStart: area.luigiStart as OwPosition | null,
      })
    } catch (err) {
      webview.postMessage({ type: 'error', message: (err as Error).message })
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri, 'dist', 'webview', 'overworldViewer.js',
      ),
    )
    const codiconCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'codicon.css'),
    )
    const nonce = getNonce()
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             font-src ${webview.cspSource};
             style-src ${webview.cspSource} 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SMW Overworld Viewer</title>
  <link rel="stylesheet" href="${codiconCssUri}" />
  <style>
    html, body { height:100%; margin:0; padding:0; overflow:hidden; }
    #app { height:100%; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from(
    { length: 32 },
    () => chars[Math.floor(Math.random() * chars.length)],
  ).join('')
}
