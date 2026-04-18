# Contributing to HackBench

Thanks for your interest in contributing! HackBench is a hobbyist
project and welcomes PRs - from documentation fixes to entirely new
editors.

## Before you start

- **License:** HackBench is released under the [MIT License](./LICENSE).
  By submitting a contribution, you agree to license it inbound under
  the same terms.
- **Code of Conduct:** contributions are subject to our
  [Code of Conduct](./CODE_OF_CONDUCT.md).
- **Never commit ROM data.** `*.smc`, `*.sfc`, `*.rom`, `*.ips`, `*.bps`
  are gitignored. Keep it that way. See [Legal](./README.md#legal).

## Setup

```bash
git clone https://github.com/en-gen/hackbench
cd hackbench
npm install
npm run compile
```

Launch the Extension Development Host with **F5** in VS Code (runs
`.vscode/launch.json` → `npm run watch` + a fresh VS Code window with
HackBench loaded).

## Commands

| Command | Purpose |
|---|---|
| `npm run compile` | Webpack dev build - extension + all webview bundles |
| `npm run watch` | Rebuild on save |
| `npm run package` | Production build (minified, hidden source maps) |
| `npm run lint` | ESLint `src/` |
| `npm run lint:fix` | Auto-fix lint |
| `npm run test:unit` | Vitest unit tests (single run) |
| `npm run test:unit:watch` | Vitest watch mode |

Run a single test file:

```bash
npx vitest run test/suite/unit/GraphicsDecoder.test.ts
```

## Branch strategy

- `main` - do not commit directly.
- `develop` - integration base. **All PRs target `develop`.**
- `feature/<short-slug>` - one concern per branch, off `develop`.

After your PR merges:

```bash
git checkout develop
git pull origin develop
git checkout -b feature/<next>
```

## Code layout

See [docs/architecture.md](./docs/architecture.md) for the full tour.
Short version:

- `src/extension.ts` - activation + provider registration
- `src/rom/` - pure ROM parsing (zero VS Code imports, fully unit-testable)
- `src/providers/` - VS Code integration (virtual FS, tree views, custom editors)
- `src/webview/<name>/main.ts` - webview entry points, bundled by webpack

## Adding a new editor

1. In `package.json`, add an entry under `contributes.customEditors`
   with a filename pattern (e.g. `**/*.smwsprites`).
2. Create `src/providers/MyEditorProvider.ts` implementing
   `CustomReadonlyEditorProvider`.
3. Create `src/webview/myEditor/main.ts`.
4. Add an entry to `webpack.config.js` under the webview configs array.
5. Register the provider in `src/extension.ts` → `activate()`.

## Pull request checklist

- [ ] Targets `develop` (not `main`)
- [ ] `npm run lint` passes
- [ ] `npm run test:unit` passes
- [ ] New behavior covered by a unit test in `test/suite/unit/`
- [ ] ROM parsing logic lives in `src/rom/` (no VS Code imports)
- [ ] No `.smc` / `.sfc` / `.rom` / `.ips` / `.bps` files staged
- [ ] User-facing changes noted in `CHANGELOG.md` under `[Unreleased]`
- [ ] Commit messages explain *why* (the *what* is in the diff)

## Commit style

One concern per commit. Subject line in the imperative mood
("Add GFX re-decode on BPP change" - not "Added..." or "Adds..."). Body
explains the motivation. See recent `git log --oneline` for examples.

## Reporting bugs & suggesting features

Use the [issue templates](https://github.com/en-gen/hackbench/issues/new/choose).
For security-sensitive reports see [SECURITY.md](./SECURITY.md).
