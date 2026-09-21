/**
 * The recent-projects list.
 *
 * The binding assertion is that a project the user moved or deleted is never
 * offered: a recent list whose entries fail the moment they are clicked is
 * worse than a shorter one, and "it was there yesterday" reads as data loss.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  RecentProjects, defaultRecentPath, MAX_RECENT,
} from '../../../src/project/RecentProjects'
import { PROJECT_EXT } from '../../../src/project/Project'

let tmp: string
let recent: RecentProjects

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hbrecent-'))
  recent = new RecentProjects(path.join(tmp, 'recent-projects.json'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** A manifest that exists on disk, which is all list() checks. */
function project(name: string): { manifestPath: string; name: string; title: string } {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  const manifestPath = path.join(dir, `${name}${PROJECT_EXT}`)
  fs.writeFileSync(manifestPath, '{}')
  return { manifestPath, name, title: name }
}

describe('RecentProjects', () => {
  it('remembers a project', () => {
    const p = project('One')
    recent.remember(p)
    expect(recent.list().map(e => e.name)).toEqual(['One'])
  })

  it('puts the most recently opened first', () => {
    const a = project('A')
    const b = project('B')
    recent.remember(a)
    recent.remember(b)
    expect(recent.list().map(e => e.name)).toEqual(['B', 'A'])
  })

  it('moves a reopened project to the front instead of duplicating it', () => {
    const a = project('A')
    const b = project('B')
    recent.remember(a)
    recent.remember(b)
    recent.remember(a)

    const names = recent.list().map(e => e.name)
    expect(names).toEqual(['A', 'B'])
    expect(names.filter(n => n === 'A')).toHaveLength(1)
  })

  it('survives a restart, because the point is not remembering in memory', () => {
    recent.remember(project('One'))
    const reopened = new RecentProjects(path.join(tmp, 'recent-projects.json'))
    expect(reopened.list().map(e => e.name)).toEqual(['One'])
  })

  /**
   * The assertion this class exists for. Offering a project that fails when
   * clicked is worse than a shorter list.
   */
  it('drops a project whose manifest is gone', () => {
    const a = project('A')
    const b = project('B')
    recent.remember(a)
    recent.remember(b)

    fs.rmSync(a.manifestPath)

    expect(recent.list().map(e => e.name)).toEqual(['B'])
  })

  it('forgets a vanished project permanently, not just for one listing', () => {
    const a = project('A')
    recent.remember(a)
    fs.rmSync(a.manifestPath)
    recent.list()

    // Recreating the file must not resurrect an entry we already pruned; the
    // user has to open it again for it to come back.
    fs.writeFileSync(a.manifestPath, '{}')
    expect(recent.list()).toEqual([])
  })

  it(`keeps at most ${MAX_RECENT} entries`, () => {
    for (let i = 0; i < MAX_RECENT + 5; i++) recent.remember(project(`P${i}`))
    const list = recent.list()
    expect(list).toHaveLength(MAX_RECENT)
    // The oldest fall off, not the newest.
    expect(list[0].name).toBe(`P${MAX_RECENT + 4}`)
  })

  it('forgets on request', () => {
    const a = project('A')
    recent.remember(a)
    recent.forget(a.manifestPath)
    expect(recent.list()).toEqual([])
  })

  it('clears the whole list on request', () => {
    recent.remember(project('A'))
    recent.remember(project('B'))
    recent.clear()
    expect(recent.list()).toEqual([])
  })

  it('starts empty rather than throwing when the file is corrupt', () => {
    const file = path.join(tmp, 'recent-projects.json')
    fs.writeFileSync(file, '{ not json')
    const r = new RecentProjects(file)
    expect(r.list()).toEqual([])
    r.remember(project('A'))
    expect(r.list()).toHaveLength(1)
  })

  it('lives in per-user application data, outside any project', () => {
    const p = defaultRecentPath()
    expect(path.isAbsolute(p)).toBe(true)
    expect(p).toMatch(/hackbench/i)
    expect(p.endsWith('.json')).toBe(true)
  })
})

/**
 * Proof the pruning can fail.
 *
 * A list() that returned entries unchecked would pass every case above except
 * the two vanished-manifest ones, so those are the oracle.
 */
describe('the oracle can fail', () => {
  it('an unchecked list would offer a project that no longer exists', () => {
    const a = project('A')
    recent.remember(a)
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'recent-projects.json'), 'utf8'))
    fs.rmSync(a.manifestPath)

    // What a naive implementation returns: the stored entries, as stored.
    expect(raw.projects).toHaveLength(1)
    expect(recent.list()).toEqual([])
  })
})
