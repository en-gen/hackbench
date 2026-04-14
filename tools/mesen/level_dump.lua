-- level_dump.lua
-- Dumps the first 64 bytes of the L1 object data for the current level.
-- Run while in a level. Shows header + object bytes so we can verify the
-- screen separator format (is it FF FF, or something else?).

local function hex(v) return string.format("%02X", v) end

emu.addEventCallback(function()
  local mode = emu.read(0x0100, emu.memType.wram)
  if mode ~= 0x11 and mode ~= 0x14 then return end

  -- Read the current level's L1 pointer from WRAM
  -- $7E065B/$7E065C/$7E065D = lo/hi/bank of current L1 pointer (runtime)
  -- Actually, read from $0689xx via a known address approach.
  -- Easier: read level number from $0E and look up the pointer table.
  local lvlLo = emu.read(0x065D, emu.memType.wram)
  local lvlHi = emu.read(0x065E, emu.memType.wram)
  local lvlBk = emu.read(0x065F, emu.memType.wram)
  if lvlLo == nil then return end

  local ptr = (lvlBk << 16) | (lvlHi << 8) | lvlLo
  if ptr == 0 then return end

  emu.log(string.format("L1 ptr = $%06X", ptr))
  emu.log("First 64 bytes:")

  local bytes = {}
  for i = 0, 63 do
    local b = emu.read(ptr + i, emu.memType.prgRom)
    bytes[i] = b or 0
  end

  -- Print header (5 bytes)
  local h = string.format("  Header: %s %s %s %s %s",
    hex(bytes[0]), hex(bytes[1]), hex(bytes[2]), hex(bytes[3]), hex(bytes[4]))
  emu.log(h)
  emu.log(string.format("    bgPalette=%d  levelLength=%d  levelMode=%d",
    (bytes[0] >> 5) & 7, bytes[0] & 0x1F, bytes[1] & 0x1F))

  -- Print object bytes in rows of 16
  for row = 0, 3 do
    local offset = 5 + row * 16
    if offset >= 64 then break end
    local s = string.format("  [+%02X] ", offset)
    for i = 0, 15 do
      local idx = offset + i
      if idx < 64 then
        s = s .. hex(bytes[idx]) .. " "
      end
    end
    emu.log(s)
  end

  -- Annotate the first few objects
  emu.log("  Object parse:")
  local pos = 5
  local screen = 0
  local objCount = 0
  while pos < 64 and objCount < 12 do
    local b0 = bytes[pos]
    if b0 == 0xFF then
      if pos + 1 < 64 and bytes[pos + 1] == 0xFF then
        emu.log(string.format("    +%02X: FF FF  → screen separator (now screen %d)", pos, screen + 1))
        screen = screen + 1
        pos = pos + 2
      else
        emu.log(string.format("    +%02X: FF     → terminator", pos))
        break
      end
    else
      local y = (b0 >> 4) & 0xF
      local x = b0 & 0xF
      if y <= 0x0A then
        local b1 = bytes[pos + 1] or 0
        emu.log(string.format("    +%02X: %s %s  → std obj  x=%d y=%d screen=%d type=%X param=%X",
          pos, hex(b0), hex(b1), x, y, screen, (b1 >> 4) & 0xF, b1 & 0xF))
        pos = pos + 2
      else
        local b1 = bytes[pos + 1] or 0
        local b2 = bytes[pos + 2] or 0
        emu.log(string.format("    +%02X: %s %s %s → ext obj  x=%d ynib=%X screen=%d type=%X",
          pos, hex(b0), hex(b1), hex(b2), x, y, screen, b2))
        pos = pos + 3
      end
      objCount = objCount + 1
    end
  end

  emu.log("---")
end, emu.eventType.startFrame)

emu.log("level_dump.lua loaded. Enter a level to see the dump (fires once per frame — check first log entry).")

-- Fire only once
local fired = false
local orig = emu.addEventCallback
