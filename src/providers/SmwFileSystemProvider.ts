import * as vscode from 'vscode'
import { RomSession } from '../RomSession'
import { LEVEL_COUNT } from '../rom/SmwRom'
import { GFX_FILE_COUNT } from '../rom/GfxLoader'

/**
 * Virtual filesystem provider for smwrom:// URIs.
 *
 * Directory tree exposed when a ROM is mounted:
 *
 *   smwrom://<slug>/
 *     levels/
 *       000.smwlevel         ← opens in LevelEditorProvider
 *       001.smwlevel
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
    this._emitter.fire([{
      type: vscode.FileChangeType.Created,
      uri: vscode.Uri.parse(`smwrom:/${session.slug}/`)
    }])
  }

  unmount(slug: string): void { this.sessions.delete(slug) }

  watch(): vscode.Disposable { return { dispose: () => undefined } }

  stat(uri: vscode.Uri): vscode.FileStat {
    const { slug, parts } = this._parse(uri)
    if (!this.sessions.has(slug)) throw vscode.FileSystemError.FileNotFound(uri)

    const now = Date.now()

    if (parts.length === 0) return dir(now)

    if (parts.length === 1) {
      if (parts[0] === 'levels' || parts[0] === 'palettes' || parts[0] === 'gfx') return dir(now)
    }

    if (parts.length === 2) {
      if (parts[0] === 'levels' && parts[1].endsWith('.smwlevel'))
        return { type: vscode.FileType.File, ctime: now, mtime: now, size: 128 }

      if (parts[0] === 'palettes' && parts[1].endsWith('.smwpalette'))
        return { type: vscode.FileType.File, ctime: now, mtime: now, size: 128 }

      if (parts[0] === 'gfx' && parts[1].endsWith('.smwgfx'))
        return { type: vscode.FileType.File, ctime: now, mtime: now, size: 128 }
    }

    throw vscode.FileSystemError.FileNotFound(uri)
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const { slug, parts } = this._parse(uri)
    if (!this.sessions.has(slug)) throw vscode.FileSystemError.FileNotFound(uri)

    if (parts.length === 0) {
      return [
        ['levels',   vscode.FileType.Directory],
        ['palettes', vscode.FileType.Directory],
        ['gfx',      vscode.FileType.Directory],
      ]
    }

    if (parts.length === 1 && parts[0] === 'levels') {
      const session = this.sessions.get(slug)!
      return session.rom.getAllLevelPointers()
        .filter(p => p.address !== null)
        .map(p => [indexToFilename(p.index), vscode.FileType.File])
    }

    if (parts.length === 1 && parts[0] === 'palettes') {
      return [['global.smwpalette', vscode.FileType.File]]
    }

    if (parts.length === 1 && parts[0] === 'gfx') {
      return Array.from({ length: GFX_FILE_COUNT }, (_, i): [string, vscode.FileType] =>
        [`GFX${i.toString(16).toUpperCase().padStart(2, '0')}.smwgfx`, vscode.FileType.File]
      )
    }

    throw vscode.FileSystemError.FileNotFound(uri)
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const { slug, parts } = this._parse(uri)
    const session = this.sessions.get(slug)
    if (!session) throw vscode.FileSystemError.FileNotFound(uri)

    if (parts.length === 2 && parts[0] === 'levels' && parts[1].endsWith('.smwlevel')) {
      const index = filenameToIndex(parts[1])
      if (index < 0 || index >= LEVEL_COUNT) throw vscode.FileSystemError.FileNotFound(uri)
      return Buffer.from(JSON.stringify({
        type: 'smwlevel', version: 1,
        romPath: session.rom.rom.filePath,
        levelIndex: index,
      }), 'utf8')
    }

    if (parts.length === 2 && parts[0] === 'palettes' && parts[1] === 'global.smwpalette') {
      return Buffer.from(JSON.stringify({
        type: 'smwpalette', version: 1,
        romPath: session.rom.rom.filePath,
        name: 'Global Palette',
      }), 'utf8')
    }

    if (parts.length === 2 && parts[0] === 'gfx' && parts[1].endsWith('.smwgfx')) {
      const hex = parts[1].replace('.smwgfx', '').replace('GFX', '')
      const gfxIndex = parseInt(hex, 16)
      return Buffer.from(JSON.stringify({
        type: 'smwgfx', version: 1,
        romPath: session.rom.rom.filePath,
        gfxIndex,
      }), 'utf8')
    }

    throw vscode.FileSystemError.FileNotFound(uri)
  }

  writeFile(): void { throw vscode.FileSystemError.NoPermissions('ROM editing not yet implemented') }
  createDirectory(): void { throw vscode.FileSystemError.NoPermissions() }
  delete(): void { throw vscode.FileSystemError.NoPermissions() }
  rename(): void { throw vscode.FileSystemError.NoPermissions() }

  private _parse(uri: vscode.Uri): { slug: string; parts: string[] } {
    const segments = uri.path.replace(/^\//, '').split('/').filter(Boolean)
    return { slug: segments[0] ?? '', parts: segments.slice(1) }
  }
}

function dir(now: number): vscode.FileStat {
  return { type: vscode.FileType.Directory, ctime: now, mtime: now, size: 0 }
}

function indexToFilename(index: number): string {
  return index.toString(16).toUpperCase().padStart(3, '0') + '.smwlevel'
}

function filenameToIndex(filename: string): number {
  return parseInt(filename.replace('.smwlevel', ''), 16)
}
