/**
 * Which project is open.
 *
 * Small on purpose. Several surfaces need the answer (the map explorer, the
 * properties dialog, the window title) and passing it between them would make
 * each one depend on whichever surface happened to open the project.
 *
 * Holds the manifest path and the last known DTO. It is not a cache: anything
 * that needs current data re-reads it from the backend, because the manifest
 * is a file the user can edit in another editor.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { Emitter, Event } from '@theia/core/lib/common'
import type { EditEvent } from '../../../../src/project/EditEvent'
import { ProjectDto } from '../common/project-protocol'
import { ProjectFrontendClient } from './project-push-client'

@injectable()
export class ProjectContext {
  protected readonly onChangedEmitter = new Emitter<ProjectDto | undefined>()
  readonly onChanged: Event<ProjectDto | undefined> = this.onChangedEmitter.event

  @inject(ProjectFrontendClient) protected readonly pushClient!: ProjectFrontendClient

  /**
   * The working copy's bytes changed (any view's edit, undo or redo): the
   * edit event of src/project/EditEvent.ts. `subject` is the manifest path;
   * a view compares it with its own project, as each did before the event
   * existed. The one bus for every widget.
   */
  get onEdit(): Event<EditEvent> {
    return this.pushClient.onEdit
  }

  /**
   * A project's base ROM was swapped (Project Properties relocated it, or
   * the working copy was rebuilt). The one event every view reading the ROM
   * rebuilds on; carries the manifest path, so a view filters to its own.
   */
  get onRomChanged(): Event<string> {
    return this.pushClient.onRomSwapped
  }

  protected _current: ProjectDto | undefined

  get current(): ProjectDto | undefined {
    return this._current
  }

  set current(project: ProjectDto | undefined) {
    this._current = project
    this.onChangedEmitter.fire(project)
  }
}
