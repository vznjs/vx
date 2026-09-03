#!/usr/bin/env bun
/**
 * Head-to-head benchmark: vx vs Turborepo vs Nx on ONE shared synthetic
 * monorepo. Writes a committed results file (bench/RESULTS.md +
 * bench/results.json) so the numbers in the docs are reproducible and can
 * be referenced from a commit.
 *
 *   bun bench/compare.ts [layers=100] [perLayer=11] [reps=2]
 *   DEPS_PER_PKG=30 BUILD_SLEEP=1 CONCURRENCY=10 bun bench/compare.ts
 *
 * Workspace shape (matches the project owner's benchmark generator):
 * `layers` dependency layers, `perLayer` packages each, plus one `@bench/top`
 * package depending on the whole last layer. Each non-bottom package depends
 * on DEPS_PER_PKG packages from the layer below (deterministic, seeded). At
 * the defaults that's 1090 packages × 3 tasks = 3270 graph nodes.
 *
 * Three tasks per package, IDENTICAL commands across every runner:
 *   build       — `sleep N && mkdir -p dist && touch dist/index.js`  (caches dist/**)
 *   installDeps — `true`, dependsOn ^build  (carries the cross-layer ordering)
 *   test        — `sleep N`, dependsOn installDeps  (no outputs)
 * `sleep N` (BUILD_SLEEP, default 1s) simulates real work so a warm cache
 * hit visibly skips it; set BUILD_SLEEP=0 for pure-overhead runs.
 *
 * For each runner we measure three cache states over the whole repo
 * (`build` + `test`), median of `reps`, every runner pinned to the SAME
 * concurrency and measured strictly one-at-a-time (no resource fight):
 *   fresh        — cache cleared, cold run (key derivation + exec + save)
 *   warm-no-restore — second run, cache hit, outputs intact (skip path)
 *   warm-restore — outputs deleted, cache hit, outputs restored
 *
 * Turbo and Nx run as a user would (daemons on, telemetry/cloud disabled);
 * vx runs as its compiled binary (the artifact users install), plus a
 * `vx (frozen)` variant from a `vx lock` snapshot (zero config eval).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { listSchedule, type GraphNode } from './ideal.js'
import path from 'node:path'

const LAYERS = Number(process.argv[2] ?? 100)
const PER_LAYER = Number(process.argv[3] ?? 11)
const REPS = Number(process.argv[4] ?? 2)
const DEPS_PER_PKG = Number(process.env.DEPS_PER_PKG ?? 30)
// Every runner is pinned to the SAME max concurrency so no tool is
// advantaged by a different default (vx defaults to CPU cores, Turbo to
// 10, Nx to 3). Override with CONCURRENCY=<n>.
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10)
const vxRoot = path.resolve(import.meta.dir, '..')
const PACKAGES = (LAYERS - 1) * PER_LAYER + 1

// `sleep N` simulates real per-task work; BUILD_SLEEP=0 drops it.
const BUILD_SLEEP = process.env.BUILD_SLEEP ?? '1'
const sleepPrefix = BUILD_SLEEP === '0' ? '' : `sleep ${BUILD_SLEEP} && `
const BUILD_CMD = `${sleepPrefix}mkdir -p dist && touch dist/index.js`
const TEST_CMD = BUILD_SLEEP === '0' ? 'true' : `sleep ${BUILD_SLEEP}`
const INSTALL_CMD = 'true'

const RUNNER_ENV = {
  ...process.env,
  NO_COLOR: '1',
  CI: '1',
  TURBO_TELEMETRY_DISABLED: '1',
  DO_NOT_TRACK: '1',
  NX_CLOUD: 'false',
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

/**
 * Wall time and CPU time of one invocation. CPU is the runner process plus
 * every descendant it waited for (`getrusage(RUSAGE_CHILDREN)` semantics,
 * which Bun exposes as `resourceUsage()` after exit). A daemon that outlives
 * the invocation (Turbo's, Nx's) is NOT counted, so their CPU is a floor.
 */
