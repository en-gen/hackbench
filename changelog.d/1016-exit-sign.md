### Fixed

- Maps view: the ghost house EXIT sign ($8D) is now drawn at its door, not 192 px too high (#1016). Why: the sign draws at fixed screen coordinates, X = table - Layer1XPos and Y = a bare table byte, only while Layer1XPos < $46 (SMWDisX bank_02.asm:15639-15676), so its map Y is the table byte plus the loader's Layer 1 Y; evidence: the interpreter run over all 3386 sprites of the 488 buildable vanilla maps, one machine, before and after: only the 8 $8D sprites changed ($0C4, $0EB, $0F0, $0FB, $1DA, $1E6, $1E7, $1F9), no capture compared.
