-- cgram_dump_live.lua
-- Dumps the current CGRAM state to Mesen's script log.
-- Run from Mesen2 Script Window while a level is loaded and playing.
-- Output: one line per row, matching the format of cgram_104_yoshi_house.txt
-- but with correct little-endian word values (as Mesen Palette Viewer shows them).
--
-- Usage:
--   1. Load the ROM, enter the level you want to capture
--   2. Pause emulation (optional but ensures stable snapshot)
--   3. Run this script
--   4. Copy the "=== CGRAM DUMP ===" block from the Script Log

emu.log("=== CGRAM DUMP (live read, 256 x BGR555 words) ===")
emu.log("Format: row XX: W0000 W0001 ... W000F  (each Wxxx = 4-digit hex, LE16 word)")
emu.log("")

for row = 0, 15 do
    local words = {}
    for col = 0, 15 do
        local byteAddr = (row * 16 + col) * 2
        -- CGRAM is byte-addressed; read low then high byte
        local lo = emu.read(byteAddr,     emu.memType.cgRam)
        local hi = emu.read(byteAddr + 1, emu.memType.cgRam)
        local word = (hi * 256) + lo  -- assemble LE16 word (matches Mesen Palette Viewer 'Value')
        table.insert(words, string.format("%04x", word))
    end
    local rowHex = string.format("%X", row)
    if #rowHex == 1 then rowHex = "0" .. rowHex end
    emu.log("row " .. rowHex .. ": " .. table.concat(words, " "))
end

emu.log("")
emu.log("=== END CGRAM DUMP ===")
