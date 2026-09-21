/**
 * Collect what a new project needs: a base ROM, a name, and somewhere to put
 * it.
 *
 * Deliberately three plain fields rather than a wizard. The ROM is picked with
 * the platform file dialog, because typing a path to a cart is not something
 * anyone should have to do.
 *
 * Title, authors, version and summary are NOT collected here. They describe
 * what the hack is rather than what creating it needs, nobody knows their
 * summary at minute zero, and a creation dialog that asks for them is asking
 * questions to which the honest answer is "not yet". They live in Project
 * Properties, and the manifest carries sensible defaults until then.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { AbstractDialog, DialogProps } from '@theia/core/lib/browser'
import { FileDialogService, OpenFileDialogProps } from '@theia/filesystem/lib/browser'
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables'
import { MessageService } from '@theia/core/lib/common'
import { CreateProjectRequest, ProjectService } from '../common/project-protocol'
import { PROJECT_EXT } from '../../../../src/project/Project'

/** Extensions a dumped SNES cart normally carries. */
const ROM_FILTER = { 'SNES ROM': ['sfc', 'smc', 'rom'] }

@injectable()
export class NewProjectDialogProps extends DialogProps {}

@injectable()
export class NewProjectDialog extends AbstractDialog<CreateProjectRequest | undefined> {
  @inject(FileDialogService) protected readonly fileDialog!: FileDialogService
  @inject(EnvVariablesServer) protected readonly env!: EnvVariablesServer
  @inject(ProjectService) protected readonly projects!: ProjectService
  @inject(MessageService) protected readonly messages!: MessageService

  protected readonly nameField = document.createElement('input')
  protected readonly romField = document.createElement('input')
  protected readonly dirField = document.createElement('input')
  protected readonly romInfo = document.createElement('div')
  protected readonly pathPreview = document.createElement('div')

  constructor() {
    super({ title: 'New HackBench Project' })

    this.contentNode.appendChild(this.field('Project name', this.nameField, 'MyHack'))

    const romRow = this.field('Base ROM', this.romField, 'Super Mario World (USA).sfc')
    this.romField.readOnly = true
    romRow.appendChild(this.browseButton('Browse...', () => this.pickRom()))
    this.contentNode.appendChild(romRow)

    // Identity, shown back so the user can confirm they picked the right cart
    // before anything is written.
    this.romInfo.className = 'hb-dialog-rominfo'
    this.contentNode.appendChild(this.romInfo)

    const dirRow = this.field('Location', this.dirField, 'where the project folder goes')
    dirRow.appendChild(this.browseButton('Browse...', () => this.pickDirectory()))
    this.contentNode.appendChild(dirRow)

    // The project gets its OWN folder under the chosen location, so show the
    // path that will actually be written. Without it the Location field reads
    // as "put the project here", and people create the folder themselves in
    // the picker, which Theia then reports as an unreadable resource.
    this.pathPreview.className = 'hb-dialog-facts'
    this.contentNode.appendChild(this.pathPreview)
    this.nameField.oninput = () => this.updatePreview()

    this.appendAcceptButton('Create')
    this.appendCloseButton('Cancel')
  }

  protected field(label: string, input: HTMLInputElement, placeholder: string): HTMLElement {
    const row = document.createElement('div')
    row.className = 'hb-dialog-row'
    const l = document.createElement('label')
    l.textContent = label
    l.className = 'hb-dialog-label'
    input.className = 'theia-input'
    input.placeholder = placeholder
    input.style.width = '100%'
    row.appendChild(l)
    row.appendChild(input)
    return row
  }

  protected browseButton(text: string, onClick: () => void): HTMLElement {
    const b = document.createElement('button')
    b.className = 'theia-button secondary'
    b.textContent = text
    b.classList.add('hb-dialog-browse')
    b.onclick = onClick
    return b
  }

  protected async pickRom(): Promise<void> {
    const props: OpenFileDialogProps = {
      title: 'Select the base ROM',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: ROM_FILTER,
    }
    const uri = await this.fileDialog.showOpenDialog(props)
    if (!uri) return
    this.romField.value = uri.path.fsPath()
    await this.describeRom()
  }

  /**
   * Read the cart back and show what it is.
   *
   * Identity is computed from the cart with any copier header stripped, so the
   * same game dumped headered or bare reads identically. Showing it here is
   * the cheapest possible guard against creating a project against the wrong
   * file.
   */
  protected async describeRom(): Promise<void> {
    this.romInfo.textContent = 'Reading...'
    try {
      const id = await this.projects.identifyRom(this.romField.value)
      this.romInfo.textContent = `${id.title || 'unrecognised title'} - ${id.size} bytes - sha256 ${id.sha256.slice(0, 12)}...`
      if (!this.nameField.value) this.nameField.value = 'MyHack'
      this.updatePreview()
    } catch (err) {
      this.romInfo.textContent = `Could not read that file: ${(err as Error).message}`
    }
  }

  protected async pickDirectory(): Promise<void> {
    const uri = await this.fileDialog.showOpenDialog({
      title: 'Where should the project go',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
    })
    if (!uri) return
    this.dirField.value = uri.path.fsPath()
    this.updatePreview()
  }

  protected updatePreview(): void {
    const name = this.nameField.value.trim()
    const parent = this.dirField.value.trim()
    this.pathPreview.textContent =
      name && parent ? `Creates ${parent}\${name}\${name}${PROJECT_EXT}` : ''
  }

  get value(): CreateProjectRequest | undefined {
    const name = this.nameField.value.trim()
    const romPath = this.romField.value.trim()
    const parent = this.dirField.value.trim()
    if (!name || !romPath || !parent) return undefined
    // The project gets its own directory under the chosen location, because
    // createProject refuses a directory that already has contents.
    return { name, romPath, directory: `${parent}/${name}` }
  }

  protected override isValid(value: CreateProjectRequest | undefined): '' | string {
    if (!value) return 'A name, a base ROM and a location are all required'
    return ''
  }

  /** Open the dialog and hand back what the user entered, or undefined. */
  async collect(): Promise<CreateProjectRequest | undefined> {
    return this.open()
  }
}
