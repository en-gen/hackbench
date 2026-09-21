import * as vscode from 'vscode'
import { Patch, PatchLayer, flatten } from '../rom/PatchLayer'
import { EditSession } from '../EditSession'
import * as fs from 'fs'
import * as path from 'path'
import { getActiveRomSession } from '../RomSession'
import { getNonce, readDescriptor } from './webviewUtils'

// bank_05.asm:7216-7227. Inverts CODE_05D8A2's override-byte decode; the
// reachable set is [$001,$0DB] union [$101,$1DB].
function encodeOverride(levelId: number): { overrideByte: number; submapFlag: number } | null {
  if (!Number.isInteger(levelId) || levelId < 0 || levelId > 0x1ff) return null
  const submapFlag = levelId >= 0x100 ? 1 : 0
  const lowByte = levelId & 0xff
  if (lowByte === 0 || lowByte > 0xdb) return null
  const overrideByte = lowByte < 0x25 ? lowByte : lowByte + 0x24
  return { overrideByte, submapFlag }
}

// bank_00.asm:2626-2632, file offset 0x16CB. The LDA/LDY immediates that
// force-load the title-screen background level; overwriting them redirects
// that same boot-time mechanism at our chosen level instead.
const LEVEL_LOAD_PATCH = { ldaImm: 0x16cc, ldyImm: 0x16ce, checkFrom: 0x16cb }

function levelLoadPatches(rom: Buffer, levelId: number): Patch[] {
  const enc = encodeOverride(levelId)
  if (!enc) throw new Error(`level $${levelId.toString(16)} is unreachable via OverworldOverride`)
  const b = rom.subarray(LEVEL_LOAD_PATCH.checkFrom, LEVEL_LOAD_PATCH.checkFrom + 7)
  const siteOk = b[0] === 0xa9 && b[1] === 0xeb && b[2] === 0xa0 && b[3] === 0x00
    && b[4] === 0x8d && b[5] === 0x09 && b[6] === 0x01
  if (!siteOk) throw new Error('level-load patch site does not match expected bytes; refusing to patch')
  return [
    { offset: LEVEL_LOAD_PATCH.ldaImm, value: enc.overrideByte },
    { offset: LEVEL_LOAD_PATCH.ldyImm, value: enc.submapFlag },
  ]
}

// bank_00.asm:3323 TitleScreenInputSeq -- 34 (input,duration) pairs then an
// $FF terminator at 0x1C63. Summing the 34 duration bytes (odd offsets)
// gives 1426 -- confirmed directly against the ROM -- so the demo, and the
// level it's showing, ends around frame 1426 regardless of input. A
// screenshot taken past that has moved on to FadeOutBackToTitle
// (bank_00.asm:3359-3365), not the level under test.
const INPUT_TABLE = { start: 0x1c1f, count: 34, stride: 2, terminator: 0x1c63 }

function inputTableSiteOk(rom: Buffer): boolean {
  const sig = [0x41, 0x0f, 0xc1, 0x30, 0x00, 0x10, 0x42, 0x20]
  const b = rom.subarray(INPUT_TABLE.start, INPUT_TABLE.start + 8)
  return sig.every((v, i) => b[i] === v) && rom[INPUT_TABLE.terminator] === 0xff
}

/** Zeroes the even-offset input bytes: demo plays no buttons, Mario stands still. */
function demoFreezePatches(rom: Buffer): Patch[] {
  if (!inputTableSiteOk(rom)) {
    console.warn('[emulatorPreview] input freeze site mismatch, demo will keep animating')
    return []
  }
  const patches: Patch[] = []
  for (let i = 0; i < INPUT_TABLE.count; i++) {
    patches.push({ offset: INPUT_TABLE.start + i * INPUT_TABLE.stride, value: 0 })
  }
  return patches
}

/**
 * Stretches the odd-offset duration bytes to $FF each, extending the demo
 * from ~1426 frames to ~34*255 while the terminator (and hence the eventual
 * fade back to the title screen) stays intact. Only useful combined with
 * the freeze above; makes Task B's pause window comfortable to measure
 * instead of racing a ~24-second demo clock.
 */
function demoExtendPatches(rom: Buffer): Patch[] {
  if (!inputTableSiteOk(rom)) return []
  const patches: Patch[] = []
  for (let i = 0; i < INPUT_TABLE.count; i++) {
    patches.push({ offset: INPUT_TABLE.start + i * INPUT_TABLE.stride + 1, value: 0xff })
  }
  return patches
}

