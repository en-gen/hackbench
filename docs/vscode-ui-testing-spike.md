# UI testing a VS Code extension: spike findings

Question: how do we test that HackBench's *extension features* work, as
opposed to its graphics? "Press the layer 1 button, layer 1 should hide."

Verdict: use Playwright driving the real VS Code Electron app. Two tiers.
The runner choice turned out to be the easy part. The hard part, and the
finding that should drive the design, is that the obvious assertion does
not work.

Evidence scope for everything below: one machine (Windows 11, VS Code
1.138.0 stable, Playwright 1.63.0, Node 26.3.1), the vanilla ROM, map
$001. Probe scripts were throwaway and are not committed.

## The finding that matters: the obvious oracle cannot fail

The natural test is "click `#btn-l1`, assert the button lost its `on`
class." That test is hollow.

`wireLayerBtn` (`src/webview/mapEditor/main.ts:1783-1792`) does three
things on click: flip the backing checkbox, dispatch `change` so
`syncLayerTogglesFromDom` updates the store, and toggle the button's own
`on` class. The class toggle reads the *checkbox*, not the store. So if
the store link breaks, the button still looks correct.

I planted exactly that defect in the built bundle, deleting the
`chk.dispatchEvent(new Event('change'))` call, and ran both candidate
oracles against the real map editor in real VS Code:

| Oracle | Clean bundle | Defect planted | Can it fail? |
|---|---|---|---|
| `#btn-l1` class attribute | `on` removed | `on` removed | No. Byte-identical report. |
| `#model-canvas` pixel hash | `4370dc9b` to `c85dd9d1` | `4370dc9b` to `4370dc9b` | Yes. Caught it. |

The class oracle produced an identical green result with the feature
broken. The canvas hash caught it, because hiding layer 1 is a claim
about what got rendered, and only the canvas knows that.

This is not a graphics-correctness test. It never asserts what the
pixels should be, only that they *changed* when the toggle was pressed.
That keeps it outside the map-rendering diff oracle's territory while
still being an oracle that can go red.

Supporting detail: the pre-click hash was `4370dc9b` on both cold
launches, so the render is stable enough to hash. That is 2 runs, one
machine, one map. It is not a determinism claim.

## Two runners probed

### Probe A: Playwright driving real VS Code (recommended)

Works, end to end, with no wrapper library. The full chain verified:

1. `electron.launch({ executablePath: <Code.exe> })` with
   `--extensionDevelopmentPath` pointing at the repo. Workbench up in
   about 2 seconds.
2. HackBench activates and registers its commands. The palette lists
   `HackBench: Open ROM…`, `HackBench: Close ROM`,
   `HackBench: Focus on HackBench View`, `View: Show HackBench`.
3. Opening a ROM populates the tree view: 26 rows, real level names
   (`VANILLA SECRET 2$001`, `TOP SECRET AREA$003`).
4. Double-clicking a tree row opens the custom editor.
5. The webview is reachable by piercing two frames:
   `frameLocator('iframe.webview.ready').frameLocator('#active-frame')`.
6. Inside it: 22 toolbar buttons, `#btn-l1` clickable, `#model-canvas`
   readable via `getImageData`.

That covers all three surfaces at once: extension host, webview, and the
end-to-end flow between them.

### Probe B: the webview bundle in a plain Chromium page

Also works, and is much cheaper, but cannot currently assert anything
useful.

`dist/webview/mapEditor.js` boots in a bare page with zero console
errors, given a six-line `acquireVsCodeApi` shim (the bundle calls it at
module scope, `main.ts:11`) and a `<div id="app">`. All 22 toolbar
buttons render, `#btn-l1` responds to clicks, and the webview posts its
`ready` handshake.

The problem: with no `load` payload the canvas never paints, so the only
oracle that can fail is unavailable. I instrumented
`CanvasRenderingContext2D` to count draw operations and got 0 before and
0 after the click, on both clean and mutant bundles.

To make this tier useful, something has to feed it a payload. A captured
real payload cannot be committed: `tools/scripts/check-staged-content.sh`
blocks ROM-derived bytes, and that rule is correct. So the payload would
have to come from extending `test/suite/support/syntheticRom.ts` to
cover what `MapEditorProvider` sends, which is real work and is why this
tier is second, not first.

## Options ruled out

| Option | Why not |
|---|---|
| `@vscode/test-web` + browser VS Code | HackBench is not a web extension. `RomFile.ts:1` and `GfxLoader.ts:23-24` import `fs`. Would require restructuring ROM I/O. |
| `@vscode/test-cli` / `@vscode/test-electron` alone | API only. Runs Mocha inside the extension host with full VS Code API access, but cannot click anything. Useful as a complement, not as the UI tier. |
| `@mshanemc/vscode-test-playwright` | Version 0.0.1-beta14, last published 2025-06-02, single maintainer, no peer deps declared. It wraps roughly the 60 lines of launch code that Probe A wrote directly. Not worth the dependency. |
| `vscode-extension-tester` (ExTester) | Genuinely viable: 8.27.0, last published 2026-09-14, actively maintained, page objects for webviews, Windows and CI supported. Rejected on fit, not quality. It is Selenium plus Mocha, a second test stack alongside the existing Vitest, and its webview page object is a thinner abstraction than Playwright's native nested `frameLocator`. Revisit if Playwright's frame piercing proves brittle across VS Code versions. |

