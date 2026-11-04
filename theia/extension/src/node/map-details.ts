/**
 * Pure `mapDetails` logic for the Map view: no Theia or RPC imports, so it is
 * unit-testable the same way map16-decode.ts is (see that file's doc
 * comment). `ProjectServiceImpl.mapDetails` is a thin delegator to
 * `buildMapDetails`, which is what lets this run in CI: the unit job does
 * not install the `theia/` workspace, and a test that reaches
 * `ProjectServiceImpl` (which imports `@theia/core/shared/inversify`) fails
 * to LOAD there, skipIf or not, because that import is resolved when the
 * test file loads, not when the gated case runs.
 */
import { SmwRom } from '../../../../src/rom/SmwRom'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import type { MapDetailsDto } from '../common/project-protocol'

/**
 * Read what the map view uses of one map: its level mode. A slot whose level data cannot be read
 * answers the index alone, never a guess (see MapDetailsDto).
 */
export function buildMapDetails(rom: SmwRom, index: number): MapDetailsDto {
  const raw = rom.getLevelRawData(index)
  if (!raw) return { index }
  return { index, levelMode: parseLevelHeader(raw).levelMode }
}
