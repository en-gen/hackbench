/**
 * Where this machine's cartridges live.
 *
 * A project records ROM identity and never a path, so it is byte-identical
 * for every contributor and safe to commit. That leaves someone having to
 * know where the user's own copy is, and it cannot be the project: two
 * contributors name their dumps differently, and a path in a shared file is
 * either wrong for everyone else or noise in every diff.
 *
 * So the pairing lives here, in per-user application data, keyed by the cart
 * hash. Opening a project looks the hash up; a miss is the prompt to locate
 * the cartridge, not an error.
 *
 * Resolving RE-VERIFIES rather than trusting the stored path. Paths are not
 * stable identifiers: the user renames files, re-dumps, and drops a different
 * hack at the same name. Editing the wrong cart is silent and the result
 * looks plausible, so the only safe answer to "is this still that ROM" is to
 * read it and check.
 *
 * No VS Code or Theia imports, same rule as src/rom/.
 */
import * as fs from 'fs'
import * as path from 'path'
import { RomIdentity, romIdentity } from './Project'
import { readRomBounded } from './BoundedRead'
import { appDataDir } from './appData'

export const REGISTRY_VERSION = 1

export interface RegistryEntry {
  sha256: string
  /** Absolute path on THIS machine. Never shared, never committed. */
  path: string
  title: string
  size: number
  /** ISO timestamp of the last successful register, for a most-recent list. */
  lastSeen: string
}

interface RegistryFile {
  version: number
  roms: Record<string, RegistryEntry>
}

/** Beside the recent-projects list, in per-user application data. */
export function defaultRegistryPath(): string {
  return path.join(appDataDir(), 'rom-registry.json')
}

export class RomRegistry {
  private readonly file: string

  constructor(file: string = defaultRegistryPath()) {
    this.file = file
  }

  /**
   * Remember where a cartridge is, returning the identity a project stores.
   *
   * Keyed by hash, so re-registering a cart the user moved updates the entry
   * instead of accumulating a second one pointing at a dead path.
   */
  register(romPath: string): RomIdentity {
    const absolute = path.resolve(romPath)
    const identity = romIdentity(readRomBounded(absolute))

    const data = this.read()
    data.roms[identity.sha256] = {
      sha256: identity.sha256,
      path: absolute,
      title: identity.title,
      size: identity.size,
      lastSeen: new Date().toISOString(),
    }
    this.write(data)
    return identity
  }

  /**
   * Where this cartridge is now, or null if we cannot say.
   *
   * Null covers three cases the caller handles identically by asking the user
   * to locate it: never registered, the file is gone, and the file is no
   * longer that cartridge.
   */
  resolve(sha256: string): string | null {
    const entry = this.read().roms[sha256]
    if (!entry || !fs.existsSync(entry.path)) return null

    let actual: RomIdentity
    try {
      actual = romIdentity(readRomBounded(entry.path))
    } catch {
      return null
    }
    return actual.sha256 === sha256 ? entry.path : null
  }

  /** Every remembered cartridge, most recently seen first. */
  list(): RegistryEntry[] {
    return Object.values(this.read().roms).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
  }

  forget(sha256: string): void {
    const data = this.read()
    delete data.roms[sha256]
    this.write(data)
  }

  /**
   * A damaged or future registry reads as empty rather than throwing. It
   * costs the user one re-pick; refusing to start the app over it does not.
   */
  private read(): RegistryFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as RegistryFile
      if (parsed?.version !== REGISTRY_VERSION || typeof parsed.roms !== 'object') {
        return { version: REGISTRY_VERSION, roms: {} }
      }
      return { version: REGISTRY_VERSION, roms: parsed.roms ?? {} }
    } catch {
      return { version: REGISTRY_VERSION, roms: {} }
    }
  }

  private write(data: RegistryFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  }
}