async function sh(
  cmd: string[],
  cwd: string,
): Promise<{ ms: number; cpuMs: number; ok: boolean; out: string }> {
  const t0 = Bun.nanoseconds()
  const p = Bun.spawn({ cmd, cwd, stdout: 'pipe', stderr: 'pipe', env: RUNNER_ENV })
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  const usage = p.resourceUsage()
  // Bun reports cpuTime as BigInt microseconds.
  const cpuMs = usage ? Number(usage.cpuTime.user + usage.cpuTime.system) / 1000 : NaN
  return { ms: (Bun.nanoseconds() - t0) / 1e6, cpuMs, ok: code === 0, out: out + err }
}

// ---- scaffolding ----

// Deterministic pseudo-random so dependency picks are stable across runs.
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pkgName = (layer: number, idx: number) =>
  layer === LAYERS ? '@bench/top' : `@bench/l${layer}-${idx}`
const pkgDirName = (layer: number, idx: number) => (layer === LAYERS ? 'top' : `l${layer}-${idx}`)

function depsFor(layer: number, idx: number): Record<string, string> {
  const deps: Record<string, string> = {}
  if (layer <= 1) return deps
  if (layer === LAYERS) {
    for (let i = 1; i <= PER_LAYER; i++) deps[pkgName(LAYERS - 1, i)] = 'workspace:*'
    return deps
  }
  const rand = mulberry32(layer * 1000 + idx)
  const pool = Array.from({ length: PER_LAYER }, (_, i) => i + 1)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  for (const i of pool.slice(0, DEPS_PER_PKG)) deps[pkgName(layer - 1, i)] = 'workspace:*'
  return deps
}

