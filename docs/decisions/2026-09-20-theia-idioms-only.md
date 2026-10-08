Ruled 2026-09-20 (Brian)

## Question

Which shell does HackBench use, and may widgets mix in raw Lumino?

## Options considered

Eclipse Theia; a Lumino-only shell on `@lumino/application`.

## Ruling

Owner ruling 2026-09-20, issue #382 (closed), wording not recorded. Theia desktop app; work in Theia idioms, never import `@lumino/*` directly. `[EST]`

## Why

- Chosen for the plugin host, VS Code extension API compatibility and process isolation, not look or speed. `[EST]`
- Speed measured equal: 60 fps for canvas plus the WASM emulator, 5 ms median input latency, both shells. `[EST]`
- Lumino-only has real DI and runtime activate/deactivate (JupyterLab) but no process isolation and no VS Code API compatibility. `[EST]`
- Accepted cost: 570 packages, 733 MB node_modules, 29.8 MB JS bundle, a C++ toolchain for contributors (`drivelist`, `native-keymap` ship no prebuilt binaries). End users compile nothing. `[EST]`
- Rendering: bake the level once and blit per frame. Per-frame repaint of every Map16 cell measured 30 fps and 66 ms latency against 59.9 fps and 5 ms. `[EST]`
- Theming: `MonacoThemingService.registerParsedTheme()` takes VS Code theme JSON. Theme files are JSONC (`JSON.parse` fails) and carry no `type` field (derive light/dark from the include chain or `editor.background` luminance). `[EST]`

## Applies to

Widgets extend `BaseWidget` from `@theia/core` and register through `WidgetFactory`. Tracking: #391 scaffold, #392 themes, #393 map editor widget. Evidence is in the owner's notes repository (experiment 2026-09-20, Theia vs Lumino shell).
