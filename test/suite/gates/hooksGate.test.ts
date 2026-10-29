/**
 * Pins the hook set (#1183, owner ruling R28): no pre-commit hook, and a
 * pre-push hook that still runs the content check. Refinement is #1163.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const hooks = path.resolve(__dirname, '../../../.githooks')

describe('git hooks', () => {
  it('has no pre-commit hook', () => {
    expect(fs.existsSync(path.join(hooks, 'pre-commit'))).toBe(false)
  })

  it('keeps pre-push running the content check', () => {
    const body = fs.readFileSync(path.join(hooks, 'pre-push'), 'utf8')
    expect(body).toContain('check-content.mjs')
    expect(body).toContain('push')
  })
})
