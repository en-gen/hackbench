/**
 * Sprites that draw only on a condition, for the reveal search (#1132). Written for this fixture; no game bytes.
 * Each handler tests one thing in WRAM (Mario's X against the sprite's, a switch cell, the frame counter) and draws
 * one 16x16 piece only when it holds, so a test can tell which condition showed it. Ids 140 and up of the
 * synthetic cart (clear of the ids and the $01:98xx-A1xx space other fixtures claim). Mario's X is $D1 (Now), the sprite's low X is $E4,X.
 *
 * 140 touch: draws when Mario's low X equals its own          145 draws tile $32 (a swapper's target)
 * 141 right: draws when Mario is 8-63 px right of it          146 swaps to id 145 on touch
 * 142 left:  draws when Mario is 8-63 px left of it           147 swaps to id $FF (past the pointer table)
 * 143 swaps to id 144 on touch (draws nothing that pass)       148 touch: rises $0F px, then draws
 * 144 draws tile $30 (a swapper's target)                     149 rises 1 px every pass, draws on touch from frame 3
 * 150 draws while the blue P-switch timer is nonzero          151 draws while the ON/OFF cell is nonzero
 * 152 mole: draws unless Mario's low-byte distance is 96-159  153 INIT faces Mario; draws on touch, flipped as INIT left it
 * 156 draws only with Mario exactly $40 px right of it
 * 154 touch: creates a sprite in slot 1 and draws nothing itself   155 draws from frame 100 on (a slow timer)
 */
const RTS = 0x60
/** Handlers sit 128 bytes apart from here (the longest is under 100); id 153 INIT follows the last. */
const FIRST = 0x01b000
const STRIDE = 0x80
const INIT_53 = 0x01b900
const lo = (a: number) => a & 0xff
const hi = (a: number) => (a >> 8) & 0xff

/**
 * Tests in order, each a guard (leaving the flags) and the branch that SKIPS the picture; a taken branch lands on the
 * RTS after the body. Offsets are counted from the end, so a test never has to know the ones after it.
 */
type Step = [guard: number[], skipIf: number]
const gated = (steps: Step[], body: number[]): number[] => {
  let after = body.length
  const out: number[][] = []
  for (const [guard, op] of [...steps].reverse()) {
    out.unshift([...guard, op, after])
    after += guard.length + 2
  }
  return [...out.flat(), ...body, RTS]
}
const BNE = 0xd0
const BCC = 0x90
const BCS = 0xb0
const BEQ = 0xf0

/**
 * One 16x16 piece at the sprite's spot minus the camera, in the slot's OAM entry; `attr` sets A to the attribute byte.
 * This cart's setup stores 4 * slot in $15EA, so the entry's size cell is $0460 + the slot, which X already holds.
 */
// prettier-ignore
const piece = (tile: number, attr: number[] = [0xa9, 0x0a]): number[] => [
  0xac, 0xea, 0x15, //                              LDY $15EA
  0x38, 0xb5, 0xe4, 0xe5, 0x1a, 0x99, 0x00, 0x03, // SEC / LDA $E4,X / SBC $1A / STA $0300,Y
  0x38, 0xb5, 0xd8, 0xe5, 0x1c, 0x99, 0x01, 0x03, // SEC / LDA $D8,X / SBC $1C / STA $0301,Y
  0xa9, tile, 0x99, 0x02, 0x03, //                  LDA #tile / STA $0302,Y
  ...attr, 0x99, 0x03, 0x03, //                     attribute / STA $0303,Y
  0xa9, 0x02, 0x9d, 0x60, 0x04, //                  LDA #2 / STA $0460,X: a 16x16 entry
]

const touch = [0xa5, 0xd1, 0xd5, 0xe4] //  LDA $D1 / CMP $E4,X: equal when Mario's low X is the sprite's
const diff = [0x38, 0xa5, 0xd1, 0xf5, 0xe4] // SEC / LDA $D1 / SBC $E4,X: Mario minus sprite, low byte
const becomes = (id: number): number[] => [0xa9, id, 0x95, 0x9e] // LDA #id / STA $9E,X

