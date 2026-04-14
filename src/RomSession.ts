import * as path from 'path'
import { SmwRom, RomSummary } from './rom/SmwRom'

/**
 * Holds the active ROM and its parsed state for the lifetime of an open session.
 * Created by the openRom command; passed to all providers.
 */
export class RomSession {
  readonly rom: SmwRom
  readonly summary: RomSummary
  /** URL-safe identifier derived from the ROM filename, used in smwrom:// URIs. */
  readonly slug: string

  constructor(romPath: string) {
    this.rom = SmwRom.open(romPath)
    this.summary = this.rom.getSummary()
    this.slug = path.basename(romPath, path.extname(romPath))
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .toLowerCase()
  }

  dispose(): void {
    // Nothing to clean up yet; placeholder for future resource handles
  }
}
