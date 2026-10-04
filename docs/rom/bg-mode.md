# The level BG mode

`src/rom/BgMode.ts` reads which BG mode a level runs in. The map view stacks its
four planes in mode 1 order (BG1 high > BG2 high > BG1 low > BG2 low), so a ROM
that does not run mode 1 gets a "layer order unverified" note, not a refusal.

## What the game does

- The level loader builds MainBGMode from header byte 3 as `(byte & $80) >> 4 | imm`:
  `AND #$80`, four `LSR`, `ORA #$01`, `STA MainBGMode` (SMWDisX `bank_05.asm:591-597`,
  at `$058568` on a stock ROM). The mode is that ORA operand, `& 7`; bit 3 of the stored value is
  layer 3 priority.
- LoadLevel reaches that routine with `JSR CODE_0584E3` and then `JSR CODE_0581FB`
  (`bank_05.asm:428-429`, `$0583B2`), followed by `LDA LevelModeSetting / CMP / BEQ`
  (`bank_05.asm:431-433`).
- The IRQ copies MainBGMode to `$2105`: `LDA.B MainBGMode / STA.W HW_BGMODE`
  (`bank_00.asm:463-465`, `$0083A8`).

## What the reader pins

Each pattern must match exactly once; the STA operand of the write must be the dp the IRQ
copy loads; the call's entry must put the write within `0xC0` bytes of it (`0x85` stock). A reason
names which step failed: write absent or doubled, call not found, code after the call replaced,
IRQ copy absent or doubled.

## Measured (2026-10-04, 6-ROM corpus)

Stock vanilla and the magic-edited ROM read mode 1. Grand Poo World 2 1.1, 1.2, Invictus and Seven
Vanilla Levels hook LoadLevel: the `JSR` pair at `$0583B2` is intact but the code after it is
replaced by a `JSL`, so they read as "code after the call is replaced". Three of the four also carry NOPs at `$058562-$058565`, just before the write. Nothing
here follows a hook.
