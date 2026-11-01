// ci.yml is one distributed run for every platform (2026-10-23:
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
  id?: string
  name?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
  'timeout-minutes'?: number
  'continue-on-error'?: boolean
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
  // runner is a worker's. The benchmarks run beside it on a runner of
  // their own, and it waits for none of them: no build depends on one.
  it('is one run, and the benchmarks beside it', () => {
    // The benchmarks' machine: a kept runner when BENCH_RUNNER names one.
    const bench = "${{ vars.BENCH_RUNNER || 'ubuntu-latest' }}"
    const top =
      "github.event.action != 'closed' && github.event.pull_request.stack.position == github.event.pull_request.stack.size"
    expect(
      Object.entries(doc.jobs).map(([id, j]) => [id, j.name, j['runs-on'], j.if, j.needs]),
    ).toEqual([
      ['linux', 'VX DTE', 'ubuntu-latest', top, undefined],
      [
        'bench',
        'Bench',
        bench,
        "github.event_name == 'push' || github.event_name == 'workflow_dispatch'",
        undefined,
      ],
      ['perf', 'Perf', bench, top, undefined],
    ])
  })

  // The site's head-to-head rows are timed on a machine of their own, one
  // runner at a time, so a benchmark never runs under DTE (2026-10-29).
  it('measures the site benchmark off the DTE run, one runner at a time', () => {
    const bench = doc.jobs['bench']!
    expect(JSON.stringify(bench)).not.toContain('VX_DTE')
    expect(bench.steps?.find((s) => s.name === 'vx run bench.data')?.run).toBe(
      'bun packages/vx/src/bin.ts run @vzn/vx-docs#bench.data --concurrency 1 --force',
    )
  })

  // A DTE worker is packed for the run's wall time, so a benchmark there
  // timed its neighbours (2026-10-24): it runs where no relay is set,
  // and the run's `ci` does not reach it.
  it('runs the benchmarks off the DTE run', () => {
    const perf = doc.jobs['perf']!
    expect(JSON.stringify(perf)).not.toContain('VX_DTE')
    expect(perf.steps?.at(-1)?.run).toBe(
      "bun packages/vx/src/bin.ts run check.perf ${{ github.event_name == 'pull_request' && '--affected' || '--all' }}",
    )
    const bench = readFileSync(path.join(dir, '../../private/vx-bench/vx.config.ts'), 'utf8')
    expect(bench).toContain("dependsOn: ['lint', 'test'],")
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

  // The run fetches a merge-base itself when it needs one (--affected,
  // reachMergeBase), so the checkout is one commit.
  it('checks the run out at one commit: the run fetches its merge-base', () => {
    expect(checkout(doc.jobs['linux'])?.with).toEqual({ 'persist-credentials': false })
  })

  // The run's report is the job summary; github() posts no check run
  // (2026-10-25), so no job grants checks: write. The run reads them: the
  // relay's Preview is named by its Workers Builds check.
  it('grants no checks: write: the report is the job summary', () => {
    expect(
      Object.entries(doc.jobs).flatMap(([id, j]) =>
        j.permissions?.['checks'] === undefined ? [] : [[id, j.permissions['checks']]],
      ),
    ).toEqual([
      ['linux', 'read'],
      ['bench', 'read'],
    ])
  })

  // A PR that changes the relay runs on its own relay code, Workers Builds'
  // Preview of its commit; the rest keep the deployed one
  // (2026-10-25). Before the run, on a PR only.
  it('points a PR’s run at the relay Preview, and main’s at its deploy, before it runs', () => {
    const steps = doc.jobs['linux']!.steps!
    const at = steps.findIndex(
      (s) => s.run === 'bun private/vx-servers/worker-url.ts private/vx-dte-service VX_DTE_RELAY',
    )
    expect(steps[at]?.if).toBe(
      "github.event_name == 'pull_request' || github.ref == 'refs/heads/main'",
    )
    const run = steps.find((s) => s.run?.includes('bin.ts run ') === true)!
    expect(at).toBeLessThan(steps.indexOf(run))
    expect(steps[at]?.id).toBe('relay')
    const cache = steps.findIndex(
      (s) => s.run === 'bun private/vx-servers/worker-url.ts private/vx-cache-service VX_CACHE_URL',
    )
    expect(steps[cache]?.if).toBe(steps[at]?.if)
    expect(cache).toBeLessThan(steps.indexOf(run))
    expect(steps[cache]?.id).toBe('cache')
    expect(run.env).toEqual({
      VX_DTE_RELAY: '${{ steps.relay.outputs.url || env.VX_DTE_RELAY }}',
      VX_CACHE_URL: '${{ steps.cache.outputs.url || env.VX_CACHE_URL }}',
    })
  })

  // Nothing runs on a distributed run's orchestrator (2026-10-22):
  // each platform's checks are tasks a worker of it runs, on main. The
  // platform's test files run on a PR too: a Mac-only test merged green
  // and turned main red (#4293).
  it('runs every platform’s checks as tasks of the run, its tests on a PR too', () => {
    const steps = doc.jobs['linux']!.steps!
    expect(steps.filter((s) => /sandbox-canary\.ts|--cache-policy/.test(s.run ?? ''))).toEqual([])
    const run = steps.find((s) => s.run?.includes('bin.ts run '))!.run!
    expect(run).toContain("ci ${{ github.event_name == 'push' && 'release' || '' }}")
  })

  // Every sandboxed task runs on a worker, which enforces it there.
  it('installs no sandbox runtime on the run', () => {
    expect(doc.jobs['linux']!.steps!.some((s) => s.run?.includes(' setup ') === true)).toBe(false)
  })

  // docs.yml was its own workflow, its own install and sandbox runtime
  // (2026-10-23). The deploy is a task (2026-10-24: the Pages actions
  // were 33 s), run by the Bench job once it has measured: a deploy in
  // main's run shipped the committed numbers, older than the live ones
  // (2026-11-01).
  it('deploys the docs site from the Bench job, with the numbers it measured', () => {
    const push = "github.event_name == 'push'"
    const run = doc.jobs['linux']!
    expect(run.environment).toBeUndefined()
    expect(run.permissions?.['pages']).toBeUndefined()
    expect(run.steps!.some((s) => s.uses?.startsWith('actions/github-script@'))).toBe(false)
    expect(
      readFileSync(path.join(dir, '../../private/vx-docs/vx.config.ts'), 'utf8'),
    ).not.toContain("release: { dependsOn: ['deploy.pages'] }")
    const job = doc.jobs['bench']!
    expect(job.environment).toBe(`\${{ ${push} && 'github-pages' || '' }}`)
    expect([job.permissions?.['pages'], job.permissions?.['id-token']]).toEqual(['write', 'write'])
    const names = job.steps!.map((s) => s.name)
    const after = names.slice(names.indexOf('vx run bench.data'))
    expect(after).toEqual([
      'vx run bench.data',
      'Upload the benchmark data',
      'Use the measured numbers',
      'Hand the Pages token to the run',
      'Deploy the site',
      'Hold vx to the live numbers',
    ])
    const step = (name: string | undefined): Step => job.steps!.find((s) => s.name === name)!
    for (const name of after.slice(2, 5)) expect(step(name).if).toBe(push)
    // The site never shows vx worse against Turbo (2026-11-01).
    expect(step('Use the measured numbers').run).toBe(
      `bun private/vx-docs/scripts/bench-gate.ts https://vznjs.github.io/vx/bench.json | tee /dev/stderr | grep '^published=' >> "$GITHUB_OUTPUT"`,
    )
    expect(step('Hold vx to the live numbers').if).toBe(
      `${push} && steps.gate.outputs.published != 'true'`,
    )
    expect(step('Hand the Pages token to the run').with?.['script']).toContain(
      "core.exportVariable('ACTIONS_RUNTIME_TOKEN'",
    )
    expect(step('Deploy the site').run).toBe(
      'bun packages/vx/src/bin.ts run @vzn/vx-docs#deploy.pages',
    )
    expect(job.steps!.some((s) => /deploy-pages|upload-pages-artifact/.test(s.uses ?? ''))).toBe(
      false,
    )
  })

  // A run is what a developer would write (2026-10-23: "super
  // simple"); vx names the run, sizes, starts and cancels its workers.
  it('is checkout, Bun, install, lock check and vx run, nothing else', () => {
    const job = doc.jobs['linux']!
    const run = job.steps!.find((s) => s.run?.includes('bin.ts run '))!.run!
    // The lock check is in the run (2026-10-23: "lock is the most
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

  // The remote cache serves every hit (2026-10-23: "we dont need
  // to carry any vx cache anymore"), and Bun's packages restored took as
  // long as a cold install (4-9 s against about 5 s, main 68b851d): only
  // the sandbox runtime of a worker and of the two benchmark jobs is kept.
  it('carries no vx cache between runs', () => {
    const cached = [...Object.values(doc.jobs), worker].flatMap((j) =>
      j.steps!.filter((s) => s.uses?.startsWith('actions/cache')).map((s) => s.with?.['path']),
    )
    expect(cached).toEqual([
      '~/.cache/vx/setup-debs',
      '~/.cache/vx/setup-debs',
      '~/.cache/vx/setup-debs',
      '~/.cache/vx/setup-debs',
    ])
  })

  // Spotlight indexed what a Mac worker's tasks wrote: a fixed test
  // workload ran 27.6 s with it, 23.3 s without (2026-10-24). Our
  // workflow's concern, not vx's (2026-10-24).
  // Only the check that its run is still on comes before: one API call.
  it('turns Spotlight off on a Mac worker, first and in the background', () => {
    const first = worker.steps![1]!
    expect([first.if, first.run]).toEqual([
      "runner.os == 'macOS'",
      '(sudo mdutil -a -i off && sudo mdutil -a -d) >/dev/null 2>&1 &',
    ])
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
    expect(run.run).toContain("${{ github.event_name == 'push' && 'release' || '' }}")
    expect([job.env?.['GH_TOKEN'], job.permissions?.['contents']]).toEqual([
      '${{ github.token }}',
      'write',
    ])
  })

  // A PR runs what its diff affects (2026-10-23: "PR should run on
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
  // The step github() lists its worker runs for: a run cancelled or
  // timed out can die before it cancels them (2026-10-28).
  it('is cancelled with the run that dispatched it', () => {
    const last = doc.jobs['linux']!.steps!.at(-1)!
    expect([last.if, last.run]).toEqual([
      'cancelled()',
      expect.stringContaining('done < "$RUNNER_TEMP/vx-dte-runs"'),
    ])
    expect(read('vx-worker.yml').on!['workflow_dispatch']).toMatchObject({
      inputs: { parent: { required: false, default: '' } },
    })
  })

  it('runs each size on its runner', () => {
    expect(worker['runs-on']).toBe(
      `\${{ fromJSON('{"small":"ubuntu-latest","arm":"ubuntu-24.04-arm","mac":"macos-latest"}')[inputs.size] }}`,
    )
  })

  // The laws that read history fetch it on the worker that runs them
  // (tests/helpers/history.ts): a full clone was 5-7 s of each warm-up.
  it('checks out one commit', () => {
    expect(checkout(worker)?.with).toEqual({
      ref: '${{ inputs.sha }}',
      'persist-credentials': false,
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

  // setup installs the restored debs with `dpkg -i`, which checks no
  // signature, and a restore takes the newest key of the prefix. A worker
  // runs the code of whatever sha it was handed, so only main's own code
  // may save what every later worker installs as root.
  it('saves the setup packages only from main at main', () => {
    const save = worker.steps!.find((s) => s.uses?.startsWith('actions/cache/save'))!
    expect(save.if).toBe(
      "steps.setup.outputs.fetched == 'true' && github.ref == 'refs/heads/main' && inputs.sha == github.sha",
    )
  })

  // The worker is what a developer would write (2026-10-23: "why vx
  // runner runs twice?"): the runtime set up by the CI plugin before the
  // worker starts (owner: "vx setup github", "we should do before"), its
  // packages kept per runner image, and no mount of its own.
  it('is leave if the run is over, Spotlight off, checkout, Bun, install, the sandbox runtime and the worker', () => {
    expect(worker.steps!.map((s) => s.uses?.split('@')[0] ?? s.run)).toEqual([
      // A worker of a run that is over cancels its own run (@vzn/vx-dte's README).
      expect.stringMatching(/^runs=.*\/cancel"\n$/s),
      '(sudo mdutil -a -i off && sudo mdutil -a -d) >/dev/null 2>&1 &',
      'actions/checkout',
      'oven-sh/setup-bun',
      // The variables the run hands its workers (github({ env })).
      expect.stringMatching(/^jq -r 'to_entries/),
      'bun install --frozen-lockfile',
      'bun install --frozen-lockfile',
      'actions/cache/restore',
      'bun packages/vx/src/bin.ts setup github',
      'actions/cache/save',
      'bun packages/vx/src/bin.ts dte worker',
    ])
  })

  // Of 210 worker installs (2026-10-28, 00:00-12:00 UTC) the median took
  // 4 s, p90 9 s, the slowest that finished on its own 49 s; three
  // printed nothing past `bun install v1.4.4` for 159, 233 and 322 s, two
  // of them until the run ended and cancelled them. A stalled fetch, so a
  // bound and a second try, not a longer wait: the arm worker is the
  // run's only one, and its 322 s held the arm64 binary behind it.
  it('bounds the install and tries it once more after a stall', () => {
    const steps = worker.steps!.filter((s) => s.run === 'bun install --frozen-lockfile')
    expect(steps.map((s) => [s.id, s['timeout-minutes'], s['continue-on-error'], s.if])).toEqual([
      ['install', 2, true, undefined],
      [undefined, 3, undefined, "steps.install.outcome != 'success'"],
    ])
  })
})
