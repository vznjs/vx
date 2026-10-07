// npm.yml's publish job ran `vx run build.bun.<target>` on a Linux runner that
// had none of the sandbox runtime's dependencies, so v0.0.20's two compile
// tasks failed in 0 ms — "sandbox not available: ripgrep (rg) not found;
// bubblewrap (bwrap) not installed; socat not installed" — and @vzn/vx never
// reached the registry, while the macOS job had already published its two
// platform packages. Every task in this repo declares `exec.sandbox` and a
// declared sandbox that cannot be built is a hard error, so the rule is the
// class: a Linux job that runs a vx task installs the runtime first, and
// `.github/actions/vx-runner` is the single place that install is written.
//
// `.unsafe`: the workflows live at the repo root, which a sandboxed project
// task may not read (the cross-project law).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const repo = path.resolve(import.meta.dir, '..', '..', '..')
const workflowDir = path.join(repo, '.github', 'workflows')
const RUNNER_ACTION = './.github/actions/vx-runner'

interface Step {
  uses?: string
  run?: string
}
interface Job {
  'runs-on'?: string
  steps?: Step[]
}

const files = readdirSync(workflowDir)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort()

function jobsOf(file: string): [string, Job][] {
  const doc = Bun.YAML.parse(readFileSync(path.join(workflowDir, file), 'utf8')) as {
    jobs?: Record<string, Job>
  }
  return Object.entries(doc.jobs ?? {})
}

// A vx task, launched from source (`src/bin.ts run`).
const runsVxTask = (s: Step) => typeof s.run === 'string' && /\bbin\.ts run\b/.test(s.run)

const covered: string[] = []
const missing: string[] = []
for (const file of files) {
  for (const [name, job] of jobsOf(file)) {
    const steps = job.steps ?? []
    if (!steps.some(runsVxTask)) continue
    if (!String(job['runs-on'] ?? '').startsWith('ubuntu')) continue
    covered.push(`${file}#${name}`)
    if (!steps.some((s) => s.uses === RUNNER_ACTION)) missing.push(`${file}#${name}`)
  }
}
describe('a Linux CI job that runs a vx task', () => {
  it('is every one of these — the pin is not vacuous', () => {
    expect(covered).toEqual([
      'auto-release.yml#release',
      'ci.yml#ci',
      'ci.yml#packages',
      'ci.yml#binary-linux-arm64',
      'docs.yml#build',
      'npm.yml#publish',
      'release.yml#assets',
    ])
  })

  it('installs the sandbox runtime through the shared action', () => {
    expect(missing).toEqual([])
  })

  it('gets the three binaries the availability probe names, plus strace', () => {
    const action = readFileSync(
      path.join(repo, '.github', 'actions', 'vx-runner', 'action.yml'),
      'utf8',
    )
    const absent = ['bubblewrap', 'socat', 'strace', 'ripgrep'].filter((d) => !action.includes(d))
    expect(absent).toEqual([])
  })
})

