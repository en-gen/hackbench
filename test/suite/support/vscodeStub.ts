/**
 * Stand-in for the `vscode` module, aliased in by vitest.
 *
 * `vscode` only resolves inside an extension host, which is why the tree
 * providers had no cover: reaching them used to mean downloading Electron.
 * They need six symbols from it and never activate, register a view or run a
 * command, so the host buys nothing the six cannot supply.
 *
 * `Uri` is the real `vscode-uri` package, the implementation VS Code itself
 * ships. A hand-rolled parser would only prove the tests agree with the test's
 * own idea of a URI, and the scheme and authority are exactly what the Maps
 * tree gets wrong when it gets a URI wrong.
 */
import type * as vscode from 'vscode'
import { URI } from 'vscode-uri'

export const Uri = URI

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class TreeItem {
  label?: string | vscode.TreeItemLabel
  id?: string
  iconPath?: vscode.TreeItem['iconPath']
  description?: string | boolean
  resourceUri?: vscode.Uri
  tooltip?: string | vscode.MarkdownString
  command?: vscode.Command
  collapsibleState?: TreeItemCollapsibleState
  contextValue?: string
  accessibilityInformation?: vscode.AccessibilityInformation
  checkboxState?: vscode.TreeItem['checkboxState']

  constructor(
    labelOrUri: string | vscode.TreeItemLabel | vscode.Uri,
    collapsibleState?: TreeItemCollapsibleState,
  ) {
    if (typeof labelOrUri === 'string' || !('scheme' in labelOrUri)) {
      this.label = labelOrUri
    } else {
      this.resourceUri = labelOrUri
    }
    this.collapsibleState = collapsibleState
  }
}

/**
 * Tab inputs, as far as `staleRomTabs` needs them. It narrows with
 * `instanceof` rather than duck-typing on a `uri` property, so the stub has
 * to supply real classes for the narrowing to land on.
 */
export class TabInputText {
  constructor(readonly uri: URI) {}
}

export class TabInputCustom {
  constructor(
    readonly uri: URI,
    readonly viewType: string,
  ) {}
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(e: T) => unknown>()

  readonly event: vscode.Event<T> = (listener, thisArgs?, disposables?) => {
    const bound = thisArgs ? listener.bind(thisArgs) : listener
    this.listeners.add(bound)
    const sub = {
      dispose: () => {
        this.listeners.delete(bound)
      },
    }
    disposables?.push(sub)
    return sub
  }

  // Copied before iterating: a listener that unsubscribes itself would
  // otherwise mutate the set mid-fire.
  fire(data: T): void {
    for (const l of [...this.listeners]) l(data)
  }

  dispose(): void {
    this.listeners.clear()
  }
}

/**
 * Pins the stub to the real API. If `@types/vscode` changes one of these
 * signatures the build breaks here, rather than the tests quietly going on
 * asserting against a shape VS Code no longer has. Narrowed to the members the
 * providers and commands call: the stub deliberately omits statics such as `ThemeIcon.File`
 * and `Uri.joinPath`, so asserting whole `typeof` shapes would be a lie.
 */
export const conformsToVsCodeApi: {
  TreeItem: new (label: string, state?: vscode.TreeItemCollapsibleState) => vscode.TreeItem
  TreeItemCollapsibleState: typeof vscode.TreeItemCollapsibleState
  ThemeColor: new (id: string) => vscode.ThemeColor
  ThemeIcon: new (id: string, color?: vscode.ThemeColor) => vscode.ThemeIcon
  EventEmitter: new <T>() => vscode.EventEmitter<T>
  Uri: { parse(value: string, strict?: boolean): vscode.Uri }
  TabInputText: new (uri: vscode.Uri) => vscode.TabInputText
  TabInputCustom: new (uri: vscode.Uri, viewType: string) => vscode.TabInputCustom
} = {
  TreeItem,
  TreeItemCollapsibleState,
  ThemeColor,
  ThemeIcon,
  EventEmitter,
  Uri,
  TabInputText,
  TabInputCustom,
}
