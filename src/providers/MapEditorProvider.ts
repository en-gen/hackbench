import * as vscode from 'vscode'
import { getActiveRomSession, resolveRom, type RomSession } from '../RomSession'
import {
  getNonce,
  getWebviewUri,
  readDescriptor,
  postWebviewError,
  SPC_PLAYER_STUB_DOM,
  buildSpcInitScript,
} from './webviewUtils'
import { parseLevelObjects, parseLevelSprites } from '../rom/LevelParser'
import { loadAllMap16BG, loadMap16WithPipeVariants, type Map16Tile } from '../rom/Map16'
import { pSwitchSubstitute } from '../rom/PSwitchRules'
import { loadRomPalettes, loadBackAreaColors } from '../rom/PaletteLoader'
import { loadAnimationData, ANIM_INTERVAL_MS } from '../rom/AnimationLoader'
import {
  explainPaletteAnimation,
  loadPaletteAnimData,
  serializePaletteAnimData,
} from '../rom/PaletteAnimationLoader'
import { readInitialLayer1YPos, readL3RoutineSummary, classifyL3Routine } from '../rom/L3Loader'
import { getAllLevelBgmTracks, readLevelMusicTable } from '../rom/MusicData'
import { buildSpc } from '../rom/SpcBuilder'
import { expandMap } from '../rom/ObjectExpander'
import {
  readL2Pointer,
  isPresetPtr,
  loadL2Preset,
  loadL2Objects,
  readInitialLayer2YPos,
  findLevelScrollSprite,
  findLevelScrollSpriteFull,
  readL2ScrollBounds,
  L2_TILEMAP_COLS,
  L2_TILEMAP_ROWS,
  L1_SCREEN_W,
  L1_SCREEN_H,
} from '../rom/L2Loader'
import { simulateScrollSetup } from '../rom/scrollDispatch'
import { buildMapPayload } from '../rom/model/MapBuilder'
import { EditSession, levelsSharingSprites } from '../EditSession'
import { build } from '../rom/PatchLayer'
import { RomFile } from '../rom/RomFile'
import { SmwRom } from '../rom/SmwRom'

/**
 * The ROM as the editor should show it: base plus the user's edit layers.
 *
 * Returns the base unchanged when there are no edits, so the common path
 * allocates nothing. Layer failures are swallowed to the base rather than
 * thrown: a stale edit must not stop the level from opening.
 */
function patchedRom(base: SmwRom, romPath: string, level: number): SmwRom {
  try {
    const { layers } = EditSession.for(romPath).layersFor(level)
    if (layers.length === 0) return base
    // Buffer.from, not the raw Uint8Array: RomFile.buffer is type-asserted as
    // a Buffer and host-side readers (PaletteLoader, SmwRom) call Buffer-only
    // methods on it. Handing them a Uint8Array throws inside buildMapPayload,
    // whose catch then silently keeps the PREVIOUS model, so tiles updated and
    // sprites did not.
    return new SmwRom(
      RomFile.fromBytes(romPath, Buffer.from(build(new Uint8Array(base.rom.buffer), layers))),
    )
  } catch {
    return base
  }
}

/**
 * Which sprite in the stream the webview means.
 *
 * The webview identifies a sprite by what is on screen (id and tile
 * position), because that is all it has. Resolving that to a stream index
 * happens HERE, against the same patched ROM the webview was rendered from,
 * so the two agree. Returns -1 when the position matches nothing, which
 * happens if the view is stale.
 */
