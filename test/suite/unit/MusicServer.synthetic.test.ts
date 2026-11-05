/**
 * MusicServiceImpl's refusal path: a project whose ROM is not on this machine
 * is a RESULT, one whose ROM cannot be read is a throw (#1006).
 *
 * Synthetic registry, no ROM. MusicServiceImpl imports @theia/core, which
 * CI's unit job does not install, hence the skipIf (as OverworldDecode.test.ts).
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'

const theiaInstalled = existsSync(
  resolve(__dirname, '../../../theia/node_modules/@theia/core/package.json'),
)

async function serviceOver(entry: unknown) {
  const { MusicServiceImpl } = await import('../../../theia/extension/src/node/music-server')
  return Object.assign(new MusicServiceImpl(), { workingRoms: { get: () => entry } })
}

describe.skipIf(!theiaInstalled)('MusicServiceImpl refusals', () => {
  const baseRom = { title: 'Some Hack', sha256: 'x', size: 1 }

  it('loadMusic on a ROM that is not located returns the result', async () => {
    const svc = await serviceOver({ status: 'rom-not-located', baseRom })
    expect(await svc.loadMusic('p.hbproj')).toEqual({ status: 'rom-not-located', baseRom })
  })

  it('loadBank and loadSfx do the same', async () => {
    const svc = await serviceOver({ status: 'rom-not-located', baseRom })
    expect(await svc.loadBank('p.hbproj', 'level')).toEqual({ status: 'rom-not-located', baseRom })
    expect(await svc.loadSfx('p.hbproj')).toEqual({ status: 'rom-not-located', baseRom })
  })

  it('loadMusic on an unreadable ROM throws with the reason', async () => {
    const svc = await serviceOver({ status: 'unreadable', reason: 'truncated at 12 bytes' })
    await expect(svc.loadMusic('p.hbproj')).rejects.toThrow('truncated at 12 bytes')
  })

  it('the spc methods answer null for either refusal', async () => {
    for (const entry of [
      { status: 'rom-not-located', baseRom },
      { status: 'unreadable', reason: 'bad' },
    ]) {
      const svc = await serviceOver(entry)
      expect(await svc.trackSpc('p.hbproj', 'level', 1)).toBeNull()
      expect(await svc.sfxSpc('p.hbproj', 0x1dfa, 1)).toBeNull()
    }
  })
})
