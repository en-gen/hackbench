import * as vscode from 'vscode'
import { SmwRom, ADDR } from '../rom/SmwRom'
import { parseLevelObjects, parseLevelSprites } from '../rom/LevelParser'
import { loadAllMap16 } from '../rom/Map16'
import { loadRomPalettes, buildLevelCgram } from '../rom/PaletteLoader'
import { loadVram } from '../rom/GfxLoader'
import { buildTileAtlas } from '../rom/TileRenderer'
import { expandLevel } from '../rom/ObjectExpander'
import { decompressRle1 } from '../rom/LcRle1'
import { SCREEN_W, SCREEN_H } from '../rom/LevelParser'

/**
 * Custom editor provider for .smwlevel virtual files.
 *
 * Build pipeline (extension host → webview):
 *   1. Parse level objects + sprites from ROM
 *   2. Load Map16 tile table
 *   3. Load palette (BGR555 → RGBA)
 *   4. Load GFX files into VRAM slots for the level's tileset
 *   5. Expand objects into a 2D Map16 tile grid
 *   6. Render all needed Map16 tiles into a flat RGBA atlas
 *   7. Send tile grid + atlas + UVs to webview
 *
 * Message protocol (extension ↔ webview):
 *   Extension → Webview:
 *     { type:'load', levelIndex, screens, tileGrid, atlasData,
 *       atlasWidth, atlasHeight, tileUvMap, sprites, header }
 *     { type:'error', message }
 *   Webview → Extension:
 *     { type:'ready' }
 *     { type:'edit', kind:'place'|'erase', tileId, col, row }
 */
