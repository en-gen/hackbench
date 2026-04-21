/**
 * PSwitchRules.ts -- Blue P-switch Map16 substitution rules for vanilla SMW.
 *
 * Map16.ts is a pure ROM format reader and doesn't know about game behavior.
 * This module owns the "what swaps with what when the blue P-switch is
 * pressed" knowledge so the decision can live alongside the Map16 tiles that
 * need it, not buried in the loader.
 *
 * In the live game the P-switch doesn't rewrite Map16 tile IDs -- bank_00.asm
 * CODE_00F545 / CODE_00F577 only adjust collision response, and the visual
 * swap is done by overwriting the coin/used-block GFX chars in VRAM so the
 * same Map16 ID renders differently. A static map view can't replay the VRAM
 * swap cheaply, so we approximate by remapping to the Map16 tile that carries
 * the alternate graphic:
 *   - $02B, $12B (yellow coin)       -> $132 (brown used block)
 *   - $132       (brown used block)  -> $12B (yellow coin)
 *   - $029       (invisible ? block) -> $024 (? block)
 *
 * Returns the substitute tile ID, or null for tiles that don't participate.
 * A tile carrying a non-null substitute "describes itself" as having a
 * P-switch counterpart; the renderer just draws the counterpart when the
 * switch is toggled on.
 */
export function pSwitchSubstitute(tileId: number): number | null {
  switch (tileId) {
    case 0x02B:
    case 0x12B: return 0x132
    case 0x132: return 0x12B
    case 0x029: return 0x024
    default:    return null
  }
}
