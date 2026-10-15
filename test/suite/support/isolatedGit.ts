/**
 * Git for throwaway test repos, isolated from the host's git config (#892,
 * #890): a host core.hooksPath slowed every checkout ~180 ms, and git detaches
 * `maintenance run --auto` after commits. Both multiply under parallel load.
 */
import { spawnSync, type SpawnSyncReturns } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

// Inherited variables that would redirect git away from the repo under test.
const DROP = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_CONFIG_PARAMETERS',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]

export function isolatedEnv(
  base: NodeJS.ProcessEnv = process.env,
  globalConfig = '/dev/null', // os.devNull does not work as a config path on Windows git
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  for (const k of Object.keys(env)) {
    if (DROP.includes(k) || /^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(k)) delete env[k]
  }
  return env
}

// `noHooks` must be a path that does not exist.
export function isolatedGit(
  cwd: string,
  noHooks: string,
  ...args: string[]
): SpawnSyncReturns<string> {
  const cfg = [
    'core.hooksPath=' + noHooks,
    'commit.gpgsign=false',
    'maintenance.auto=false', // else ~5 extra git starts per commit (GIT_TRACE2, one Windows machine)
    'core.autocrlf=false',
    'user.name=t',
    'user.email=t@t',
  ]
  const r = spawnSync('git', ['-C', cwd, ...cfg.flatMap(c => ['-c', c]), ...args], {
    encoding: 'utf8',
    env: isolatedEnv(),
  })
  if (r.error) throw new Error(`git ${args.join(' ')} did not start: ${r.error}`)
  return r
}

/**
 * For code under test that spawns git with process.env: install a gitconfig in
 * `dir` (no hooks or maintenance, an identity). Repo config still wins.
 * Returns the restore function.
 */
export function isolateProcessGit(dir: string): () => void {
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'isolated.gitconfig')
  const hooks = join(dir, 'no-hooks').replaceAll('\\', '/')
  writeFileSync(
    cfg,
    `[core]\n\thooksPath = ${hooks}\n[maintenance]\n\tauto = false\n[commit]\n\tgpgsign = false\n[user]\n\tname = t\n\temail = t@t\n`,
  )
  const saved = { ...process.env }
  const next = isolatedEnv(process.env, cfg.replaceAll('\\', '/'))
  for (const k of Object.keys(process.env)) if (!(k in next)) delete process.env[k]
  Object.assign(process.env, next)
  return () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
}
