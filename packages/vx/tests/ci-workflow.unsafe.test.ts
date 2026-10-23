// ci.yml is two distributed runs (owner, 2026-10-22: "everything should run
// in DTE", "yes 2x dte"): one for Linux, one for macOS, each the required
// check of its platform, with no `changes` job skipping either.
//
// `.unsafe`: the workflows live at the repo root, which a sandboxed project
// task may not read.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const dir = path.resolve(import.meta.dir, '..', '..', '..', '.github', 'workflows')

interface Step {
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}
interface Job {
  name?: string
  environment?: string
  if?: string
  needs?: string | string[]
  'runs-on'?: string
  permissions?: Record<string, string>
  env?: Record<string, string>
  steps?: Step[]
}
interface Workflow {
  on?: Record<string, unknown>
  true?: Record<string, unknown>
  concurrency?: Record<string, string>
  jobs: Record<string, Job>
}
const read = (file: string): Workflow =>
  Bun.YAML.parse(readFileSync(path.join(dir, file), 'utf8')) as Workflow
const doc = read('ci.yml')
const agent = read('vx-agent.yml').jobs['agent']!
const RUNS = ['linux', 'binary-linux-arm64', 'macos'] as const
const checkout = (j: Job | undefined): Step | undefined =>
  j?.steps?.find((s) => String(s.uses).startsWith('actions/checkout@'))