## Blockers and work items found

**1. `openRom` cannot be driven by a test.** FIXED, see
`src/romPathFromCommandArg.ts`. It called
`vscode.window.showOpenDialog()` unconditionally, a native OS dialog
that Playwright cannot touch.

The fix is already justified on its own merits. The command is
contributed to `explorer/context` for `.sfc` and `.smc` files
(`package.json`), and VS Code passes the right-clicked URI as the first
argument, but the registration discards it:

```ts
vscode.commands.registerCommand('hackbench.openRom', () =>
  openRomCommand(context, fsProvider, mapsProvider, resourcesProvider)
)
```

So right-clicking a ROM in the Explorer today ignores the file you
clicked and opens a dialog anyway. Accepting an optional
`vscode.Uri` argument fixes that bug and unblocks E2E in the same
change. No test-only backdoor needed.

**2. Quick-open cannot reach `smwrom://` files.** They are not workspace
files, so `Ctrl+P` finds nothing. Tests must open maps by clicking the
tree row. This is correct behaviour, just worth writing down.

**3. The webview HTML shell lives in the provider.** `_buildHtml`
(`src/providers/MapEditorProvider.ts:460-489`) is a private method, so a
standalone harness has to duplicate the shell. If tier 2 gets built,
extract the shell into a pure function shared by provider and harness.
Incidentally, the SPC stub DOM turned out not to be required for the map
editor to boot: the bundle loaded clean without it.

**4. `MAX_PATH` bites at 260 characters, but not where it matters.** My
scratchpad put `workbench.html` at 295 characters and VS Code failed to
load with `ERR_FILE_NOT_FOUND` on a file that demonstrably existed. A
directory junction does not help, since Electron resolves it back to the
real path. Worth knowing because the error message is misleading, but
`.vscode-test` at the repo root gives 146 characters, so the normal
setup has no problem. CI on Windows should keep the checkout path short.

**5. Isolate the extension host.** Without `--extensions-dir` pointing
at an empty temp directory, the probe loaded my real installed
extensions. Tests must pass `--user-data-dir` and `--extensions-dir` as
fresh temp directories.

## Recommended shape

Tier 1, build this first. Playwright plus real VS Code, covering the
flows that span processes: ROM opens, tree populates, map opens, toolbar
toggles change the render. Assert on the canvas hash, not on CSS classes.

Built as `test/e2e/`, run with `npm run test:e2e`. Ten tests, and the
whole suite takes 10 to 17 seconds, measured over 5 consecutive clean
runs on one machine, all green. That is fast enough to run pre-merge
without complaint.

Getting there depended on one decision worth recording: the workbench
fixture is worker-scoped, so the run boots VS Code once and opens the
ROM once. The first version launched a fresh VS Code per test, which
took 8.6 minutes and failed 4 of 10, because opening the ROM through the
Explorer context menu is the fragile step and each test repeated it.
Per-test isolation comes from opening and closing the editor tab
instead, which is cheap: these panels set `retainContextWhenHidden:
false`, so a closed tab is a disposed webview.

Tier 2, only if tier 1 proves too slow to iterate on. The standalone
webview harness, gated on extending `syntheticRom.ts` to emit a map
payload. Fast enough for the watch loop. Do not build it before tier 1,
because until the synthetic payload exists it can only host oracles that
cannot fail.

Keep `@vscode/test-electron` as a dependency either way. Tier 1 needs it
to download and pin the VS Code build, which is the one job the official
tooling does better than anything else.

Whatever gets written, the mutation test above should be committed
alongside it, per the repo rule that oracles must be proven able to
fail. The `chk.dispatchEvent` deletion is a good planted defect: it is
one line, it is realistic, and it defeats the naive test.

## Things that cost time, recorded so they cost it once

Every one of these presented as "the feature is broken" rather than "the
test is wrong".

- **A right-click on an unselected Explorer row** opens a menu with no
  resource context. Every `when` clause keyed on `resourceExtname`
  evaluates false, and the contributed item is simply absent. Select the
  row first. Chasing this cost two wrong diagnoses of the `when` clause.
- **`when: "true"` is not a tautology.** VS Code parses the bare word as
  a context key, which is undefined, so the clause is false. To test
  whether a `when` clause is the problem, delete the key instead.
- **Clicking `.action-label` inside a menu item** can land without
  activating the item or dismissing the menu. The leftover
  `.context-view-block` overlay then swallows every later click, and the
  symptom appears far from the cause. Click the item, by role.
- **VS Code pools `.monaco-menu` and `.context-view-block`** and leaves
  them in the DOM and visible after dismissal, so waiting for either to
  hide never settles. Wait for the effect you actually want instead.
- **There is more than one `.quick-input-widget`** in the DOM. An
  unscoped selector finds a hidden one's rows first, and they never
  become visible. Filter to the visible widget.
- **Quick-open cannot see `smwrom://` files**, since they are not
  workspace files. Open maps by clicking the tree row.