async function generate(dir: string): Promise<void> {
  const json = (p: string, obj: unknown) =>
    writeFile(path.join(dir, p), JSON.stringify(obj, null, 2) + '\n')

  await mkdir(path.join(dir, 'packages'), { recursive: true })
  await writeFile(
    path.join(dir, '.gitignore'),
    ['node_modules', 'dist', '.vx', '.turbo', '.nx', '.vx-runner', '*.tsbuildinfo'].join('\n') +
      '\n',
  )
  // Root: a workspace Turbo, Nx, and vx all discover. `packageManager` +
  // the install-written lockfile satisfy Turbo.
  await json('package.json', {
    name: 'bench-root',
    version: '0.0.0',
    private: true,
    packageManager: 'bun@1.3.11',
    workspaces: ['packages/*'],
  })
  await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  // NO DEFAULTS: a workspace declares its executor and cache. By absolute
  // path into this checkout, since the tmp dir has no `@vzn/vx` in
  // node_modules; the plugin files' own `@vzn/vx` import resolves through
  // the checkout's node_modules (the self-link), for the binary as well.
  await writeFile(
    path.join(dir, 'vx.workspace.mjs'),
    `import { localExecutorPlugin } from ${JSON.stringify(path.join(vxRoot, 'packages/vx/src/plugins/local-executor/index.ts'))}\n` +
      `import { localCachePlugin } from ${JSON.stringify(path.join(vxRoot, 'packages/vx/src/plugins/local-cache/index.ts'))}\n` +
      `export default { plugins: [localExecutorPlugin(), localCachePlugin()] }\n`,
  )
  await json('turbo.json', {
    $schema: 'https://turborepo.com/schema.json',
    tasks: { build: {}, installDeps: {}, test: {} },
  })
  await json('nx.json', {
    $schema: './node_modules/nx/schemas/nx-schema.json',
    parallel: CONCURRENCY,
    namedInputs: { default: ['{projectRoot}/**/*'], production: ['default'] },
    analytics: false,
  })

  for (let layer = 1; layer <= LAYERS; layer++) {
    const count = layer === LAYERS ? 1 : PER_LAYER
    for (let idx = 1; idx <= count; idx++) {
      const name = pkgName(layer, idx)
      const rel = path.join('packages', pkgDirName(layer, idx))
      const dirAbs = path.join(dir, rel)
      await mkdir(path.join(dirAbs, 'src'), { recursive: true })
      const deps = depsFor(layer, idx)

      await json(path.join(rel, 'package.json'), {
        name,
        version: '0.0.0',
        private: true,
        main: 'dist/index.js',
        scripts: { build: BUILD_CMD, installDeps: INSTALL_CMD, test: TEST_CMD },
        dependencies: deps,
      })
      // Turbo: per-package config; build/test hash everything, installDeps
      // carries the cross-layer edge (^build).
      await json(path.join(rel, 'turbo.json'), {
        extends: ['//'],
        tasks: {
          build: { dependsOn: ['installDeps'], inputs: ['src/**'], outputs: ['dist/**'] },
          installDeps: { dependsOn: ['^build'], inputs: [], outputs: [], cache: true },
          test: { dependsOn: ['installDeps'], inputs: ['src/**'], outputs: [] },
        },
      })
      // Nx: same three targets via run-script; deps inferred from package.json.
      await json(path.join(rel, 'project.json'), {
        name,
        $schema: '../../node_modules/nx/schemas/project-schema.json',
        sourceRoot: `${rel}/src`,
        projectType: 'library',
        targets: {
          build: {
            executor: 'nx:run-script',
            options: { script: 'build' },
            dependsOn: ['installDeps'],
            inputs: ['{projectRoot}/src/**'],
            outputs: ['{projectRoot}/dist'],
            cache: true,
          },
          installDeps: {
            executor: 'nx:run-script',
            options: { script: 'installDeps' },
            dependsOn: ['^build'],
            inputs: [],
            outputs: [],
            cache: true,
          },
          test: {
            executor: 'nx:run-script',
            options: { script: 'test' },
            dependsOn: ['installDeps'],
            inputs: ['{projectRoot}/src/**'],
            outputs: [],
            cache: true,
          },
        },
      })
      // vx: same graph. installDeps is a group task (no exec) carrying ^build.
      await writeFile(
        path.join(dirAbs, 'vx.config.ts'),
        `export default {
  tasks: {
    build: {
      exec: { command: ${JSON.stringify(BUILD_CMD)} },
      dependsOn: ['installDeps'],
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
    installDeps: { dependsOn: ['^build'] },
    test: {
      exec: { command: ${JSON.stringify(TEST_CMD)} },
      dependsOn: ['installDeps'],
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
    },
  },
}
`,
      )
      await writeFile(
        path.join(dirAbs, 'src', 'index.js'),
        `module.exports = ${JSON.stringify(name)}\n`,
      )
    }
  }
}

// git is required by vx (input hashing). Commit AFTER install so the
// lockfile is tracked and the tree is clean — the realistic scenario, and
// the one where vx's git-OID hashing does zero file reads.
async function gitInit(dir: string): Promise<void> {
  await sh(['git', 'init', '-q'], dir)
  await sh(['git', 'add', '-A'], dir)
  await sh(
    [
      'git',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.email=b@b.b',
      '-c',
      'user.name=b',
      'commit',
      '-qm',
      'init',
    ],
    dir,
  )
}

async function deleteDist(dir: string): Promise<void> {
  const glob = new Bun.Glob('packages/*/dist')
  const jobs: Promise<void>[] = []
  for await (const rel of glob.scan({ cwd: dir, onlyFiles: false })) {
    jobs.push(rm(path.join(dir, rel), { recursive: true, force: true }))
  }
  await Promise.all(jobs)
}

// ---- runners ----

interface Runner {
  name: string
  version: string
  run: string[]
  clear: () => Promise<void>
}

