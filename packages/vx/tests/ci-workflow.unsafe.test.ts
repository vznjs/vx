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
      ['linux', 'Linux DTE', 'ubuntu-latest', top, undefined],
      // Each run only plans and dispatches: Linux x64, so every macOS and
      // arm runner is an agent's.
      [
        'binary-linux-arm64',
        'compiled binary (linux-arm64)',
        'ubuntu-latest',
        "github.event_name != 'pull_request'",
        undefined,
      ],
      [
        'macos',
        'macOS DTE',
        'ubuntu-latest',
        "github.event_name != 'pull_request'",
        undefined,
      ],
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

  // A merged PR's run held its 12 agents' runners 80 s past the merge, and
  // main's agents waited 65 s for them (2026-10-23).
  it("cancels the merged PR's runs once main's agents are asked for", () => {
    const steps = doc.jobs['linux']!.steps!
    const i = steps.findIndex((s) => s.run?.includes('/commits/$GITHUB_SHA/pulls'))
    expect(steps[i]?.if).toBe("github.event_name == 'push'")
    expect(steps[i]!.run).toContain('/cancel')
    expect(i).toBeGreaterThan(steps.findIndex((s) => s.run?.includes('vx-dte-started')))
    expect(i).toBeLessThan(steps.findIndex((s) => s.uses?.startsWith('actions/checkout')))
  })

  it('makes each run distributed, over its relay', () => {
    for (const id of RUNS) {
      const steps = doc.jobs[id]!.steps!
      expect([id, steps.some((s) => s.run?.includes('VX_DTE_RUN=$(uuidgen)'))]).toEqual([id, true])
      const run = steps.find((s) => s.run?.includes('bin.ts run '))
      const relay = run?.env?.['VX_DTE_RELAY'] ?? doc.jobs[id]!.env?.['VX_DTE_RELAY']
      expect([id, relay]).toEqual([id, expect.stringMatching(/^https:\/\//)])
    }
  })

  // Checkout and install took ~19 s before vx asked for agents; agents a
  // step starts first are adopted (github() reads vx-dte-started).
  it("starts the Linux run's agents before checkout, for the run to adopt", () => {
    const steps = doc.jobs['linux']!.steps!
    const start = steps.findIndex((s) => s.run?.includes('vx-dte-started'))
    expect(start).toBeGreaterThan(steps.findIndex((s) => s.run?.includes('VX_DTE_RUN=$(uuidgen)')))
    expect(start).toBeLessThan(steps.findIndex((s) => s.uses?.startsWith('actions/checkout')))
    expect(steps[start]!.run).toContain('vx-dte-runs')
  })

  // An agent the run asks for later came online 82-90 s in (2026-10-23).
  it("starts all of each run's agent size before checkout, so none comes late", () => {
    const workspace = readFileSync(path.join(dir, '..', '..', '.vx', 'workspace.ts'), 'utf8')
    for (const [id, size] of [
      ['linux', 'small'],
      ['macos', 'mac'],
    ] as const) {
      const steps = doc.jobs[id]!.steps!
      const start = steps.findIndex((s) => s.run?.includes('vx-dte-started'))
      expect(start).toBeLessThan(steps.findIndex((s) => s.uses?.startsWith('actions/checkout')))
      expect([
        id,
        new RegExp(`seq -f '${size}#%g' 1 (\\d+)`).exec(steps[start]!.run!)?.[1],
      ]).toEqual([id, new RegExp(`${size}: \\{ max: (\\d+)`).exec(workspace)?.[1]])
    }
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

  // A job whose env carries GITHUB_TOKEN turns vx-ci's check run on; without
  // checks: write its POST answered 403 and warned (2026-10-22).
  it('lets each job that hands vx a GITHUB_TOKEN post its check run', () => {
    const withToken = Object.entries(doc.jobs).filter(([, j]) =>
      JSON.stringify(j.steps ?? []).includes('GITHUB_TOKEN'),
    )
    expect(withToken.map(([id]) => id)).toEqual([...RUNS])
    for (const [id, j] of withToken) expect([id, j.permissions?.['checks']]).toEqual([id, 'write'])
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

  // A killed vx never closes its run, so its queued agents held macOS runners.
  // A cold run that wrote no remote failed every task an agent ran: its
  // outputs come back through the remote (2026-10-23).
  it('runs cold reading no cache, still writing the remote agents hand outputs through', () => {
    const run = doc.jobs['linux']!.steps!.find((s) => s.run?.includes('bin.ts run '))
    expect(run?.env?.['VX_CACHE_POLICY']).toBe("${{ inputs.cold && 'local:w,remote:w' || '' }}")
  })

  it('cancels the agent runs a run dispatched, on any outcome', () => {
    for (const id of RUNS) {
      const cancel = doc.jobs[id]!.steps!.find(
        (s) => s.run?.includes('vx-dte-runs') && s.run.includes('/cancel'),
      )
      expect([id, cancel?.if]).toEqual([id, 'always()'])
    }
  })

  // Every sandboxed task runs on an agent, which enforces it there.
  it('installs no sandbox runtime on a run', () => {
    for (const id of RUNS)
      expect([id, doc.jobs[id]!.steps!.some((s) => s.uses?.includes('vx-runner'))]).toEqual([
        id,
        false,
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

  it('mounts the small disk the Linux run names, on Linux', () => {
    const mount = agent.steps!.find((s) => s.run?.includes('tmpfs'))
    expect(mount?.if).toBe("runner.os == 'Linux'")
    expect(mount?.run).toContain('/tmp/vx-small')
    expect(
      doc.jobs['linux']!.steps!.some((s) => s.env?.['VX_SMALL_DISK'] === '/tmp/vx-small'),
    ).toBe(true)
  })
})
