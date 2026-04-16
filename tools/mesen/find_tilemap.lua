-- find_tilemap.lua — Find where the L1 tilemap actually lives in WRAM.
--
-- Instead of assuming $C800, scan a wide WRAM range for non-zero/non-$25
-- byte clusters that appear after level loading. Dumps any region that
-- has a concentration of non-trivial values (likely tile data).
--
-- Also watches for writes via [$6B],Y by reading $6B/$6C each frame
-- to see what address range the object handlers are targeting.
--
-- Usage: Load in Mesen2 Script Window, enter level $104.

local dumped = false

emu.addEventCallback(function()
  if dumped then return end
  local mode = emu.read(0x0100, emu.memType.wram)
  if mode ~= 0x14 then return end
  dumped = true

  local lvl = emu.read(0x1925, emu.memType.wram) | (emu.read(0x1926, emu.memType.wram) << 8)
  emu.log(string.format("Level $%04X loaded. Scanning WRAM for tilemap data...", lvl))

  -- Log the current [$6B] pointer (may still hold the last value from expansion)
  local ptr6B = emu.read(0x006B, emu.memType.wram)
  local ptr6C = emu.read(0x006C, emu.memType.wram)
  local ptr6D = emu.read(0x006D, emu.memType.wram)
  emu.log(string.format("[$6B] pointer: $%02X%02X%02X (bank:hi:lo)", ptr6D, ptr6C, ptr6B))

  -- Also check [$6E] (used by some handlers for high-byte writes)
  local ptr6E = emu.read(0x006E, emu.memType.wram)
  local ptr6F = emu.read(0x006F, emu.memType.wram)
  local ptr70 = emu.read(0x0070, emu.memType.wram)
  emu.log(string.format("[$6E] pointer: $%02X%02X%02X", ptr70, ptr6F, ptr6E))

  -- Scan WRAM in 256-byte blocks from $0000 to $FFFF
  -- Count non-zero, non-$25 bytes in each block
  emu.log("")
  emu.log("=== WRAM scan: blocks with >20 non-trivial bytes ===")
  emu.log("(trivial = $00 or $25, which is SMW's empty/air tile)")
  for block = 0, 255 do
    local base = block * 256
    local count = 0
    for i = 0, 255 do
      local b = emu.read(base + i, emu.memType.wram)
      if b ~= 0x00 and b ~= 0x25 and b ~= 0xFF then
        count = count + 1
      end
    end
    if count > 20 then
      emu.log(string.format("  $%04X-$%04X: %d non-trivial bytes", base, base + 255, count))
    end
  end

  -- Now do a focused scan of likely tilemap regions
  -- Community docs suggest $C800 for L1 low bytes, $1C00 for high bytes
  -- Let's check both plus neighboring ranges
  local candidates = {0x1C00, 0xC800, 0xC000, 0xD000, 0xD800, 0xE000}
  for _, base in ipairs(candidates) do
    local nonZero = 0
    local sample = {}
    for i = 0, 0x1FF do
      local b = emu.read(base + i, emu.memType.wram)
      if b ~= 0x00 and b ~= 0x25 then
        nonZero = nonZero + 1
        if #sample < 10 then
          table.insert(sample, string.format("$%04X=$%02X", base + i, b))
        end
      end
    end
    emu.log(string.format("\n$%04X-$%04X: %d non-trivial in first $200 bytes", base, base + 0x1FF, nonZero))
    if #sample > 0 then
      emu.log("  samples: " .. table.concat(sample, ", "))
    end
  end

  -- Dump the first 512 bytes at $C800 as hex rows
  emu.log("\n=== Raw hex at $C800 (first $100 bytes) ===")
  for row = 0, 15 do
    local addr = 0xC800 + row * 16
    local s = string.format("$%04X: ", addr)
    for col = 0, 15 do
      s = s .. string.format("%02X ", emu.read(addr + col, emu.memType.wram))
    end
    emu.log(s)
  end

  -- Dump the first 256 bytes at $1C00
  emu.log("\n=== Raw hex at $1C00 (first $100 bytes) ===")
  for row = 0, 15 do
    local addr = 0x1C00 + row * 16
    local s = string.format("$%04X: ", addr)
    for col = 0, 15 do
      s = s .. string.format("%02X ", emu.read(addr + col, emu.memType.wram))
    end
    emu.log(s)
  end

  emu.log("\n=== DONE ===")
end, emu.eventType.startFrame)

emu.log("find_tilemap.lua loaded — enter a level to scan WRAM.")
