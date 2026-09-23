# The VS Code extension (reference only)

HackBench is a Theia and Electron desktop app. This tree is the original VS
Code extension, kept for the ROM interpretation it holds. It is not a
shipping target, is not published, and receives no new features. Do not add
features here.

It is `src/providers/`, `src/webview/`, the entry point `src/extension.ts`
and its `src/`-root helpers (`EditSession.ts`, `romPathFromCommandArg.ts`,
`romTabs.ts`, `RomSession.ts`).

It still builds with `npm run compile`, and **F5** in VS Code launches it in
an Extension Development Host.

## Virtual filesystem

Opening a ROM mounts `smwrom://<slug>/`. Each virtual file is a small JSON descriptor; the editor provider reads it and fetches actual ROM data on demand.

```
smwrom://<slug>/
  maps/000.smwmap         ← { romPath, levelIndex }
  palettes/global.smwpalette
  gfx/GFX00.smwgfx        ← { romPath, gfxIndex }
```

## Providers (`src/providers/`)

| Provider | Virtual file | Editor |
|----------|-------------|--------|
| `SmwFileSystemProvider` | - | Implements `vscode.FileSystemProvider` for `smwrom://` |
| `RomExplorerProvider` | - | TreeDataProvider sidebar |
| `MapEditorProvider` | `.smwmap` | Map tile grid + object/sprite overlay |
| `PaletteEditorProvider` | `.smwpalette` | Palette group browser |
| `GfxViewerProvider` | `.smwgfx` | Tile sheet viewer |

## Webview layer (`src/webview/`)

Webpack bundles each editor's `main.ts` into `dist/webview/<name>.js`. Communication is via `postMessage`: webview sends `{ type: 'ready' }`, extension replies `{ type: 'load', ...payload }` or `{ type: 'error', message }`. GFX viewer payload includes `rawBytes` + `defaultBpp` for client-side re-decode.

