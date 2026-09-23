/**
 * The emulator's save games (the core's SRAM), numbered slots in the
 * project's `saves/` folder: `<ROM title>.<#>.srm`, labels beside them in
 * `labels.json`, so file names always follow the convention whatever a
 * slot is called.
 *
 * The ROM title is the one in the ROM's own header, recorded in the
 * manifest: the same on every machine, so a shared project finds its saves.
 *
 * SRAM is the game's own progress data, not ROM content, so this does not
 * break Project.ts's rule that a project holds no ROM-derived bytes. Save
 * STATES do hold ROM-derived bytes and never belong here.
 *
 * Plain TypeScript, no Theia, same as the rest of src/project.
 */
import * as fs from 'fs'
import * as path from 'path'
import { SAVES_DIR } from './Project'

/**
 * Generous for any SNES game (the largest SRAM is 128 KiB) while refusing a
 * frontend that sends something that is plainly not a save file.
 */
export const MAX_SAVE_BYTES = 512 * 1024
export const MAX_LABEL_LENGTH = 80
const LABELS_FILE = 'labels.json'
/** The single save before slots existed; becomes slot 1 on first sight. */
const LEGACY_SAVE = 'game.srm'

export interface SaveSlot {
  slot: number
  file: string
  label?: string
}

/** A title safe as a file name on every platform; never empty. */
export function saveBaseName(romTitle: string): string {
  const safe = romTitle
    // Control characters are exactly what must not reach a file name.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/, '')
  if (!safe) return 'ROM'
  // Windows treats these as devices even with an extension (NUL.1.srm).
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe) ? `${safe}_` : safe
}

export function slotFile(romTitle: string, slot: number): string {
  return `${saveBaseName(romTitle)}.${slot}.srm`
}

function savesDir(projectDirectory: string): string {
  return path.join(projectDirectory, SAVES_DIR)
}

function checkSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > 9999)
    throw new Error(`not a save slot: ${slot}`)
}

/**
 * Labels by FILE NAME, not slot number, so two titles sharing a saves/
 * folder cannot pick up each other's. Only string values count; a file
 * that is not valid JSON reads as no labels for listing, but `strict`
 * refuses it, so a rename cannot silently erase every label in it.
 */
function readLabels(dir: string, strict = false): Record<string, string> {
  const file = path.join(dir, LABELS_FILE)
  if (!fs.existsSync(file)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    if (strict) throw new Error(`${LABELS_FILE} is not valid JSON; fix or remove it first`)
    return {}
  }
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v
  }
  return out
}

function writeLabels(dir: string, labels: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true })
  atomicWrite(path.join(dir, LABELS_FILE), Buffer.from(JSON.stringify(labels, null, 2)))
}

/** Every slot on disk for this ROM title, lowest number first. */
export function listSaves(projectDirectory: string, romTitle: string): SaveSlot[] {
  const dir = savesDir(projectDirectory)
  migrateLegacy(dir, romTitle)
  if (!fs.existsSync(dir)) return []
  const base = saveBaseName(romTitle)
  const labels = readLabels(dir)
  const slots: SaveSlot[] = []
  for (const file of fs.readdirSync(dir)) {
    if (!file.startsWith(`${base}.`) || !file.endsWith('.srm')) continue
    const n = file.slice(base.length + 1, -'.srm'.length)
    if (!/^[1-9]\d{0,3}$/.test(n)) continue
    const slot = Number(n)
    slots.push({ slot, file, ...(labels[file] ? { label: labels[file] } : {}) })
  }
  return slots.sort((a, b) => a.slot - b.slot)
}

/**
 * The lowest slot number with no save in it and not `reserved`: a slot
 * chosen (or running) but not yet written has no file, and must not be
 * handed out again.
 */
export function nextFreeSlot(
  projectDirectory: string,
  romTitle: string,
  reserved: number[] = [],
): number {
  const used = new Set([...listSaves(projectDirectory, romTitle).map(s => s.slot), ...reserved])
  let n = 1
  while (used.has(n)) n++
  return n
}

export function loadSave(
  projectDirectory: string,
  romTitle: string,
  slot: number,
): Uint8Array | undefined {
  checkSlot(slot)
  migrateLegacy(savesDir(projectDirectory), romTitle)
  const file = path.join(savesDir(projectDirectory), slotFile(romTitle, slot))
  return fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : undefined
}

export function storeSave(
  projectDirectory: string,
  romTitle: string,
  slot: number,
  bytes: Uint8Array,
): void {
  checkSlot(slot)
  if (bytes.length === 0 || bytes.length > MAX_SAVE_BYTES) {
    throw new Error(`refusing a ${bytes.length}-byte save file (limit ${MAX_SAVE_BYTES})`)
  }
  const dir = savesDir(projectDirectory)
  fs.mkdirSync(dir, { recursive: true })
  const file = slotFile(romTitle, slot)
  const isNew = !fs.existsSync(path.join(dir, file))
  atomicWrite(path.join(dir, file), bytes)
  // A label left by a file removed outside HackBench is not this save's.
  // Best effort: a broken labels.json must never stop a save being written.
  if (isNew) {
    try {
      setLabel(dir, file, '')
    } catch {
      /* the save is on disk; the stale label only mislabels it */
    }
  }
}

