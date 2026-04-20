import * as vscode from 'vscode'
import { getActiveRomSession, resolveRom, type RomSession } from '../RomSession'
import { parseLevelObjects, parseLevelSprites, isLevelModeVerticalL2 } from '../rom/LevelParser'
import { loadAllMap16BG, loadMap16WithPipeVariants, type Map16Tile } from '../rom/Map16'
import { loadRomPalettes, loadBackAreaColors, buildLevelCgram } from '../rom/PaletteLoader'
import { loadVram, VRAM_SLOT_NAMES, VRAM_CHAR_BASE, getCharPixels, type VramState, type GfxSheet } from '../rom/GfxLoader'
import { loadAnimationData, ANIM_INTERVAL_MS, type AnimationData } from '../rom/AnimationLoader'
import { loadPaletteAnimData, serializePaletteAnimData } from '../rom/PaletteAnimationLoader'
import { expandMap } from '../rom/ObjectExpander'
import { loadL2Preset, loadL2Objects, readL2Pointer, isPresetPtr, L2_TILEMAP_COLS, L2_TILEMAP_ROWS, L2_BG_PLANE_ROWS, L2_EMPTY_TILE } from '../rom/L2Loader'
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

      const romPath = descriptor.romPath as string
      const activeSession = getActiveRomSession()
      const session: RomSession | null =
        activeSession && activeSession.rom.rom.filePath === romPath ? activeSession : null
      const rom   = session?.rom ?? resolveRom(romPath)
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
      // L2 verticality is an independent bit from L1. Per bank_05.asm
      // LoadLevelData (lines 707-715) the game right-shifts the VerticalTable
      // entry for LayerProcessing=1 before checking bit 0, so L2 tracks bit 1
      // of the same entry. Vanilla mode-10 levels (0C2, 0DB, 0EA, 0F7, 108,
      // 109, 12A, 134, 1ED) have vertical L1 but horizontal L2.
      const isVerticalL2 = isLevelModeVerticalL2(header.levelMode)
      if (levelL2Ptr !== 0 && isPresetPtr(levelL2Ptr)) {
        const preset = loadL2Preset(rom.rom, levelL2Ptr)
        if (preset) {
          l2UsesBgAtlas = true
          // Tile the preset across the L1 footprint. The PPU's BG2 sub-tilemap
          // is 32×32 (1024 bytes); only rows 0..26 hold preset data and rows
          // 27..31 stay at the $25 init fill (CODE_05801E). For vertical
          // levels the BG scrolls vertically and the sub-tilemap wraps every
          // 32 rows, so the pattern repeats with a 5-row $25 strip between
          // iterations — matches the gap Lunar Magic shows between screens.
          // Horizontal levels never exceed 27 visible rows so the wrap
          // distinction doesn't matter.
          const cols = isVertical ? SCREEN_W_VERT : screens * SCREEN_W
          const rows = isVertical ? screens * SCREEN_H_VERT : SCREEN_H
          const bgPaddingTile = (preset.page << 8) | L2_EMPTY_TILE
          l2TileGrid = Array.from({ length: rows }, (_, r) =>
            Array.from({ length: cols }, (_, c) => {
              const rr = r % L2_BG_PLANE_ROWS
              return rr < L2_TILEMAP_ROWS
                ? preset.grid[rr][c % L2_TILEMAP_COLS]
                : bgPaddingTile
            }),
          )
        }
      } else if (levelL2Ptr !== 0 && !isPresetPtr(levelL2Ptr)) {
        // Object-stream L2. Uses L1's screens + tileset, no BG atlas.
        // Orientation comes from L2's own bit, not L1's.
        const tilesetForL2 = overrides.tilesetId ?? header.objectTileset
        const objL2 = loadL2Objects(rom.rom, levelL2Ptr, screens, tilesetForL2, isVerticalL2)
        if (objL2) {
          l2TileGrid = objL2.grid
        }
      }

      // ── Load ROM rendering data (allow webview overrides) ─────────────────
      const bgVariant      = overrides.bgVariant      ?? header.bgPalette
      const bgColorVariant = overrides.bgColorVariant ?? header.bgColor
      const romPalettes    = session?.getRomPalettes(bgColorVariant) ?? loadRomPalettes(rom.rom, bgColorVariant)
      const backAreaColors = session?.getBackAreaColors() ?? loadBackAreaColors(rom.rom)
      const fgVariant      = overrides.fgVariant      ?? header.fgPalette
      const spriteTileset  = overrides.spriteSet      ?? header.spriteSet
      const spritePalette  = overrides.spritePalette  ?? header.spritePalette
      // ObjectTileset is stored directly in header byte 4 bits 3-0 (CODE_0584E3)
      const objectTileset  = overrides.tilesetId      ?? header.objectTileset

      const marioVariant = overrides.marioVariant ?? 0
      const cgram = buildLevelCgram(romPalettes, bgVariant, fgVariant, spritePalette, marioVariant)
      const baseVram: VramState = session?.getVram(objectTileset, spriteTileset) ?? loadVram(rom.rom, objectTileset, spriteTileset)
      // Default map16 (variant 1 / green) for tiles outside the $133..$13A pipe
      // range, plus the four pipe variants for $133..$13A. Single pointer-table
      // build shared across all five outputs.
      const m16: { tiles: Map16Tile[]; pipeVariants: Map16Tile[][] } =
        session?.getMap16(objectTileset) ?? loadMap16WithPipeVariants(rom.rom, objectTileset)
      const map16 = m16.tiles
      const pipeVariants = m16.pipeVariants

      // Vanilla SMW cycles pipe palettes per screen via MAP16AppTable redirection
      // (CODE_0580BD, bank_05.asm:110-143). Tiles $133..$13A render with palette
      // 3/5/6/7 depending on which screen they're on. We expose all four variants
      // here so the webview can pick per screen at draw time.
      const pipeVariantDefs = pipeVariants.map(variantTiles =>
        variantTiles.map(t => ({
          id: t.id,
          tl: { c: t.tl.charNum, p: t.tl.palette, fx: t.tl.flipX, fy: t.tl.flipY },
          bl: { c: t.bl.charNum, p: t.bl.palette, fx: t.bl.flipX, fy: t.bl.flipY },
          tr: { c: t.tr.charNum, p: t.tr.palette, fx: t.tr.flipX, fy: t.tr.flipY },
          br: { c: t.br.charNum, p: t.br.palette, fx: t.br.flipX, fy: t.br.flipY },
        })),
      )

      // ── Animation: apply frame 0 to VRAM non-destructively ──
      // The SNES animation engine replaces 8×8 char data in VRAM via DMA.
      // Map16 tiles are just pointers to chars — they don't change. We build a
      // frame-0 proxy over the cached base VRAM so subsequent reuses of the
      // cached VRAM (other levels sharing this tileset) are not polluted.
      let animIntervalMs = ANIM_INTERVAL_MS
      let animFrameCount = 1
      let animData: AnimationData | null = null
      let vram: VramState = baseVram
      try {
        animData = session?.getAnimationData(objectTileset) ?? loadAnimationData(rom.rom, objectTileset)
        if (animData && animData.frameCount > 1) {
          animFrameCount = animData.frameCount
          animIntervalMs = animData.intervalMs

          const frame0Overrides = new Map<number, Uint8Array>()
          for (const slot of animData.frames[0]) {
            for (let i = 0; i < slot.tiles.length; i++) {
              frame0Overrides.set(slot.charBase + i, slot.tiles[i])
            }
          }
          vram = createAnimatedVramProxy(baseVram, frame0Overrides)
          console.log(`[ANIM] ${animFrameCount} frames, ${animIntervalMs}ms interval`)
        }
      } catch (err) {
        console.warn('[LVL] Failed to load animation data:', (err as Error).message)
      }

      // L1 + L2/BG Map16 tiles are both composited live in the webview from
      // their defs + vramIndexedData + paletteRows. No baked RGBA atlases are
      // sent; the webview's reactive chain produces first paint from indexed
      // data within a frame of the 'load' message.
      const map16bg = session?.getMap16BG() ?? loadAllMap16BG(rom.rom)

      // ── Layer 2 scroll settings ─────────────────────────────────────────
      // CODE_05D26E (bank_05.asm:7268-7277) reads byte $05F000+levelIndex,
      // takes the top nibble, and uses it as index into the 16-byte scroll
      // tables at $05D710 (VertLayer2Setting) and $05D720 (HorizLayer2Setting).
      // Each setting is 0..3 and drives the per-frame scroll divisor:
      //   0 = BG locked (no update), 1 = 1:1, 2 = 1/2 rate, 3 = 1/32 rate
      // (bank_00.asm:13735-13749 — px-wise shifts 0, 1, 5 for the non-zero
      // settings). The 1/32 rate is why vanilla mode-10 vertical levels never
      // expose the $25 padding strip in-game: BG scrolls so slowly that the
      // 32-row wrap is never reached within the level's height.
      const scrollByte = rom.rom.readByte(0x05F000 + index) ?? 0
      const scrollIndex = (scrollByte >> 4) & 0x0F
      const vertLayer2Setting  = rom.rom.readByte(0x05D710 + scrollIndex) ?? 0
      const horizLayer2Setting = rom.rom.readByte(0x05D720 + scrollIndex) ?? 0

      // ── Raw indexed VRAM for client-side Map16 composition ──
      // 1 byte per pixel (palette index), 64 bytes per char, 1536 chars.
      // Frame 0 has animation-frame-0 overrides already baked in via the proxy.
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
          const frameVram = createAnimatedVramProxy(baseVram, charOverrides)
          extraVramIndexed.push(Array.from(buildVramIndexed(frameVram)))
        }
      }

      webview.postMessage({
        type: 'load',
        _initial:       overrides._initial !== false,
        mapIndex:     index,
        screens,
        isVertical,
        // Per-screen pipe-palette variant for tiles $133..$13A, matching
        // vanilla SMW's MAP16AppTable cycle (CODE_0580BD, bank_05.asm:110-143).
        // Variant cycles 0→1→2→3→0 every screen for horizontal levels.
        pipeVariantDefs,
        screenPipeVariants: Array.from({ length: screens }, (_, s) => s & 0x03),
        tileGrid,
        l2TileGrid,
        l2UsesBgAtlas,
        // Map16 tile definitions for client-side composition from live VRAM chars.
        // Each def: { id, tl, bl, tr, br } where subtile: { c, p, fx, fy }
        map16Defs: map16.map(t => ({
          id: t.id,
          tl: { c: t.tl.charNum, p: t.tl.palette, fx: t.tl.flipX, fy: t.tl.flipY },
          bl: { c: t.bl.charNum, p: t.bl.palette, fx: t.bl.flipX, fy: t.bl.flipY },
          tr: { c: t.tr.charNum, p: t.tr.palette, fx: t.tr.flipX, fy: t.tr.flipY },
          br: { c: t.br.charNum, p: t.br.palette, fx: t.br.flipX, fy: t.br.flipY },
        })),
        // L2/BG Map16 defs (same shape as map16Defs) — webview recomposites live.
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
          extraVramIndexed,     // frames 1+ raw indexed for Map16 composition
        },
        paletteAnimation: (() => {
          const palAnimRaw = session?.getPaletteAnim('level') ?? loadPaletteAnimData(rom.rom, 'level')
          return palAnimRaw ? serializePaletteAnimData(palAnimRaw) : null
        })(),
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
          vertLayer2Setting,
          horizLayer2Setting,
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
             script-src 'nonce-${nonce}';
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