async function buildRunners(dir: string): Promise<Runner[]> {
  const runners: Runner[] = []

  // vx — compile the standalone binary (the artifact real users install via
  // npm / release.yml). Comparing TS-source startup against Turbo's
  // and Nx's precompiled binaries would handicap vx unfairly.
  const vxBin = path.join(dir, '.vx-runner')
  const target = `bun-${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`
  const compiled = await sh(
    [
      'bun',
      'build',
      '--compile',
      '--minify',
      '--bytecode',
      `--target=${target}`,
      path.join(vxRoot, 'packages', 'vx', 'src', 'bin.ts'),
      '--outfile',
      vxBin,
    ],
    vxRoot,
  )
  // Bun 1.4.0's compiled binary carries a signature this macOS rejects
  // (SIGKILL on launch, exit 137 — see docs/benchmarks.md); an ad-hoc
  // re-sign repairs it, exactly as release.yml does. Fall back to the source
  // tree only when the binary still cannot answer `--version`.
  if (compiled.ok && process.platform === 'darwin')
    await sh(['codesign', '-s', '-', '--force', vxBin], dir)
  const binWorks = compiled.ok && (await sh([vxBin, '--version'], dir)).ok
  if (compiled.ok && !binWorks)
    console.error('  compiled vx binary does not launch; measuring from source')
  const vxRun = binWorks
    ? [vxBin]
    : [process.execPath, path.join(vxRoot, 'packages', 'vx', 'src', 'bin.ts')]
  const vxVer = (await sh([...vxRun, '--version'], dir)).out.trim()
  const conc = ['--concurrency', String(CONCURRENCY)]
  runners.push({
    name: compiled.ok ? 'vx' : 'vx (ts-source)',
    version: vxVer || 'workspace',
    run: [...vxRun, 'run', 'build', 'test', '--all', ...conc],
    clear: () => rm(path.join(dir, '.vx'), { recursive: true, force: true }),
  })

  // vx (frozen): freeze the resolved config graph into vx-lock.json once,
  // then run from it (no per-run config evaluation — the CI fast path).
  const locked = await sh([...vxRun, 'lock'], dir)
  if (compiled.ok && locked.ok) {
    runners.push({
      name: 'vx (frozen)',
      version: vxVer || 'workspace',
      run: [...vxRun, 'run', 'build', 'test', '--all', ...conc, '--frozen'],
      clear: () => rm(path.join(dir, '.vx'), { recursive: true, force: true }),
    })
  }

  // turbo + nx — installed into the generated workspace.
  const bin = (t: string) => path.join(dir, 'node_modules', '.bin', t)
  const turboV = await sh([bin('turbo'), '--version'], dir)
  if (turboV.ok) {
    runners.push({
      name: 'turbo',
      version: turboV.out.trim(),
      run: [bin('turbo'), 'run', 'build', 'test', `--concurrency=${CONCURRENCY}`],
      clear: async () => {
        await sh([bin('turbo'), 'daemon', 'stop'], dir)
        await rm(path.join(dir, '.turbo'), { recursive: true, force: true })
        await rm(path.join(dir, 'node_modules', '.cache', 'turbo'), {
          recursive: true,
          force: true,
        })
      },
    })
  }
  const nxV = await sh([bin('nx'), '--version'], dir)
  if (nxV.ok) {
    runners.push({
      name: 'nx',
      version: (nxV.out.match(/Local:\s*v?([\d.]+)/)?.[1] ?? nxV.out.trim()).slice(0, 12),
      run: [bin('nx'), 'run-many', '-t', 'build', 'test', `--parallel=${CONCURRENCY}`],
      clear: () => sh([bin('nx'), 'reset'], dir).then(() => undefined),
    })
  }
  return runners
}

