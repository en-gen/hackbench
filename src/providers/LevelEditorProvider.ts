import * as vscode from 'vscode'
import { SmwRom, ADDR } from '../rom/SmwRom'
import { parseLevelObjects, parseLevelSprites } from '../rom/LevelParser'
import { loadAllMap16 } from '../rom/Map16'
import { loadRomPalettes, buildLevelCgram, loadBackAreaColors } from '../rom/PaletteLoader'
import { loadVram, VRAM_SLOT_NAMES, VRAM_CHAR_BASE, type VramState, type GfxSheet } from '../rom/GfxLoader'
import { buildTileAtlas, renderMap16Tile } from '../rom/TileRenderer'
import { loadAnimationData, ANIM_FRAME_COUNT, ANIM_INTERVAL_MS, type AnimationData } from '../rom/AnimationLoader'
import type { Map16Tile } from '../rom/Map16'
type RgbaColor = [number, number, number, number]
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
          bgColorVariant: msg.bgColorVariant as number,
          marioVariant:   msg.marioVariant   as number,
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
    overrides: { bgVariant?: number; fgVariant?: number; spriteSet?: number; spritePalette?: number; tilesetId?: number; bgColorVariant?: number; marioVariant?: number; _initial?: boolean },
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
      const screens = header.levelLength

      const sprPtr = rom.getLevelSpritePointer(index)
      let sprites = parseLevelSprites(Buffer.alloc(1, 0xFF))
      if (sprPtr) {
        const sprData = rom.rom.readAt(sprPtr, 0x200)
        if (sprData) sprites = parseLevelSprites(sprData)
      }

      // ── Build L1 tile grid ────────────────────────────────────────────────
      const tileGrid = expandLevel(objects, screens, rom.rom)

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
      const bgVariant      = overrides.bgVariant      ?? header.bgPalette
      const bgColorVariant = overrides.bgColorVariant ?? header.bgColor
      const romPalettes    = loadRomPalettes(rom.rom, bgColorVariant)
      const backAreaColors = loadBackAreaColors(rom.rom)
      const fgVariant      = overrides.fgVariant      ?? header.fgPalette
      const spriteTileset  = overrides.spriteSet      ?? header.spriteSet
      const spritePalette  = overrides.spritePalette  ?? header.spritePalette
      // ObjectTileset is stored directly in header byte 4 bits 3-0 (CODE_0584E3)
      const objectTileset  = overrides.tilesetId      ?? header.objectTileset

      const marioVariant = overrides.marioVariant ?? 0
      const cgram = buildLevelCgram(romPalettes, bgVariant, fgVariant, spritePalette, marioVariant)
      const palette = { colors: cgram.colors, rows: cgram.rows }
      const vram    = loadVram(rom.rom, objectTileset, spriteTileset)
      const map16   = loadAllMap16(rom.rom, objectTileset)

      // Collect unique tile IDs present in the grid
      const usedIds = new Set<number>()
      for (const row of tileGrid) for (const id of row) if (id !== 0) usedIds.add(id)
      const usedTiles = map16.filter(t => usedIds.has(t.id))

      // ── Animation: apply frame 0 to VRAM BEFORE building any atlases ──
      // The SNES animation engine replaces 8×8 char data in VRAM via DMA.
      // Map16 tiles are just pointers to chars — they don't change.
      // We apply frame 0 to the base VRAM before building any atlases,
      // then build additional VRAM sheets for frames 1+ so the webview
      // can cycle them.
      let animIntervalMs = ANIM_INTERVAL_MS
      let animFrameCount = 1
      let animData: ReturnType<typeof loadAnimationData> = null
      try {
        animData = loadAnimationData(rom.rom, objectTileset)
        if (animData && animData.frameCount > 1) {
          animFrameCount = animData.frameCount
          animIntervalMs = animData.intervalMs

          // Apply frame 0 overrides directly to the base VRAM
          // This makes ALL downstream rendering (8×8 sheet, Map16 atlas, level atlas)
          // use the correct animated char data from the start.
          const frame0Overrides = new Map<number, Uint8Array>()
          for (const slot of animData.frames[0]) {
            for (let i = 0; i < slot.tiles.length; i++) {
              frame0Overrides.set(slot.charBase + i, slot.tiles[i])
            }
          }
          const baseVram = createAnimatedVramProxy(vram, frame0Overrides)
          // Replace vram slots with the frame-0-applied versions
          for (const slotName of VRAM_SLOT_NAMES) {
            if (baseVram[slotName]) (vram as Record<string, unknown>)[slotName] = baseVram[slotName]
          }
          console.log(`[ANIM] ${animFrameCount} frames, ${animIntervalMs}ms interval`)
        }
      } catch (err) {
        console.warn('[LVL] Failed to load animation data:', (err as Error).message)
      }

      // ── Build all atlases using the frame-0-applied VRAM ──────────────
      const { atlas, atlasWidth, atlasHeight, tileUvs } = buildTileAtlas(usedTiles, vram, palette)
      const tileUvMap: Record<number, { col: number; row: number }> = {}
      for (const [id, uv] of tileUvs) tileUvMap[id] = uv

      const { atlas: map16Atlas } = buildTileAtlas(map16, vram, palette)

      const { loadAllMap16BG } = require('../rom/Map16') as typeof import('../rom/Map16')
      const map16bg = loadAllMap16BG(rom.rom)
      const { atlas: map16BgAtlas } = buildTileAtlas(map16bg, vram, palette)

      // ── Build extra animation frames (VRAM sheets only) ────────────────
      // Map16 viewer composites from live VRAM chars per frame, so no
      // separate Map16 atlases are needed for animation.
      const extraVramSheets: number[][] = []
      if (animData && animFrameCount > 1) {
        for (let frame = 1; frame < animFrameCount; frame++) {
          const charOverrides = new Map<number, Uint8Array>()
          for (const slot of animData.frames[frame]) {
            for (let i = 0; i < slot.tiles.length; i++) {
              charOverrides.set(slot.charBase + i, slot.tiles[i])
            }
          }
          const frameVram = createAnimatedVramProxy(vram, charOverrides)
          extraVramSheets.push(Array.from(buildVramSheet(frameVram, palette)))
        }
      }

      // ── Build 8×8 VRAM sheet (frame 0 applied) ──
      const vramSheet = buildVramSheet(vram, palette)
      const vramSheetW = 128  // 16 tiles × 8px
      const vramSheetH = Math.ceil(1536 / 16) * 8

      // ── Raw indexed VRAM for client-side Map16 composition ──
      // 1 byte per pixel (palette index), 64 bytes per char, 1536 chars.
      // Per-frame indexed data built alongside VRAM sheets above.
      const vramIndexed = buildVramIndexed(vram)
      const extraVramIndexed: number[][] = []
      if (animData && animFrameCount > 1) {
        for (let frame = 1; frame < animFrameCount; frame++) {
          const charOverrides = new Map<number, Uint8Array>()
          for (const slot of animData.frames[frame]) {
            for (let i = 0; i < slot.tiles.length; i++) {
              charOverrides.set(slot.charBase + i, slot.tiles[i])
            }
          }
          const frameVram = createAnimatedVramProxy(vram, charOverrides)
          extraVramIndexed.push(Array.from(buildVramIndexed(frameVram)))
        }
      }

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
        vramSheetData:  Array.from(vramSheet),
        vramSheetW,
        vramSheetH,
        map16AtlasData: Array.from(map16Atlas),
        map16BgAtlasData: Array.from(map16BgAtlas),
        // Map16 tile definitions for client-side composition from live VRAM chars.
        // Each def: { id, tl, bl, tr, br } where subtile: { c, p, fx, fy }
        map16Defs: map16.map(t => ({
          id: t.id,
          tl: { c: t.tl.charNum, p: t.tl.palette, fx: t.tl.flipX, fy: t.tl.flipY },
          bl: { c: t.bl.charNum, p: t.bl.palette, fx: t.bl.flipX, fy: t.bl.flipY },
          tr: { c: t.tr.charNum, p: t.tr.palette, fx: t.tr.flipX, fy: t.tr.flipY },
          br: { c: t.br.charNum, p: t.br.palette, fx: t.br.flipX, fy: t.br.flipY },
        })),
        // Raw indexed VRAM: palette indices per char for client-side Map16 composition
        vramIndexedData: Array.from(vramIndexed),
        animation: {
          frameCount: animFrameCount,
          intervalMs: animIntervalMs,
          extraVramSheets,      // frames 1+ RGBA for the 8×8 viewer
          extraVramIndexed,     // frames 1+ raw indexed for Map16 composition
        },
        backAreaColor:  romPalettes.backAreaColor,
        backAreaColors: backAreaColors.map(c => [c[0], c[1], c[2], c[3]]),
        paletteRows:    cgram.rows.map(row => row.map((c: number[]) => [c[0], c[1], c[2], c[3]])),
        sprites:        sprites.map(s => ({ x: s.x, y: s.y, spriteId: s.spriteId })),
        header: {
          music:          header.music,
          spriteSet:      spriteTileset,
          bgPalette:      bgVariant,
          fgPalette:      fgVariant,
          bgColor:        bgColorVariant,
          spritePalette,
          marioVariant,
          gfxTilesetId:   objectTileset,
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

// ── VRAM sheet builder ───────────────────────────────────────────────────────

function buildVramSheet(
  vramState: VramState,
  palette: { colors: RgbaColor[] },
): Uint8ClampedArray {
  const { getCharPixels: getChar } = require('../rom/GfxLoader') as typeof import('../rom/GfxLoader')
  const { getPaletteColor: getPalColor } = require('../rom/PaletteLoader') as typeof import('../rom/PaletteLoader')
  const VRAM_TILES = 1536
  const VR_PER_ROW = 16
  const vramSheetW = VR_PER_ROW * 8
  const vramSheetH = Math.ceil(VRAM_TILES / VR_PER_ROW) * 8
  const sheet = new Uint8ClampedArray(vramSheetW * vramSheetH * 4)
  for (let i = 0; i < VRAM_TILES; i++) {
    const pixels = getChar(vramState, i)
    const tileCol = i % VR_PER_ROW
    const tileRow = Math.floor(i / VR_PER_ROW)
    const palRow = i < 0x300 ? 2 : 8
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const palIdx = pixels ? pixels[py * 8 + px] : 0
        const destX = tileCol * 8 + px
        const destY = tileRow * 8 + py
        const destOff = (destY * vramSheetW + destX) * 4
        if (palIdx === 0 || !pixels) {
          sheet[destOff] = sheet[destOff + 1] = sheet[destOff + 2] = 0
          sheet[destOff + 3] = pixels ? 0 : 128
        } else {
          const color = getPalColor(palette, palRow, palIdx)
          sheet[destOff] = color[0]; sheet[destOff + 1] = color[1]
          sheet[destOff + 2] = color[2]; sheet[destOff + 3] = 255
        }
      }
    }
  }
  return sheet
}

