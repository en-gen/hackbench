import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  MAX_SAVE_BYTES,
  deleteSave,
  duplicateSave,
  importSave,
  labelSave,
  listForeignSaves,
  listSaves,
  loadSave,
  nextFreeSlot,
  saveBaseName,
  slotFile,
  storeSave,
} from '../../../src/project/SaveStore'

const TITLE = 'SUPER MARIOWORLD'

describe('SaveStore', () => {
  let dir: string
  const saves = (): string[] => fs.readdirSync(path.join(dir, 'saves')).sort()
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-save-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('names slots <ROM title>.<#>.srm', () => {
    expect(slotFile(TITLE, 3)).toBe('SUPER MARIOWORLD.3.srm')
    storeSave(dir, TITLE, 2, new Uint8Array([1]))
    expect(saves()).toEqual(['SUPER MARIOWORLD.2.srm'])
  })

  it('makes any header title safe as a file name, and never empty', () => {
    expect(saveBaseName('A:B/C\\D*?"<>|')).toBe('A_B_C_D______')
    expect(saveBaseName('TRAILING. ')).toBe('TRAILING')
    expect(saveBaseName('   ')).toBe('ROM')
    expect(saveBaseName(String.fromCharCode(1, 2))).toBe('__')
  })

  it('never produces a Windows device name', () => {
    for (const t of ['CON', 'nul', 'Com1', 'LPT9', 'aux', 'PRN']) {
      expect(saveBaseName(t)).toBe(`${t}_`)
    }
    expect(saveBaseName('CONTRA')).toBe('CONTRA')
  })

  it('a project with no saves has none, and slot 1 is free', () => {
    expect(listSaves(dir, TITLE)).toEqual([])
    expect(loadSave(dir, TITLE, 1)).toBeUndefined()
    expect(nextFreeSlot(dir, TITLE)).toBe(1)
  })

  it('stores and reads back each slot separately, listed in number order', () => {
    storeSave(dir, TITLE, 10, new Uint8Array([10]))
    storeSave(dir, TITLE, 2, new Uint8Array([2]))
    expect(loadSave(dir, TITLE, 2)).toEqual(new Uint8Array([2]))
    expect(loadSave(dir, TITLE, 10)).toEqual(new Uint8Array([10]))
    expect(listSaves(dir, TITLE).map(s => s.slot)).toEqual([2, 10])
    expect(nextFreeSlot(dir, TITLE)).toBe(1)
  })

  it("ignores files that are not this title's slots", () => {
    fs.mkdirSync(path.join(dir, 'saves'))
    for (const f of ['OTHER GAME.1.srm', `${TITLE}.x.srm`, `${TITLE}.0.srm`, 'notes.txt']) {
      fs.writeFileSync(path.join(dir, 'saves', f), 'x')
    }
    expect(listSaves(dir, TITLE)).toEqual([])
  })

  it('lists only numbers that can be loaded', () => {
    fs.mkdirSync(path.join(dir, 'saves'))
    fs.writeFileSync(path.join(dir, 'saves', `${TITLE}.10000.srm`), 'x')
    fs.writeFileSync(path.join(dir, 'saves', `${TITLE}.9999.srm`), 'x')
    expect(listSaves(dir, TITLE).map(s => s.slot)).toEqual([9999])
  })

  it('labels live beside the files; the file name never changes', () => {
    storeSave(dir, TITLE, 1, new Uint8Array([1]))
    labelSave(dir, TITLE, 1, '  before the castle  ')
    expect(listSaves(dir, TITLE)).toEqual([
      { slot: 1, file: 'SUPER MARIOWORLD.1.srm', label: 'before the castle' },
    ])
    labelSave(dir, TITLE, 1, '')
    expect(listSaves(dir, TITLE)[0].label).toBeUndefined()
    expect(saves()).toEqual(['SUPER MARIOWORLD.1.srm', 'labels.json'])
  })

  it('labels belong to a file, so another title sharing the folder does not inherit them', () => {
    storeSave(dir, TITLE, 1, new Uint8Array([1]))
    storeSave(dir, 'OTHER GAME', 1, new Uint8Array([2]))
    labelSave(dir, TITLE, 1, 'mine')
    expect(listSaves(dir, 'OTHER GAME')[0].label).toBeUndefined()
  })

  it('a label left by a file deleted outside HackBench does not stick to the next save there', () => {
    storeSave(dir, TITLE, 1, new Uint8Array([1]))
    labelSave(dir, TITLE, 1, 'old')
    fs.rmSync(path.join(dir, 'saves', slotFile(TITLE, 1)))
    storeSave(dir, TITLE, 1, new Uint8Array([2]))
    expect(listSaves(dir, TITLE)[0].label).toBeUndefined()
  })

  it('a labels.json with junk values shows only string labels; a broken one is never overwritten', () => {
    storeSave(dir, TITLE, 1, new Uint8Array([1]))
    const labels = path.join(dir, 'saves', 'labels.json')
    fs.writeFileSync(labels, JSON.stringify({ [slotFile(TITLE, 1)]: { not: 'a string' } }))
    expect(listSaves(dir, TITLE)[0].label).toBeUndefined()
    fs.writeFileSync(labels, '{ not json')
    expect(() => labelSave(dir, TITLE, 1, 'x')).toThrow(/not valid JSON/)
    expect(fs.readFileSync(labels, 'utf8')).toBe('{ not json')
    // Saving the game itself still works with a broken labels file.
    storeSave(dir, TITLE, 2, new Uint8Array([2]))
    expect(loadSave(dir, TITLE, 2)).toEqual(new Uint8Array([2]))
  })

  it('duplicate copies bytes and label into the next free number', () => {
    storeSave(dir, TITLE, 1, new Uint8Array([7, 7]))
    storeSave(dir, TITLE, 2, new Uint8Array([2]))
    labelSave(dir, TITLE, 1, 'world 3')
    expect(duplicateSave(dir, TITLE, 1)).toBe(3)
    expect(loadSave(dir, TITLE, 3)).toEqual(new Uint8Array([7, 7]))
    expect(listSaves(dir, TITLE).find(s => s.slot === 3)?.label).toBe('world 3 (copy)')
    expect(() => duplicateSave(dir, TITLE, 9)).toThrow(/does not exist/)
  })

  it('never hands out a reserved number: a new save chosen but not yet written', () => {
    storeSave(dir, TITLE, 1, new Uint8Array([1]))
    // Slot 2 is a New save the game has not written: no file, but taken.
    expect(nextFreeSlot(dir, TITLE, [2])).toBe(3)
    expect(duplicateSave(dir, TITLE, 1, [2])).toBe(3)
    expect(loadSave(dir, TITLE, 2)).toBeUndefined()
  })

  it('delete removes the file and its label, and frees the number', () => {
    storeSave(dir, TITLE, 1, new Uint8Array([1]))
    labelSave(dir, TITLE, 1, 'gone soon')
    deleteSave(dir, TITLE, 1)
    expect(listSaves(dir, TITLE)).toEqual([])
    expect(nextFreeSlot(dir, TITLE)).toBe(1)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'saves', 'labels.json'), 'utf8'))).toEqual({})
  })

  it('the single game.srm from before slots becomes slot 1', () => {
    fs.mkdirSync(path.join(dir, 'saves'))
    fs.writeFileSync(path.join(dir, 'saves', 'game.srm'), Buffer.from([5, 5]))
    expect(listSaves(dir, TITLE).map(s => s.file)).toEqual(['SUPER MARIOWORLD.1.srm'])
    expect(loadSave(dir, TITLE, 1)).toEqual(new Uint8Array([5, 5]))
    expect(saves()).toEqual(['SUPER MARIOWORLD.1.srm'])
  })

  it('an old game.srm next to an existing slot 1 becomes the next slot, never hidden', () => {
    storeSave(dir, TITLE, 1, new Uint8Array([1]))
    fs.writeFileSync(path.join(dir, 'saves', 'game.srm'), Buffer.from([6]))
    expect(listSaves(dir, TITLE).map(s => s.slot)).toEqual([1, 2])
    expect(loadSave(dir, TITLE, 2)).toEqual(new Uint8Array([6]))
  })

  it("lists another emulator's save, and imports it into the next slot under its old name", () => {
    storeSave(dir, TITLE, 1, new Uint8Array([1]))
    const foreign = 'Super Mario World (USA).vanilla.srm'
    fs.writeFileSync(path.join(dir, 'saves', foreign), Buffer.from([4, 4]))
    expect(listSaves(dir, TITLE).map(s => s.slot)).toEqual([1])
    expect(listForeignSaves(dir, TITLE)).toEqual([foreign])

    expect(importSave(dir, TITLE, foreign, [2])).toBe(3)
    expect(listForeignSaves(dir, TITLE)).toEqual([])
    expect(loadSave(dir, TITLE, 3)).toEqual(new Uint8Array([4, 4]))
    expect(listSaves(dir, TITLE).find(s => s.slot === 3)?.label).toBe(
      'Super Mario World (USA).vanilla',
    )
  })

  it('imports only a foreign .srm in saves/, nothing else', () => {
    storeSave(dir, TITLE, 1, new Uint8Array([1]))
    fs.writeFileSync(path.join(dir, 'outside.srm'), 'x')
    fs.writeFileSync(path.join(dir, 'saves', 'empty.srm'), '')
    for (const f of ['../outside.srm', slotFile(TITLE, 1), 'missing.srm', 'labels.json']) {
      expect(() => importSave(dir, TITLE, f)).toThrow(/not a save file to import/)
    }
    expect(() => importSave(dir, TITLE, 'empty.srm')).toThrow(/refusing/)
    expect(fs.existsSync(path.join(dir, 'outside.srm'))).toBe(true)
  })

  it('refuses bad slot numbers, empty and oversized saves', () => {
    for (const bad of [0, -1, 1.5, 10000]) {
      expect(() => storeSave(dir, TITLE, bad, new Uint8Array([1]))).toThrow(/not a save slot/)
    }
    storeSave(dir, TITLE, 1, new Uint8Array([9]))
    expect(() => storeSave(dir, TITLE, 1, new Uint8Array(0))).toThrow(/refusing/)
    expect(() => storeSave(dir, TITLE, 1, new Uint8Array(MAX_SAVE_BYTES + 1))).toThrow(/refusing/)
    expect(loadSave(dir, TITLE, 1)).toEqual(new Uint8Array([9]))
  })

  it('a write that cannot land leaves the previous save intact', () => {
    storeSave(dir, TITLE, 1, new Uint8Array([1, 1]))
    // A directory where the temporary file goes: the write fails on every
    // platform before the real save is touched.
    fs.mkdirSync(path.join(dir, 'saves', `${slotFile(TITLE, 1)}.tmp`))
    expect(() => storeSave(dir, TITLE, 1, new Uint8Array([2]))).toThrow()
    expect(loadSave(dir, TITLE, 1)).toEqual(new Uint8Array([1, 1]))
  })

  it('a rename that fails removes the temporary file', () => {
    storeSave(dir, TITLE, 1, new Uint8Array([1]))
    // A directory where the save goes: the rename fails on every platform.
    const target = path.join(dir, 'saves', slotFile(TITLE, 1))
    fs.rmSync(target)
    fs.mkdirSync(target)
    expect(() => storeSave(dir, TITLE, 1, new Uint8Array([2]))).toThrow()
    expect(saves()).toEqual([slotFile(TITLE, 1)])
  })
})
