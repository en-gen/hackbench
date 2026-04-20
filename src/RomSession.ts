import * as path from 'path'
import { SmwRom, RomSummary } from './rom/SmwRom'
import { loadAllMap16BG, loadMap16WithPipeVariants, type Map16Tile } from './rom/Map16'
import { loadVram, type VramState } from './rom/GfxLoader'
import { loadAnimationData, type AnimationData } from './rom/AnimationLoader'
import { loadRomPalettes, loadBackAreaColors, type RomPalettes } from './rom/PaletteLoader'
import type { RgbaColor } from './rom/GraphicsDecoder'
import { loadPaletteAnimData, type PaletteAnimData } from './rom/PaletteAnimationLoader'
import { buildSpc } from './rom/SpcBuilder'

let activeSession: RomSession | undefined

/**
 * Returns the currently open session, or undefined if no ROM is loaded.
 * Providers call this to reuse the in-memory ROM buffer instead of
 * re-reading the file from disk on every descriptor load — critical
 * for fast switching between maps/palettes/gfx files.
 */
export function getActiveRomSession(): RomSession | undefined {
  return activeSession
}

/** Set on construction by RomSession; cleared on dispose. */
export function setActiveRomSession(session: RomSession | undefined): void {
  activeSession = session
}

/**
 * Get the SmwRom for a descriptor's romPath, reusing the active session's
 * in-memory buffer when it matches. Falls back to a fresh disk read only
 * if no active session matches (e.g., stale descriptor after ROM close).
 */
export function resolveRom(romPath: string): SmwRom {
  if (activeSession && activeSession.rom.rom.filePath === romPath) {
    return activeSession.rom
  }
  return SmwRom.open(romPath)
}

export interface Map16WithVariants {
  tiles: Map16Tile[]
  pipeVariants: Map16Tile[][]
}

/**
 * Holds the active ROM and its parsed state for the lifetime of an open session.
 * Created by the openRom command; passed to all providers.
 *
 * Derived-asset getters (getMap16, getVram, etc.) memoize their results so that
 * cycling between levels with the same tileset doesn't re-decompress GFX or
 * rebuild Map16 tables from scratch. All pure-TS loaders under `src/rom/*` stay
 * untouched; caching is a thin wrapper.
 */
export class RomSession {
  readonly rom: SmwRom
  readonly summary: RomSummary
  /** URL-safe identifier derived from the ROM filename, used in smwrom:// URIs. */
  readonly slug: string

  private readonly _map16Cache = new Map<number, Map16WithVariants>()
  private _map16BgCache: Map16Tile[] | undefined
  private readonly _vramCache = new Map<string, VramState>()
  private readonly _animCache = new Map<number, AnimationData | null>()
  private readonly _palettesCache = new Map<number, RomPalettes>()
  private _backAreaColorsCache: RgbaColor[] | undefined
  private readonly _paletteAnimCache = new Map<string, PaletteAnimData | null>()
  private readonly _spcCache = new Map<string, Uint8Array | null>()

  constructor(romPath: string) {
    this.rom = SmwRom.open(romPath)
    this.summary = this.rom.getSummary()
    this.slug = path.basename(romPath, path.extname(romPath))
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .toLowerCase()
    setActiveRomSession(this)
  }

  dispose(): void {
    if (getActiveRomSession() === this) setActiveRomSession(undefined)
  }

  getMap16(tileset: number): Map16WithVariants {
    let entry = this._map16Cache.get(tileset)
    if (!entry) {
      entry = loadMap16WithPipeVariants(this.rom.rom, tileset)
      this._map16Cache.set(tileset, entry)
    }
    return entry
  }

  getMap16BG(): Map16Tile[] {
    if (!this._map16BgCache) this._map16BgCache = loadAllMap16BG(this.rom.rom)
    return this._map16BgCache
  }

  getVram(tilesetId: number, spriteSet: number): VramState {
    const key = `${tilesetId}|${spriteSet}`
    let v = this._vramCache.get(key)
    if (!v) {
      v = loadVram(this.rom.rom, tilesetId, spriteSet)
      this._vramCache.set(key, v)
    }
    return v
  }

  getAnimationData(tilesetId: number): AnimationData | null {
    if (!this._animCache.has(tilesetId)) {
      this._animCache.set(tilesetId, loadAnimationData(this.rom.rom, tilesetId))
    }
    return this._animCache.get(tilesetId) ?? null
  }

  getRomPalettes(bgColorVariant: number): RomPalettes {
    let p = this._palettesCache.get(bgColorVariant)
    if (!p) {
      p = loadRomPalettes(this.rom.rom, bgColorVariant)
      this._palettesCache.set(bgColorVariant, p)
    }
    return p
  }

  getBackAreaColors(): RgbaColor[] {
    if (!this._backAreaColorsCache) this._backAreaColorsCache = loadBackAreaColors(this.rom.rom)
    return this._backAreaColorsCache
  }

  getPaletteAnim(mode: 'level' | 'overworld'): PaletteAnimData | null {
    if (!this._paletteAnimCache.has(mode)) {
      this._paletteAnimCache.set(mode, loadPaletteAnimData(this.rom.rom, mode))
    }
    return this._paletteAnimCache.get(mode) ?? null
  }

  getSpc(bgmCommand: number, musicBank: 'level' | 'overworld' | 'credits'): Uint8Array | null {
    const key = `${musicBank}|${bgmCommand}`
    if (!this._spcCache.has(key)) {
      this._spcCache.set(key, buildSpc(this.rom.rom, bgmCommand, musicBank))
    }
    return this._spcCache.get(key) ?? null
  }
}
