// ci.yml is one distributed run for every platform (owner, 2026-10-23:
// "merge all 3 workflows into 1 dte"): a task bound to one platform runs
// on a worker of it, with no `changes` job skipping the run.
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
const worker = read('vx-worker.yml').jobs['worker']!
const checkout = (j: Job | undefined): Step | undefined =>
  j?.steps?.find((s) => String(s.uses).startsWith('actions/checkout@'))

describe('ci.yml', () => {
  // The run only plans and dispatches: Linux x64, so every macOS and arm
  // runner is a worker's.
  it('is one run', () => {
    const top =
      "github.event.action != 'closed' && github.event.pull_request.stack.position == github.event.pull_request.stack.size"
    expect(
      Object.entries(doc.jobs).map(([id, j]) => [id, j.name, j['runs-on'], j.if, j.needs]),
    ).toEqual([['linux', 'VX DTE', 'ubuntu-latest', top, undefined]])
  })

  // A merged PR's run held its workers' runners until it ended, and the next
  // main run's workers queued 108-184 s behind them (2026-10-23).
  it('cancels a PR’s run, and so its workers, once the PR closes', () => {
    const on = (doc.on ?? doc.true)!
    expect(on['pull_request']).toEqual({ types: ['opened', 'synchronize', 'reopened', 'closed'] })
    expect(doc.concurrency).toEqual({
      group: '${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    })
    expect(doc.jobs['linux']!.if).toStartWith("github.event.action != 'closed' && ")
  })

  // Shallow, a run found no merge-base and so no measured needs, and every
  // shard booked a whole worker at ~25% CPU (2026-10-22). The run fetches
  // its merge-base now (mergeBaseWith), so the checkout is one commit.
  it('checks the run out at one commit: the run fetches its merge-base', () => {
    expect(checkout(doc.jobs['linux'])?.with).toBeUndefined()
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
  // each platform's checks are tasks a worker of it runs, on main. The
  // platform's test files run on a PR too: a Mac-only test merged green
  // and turned main red (#4293).
  it('runs every platform’s checks as tasks of the run, its tests on a PR too', () => {
    const steps = doc.jobs['linux']!.steps!
    expect(steps.filter((s) => /sandbox-canary\.ts|--cache-policy/.test(s.run ?? ''))).toEqual([])
    const run = steps.find((s) => s.run?.includes('bin.ts run '))!.run!
    expect(run).toContain(
      "build.bun.darwin-arm64 test.platform ${{ github.event_name != 'pull_request' && 'build.bun.linux-x64 build.bun.darwin-x64 check.binary.linux-arm64 check.binary.darwin-arm64 check.sandbox-canary check.build-cold' || '' }}",
    )
  })

  // Every sandboxed task runs on a worker, which enforces it there.
  it('installs no sandbox runtime on the run', () => {
    expect(doc.jobs['linux']!.steps!.some((s) => s.run?.includes(' setup ') === true)).toBe(false)
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
  // simple"); vx names the run, sizes, starts and cancels its workers.
  it('is checkout, Bun, install, lock check and vx run, nothing else', () => {
    const job = doc.jobs['linux']!
    const run = job.steps!.find((s) => s.run?.includes('bin.ts run '))!.run!
    // The lock check is in the run (owner, 2026-10-23: "lock is the most
    // critical step on CI to run").
    expect(
      job.steps!.filter((s) => s.if === undefined).map((s) => s.uses?.split('@')[0] ?? s.run),
    ).toEqual([
      'actions/checkout',
      'oven-sh/setup-bun',
      'bun install --frozen-lockfile',
      'bun packages/vx/src/bin.ts lock --check',
      run,
    ])
    expect(job.env?.['VX_DTE_RELAY']).toMatch(/^https:\/\//)
  })

  // The remote cache serves every hit (owner, 2026-10-23: "we dont need
  // to carry any vx cache anymore"), and Bun's packages restored took as
  // long as a cold install (4-9 s against about 5 s, main 68b851d): only
  // a worker's sandbox runtime is kept.
  it('carries no vx cache between runs', () => {
    const cached = [...Object.values(doc.jobs), worker].flatMap((j) =>
      j.steps!.filter((s) => s.uses?.startsWith('actions/cache')).map((s) => s.with?.['path']),
    )
    expect(cached).toEqual(['~/.cache/vx/setup-debs', '~/.cache/vx/setup-debs'])
  })

  // `vx setup github` saves under `vx-setup-debs-<RUNNER_OS>-<RUNNER_ARCH>-<image>`
  // (vx-ci's debsKey): a key led by the image matched no restore, and
  // every worker fetched again (2026-10-23).
  it('restores the setup packages by the prefix setup saves them under', () => {
    const restore = worker.steps!.find(
      (s) =>
        s.uses?.startsWith('actions/cache/restore') &&
        s.with?.['path'] === '~/.cache/vx/setup-debs',
    )!
    expect(restore.with?.['restore-keys']).toBe(
      'vx-setup-debs-${{ runner.os }}-${{ runner.arch }}-',
    )
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

  // A PR runs what its diff affects (owner, 2026-10-23: "PR should run on
  // affected and DTE"); main runs everything, which seeds the cache.
  it('runs a PR affected, main all', () => {
    const run = doc.jobs['linux']!.steps!.find((s) => s.run?.includes('bin.ts run '))!.run!
    expect(run).toEndWith(" ${{ github.event_name == 'pull_request' && '--affected' || '--all' }}")
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

describe('vx-worker.yml', () => {
  it('runs each size on its runner', () => {
    expect(worker['runs-on']).toBe(
      `\${{ fromJSON('{"small":"ubuntu-latest","arm":"ubuntu-24.04-arm","mac":"macos-latest"}')[inputs.size] }}`,
    )
  })

  // The API-break law reads the last release's tag; the PR-commit law walks
  // base..head. A task runs on whichever worker is free.
  // Without old blobs: a full clone was 5-7 s of each warm-up (2026-10-23).
  it('checks out the full history, without old blobs', () => {
    expect(checkout(worker)?.with).toEqual({
      ref: '${{ inputs.sha }}',
      'fetch-depth': 0,
      filter: 'blob:none',
    })
  })

  // A worker saving to ~/.vx while a shard runs failed the shard's home
  // guard (2026-10-22): the worker keeps its store out of home.
  it("keeps the worker's store out of home", () => {
    // `runner` is a step's context, not a job's: a job env naming it is a
    // workflow GitHub refuses to dispatch.
    const step = worker.steps?.find((s) => s.run?.includes('dte worker') === true)
    expect(step?.env?.['VX_CACHE_DIR']).toBe('${{ runner.temp }}/vx-cache')
  })

  // The worker is what a developer would write (owner, 2026-10-23: "why vx
  // runner runs twice?"): the runtime set up by the CI plugin before the
  // worker starts (owner: "vx setup github", "we should do before"), its
  // packages kept per runner image, and no mount of its own.
  it('is checkout, Bun, install, the sandbox runtime and the worker', () => {
    expect(worker.steps!.map((s) => s.uses?.split('@')[0] ?? s.run)).toEqual([
      'actions/checkout',
      'oven-sh/setup-bun',
      'bun install --frozen-lockfile',
      'actions/cache/restore',
      'bun packages/vx/src/bin.ts setup github',
      'actions/cache/save',
      'bun packages/vx/src/bin.ts dte worker',
    ])
  })
})
