### Changed

- Maps (#927): tests pin the midway-restart Layer 1 Y high byte. The reader was already right (`L2Model.ts` entryDy, bank_05.asm:7362-7373); new synthetic tests sweep the F400 midway nibble and the screen-exit-only case, and a vanilla sweep shows 0 of 38 midway maps are vertical. Tests only, no behaviour change.
