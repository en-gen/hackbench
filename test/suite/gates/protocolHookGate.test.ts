import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Every temp directory a test makes is removed afterwards, like lintGate.test.ts.
// Windows can refuse a removal while a just-exited child process lets go, so
// retry once and then ignore: hygiene must never fail a run.
const made: string[] = []

function mk(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  made.push(dir)
  return dir
}

function removeAll(): void {
  for (const dir of made.splice(0)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
    }
  }
}

afterEach(removeAll)

const repoRoot = path.resolve(__dirname, '../../..')
const hook = path.join(repoRoot, 'tools/scripts/protocol-inject.mjs')
const CLI_ID = '2b245891-c391-4d73-9647-b5b41cea6c49'
let stateDir: string
let protocolsDir: string
let docsDir: string

function proto(name: string, group: string, changes: string[]): string {
  return (
    [
      `# ${name}`,
      '## Purpose',
      'p.',
      '## Group',
      group,
      '## Activation',
      'owner.',
      '## Changes',
      ...changes,
      '## Unchanged',
      'rest.',
      '## Exit',
      'off.',
    ].join('\n\n') + '\n'
  )
}

function hookEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HACKBENCH_STATE_DIR: stateDir,
    HACKBENCH_PROTOCOLS_DIR: protocolsDir,
    HACKBENCH_DOCS_DIR: docsDir,
  }
}

function runHook(input: object): { code: number; out: string } {
  const r = spawnSync('node', [hook], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: hookEnv(),
  })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

const START = { session_id: CLI_ID, hook_event_name: 'SessionStart', source: 'clear' }