export function deleteSave(projectDirectory: string, romTitle: string, slot: number): void {
  checkSlot(slot)
  const dir = savesDir(projectDirectory)
  const file = slotFile(romTitle, slot)
  fs.rmSync(path.join(dir, file), { force: true })
  setLabel(dir, file, '')
}

/**
 * Copy a slot into the next free number, label and all; returns that
 * number. `reserved` as for nextFreeSlot.
 */
export function duplicateSave(
  projectDirectory: string,
  romTitle: string,
  slot: number,
  reserved: number[] = [],
): number {
  const bytes = loadSave(projectDirectory, romTitle, slot)
  if (!bytes) throw new Error(`save ${slot} does not exist`)
  const copy = nextFreeSlot(projectDirectory, romTitle, reserved)
  storeSave(projectDirectory, romTitle, copy, bytes)
  const label = readLabels(savesDir(projectDirectory))[slotFile(romTitle, slot)]
  if (label) labelSave(projectDirectory, romTitle, copy, `${label} (copy)`)
  return copy
}

/** Set a slot's label; an empty one clears it. */
export function labelSave(
  projectDirectory: string,
  romTitle: string,
  slot: number,
  label: string,
): void {
  checkSlot(slot)
  setLabel(savesDir(projectDirectory), slotFile(romTitle, slot), label)
}

function setLabel(dir: string, file: string, label: string): void {
  const clean = label.trim().slice(0, MAX_LABEL_LENGTH)
  const labels = readLabels(dir, true)
  if ((labels[file] ?? '') === clean) return
  if (clean) labels[file] = clean
  else delete labels[file]
  writeLabels(dir, labels)
}

/**
 * Other .srm files in saves/: not this title's numbered slots, typically a
 * save from another emulator named after the ROM file. Listed so the user
 * can import one; never renamed without being asked.
 */
export function listForeignSaves(projectDirectory: string, romTitle: string): string[] {
  const dir = savesDir(projectDirectory)
  migrateLegacy(dir, romTitle)
  if (!fs.existsSync(dir)) return []
  const ours = new Set(listSaves(projectDirectory, romTitle).map(s => s.file))
  return fs
    .readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.srm') && !ours.has(f))
    .filter(f => fs.statSync(path.join(dir, f)).isFile())
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Move a foreign save into the next free slot (skipping `reserved`),
 * labelled with the name it had. `file` must be one listForeignSaves
 * returns: a bare name in saves/, so this cannot reach outside it.
 */
export function importSave(
  projectDirectory: string,
  romTitle: string,
  file: string,
  reserved: number[] = [],
): number {
  if (!listForeignSaves(projectDirectory, romTitle).includes(file)) {
    throw new Error(`not a save file to import: ${file}`)
  }
  const dir = savesDir(projectDirectory)
  const size = fs.statSync(path.join(dir, file)).size
  if (size === 0 || size > MAX_SAVE_BYTES) {
    throw new Error(`refusing a ${size}-byte save file (limit ${MAX_SAVE_BYTES})`)
  }
  const slot = nextFreeSlot(projectDirectory, romTitle, reserved)
  checkSlot(slot)
  const target = slotFile(romTitle, slot)
  renameWithRetry(path.join(dir, file), path.join(dir, target))
  try {
    setLabel(dir, target, file.slice(0, -'.srm'.length))
  } catch {
    /* imported; a broken labels.json only leaves it unlabelled */
  }
  return slot
}

/**
 * The pre-slot `game.srm` becomes slot 1, or the next free number when slot
 * 1 is taken: never left on disk where no list shows it.
 */
function migrateLegacy(dir: string, romTitle: string): void {
  const legacy = path.join(dir, LEGACY_SAVE)
  if (!fs.existsSync(legacy)) return
  let n = 1
  while (fs.existsSync(path.join(dir, slotFile(romTitle, n)))) n++
  fs.renameSync(legacy, path.join(dir, slotFile(romTitle, n)))
}

/**
 * Written to a temporary file, flushed to disk, and renamed over the old
 * one, so a killed backend mid-write leaves the previous file intact rather
 * than half of one. On a failure the temporary file is removed.
 */
function atomicWrite(file: string, bytes: Uint8Array): void {
  const tmp = `${file}.tmp`
  try {
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeSync(fd, bytes)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    renameWithRetry(tmp, file)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * Windows refuses a rename over a file another process has open (OneDrive,
 * an antivirus scan, an editor) with EPERM or EBUSY, usually for moments.
 */
function renameWithRetry(from: string, to: string, attempts = 5): void {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (i >= attempts || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      // Synchronous back-off: callers expect a finished write when this returns.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * i)
    }
  }
}
