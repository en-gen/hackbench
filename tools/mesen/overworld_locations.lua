-- overworld_locations.lua
-- Reads the overworld location table from WRAM and flags from $7E1EA2
-- to discover which translevel number each overworld location points to.
--
-- $7E13BF  — overworld location data table (96 entries)
-- $7E1EA2  — overworld level setting flags (96 bytes, one per location)
--            byte format: bmesudlr  (b=beaten, m=midway, e=unused, s/u/d/l/r=paths)
--
-- The location table entries contain the tile position on the overworld.
-- The translevel for each location is stored at $7E0D9F per entry, OR in a
-- separate block. This script tries several candidate layouts.
--
-- HOW TO USE: Load this on the TITLE SCREEN or OVERWORLD — NOT in a level.
-- The WRAM tables are populated after the overworld is initialized.

local BASE_FLAGS   = 0x1EA2   -- 96 flag bytes
local BASE_LOC     = 0x13BF   -- location table (byte width per entry unknown — we probe)
local ENTRY_COUNT  = 96

local function rb(addr) return emu.read(addr, emu.memType.wram) or 0 end
local function rw(addr) return rb(addr) | (rb(addr+1) << 8) end

-- Read the 96 flag bytes
local flags = {}
for i = 0, ENTRY_COUNT - 1 do
  flags[i] = rb(BASE_FLAGS + i)
end

-- Count how many have any flag set (beaten = bit 7)
local beaten = 0
for i = 0, ENTRY_COUNT - 1 do
  if (flags[i] & 0x80) ~= 0 then beaten = beaten + 1 end
end
emu.log(string.format("$7E1EA2 flags: %d of 96 locations beaten", beaten))
emu.log("Flags (hex, first 32): " .. table.concat((function()
  local t = {}
  for i = 0, 31 do t[#t+1] = string.format("%02X", flags[i]) end
  return t
end)(), " "))

-- Try to find translevel data.
-- In SMW the overworld event table is decompressed to WRAM somewhere.
-- Known candidate: $7E0D9F + something, $7ED000+, $7EC800+
-- Strategy: dump $7E1300-$7E1500 in hex to see the location table structure.
emu.log("\n--- WRAM $13BF-$147E (location table area, 192 bytes) ---")
for row = 0, 11 do
  local offset = row * 16
  local addr = 0x13BF + offset
  if addr > 0x147F then break end
  local s = string.format("  $%04X: ", addr)
  for i = 0, 15 do
    s = s .. string.format("%02X ", rb(addr + i))
  end
  emu.log(s)
end

-- Also dump $7E1D8B (sometimes cited as overworld translevel table)
emu.log("\n--- WRAM $1D8B-$1DCA (translevel candidate area, 64 bytes) ---")
for row = 0, 3 do
  local addr = 0x1D8B + row * 16
  local s = string.format("  $%04X: ", addr)
  for i = 0, 15 do
    s = s .. string.format("%02X ", rb(addr + i))
  end
  emu.log(s)
end

-- Dump the area around $0DBF (changed during our cursor test)
emu.log("\n--- WRAM $0D90-$0DFF (overworld state area, 112 bytes) ---")
for row = 0, 6 do
  local addr = 0x0D90 + row * 16
  local s = string.format("  $%04X: ", addr)
  for i = 0, 15 do
    s = s .. string.format("%02X ", rb(addr + i))
  end
  emu.log(s)
end

-- Dump $7ED000-$7ED0BF (decompressed overworld data, first 192 bytes)
-- This is where SMW decompresses overworld ROM data at runtime
emu.log("\n--- WRAM $D000-$D0FF (decompressed overworld data start) ---")
for row = 0, 15 do
  local addr = 0xD000 + row * 16
  local s = string.format("  $%04X: ", addr)
  for i = 0, 15 do
    s = s .. string.format("%02X ", rb(addr + i))
  end
  emu.log(s)
end

-- Try $7EDA00-$7EDA7F (another candidate for translevel table)
emu.log("\n--- WRAM $DA00-$DA7F (translevel candidate) ---")
for row = 0, 7 do
  local addr = 0xDA00 + row * 16
  local s = string.format("  $%04X: ", addr)
  for i = 0, 15 do
    s = s .. string.format("%02X ", rb(addr + i))
  end
  emu.log(s)
end

emu.log("\nDone. Check the hex dumps to find the overworld translevel table.")
emu.log("The translevel table should contain values $000-$1FF (9-bit level indices).")
