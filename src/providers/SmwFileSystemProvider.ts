import * as vscode from 'vscode'
import { RomSession } from '../RomSession'
import { LEVEL_COUNT } from '../rom/SmwRom'
import { GFX_FILE_COUNT } from '../rom/GfxLoader'
import { loadRomPalettes } from '../rom/PaletteLoader'
import { OW_AREA_COUNT, loadOverworldAreas, OwArea } from '../rom/OverworldLoader'
import { hex2, hex3 } from '../rom/hex'

const VIRTUAL_DIRS = new Set(['maps', 'palettes', 'gfx', 'music', 'overworld'])

/**
 * Virtual filesystem provider for smwrom:// URIs.
 *
 * Directory tree exposed when a ROM is mounted:
 *
 *   smwrom://<slug>/
 *     maps/
 *       000.smwmap         ← opens in MapEditorProvider
 *       001.smwmap
 *       ...
 *     palettes/
 *       global.smwpalette    ← opens in PaletteEditorProvider
 *
 * Future: graphics/, music/, sprites/
 *
 * File contents are small JSON descriptors; actual binary data is read
 * on demand by the respective editor provider.
 */
export class SmwFileSystemProvider implements vscode.FileSystemProvider {
  private sessions = new Map<string, RomSession>()

  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  readonly onDidChangeFile = this._emitter.event

  mount(session: RomSession): void {
    this.sessions.set(session.slug, session)
    this._emitter.fire([
      {
        type: vscode.FileChangeType.Created,
        uri: vscode.Uri.parse(`smwrom:/${session.slug}/`),
      },
    ])
  }

  unmount(slug: string): void {
    this.sessions.delete(slug)
  }