// Stop any daemon a previous runner left running so it can't idle-contend
// for CPU while the next runner is timed. (vx has no daemon; Turbo and Nx
// each keep one alive.)
async function quiesce(dir: string): Promise<void> {
  const bin = (t: string) => path.join(dir, 'node_modules', '.bin', t)
  await sh([bin('turbo'), 'daemon', 'stop'], dir).catch(() => undefined)
  await sh([bin('nx'), 'reset'], dir).catch(() => undefined)
}

type Row = {
  runner: string
  version: string
  fresh: number
  warmNoRestore: number
  warmRestore: number
  /** CPU (user + system) of the invocation and the children it waited for, per state. */
  freshCpu: number
  warmNoRestoreCpu: number
  warmRestoreCpu: number
}

async function measure(r: Runner, dir: string): Promise<Row> {
  const fresh: number[] = []
  const freshCpu: number[] = []
  for (let i = 0; i < REPS; i++) {
    await r.clear()
    const res = await sh(r.run, dir)
    if (!res.ok) throw new Error(`${r.name} failed:\n${res.out.slice(-2000)}`)
    fresh.push(res.ms)
    freshCpu.push(res.cpuMs)
  }
  const warmNoRestore: number[] = []
  const warmNoRestoreCpu: number[] = []
  for (let i = 0; i < REPS; i++) {
    const res = await sh(r.run, dir)
    warmNoRestore.push(res.ms)
    warmNoRestoreCpu.push(res.cpuMs)
  }
  const warmRestore: number[] = []
  const warmRestoreCpu: number[] = []
  for (let i = 0; i < REPS; i++) {
    await deleteDist(dir)
    const res = await sh(r.run, dir)
    warmRestore.push(res.ms)
    warmRestoreCpu.push(res.cpuMs)
  }
  return {
    runner: r.name,
    version: r.version,
    fresh: median(fresh),
    warmNoRestore: median(warmNoRestore),
    warmRestore: median(warmRestore),
    freshCpu: median(freshCpu),
    warmNoRestoreCpu: median(warmNoRestoreCpu),
    warmRestoreCpu: median(warmRestoreCpu),
  }
}

// ---- report ----

function fmt(ms: number): string {
  if (Number.isNaN(ms)) return 'n/a'
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`
}

function markdown(rows: Row[], baseline: Baseline): string {
  const vx = rows.find((r) => r.runner === 'vx')
  const speed = (
    row: Row,
    key: 'fresh' | 'warmNoRestore' | 'warmRestore' | 'freshCpu' | 'warmNoRestoreCpu',
  ) => {
    if (!vx || row.runner === 'vx' || vx[key] === 0 || Number.isNaN(row[key])) return ''
    return ` (${(row[key] / vx[key]).toFixed(1)}× vx)`
  }
  const head = `# Benchmark results — vx vs Turborepo vs Nx

<!-- Generated by \`bun bench/compare.ts\`. Do not edit by hand. -->

- **Workspace:** ${PACKAGES} packages, ${LAYERS} layers × ${PER_LAYER}, ~${DEPS_PER_PKG} deps/package, 3 tasks (build + installDeps + test) = ${PACKAGES * 3} graph nodes.
- **Tasks:** \`build\` = \`${BUILD_CMD}\`; \`test\` = \`${TEST_CMD}\`; \`installDeps\` = \`${INSTALL_CMD}\` — identical across all runners.
- **Concurrency:** ${CONCURRENCY} (pinned identically for every runner).
- **Measured:** whole-repo \`build\`+\`test\`, median of ${REPS}, one runner at a time, wall-clock of the CLI invocation.
- **Host:** ${os.type()} ${os.release()} · ${os.cpus().length} cores · ${process.platform}/${process.arch}
- **Date:** ${new Date().toISOString().slice(0, 10)}

| Runner | Version | Fresh (cold) | Warm (no restore) | Warm (restore) | CPU, cold | CPU, warm |
| ------ | ------- | ------------ | ----------------- | -------------- | --------- | --------- |
| baseline (ideal) | — | ${fmt(baseline.fresh)} | ${fmt(baseline.warmNoRestore)} | ${fmt(baseline.warmRestore)} | ${fmt(baseline.freshCpu)} | ${fmt(baseline.warmNoRestoreCpu)} |
`
  const body = rows
    .map(
      (r) =>
        `| ${r.runner} | ${r.version} | ${fmt(r.fresh)}${speed(r, 'fresh')} | ${fmt(r.warmNoRestore)}${speed(r, 'warmNoRestore')} | ${fmt(r.warmRestore)}${speed(r, 'warmRestore')} | ${fmt(r.freshCpu)}${speed(r, 'freshCpu')} | ${fmt(r.warmNoRestoreCpu)}${speed(r, 'warmNoRestoreCpu')} |`,
    )
    .join('\n')
  return `${head}${body}

**Cache states.** *Fresh* clears the runner's cache and runs cold (key
derivation + execution + save). *Warm, no restore* re-runs with the cache
warm and outputs intact (the steady-state dev loop). *Warm, restore*
deletes every \`dist/\` first, so the runner restores outputs from cache.

**Baseline** is the theoretical best case, so each row shows its overhead:
cold is the tasks' own durations list-scheduled on ${CONCURRENCY} workers along the
exact dependency graph (critical path ${fmt(baseline.criticalPathMs)}, total work ÷ workers
${fmt(baseline.workBoundMs)}); warm is ONE \`git status -uall\` walk — the floor of asking
what changed; restore adds a raw copy of every output file; CPU is the tasks'
own shells (one measured spawn × the task count) plus that walk.

**CPU** is user + system time of the invocation and every child it waited
for (the tasks themselves are \`sleep\`, so this is the runner's own
work). A daemon that outlives the invocation (Turbo's, Nx's) is not
counted, so their CPU is a floor.

Reproduce: \`bun bench/compare.ts ${LAYERS} ${PER_LAYER} ${REPS}\`.
`
}

