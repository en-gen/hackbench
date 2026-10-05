-- Mesen 2 Lua: sprite SPAWN extractor. The recorder and the spawn mode live in
-- sprite_routine_trace.lua; this launcher selects the mode and loads it.
-- HB_ORACLE_LIB (set by spikes/sprite-oracle/scripts/run_sprite_oracle.ps1 -Mode spawn)
-- is the absolute path of sprite_routine_trace.lua. Seed contract, the fixed
-- level and what is recorded: the "mode: spawn" block in that file.
SPRITE_ORACLE_MODE = "spawn"
dofile(os.getenv("HB_ORACLE_LIB"))
