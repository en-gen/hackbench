/**
 * Edit what the hack says about itself.
 *
 * Separate from creating a project on purpose. At minute zero nobody knows
 * their hack's summary, and a creation dialog that asks is asking a question
 * whose honest answer is "not yet". These are things you fill in once the hack
 * exists, and change repeatedly after that.
 *
 * The base ROM and the creation date are shown but not editable: they are
 * facts about the project rather than opinions, and changing the ROM
 * would leave the patch layers pointed at a different game.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { AbstractDialog } from '@theia/core/lib/browser'
import { FileDialogService } from '@theia/filesystem/lib/browser'
import { EmulatorService } from '../common/emulator-protocol'
import { HackMetadataDto, ProjectDto, ProjectService } from '../common/project-protocol'

import { CORE_FILTER, ROM_FILTER } from './file-filters'

/** Both hashes, shortened: the user needs to see they differ, not read 64 digits. */
export function describeRomMismatch(check: { picked: string; expected: string }): string {
  return (
    `That is a different ROM (sha256 ${check.picked.slice(0, 12)}…); ` +
    `this project needs ${check.expected.slice(0, 12)}…`
  )
}

@injectable()
export class ProjectPropertiesDialog extends AbstractDialog<HackMetadataDto | undefined> {
  protected readonly titleField = document.createElement('input')
  protected readonly authorsField = document.createElement('input')
  protected readonly versionField = document.createElement('input')
  protected readonly summaryField = document.createElement('textarea')
  protected readonly factsNode = document.createElement('div')

  protected readonly romPathField = document.createElement('input')
  protected readonly corePathField = document.createElement('input')
  protected readonly pathError = document.createElement('div')

  protected project: ProjectDto | undefined

  /**
   * Picks made with Browse..., applied by the caller on Save. The dialog
   * persists nothing itself, so Cancel discards them with the dialog.
   */
  pendingRomPath: string | undefined
  pendingCorePath: string | undefined

  @inject(ProjectService) protected readonly projects!: ProjectService
  @inject(EmulatorService) protected readonly emulator!: EmulatorService
  @inject(FileDialogService) protected readonly fileDialog!: FileDialogService

  constructor() {
    super({ title: 'Project Properties' })

    this.contentNode.appendChild(this.row('Title', this.titleField, 'the hack’s name'))
    this.contentNode.appendChild(this.row('Authors', this.authorsField, 'comma separated'))
    this.contentNode.appendChild(this.row('Version', this.versionField, '0.1.0'))
    this.contentNode.appendChild(this.textArea('Summary', this.summaryField, 'what is this hack?'))

    // Read-only, and visibly so: these identify the project rather than
    // describe it.
    this.factsNode.className = 'hb-dialog-facts'
    this.contentNode.appendChild(this.factsNode)
    this.contentNode.appendChild(this.workstationSection())

    this.appendAcceptButton('Save')
    this.appendCloseButton('Cancel')
  }

  protected row(label: string, input: HTMLInputElement, placeholder: string): HTMLElement {
    const row = document.createElement('div')
    row.className = 'hb-dialog-row'
    const l = document.createElement('label')
    l.textContent = label
    l.className = 'hb-dialog-label'
    input.className = 'theia-input'
    input.placeholder = placeholder
    row.appendChild(l)
    row.appendChild(input)
    return row
  }

  protected textArea(label: string, input: HTMLTextAreaElement, placeholder: string): HTMLElement {
    const row = document.createElement('div')
    row.className = 'hb-dialog-row'
    const l = document.createElement('label')
    l.textContent = label
    l.className = 'hb-dialog-label'
    input.className = 'theia-input hb-dialog-summary'
    input.placeholder = placeholder
    input.rows = 3
    row.appendChild(l)
    row.appendChild(input)
    return row
  }

