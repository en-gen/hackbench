/**
 * The call path from a level's sprite list to the cluster spawns and draws (castle flames $E6, rotating
 * ring $E2/$E3), written for a synthetic cart: INVENTED code that is not the game's. It differs in
 * instruction choice, order and operands from the ROM's (counting up, a subtract-and-compare dispatch), so no
 * vanilla code is committed (D126, FINGERPRINT MINIMUM rule 9). The gate in CastleFlames.ts runs this code
 * on the core and asks only whether it reaches the spawn and the draw, which it does for the ids it is given.
 * Evidence scope: synthetic bytes; the vanilla ROM's own path is proven in the corpus blocks.
 */

/** JSL to the cart's ExecutePtr slot (syntheticSpriteRom.ts) from an address, not a spelled-out operand. */
const jsl = (to: number): number[] => [0x22, to & 0xff, (to >> 8) & 0xff, to >> 16]
const jmp = (to: number): number[] => [0x4c, to & 0xff, (to >> 8) & 0xff]

export const STANDIN = {
  route: 0x02a8c0,
  entry: 0x02aac0,
  loop: 0x02f808,
  dispatchCall: 0x02f821,
  flameSpawn: 0x02aa6c,
  ringSpawn: 0x02ab11,
  flameDraw: 0x02fa16,
  ringDraw: 0x02fa98,
  execPtr: 0x0086fa,
  /** The dw table after the dispatch call: type 4 is the 5th word, type 5 the 6th. */
  typeTable: 0x02f825,
} as const

/** Everything to write, as [address, bytes]. */
export function clusterPathStandIn(): [number, number[]][] {
  const s = STANDIN
  return [
    // route: the cart's shell loader site already holds the first four bytes (an id compare and branch); the rest stores the id and calls the entry
    [s.route + 4, [0x85, 0x0a, 0x20, s.entry & 0xff, s.entry >> 8, 0x60]],
    // entry: id less $E2 is 0 or 1 for the ring, 4 for the flames
    [
      s.entry,
      [
        0x38, 0xe9, 0xe2, 0xc9, 0x02, 0xb0, 0x03,
        ...jmp(s.ringSpawn),
        0xc9, 0x04, 0xd0, 0x03,
        ...jmp(s.flameSpawn),
        0x60,
      ], // prettier-ignore
    ],
    // loop: count slots up from 0; a non-empty slot branches out to the dispatcher call and back
    [
      s.loop,
      [
        0xa2, 0x00, 0xbd, 0x92, 0x18, 0xd0, 0x06, 0xe8, 0xe0, 0x14, 0x90, 0xf6, 0x6b,
        0x20, s.dispatchCall & 0xff, s.dispatchCall >> 8, 0x80, 0xf5,
      ], // prettier-ignore
    ],
    [s.dispatchCall, jsl(s.execPtr)],
    [s.typeTable + 8, [s.ringDraw & 0xff, s.ringDraw >> 8, s.flameDraw & 0xff, s.flameDraw >> 8]],
  ]
}
