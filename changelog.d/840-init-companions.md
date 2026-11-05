### Fixed

- Sprite model: a sprite whose INIT spawns companions ($61 skulls, the $1E Lakitu cloud) is credited with its own
  drawing only, so map 10a's $61 gives 1 part and map 1c4's $1E gives 2 (vanilla ROM, `layers_v5` captures, one machine,
  2026-11-04; 11 sprite records that graded wrong now grade exact, none worse) (#840). The map view still draws those
  companions with the spawner, and a spawner that draws only through its companions still draws.
