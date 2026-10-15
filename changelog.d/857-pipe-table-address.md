### Changed

- Pipes (#857): a comment on the pipe dispatcher put the JSL at $0DAB52; it is at $0DAB4C and the table at $0DAB50 (`handlerAddr + 18`), which the code already used. A synthetic test (no ROM) now checks every size low nibble $0..$F against the table entry at that address. Citation: SMWDisX bank_0D.asm:2288. No behaviour change.
