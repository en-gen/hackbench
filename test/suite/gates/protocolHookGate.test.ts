import { describe, it, expect, beforeEach } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const repoRoot = path.resolve(__dirname, '../../..')
const hook = path.join(repoRoot, 'tools/scripts/protocol-inject.mjs')
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

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-state-'))
  protocolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-protocols-'))
  docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-docs-'))
  fs.mkdirSync(path.join(docsDir, 'agents'))
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
    const r = runHook({ session_id: 's1', hook_event_name: 'UserPromptSubmit' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('Active protocols: beta')
    expect(r.out).toContain('2. Beta rule two.')
    expect(r.out).not.toContain('Alpha rule')
    expect(r.out).not.toContain('Session id')
  })

  it('falls back to the group default with no state file', () => {
    const r = runHook({ session_id: 's1', hook_event_name: 'UserPromptSubmit' })
    expect(r.out).toContain('Active protocols: alpha')
  })

  it('on session start prints registration, manual and state file', () => {
    fs.writeFileSync(path.join(docsDir, 'agents', 'tech-lead.md'), '# Tech lead manual\n')
    fs.writeFileSync(path.join(docsDir, 'agents', 'ba.md'), '# BA manual\n')
    fs.mkdirSync(path.join(stateDir, 'teams'))
    fs.writeFileSync(path.join(stateDir, 'teams', 'alpha.md'), '# Alpha state\n')
    fs.writeFileSync(
      path.join(stateDir, 'sessions.json'),
      JSON.stringify({ s1: { role: 'tech-lead', team: 'alpha', registered: 'x' } }),
    )
    const r = runHook({ session_id: 's1', hook_event_name: 'SessionStart', source: 'clear' })
    expect(r.out).toContain('Session id: s1. Registered as tech-lead alpha.')
    expect(r.out).toContain('# Tech lead manual')
    expect(r.out).not.toContain('# BA manual')
    expect(r.out).toContain('# Alpha state')
  })

  it('on session start for an unregistered session prints the tech-lead manual, a BA pointer and the first-step line', () => {
    fs.writeFileSync(path.join(docsDir, 'agents', 'tech-lead.md'), '# Tech lead manual\n')
    fs.writeFileSync(path.join(docsDir, 'agents', 'ba.md'), '# BA manual\n')
    const r = runHook({ session_id: 's9', hook_event_name: 'SessionStart', source: 'startup' })
    expect(r.out).toContain('Session id: s9. Not registered: follow the first step of your manual.')
    expect(r.out).toContain('# Tech lead manual')
    expect(r.out).not.toContain('# BA manual')
    expect(r.out).toContain('You are also the BA: read docs/agents/ba.md before your first reply.')
  })

  it('turns a manual that would pass the cap into a pointer', () => {
    fs.writeFileSync(path.join(docsDir, 'agents', 'tech-lead.md'), 'x'.repeat(12000))
    const r = runHook({ session_id: 's9', hook_event_name: 'SessionStart' })
    expect(r.out).toContain('Read docs/agents/tech-lead.md before your first reply')
    expect(r.out.length).toBeLessThan(10000)
  })

  it('never blocks a session: a broken protocol file becomes one line and exit 0', () => {
    fs.writeFileSync(
      path.join(protocolsDir, 'broken.md'),
      '# broken\n\n## Purpose\n\nno other headings\n',
    )
    const r = runHook({ session_id: 's1', hook_event_name: 'UserPromptSubmit' })
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

describe('the hook is wired', () => {
  function commandsFor(event: string): string[] {
    const settings = JSON.parse(
      fs.readFileSync(path.join(repoRoot, '.claude/settings.json'), 'utf8'),
    )
    return (settings.hooks[event] ?? []).flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map(h => h.command),
    )
  }

  it('settings.json runs protocol-inject.mjs on SessionStart and UserPromptSubmit', () => {
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      expect(commandsFor(event).some((c: string) => c.includes('protocol-inject.mjs'))).toBe(true)
    }
  })

  // The settings command imports the script under `node -e`, where argv[1] is
  // unset; a main guard that only matched a direct invocation printed nothing.
  it('the settings.json command itself prints the active protocols', () => {
    const command = commandsFor('UserPromptSubmit').find(c => c.includes('protocol-inject.mjs'))
    const r = spawnSync(command ?? 'exit 1', {
      shell: true,
      cwd: repoRoot,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 's1', hook_event_name: 'UserPromptSubmit' }),
      env: { ...hookEnv(), CLAUDE_PROJECT_DIR: repoRoot },
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Active protocols: alpha')
  })
})

// The hooks docs cap injected output at 10,000 characters; beyond that Claude
// sees only a file path and a 2,000-character preview, which is how the old
// orchestrator manual (11,194 characters) reached sessions. This renders
// against the REAL docs/ and docs/protocols/, not fixtures, so growing a
// manual or a protocol past the cap turns this red.
describe('the SessionStart injection stays under the hook cap', () => {
  const CAP = 10000

  it.each([
    ['tech-lead', 'tech-lead', 'alpha'],
    ['ba', 'ba', null],
    ['both', 'both', 'alpha'],
  ])('registered as %s', (_label, role, team) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-cap-'))
    fs.mkdirSync(path.join(dir, 'teams'))
    fs.writeFileSync(
      path.join(dir, 'protocols.json'),
      JSON.stringify({ active: ['night-shift', 'throttle'], changed: null, by: null }),
    )
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ s1: { role, team } }))
    fs.writeFileSync(path.join(dir, 'ba.md'), 'b'.repeat(1500))
    fs.writeFileSync(path.join(dir, 'teams', 'alpha.md'), 't'.repeat(1500))
    const r = spawnSync('node', [hook], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart' }),
      env: {
        ...process.env,
        HACKBENCH_STATE_DIR: dir,
        HACKBENCH_PROTOCOLS_DIR: '',
        HACKBENCH_DOCS_DIR: '',
        CLAUDE_PROJECT_DIR: repoRoot,
      },
    })
    expect(r.stdout).toContain('Active protocols: night-shift, throttle')
    expect(r.stdout.length).toBeLessThan(CAP)
  })
})
