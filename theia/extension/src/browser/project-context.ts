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
import { injectable } from '@theia/core/shared/inversify'
import { Emitter, Event } from '@theia/core/lib/common'
import { ProjectDto } from '../common/project-protocol'

@injectable()
export class ProjectContext {
  protected readonly onChangedEmitter = new Emitter<ProjectDto | undefined>()
  readonly onChanged: Event<ProjectDto | undefined> = this.onChangedEmitter.event

  protected _current: ProjectDto | undefined

  get current(): ProjectDto | undefined {
    return this._current
  }

  set current(project: ProjectDto | undefined) {
    this._current = project
    this.onChangedEmitter.fire(project)
  }
}