export interface RevealRoutines {
  init: Record<number, number>
  main: Record<number, number>
}

/** Writes the handlers with `put` and returns where the tables should point; the cart owns the tables. */
export function putRevealSprites(put: (snes: number, bytes: number[]) => void): RevealRoutines {
  const sees: Step = [touch, BNE]
  const mains: [number, number[]][] = [
    [140, gated([sees], piece(0x24))],
    [
      141,
      gated(
        [
          [[...diff, 0xc9, 0x08], BCC],
          [[0xc9, 0x40], BCS],
        ],
        piece(0x24),
      ),
    ],
    [
      142,
      gated(
        [
          [[...diff, 0xc9, 0xc0], BCC],
          [[0xc9, 0xf8], BCS],
        ],
        piece(0x24),
      ),
    ],
    [143, gated([sees], becomes(144))],
    [144, [...piece(0x30), RTS]],
    [145, [...piece(0x32), RTS]],
    [146, gated([sees], becomes(145))],
    [147, gated([sees], becomes(0xff))],
    // Rise $0F: SEC / LDA $D8,X / SBC #$0F / STA $D8,X, then the picture.
    [148, gated([sees], [0x38, 0xb5, 0xd8, 0xe9, 0x0f, 0x95, 0xd8, ...piece(0x24)])],
    // Rises every pass (DEC $D8,X), then draws on touch once $14 reaches 3.
    [149, [0xd6, 0xd8, ...gated([[[0xa5, 0x14, 0xc9, 0x03], BCC], sees], piece(0x24))]],
    [150, gated([[[0xad, 0xad, 0x14], BEQ]], piece(0x24))],
    [151, gated([[[0xad, 0xaf, 0x14], BEQ]], piece(0x24))],
    // CLC / ADC #$60 / CMP #$C0: draws when the sum stays below $C0 (SubHorizPos's low byte, the mole's window).
    [152, gated([[[...diff, 0x18, 0x69, 0x60, 0xc9, 0xc0], BCS]], piece(0x24))],
    // Faces by the facing byte INIT left in $157C: attribute $0A, or'd with it.
    [153, gated([sees], piece(0x24, [0xbd, 0x7c, 0x15, 0x09, 0x0a]))],
    // On touch writes a sprite into slot 1 (status 8, number 0: the plain drawer) at its own spot, and draws nothing.
    [154, gated([sees], [0xa9, 0x08, 0x8d, 0xc9, 0x14, 0xa9, 0x00, 0x85, 0x9f, 0xa5, 0xe4, 0x85, 0xe5, 0xa5, 0xd8, 0x85, 0xd9])], // prettier-ignore
    // Draws only at exactly 64 px right of it: shown from a real start there, blank at every other probe, shown by no condition.
    [156, gated([[[...diff, 0xc9, 0x40], BNE]], piece(0x24))],
    [155, gated([[[0xa5, 0x14, 0xc9, 0x64], BCC]], piece(0x24))],
  ]
  const main: Record<number, number> = {}
  for (const [id, bytes] of mains) {
    const at = FIRST + (id - 140) * STRIDE
    put(at, bytes)
    main[id] = at & 0xffff
  }
  // 53's INIT: facing 0, or $40 (X flip) when Mario is left of the sprite (CMP leaves carry set when Mario >= sprite).
  put(INIT_53, [0xa9, 0x00, 0x9d, 0x7c, 0x15, 0xa5, 0xd1, 0xd5, 0xe4, BCS, 0x05, 0xa9, 0x40, 0x9d, 0x7c, 0x15, RTS]) // prettier-ignore
  return { init: { 153: INIT_53 & 0xffff }, main }
}

export { lo, hi }
