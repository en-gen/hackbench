/**
 * Git for Windows' bash for tests that run a .sh script. On win32 a bare
 * `bash` can be the WSL launcher, which skips PATH shims and fake tools, so
 * fail loudly when Git Bash is missing. Pure helpers: no tests register here.
 */
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'

export function resolveGitBash(candidates: string[], exists: (p: string) => boolean): string {
  const found = candidates.find(exists)
  if (!found) throw new Error(`Git Bash required, not found at ${candidates.join(' or ')}`)
  return found
}

export function findBash(): string {
  if (process.platform !== 'win32') return 'bash'
  // bash.exe sits under the Git root's bin; --exec-path is <root>/mingw64/libexec/git-core.
  const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 20000 }).trim()
  return resolveGitBash(
    [
      path.resolve(exec, '..', '..', '..', 'bin', 'bash.exe'),
      path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe'),
    ],
    fs.existsSync,
  )
}
