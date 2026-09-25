/**
 * The user's edit layers: real patch files on disk, stacked onto the base ROM.
 *
 * Each edit writes ONE IPS file. Those files are the layers, in the Docker
 * image sense: the base ROM is never modified, layers apply in order, and
 * dropping the top one rebuilds the state before it. An IPS applies with any
 * patcher, so a layer does not need HackBench to be useful.
 *
 * WHY THE LAYER IS FROZEN AT EDIT TIME
 *
 * A layer is computed once, against the ROM as it stood when the edit was
 * made, and then stored as bytes. Deriving them all from the base ROM instead
 * is wrong, and subtly: two "move this sprite one tile right" edits would each
 * compute the same destination from the same starting position, and flattening
 * them would move the sprite one tile, not two. Freezing at edit time makes
 * the stack mean what it looks like it means.
 *
 * The cost is that a layer is bytes, so it is ROM-derived output and the
 * directory holding it is gitignored. The op that produced it is recorded in
 * the manifest as provenance, so a layer can still be explained and, when the
 * base ROM changes underneath, re-derived.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { EditOp } from './rom/EditStack'
import { PatchLayer, build } from './rom/PatchLayer'
import { encodeIps, decodeIps } from './rom/Ips'
import { deleteSprite, moveObjectX, moveSpriteX } from './rom/LevelEdits'
import { SmwRom } from './rom/SmwRom'
import { RomFile } from './rom/RomFile'
import { isLevelModeVertical, parseLevelHeader } from './rom/LevelParser'

/** Where a ROM's layers live: a directory beside it, named after it. */
export function layerDir(romPath: string): string {
  return `${romPath}.hackbench`
}

function manifestPath(romPath: string): string {
  return path.join(layerDir(romPath), 'layers.json')
}

/** One entry per layer file, in application order. */
export interface LayerRecord {
  file: string
  id: string
  label: string
  level: number
  /** What the user did. Provenance, and enough to re-derive if the base moves. */
  op: EditOp
}

interface Manifest {
  version: 1
  layers: LayerRecord[]
}

export class EditSession {
  private manifest: Manifest = { version: 1, layers: [] }
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChange = this.emitter.event

  private constructor(readonly romPath: string) {}

  private static sessions = new Map<string, EditSession>()

  static for(romPath: string): EditSession {
    let s = EditSession.sessions.get(romPath)
    if (!s) {
      s = new EditSession(romPath)
      s.load()
      EditSession.sessions.set(romPath, s)
    }
    return s
  }

  get records(): readonly LayerRecord[] {
    return this.manifest.layers
  }

  private load(): void {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(manifestPath(this.romPath), 'utf8'))
      const m = raw as Partial<Manifest>
      if (m.version === 1 && Array.isArray(m.layers)) {
        this.manifest = { version: 1, layers: m.layers }
        return
      }
      vscode.window.showWarningMessage(
        `HackBench: ${manifestPath(this.romPath)} is not a layer manifest this build understands; ` +
          'starting with no layers. The file has been left alone.',
      )
    } catch {
      // No layers yet. Normal for a ROM that has never been edited.
    }
  }

  private saveManifest(): void {
    fs.mkdirSync(layerDir(this.romPath), { recursive: true })
    fs.writeFileSync(
      manifestPath(this.romPath),
      JSON.stringify(this.manifest, null, 2) + '\n',
      'utf8',
    )
  }

  /**
   * Every layer, read back from its patch file.
   *
   * A layer whose file is missing or corrupt is SKIPPED rather than throwing:
   * one bad file must not stop the rest of a user's work from loading. It is
   * reported so the gap is visible instead of silent.
   */
  layers(): { layers: PatchLayer[]; skipped: string[] } {
    const layers: PatchLayer[] = []
    const skipped: string[] = []
    for (const rec of this.manifest.layers) {
      try {
        const patches = decodeIps(fs.readFileSync(path.join(layerDir(this.romPath), rec.file)))
        if (!patches) {
          skipped.push(`${rec.file}: not a readable IPS`)
          continue
        }
        layers.push({ id: rec.id, label: rec.label, scope: 'edit', patches })
      } catch (err) {
        skipped.push(`${rec.file}: ${(err as Error).message}`)
      }
    }
    return { layers, skipped }
  }

  /** The layers touching one level, for rendering just that map. */
  layersFor(level: number): { layers: PatchLayer[]; skipped: string[] } {
    const all = this.layers()
    const keep = new Set(this.manifest.layers.filter(r => r.level === level).map(r => r.id))
    return { layers: all.layers.filter(l => keep.has(l.id)), skipped: all.skipped }
  }

  /** The base ROM with every layer applied: what the editor and emulator show. */
  patchedBytes(base: Uint8Array): Uint8Array {
    return build(base, this.layers().layers)
  }

  /**
   * Record an edit: compute its patch against the CURRENT state, write it as
   * an IPS file, and append it to the manifest.
   */
  pushEdit(baseRom: SmwRom, op: EditOp): void {
    // Buffer.from: host-side readers call Buffer-only methods on RomFile.buffer.
    const current = new SmwRom(
      RomFile.fromBytes(
        this.romPath,
        Buffer.from(this.patchedBytes(new Uint8Array(baseRom.rom.buffer))),
      ),
    )
    const seq = this.manifest.layers.length + 1
    const layer = deriveLayer(current, op, `layer-${seq}`)

    const file = `${String(seq).padStart(4, '0')}-${op.kind}.ips`
    fs.mkdirSync(layerDir(this.romPath), { recursive: true })
    fs.writeFileSync(path.join(layerDir(this.romPath), file), encodeIps(layer.patches))

    this.manifest.layers.push({ file, id: layer.id, label: layer.label, level: op.level, op })
    this.saveManifest()
    this.emitter.fire()
  }

  /** Undo: drop the top layer and delete its file. */
  undo(): LayerRecord | undefined {
    const rec = this.manifest.layers.pop()
    if (!rec) return undefined
    try {
      fs.unlinkSync(path.join(layerDir(this.romPath), rec.file))
    } catch {
      // Already gone. The manifest is the source of truth for what applies.
    }
    this.saveManifest()
    this.emitter.fire()
    return rec
  }
}

