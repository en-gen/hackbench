/**
 * A HackBench project: a hack, not a workspace.
 *
 * The base ROM is never modified. Every edit becomes an ordered patch layer,
 * and the project holds those layers plus metadata. The cart itself is
 * REFERENCED by identity, never copied in, which is what makes a project safe
 * to share: it contains no cartridge-derived bytes at all.
 *
 * That property is unconditional rather than dependent on an ignore file. The
 * only cartridge-derived output HackBench produces is the emulator cache
 * (savestates, heap offsets), and that lives in application data keyed by ROM
 * hash and core identity, not here.
 *
 * Layout, one manifest at the root of the data it describes, the way
 * package.json sits at the root of a package:
 *
 *   my-hack/
 *     MyHack.hbproj      this manifest
 *     levels/            per-level patch layers
 *     snapshots/         squashed save points
 *
 * Directory names are FIXED, not derived from the project name, so renaming
 * the manifest cannot orphan the layers.
 *
 * No VS Code or Theia imports. Same rule as src/rom/: this is plain
 * TypeScript so it can be tested without a shell.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { COPIER_HEADER_SIZE, hasCopierHeader } from '../rom/addressing'

export const PROJECT_EXT = '.hbproj'
export const SCHEMA_VERSION = 1

/** Fixed, because renaming the manifest must not orphan the data. */
export const LEVELS_DIR = 'levels'
export const SNAPSHOTS_DIR = 'snapshots'

/**
 * Which cartridge a project is built against.
 *
 * Identity only. No path: where the cart lives is per-machine and belongs in
 * the ROM registry, so a project committed to a repo is byte-identical for
 * every contributor regardless of what they named their copy.
 */
export interface RomIdentity {
  sha256: string
  /** Size WITHOUT any copier header, so it describes the cart. */
  size: number
  title: string
}

/**
 * What the hack IS, as opposed to what HackBench needs to open it.
 *
 * Separate from `name`, which is the manifest's own filename stem and so is
 * constrained by the filesystem. A hack called "Super Kaizo World ]|[" has to
 * live in a directory that cannot be called that.
 *
 * All optional at creation and all editable afterwards: someone starting a
 * hack does not yet know its summary, and refusing to create a project until
 * they invent one would be the tool getting in the way.
 */
export interface HackMetadata {
  /** The game's display title. Defaults to the project name. */
  title: string
  /** One or two sentences about the hack. Empty until the author writes one. */
  summary: string
  authors: string[]
  /**
   * The HACK's version, which is the author's to set and means nothing to us.
   * Unrelated to schemaVersion, which is the manifest format's.
   */
  version: string
}

export interface ProjectManifest extends HackMetadata {
  schemaVersion: number
  name: string
  baseRom: RomIdentity
  created: string
}

export interface Project extends HackMetadata {
  manifestPath: string
  directory: string
  levelsDir: string
  snapshotsDir: string
  name: string
  baseRom: RomIdentity
}

/** LoROM carries its internal header at $7FC0, and the title is 21 bytes. */
const LOROM_HEADER_OFFSET = 0x7fc0
const TITLE_LENGTH = 21

/**
 * Identify a cartridge from its bytes.
 *
 * The hash covers the CART, not the file: a 512-byte copier header is stripped
 * first. The same game dumped with and without one is a single identity, which
 * matters because both forms are common and a contributor whose dump differs
 * would otherwise be told to find a ROM they already have.
 */
export function romIdentity(bytes: Uint8Array): RomIdentity {
  const headered = hasCopierHeader(bytes.length)
  const cart = headered ? bytes.subarray(COPIER_HEADER_SIZE) : bytes

  const sha256 = crypto.createHash('sha256').update(cart).digest('hex')

  const raw = Buffer.from(
    cart.subarray(LOROM_HEADER_OFFSET, LOROM_HEADER_OFFSET + TITLE_LENGTH),
  ).toString('ascii')
  // Trailing spaces are padding in the cart's own header, not part of the name.
  // Control bytes appear when the offset holds data rather than a title.
  const title = raw.replace(/[^\x20-\x7e]/g, '').trim()

  return { sha256, size: cart.length, title }
}

export interface CreateOptions extends Partial<HackMetadata> {
  romPath: string
  name: string
  /** Where the project directory goes. Created if absent, refused if occupied. */
  directory: string
}

/** The author's starting version. Theirs to change; we never touch it again. */
export const INITIAL_HACK_VERSION = '0.1.0'

/**
 * Fill in what the author did not supply.
 *
 * Applied on READ as well as on create, so a manifest written before these
 * fields existed opens with sensible values instead of `undefined` reaching
 * the UI.
 */
