# The hook at UploadGFXFile's PrepareGraphicsFile call

Issue #411, follow-up to #163. Code: `src/rom/GfxUploadHook.ts`; wired into
`filterSomeRamPath` (`src/rom/GfxLoader.ts`).

## Why Y matters

`UploadGFXFile` calls `JSL PrepareGraphicsFile` and then compares Y, the file
index, against the files it sends through FilterSomeRAM
(`SMWDisX bank_00.asm:5402-5419`). The stock routine keeps Y with PHY and PLY
(`bank_00.asm:6573`, `6589`). On a ROM whose JSL goes elsewhere, the compare
is only meaningful if that code leaves Y alone.

## The hook on the corpus

On 4 of the 6 corpus ROMs (Grand Poo World 2 1.1, Grand Poo World 1.2,
Invictus 1.0, Seven Vanilla Levels) the JSL goes to `$0FF160`. Its entry
routine is byte-identical on all four (127 bytes, through its final RTL).
In mnemonics: it tests a direct-page byte and a RAM flag, and on most paths
calls helpers that save X, Y and the status register (PHX, PHY, PHP ... PLP,
PLY, PLX) and jump into the stock decompression call. One path, reached when the
direct-page byte equals `$4B` and the RAM flag holds its marker, ends with
`LDY #imm` or `LDY dp` and an RTL with no PHY/PLY around it, so Y leaves the
hook as a different index. Measured on the corpus only; one machine.

## Recognition

The entry routine is hashed with SHA-256 after zeroing the bytes that vary
between ROMs (its four JSR targets and one indexed table address), because it
is longer than the 32 bytes the house rule allows literally. `HookShape` holds
length, wild offsets and hash. A hook that does not hash to a known shape
refuses, whatever its bytes do to Y.

## The Y rule

`readHookY` walks every reachable path from the entry with 8-bit A and index
registers (the state of the stock call) and never evaluates a condition. Y
survives when on every path to the return it is never written, or its writes
sit between a PHY and its PLY. Writes are LDY, TAY, TXY, INY, DEY, MVN, MVP and
a PLY that does not pull a PHY. A call is allowed to the stock
PrepareGraphicsFile or to a routine the walk also clears. Anything else
(indirect jumps, interrupts, stack surgery, a call that changes the register
widths, an unbalanced stack, a state budget overrun) is `unknown`.

A write on any path is reported as clobbered even if other paths are unread:
a path-insensitive walk says what some path does, not what a given run does.
This is why the 4 corpus ROMs still refuse, now naming the write at
`$0FF1B3` instead of "does not call the stock PrepareGraphicsFile".