/** Turn one op into a layer by reading the ROM it applies to. */
function deriveLayer(smw: SmwRom, op: EditOp, id: string): PatchLayer {
  const verticalTable = smw.requireVerticalTable()

  if (op.kind === 'moveObjectX') {
    const raw = smw.getLevelRawData(op.level)
    const ptr = smw.getLevelL1Pointer(op.level)
    const off = ptr === null ? null : smw.rom.fileOffsetOf(ptr)
    if (!raw || off === null) throw new Error(`level $${op.level.toString(16)} has no Layer 1 data`)
    return moveObjectX(raw, off, op.index, op.dx, verticalTable, id)
  }

  const ptr = smw.getLevelSpritePointer(op.level)
  const off = ptr === null ? null : smw.rom.fileOffsetOf(ptr)
  const raw = ptr === null ? null : smw.rom.readAt(ptr, 0x200)
  if (!raw || off === null) throw new Error(`level $${op.level.toString(16)} has no sprite data`)
  const vertical = isLevelVertical(smw, op.level, verticalTable)
  return op.kind === 'deleteSprite'
    ? deleteSprite(raw, off, op.index, vertical, id)
    : moveSpriteX(raw, off, op.index, op.dx, vertical, id)
}

/**
 * Other levels that would be changed by editing this level's sprites.
 *
 * Sprite data is reached through a per-level pointer, but those pointers are
 * NOT all distinct: in the vanilla cart 27 of them are shared by more than one
 * level that has real Layer 1 data, and one is shared by eight ($7C3F0 serves
 * $C6, $CB, $F3, $FF, $1D5, $1D6, $1E1 and $1EE). Patching the stream in place
 * therefore edits every level pointing at it.
 *
 * Editing shared data is not wrong in itself, but doing it without saying so
 * is: the other levels would change silently and still look correct. The real
 * fix is to relocate this level's sprite data and repoint it, which is not
 * built. Until then, callers warn.
 */
export function levelsSharingSprites(smw: SmwRom, level: number): number[] {
  const ptr = smw.getLevelSpritePointer(level)
  if (ptr === null) return []
  const out: number[] = []
  for (let id = 0; id < 0x200; id++) {
    if (id === level) continue
    if (smw.getLevelSpritePointer(id) !== ptr) continue
    // Ignore unused slots: an empty Layer 1 stream means nothing renders there.
    const l1 = smw.getLevelRawData(id)
    if (l1 && l1.length > 5 && l1[5] !== 0xff) out.push(id)
  }
  return out
}

/** Orientation decides which byte holds a sprite's X, so it is read, not assumed. */
function isLevelVertical(smw: SmwRom, level: number, verticalTable: readonly number[]): boolean {
  const raw = smw.getLevelRawData(level)
  if (!raw || raw.length < 5) return false
  return isLevelModeVertical(parseLevelHeader(raw).levelMode, verticalTable)
}
