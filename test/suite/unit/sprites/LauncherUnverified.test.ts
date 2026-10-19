import { describe, expect, it } from 'vitest'
import { launcherUnverified } from '../../../../theia/extension/src/node/map-sprites'

describe('launcherUnverified (#985)', () => {
  it('says nothing when there is no reason', () => {
    expect(launcherUnverified([])).toBeUndefined()
  })

  it('opens with the verdict and never claims the vanilla address', () => {
    const arm =
      'the extended sprite dispatch sends the arm $08 to $029F00, not the vanilla LauncherArm'
    const spawn = 'the launcher spawns sprite $45, not $44'
    expect(launcherUnverified([arm])).toBe(`Torpedo launcher unverified: ${arm}`)
    expect(launcherUnverified([arm, spawn])).toBe(`Torpedo launcher unverified: ${arm}; ${spawn}`)
    expect(launcherUnverified([arm])).not.toContain('vanilla address')
  })
})
