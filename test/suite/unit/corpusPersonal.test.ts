/**
 * The personal-ROM list (#1289): a `personal.txt` in the ROM folder, outside
 * git, names carts the owner keeps there that are not part of the corpus. The
 * corpus checks leave them out. Built on scratch folders of junk bytes: no ROM
 * content, so this runs in CI.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CORPUS,
  parsePersonalList,
  personalCorpusOverlap,
  personalRomsPresent,
  romsOnDisk,
  unlistedCarts,
} from '../support/corpus'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hb-personal-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const cart = (name: string): void => writeFileSync(join(dir, name), Buffer.from([1, 2, 3]))
const list = (text: string): void => writeFileSync(join(dir, 'personal.txt'), text)

describe('personal ROM list', () => {
  it('leaves a listed cart out of the listing and counts it as left out', () => {
    cart(CORPUS[0]!)
    cart('mine.sfc')
    list('mine.sfc\n')
    expect(romsOnDisk(dir)).toEqual([CORPUS[0]])
    expect(personalRomsPresent(dir)).toEqual(['mine.sfc'])
    expect(unlistedCarts(dir)).toEqual([])
  })

  it('still reports an unlisted unknown cart, so the membership guard would fail', () => {
    cart(CORPUS[0]!)
    cart('mine.sfc')
    cart('stranger.sfc')
    list('mine.sfc\n')
    expect(romsOnDisk(dir)).toContain('stranger.sfc')
    expect(unlistedCarts(dir)).toEqual(['stranger.sfc'])
    expect(personalRomsPresent(dir)).toEqual(['mine.sfc'])
  })

  it('ignores comments, blank lines, CRLF and surrounding spaces', () => {
    expect(parsePersonalList('# note\r\n\r\n  a.sfc  \r\n#b.sfc\nc.smc')).toEqual([
      'a.sfc',
      'c.smc',
    ])
    cart('a.sfc')
    cart('b.sfc')
    list('# mine\r\n\r\na.sfc\r\n')
    expect(romsOnDisk(dir)).toEqual(['b.sfc'])
  })

  it('treats a missing personal.txt as an empty list', () => {
    cart('x.sfc')
    expect(romsOnDisk(dir)).toEqual(['x.sfc'])
    expect(personalRomsPresent(dir)).toEqual([])
    expect(unlistedCarts(dir)).toEqual(['x.sfc'])
  })

  it('does not count a listed name that has no file on disk', () => {
    cart('x.sfc')
    list('ghost.sfc\n')
    expect(personalRomsPresent(dir)).toEqual([])
    expect(romsOnDisk(dir)).toEqual(['x.sfc'])
  })

  it('matches names case-insensitively in both directions', () => {
    cart('Mine.SFC')
    list('mine.sfc\n')
    expect(romsOnDisk(dir)).toEqual([])
    expect(personalRomsPresent(dir)).toEqual(['Mine.SFC'])
    rmSync(join(dir, 'Mine.SFC'))
    cart('mine.sfc')
    list('MINE.SFC\n')
    expect(romsOnDisk(dir)).toEqual([])
    expect(personalRomsPresent(dir)).toEqual(['mine.sfc'])
  })

  it('reports a CORPUS cart listed as personal, however it is cased', () => {
    list(`${CORPUS[0]!.toUpperCase()}\nmine.sfc\n`)
    expect(personalCorpusOverlap(dir)).toEqual([CORPUS[0]!.toUpperCase()])
    list('mine.sfc\n')
    expect(personalCorpusOverlap(dir)).toEqual([])
  })

  it('treats a missing folder as empty', () => {
    const gone = join(dir, 'nope')
    expect(romsOnDisk(gone)).toEqual([])
    expect(personalRomsPresent(gone)).toEqual([])
    expect(unlistedCarts(gone)).toEqual([])
  })
})