// ---- main ----

// ---- baseline: the theoretical best case, so every bar shows its overhead ----
//
// Cold: the tasks' own durations list-scheduled on CONCURRENCY workers along
// the exact dependency graph (a greedy schedule; with uniform durations it
// is within one task of optimal and never below the true lower bound
// max(critical path, total work / workers)). Warm: nothing executes, but a
// correct cached runner must still ask git what changed — ONE
// `git status --porcelain -uall` walk is the floor, measured. Restore: that
// walk plus a raw copy of every output file back into place, measured. CPU:
// the tasks' own shells (one measured spawn × the task count) plus the walk.
type Baseline = {
  fresh: number
  warmNoRestore: number
  warmRestore: number
  freshCpu: number
  warmNoRestoreCpu: number
  criticalPathMs: number
  workBoundMs: number
}

function idealMakespanMs(sleepMs: number): { makespan: number; critical: number; work: number } {
  // Nodes: per package build (sleep), installDeps (0), test (sleep).
  // build → installDeps → ^build (deps' builds); test → installDeps.
  const nodes: GraphNode[] = []
  const idOf = new Map<string, number>()
  const add = (id: string, dur: number): void => {
    idOf.set(id, nodes.length)
    nodes.push({ id, dur, deps: [] })
  }
  for (let layer = 1; layer <= LAYERS; layer++) {
    for (let idx = 1; idx <= (layer === LAYERS ? 1 : PER_LAYER); idx++) {
      const name = pkgName(layer, idx)
      add(`${name}#installDeps`, 0)
      add(`${name}#build`, sleepMs)
      add(`${name}#test`, sleepMs)
    }
  }
  const link = (from: string, to: string): void => {
    nodes[idOf.get(to)!]!.deps.push(idOf.get(from)!)
  }
  for (let layer = 1; layer <= LAYERS; layer++) {
    for (let idx = 1; idx <= (layer === LAYERS ? 1 : PER_LAYER); idx++) {
      const name = pkgName(layer, idx)
      link(`${name}#installDeps`, `${name}#build`)
      link(`${name}#installDeps`, `${name}#test`)
      for (const dep of Object.keys(depsFor(layer, idx)))
        link(`${dep}#build`, `${name}#installDeps`)
    }
  }
  return listSchedule(nodes, CONCURRENCY)
}

