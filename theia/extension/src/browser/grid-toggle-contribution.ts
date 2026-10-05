/**
 * `hackbench.gfx.toggleGrid` and `hackbench.map16.toggleGrid`: Command
 * Palette routes to each view's own grid button (no default keybinding). Each
 * is enabled only while a tab of its own view is focused, so the two views'
 * grids stay independent.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { ApplicationShell } from '@theia/core/lib/browser'
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common'
import { GfxViewWidget } from './gfx-view-widget'
import { Map16ViewWidget } from './map16-view-widget'

export const ToggleGfxGridCommand: Command = {
  id: 'hackbench.gfx.toggleGrid',
  label: 'Toggle Grid',
  category: 'Graphics',
}

export const ToggleMap16GridCommand: Command = {
  id: 'hackbench.map16.toggleGrid',
  label: 'Toggle Grid',
  category: 'Map16',
}

@injectable()
export class GridToggleContribution implements CommandContribution {
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell

  registerCommands(registry: CommandRegistry): void {
    this.register(registry, ToggleGfxGridCommand, GfxViewWidget)
    this.register(registry, ToggleMap16GridCommand, Map16ViewWidget)
  }

  protected register<T extends { toggleGrid(): void }>(
    registry: CommandRegistry,
    command: Command,
    type: abstract new (...args: never[]) => T,
  ): void {
    const target = (): T | undefined => {
      const w = this.shell.currentWidget
      return w instanceof type ? w : undefined
    }
    registry.registerCommand(command, {
      execute: () => target()?.toggleGrid(),
      isEnabled: () => !!target(),
    })
  }
}
