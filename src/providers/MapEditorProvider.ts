import * as vscode from 'vscode'
import { getActiveRomSession, resolveRom, type RomSession } from '../RomSession'
import { parseLevelObjects, parseLevelSprites } from '../rom/LevelParser'
import { loadAllMap16BG, loadMap16WithPipeVariants, type Map16Tile } from '../rom/Map16'
import { pSwitchSubstitute } from '../rom/PSwitchRules'
import { loadRomPalettes, loadBackAreaColors, buildLevelCgram } from '../rom/PaletteLoader'
import { loadVram, VRAM_SLOT_NAMES, VRAM_CHAR_BASE, getCharPixels, type VramState, type GfxSheet } from '../rom/GfxLoader'
import { loadAnimationData, ANIM_INTERVAL_MS, type AnimationData } from '../rom/AnimationLoader'
import { loadPaletteAnimData, serializePaletteAnimData } from '../rom/PaletteAnimationLoader'
import { readInitialLayer1YPos, readL3RoutineSummary, classifyL3Routine } from '../rom/L3Loader'
import { expandMap } from '../rom/ObjectExpander'
import { readL2Pointer, isPresetPtr, loadL2Preset, loadL2Objects, L2_TILEMAP_COLS, L2_TILEMAP_ROWS, L1_SCREEN_W, L1_SCREEN_H } from '../rom/L2Loader'
import { buildMapPayload } from '../rom/model/MapBuilder'

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
          // New header-bit overrides (Plan A — render overrides). Music /
          // levelMode / itemMemory / verticalScroll have no current render
          // path that honors the override; they're echoed back so the
          // controls keep their selected value across re-renders. Step 3
          // (real ROM writes) will wire visible effects + persistence.
          music:          msg.music          as number | undefined,
          timeLimit:      msg.timeLimit      as number | undefined,
          levelMode:      msg.levelMode      as number | undefined,
          itemMemory:     msg.itemMemory     as number | undefined,
          verticalScroll: msg.verticalScroll as number | undefined,
          layer3Priority: msg.layer3Priority as boolean | undefined,
          layer3Setting:  msg.layer3Setting  as number | undefined,
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
    overrides: {
      bgVariant?: number; fgVariant?: number; spriteSet?: number;
      spritePalette?: number; tilesetId?: number; bgColorVariant?: number;
      marioVariant?: number;
      // New header-bit overrides (Plan A — render overrides only).
      music?: number; timeLimit?: number; levelMode?: number;
      itemMemory?: number; verticalScroll?: number;
      layer3Priority?: boolean; layer3Setting?: number;
      _initial?: boolean;
    },
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
      let sprites = parseLevelSprites(Buffer.alloc(1, 0xFF), isVertical)
      if (sprPtr) {
        const sprData = rom.rom.readAt(sprPtr, 0x200)
        if (sprData) sprites = parseLevelSprites(sprData, isVertical)
      }

      // ── Build L1 tile grid ────────────────────────────────────────────────
      // Tileset byte from the header selects which dispatch table (CODE_0DA415)
      // and thus which handler set is used. Must be passed so standard-object
      // dispatch reads the correct per-tileset handler pointer table.
      // Vertical levels flip the grid shape to 32 × (screens*16).
      const tileGrid = expandMap(objects, screens, rom.rom, header.objectTileset, isVertical, header.levelMode)

      // ── Build L2 tile grid ────────────────────────────────────────────────
      let l2TileGrid: number[][] | null = null
      let l2UsesBgAtlas = false
      const levelL2Ptr = readL2Pointer(rom.rom, index) ?? 0
      if (levelL2Ptr !== 0 && isPresetPtr(levelL2Ptr)) {
        const preset = loadL2Preset(rom.rom, levelL2Ptr)
        if (preset) {
          l2UsesBgAtlas = true
          const cols = screens * L1_SCREEN_W
          const rows = L1_SCREEN_H
          l2TileGrid = Array.from({ length: rows }, (_, r) =>
            Array.from({ length: cols }, (_, c) =>
              preset.grid[r % L2_TILEMAP_ROWS][c % L2_TILEMAP_COLS],
            ),
          )
        }
      } else if (levelL2Ptr !== 0) {
        const tilesetForL2 = overrides.tilesetId ?? header.objectTileset
        const objL2 = loadL2Objects(rom.rom, levelL2Ptr, screens, tilesetForL2, isVertical)
        if (objL2) l2TileGrid = objL2.grid
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
      // Map16 / BG counts only — the model owns tile composition. Numbers go
      // into the load payload so the Map16 panel can build its page strip.
      const m16: { tiles: Map16Tile[]; pipeVariants: Map16Tile[][] } =
        session?.getMap16(objectTileset) ?? loadMap16WithPipeVariants(rom.rom, objectTileset)
      const map16 = m16.tiles
      const map16bg = session?.getMap16BG() ?? loadAllMap16BG(rom.rom)

      // Animation timing — just the counters. The model reads VRAM directly
      // via AnimatedPixelsBehavior behaviors, so the webview never sees raw frames.
      let animIntervalMs = ANIM_INTERVAL_MS
      let animFrameCount = 1
      try {
        const animData = session?.getAnimationData(objectTileset) ?? loadAnimationData(rom.rom, objectTileset)
        if (animData && animData.frameCount > 1) {
          animFrameCount = animData.frameCount
          animIntervalMs = animData.intervalMs
        }
      } catch (err) {
        console.warn('[LVL] Failed to load animation data:', (err as Error).message)
      }

      // vramIndexedData was used by the legacy renderer (removed in #62).
      // The model now owns VRAM rendering; pass an empty array so the field
      // remains in the payload without breaking old webview reads.
      const vramIndexed: number[] = []

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
      // Initial camera Y — see readInitialLayer1YPos in L3Loader.ts. Seeds
      // the camera viewport so sublevels (accessed only via pipes/doors) show
      // the player's actual starting viewport.
      const initialCameraYPx = readInitialLayer1YPos(rom.rom, index, isVertical)

      // L3 routine summary — pure metadata (no stripe parsing). Read against
      // the live tileset override so the routine kind reflects what the
      // editor is actually rendering, not just the header default. When
      // layer3Setting is overridden, recompute via classifyL3Routine so the
      // $009F88 byte / kind / init Y display values match the override.
      let l3Routine = readL3RoutineSummary(rom.rom, index, objectTileset)
      if (overrides.layer3Setting !== undefined && overrides.layer3Setting !== l3Routine.layer3Setting) {
        const setting = overrides.layer3Setting
        const settingsByte = setting === 0
          ? null
          : (rom.rom.readByte(0x009F88 + objectTileset * 3 + (setting - 1)) ?? null)
        l3Routine = classifyL3Routine({ layer3Setting: setting, settingsByte, tileset: objectTileset })
      }

      // Header-bit overrides (Plan A — render overrides only). Echoed into
      // the header payload so the controls keep their selected value across
      // re-renders. Step 3 (real ROM writes) will turn these into byte-level
      // mutations of the L1 header.
      const musicEff          = overrides.music          ?? header.music
      const timeLimitEff      = overrides.timeLimit      ?? header.timeLimit
      const levelModeEff      = overrides.levelMode      ?? header.levelMode
      const itemMemoryEff     = overrides.itemMemory     ?? header.itemMemory
      const verticalScrollEff = overrides.verticalScroll ?? header.verticalScroll
      const layer3PriorityEff = overrides.layer3Priority ?? header.layer3Priority

      // Palette-animation raw — the model owns the frame cycle; the
      // legacy load payload only needs the timer's frameCount / intervalMs.
      const palAnimRaw = session?.getPaletteAnim('level') ?? loadPaletteAnimData(rom.rom, 'level')
      const palAnimSerialized = palAnimRaw ? serializePaletteAnimData(palAnimRaw) : null
      webview.postMessage({
        type: 'load',
        _initial:       overrides._initial !== false,
        mapIndex:     index,
        screens,
        isVertical,
        tileGrid,
        l2TileGrid,
        l2UsesBgAtlas,
        // Map16 tile definitions for client-side composition from live VRAM chars.
        // Each def: { id, tl, bl, tr, br, pSwitchSub } where subtile: { c, p, fx, fy }.
        // pSwitchSub is attached here (not in Map16.ts) so each tile carries its own
        // "I have a P-switch counterpart" description while keeping the ROM reader
        // free of game-specific substitution rules.
        map16Defs: map16.map(t => ({
          id: t.id,
          tl: { c: t.tl.charNum, p: t.tl.palette, fx: t.tl.flipX, fy: t.tl.flipY },
          bl: { c: t.bl.charNum, p: t.bl.palette, fx: t.bl.flipX, fy: t.bl.flipY },
          tr: { c: t.tr.charNum, p: t.tr.palette, fx: t.tr.flipX, fy: t.tr.flipY },
          br: { c: t.br.charNum, p: t.br.palette, fx: t.br.flipX, fy: t.br.flipY },
          pSwitchSub: pSwitchSubstitute(t.id),
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
        },
        paletteAnimation: palAnimSerialized
          ? { frameCount: palAnimSerialized.frameCount, intervalMs: palAnimSerialized.intervalMs }
          : null,
        backAreaColor:  romPalettes.backAreaColor,
        backAreaColors: backAreaColors.map(c => [c[0], c[1], c[2], c[3]]),
        sprites:        sprites.map(s => ({ x: s.x, y: s.y, spriteId: s.spriteId })),
        header: {
          music:          musicEff,
          spriteSet:      spriteTileset,
          bgPalette:      bgVariant,
          fgPalette:      fgVariant,
          bgColor:        bgColorVariant,
          spritePalette,
          marioVariant,
          gfxTilesetId:   objectTileset,
          vertLayer2Setting,
          horizLayer2Setting,
          initialCameraYPx,
          // Header-bit fields surfaced for the Level Settings panel. Each
          // honors a render override from the rerender pipeline (Plan A); the
          // override is purely UI-state today and gets persisted as a real
          // ROM byte write when step 3 lands.
          levelLength:    header.levelLength,
          levelMode:      levelModeEff,
          timeLimit:      timeLimitEff,
          itemMemory:     itemMemoryEff,
          verticalScroll: verticalScrollEff,
          layer3Priority: layer3PriorityEff,
          isVertical,
        },
        l3Routine: {
          layer3Setting:   l3Routine.layer3Setting,
          settingsByte:    l3Routine.settingsByte,
          kind:            l3Routine.kind,
          initialYPx:      l3Routine.initialYPx,
          isTideUpAndDown: l3Routine.isTideUpAndDown,
        },
      })
      // Ship the self-rendering model payload alongside the legacy atlas
      // data. Toolbar dropdown overrides go in too so the model rebuilds
      // with the same effective palette/tileset/sprite set the legacy
      // path uses — otherwise dropdown changes wouldn't affect anything
      // the model renders.
      try {
        const modelPayload = buildMapPayload(rom, index, {
          bgPalette:     bgVariant,
          fgPalette:     fgVariant,
          bgColor:       bgColorVariant,
          spritePalette,
          spriteSet:     spriteTileset,
          objectTileset,
          marioVariant,
        })
        webview.postMessage({ type: 'modelPayload', payload: modelPayload })
      } catch (modelErr) {
        // Non-fatal: legacy render keeps working if the model build trips.
        console.error('[MapEditorProvider] model payload build failed:', modelErr)
      }
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