async function measureBaseline(dir: string): Promise<Baseline> {
  const sleepMs = Number(BUILD_SLEEP) * 1000
  const ideal = idealMakespanMs(sleepMs)
  // The floor of "did anything change": one untracked walk, best of 5.
  const status = ['git', 'status', '--porcelain', '-z', '-uall']
  const walks: Array<{ ms: number; cpuMs: number }> = []
  for (let i = 0; i < 5; i++) walks.push(await sh(status, dir))
  const walk = walks.sort((a, b) => a.ms - b.ms)[0]!
  // The floor of restoring: every output file written back from a pristine
  // copy, best of 3 (the outputs are exactly what `build` produces).
  const snapshot = path.join(dir, '.baseline-outputs')
  await rm(snapshot, { recursive: true, force: true })
  await mkdir(snapshot, { recursive: true })
  const pkgDirs: string[] = []
  for (let layer = 1; layer <= LAYERS; layer++) {
    for (let idx = 1; idx <= (layer === LAYERS ? 1 : PER_LAYER); idx++) {
      pkgDirs.push(pkgDirName(layer, idx))
    }
  }
  for (const d of pkgDirs) {
    await mkdir(path.join(snapshot, d, 'dist'), { recursive: true })
    await writeFile(path.join(snapshot, d, 'dist', 'index.js'), '')
  }
  const copies: number[] = []
  for (let i = 0; i < 3; i++) {
    await deleteDist(dir)
    const t0 = Bun.nanoseconds()
    await Promise.all(
      pkgDirs.map(async (d) => {
        await mkdir(path.join(dir, 'packages', d, 'dist'), { recursive: true })
        await Bun.write(
          path.join(dir, 'packages', d, 'dist', 'index.js'),
          Bun.file(path.join(snapshot, d, 'dist', 'index.js')),
        )
      }),
    )
    copies.push((Bun.nanoseconds() - t0) / 1e6)
  }
  await rm(snapshot, { recursive: true, force: true })
  const copy = Math.min(...copies)
  // The tasks' own CPU: the exact commands under the thinnest runner there
  // is — `xargs -P CONCURRENCY sh -c` — in one resource-usage reading.
  // Sampling one spawn at a time over-counted process creation (it read
  // above vx's whole cold run); xargs's own CPU is noise, and this is the
  // floor every runner's "CPU, cold" is measured against.
  const cmds: string[] = []
  for (const d of pkgDirs) {
    const cwd = path.join(dir, 'packages', d)
    cmds.push(
      `cd ${cwd} && ${BUILD_CMD}`,
      `cd ${cwd} && ${TEST_CMD}`,
      `cd ${cwd} && ${INSTALL_CMD}`,
    )
  }
  const list = path.join(dir, '.baseline-cmds.txt')
  await writeFile(list, cmds.join('\n') + '\n')
  // Best of two: the same 3,270 shells read 33.5 s and 34.9 s back to back
  // (2026-09-03), so one reading has ±1 s of noise — the size of a good
  // runner's entire overhead.
  const xargsCpu: number[] = []
  for (let i = 0; i < 2; i++) {
    const xargs = await sh(['sh', '-c', `xargs -P ${CONCURRENCY} -I{} sh -c '{}' < ${list}`], dir)
    if (!xargs.ok) throw new Error(`baseline xargs failed:\n${xargs.out.slice(-500)}`)
    xargsCpu.push(xargs.cpuMs)
    await deleteDist(dir)
  }
  await rm(list, { force: true })
  const tasksCpu = Math.min(...xargsCpu)
  return {
    fresh: ideal.makespan,
    warmNoRestore: walk.ms,
    warmRestore: walk.ms + copy,
    freshCpu: tasksCpu + walk.cpuMs,
    warmNoRestoreCpu: walk.cpuMs,
    criticalPathMs: ideal.critical,
    workBoundMs: ideal.work / CONCURRENCY,
  }
}

