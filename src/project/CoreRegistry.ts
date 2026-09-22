/**
 * Where this machine's libretro core build lives.
 *
 * Mirrors RomRegistry.ts: a core is a per-machine choice, never a project
 * value, because two contributors point at different local copies of the same
 * core build. A single entry rather than a map keyed by identity, since only
 * one core drives the emulator view at a time.
 *
 * Resolving RE-VALIDATES on every call rather than trusting the stored path,
 * for the same reason RomRegistry does: the user can move or replace the file
 * underneath a stale entry.
 *
 * No VS Code or Theia imports, same rule as src/rom/ and RomRegistry.ts.
 */
import * as fs from 'fs'
import * as path from 'path'
import { appDataDir } from './appData'

export const CORE_REGISTRY_VERSION = 1

export interface CoreEntry {
  /** Absolute path to the Emscripten loader (.js). Never shared, never committed. */
  jsPath: string
  /** Absolute path to the sibling .wasm, resolved once at registration. */
  wasmPath: string
  label: string
  lastSeen: string
}

interface CoreRegistryFile {
  version: number
  core: CoreEntry | null
}

/** Beside the ROM registry, in per-user application data. */
export function defaultCoreRegistryPath(): string {
  return path.join(appDataDir(), 'core-registry.json')
}

/** Every WASM binary opens with this 4-byte magic ("\0asm"). */
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d])

/**
 * What theia/extension/src/browser/emulator-driver.ts actually calls on the
 * loaded Module: the runtime factory, and the frame counter the honest-fps
 * meter reads (its absence is exactly the "meter that cannot fail" defect
 * class, so it is refused here rather than discovered at boot).
 */
const REQUIRED_JS_MARKERS = ['EJS_Runtime', '_get_current_frame_count']

export interface CoreValidation {
  ok: boolean
  wasmPath: string
  message?: string
}

/**
 * Check, without proving general libretro conformance, whether a picked file
 * carries the specific entry points this driver calls. Missing ones are
 * refused here rather than left to fail confusingly mid boot. This is a
 * usability guard, not a security boundary: the matched glue still runs as
 * plain script in the frontend, same trust level as any other local file the
 * user opens.
 *
 * Never throws: an unreadable sibling (a directory named *.wasm, a locked
 * file) is a validation failure, not this function's problem to propagate.
 */
export function validateCore(jsPath: string): CoreValidation {
  const wasmPath = jsPath.replace(/\.js$/i, '.wasm')
  if (!jsPath.toLowerCase().endsWith('.js') || wasmPath === jsPath) {
    return {
      ok: false,
      wasmPath,
      message: "Pick the core's .js loader (the Emscripten glue), not another file.",
    }
  }

  try {
    if (!fs.existsSync(jsPath)) {
      return { ok: false, wasmPath, message: `No file at ${jsPath}` }
    }
    if (
      !fs.statSync(jsPath).isFile() ||
      !fs.existsSync(wasmPath) ||
      !fs.statSync(wasmPath).isFile()
    ) {
      return { ok: false, wasmPath, message: `No sibling .wasm beside ${path.basename(jsPath)}` }
    }

    const head = Buffer.alloc(4)
    const fd = fs.openSync(wasmPath, 'r')
    try {
      fs.readSync(fd, head, 0, 4, 0)
    } finally {
      fs.closeSync(fd)
    }
    if (!head.equals(WASM_MAGIC)) {
      return { ok: false, wasmPath, message: `${path.basename(wasmPath)} is not a WASM binary` }
    }

    // Capped rather than a plain readFileSync: an absurdly large pick (the
    // wrong file entirely) must not try to hold it all as one JS string.
    const stat = fs.statSync(jsPath)
    if (stat.size > 64 * 1024 * 1024) {
      return {
        ok: false,
        wasmPath,
        message: `${path.basename(jsPath)} is too large to be this core's loader script`,
      }
    }
    const js = fs.readFileSync(jsPath, 'utf8')
    const missing = REQUIRED_JS_MARKERS.filter(m => !js.includes(m))
    if (missing.length > 0) {
      return {
        ok: false,
        wasmPath,
        message: `${path.basename(jsPath)} is missing ${missing.join(', ')}; not a core build this driver can run`,
      }
    }

    return { ok: true, wasmPath }
  } catch (err) {
    return {
      ok: false,
      wasmPath,
      message: `Could not read ${path.basename(jsPath)}: ${(err as Error).message}`,
    }
  }
}

export class CoreRegistry {
  private readonly file: string

  constructor(file: string = defaultCoreRegistryPath()) {
    this.file = file
  }

  /** Validate then remember a core, replacing whatever was registered before. */
  register(jsPath: string): CoreEntry {
    const absolute = path.resolve(jsPath)
    const check = validateCore(absolute)
    if (!check.ok) throw new Error(check.message)

    const entry: CoreEntry = {
      jsPath: absolute,
      wasmPath: check.wasmPath,
      label: path.basename(absolute),
      lastSeen: new Date().toISOString(),
    }
    this.write({ version: CORE_REGISTRY_VERSION, core: entry })
    return entry
  }

  /**
   * The registered core, or undefined if none is set or it no longer
   * validates. Re-derives `wasmPath` from the check rather than trusting the
   * stored one, so a hand-edited registry cannot point the two fields at
   * different files. A malformed entry (missing fields, a future schema)
   * reads as unregistered rather than throwing, same rule as `read()`.
   */
  current(): CoreEntry | undefined {
    try {
      const entry = this.read().core
      if (!entry?.jsPath) return undefined
      const check = validateCore(entry.jsPath)
      return check.ok ? { ...entry, wasmPath: check.wasmPath } : undefined
    } catch {
      return undefined
    }
  }

  forget(): void {
    this.write({ version: CORE_REGISTRY_VERSION, core: null })
  }

  /** A damaged or future registry reads as empty rather than throwing. */
  private read(): CoreRegistryFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as CoreRegistryFile
      if (parsed?.version !== CORE_REGISTRY_VERSION) {
        return { version: CORE_REGISTRY_VERSION, core: null }
      }
      return { version: CORE_REGISTRY_VERSION, core: parsed.core ?? null }
    } catch {
      return { version: CORE_REGISTRY_VERSION, core: null }
    }
  }

  private write(data: CoreRegistryFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  }
}
