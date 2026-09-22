/**
 * Pairing this machine's libretro core build with the emulator driver.
 *
 * Mirrors RomRegistry.test.ts: the assertion that matters most is that
 * resolving re-validates rather than trusting a remembered path, because the
 * driver crashes confusingly, not safely, against a core missing the entry
 * points it calls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  CoreRegistry,
  defaultCoreRegistryPath,
  validateCore,
} from '../../../src/project/CoreRegistry'

let tmp: string
let registry: CoreRegistry

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hbcorereg-'))
  registry = new CoreRegistry(path.join(tmp, 'core-registry.json'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Synthetic glue carrying the two markers the driver actually calls. */
const FAKE_JS = 'var x = "EJS_Runtime"; Module["_get_current_frame_count"] = function(){};'
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

function writeCore(dir: string, base = 'core'): string {
  const jsPath = path.join(dir, `${base}.js`)
  fs.writeFileSync(jsPath, FAKE_JS)
  fs.writeFileSync(path.join(dir, `${base}.wasm`), WASM_MAGIC)
  return jsPath
}

describe('CoreRegistry', () => {
  it('registers and resolves a valid core', () => {
    const jsPath = writeCore(tmp)
    const entry = registry.register(jsPath)
    expect(entry.wasmPath).toBe(path.join(tmp, 'core.wasm'))
    expect(registry.current()?.jsPath).toBe(path.resolve(jsPath))
  })

  it('survives a restart', () => {
    const jsPath = writeCore(tmp)
    registry.register(jsPath)
    const reopened = new CoreRegistry(path.join(tmp, 'core-registry.json'))
    expect(reopened.current()?.jsPath).toBe(path.resolve(jsPath))
  })

  it('starts with no core registered', () => {
    expect(registry.current()).toBeUndefined()
  })

  it('forgets on request', () => {
    registry.register(writeCore(tmp))
    registry.forget()
    expect(registry.current()).toBeUndefined()
  })

  it('stops resolving once the file is gone', () => {
    const jsPath = writeCore(tmp)
    registry.register(jsPath)
    fs.rmSync(jsPath)
    expect(registry.current()).toBeUndefined()
  })

  it('replaces whatever was registered before rather than accumulating entries', () => {
    registry.register(writeCore(tmp, 'first'))
    const second = registry.register(writeCore(tmp, 'second'))
    expect(registry.current()?.jsPath).toBe(second.jsPath)
  })

  it('starts empty rather than throwing when the file is corrupt', () => {
    const file = path.join(tmp, 'core-registry.json')
    fs.writeFileSync(file, '{ not json')
    const r = new CoreRegistry(file)
    expect(r.current()).toBeUndefined()
    const jsPath = writeCore(tmp)
    expect(r.register(jsPath).jsPath).toBe(path.resolve(jsPath))
  })

  it('puts the registry outside any project, in per-user application data', () => {
    const p = defaultCoreRegistryPath()
    expect(path.isAbsolute(p)).toBe(true)
    expect(p).toMatch(/hackbench/i)
  })

  /**
   * The oracle this case exists for: a naive current() that only guards the
   * top-level JSON.parse (as an earlier version of this class did) throws
   * here instead of reading as unregistered, wedging the emulator view's
   * registeredCore() RPC call.
   */
  it('reads a structurally malformed entry as unregistered rather than throwing', () => {
    const file = path.join(tmp, 'core-registry.json')
    fs.writeFileSync(file, JSON.stringify({ version: 1, core: { label: 'x' } }))
    const r = new CoreRegistry(file)
    expect(() => r.current()).not.toThrow()
    expect(r.current()).toBeUndefined()
  })

  it('serves the freshly validated wasmPath, not a stored one a hand edit could have pointed elsewhere', () => {
    const jsPath = writeCore(tmp)
    registry.register(jsPath)

    const file = path.join(tmp, 'core-registry.json')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    data.core.wasmPath = path.join(tmp, 'unrelated-file.txt')
    fs.writeFileSync(path.join(tmp, 'unrelated-file.txt'), 'not a core at all')
    fs.writeFileSync(file, JSON.stringify(data))

    expect(registry.current()?.wasmPath).toBe(path.join(tmp, 'core.wasm'))
  })
})

describe('validateCore', () => {
  it('refuses a file that is not a .js loader', () => {
    const notJs = path.join(tmp, 'core.txt')
    fs.writeFileSync(notJs, FAKE_JS)
    expect(validateCore(notJs).ok).toBe(false)
  })

  it('refuses a .js with no sibling .wasm', () => {
    const jsPath = path.join(tmp, 'lonely.js')
    fs.writeFileSync(jsPath, FAKE_JS)
    const result = validateCore(jsPath)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/wasm/i)
  })

  it('refuses a sibling file that is not actually a WASM binary', () => {
    const jsPath = path.join(tmp, 'fake.js')
    fs.writeFileSync(jsPath, FAKE_JS)
    fs.writeFileSync(path.join(tmp, 'fake.wasm'), 'not wasm at all')
    expect(validateCore(jsPath).ok).toBe(false)
  })

  /**
   * The oracle this file exists for: acceptance without checking for the
   * entry points the driver calls would let any arbitrary .js/.wasm pair
   * through, and fail silently and confusingly at boot instead of here.
   */
  it('refuses JS glue missing the frame counter the honest-fps meter needs', () => {
    const jsPath = path.join(tmp, 'nocounter.js')
    fs.writeFileSync(jsPath, 'var x = "EJS_Runtime";') // no _get_current_frame_count
    fs.writeFileSync(path.join(tmp, 'nocounter.wasm'), WASM_MAGIC)
    const result = validateCore(jsPath)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/_get_current_frame_count/)
  })

  it('accepts a well-formed pair', () => {
    const jsPath = writeCore(tmp)
    expect(validateCore(jsPath).ok).toBe(true)
  })

  /**
   * The oracle this case exists for: fs.existsSync is true for a directory,
   * so a check that stopped there would try to open it as a file and throw
   * EISDIR out of validateCore, which is documented never to throw.
   */
  it('refuses rather than throws when the sibling name is a directory', () => {
    const jsPath = path.join(tmp, 'dirwasm.js')
    fs.writeFileSync(jsPath, FAKE_JS)
    fs.mkdirSync(path.join(tmp, 'dirwasm.wasm'))
    expect(() => validateCore(jsPath)).not.toThrow()
    expect(validateCore(jsPath).ok).toBe(false)
  })
})