export class LevelEditorProvider implements vscode.CustomReadonlyEditorProvider {
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
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')
      ]
    }
    panel.webview.html = this._buildHtml(panel.webview)

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        await this._sendLevelData(document.uri, panel.webview, {})
      } else if (msg.type === 'rerender') {
        await this._sendLevelData(document.uri, panel.webview, {
          bgVariant:      msg.bgVariant      as number,
          fgVariant:      msg.fgVariant      as number,
          spriteSet:      msg.spriteSet      as number,
          spritePalette:  msg.spritePalette  as number,
          tilesetId:      msg.tilesetId      as number,
          _initial:       false,
        })
      } else if (msg.type === 'edit') {
        // Future: apply edit to ROM buffer and mark dirty
      }
    })
  }

  private async _sendLevelData(
    uri: vscode.Uri,
    webview: vscode.Webview,
    overrides: { bgVariant?: number; fgVariant?: number; spriteSet?: number; spritePalette?: number; tilesetId?: number; _initial?: boolean },
  ): Promise<void> {
    try {
      const raw = await vscode.workspace.fs.readFile(uri)
      const descriptor = JSON.parse(Buffer.from(raw).toString('utf8'))

      const rom   = SmwRom.open(descriptor.romPath as string)
      const index = descriptor.levelIndex as number

      // ── Parse level ───────────────────────────────────────────────────────
      const rawL1 = rom.getLevelRawData(index)
      if (!rawL1) {
        webview.postMessage({ type: 'error', message: `Level $${index.toString(16).toUpperCase()} has no data` })
        return
      }

      const { header, objects } = parseLevelObjects(rawL1)
      const screens = header.levelLength + 1

      // ── Debug: log raw header + pointer + first objects ───────────────────
      const l1ptr = rom.rom.readAt(0x05E000 + index * 3, 3)
      const ptrAddr = l1ptr ? (l1ptr[2] << 16) | (l1ptr[1] << 8) | l1ptr[0] : 0
      console.log(`[LVL $${index.toString(16).toUpperCase()}] L1 ptr=$${ptrAddr.toString(16).toUpperCase()}`)
      console.log(`[LVL] raw[0..9]: ${Array.from(rawL1.subarray(0,10)).map(b=>b.toString(16).padStart(2,'0')).join(' ')}`)
      console.log(`[LVL] header: screens=${screens} mode=${header.levelMode} bgPal=${header.bgPalette} spriteSet=${header.spriteSet} music=${header.music}`)
      console.log(`[LVL] objects parsed: ${objects.length}`)
      if (objects.length > 0) {
        const first5 = objects.slice(0, 5).map(o =>
          `{type=${o.objectType.toString(16)} x=${o.x} y=${o.y} param=${o.param} screen=${o.screen}}`
        ).join(', ')
        console.log(`[LVL] first objects: ${first5}`)
      }
      // ─────────────────────────────────────────────────────────────────────

      const sprPtr = rom.getLevelSpritePointer(index)
      let sprites = parseLevelSprites(Buffer.alloc(1, 0xFF))
      if (sprPtr) {
        const sprData = rom.rom.readAt(sprPtr, 0x200)
        if (sprData) sprites = parseLevelSprites(sprData)
      }

      // ── Build L1 tile grid ────────────────────────────────────────────────
      const tileGrid = expandLevel(objects, screens)

      // ── Build L2 tile grid (background tilemap, if present) ───────────────
      let l2TileGrid: number[][] | null = null
      const l2ptr = rom.getLevelL2Pointer(index)
      // Bank byte $FF means data is an LC_RLE1 background tilemap (not an object stream).
      if (l2ptr !== null && ((l2ptr >> 16) & 0xFF) === 0xFF) {
        // lo/hi bytes hold the actual SNES data address; bank=$FF is just the flag.
        const l2Base = ADDR.LEVEL_L2_PTR + index * 3
        const l2lo = rom.rom.readByte(l2Base)
        const l2hi = rom.rom.readByte(l2Base + 1)
        if (l2lo !== null && l2hi !== null) {
          const l2addr = (l2hi << 8) | l2lo
          const l2raw  = rom.rom.readAt(l2addr, 0x2000)
          if (l2raw) {
            const l2data = decompressRle1(l2raw)
            const cols   = screens * SCREEN_W
            const rows   = SCREEN_H
            // Each tile entry is 1 byte (Map16 page-0 tile ID for L2 background).
            l2TileGrid = Array.from({ length: rows }, (_, r) =>
              Array.from({ length: cols }, (_, c) => l2data[r * cols + c] ?? 0)
            )
          }
        }
      }

      // ── Load ROM rendering data (allow webview overrides) ─────────────────
      const romPalettes   = loadRomPalettes(rom.rom)
      const bgVariant     = overrides.bgVariant      ?? header.bgPalette
      const fgVariant     = overrides.fgVariant      ?? 0
      const spriteSet     = overrides.spriteSet      ?? header.spriteSet
      const spritePalette = overrides.spritePalette  ?? header.spritePalette
      const gfxTilesetId  = overrides.tilesetId      ?? rom.getGfxTilesetId(index)

      const cgram = buildLevelCgram(romPalettes, bgVariant, fgVariant, spritePalette)
      const palette = { colors: cgram.colors, rows: cgram.rows }
      const vram    = loadVram(rom.rom, gfxTilesetId, spriteSet)
      const map16        = loadAllMap16(rom.rom)

      // Collect unique tile IDs present in the grid to limit atlas size
      const usedIds = new Set<number>()
      for (const row of tileGrid) for (const id of row) if (id !== 0) usedIds.add(id)
      const usedTiles = map16.filter(t => usedIds.has(t.id))

      const { atlas, atlasWidth, atlasHeight, tileUvs } = buildTileAtlas(usedTiles, vram, palette)

      // tileUvMap: plain object (JSON-serialisable)
      const tileUvMap: Record<number, { col: number; row: number }> = {}
      for (const [id, uv] of tileUvs) tileUvMap[id] = uv

      webview.postMessage({
        type: 'load',
        _initial:       overrides._initial !== false,
        levelIndex:     index,
        screens,
        tileGrid,
        l2TileGrid,
        atlasData:      Array.from(atlas),
        atlasWidth,
        atlasHeight,
        tileUvMap,
        backAreaColor:  romPalettes.backAreaColor,
        paletteRows:    cgram.rows.map(row => row.map((c: number[]) => [c[0], c[1], c[2], c[3]])),
        sprites:        sprites.map(s => ({ x: s.x, y: s.y, spriteId: s.spriteId })),
        header: {
          music:          header.music,
          spriteSet,
          bgPalette:      bgVariant,
          fgPalette:      fgVariant,
          bgColor:        header.bgColor,
          spritePalette,
          gfxTilesetId,
        },
      })
    } catch (err) {
      webview.postMessage({ type: 'error', message: (err as Error).message })
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'levelEditor.js')
    )
    const nonce = getNonce()
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             style-src ${webview.cspSource} 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SMW Level Editor</title>
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
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}