// Layer1Ptrs[$105] at SNES $05E30F -> DD 88 06 -> SNES $06:88DD -> file
// 0x308DD (bank_05.asm:7235-7256; pointer bytes and object-stream start
// verified directly against the ROM file). HEADER_SIZE=5
// (LevelParser.ts:132, CODE_0584E3:645-651) puts the first object byte at
// 0x308DD+5 = 0x308E2, so $FF there truncates the L1 object stream --
// answers whether pre-boot patching reaches bank $05/$06 data at all.
const TRUNCATE_L1_PATCH: Patch = { offset: 0x308e2, value: 0xff }

// Mario spawn X table, file offset 0x2F305 (independently verified: vanilla
// byte is 0x00 for level $105). Low 3 bits only; bits 3-7 preserved.
function spawnXPatch(rom: Buffer): Patch {
  return { offset: 0x2f305, value: (rom[0x2f305] & 0xf8) | 0x05 }
}

/**
 * T12 spike escape hatch (libretro-view-engine, task A). Read from a file
 * next to the ROM rather than an env var, so test/e2e/emulatorPreview.spec.ts
 * can reuse one VS Code launch across every case: env vars are fixed for
 * the process's lifetime, but this is re-read on every `open()` call, and
 * each call already gets a fresh panel/webview/core regardless. Absent
 * (normal F5 use) behaves like the pre-existing mechanism: level-load
 * override + demo freeze, no extras.
 */
function readScenario(romPath: string): string | undefined {
  try {
    return fs.readFileSync(path.join(path.dirname(romPath), '.hackbench-e2e-scenario'), 'utf8').trim()
  } catch {
    return process.env['HACKBENCH_E2E_PATCH_SCENARIO']
  }
}

function scenarioPatches(rom: Buffer, scenario: string | undefined): { freeze: boolean; extend: boolean; extra: Patch[] } {
  switch (scenario) {
    case 'baseline': return { freeze: false, extend: false, extra: [] }
    case 'truncate-l1': return { freeze: true, extend: false, extra: [TRUNCATE_L1_PATCH] }
    case 'truncate-l1-no-freeze': return { freeze: false, extend: false, extra: [TRUNCATE_L1_PATCH] }
    case 'spawn-x': return { freeze: true, extend: false, extra: [spawnXPatch(rom)] }
    case 'spawn-x-no-freeze': return { freeze: false, extend: false, extra: [spawnXPatch(rom)] }
    case 'pause-test': return { freeze: true, extend: true, extra: [] }
    // 'edit-layer' and 'edit-layer-undone' are handled by the caller, which
    // has the SmwRom needed to locate the object being moved.
    case 'edit-layer': return { freeze: true, extend: false, extra: [] }
    case 'edit-layer-undone': return { freeze: true, extend: false, extra: [] }
    default: return { freeze: true, extend: false, extra: [] } // 'positive-control' and unset (F5)
  }
}

/**
 * Spike provider (see CLAUDE.md, libretro-view-engine spike). Opens a
 * webview panel that boots the snes9x-wasm libretro core and force-loads one
 * SMW level via the OverworldOverride ROM patch (bank_05.asm:7216-7227) --
 * the same mechanism the ROM itself uses at boot to draw its title-screen
 * background level. There is no WRAM access in this JS-heap environment;
 * every state change is a verified ROM byte write.
 *
 * Task A (this spike's project-deciding question): all patches are now
 * computed here and applied by the webview to the plain ROM byte array
 * BEFORE the core's first read, not to Module.HEAPU8 after callMain the way
 * t9's original version did. See main.ts's top comment.
 *
 * Not a CustomEditorProvider: this has no backing document, just a command
 * that opens a panel against whatever ROM is currently loaded.
 *
 * Message protocol:
 *   Extension -> Webview: { type:'load', romBytes, wasmUri, levelId, patches }
 *   Webview -> Extension: { type:'ready' } | { type:'error', message }
 */

/**
 * What a cached open needs: the machine state, plus where WRAM lived when it
 * was taken.
 *
 * The state alone is not enough to skip the boot. Restoring it puts the console
 * at the black screen instantly, but the webview still has to know where WRAM
 * is before it can write the level override, and finding WRAM means planting a
 * signature and running ~90 frames of a live console -- which is the boot
 * sequence, back on screen. Caching the base too is what makes the restored
 * path actually boot-free.
 */
interface CachedState {
  state: Uint8Array
  wramBase: number
}

/** 'HBST', version, wramBase, then the state bytes. */
const CACHE_MAGIC = 0x48425354
const CACHE_VERSION = 3
const CACHE_HEADER_LEN = 12

function encodeCachedState(c: CachedState): Uint8Array {
  const out = new Uint8Array(CACHE_HEADER_LEN + c.state.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, CACHE_MAGIC)
  view.setUint32(4, CACHE_VERSION)
  view.setUint32(8, c.wramBase)
  out.set(c.state, CACHE_HEADER_LEN)
  return out
}

