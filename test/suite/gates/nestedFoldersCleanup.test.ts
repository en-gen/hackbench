/**
 * #1202: nestedFoldersGate plants files in .worktrees/ and .overwatch/ and must
 * leave neither folder behind when it created them. Its first version left an
 * empty .overwatch that flipped live sessions. These cases run the cleanup on a
 * scratch dir and fail if it is removed or loosened.
 */
import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { cleanupNested, holdsSessionsFile } from '../support/nestedFolders'

const FOLDERS = ['.worktrees', '.overwatch'] as const
const made: string[] = []
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true })
})
function scratch(pre: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-'))
  made.push(root)
  for (const f of pre) fs.mkdirSync(path.join(root, f))
  const planted = FOLDERS.map(f => `${f}/__plant-1`)
  for (const p of planted) {
    fs.mkdirSync(path.join(root, p), { recursive: true })
    fs.writeFileSync(path.join(root, p, 'x.ts'), '')
  }
  return { root, planted, existed: FOLDERS.map(f => pre.includes(f)) }
}

const wiring = /afterAll\(\(\) => \{\s*cleanupNested\(repoRoot, FOLDERS, existed, planted\)/

describe('nestedFoldersGate cleanup (#1202)', () => {
  it('leaves neither folder behind in a run where neither existed', () => {
    const { root, planted, existed } = scratch([])
    cleanupNested(root, FOLDERS, existed, planted)
    for (const f of FOLDERS) expect(fs.existsSync(path.join(root, f)), f).toBe(false)
  })

  it('keeps a folder that existed, and anything another process put in it', () => {
    const { root, planted, existed } = scratch([...FOLDERS])
    fs.writeFileSync(path.join(root, '.overwatch', 'sessions.json'), '{}')
    cleanupNested(root, FOLDERS, existed, planted)
    expect(fs.existsSync(path.join(root, '.overwatch', 'sessions.json'))).toBe(true)
    expect(fs.existsSync(path.join(root, '.worktrees'))).toBe(true)
    expect(fs.existsSync(path.join(root, planted[0]))).toBe(false)
  })

  it('does not delete a created folder that another process filled', () => {
    const { root, planted, existed } = scratch([])
    fs.writeFileSync(path.join(root, '.overwatch', 'other.txt'), 'x')
    cleanupNested(root, FOLDERS, existed, planted)
    expect(fs.existsSync(path.join(root, '.overwatch', 'other.txt'))).toBe(true)
  })

  it('the gate wires its afterAll to this cleanup (the helper alone proves nothing if unused)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'nestedFoldersGate.test.ts'), 'utf8')
    expect(src).toMatch(wiring)
  })

  it('oracle: the wiring match rejects a call with other arguments, and a plant tree with sessions.json is seen', () => {
    expect('afterAll(() => { cleanupNested(repoRoot, [], [], []) })').not.toMatch(wiring)
    const { root } = scratch([])
    expect(holdsSessionsFile(root)).toBe(false)
    fs.writeFileSync(path.join(root, '.overwatch', '__plant-1', 'sessions.json'), '{}')
    expect(holdsSessionsFile(path.join(root, '.overwatch'))).toBe(true)
  })
})