function withMetadataDefaults(
  meta: Partial<HackMetadata>, name: string,
): HackMetadata {
  return {
    title: meta.title?.trim() || name,
    summary: meta.summary ?? '',
    // Tolerates a bare string, which is what a hand-edited manifest tends to
    // hold: splitting it silently would invent authors that do not exist.
    authors: Array.isArray(meta.authors) ? meta.authors : (meta.authors ? [meta.authors] : []),
    version: (meta.version || '').trim() || INITIAL_HACK_VERSION,
  }
}

/**
 * Create a project against a base ROM.
 *
 * Reads the cart to identify it and writes nothing from it. The ROM file is
 * left untouched.
 */
export function createProject(opts: CreateOptions): Project {
  const { romPath, name, directory } = opts

  if (!fs.existsSync(romPath)) {
    throw new Error(`No ROM at ${romPath}`)
  }
  if (!name.trim()) {
    throw new Error('A project needs a name')
  }

  // Refuse an occupied directory rather than merging into it: adopting files
  // that are not ours, and being unable to tell later which were, is worse
  // than making the user pick somewhere else.
  if (fs.existsSync(directory) && fs.readdirSync(directory).length > 0) {
    throw new Error(`Directory is not empty: ${directory}`)
  }

  const baseRom = romIdentity(new Uint8Array(fs.readFileSync(romPath)))

  const manifest: ProjectManifest = {
    schemaVersion: SCHEMA_VERSION,
    name,
    ...withMetadataDefaults(opts, name),
    baseRom,
    created: new Date().toISOString(),
  }

  fs.mkdirSync(directory, { recursive: true })
  fs.mkdirSync(path.join(directory, LEVELS_DIR), { recursive: true })
  fs.mkdirSync(path.join(directory, SNAPSHOTS_DIR), { recursive: true })

  const manifestPath = path.join(directory, `${name}${PROJECT_EXT}`)
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  return toProject(manifestPath, manifest)
}

/**
 * Open a project from its manifest.
 *
 * The manifest is meaningless away from its data, so a manifest whose sibling
 * directories are gone is an error rather than an empty project. An empty
 * project looks exactly like a hack that lost all its work.
 */
export function openProject(manifestPath: string): Project {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No project at ${manifestPath}`)
  }
  const directory = path.dirname(manifestPath)

  // Two manifests would both claim the same levels/, so neither can be assumed
  // to be the right one.
  const manifests = fs.readdirSync(directory).filter(f => f.endsWith(PROJECT_EXT))
  if (manifests.length > 1) {
    throw new Error(
      `Directory holds more than one project file (${manifests.join(', ')}): ${directory}`,
    )
  }

  let manifest: ProjectManifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ProjectManifest
  } catch (err) {
    throw new Error(`Project file is not readable JSON: ${manifestPath}`, { cause: err })
  }

  // Refuse a newer schema rather than guessing at fields we do not know. A
  // project written by a later version may mean something different by the
  // same names.
  if (typeof manifest.schemaVersion !== 'number') {
    throw new Error(`Project file has no schema version: ${manifestPath}`)
  }
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `Project uses schema version ${manifest.schemaVersion}; this build understands ${SCHEMA_VERSION}`,
    )
  }

  const levelsDir = path.join(directory, LEVELS_DIR)
  if (!fs.existsSync(levelsDir)) {
    throw new Error(
      `Project file has no data directories beside it; it may have been moved away from its project: ${manifestPath}`,
    )
  }

  return toProject(manifestPath, manifest)
}

function toProject(manifestPath: string, manifest: ProjectManifest): Project {
  const directory = path.dirname(manifestPath)
  return {
    manifestPath,
    directory,
    levelsDir: path.join(directory, LEVELS_DIR),
    snapshotsDir: path.join(directory, SNAPSHOTS_DIR),
    name: manifest.name,
    ...withMetadataDefaults(manifest, manifest.name),
    baseRom: manifest.baseRom,
  }
}

/**
 * Change what the hack says about itself.
 *
 * Merges onto the manifest ON DISK rather than rewriting it from a Project
 * object, so fields this build does not know about survive. A collaborator on
 * a newer HackBench must not lose data because someone on an older one edited
 * the title.
 *
 * Only metadata is editable here. The base ROM identity and the creation date
 * are facts about the project, not opinions, and changing either would make
 * the manifest describe a different thing.
 */
export function updateProject(
  manifestPath: string, changes: Partial<HackMetadata>,
): Project {
  // Round-trips through openProject first so a manifest that is unreadable,
  // orphaned or from a future schema is refused BEFORE anything is written.
  openProject(manifestPath)

  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ProjectManifest
  const merged: ProjectManifest = {
    ...raw,
    ...withMetadataDefaults({ ...raw, ...changes }, raw.name),
  }

  fs.writeFileSync(manifestPath, `${JSON.stringify(merged, null, 2)}
`, 'utf8')
  return toProject(manifestPath, merged)
}