/**
 * Returns undefined for anything this build does not recognise, which covers
 * both a cache written by an older build (no header at all) and a future one.
 * A misread header would hand the webview a wrong WRAM base, so failing to
 * decode has to mean "boot again", never "guess".
 */
function decodeCachedState(bytes: Uint8Array): CachedState | undefined {
  if (bytes.length <= CACHE_HEADER_LEN) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0) !== CACHE_MAGIC || view.getUint32(4) !== CACHE_VERSION) return undefined
  return { wramBase: view.getUint32(8), state: bytes.slice(CACHE_HEADER_LEN) }
}

export class EmulatorPreviewProvider {
  /**
   * Title-screen machine states, one per ROM, shared across every panel this
   * window opens. Static because each open() builds a fresh provider, and the
   * whole value is that the second open does not repeat the boot sequence.
   */
  private static titleState = new Map<string, CachedState>()

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Where the title-screen savestate lives, keyed by the ROM it was taken from.
   * A state restored against a different ROM would be meaningless, so the key
   * is a cheap content hash rather than a fixed filename.
   */
  private stateUri(rom: Uint8Array): vscode.Uri {
    let h = 0x811c9dc5
    for (let i = 0; i < rom.length; i += 4099) {
      h = Math.imul(h ^ rom[i], 0x01000193) >>> 0
    }
    const key = (h >>> 0).toString(16).padStart(8, '0') + '-' + rom.length
    return vscode.Uri.joinPath(this.context.globalStorageUri, `titlestate-${key}.bin`)
  }

  private async readCachedState(uri: vscode.Uri): Promise<CachedState | undefined> {
    try {
      return decodeCachedState(await vscode.workspace.fs.readFile(uri))
    } catch {
      return undefined // nothing cached yet, or storage unavailable
    }
  }

