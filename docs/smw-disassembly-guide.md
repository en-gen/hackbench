# SMW Disassembly Guide

> Reference for disassembling SMW ROM code, IPS patches, and BIN files.

## 65816 Hex Encoding (Little Endian)

The 65c816 CPU uses **little endian** byte ordering. The least significant byte (LSB) is stored first.

```
LDA $1F30  →  AD 30 1F       (AD = LDA $xxxx opcode)
JSL $123456  →  22 56 34 12  (22 = JSL opcode)
LDA #$1234  →  A9 34 12      (A9 = LDA #$xxxx in 16-bit mode)
STA $50  →  85 50             (85 = STA $xx direct page)
```

Key opcodes (see HEX2ASM reference for full table):

| Hex | Instruction | Bytes |
|-----|-------------|-------|
| `AD` | `LDA $xxxx` | 3 |
| `A9` | `LDA #$xx` / `LDA #$xxxx` | 2 or 3 (depends on M flag) |
| `8D` | `STA $xxxx` | 3 |
| `85` | `STA $xx` (direct page) | 2 |
| `A2` | `LDX #$xx` / `LDX #$xxxx` | 2 or 3 |
| `A0` | `LDY #$xx` / `LDY #$xxxx` | 2 or 3 |
| `20` | `JSR $xxxx` | 3 |
| `22` | `JSL $xxxxxx` | 4 |
| `60` | `RTS` | 1 |
| `6B` | `RTL` | 1 |
| `C2` | `REP #$xx` | 2 (set 16-bit: `C2 30` = `REP #$30`) |
| `E2` | `SEP #$xx` | 2 (set 8-bit: `E2 30` = `SEP #$30`) |
| `9D` | `STA $xxxx,X` | 3 |
| `9E` | `STZ $xxxx,X` | 3 |
| `29` | `AND #$xx` / `AND #$xxxx` | 2 or 3 |
| `18` | `CLC` | 1 |
| `69` | `ADC #$xx` / `ADC #$xxxx` | 2 or 3 |
| `E8` | `INX` | 1 |
| `88` | `DEY` | 1 |
| `10` | `BPL $xx` (relative branch) | 2 |
| `B2` | `LDA ($xx)` (indirect) | 2 |
| `E6` | `INC $xx` (direct page) | 2 |
| `C6` | `DEC $xx` (direct page) | 2 |
| `A8` | `TAY` | 1 |
| `8A` | `TXA` | 1 |
| `AA` | `TAX` | 1 |
| `98` | `TYA` | 1 |
| `0A` | `ASL A` | 1 |
| `B9` | `LDA $xxxx,Y` | 3 |

## BIN File Disassembly

1. Open `.bin` file in a hex editor (Translhextion, HxD, etc.)
2. Start at byte 0, look up the opcode in HEX2ASM
3. Read the appropriate number of operand bytes (little endian)
4. Write the instruction in ASM notation
5. Repeat until end of file

### Example

Hex bytes:
```
AD 30 1F 85 50 A2 50 A0 60 9E 34 12 6B A4 01 98
```

Disassembles to:
```asm
Code_000000: LDA $1F30
Code_000003: STA $50
Code_000005: LDX #$50
Code_000007: LDY #$60
Code_000009: STZ $1234,X
Code_00000C: RTL
Code_00000D: LDY $01
Code_00000F: TYA
```

## IPS Patch Disassembly

IPS format structure:
```
[5 bytes: "PATCH" = 50 41 54 43 48]
[3 bytes: PC offset address]
[2 bytes: size of change (big endian)]
[N bytes: the changed data/code]
... repeat offset/size/data blocks ...
[3 bytes: "EOF" = 45 4F 46]
```

### Example

```
50 41 54 43 48   → PATCH header
00 02 50         → PC offset $000250 → convert to SNES LoROM address
00 01            → 1 byte of code changed
01               → the code byte
00 02 52         → PC offset $000252
00 01            → 1 byte changed
AD               → the code byte
45 4F 46         → EOF
```

Translates to:
```asm
ORG $008250      ; (PC $000250 → SNES LoROM)
db $01

ORG $008252      ; (PC $000252 → SNES LoROM)
db $AD
```

### PC to SNES LoROM Conversion

```
SNES_bank = PC_offset / 0x8000
SNES_addr = 0x8000 + (PC_offset % 0x8000)
SNES_full = (SNES_bank << 16) | SNES_addr
```

## Using DisPel (65c816 Disassembler)

DisPel is a command-line 65c816 disassembler for SNES ROMs.

### Basic usage

Create a `.bat` file:
```bat
dispel -o output.asm ROM.smc
@pause
```

### Disassemble a specific address range

```bat
dispel -r 108000-109000 -o palette_init.asm ROM.smc
@pause
```

Where `-r START-END` specifies SNES LoROM addresses.

### Useful ranges for SMW palette code

| Range | Description |
|-------|-------------|
| `$00ABD0-$00AD20` | Palette init routine (variant tables + DMA calls) |
| `$00ACED-$00AD1D` | Palette DMA subroutines ($ACED = col-1 writer, $ACFF = block writer) |
| `$00AC06-$00ACEC` | All palette DMA parameter blocks |

## 16-bit vs 8-bit Mode

The 65816 switches between 8-bit and 16-bit accumulator/index register modes:
- `REP #$20` → 16-bit accumulator (M=0)
- `REP #$10` → 16-bit index registers (X=0)
- `REP #$30` → 16-bit both
- `SEP #$20` → 8-bit accumulator (M=1)
- `SEP #$10` → 8-bit index registers (X=1)
- `SEP #$30` → 8-bit both

This affects the size of immediate operands (`LDA #$xx` vs `LDA #$xxxx`) and must be tracked during disassembly.
