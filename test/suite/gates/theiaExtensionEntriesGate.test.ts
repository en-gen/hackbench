/**
 * Theia 1.75 loads `frontendElectron || frontend` per theiaExtensions entry
 * (@theia/application-package application-package.js), so an entry carrying
 * both silently drops its browser frontend module from the Electron app: the
 * emulator view vanished that way. Electron-only modules need their own entry.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

interface Entry {
  frontend?: string
  frontendElectron?: string
}

export function entriesWithBoth(entries: Entry[]): Entry[] {
  return entries.filter(e => e.frontend && e.frontendElectron)
}

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../theia/extension/package.json'), 'utf8'),
) as { theiaExtensions: Entry[] }

describe('theia/extension/package.json theiaExtensions', () => {
  it('no entry carries both frontend and frontendElectron', () => {
    expect(entriesWithBoth(pkg.theiaExtensions)).toEqual([])
  })

  it('the check can fail: it flags a planted entry', () => {
    const planted = [{ frontend: 'a', frontendElectron: 'b' }, { frontend: 'c' }]
    expect(entriesWithBoth(planted)).toEqual([planted[0]])
  })

  it('the os-locale Electron module is registered', () => {
    expect(pkg.theiaExtensions.some(e => e.frontendElectron?.includes('os-locale'))).toBe(true)
  })
})