// CI runs vx tasks, never commands of its own (owner, 2026-10-03): the
// release logic lives in `release.*` tasks (scripts/release.ts,
// scripts/auto-release.ts), where it is typed, tested and sandboxed. The
// three release workflows run nothing but the install and vx tasks, and no
// workflow inlines a script or does a task's job itself.
describe('a workflow `run:` step', () => {
  const steps = files.flatMap((file) =>
    jobsOf(file).flatMap(([name, job]) =>
      (job.steps ?? [])
        .filter((s) => typeof s.run === 'string')
        .map((s) => ({ at: `${file}#${name}`, run: s.run!.trim() })),
    ),
  )

  it("inlines no script and does no release task's job", () => {
    const offenders = steps
      .filter(({ run }) => /\b(?:bun|node) -[ep]\b|npm publish|codesign/.test(run))
      .map(({ at, run }) => `${at}: ${run}`)
    expect(offenders).toEqual([])
  })

  it('in a release workflow, is the install or one vx task', () => {
    const release = steps.filter(({ at }) => /^(?:npm|release|auto-release)\.yml#/.test(at))
    expect(release.length).toBeGreaterThan(10)
    const custom = release
      .filter(
        ({ run }) =>
          run !== 'bun install --frozen-lockfile' &&
          !/^bun packages\/vx\/src\/bin\.ts run [\w. -]+ --filter @vzn\/vx(?: --concurrency \d+)?$/.test(
            run,
          ),
      )
      .map(({ at, run }) => `${at}: ${run}`)
    expect(custom).toEqual([])
  })
})

// The other half of "a skip is a silent pass": a suite that reads a path or an
// endpoint out of the environment and skips when it is absent runs ONLY where
// something sets it. `VX_REQUIRE_SANDBOX` and `VX_REQUIRE_REAPI` exist because
// of exactly that, and both are set by hand in ci.yml — so nothing catches the
// next gate of this shape being added and never enabled, or an existing one
// renamed on one side only.
//
// The shape is what separates a GATE from a knob: a bare read (`const SMALL =
// process.env['VX_SMALL_DISK']`) makes the value itself the resource, so its
// absence skips. A read compared to a literal or given a `??` default
// (`VX_PERF === '0'`, `VX_PERF_SCALE ?? '3'`) is a knob with a working
// default, and CI setting it would mean nothing.
describe('a suite that skips without an env var', () => {
  const testFiles: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.ts')) testFiles.push(full)
    }
  }
  for (const pkg of readdirSync(path.join(repo, 'packages'))) {
    const dir = path.join(repo, 'packages', pkg, 'tests')
    if (existsSync(dir)) walk(dir)
  }
  const gates = new Map<string, string>()
  for (const file of testFiles) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(
      /^(?:const|let)\s+\w+\s*=\s*(?:Bun|process)\.env\[\s*'(VX_\w+)'\s*\]\s*$/gm,
    )) {
      gates.set(m[1]!, path.relative(repo, file))
    }
  }
  const declared = new Set<string>()
  for (const file of files) {
    for (const m of readFileSync(path.join(workflowDir, file), 'utf8').matchAll(
      /^\s+(VX_\w+):/gm,
    )) {
      declared.add(m[1]!)
    }
  }

  it('is found by the shape, not by a list — and there are some', () => {
    expect(testFiles.length).toBeGreaterThan(100)
    expect([...gates.keys()].sort()).toEqual([
      'VX_NX_MODULES',
      'VX_REAPI_EXEC_ENDPOINT',
      'VX_REAPI_TEST_ENDPOINT',
      'VX_SMALL_DISK',
    ])
  })

  it('has that var set by a CI workflow, or it never runs anywhere', () => {
    const unset = [...gates].filter(([name]) => !declared.has(name)).map(([n, f]) => `${n} (${f})`)
    expect(unset).toEqual([])
  })
})

// The OTHER other half. The law above proves a gate is SET by a workflow; it
// says nothing about whether the value survives the trip to the test process,
// and `vx run` isolates a task's environment on purpose — a var absent from
// the task's `exec.env.passThrough` is dropped, and the gate it was meant to
// arm becomes a no-op that reports green.
//
// That is a hard defect to notice from a run, because a gate is only
// OBSERVABLE when it fires: VX_REQUIRE_NONROOT on a non-root runner behaves
// identically whether it arrived or was dropped (item 482, which found it by
// trying to write the run-time assertion and discovering it cannot exist).
// So assert it statically, on the two lists, where it is decidable.
describe('a VX_ var a workflow sets reaches the task that reads it', () => {
  const declaredInWorkflows = new Set<string>()
  for (const file of files) {
    for (const m of readFileSync(path.join(workflowDir, file), 'utf8').matchAll(
      /^\s+(VX_\w+):/gm,
    )) {
      declaredInWorkflows.add(m[1]!)
    }
  }

  const forwarded = new Set<string>()
  const configs = [path.join(repo, 'vx.config.ts')]
  for (const pkg of readdirSync(path.join(repo, 'packages'))) {
    configs.push(path.join(repo, 'packages', pkg, 'vx.config.ts'))
  }
  for (const file of configs.filter((f) => existsSync(f))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/'(VX_\w+)'/g)) {
      forwarded.add(m[1]!)
    }
  }

  it('is found by the shape, not by a list — and there are some', () => {
    expect(declaredInWorkflows.size).toBeGreaterThan(3)
  })

  it('appears in some task’s passThrough, or `vx run` drops it on the way in', () => {
    const dropped = [...declaredInWorkflows].filter((n) => !forwarded.has(n)).sort()
    expect(dropped).toEqual([])
  })
})
