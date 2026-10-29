/**
 * Pins the hook set (#1183, owner ruling R28): pre-push is the only hook.
 * Refinement is #1163. That pre-push really refuses a planted push is proven
 * in contentGate.test.ts ("the real .githooks/pre-push"), which owns the
 * throwaway-repo fixtures.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const hooks = path.resolve(__dirname, '../../../.githooks')

describe('git hooks', () => {
  it('holds exactly the pre-push hook (no pre-commit, no extra hooks)', () => {
    expect(fs.readdirSync(hooks).sort()).toEqual(['pre-push'])
  })
})