  protected workstationSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'hb-dialog-facts'
    const heading = document.createElement('strong')
    heading.textContent = 'Local workstation'
    const note = document.createElement('div')
    note.textContent = 'These paths are stored on this workstation, not in the project.'
    section.append(heading, note)
    section.appendChild(this.pathRow('ROM location', this.romPathField, () => this.browseRom()))
    section.appendChild(this.pathRow('Emulator core', this.corePathField, () => this.browseCore()))
    const coreNote = document.createElement('div')
    coreNote.textContent = 'The emulator core applies to all projects.'
    this.pathError.className = 'hb-dialog-error'
    section.append(coreNote, this.pathError)
    return section
  }

  protected pathRow(
    label: string,
    field: HTMLInputElement,
    browse: () => Promise<void>,
  ): HTMLElement {
    const row = this.row(label, field, '')
    field.readOnly = true
    const button = document.createElement('button')
    button.className = 'theia-button secondary'
    button.textContent = 'Browse...'
    // A rejected RPC (unreadable file, backend gone) shows inline rather than
    // vanishing as an unhandled rejection.
    button.onclick = () =>
      void browse().catch(err => {
        this.pathError.textContent = (err as Error).message
      })
    row.appendChild(button)
    return row
  }

  protected async pickFile(
    title: string,
    filters: Record<string, string[]>,
  ): Promise<string | undefined> {
    const uri = await this.fileDialog.showOpenDialog({
      title,
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters,
    })
    return uri?.path.fsPath()
  }

  /** The base ROM only: a different ROM is refused inline, the field unchanged. */
  protected async browseRom(): Promise<void> {
    if (!this.project) return
    const picked = await this.pickFile("Locate this project's ROM", ROM_FILTER)
    if (!picked) return
    try {
      const check = await this.projects.checkRom(this.project.manifestPath, picked)
      if (check.status === 'mismatch') {
        this.pathError.textContent = describeRomMismatch(check)
        return
      }
    } catch (err) {
      this.pathError.textContent = (err as Error).message
      return
    }
    this.pathError.textContent = ''
    this.pendingRomPath = picked
    this.romPathField.value = picked
  }

  /** Validation is the emulator's own (`checkCore`); nothing is remembered until Save. */
  protected async browseCore(): Promise<void> {
    const picked = await this.pickFile("Select the core's Emscripten loader (.js)", CORE_FILTER)
    if (!picked) return
    const result = await this.emulator.checkCore(picked)
    if (result.status === 'invalid') {
      this.pathError.textContent = result.message
      return
    }
    this.pathError.textContent = ''
    this.pendingCorePath = picked
    this.corePathField.value = picked
  }

  /** Open against a project, prefilled with what it currently says. */
  async editFor(project: ProjectDto): Promise<HackMetadataDto | undefined> {
    this.project = project
    this.titleField.value = project.title
    // Joined for editing and split again on the way out: a comma-separated
    // list is a UI affordance, and the manifest stores real authors.
    this.authorsField.value = project.authors.join(', ')
    this.versionField.value = project.version
    this.summaryField.value = project.summary

    this.factsNode.textContent =
      `${project.baseRom.title || 'unrecognized ROM'} · ${project.baseRom.size} bytes ` +
      `· sha256 ${project.baseRom.sha256.slice(0, 12)}…`

    this.pendingRomPath = undefined
    this.pendingCorePath = undefined
    this.pathError.textContent = ''
    const paths = await this.projects.workstationPaths(project.manifestPath)
    this.romPathField.value = paths.romPath ?? 'not located'
    this.corePathField.value = paths.corePath ?? 'not set up'

    return this.open()
  }

  get value(): HackMetadataDto | undefined {
    if (!this.project) return undefined
    return {
      // Empty falls back to the project name rather than storing a blank
      // title, which would leave the hack nameless everywhere it is shown.
      title: this.titleField.value.trim() || this.project.name,
      authors: this.authorsField.value
        .split(',')
        .map(a => a.trim())
        .filter(Boolean),
      version: this.versionField.value.trim(),
      summary: this.summaryField.value.trim(),
    }
  }
}