beforeEach(() => {
  stateDir = mk('hook-state-')
  protocolsDir = mk('hook-protocols-')
  docsDir = mk('hook-docs-')
  fs.mkdirSync(path.join(docsDir, 'agents'))
  fs.mkdirSync(path.join(stateDir, 'teams'))
  fs.writeFileSync(
    path.join(protocolsDir, 'alpha.md'),
    proto('alpha', 'shift (default)', ['1. Alpha rule.']),
  )
  fs.writeFileSync(
    path.join(protocolsDir, 'beta.md'),
    proto('beta', 'shift', ['1. Beta rule one.', '2. Beta rule two.']),
  )
})
describe('the protocol hook', () => {
  it('prints only the active protocols on a prompt', () => {
    fs.writeFileSync(
      path.join(stateDir, 'protocols.json'),
      JSON.stringify({ active: ['beta'], changed: null, by: null }),
    )
    const r = runHook({ session_id: CLI_ID, hook_event_name: 'UserPromptSubmit' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('Active protocols: beta')
    expect(r.out).toContain('2. Beta rule two.')
    expect(r.out).not.toContain('Alpha rule')
    expect(r.out).not.toContain('Session id')
  })

  it('falls back to the group default with no state file', () => {
    const r = runHook({ session_id: CLI_ID, hook_event_name: 'UserPromptSubmit' })
    expect(r.out).toContain('Active protocols: alpha')
  })

  it('prints one warning line when the state file is unreadable', () => {
    fs.writeFileSync(path.join(stateDir, 'protocols.json'), '{bad')
    const r = runHook({ session_id: CLI_ID, hook_event_name: 'UserPromptSubmit' })
    expect(r.out).toContain('protocols.json unreadable, defaults applied')
    expect(r.out).toContain('Active protocols: alpha')
  })

  it('on session start prints the facts and the instruction, and injects no manual', () => {
    fs.writeFileSync(path.join(docsDir, 'agents', 'tech-lead.md'), '# Tech lead manual\n')
    fs.writeFileSync(path.join(stateDir, 'teams', 'alpha.md'), '# Alpha state\n')
    const r = runHook(START)
    const script = path.join(path.resolve(docsDir, '..'), 'tools', 'scripts', 'protocol.mjs')
    expect(r.out).toContain(`Session id: ${CLI_ID}.`)
    expect(r.out).toContain(`Protocol script (main checkout): ${script}`)
    expect(r.out).toContain(`State folder: ${stateDir}`)
    expect(r.out).toContain("waits for its orchestrator's resume prompt and follows it")
    expect(r.out).toContain('registers from its title')
    expect(r.out).toContain(path.resolve(docsDir, 'agents', 'tech-lead.md'))
    expect(r.out).toContain(path.resolve(docsDir, 'agents', 'ba.md'))
    expect(r.out).not.toContain('# Tech lead manual')
    expect(r.out).not.toContain('# Alpha state')
    expect(r.out).not.toContain('Not registered')
  })

  it('stays small: the facts add two lines to the protocols block', () => {
    const prompt = runHook({ session_id: CLI_ID, hook_event_name: 'UserPromptSubmit' })
    const start = runHook(START)
    expect(start.out.split('\n').length - prompt.out.split('\n').length).toBe(2)
    expect(start.out.length).toBeLessThan(2000)
  })

  it('never blocks a session: a broken protocol file becomes one line and exit 0', () => {
    fs.writeFileSync(
      path.join(protocolsDir, 'broken.md'),
      '# broken\n\n## Purpose\n\nno other headings\n',
    )
    const r = runHook({ session_id: CLI_ID, hook_event_name: 'UserPromptSubmit' })
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/^Protocol hook error: broken: headings must be/)
  })

  it('survives empty stdin', () => {
    const r = spawnSync('node', [hook], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: '',
      env: hookEnv(),
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Active protocols: alpha')
  })
})

// The real protocols and manuals must stay inside the hooks docs cap of
// 10,000 characters, or Claude sees a file path and a short preview instead.
describe('the real SessionStart output stays under the hook cap', () => {
  it('with every protocol active', () => {
    fs.writeFileSync(
      path.join(stateDir, 'protocols.json'),
      JSON.stringify({ active: ['night-shift', 'throttle'], changed: null, by: null }),
    )
    const r = spawnSync('node', [hook], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: JSON.stringify(START),
      env: {
        ...process.env,
        HACKBENCH_STATE_DIR: stateDir,
        HACKBENCH_PROTOCOLS_DIR: '',
        HACKBENCH_DOCS_DIR: '',
        CLAUDE_PROJECT_DIR: repoRoot,
      },
    })
    expect(r.stdout).toContain('Active protocols: night-shift, throttle')
    expect(r.stdout.length).toBeLessThan(10000)
  })
})

describe('the hook is wired', () => {
  function commandsFor(event: string): string[] {
    const settings = JSON.parse(
      fs.readFileSync(path.join(repoRoot, '.claude/settings.json'), 'utf8'),
    )
    return (settings.hooks[event] ?? []).flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map(h => h.command),
    )
  }

  function runCommand(projectDir: string): { status: number | null; stdout: string } {
    const command = commandsFor('UserPromptSubmit').find(c => c.includes('protocol-inject.mjs'))
    const r = spawnSync(command ?? 'exit 1', {
      shell: true,
      cwd: repoRoot,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: CLI_ID, hook_event_name: 'UserPromptSubmit' }),
      env: { ...hookEnv(), CLAUDE_PROJECT_DIR: projectDir },
    })
    return { status: r.status, stdout: r.stdout + r.stderr }
  }

  it('settings.json runs protocol-inject.mjs on SessionStart and UserPromptSubmit', () => {
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      expect(commandsFor(event).some((c: string) => c.includes('protocol-inject.mjs'))).toBe(true)
    }
  })

  // The settings command imports the script under `node -e`, where argv[1] is
  // unset; a main guard that only matched a direct invocation printed nothing.
  it('the settings.json command itself prints the active protocols', () => {
    const r = runCommand(repoRoot)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Active protocols: alpha')
  })

  it('a missing script becomes one line and exit 0, not a stack trace', () => {
    const empty = mk('hook-empty-')
    const r = runCommand(empty)
    expect(r.status).toBe(0)
    expect(r.stdout.trim().split('\n')).toHaveLength(1)
    expect(r.stdout).toMatch(/^Protocol hook error: /)
  })
})
