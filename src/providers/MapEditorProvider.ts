import * as vscode from 'vscode'
import { SmwRom, ADDR } from '../rom/SmwRom'
import { parseLevelObjects, parseLevelSprites } from '../rom/LevelParser'
import { loadAllMap16, loadAllMap16BG } from '../rom/Map16'
import { loadRomPalettes, buildLevelCgram, loadBackAreaColors, getPaletteColor } from '../rom/PaletteLoader'
import { loadVram, VRAM_SLOT_NAMES, VRAM_CHAR_BASE, getCharPixels, type VramState, type GfxSheet } from '../rom/GfxLoader'
import { buildTileAtlas } from '../rom/TileRenderer'
import { loadAnimationData, ANIM_INTERVAL_MS } from '../rom/AnimationLoader'
import { loadPaletteAnimData, serializePaletteAnimData } from '../rom/PaletteAnimationLoader'
type RgbaColor = [number, number, number, number]
import { expandMap } from '../rom/ObjectExpander'
import { loadL2Preset, loadL2Objects, readL2Pointer, isPresetPtr, L2_TILEMAP_COLS, L2_TILEMAP_ROWS } from '../rom/L2Loader'
import { getLevelMusicBgm } from '../rom/MusicData'
import { buildSpc } from '../rom/SpcBuilder'
import { SCREEN_W, SCREEN_H, SCREEN_W_VERT, SCREEN_H_VERT } from '../rom/LevelParser'

/**
 * Custom editor provider for .smwmap virtual files.
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
 *     { type:'load', mapIndex, screens, tileGrid, atlasData,
 *       atlasWidth, atlasHeight, tileUvMap, sprites, header }
 *     { type:'error', message }
 *   Webview → Extension:
 *     { type:'ready' }
 *     { type:'edit', kind:'place'|'erase', tileId, col, row }
 */
export class MapEditorProvider implements vscode.CustomReadonlyEditorProvider {
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