/**
 * Build raw indexed VRAM char data: 1 byte per pixel (palette index 0-15).
 * Flat array of 1536 chars × 64 pixels = 98304 bytes.
 * The webview uses this + palette rows to composite Map16 tiles with
 * per-subtile palette selection (unlike the RGBA sheet which has fixed palette).
 */
function buildVramIndexed(vramState: VramState): Uint8Array {
  const { getCharPixels: getChar } = require('../rom/GfxLoader') as typeof import('../rom/GfxLoader')
  const VRAM_TILES = 1536
  const buf = new Uint8Array(VRAM_TILES * 64)
  for (let i = 0; i < VRAM_TILES; i++) {
    const pixels = getChar(vramState, i)
    const off = i * 64
    if (pixels) {
      for (let p = 0; p < 64; p++) buf[off + p] = pixels[p]
    }
  }
  return buf
}

// ── Animation helpers ─────────────────────────────────────────────────────────

function buildAnimationPatches(
  animData: AnimationData,
  usedTiles: Map16Tile[],
  tileUvs: Map<number, { col: number; row: number }>,
  vram: VramState,
  palette: { colors: RgbaColor[] },
): Array<Array<{ tileId: number; col: number; row: number; rgba: number[] }>> {
  const animatedChars = new Set<number>()
  for (const frameSlots of animData.frames) {
    for (const slot of frameSlots) {
      for (let i = 0; i < slot.tiles.length; i++) {
        animatedChars.add(slot.charBase + i)
      }
    }
  }

  const animatedTiles: Map16Tile[] = []
  for (const tile of usedTiles) {
    if ([tile.tl, tile.tr, tile.bl, tile.br].some(s => animatedChars.has(s.charNum))) {
      animatedTiles.push(tile)
    }
  }
  if (animatedTiles.length === 0) return []

  const patches: Array<Array<{ tileId: number; col: number; row: number; rgba: number[] }>> = []
  for (let frame = 0; frame < animData.frameCount; frame++) {
    const charOverrides = new Map<number, Uint8Array>()
    for (const slot of animData.frames[frame]) {
      for (let i = 0; i < slot.tiles.length; i++) {
        charOverrides.set(slot.charBase + i, slot.tiles[i])
      }
    }
    const proxyVram = createAnimatedVramProxy(vram, charOverrides)
    const framePatches: Array<{ tileId: number; col: number; row: number; rgba: number[] }> = []
    for (const tile of animatedTiles) {
      const uv = tileUvs.get(tile.id)
      if (!uv) continue
      const rgba = renderMap16Tile(tile, proxyVram, palette)
      framePatches.push({ tileId: tile.id, col: uv.col, row: uv.row, rgba: Array.from(rgba) })
    }
    patches.push(framePatches)
  }
  return patches
}

function createAnimatedVramProxy(
  baseVram: VramState,
  charOverrides: Map<number, Uint8Array>,
): VramState {
  if (charOverrides.size === 0) return baseVram
  const result: VramState = { ...baseVram }
  for (const slot of VRAM_SLOT_NAMES) {
    const base = VRAM_CHAR_BASE[slot]
    const sheet = baseVram[slot]
    if (!sheet) continue
    let hasOverride = false
    for (let i = 0; i < sheet.length; i++) {
      if (charOverrides.has(base + i)) { hasOverride = true; break }
    }
    if (hasOverride) {
      const newSheet: GfxSheet = [...sheet]
      for (let i = 0; i < newSheet.length; i++) {
        const override = charOverrides.get(base + i)
        if (override) newSheet[i] = override
      }
      result[slot] = newSheet
    }
  }
  return result
}