  private async writeCachedState(uri: vscode.Uri, cached: CachedState): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.context.globalStorageUri)
      await vscode.workspace.fs.writeFile(uri, encodeCachedState(cached))
    } catch (err) {
      // Non-fatal: without a cache every open just repeats the boot sequence.
      console.warn('[hackbench] could not cache title state', err)
    }
  }

  async open(levelIdArg?: number): Promise<void> {
    const session = getActiveRomSession()
    if (!session) {
      vscode.window.showErrorMessage('HackBench: open a ROM before previewing a level in the emulator.')
      return
    }

    const levelId = levelIdArg ?? (await this._activeMapLevelId(session.rom.rom.filePath)) ?? 0x105

    const panel = vscode.window.createWebviewPanel(
      'hackbench.emulatorPreview',
      `Emulator Preview: $${levelId.toString(16).toUpperCase()}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
          vscode.Uri.joinPath(this.context.extensionUri, 'vendor', 'cores', 'snes9x-wasm'),
        ],
      },
    )

    const coreDir = vscode.Uri.joinPath(this.context.extensionUri, 'vendor', 'cores', 'snes9x-wasm')
    const coreJsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(coreDir, 'snes9x_libretro.js'))
    const coreWasmUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(coreDir, 'snes9x_libretro.wasm'))
    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'emulatorPreview.js'),
    )

    panel.webview.html = this._buildHtml(panel.webview, coreJsUri, scriptUri)

    let patches: Patch[]
    try {
      const scenario = readScenario(session.rom.rom.filePath)
      const { freeze, extend, extra } = scenarioPatches(session.rom.rom.buffer, scenario)
      // Ordered layers, later winning, rather than one flat list. The base
      // ROM is never mutated, which is what keeps the cached machine state
      // (keyed on ROM content) valid across edits.
      const layers: PatchLayer[] = [
        { id: 'level-load', label: `force-load $${levelId.toString(16)}`, scope: 'preview',
          patches: levelLoadPatches(session.rom.rom.buffer, levelId) },
      ]
      if (freeze) layers.push({ id: 'demo-freeze', label: 'freeze demo input', scope: 'preview', patches: demoFreezePatches(session.rom.rom.buffer) })
      if (extend) layers.push({ id: 'demo-extend', label: 'extend demo', scope: 'preview', patches: demoExtendPatches(session.rom.rom.buffer) })
      if (extra.length) layers.push({ id: 'scenario', label: scenario ?? 'scenario', scope: 'preview', patches: extra })

      // The user's own edits, derived from their op list against this ROM.
      // Last, so they win over anything the preview set up for its own
      // convenience.
      const edits = EditSession.for(session.rom.rom.filePath).layersFor(levelId)
      layers.push(...edits.layers)
      if (edits.skipped.length) {
        vscode.window.showWarningMessage(
          `HackBench: ${edits.skipped.length} layer file(s) could not be read and were skipped. ${edits.skipped[0]}`,
        )
      }

      patches = flatten(layers)
    } catch (err) {
      vscode.window.showErrorMessage(`HackBench emulator preview: ${(err as Error).message}`)
      return
    }

    // Read the cached title state up front: the message handler below is
    // synchronous, and the whole point is to have it ready on the first 'ready'.
    const stateUri = this.stateUri(new Uint8Array(session.rom.rom.buffer))
    // Keyed by the state's own URI, which already carries the ROM content hash.
    // An unkeyed cache would hand a second ROM the first one's machine state.
    const cacheKey = stateUri.toString()
    const cached = EmulatorPreviewProvider.titleState.get(cacheKey)
      ?? await this.readCachedState(stateUri)

    panel.webview.onDidReceiveMessage((msg: {
      type: string
      message?: string
      state?: Uint8Array
      wramBase?: number
    }) => {
      if (msg.type === 'ready') {
        panel.webview.postMessage({
          type: 'load',
          // Sent as a live Uint8Array, not Array.from() -- postMessage structured-
          // clones typed arrays directly, same as MapEditorProvider's romBytes.
          romBytes: new Uint8Array(session.rom.rom.buffer),
          wasmUri: coreWasmUri.toString(),
          levelId,
          patches,
          // A savestate captured at the title screen on a previous open, if we
          // have one. Restoring it skips the whole boot sequence (the Nintendo
          // Presents logo and the title fade, roughly 230 emulated frames)
          // because the one-time Layer 3 graphics uploads GM00/GM01 perform are
          // already baked into the state.
          machineState: cached?.state,
          // The heap offset WRAM sat at when the state was taken. The webview
          // re-verifies it before trusting it. Without it the webview has to
          // search for WRAM, and searching costs the ~90 live frames of boot
          // that the state exists to skip.
          wramBase: cached?.wramBase,
        })
      } else if (msg.type === 'machineState' && msg.state && msg.wramBase !== undefined) {
        const next: CachedState = { state: msg.state, wramBase: msg.wramBase }
        EmulatorPreviewProvider.titleState.set(cacheKey, next)
        void this.writeCachedState(stateUri, next)
      } else if (msg.type === 'error') {
        vscode.window.showErrorMessage(`HackBench emulator preview: ${msg.message}`)
      }
    })
  }

  /**
   * Reads mapIndex from the active .smwmap document, if one is focused and
   * open against the same ROM. Additive: reads MapEditorProvider's virtual
   * file through the public smwrom:// filesystem, does not touch the
   * provider itself.
   */
  private async _activeMapLevelId(romPath: string): Promise<number | undefined> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!tab.isActive || !(tab.input instanceof vscode.TabInputCustom)) continue
        if (tab.input.viewType !== 'hackbench.mapEditor') continue
        try {
          const descriptor = await readDescriptor<{ romPath: string; mapIndex: number }>(tab.input.uri)
          if (descriptor.romPath === romPath) return descriptor.mapIndex
        } catch {
          // No usable descriptor -- fall through to the caller's default.
        }
      }
    }
    return undefined
  }

  private _buildHtml(webview: vscode.Webview, coreJsUri: vscode.Uri, scriptUri: vscode.Uri): string {
    const nonce = getNonce()
    // wasm-unsafe-eval + unsafe-eval: same combination MapEditorProvider
    // already ships for spc.wasm. connect-src needs webview.cspSource
    // because Emscripten fetches the .wasm itself via locateFile's URI.
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}' 'wasm-unsafe-eval' 'unsafe-eval';
             connect-src ${webview.cspSource};
             style-src 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SMW Emulator Preview</title>
</head>
<body style="margin:0;background:#1e1e1e;color:#ccc;font-family:sans-serif;">
  <!-- The curtain COVERS the canvas rather than hiding it. The core sizes its
       own backing store from the canvas's CSS box, so display:none would
       collapse that box to zero and break the GL surface. -->
  <div id="stage" style="position:relative;display:block;width:max-content;margin:12px auto;">
    <canvas id="canvas" width="256" height="224"
      style="width:512px;height:448px;image-rendering:pixelated;background:#000;display:block;"></canvas>
    <div id="curtain" style="position:absolute;inset:0;background:#000;color:#8a8a8a;
      display:flex;align-items:center;justify-content:center;font-size:13px;letter-spacing:.06em;">initializing&hellip;</div>
  </div>
  <div id="status" style="text-align:center;font-size:12px;">booting&hellip;</div>
  <script nonce="${nonce}" src="${coreJsUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}
