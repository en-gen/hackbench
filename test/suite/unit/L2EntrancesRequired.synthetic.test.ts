/**
 * `buildL2Inputs` takes `entrances` as a required argument (#1340): leaving it out once placed
 * Layer 2 at the primary entrance with no word in the note (#1039). Vitest does not type-check, so
 * the oracle is the `@ts-expect-error` below, checked by `npx tsc -p tsconfig.test.json` (CI
 * `static` job, ci.yml): it reports an unused directive (TS2578) once the parameter is optional
 * again. The runtime case exists only so this file registers a test; it claims nothing.
 * Synthetic 512 KiB ROM, no corpus.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { buildL2Inputs } from '../../../src/rom/model/L2Model'
import type { L1Inputs } from '../../../src/rom/model/L1Model'
import type { SmwRom } from '../../../src/rom/SmwRom'

describe('buildL2Inputs entrances parameter (#1340)', () => {
  it('compiles only with entrances given (checked by tsc, not by this assertion)', () => {
    const smw = { rom: new RomFile('synthetic.sfc', Buffer.alloc(0x80000)) } as unknown as SmwRom
    const l1 = {
      screenCount: 1,
      isVertical: false,
      header: { levelMode: 0 },
    } as unknown as L1Inputs
    // @ts-expect-error entrances is required (#1340)
    const omitted = buildL2Inputs(smw, 0, l1)
    const explicit = buildL2Inputs(smw, 0, l1, undefined)
    expect(explicit).toEqual(omitted)
  })
})
