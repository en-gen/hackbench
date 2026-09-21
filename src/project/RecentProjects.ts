/**
 * Projects this user has opened, most recent first.
 *
 * Per-machine, like the ROM registry, and for the same reason: where a project
 * lives is a fact about one computer, not about the hack. It lives beside the
 * registry in application data rather than in any project directory.
 *
 * Entries are validated on READ. A project the user moved or deleted is
 * dropped rather than offered, because a recent list whose entries fail when
 * clicked is worse than a shorter one.
 *
 * No VS Code or Theia imports, same rule as src/rom/.
 */
import * as fs from 'fs'
import * as path from 'path'
import { PROJECT_EXT } from './Project'
import { appDataDir } from './appData'

export const RECENT_VERSION = 1

/** Ten is what fits in a menu without becoming a file browser. */
export const MAX_RECENT = 10

export interface RecentProject {
  manifestPath: string
  /** Shown in the menu. Stored so the list renders without opening each file. */
  name: string
  title: string
  /** ISO timestamp of the last open, which is what orders the list. */
  lastOpened: string
}

interface RecentFile {
  version: number
  projects: RecentProject[]
}

export function defaultRecentPath(): string {
  return path.join(appDataDir(), 'recent-projects.json')
}

export class RecentProjects {
  private readonly file: string

  constructor(file: string = defaultRecentPath()) {
    this.file = file
  }

  /**
   * Record a project as just-opened.
   *
   * Keyed by manifest path, so reopening moves an entry to the front instead
   * of adding a duplicate.
   */
  remember(project: { manifestPath: string; name: string; title: string }): void {
    const absolute = path.resolve(project.manifestPath)
    const kept = this.read().projects.filter(p => path.resolve(p.manifestPath) !== absolute)

    kept.unshift({
      manifestPath: absolute,
      name: project.name,
      title: project.title,
      lastOpened: new Date().toISOString(),
    })

    this.write({ version: RECENT_VERSION, projects: kept.slice(0, MAX_RECENT) })
  }

  /**
   * The list to show, most recent first.
   *
   * Entries whose manifest is gone are dropped and forgotten: offering a
   * project that fails the moment it is clicked is worse than not offering it.
   */
  list(): RecentProject[] {
    const all = this.read().projects
    const alive = all.filter(
      p => fs.existsSync(p.manifestPath) && p.manifestPath.endsWith(PROJECT_EXT),
    )
    if (alive.length !== all.length) {
      this.write({ version: RECENT_VERSION, projects: alive })
    }
    return alive
  }

  forget(manifestPath: string): void {
    const absolute = path.resolve(manifestPath)
    this.write({
      version: RECENT_VERSION,
      projects: this.read().projects.filter(p => path.resolve(p.manifestPath) !== absolute),
    })
  }

  clear(): void {
    this.write({ version: RECENT_VERSION, projects: [] })
  }

  /** A damaged or future list reads as empty rather than throwing. */
  private read(): RecentFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as RecentFile
      if (parsed?.version !== RECENT_VERSION || !Array.isArray(parsed.projects)) {
        return { version: RECENT_VERSION, projects: [] }
      }
      return parsed
    } catch {
      return { version: RECENT_VERSION, projects: [] }
    }
  }

  private write(data: RecentFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  }
}