function resolveSpriteIndex(
  rom: SmwRom,
  level: number,
  id: number,
  tileX: number,
  tileY: number,
): number {
  const rawL1 = rom.getLevelRawData(level)
  if (!rawL1) return -1
  const { isVertical } = parseLevelObjects(rawL1)
  const ptr = rom.getLevelSpritePointer(level)
  if (ptr === null) return -1
  const data = rom.rom.readAt(ptr, 0x200)
  if (!data) return -1
  return parseLevelSprites(data, isVertical).findIndex(
    s => s.spriteId === id && s.x === tileX && s.y === tileY,
  )
}

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
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
    }
    panel.webview.html = this._buildHtml(panel.webview)

    panel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'ready') {
        await this._sendLevelData(document.uri, panel.webview, {})
      } else if (
        msg.type === 'nudgeSprite' ||
        msg.type === 'deleteSprite' ||
        msg.type === 'undoEdit'
      ) {
        await this._handleEdit(document.uri, panel.webview, msg)
      } else if (msg.type === 'rerender') {
        await this._sendLevelData(document.uri, panel.webview, {
          bgVariant: msg.bgVariant as number,
          fgVariant: msg.fgVariant as number,
          spriteSet: msg.spriteSet as number,
          spritePalette: msg.spritePalette as number,
          tilesetId: msg.tilesetId as number,
          bgColorVariant: msg.bgColorVariant as number,
          marioVariant: msg.marioVariant as number,
          // New header-bit overrides (Plan A - render overrides). Music /
          // levelMode / itemMemory / verticalScroll have no current render
          // path that honors the override; they're echoed back so the
          // controls keep their selected value across re-renders. Step 3
          // (real ROM writes) will wire visible effects + persistence.
          music: msg.music as number | undefined,
          timeLimit: msg.timeLimit as number | undefined,
          levelMode: msg.levelMode as number | undefined,
          itemMemory: msg.itemMemory as number | undefined,
          verticalScroll: msg.verticalScroll as number | undefined,
          layer3Priority: msg.layer3Priority as boolean | undefined,
          layer3Setting: msg.layer3Setting as number | undefined,
          _initial: false,
        })
      } else if (msg.type === 'requestMusicSpc') {
        const bgmCommand = msg.bgmCommand as number
        try {
          const descriptor = await readDescriptor<{ romPath: string }>(document.uri)
          const activeSession = getActiveRomSession()
          const spcRom =
            activeSession && activeSession.rom.rom.filePath === descriptor.romPath
              ? activeSession.rom
              : resolveRom(descriptor.romPath)
          const spc = buildSpc(spcRom.rom, bgmCommand, 'level')
          panel.webview.postMessage({
            type: 'musicSpc',
            bgmCommand,
            spcData: spc ? Array.from(spc) : null,
          })
        } catch {
          panel.webview.postMessage({ type: 'musicSpc', bgmCommand, spcData: null })
        }
      } else if (msg.type === 'edit') {
        // Future: apply edit to ROM buffer and mark dirty
      }
    })
  }

  /**
   * Apply an edit from the webview, then re-send the level so the editor shows
   * it. The edit is recorded as an OP, not as bytes; layers are re-derived on
   * every render. The ROM file is never written.
   */
  private async _handleEdit(
    uri: vscode.Uri,
    webview: vscode.Webview,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const descriptor = await readDescriptor<{ romPath: string; mapIndex: number }>(uri)
    if (!descriptor) return
    const { romPath, mapIndex } = descriptor
    const edits = EditSession.for(romPath)

    if (msg.type === 'undoEdit') {
      if (!edits.undo()) {
        void vscode.window.showInformationMessage('HackBench: nothing to undo.')
        return
      }
    } else {
      const base = getActiveRomSession()?.rom ?? resolveRom(romPath)
      // Resolve against the SAME patched view the webview was rendered from,
      // otherwise a second nudge would look the sprite up at its old position.
      const rom = patchedRom(base, romPath, mapIndex)
      const index = resolveSpriteIndex(
        rom,
        mapIndex,
        msg.spriteId as number,
        msg.tileX as number,
        msg.tileY as number,
      )
      if (index < 0) {
        // Almost always a stale selection: the sprite was already edited away
        // and the view still holds the old object. Say that, rather than
        // implying the level data is broken.
        void vscode.window.showWarningMessage(
          'HackBench: that sprite is no longer in the level. Click a sprite to select it again.',
        )
        await this._sendLevelData(uri, webview, {})
        return
      }
      // Sprite data is reached by a per-level pointer, and those pointers are
      // not all distinct. Editing shared data changes every level that points
      // at it, so say so before doing it rather than after.
      const alsoAffected = levelsSharingSprites(rom, mapIndex)
      if (alsoAffected.length > 0) {
        const list = alsoAffected
          .slice(0, 6)
          .map(l => `$${l.toString(16).toUpperCase()}`)
          .join(', ')
        const more = alsoAffected.length > 6 ? ` and ${alsoAffected.length - 6} more` : ''
        const choice = await vscode.window.showWarningMessage(
          `This level shares its sprite data with ${alsoAffected.length} other level(s): ${list}${more}. ` +
            'Editing it changes them too.',
          { modal: true },
          'Edit anyway',
        )
        if (choice !== 'Edit anyway') {
          // The webview may have already removed the sprite optimistically.
          // Re-send so a declined edit is visibly declined.
          await this._sendLevelData(uri, webview, {})
          return
        }
      }

      try {
        edits.pushEdit(
          base,
          msg.type === 'deleteSprite'
            ? { kind: 'deleteSprite', level: mapIndex, index }
            : { kind: 'moveSpriteX', level: mapIndex, index, dx: msg.dx as number },
        )
      } catch (err) {
        void vscode.window.showWarningMessage(`HackBench: ${(err as Error).message}`)
        await this._sendLevelData(uri, webview, {})
        return
      }
    }

    await this._sendLevelData(uri, webview, {})
    webview.postMessage({ type: 'editApplied', count: edits.records.length })
  }

  private async _sendLevelData(
    uri: vscode.Uri,
    webview: vscode.Webview,
    overrides: {
      bgVariant?: number
      fgVariant?: number
      spriteSet?: number
      spritePalette?: number
      tilesetId?: number
      bgColorVariant?: number
      marioVariant?: number
      // New header-bit overrides (Plan A - render overrides only).
      music?: number
      timeLimit?: number
      levelMode?: number
      itemMemory?: number
      verticalScroll?: number
      layer3Priority?: boolean
      layer3Setting?: number
      _initial?: boolean
    },
  ): Promise<void> {
    try {
      const descriptor = await readDescriptor<{ romPath: string; mapIndex: number }>(uri)
      const romPath = descriptor.romPath
      const activeSession = getActiveRomSession()
      const session: RomSession | null =
        activeSession && activeSession.rom.rom.filePath === romPath ? activeSession : null
      const baseRom = session?.rom ?? resolveRom(romPath)
      const index = descriptor.mapIndex

      // Render the level the user is actually editing: base ROM plus their
      // edit layers. The ROM FILE is untouched; this is a patched copy held
      // for the duration of this build. Resolving sprite indices against the
      // same patched view is what keeps an index stable across repeated
      // nudges, since a move changes a sprite's x but never its position in
      // the stream.
      const rom = patchedRom(baseRom, romPath, index)

      // ── Parse level ───────────────────────────────────────────────────────
      const rawL1 = rom.getLevelRawData(index)
      if (!rawL1) {
        webview.postMessage({
          type: 'error',
          message: `Map $${index.toString(16).toUpperCase()} has no data`,
        })
        return
      }

      const { header, objects, isVertical } = parseLevelObjects(rawL1)
      const screens = header.levelLength

      const sprPtr = rom.getLevelSpritePointer(index)
      let sprites = parseLevelSprites(Buffer.alloc(1, 0xff), isVertical)
      if (sprPtr) {
        const sprData = rom.rom.readAt(sprPtr, 0x200)
        if (sprData) sprites = parseLevelSprites(sprData, isVertical)
      }

      // ── Build L1 tile grid ────────────────────────────────────────────────
      // Tileset byte from the header selects which dispatch table (CODE_0DA415)
      // and thus which handler set is used. Must be passed so standard-object
      // dispatch reads the correct per-tileset handler pointer table.
      // Vertical levels flip the grid shape to 32 × (screens*16).
      const tileGrid = expandMap(
        objects,
        screens,
        rom.rom,
        header.objectTileset,
        isVertical,
        header.levelMode,
      )

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
            Array.from(
              { length: cols },
              (_, c) => preset.grid[r % L2_TILEMAP_ROWS][c % L2_TILEMAP_COLS],
            ),
          )
        }
      } else if (levelL2Ptr !== 0) {
        const tilesetForL2 = overrides.tilesetId ?? header.objectTileset
        const objL2 = loadL2Objects(rom.rom, levelL2Ptr, screens, tilesetForL2, isVertical)
        if (objL2) l2TileGrid = objL2.grid
      }

      // ── Load ROM rendering data (allow webview overrides) ─────────────────
      const bgVariant = overrides.bgVariant ?? header.bgPalette
      const bgColorVariant = overrides.bgColorVariant ?? header.bgColor
      const romPalettes =
        session?.getRomPalettes(bgColorVariant) ?? loadRomPalettes(rom.rom, bgColorVariant)
      const backAreaColors = session?.getBackAreaColors() ?? loadBackAreaColors(rom.rom)
      const fgVariant = overrides.fgVariant ?? header.fgPalette
      const spriteTileset = overrides.spriteSet ?? header.spriteSet
      const spritePalette = overrides.spritePalette ?? header.spritePalette
      // ObjectTileset is stored directly in header byte 4 bits 3-0 (CODE_0584E3)
      const objectTileset = overrides.tilesetId ?? header.objectTileset

      const marioVariant = overrides.marioVariant ?? 0
      // Map16 / BG counts only - the model owns tile composition. Numbers go
      // into the load payload so the Map16 panel can build its page strip.
      const m16: { tiles: Map16Tile[]; pipeVariants: Map16Tile[][] } =
        session?.getMap16(objectTileset) ?? loadMap16WithPipeVariants(rom.rom, objectTileset)
      const map16 = m16.tiles
      const map16bg = session?.getMap16BG() ?? loadAllMap16BG(rom.rom)

      // Animation timing - just the counters. The model reads VRAM directly
      // via AnimatedPixelsBehavior behaviors, so the webview never sees raw frames.
      let animIntervalMs = ANIM_INTERVAL_MS
      let animFrameCount = 1
      try {
        const animData =
          session?.getAnimationData(objectTileset) ?? loadAnimationData(rom.rom, objectTileset)
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
      // (bank_00.asm:13735-13749 - px-wise shifts 0, 1, 5 for the non-zero
      // settings). The 1/32 rate is why vanilla mode-10 vertical levels never
      // expose the $25 padding strip in-game: BG scrolls so slowly that the
      // 32-row wrap is never reached within the level's height.
      const scrollByte = rom.rom.readByte(0x05f000 + index) ?? 0
      const scrollIndex = (scrollByte >> 4) & 0x0f
      const vertLayer2Setting = rom.rom.readByte(0x05d710 + scrollIndex) ?? 0
      const horizLayer2Setting = rom.rom.readByte(0x05d720 + scrollIndex) ?? 0
      // Initial camera Y - see readInitialLayer1YPos in L3Loader.ts. Seeds
      // the camera viewport so sublevels (accessed only via pipes/doors) show
      // the player's actual starting viewport.
      const initialCameraYPx = readInitialLayer1YPos(rom.rom, index, isVertical)
      // Initial Layer2YPos (BG2VOFS). Populated for ALL levels - the
      // Layer 2 tab's Y-scrubber slider seeds from this. Only meaningful
      // for object-stream L2; preset-BG levels won't show the slider.
      const initialLayer2YPx = readInitialLayer2YPos(rom.rom, index, false) & 0xff
      // L1 scroll-sprite cmd byte (spriteId - $E7), or null when no scroll
      // sprite. Drives the Layer 2 Y-scrubber slider's min/max so the user
      // can only drag through the Y range that's actually reachable for this
      // cmd's motion. See findLevelScrollSprite in L2Loader.ts.
      const layer1ScrollCmd = findLevelScrollSprite(sprites)
      // Compute the post-setup Layer2ScrollCmd by simulating the bank_05
      // L1 setup dispatch (CODE_05BCD6). The L1 setup routine for many
      // cmds 16-bit-STAs Layer1ScrollCmd, which writes the cmd's high byte
      // to Layer2ScrollCmd at $143F. Without this simulation we'd derive
      // bounds from L1's cmd, which is wrong for cmds like $0C (L1 $0C
      // → L2 $00, no motion despite a scroll sprite being present).
      let layer2ScrollCmd: number | null = null
      const scrollSpriteFull = findLevelScrollSpriteFull(sprites)
      if (scrollSpriteFull) {
        const setupState = simulateScrollSetup(
          rom.rom,
          scrollSpriteFull.spriteId,
          scrollSpriteFull.b0,
        )
        if (setupState) layer2ScrollCmd = setupState.layer2ScrollCmd
      }
      // Bounds for the Layer 2 Y slider, read from the ROM tables the
      // post-setup L2 cmd's per-frame routine compares against. null when
      // the cmd has no Y motion or its bounds source is undecoded -
      // webview falls back to a zero-range slider locked at initialLayer2YPx.
      const layer2ScrollBounds = readL2ScrollBounds(rom.rom, layer2ScrollCmd)

      // Walk the per-frame scroll simulator (when the level has a scroll
      // Scroll-sim seed: the host's job is to *identify* the scroll
      // sprite + run the cmd-byte remap. Computing the per-frame
      // scroll path / layer2YRange / column-dy ranges is the
      // webview's job now (it has the same simulator + ROM bytes
      // from the message). Keeps host work to "pure data" and
      // moves visualization-derived state to the rendering layer.
      let scrollSimSeed: import('../rom/scrollSim').ScrollSimSeed | null = null
      if (scrollSpriteFull) {
        const setupState = simulateScrollSetup(
          rom.rom,
          scrollSpriteFull.spriteId,
          scrollSpriteFull.b0,
        )
        if (setupState) {
          scrollSimSeed = {
            layer1XPos: 0,
            layer1YPos: initialCameraYPx,
            layer2XPos: 0,
            layer2YPos: initialLayer2YPx,
            layer1ScrollCmd: setupState.layer1ScrollCmd,
            layer2ScrollCmd: setupState.layer2ScrollCmd,
            layer1ScrollBits: setupState.layer1ScrollBits,
            layer2ScrollBits: setupState.layer2ScrollBits,
            horizLayer2Setting,
            vertLayer2Setting,
            // Mario spawn isn't read at this code site (legacy load
            // payload). The model payload's MapBuilder seeds it from
            // the parsed L1 header - webview overrides if needed.
            marioSpawnX: 0,
            marioSpawnY: 0,
            screenMode: header.levelMode,
          }
        }
      }

      // L3 routine summary - pure metadata (no stripe parsing). Read against
      // the live tileset override so the routine kind reflects what the
      // editor is actually rendering, not just the header default. When
      // layer3Setting is overridden, recompute via classifyL3Routine so the
      // $009F88 byte / kind / init Y display values match the override.
      let l3Routine = readL3RoutineSummary(rom.rom, index, objectTileset)
      if (
        overrides.layer3Setting !== undefined &&
        overrides.layer3Setting !== l3Routine.layer3Setting
      ) {
        const setting = overrides.layer3Setting
        const settingsByte =
          setting === 0
            ? null
            : (rom.rom.readByte(0x009f88 + objectTileset * 3 + (setting - 1)) ?? null)
        l3Routine = classifyL3Routine({
          layer3Setting: setting,
          settingsByte,
          tileset: objectTileset,
        })
      }

      // Header-bit overrides (Plan A - render overrides only). Echoed into
      // the header payload so the controls keep their selected value across
      // re-renders. Step 3 (real ROM writes) will turn these into byte-level
      // mutations of the L1 header.
      const musicEff = overrides.music ?? header.music
      const allBgmTracks = getAllLevelBgmTracks(rom.rom)
      // After a rerender, overrides.music is already a bgmCommand (the webview
      // sends the selected option value, which is a bgmCommand). On initial load
      // (no override) look it up from the 3-bit header index via the level music table.
      const currentBgmCommand =
        overrides.music !== undefined
          ? overrides.music
          : (readLevelMusicTable(rom.rom).find(e => e.index === musicEff)?.bgmCommand ??
            allBgmTracks[0]?.bgmCommand ??
            1)
      const spcRaw = buildSpc(rom.rom, currentBgmCommand, 'level')
      const spcData = spcRaw ? Array.from(spcRaw) : null

      const timeLimitEff = overrides.timeLimit ?? header.timeLimit
      const levelModeEff = overrides.levelMode ?? header.levelMode
      const itemMemoryEff = overrides.itemMemory ?? header.itemMemory
      const verticalScrollEff = overrides.verticalScroll ?? header.verticalScroll
      const layer3PriorityEff = overrides.layer3Priority ?? header.layer3Priority

      // Palette-animation raw - the model owns the frame cycle; the
      // legacy load payload only needs the timer's frameCount / intervalMs.
      // `??` would treat the session's correctly cached null as a miss and
      // re-scan the whole cart on every open of a cart that has no animation.
      const palAnimRaw = session
        ? session.getPaletteAnim('level')
        : loadPaletteAnimData(rom.rom, 'level')
      const palAnimSerialized = palAnimRaw ? serializePaletteAnimData(palAnimRaw) : null
      const palAnimNotes = explainPaletteAnimation(rom.rom, 'level')
      // ROM bytes: shipped once per load message so the webview can
      // (a) reconstruct a `RomFile` for `buildScrollSimulator` (every
      // scroll handler reads data tables directly from ROM), and
      // (b) derive scrollPath / layer2YRange / columnDyRanges from
      // its own simulator. Single transfer; the modelPayload reuses
      // it via the cached webview-side rom rather than re-shipping.
      const romBytesForWebview = new Uint8Array(rom.rom.buffer)
      webview.postMessage({
        type: 'load',
        romBytes: romBytesForWebview,
        _initial: overrides._initial !== false,
        allBgmTracks,
        currentBgmCommand,
        spcData,
        mapIndex: index,
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
        // L2/BG Map16 defs (same shape as map16Defs) - webview recomposites live.
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
        paletteAnimationNotes: palAnimNotes,
        backAreaColor: romPalettes.backAreaColor,
        backAreaColors: backAreaColors.map(c => [c[0], c[1], c[2], c[3]]),
        sprites: sprites.map(s => ({ x: s.x, y: s.y, spriteId: s.spriteId })),
        // Truthy when the level has a scroll sprite - the webview's
        // Layer 2 slider switches from raw `Layer2YPos` scrubbing to
        // SCROLL FRAME scrubbing (the model rebuilds a `ScrollSimulator`
        // and `L2ObjectStream.render` reads `mapStore.scrollSimulator`).
        // Scroll-sim seed (when a scroll sprite is present on this
        // level). Webview rebuilds the simulator from this + the ROM
        // bytes shipped below, then derives layer2YRange / scrollPath
        // / columnDyRanges itself. `null` for non-scroll-sprite levels.
        scrollSim: scrollSimSeed,
        header: {
          music: musicEff,
          spriteSet: spriteTileset,
          bgPalette: bgVariant,
          fgPalette: fgVariant,
          bgColor: bgColorVariant,
          spritePalette,
          marioVariant,
          gfxTilesetId: objectTileset,
          vertLayer2Setting,
          horizLayer2Setting,
          initialCameraYPx,
          initialLayer2YPx,
          layer1ScrollCmd,
          layer2ScrollCmd,
          layer2ScrollBounds,
          // layer2YRange / columnDyRanges / scrollPath used to be
          // pre-computed here. Moved to webview load handler - see
          // `deriveScrollData()`. Host now ships only the seed, and
          // the visualization layer derives from the simulator it
          // already owns. Issue: "host = data, webview = view".
          // Header-bit fields surfaced for the Level Settings panel. Each
          // honors a render override from the rerender pipeline (Plan A); the
          // override is purely UI-state today and gets persisted as a real
          // ROM byte write when step 3 lands.
          levelLength: header.levelLength,
          levelMode: levelModeEff,
          timeLimit: timeLimitEff,
          itemMemory: itemMemoryEff,
          verticalScroll: verticalScrollEff,
          layer3Priority: layer3PriorityEff,
          isVertical,
        },
        l3Routine: {
          layer3Setting: l3Routine.layer3Setting,
          settingsByte: l3Routine.settingsByte,
          kind: l3Routine.kind,
          initialYPx: l3Routine.initialYPx,
          isTideUpAndDown: l3Routine.isTideUpAndDown,
        },
      })
      // Ship the self-rendering model payload alongside the legacy atlas
      // data. Toolbar dropdown overrides go in too so the model rebuilds
      // with the same effective palette/tileset/sprite set the legacy
      // path uses - otherwise dropdown changes wouldn't affect anything
      // the model renders.
      try {
        const modelPayload = buildMapPayload(rom, index, {
          bgPalette: bgVariant,
          fgPalette: fgVariant,
          bgColor: bgColorVariant,
          spritePalette,
          spriteSet: spriteTileset,
          objectTileset,
          marioVariant,
        })
        // ROM bytes for the modelPayload's simulator are shipped in
        // the 'load' message above (one transfer per level load).
        // The webview caches them in `cachedRom` and pulls from
        // there during rehydrate.
        webview.postMessage({ type: 'modelPayload', payload: modelPayload })
      } catch (modelErr) {
        // Non-fatal: legacy render keeps working if the model build trips.
        console.error('[MapEditorProvider] model payload build failed:', modelErr)
      }
    } catch (err) {
      postWebviewError(webview, err)
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    const ext = this.context.extensionUri
    const scriptUri = getWebviewUri(webview, ext, 'mapEditor.js')
    const codiconUri = getWebviewUri(webview, ext, 'codicon.css')
    const spcJsUri = getWebviewUri(webview, ext, 'spc.js')
    const wasmUri = getWebviewUri(webview, ext, 'spc.wasm')
    const nonce = getNonce()
    return /* html */ `<!DOCTYPE html>
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
  <link rel="stylesheet" href="${codiconUri}" />
  <style>html,body{height:100%;margin:0;padding:0;overflow:hidden;}#app{height:100%;}</style>
</head>
<body>
  <div id="app"></div>
${SPC_PLAYER_STUB_DOM}
${buildSpcInitScript(nonce, wasmUri)}
  <script nonce="${nonce}" src="${spcJsUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}