const BASELINE_ONLY = process.env['BASELINE_ONLY'] === '1'

const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-compare-'))

console.error(`scaffolding ${PACKAGES} packages × ${LAYERS} layers in ${ws} …`)
await generate(ws)

let rows: Row[] = []
let runners: Runner[] = []
if (BASELINE_ONLY) {
  // Recompute only the baseline against the committed rows (the full
  // comparison is ~50 minutes; the floors take one).
  const prior = JSON.parse(await Bun.file(path.join(vxRoot, 'bench', 'results.json')).text()) as {
    rows: Row[]
  }
  rows = prior.rows
  await gitInit(ws)
} else {
  console.error('installing turbo + nx into the workspace …')
  const install = await sh(['bun', 'add', '-d', 'turbo', 'nx', '--no-save'], ws).catch(() => null)
  if (!install || !install.ok) await sh(['bun', 'add', '-d', 'turbo', 'nx'], ws)
  runners = await buildRunners(ws)
  // RUNNERS=vx,turbo re-measures a subset and keeps the committed rows of
  // the rest (a vx-only refresh is ~5 minutes; Nx alone is ~40).
  const only = process.env['RUNNERS']
    ?.split(',')
    .map((n) => n.trim())
    .filter(Boolean)
  if (only && only.length > 0) {
    runners = runners.filter((r) => only.includes(r.name))
    const prior = JSON.parse(await Bun.file(path.join(vxRoot, 'bench', 'results.json')).text()) as {
      rows: Row[]
    }
    rows = prior.rows.filter((r) => !only.includes(r.runner))
  }
  await gitInit(ws)
  console.error(`runners: ${runners.map((r) => `${r.name}@${r.version}`).join(', ')}`)
}

// Runners are measured ONE AT A TIME (never concurrently) so they don't
// fight over CPU/disk and skew each other's timings.
for (const r of runners) {
  await quiesce(ws)
  console.error(`measuring ${r.name} …`)
  try {
    rows.push(await measure(r, ws))
  } catch (err) {
    const lines = (err as Error).message.split('\n').filter((l) => l.trim() !== '')
    console.error(`  ${r.name} skipped: ${lines[0]} ${lines[1] ?? ''}`)
    rows.push({
      runner: r.name,
      version: r.version,
      fresh: NaN,
      warmNoRestore: NaN,
      warmRestore: NaN,
      freshCpu: NaN,
      warmNoRestoreCpu: NaN,
      warmRestoreCpu: NaN,
    })
  }
}

const ORDER = ['vx', 'vx (frozen)', 'turbo', 'nx']
rows.sort((a, b) => ORDER.indexOf(a.runner) - ORDER.indexOf(b.runner))
console.error('measuring the baseline (ideal schedule, one git walk, a raw copy) …')
const baseline = await measureBaseline(ws)
const md = markdown(rows, baseline)
await writeFile(path.join(vxRoot, 'bench', 'RESULTS.md'), md)
await writeFile(
  path.join(vxRoot, 'bench', 'results.json'),
  JSON.stringify(
    {
      layers: LAYERS,
      perLayer: PER_LAYER,
      packages: PACKAGES,
      depsPerPkg: DEPS_PER_PKG,
      concurrency: CONCURRENCY,
      reps: REPS,
      buildSleep: BUILD_SLEEP,
      date: new Date().toISOString(),
      rows,
      baseline,
    },
    null,
    2,
  ) + '\n',
)

console.error('\n' + md)
console.error('\nwrote bench/RESULTS.md + bench/results.json')
await rm(ws, { recursive: true, force: true })