  watch(): vscode.Disposable {
    return { dispose: () => undefined }
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const { slug, parts } = this._parse(uri)
    if (!this.sessions.has(slug)) throw vscode.FileSystemError.FileNotFound(uri)

    const now = Date.now()

    if (parts.length === 0) return dir(now)

    if (parts.length === 1 && VIRTUAL_DIRS.has(parts[0])) return dir(now)

    if (parts.length === 1 && parts[0] === 'info.smwinfo')
      return { type: vscode.FileType.File, ctime: now, mtime: now, size: 128 }

    if (parts.length === 1 && parts[0] === 'graph.smwgraph')
      return { type: vscode.FileType.File, ctime: now, mtime: now, size: 128 }

    if (parts.length === 1 && parts[0] === 'compare.smwtilecomp')
      return { type: vscode.FileType.File, ctime: now, mtime: now, size: 128 }

    if (parts.length === 1 && parts[0] === 'rom.smwrommap')
      return { type: vscode.FileType.File, ctime: now, mtime: now, size: 128 }

    if (parts.length === 2) {
      if (parts[0] === 'music' && parts[1].endsWith('.smwmusic'))
        return { type: vscode.FileType.File, ctime: now, mtime: now, size: 128 }
      if (parts[0] === 'maps' && parts[1].endsWith('.smwmap'))
        return { type: vscode.FileType.File, ctime: now, mtime: now, size: 128 }

      if (parts[0] === 'palettes' && parts[1].endsWith('.smwpalette'))
        return { type: vscode.FileType.File, ctime: now, mtime: now, size: 128 }

      if (parts[0] === 'gfx' && parts[1].endsWith('.smwgfx'))
        return { type: vscode.FileType.File, ctime: now, mtime: now, size: 128 }

      if (parts[0] === 'overworld' && parts[1].endsWith('.smwoverworld'))
        return { type: vscode.FileType.File, ctime: now, mtime: now, size: 128 }
    }

    throw vscode.FileSystemError.FileNotFound(uri)
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const { slug, parts } = this._parse(uri)
    if (!this.sessions.has(slug)) throw vscode.FileSystemError.FileNotFound(uri)

    if (parts.length === 0) {
      return [
        ['maps', vscode.FileType.Directory],
        ['overworld', vscode.FileType.Directory],
        ['palettes', vscode.FileType.Directory],
        ['gfx', vscode.FileType.Directory],
      ]
    }

    if (parts.length === 1 && parts[0] === 'overworld') {
      const session = this.sessions.get(slug)!
      const areas = loadOverworldAreas(session.rom.rom)
      return areas.map((a): [string, vscode.FileType] => [areaFilename(a), vscode.FileType.File])
    }

    if (parts.length === 1 && parts[0] === 'maps') {
      const session = this.sessions.get(slug)!
      return session.rom
        .getAllLevelPointers()
        .filter(p => p.address !== null)
        .map(p => [indexToFilename(p.index), vscode.FileType.File])
    }

    if (parts.length === 1 && parts[0] === 'palettes') {
      // List per-group palette files + the global overview
      const session = this.sessions.get(slug)!
      const palettes = loadRomPalettes(session.rom.rom)
      const entries: [string, vscode.FileType][] = palettes.groups.map(
        g => [`${g.id}.smwpalette`, vscode.FileType.File] as [string, vscode.FileType],
      )
      entries.unshift(['global.smwpalette', vscode.FileType.File])
      return entries
    }

    if (parts.length === 1 && parts[0] === 'gfx') {
      return Array.from({ length: GFX_FILE_COUNT }, (_, i): [string, vscode.FileType] => [
        `GFX${hex2(i)}.smwgfx`,
        vscode.FileType.File,
      ])
    }

    if (parts.length === 1 && parts[0] === 'music') {
      return [['player.smwmusic', vscode.FileType.File]]
    }

    throw vscode.FileSystemError.FileNotFound(uri)
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const { slug, parts } = this._parse(uri)
    const session = this.sessions.get(slug)
    if (!session) throw vscode.FileSystemError.FileNotFound(uri)

    const romPath = session.rom.rom.filePath
    const encode = (type: string, extra: Record<string, unknown> = {}): Uint8Array =>
      Buffer.from(JSON.stringify({ type, version: 1, romPath, ...extra }), 'utf8')

    if (parts.length === 2 && parts[0] === 'maps' && parts[1].endsWith('.smwmap')) {
      const index = filenameToIndex(parts[1])
      if (index < 0 || index >= LEVEL_COUNT) throw vscode.FileSystemError.FileNotFound(uri)
      return encode('smwmap', { mapIndex: index })
    }

    if (parts.length === 2 && parts[0] === 'palettes' && parts[1].endsWith('.smwpalette')) {
      const groupId = parts[1].replace('.smwpalette', '')
      return encode('smwpalette', {
        groupId: groupId === 'global' ? null : groupId,
        name: groupId === 'global' ? 'Global Palette' : groupId,
      })
    }

    if (parts.length === 2 && parts[0] === 'gfx' && parts[1].endsWith('.smwgfx')) {
      const gfxIndex = parseInt(parts[1].replace('.smwgfx', '').replace('GFX', ''), 16)
      return encode('smwgfx', { gfxIndex })
    }

    if (parts.length === 2 && parts[0] === 'overworld' && parts[1].endsWith('.smwoverworld')) {
      const areaIndex = filenameToAreaIndex(parts[1])
      if (areaIndex < 0 || areaIndex >= OW_AREA_COUNT)
        throw vscode.FileSystemError.FileNotFound(uri)
      return encode('smwoverworld', { areaIndex })
    }

    if (parts.length === 2 && parts[0] === 'music' && parts[1].endsWith('.smwmusic'))
      return encode('smwmusic')

    if (parts.length === 1 && parts[0] === 'info.smwinfo') return encode('smwinfo')

    if (parts.length === 1 && parts[0] === 'graph.smwgraph') return encode('smwgraph', { slug })

    if (parts.length === 1 && parts[0] === 'compare.smwtilecomp') return encode('smwtilecomp')

    if (parts.length === 1 && parts[0] === 'rom.smwrommap') return encode('smwrommap')

    throw vscode.FileSystemError.FileNotFound(uri)
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions('ROM editing not yet implemented')
  }
  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions()
  }
  delete(): void {
    throw vscode.FileSystemError.NoPermissions()
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions()
  }

  private _parse(uri: vscode.Uri): { slug: string; parts: string[] } {
    const segments = uri.path.replace(/^\//, '').split('/').filter(Boolean)
    return { slug: segments[0] ?? '', parts: segments.slice(1) }
  }
}

function dir(now: number): vscode.FileStat {
  return { type: vscode.FileType.Directory, ctime: now, mtime: now, size: 0 }
}

function indexToFilename(index: number): string {
  return hex3(index) + '.smwmap'
}

function filenameToIndex(filename: string): number {
  return parseInt(filename.replace('.smwmap', ''), 16)
}

/** "0-64x64.smwoverworld", "1-32x32.smwoverworld", … - generic, dimensions only. */
function areaFilename(area: OwArea): string {
  return `${area.index}-${area.widthTiles}x${area.heightTiles}.smwoverworld`
}

function filenameToAreaIndex(filename: string): number {
  const m = /^(\d+)-/.exec(filename)
  return m ? parseInt(m[1], 10) : -1
}
