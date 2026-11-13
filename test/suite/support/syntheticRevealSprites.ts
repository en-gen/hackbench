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
 * 157 creates a sprite in slot 1 every pass; on touch from frame 5 draws its own tile
 * 158 draws every pass; at frame 5 sets its status to 0 and leaves $FF in $9E (dead, so the number is never run)
 * 159 touch by Mario's NEXT X ($94)                       160 draws when Mario stands 16 px above it ($D3, Now Y)
 * 161 draws while any of Mario's state cells is nonzero    162 draws while all of them are zero
 * 163 all of them zero, and from frame 100 on              164 draws while Mario shares its X high byte (a 256 px reach)
 * 165 blank when (Mario - sprite) low byte is within $20 above the sprite's own Y low byte (a moving window)
 * 166 draws when Mario is 12-19 px right of it (faces by INIT) 167 the same, 12-19 px left of it
 * 168 draws when Mario is 12-19 px either side of it       170 blank only when Mario's X high byte is below its own
 * 171 draws from frame 200 on                              172 creates a child every pass; draws its own from frame 5
 * 173 draws; on touch becomes $FF (refused)                174 draws, but its INIT erases it (status 0)
 * 175 creates a child every pass; from frame 5 draws its own tile only with Mario exactly $40 px right of it
 * 176 draws tile $24 only with Mario exactly $40 px right of it (the real start), but tile $32 whenever the P-switch is on
 * 177 as 176, but the ON/OFF cell is what shows tile $32     178 as 176, but the P-switch shows the SAME tile $24 (#1365)
 */
const RTS = 0x60
// Writes a plain-drawer sprite into slot 1 at this sprite's spot (status 8, number 0).
const MAKE_CHILD = [0xa9, 0x08, 0x8d, 0xc9, 0x14, 0xa9, 0x00, 0x85, 0x9f, 0xa5, 0xe4, 0x85, 0xe5, 0xa5, 0xd8, 0x85, 0xd9] // prettier-ignore
const FRAME_5 = [0xa5, 0x14, 0xc9, 0x05] // LDA $14 / CMP #5: carry set from frame 5 on
// ORA of Mario's state cells $19, $71, $72, $73, $187A: zero only when all are (MARIO_STATE's cells).
const STATE = [0xa5, 0x19, 0x05, 0x71, 0x05, 0x72, 0x05, 0x73, 0x0d, 0x7a, 0x18]
const FACING = [0xbd, 0x7c, 0x15, 0x09, 0x0a] // LDA $157C,X / ORA #$0A: the attribute, flipped as INIT left the facing
/** Handlers sit 128 bytes apart from here (the longest is under 100); the INIT routines sit past the last (174). */
const FIRST = 0x01b000
const STRIDE = 0x80
const INIT_53 = 0x01c400
const INIT_ERASE = 0x01c480

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
const BMI = 0x30

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

/** While the cell is nonzero, draw tile $32 and stop; otherwise fall through to whatever follows. */
const cellGated = (cell: number): number[] => [
  0xad, cell & 0xff, cell >> 8, BEQ, piece(0x32).length + 1, ...piece(0x32), RTS,
] // prettier-ignore

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
    [153, gated([sees], piece(0x24, FACING))],
    // On touch writes a sprite into slot 1 (status 8, number 0: the plain drawer) at its own spot, and draws nothing.
    [154, gated([sees], MAKE_CHILD)],
    // Draws only at exactly 64 px right of it: shown from a real start there, blank at every other probe, shown by no condition.
    [156, gated([[[...diff, 0xc9, 0x40], BNE]], piece(0x24))],
    [155, gated([[[0xa5, 0x14, 0xc9, 0x64], BCC]], piece(0x24))],
    [157, [...MAKE_CHILD, ...gated([[FRAME_5, BCC], sees], piece(0x24))]],
    // LDA #$FF / STA $9E,X / LDA #1 / DEC A / STA $14C8,X
    [
      158,
      [
        ...piece(0x24),
        ...gated(
          [[FRAME_5, BCC]],
          [0xa9, 0xff, 0x95, 0x9e, 0xa9, 0x01, 0x3a, 0x9d, 0xc8, 0x14, 0xea, 0xea],
        ),
      ],
    ],
    [159, gated([[[0xa5, 0x94, 0xd5, 0xe4], BNE]], piece(0x24))],
    // CLC / LDA $D3 / ADC #$10 / CMP $D8,X: Mario's Y plus 16 is the sprite's.
    [160, gated([[[0x18, 0xa5, 0xd3, 0x69, 0x10, 0xd5, 0xd8], BNE]], piece(0x24))],
    [161, gated([[STATE, BEQ]], piece(0x24))],
    [162, gated([[STATE, BNE]], piece(0x24))],
    [
      163,
      gated(
        [
          [STATE, BNE],
          [[0xa5, 0x14, 0xc9, 0x64], BCC],
        ],
        piece(0x24),
      ),
    ],
    // LDA $D2 / CMP $14E0,X: Mario's X high byte against the sprite's.
    [164, gated([[[0xa5, 0xd2, 0xdd, 0xe0, 0x14], BNE]], piece(0x24))],
    // (Mario - sprite) low byte minus the sprite's Y low byte, under $20: blank.
    [165, gated([[[...diff, 0x38, 0xf5, 0xd8, 0xc9, 0x20], BCC]], piece(0x24))],
    [
      166,
      gated(
        [
          [[...diff, 0xc9, 0x0c], BCC],
          [[0xc9, 0x14], BCS],
        ],
        piece(0x24, FACING),
      ),
    ],
    [
      167,
      gated(
        [
          [[...diff, 0xc9, 0xed], BCC],
          [[0xc9, 0xf5], BCS],
        ],
        piece(0x24, FACING),
      ),
    ],
    // The distance's magnitude (BPL / EOR #$FF / INC A), less 12, under 8.
    [
      168,
      gated(
        [[[...diff, 0x10, 0x03, 0x49, 0xff, 0x1a, 0x38, 0xe9, 0x0c, 0xc9, 0x08], BCS]],
        piece(0x24),
      ),
    ],
    // SEC / LDA $D2 / SBC $14E0,X: blank when Mario's high byte is below the sprite's (signed).
    [170, gated([[[0x38, 0xa5, 0xd2, 0xed, 0xe0, 0x14], BMI]], piece(0x24))],
    [171, gated([[[0xa5, 0x14, 0xc9, 0xc8], BCC]], piece(0x24))],
    [172, [...MAKE_CHILD, ...gated([[FRAME_5, BCC]], piece(0x24))]],
    [173, [...piece(0x24), ...gated([sees], becomes(0xff))]],
    [174, [...piece(0x24), RTS]],
    [
      175,
      [
        ...MAKE_CHILD,
        ...gated(
          [
            [FRAME_5, BCC],
            [[...diff, 0xc9, 0x40], BNE],
          ],
          piece(0x24),
        ),
      ],
    ],
    // 176/177: LDA cell / BEQ over the alternate picture / its piece / RTS; then 156's test and the at-rest picture.
    [176, [...cellGated(0x14ad), ...gated([[[...diff, 0xc9, 0x40], BNE]], piece(0x24))]],
    [177, [...cellGated(0x14af), ...gated([[[...diff, 0xc9, 0x40], BNE]], piece(0x24))]],
    // 178: LDA $14AD / BNE to the picture / (156's test, skipping it) / the same $24 piece as the real start draws.
    [178, [0xad, 0xad, 0x14, BNE, 0x09, ...diff, 0xc9, 0x40, BNE, piece(0x24).length, ...piece(0x24), RTS]], // prettier-ignore
    // 179: Mario's low X equal to its own (diff 0) draws the $32 piece and stops; else 156's test and the $24 piece.
    [179, [...diff, 0xc9, 0x00, BNE, piece(0x32).length + 1, ...piece(0x32), RTS, ...gated([[[...diff, 0xc9, 0x40], BNE]], piece(0x24))]], // prettier-ignore
  ]
  const main: Record<number, number> = {}
  for (const [id, bytes] of mains) {
    const at = FIRST + (id - 140) * STRIDE
    put(at, bytes)
    main[id] = at & 0xffff
  }
  // 53's INIT: facing 0, or $40 (X flip) when Mario is left of the sprite (CMP leaves carry set when Mario >= sprite).
  put(INIT_53, [0xa9, 0x00, 0x9d, 0x7c, 0x15, 0xa5, 0xd1, 0xd5, 0xe4, BCS, 0x05, 0xa9, 0x40, 0x9d, 0x7c, 0x15, RTS]) // prettier-ignore
  // 174's INIT: status 1 less 1 is 0 (STA $14C8,X), so the sprite is gone before its first pass.
  put(INIT_ERASE, [0xa9, 0x01, 0x3a, 0x9d, 0xc8, 0x14, 0xea, 0xea, RTS])
  const face = INIT_53 & 0xffff
  return { init: { 153: face, 166: face, 167: face, 174: INIT_ERASE & 0xffff }, main }
}
