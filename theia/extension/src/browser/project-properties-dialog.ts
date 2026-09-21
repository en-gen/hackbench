/**
 * Edit what the hack says about itself.
 *
 * Separate from creating a project on purpose. At minute zero nobody knows
 * their hack's summary, and a creation dialog that asks is asking a question
 * whose honest answer is "not yet". These are things you fill in once the hack
 * exists, and change repeatedly after that.
 *
 * The base ROM and the creation date are shown but not editable: they are
 * facts about the project rather than opinions, and changing the cartridge
 * would leave the patch layers pointed at a different game.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { AbstractDialog } from '@theia/core/lib/browser'
import { HackMetadataDto, ProjectDto } from '../common/project-protocol'

@injectable()
export class ProjectPropertiesDialog extends AbstractDialog<HackMetadataDto | undefined> {
  protected readonly titleField = document.createElement('input')
  protected readonly authorsField = document.createElement('input')
  protected readonly versionField = document.createElement('input')
  protected readonly summaryField = document.createElement('textarea')
  protected readonly factsNode = document.createElement('div')

  protected project: ProjectDto | undefined

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
      `${project.baseRom.title || 'unrecognised cart'} · ${project.baseRom.size} bytes `
      + `· sha256 ${project.baseRom.sha256.slice(0, 12)}…`

    return this.open()
  }

  get value(): HackMetadataDto | undefined {
    if (!this.project) return undefined
    return {
      // Empty falls back to the project name rather than storing a blank
      // title, which would leave the hack nameless everywhere it is shown.
      title: this.titleField.value.trim() || this.project.name,
      authors: this.authorsField.value.split(',').map(a => a.trim()).filter(Boolean),
      version: this.versionField.value.trim(),
      summary: this.summaryField.value.trim(),
    }
  }
}
