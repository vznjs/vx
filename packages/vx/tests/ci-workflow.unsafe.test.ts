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
const checkout = (j: Job | undefined): Step | undefined =>
  j?.steps?.find((s) => String(s.uses).startsWith('actions/checkout@'))

describe('ci.yml', () => {
  it('is the two runs, plus the live suites and the arm64 binary on main', () => {
    expect(
      Object.entries(doc.jobs).map(([id, j]) => [id, j.name, j['runs-on'], j.if, j.needs]),
    ).toEqual([
      ['linux', 'lint · format · test', 'ubuntu-latest', undefined, undefined],
      ['packages', 'plugin packages', 'ubuntu-latest', undefined, undefined],
      [
        'binary-linux-arm64',
        'compiled binary (linux-arm64)',
        'ubuntu-24.04-arm',
        "github.event_name != 'pull_request'",
        undefined,
      ],
      // Both runs only plan and dispatch: Linux, so every macOS runner is an agent's.
      ['macos', 'core tests (macOS)', 'ubuntu-latest', undefined, undefined],
    ])
  })

  it('makes each run distributed, over its relay', () => {
    for (const id of ['linux', 'macos']) {
      const steps = doc.jobs[id]!.steps!
      expect([id, steps.some((s) => s.run?.includes('VX_DTE_RUN=$(uuidgen)'))]).toEqual([id, true])
      const run = steps.find((s) => s.env?.['VX_DTE_RELAY'] !== undefined)
      expect([id, run?.run]).toEqual([id, expect.stringContaining('bin.ts run ')])
    }
  })

  // Shallow, a run found no merge-base and so no measured needs, and every
  // shard booked a whole agent at ~25% CPU (2026-10-22).
  it('checks each run out with the history its timings import walks', () => {
    for (const id of ['linux', 'macos'])
      expect([id, checkout(doc.jobs[id])?.with?.['fetch-depth']]).toEqual([id, 0])
  })

  // A job whose env carries GITHUB_TOKEN turns vx-ci's check run on; without
  // checks: write its POST answered 403 and warned (2026-10-22).
  it('lets each job that hands vx a GITHUB_TOKEN post its check run', () => {
    const withToken = Object.entries(doc.jobs).filter(([, j]) =>
      JSON.stringify(j.steps ?? []).includes('GITHUB_TOKEN'),
    )
    expect(withToken.map(([id]) => id)).toEqual(['linux', 'macos'])
    for (const [id, j] of withToken) expect([id, j.permissions?.['checks']]).toEqual([id, 'write'])
  })

  // Nothing runs on a distributed run's orchestrator (owner, 2026-10-22):
  // the macOS checks of this machine's sandbox are tasks a Mac agent runs.
  it('runs the macOS sandbox checks as tasks of the run', () => {
    const steps = doc.jobs['macos']!.steps!
    expect(steps.filter((s) => /sandbox-canary\.ts|--cache-policy/.test(s.run ?? ''))).toEqual([])
    const run = steps.find((s) => s.env?.['VX_DTE_RELAY'] !== undefined)!.run!
    expect(run).toContain(' check.sandbox-canary ')
    expect(run).toContain(' check.build-cold ')
  })

  // A killed vx never closes its run, so its queued agents held macOS runners.
  it('cancels the agent runs a run dispatched, on any outcome', () => {
    for (const id of ['linux', 'macos']) {
      const cancel = doc.jobs[id]!.steps!.find((s) => s.run?.includes('vx-dte-runs'))
      expect([id, cancel?.if]).toEqual([id, 'always()'])
    }
  })

  // Every sandboxed task runs on an agent, which enforces it there.
  it('installs no sandbox runtime on a run', () => {
    for (const id of ['linux', 'macos'])
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
      `\${{ fromJSON('{"small":"ubuntu-latest","mac":"macos-latest"}')[inputs.size] }}`,
    )
  })

  // The API-break law reads the last release's tag; the PR-commit law walks
  // base..head. A task runs on whichever agent is free.
  it('checks out the full history', () => {
    expect(checkout(agent)?.with?.['fetch-depth']).toBe(0)
  })

  // An agent saving to ~/.vx while a shard runs failed the shard's home
  // guard (2026-10-22): the agent keeps its store out of home.
  it("keeps the agent's store out of home", () => {
    // `runner` is a step's context, not a job's: a job env naming it is a
    // workflow GitHub refuses to dispatch.
    const step = agent.steps?.find((s) => s.run?.includes('dte agent') === true)
    expect(step?.env?.['VX_CACHE_DIR']).toBe('${{ runner.temp }}/vx-cache')
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