    const unmuteIcon = {
          light: vscode.Uri.joinPath(this.context.extensionUri, 'build', 'icons', 'light', 'unmute.svg'),
          dark: vscode.Uri.joinPath(this.context.extensionUri, 'build', 'icons', 'dark', 'unmute.svg'),
        }

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        await this._sendLevelData(document.uri, panel.webview, {})
      } else if (msg.type === 'musicState') {
        panel.iconPath = msg.playing ? unmuteIcon : undefined
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
      const index = descriptor.mapIndex as number

      // ── Parse level ───────────────────────────────────────────────────────
      const rawL1 = rom.getLevelRawData(index)
      if (!rawL1) {
        webview.postMessage({ type: 'error', message: `Map $${index.toString(16).toUpperCase()} has no data` })
        return
      }

      const { header, objects, isVertical } = parseLevelObjects(rawL1)
      const screens = header.levelLength

      const sprPtr = rom.getLevelSpritePointer(index)
      let sprites = parseLevelSprites(Buffer.alloc(1, 0xFF))
      if (sprPtr) {
        const sprData = rom.rom.readAt(sprPtr, 0x200)
        if (sprData) sprites = parseLevelSprites(sprData)
      }

      // ── Build L1 tile grid ────────────────────────────────────────────────
      // Tileset byte from the header selects which dispatch table (CODE_0DA415)
      // and thus which handler set is used. Must be passed so standard-object
      // dispatch reads the correct per-tileset handler pointer table.
      // Vertical levels flip the grid shape to 32 × (screens*16).
      const tileGrid = expandMap(objects, screens, rom.rom, header.objectTileset, isVertical)

      // ── Build L2 tile grid ────────────────────────────────────────────────
      // Ported from CODE_05801E (bank_05.asm lines 20-74) and LoadLevel's
      // LayerProcessing=1 path (line 458). Two distinct flavors:
      //
      //   - bank == $FF: preset background. LC_RLE1-compressed Map16 tile
      //     IDs in bank $0C (see loadL2Preset). Tiles render against the BG
      //     Map16 pointer table (Map16BGTiles @ $0D9100).
      //
      //   - bank != $FF: object stream. Same format as L1. LoadLevel skips
      //     L2's 5-byte header (+5 offset) and expands using L1's screen
      //     count and L1's ObjectTileset. Tiles render against the regular
      //     Map16 pointer table (same atlas as L1).
      //
      // The `l2UsesBgAtlas` flag tells the webview which atlas to sample.
      let l2TileGrid: number[][] | null = null
      let l2UsesBgAtlas = false
      const levelL2Ptr = readL2Pointer(rom.rom, index) ?? 0
      if (levelL2Ptr !== 0 && isPresetPtr(levelL2Ptr)) {
        const preset = loadL2Preset(rom.rom, levelL2Ptr)
        if (preset) {
          l2UsesBgAtlas = true
          // Tile the 32×27 preset grid across the full L1 area. Mirrors how the
          // live game scrolls the BG: the same pattern repeats in both axes.
          // Horizontal: level width × 27 rows. Vertical: 32 × (screens*16) rows.
          const cols = isVertical ? SCREEN_W_VERT : screens * SCREEN_W
          const rows = isVertical ? screens * SCREEN_H_VERT : SCREEN_H
          l2TileGrid = Array.from({ length: rows }, (_, r) =>
            Array.from({ length: cols }, (_, c) =>
              preset.grid[r % L2_TILEMAP_ROWS][c % L2_TILEMAP_COLS],
            ),
          )
        }
      } else if (levelL2Ptr !== 0 && !isPresetPtr(levelL2Ptr)) {
        // Object-stream L2. Uses L1's screens + tileset, no BG atlas.
        const tilesetForL2 = overrides.tilesetId ?? header.objectTileset
        const objL2 = loadL2Objects(rom.rom, levelL2Ptr, screens, tilesetForL2, isVertical)
        if (objL2) {
          l2TileGrid = objL2.grid
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

      // L1 + L2/BG Map16 tiles are both composited live in the webview from
      // their defs + vramIndexedData + paletteRows, so animation frames can
      // swap the L2 atlas the same way they swap L1. The baked atlas is kept
      // as an initial-paint fallback before the client rebuild runs.
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
        mapIndex:     index,
        screens,
        isVertical,
        tileGrid,
        l2TileGrid,
        l2UsesBgAtlas,
        vramSheetData:  Array.from(vramSheet),
        vramSheetW,
        vramSheetH,
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
        // L2/BG Map16 defs (same shape as map16Defs) so the webview can re-composite
        // the BG atlas per animation frame instead of relying on the baked atlas.
        map16BgDefs: map16bg.map(t => ({
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
        paletteAnimation: (() => {
          const palAnimRaw = loadPaletteAnimData(rom.rom, 'level')
          return palAnimRaw ? serializePaletteAnimData(palAnimRaw) : null
        })(),
        backAreaColor:  romPalettes.backAreaColor,
        backAreaColors: backAreaColors.map(c => [c[0], c[1], c[2], c[3]]),
        paletteRows:    cgram.rows.map(row => row.map((c: number[]) => [c[0], c[1], c[2], c[3]])),
        sprites:        sprites.map(s => ({ x: s.x, y: s.y, spriteId: s.spriteId })),
        // SPC music for this level's BGM
        spcData: (() => {
          const bgm = getLevelMusicBgm(rom.rom, header.music)
          const spc = bgm > 0 ? buildSpc(rom.rom, bgm, 'level') : null
          return spc ? Array.from(spc) : null
        })(),
        spcBgmCommand: getLevelMusicBgm(rom.rom, header.music),
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
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'mapEditor.js')
    )
    const spcJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'spc.js')
    )
    const wasmUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'spc.wasm')
    )
    const codiconCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'codicon.css')
    )
    const nonce = getNonce()
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}' 'wasm-unsafe-eval' 'unsafe-eval';
             connect-src ${webview.cspSource};
             font-src ${webview.cspSource};
             style-src ${webview.cspSource} 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SMW Map Editor</title>
  <link rel="stylesheet" href="${codiconCssUri}" />
  <style>
    html, body { height:100%; margin:0; padding:0; overflow:hidden; }
    #app { height:100%; }
  </style>
</head>
<body>
  <!-- Stub DOM for spc.js UI init -->
  <div id="spc-player-interface" style="display:none;">
    <div id="spc-player-header" class="header-button"></div>
    <div class="title"></div><div class="subtitle"></div><div class="details"></div>
    <button class="pause hidden"></button><button class="play"></button>
    <button class="restart"></button><button class="stop"></button><button class="close"></button>
    <input type="checkbox" id="spc-player-toggle"/>
    <input type="checkbox" id="spc-player-loop"/>
    <input type="range" id="volume-slider" class="volume-slider" min="0" max="1.5" step="0.01" value="1"/>
    <div class="volume-fill"></div><div class="volume-level"></div><div class="volume-thumb"></div>
    <div class="seek-container"><input type="range" class="seek-control" min="0" max="1"/><span class="seek-preview"></span></div>
    <span class="track-time-elapsed"></span><span class="track-duration"></span>
    <div id="track-list-container" class="hidden"><div class="track-list-scrollbox"></div>
      <div class="track-list"></div>
      <div class="overflow-indicator top"></div><div class="overflow-indicator bottom"></div>
    </div><div class="seek"></div>
  </div>
  <div id="app"></div>
  <script nonce="${nonce}">
    window.Module = { locateFile: function(path) {
      if (path.endsWith('.wasm')) return '${wasmUri}';
      return path;
    }};
    window.SMWCentral = { SPCPlayer: {} };
  </script>
  <script nonce="${nonce}" src="${spcJsUri}"></script>
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
  const getChar = getCharPixels
  const getPalColor = getPaletteColor
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
  const getChar = getCharPixels
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
