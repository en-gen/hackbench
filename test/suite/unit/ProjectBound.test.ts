/**
 * Which widgets a project switch must close (#628). No Theia import, so it
 * runs without a ROM or an application, as CI does.
 */
import { describe, it, expect } from 'vitest'
import { boundToOther, isProjectBound } from '../../../theia/extension/src/browser/project-bound'

const bound = (id: string, manifestPath: string | undefined) => ({
  id,
  projectBound: true as const,
  manifestPath,
})

describe('boundToOther', () => {
  it('picks views of another project and keeps views of the opening one', () => {
    const a = bound('gfx', '/a.hbproj')
    const b = bound('map', '/b.hbproj')
    expect(boundToOther([a, b], '/b.hbproj')).toEqual([a])
    expect(boundToOther([a, b], '/a.hbproj')).toEqual([b])
  })

  it('keeps a view not yet opened on anything (manifestPath undefined or empty)', () => {
    expect(boundToOther([bound('x', undefined), bound('y', '')], '/b.hbproj')).toEqual([])
  })

  it('keeps widgets that are not project-bound, even with a manifestPath field', () => {
    // The overworld view holds a field of this name and re-targets itself.
    const overworld = { id: 'overworld', manifestPath: '/a.hbproj' }
    expect(boundToOther([overworld, { id: '' }, null, 'text'], '/b.hbproj')).toEqual([])
    expect(isProjectBound(overworld)).toBe(false)
  })

  it('reports a survivor when re-run on what is still attached after a close', () => {
    // A fake shell whose close "succeeded" but left one view attached.
    const kept = bound('gfx-dirty', '/a.hbproj')
    const attachedAfterClose = [kept, bound('b-view', '/b.hbproj')]
    expect(boundToOther(attachedAfterClose, '/b.hbproj')).toEqual([kept])
    expect(boundToOther([bound('b-view', '/b.hbproj')], '/b.hbproj')).toEqual([])
  })
})
