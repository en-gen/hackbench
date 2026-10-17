### Fixed

- Layer 3 now shows on the vertical maps $0E7 and $1CE, where the game draws it, on every screen
  (it is screen-locked there). Why: a settings byte $81-$BF on Castle1 or Underground1 reaches CODE_009FFA, which sets Layer3YPos to $C0 once (SMWDisX bank_00.asm:4175-4182), and the per-frame scroll for tileset 1 and 3 follows camera X only and jumps past the Layer3YPos = Layer1YPos copy (bank_05.asm:5515-5519, copy at :5569-5572); nothing there depends on the map being vertical. Other vertical maps with a layer 3 still say why it is not drawn.
  In vanilla only those two change (sweep test, all $200 slots, vanilla ROM only).