describe('ci.yml', () => {
  it('is the Linux run, plus macOS and the arm64 binary on main', () => {
    const top =
      "github.event.action != 'closed' && github.event.pull_request.stack.position == github.event.pull_request.stack.size"
    expect(
      Object.entries(doc.jobs).map(([id, j]) => [id, j.name, j['runs-on'], j.if, j.needs]),
    ).toEqual([
      ['linux', 'linux-x64', 'ubuntu-latest', top, undefined],
      // Each run only plans and dispatches: Linux x64, so every macOS and
      // arm runner is an agent's.
      [
        'binary-linux-arm64',
        'linux-arm64',
        'ubuntu-latest',
        "github.event_name != 'pull_request'",
        undefined,
      ],
      ['macos', 'darwin-arm64', 'ubuntu-latest', "github.event_name != 'pull_request'", undefined],
    ])
  })

  // A merged PR's run held its agents' runners until it ended, and the next
  // main run's agents queued 108-184 s behind them (2026-10-23).
  it('cancels a PR’s run, and so its agents, once the PR closes', () => {
    const on = (doc.on ?? doc.true)!
    expect(on['pull_request']).toEqual({ types: ['opened', 'synchronize', 'reopened', 'closed'] })
    expect(doc.concurrency).toEqual({
      group: '${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    })
    for (const j of Object.values(doc.jobs))
      expect(j.if).toMatch(/github\.event\.action != 'closed'|github\.event_name != 'pull_request'/)
  })

  // Shallow, a run found no merge-base and so no measured needs, and every
  // shard booked a whole agent at ~25% CPU (2026-10-22).
  it('checks each run out with the history its timings import walks', () => {
    for (const id of RUNS)
      expect([id, checkout(doc.jobs[id])?.with]).toEqual([
        id,
        { 'fetch-depth': 0, filter: 'blob:none' },
      ])
  })

  // The run's report is the job summary, not a check run of its own beside
  // the jobs (owner, 2026-10-23), so no job grants checks: write.
  it('posts no check run: the report is the job summary', () => {
    const ws = readFileSync(path.join(dir, '..', '..', '.vx', 'workspace.ts'), 'utf8')
    expect(ws).toContain('github({ checks: false })')
    expect(
      Object.entries(doc.jobs).filter(([, j]) => j.permissions?.['checks'] !== undefined),
    ).toEqual([])
  })

  // Nothing runs on a distributed run's orchestrator (owner, 2026-10-22):
  // the macOS checks of this machine's sandbox are tasks a Mac agent runs.
  it('runs the macOS sandbox checks as tasks of the run', () => {
    const steps = doc.jobs['macos']!.steps!
    expect(steps.filter((s) => /sandbox-canary\.ts|--cache-policy/.test(s.run ?? ''))).toEqual([])
    const run = steps.find((s) => s.run?.includes('bin.ts run '))!.run!
    expect(run).toContain(' check.sandbox-canary ')
    expect(run).toContain(' check.build-cold ')
  })

  // Every sandboxed task runs on an agent, which enforces it there.
  it('installs no sandbox runtime on a run', () => {
    for (const id of RUNS)
      expect([id, doc.jobs[id]!.steps!.some((s) => s.uses?.includes('vx-runner'))]).toEqual([
        id,
        false,
      ])
  })

  // docs.yml was its own workflow, its own install and sandbox runtime, for
  // a site the run already builds (owner, 2026-10-23: fold workflows into
  // vx tasks on DTE). Only a green push to main deploys it.
  it('deploys the docs site the Linux run built, on a push to main', () => {
    const job = doc.jobs['linux']!
    const main = "success() && github.event_name == 'push' && github.ref == 'refs/heads/main'"
    const upload = job.steps!.find((s) => s.uses?.startsWith('actions/upload-pages-artifact@'))
    const deploy = job.steps!.find((s) => s.uses?.startsWith('actions/deploy-pages@'))
    expect([upload?.if, upload?.with, deploy?.if]).toEqual([
      main,
      { path: 'private/vx-docs/dist' },
      main,
    ])
    expect(job.environment).toBe("${{ github.event_name == 'push' && 'github-pages' || '' }}")
    expect(job.permissions?.['pages']).toBe('write')
  })

  // A run is what a developer would write (owner, 2026-10-23: "super
  // simple"); vx names the run, sizes, starts and cancels its agents.
  it('is checkout, Bun, install, lock check and vx run, nothing else', () => {
    const shape = (j: Job) =>
      j.steps!.filter((s) => s.if === undefined).map((s) => s.uses?.split('@')[0] ?? s.run)
    const run = (id: string) =>
      doc.jobs[id]!.steps!.find((s) => s.run?.includes('bin.ts run '))!.run!
    // The lock check is in every run (owner, 2026-10-23: "lock is the most
    // critical step on CI to run").
    for (const id of RUNS)
      expect([id, shape(doc.jobs[id]!)]).toEqual([
        id,
        [
          'actions/checkout',
          'oven-sh/setup-bun',
          'bun install --frozen-lockfile',
          'bun packages/vx/src/bin.ts lock --check',
          run(id),
        ],
      ])
    for (const id of RUNS)
      expect([id, doc.jobs[id]!.env?.['VX_DTE_RELAY']]).toEqual([
        id,
        expect.stringMatching(/^https:\/\//),
      ])
  })

  // The remote cache serves every hit (owner, 2026-10-23: "we dont need
  // to carry any vx cache anymore").
  it('carries no vx cache between runs', () => {
    for (const file of ['ci.yml', 'vx-agent.yml'])
      expect([file, readFileSync(path.join(dir, file), 'utf8').includes('actions/cache')]).toEqual([
        file,
        false,
      ])
  })

  // release-notes.yml was a workflow of its own for one task.
  it('syncs the release notes as a task of the Linux run, on a push', () => {
    const job = doc.jobs['linux']!
    const run = job.steps!.find((s) => s.run?.includes('bin.ts run '))!
    expect(run.run).toContain("${{ github.event_name == 'push' && 'release.sync' || '' }}")
    expect([job.env?.['GH_TOKEN'], job.permissions?.['contents']]).toEqual([
      '${{ github.token }}',
      'write',
    ])
  })

  it('filters no trigger by path', () => {
    expect(JSON.stringify(doc.on ?? doc.true)).not.toMatch(/paths/)
  })

  it('cancels a superseded run on a pull request only', () => {
    expect(doc.concurrency).toEqual({
      group: '${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    })
  })
})

describe('vx-agent.yml', () => {
  it('runs each size on its runner', () => {
    expect(agent['runs-on']).toBe(
      `\${{ fromJSON('{"small":"ubuntu-latest","arm":"ubuntu-24.04-arm","mac":"macos-latest"}')[inputs.size] }}`,
    )
  })

  // The API-break law reads the last release's tag; the PR-commit law walks
  // base..head. A task runs on whichever agent is free.
  // Without old blobs: a full clone was 5-7 s of each warm-up (2026-10-23).
  it('checks out the full history, without old blobs', () => {
    expect(checkout(agent)?.with).toEqual({
      ref: '${{ inputs.sha }}',
      'fetch-depth': 0,
      filter: 'blob:none',
    })
  })

  // An agent saving to ~/.vx while a shard runs failed the shard's home
  // guard (2026-10-22): the agent keeps its store out of home.
  it("keeps the agent's store out of home", () => {
    // `runner` is a step's context, not a job's: a job env naming it is a
    // workflow GitHub refuses to dispatch.
    const step = agent.steps?.find((s) => s.run?.includes('dte agent') === true)
    expect(step?.env?.['VX_CACHE_DIR']).toBe('${{ runner.temp }}/vx-cache')
  })

  // apt's ~9 s ran after `bun install`, on every agent's warm-up (2026-10-22).
  it('installs the sandbox runtime while Bun installs, and proves it before the agent', () => {
    const steps = agent.steps!
    const at = (p: (s: Step) => boolean) => steps.findIndex(p)
    const runner = (phase: string) =>
      at((s) => s.uses === './.github/actions/vx-runner' && s.with?.['phase'] === phase)
    const install = at((s) => s.run?.includes('bun install') === true)
    const agentStep = at((s) => s.run?.includes('dte agent') === true)
    expect(runner('start')).toBeGreaterThan(-1)
    expect(runner('start')).toBeLessThan(install)
    expect(runner('finish')).toBeGreaterThan(install)
    expect(runner('finish')).toBeLessThan(agentStep)
  })

  // Ubuntu 26 runners confine bwrap with this profile and have no
  // aa-disable: every sandboxed task failed on its agent (2026-10-23).
  // Ubuntu's way for one program (discourse.ubuntu.com/t/58007): a profile
  // granting it `userns`, the restriction kept for every other.
  it('gives bwrap a userns profile in place of the one that strips its nested namespace', () => {
    const action = readFileSync(path.join(dir, '..', 'actions', 'vx-runner', 'action.yml'), 'utf8')
    expect(action).toContain('sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict')
    expect(action).toContain("'profile bwrap /usr/bin/bwrap flags=(unconfined) {' '  userns,' '}'")
    expect(action).toContain('sudo apparmor_parser -r /etc/apparmor.d/bwrap')
    expect(action).not.toContain('apparmor_restrict_unprivileged_userns=0')
    expect(action).not.toContain('aa-disable')
  })

  it('mounts the small disk the Linux run names, on Linux', () => {
    const mount = agent.steps!.find((s) => s.run?.includes('tmpfs'))
    expect(mount?.if).toBe("runner.os == 'Linux'")
    expect(mount?.run).toContain('/tmp/vx-small')
    expect(doc.jobs['linux']!.env?.['VX_SMALL_DISK']).toBe('/tmp/vx-small')
  })
})
