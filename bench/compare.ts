#!/usr/bin/env bun
/**
 * Head-to-head benchmark: vx vs Turborepo vs Nx on ONE shared synthetic
 * monorepo. Writes a committed results file (bench/RESULTS.md +
 * bench/results.json) so the numbers in the docs are reproducible and
 * can be referenced from a commit.
 *
 *   bun bench/compare.ts [packages=1000] [layers=10] [reps=2]
 *
 * The workspace: `packages` packages across `layers` dependency layers
 * (each package depends on a few packages in the previous layer). Every
 * package has the SAME two tasks, identical across all three runners:
 *   build — `sleep 1 && mkdir -p dist && : > dist/out.txt`  (BUILD_SLEEP=0 to drop the sleep)
 *   test  — `true`                                          (no-op, no outputs)
 *
 * For each runner we measure three cache states over the whole repo
 * (build + test), median of `reps`, all pinned to the SAME concurrency:
 *   fresh        — cache cleared, cold run (key derivation + exec + save)
 *   warm-no-restore — second run, cache hit, outputs intact (skip path)
 *   warm-restore — outputs deleted, cache hit, outputs restored
 *
 * Turbo and Nx are invoked as a user would (daemons on, telemetry/cloud
 * disabled); vx runs as its compiled binary (the artifact users install).
 * A runner that fails to install/run is recorded as unavailable rather
 * than aborting the comparison.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const PACKAGES = Number(process.argv[2] ?? 1000)
const LAYERS = Number(process.argv[3] ?? 10)
const REPS = Number(process.argv[4] ?? 2)
const DEPS_PER_PKG = 3
// Every runner is pinned to the SAME max concurrency so no tool is
// advantaged by a different default (vx defaults to CPU cores, Turbo to
// 10, Nx to 3). Override with CONCURRENCY=<n>.
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10)
const vxRoot = path.resolve(import.meta.dir, '..')

// Identical task commands for every runner — pure POSIX shell, no quoting
// hazards, no Node dependency in the measured command itself. `build`
// sleeps to simulate real work (so a cold run reflects task duration, and
// a warm hit visibly skips it); set BUILD_SLEEP=0 for pure-overhead runs.
const BUILD_SLEEP = process.env.BUILD_SLEEP ?? '1'
const BUILD_CMD =
  (BUILD_SLEEP === '0' ? '' : `sleep ${BUILD_SLEEP} && `) + 'mkdir -p dist && : > dist/out.txt'
const TEST_CMD = 'true'

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

async function sh(cmd: string[], cwd: string): Promise<{ ms: number; ok: boolean; out: string }> {
  const t0 = Bun.nanoseconds()
  const p = Bun.spawn({ cmd, cwd, stdout: 'pipe', stderr: 'pipe', env: RUNNER_ENV })
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  return { ms: (Bun.nanoseconds() - t0) / 1e6, ok: code === 0, out: out + err }
}

// ---- scaffolding ----

async function generate(dir: string): Promise<void> {
  const perLayer = Math.ceil(PACKAGES / LAYERS)
  const layerOf = (i: number) => Math.floor(i / perLayer)
  const name = (i: number) => `@bench/p${i}`

  await mkdir(path.join(dir, 'packages'), { recursive: true })

  // Every real repo ignores these — without it, vx's git-based input
  // enumeration would walk node_modules (thousands of files) and Turbo/Nx
  // would not, an unfair handicap.
  await writeFile(
    path.join(dir, '.gitignore'),
    ['node_modules', 'dist', '.vx', '.turbo', '.nx', '.vx-runner', '*.tsbuildinfo'].join('\n') +
      '\n',
  )

  // Root manifest: a Bun/npm workspace. `packageManager` + a lockfile
  // (written by the later install) satisfy Turbo's requirements.
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'bench-root',
        version: '0.0.0',
        private: true,
        packageManager: 'bun@1.3.11',
        workspaces: ['packages/*'],
      },
      null,
      2,
    ),
  )

  // Turbo pipeline (runs each package's package.json script of the same name).
  await writeFile(
    path.join(dir, 'turbo.json'),
    JSON.stringify(
      {
        $schema: 'https://turborepo.com/schema.json',
        tasks: {
          build: { dependsOn: ['^build'], outputs: ['dist/**'] },
          test: { dependsOn: ['build'], outputs: [] },
        },
      },
      null,
      2,
    ),
  )

  // Nx: cacheable targets + dependency-aware build, inferred project graph
  // from package.json dependencies.
  await writeFile(
    path.join(dir, 'nx.json'),
    JSON.stringify(
      {
        $schema: './node_modules/nx/schemas/nx-schema.json',
        targetDefaults: {
          build: { dependsOn: ['^build'], cache: true, outputs: ['{projectRoot}/dist'] },
          test: { dependsOn: ['build'], cache: true },
        },
      },
      null,
      2,
    ),
  )

  for (let i = 0; i < PACKAGES; i++) {
    const L = layerOf(i)
    const pdir = path.join(dir, 'packages', `p${i}`)
    await mkdir(pdir, { recursive: true })

    // Dependencies: a few packages from the previous layer.
    const deps: Record<string, string> = {}
    if (L > 0) {
      const prevStart = (L - 1) * perLayer
      const prevEnd = Math.min(L * perLayer, PACKAGES)
      const span = prevEnd - prevStart
      for (let d = 0; d < DEPS_PER_PKG && span > 0; d++) {
        const idx = prevStart + ((i * 7 + d * 13) % span)
        deps[name(idx)] = 'workspace:*'
      }
    }

    await writeFile(
      path.join(pdir, 'package.json'),
      JSON.stringify(
        {
          name: name(i),
          version: '0.0.0',
          scripts: { build: BUILD_CMD, test: TEST_CMD },
          dependencies: deps,
        },
        null,
        2,
      ),
    )

    // Nx project.json — same command, dependency edges come from deps above.
    await writeFile(
      path.join(pdir, 'project.json'),
      JSON.stringify(
        {
          name: name(i),
          targets: {
            build: {
              executor: 'nx:run-commands',
              options: { command: BUILD_CMD, cwd: '{projectRoot}' },
              outputs: ['{projectRoot}/dist'],
            },
            test: {
              executor: 'nx:run-commands',
              options: { command: TEST_CMD, cwd: '{projectRoot}' },
            },
          },
        },
        null,
        2,
      ),
    )

    // vx config — same command, same graph (vx derives edges from deps).
    const depList = Object.keys(deps)
    const dependsOn = depList.length > 0 ? `['^build']` : `[]`
    await writeFile(
      path.join(pdir, 'vx.config.ts'),
      `export default {
  tasks: {
    build: {
      exec: { command: ${JSON.stringify(BUILD_CMD)} },
      dependsOn: ${dependsOn},
      cache: { inputs: { files: ['package.json'] }, outputs: { files: ['dist/**'] } },
    },
    test: {
      exec: { command: ${JSON.stringify(TEST_CMD)} },
      dependsOn: ['build'],
      cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
    },
  },
}
`,
    )
  }
}

// git is required by vx (input hashing). Commit AFTER install so the
// lockfile is tracked and the tree is clean — the realistic scenario, and
// the one where vx's git-OID hashing does zero file reads.
async function gitInit(dir: string): Promise<void> {
  await sh(['git', 'init', '-q'], dir)
  await sh(['git', 'add', '-A'], dir)
  await sh(['git', '-c', 'user.email=b@b.b', '-c', 'user.name=b', 'commit', '-qm', 'init'], dir)
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

  // vx — compile the standalone binary first (the artifact real users run
  // via install.sh / release.yml). Comparing TS-source startup against
  // Turbo's and Nx's precompiled binaries would handicap vx unfairly.
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
      path.join(vxRoot, 'src', 'bin.ts'),
      '--outfile',
      vxBin,
    ],
    vxRoot,
  )
  const vxRun = compiled.ok ? [vxBin] : [process.execPath, path.join(vxRoot, 'src', 'bin.ts')]
  const vxVer = (await sh([...vxRun, '--version'], dir)).out.trim()
  runners.push({
    name: compiled.ok ? 'vx' : 'vx (ts-source)',
    version: vxVer || 'workspace',
    run: [...vxRun, 'run', 'build', 'test', '--all', '--concurrency', String(CONCURRENCY)],
    clear: () => rm(path.join(dir, '.vx'), { recursive: true, force: true }),
  })

  // vx (frozen): freeze the resolved config graph into vx-lock.json once,
  // then run from it (no per-run config evaluation — the CI fast path).
  const locked = await sh([...vxRun, 'lock'], dir)
  if (compiled.ok && locked.ok) {
    runners.push({
      name: 'vx (frozen)',
      version: vxVer || 'workspace',
      run: [
        ...vxRun,
        'run',
        'build',
        'test',
        '--all',
        '--concurrency',
        String(CONCURRENCY),
        '--frozen',
      ],
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

type Row = {
  runner: string
  version: string
  fresh: number
  warmNoRestore: number
  warmRestore: number
}

async function measure(r: Runner, dir: string): Promise<Row> {
  const fresh: number[] = []
  for (let i = 0; i < REPS; i++) {
    await r.clear()
    const res = await sh(r.run, dir)
    if (!res.ok) throw new Error(`${r.name} failed:\n${res.out.slice(-2000)}`)
    fresh.push(res.ms)
  }
  const warmNoRestore: number[] = []
  for (let i = 0; i < REPS; i++) warmNoRestore.push((await sh(r.run, dir)).ms)
  const warmRestore: number[] = []
  for (let i = 0; i < REPS; i++) {
    await deleteDist(dir)
    warmRestore.push((await sh(r.run, dir)).ms)
  }
  return {
    runner: r.name,
    version: r.version,
    fresh: median(fresh),
    warmNoRestore: median(warmNoRestore),
    warmRestore: median(warmRestore),
  }
}

// ---- report ----

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`
}

function markdown(rows: Row[]): string {
  const vx = rows.find((r) => r.runner === 'vx')
  const speed = (row: Row, key: keyof Pick<Row, 'fresh' | 'warmNoRestore' | 'warmRestore'>) => {
    if (!vx || row.runner === 'vx' || vx[key] === 0) return ''
    return ` (${(row[key] / vx[key]).toFixed(1)}× vx)`
  }
  const head = `# Benchmark results — vx vs Turborepo vs Nx

<!-- Generated by \`bun bench/compare.ts\`. Do not edit by hand. -->

- **Workspace:** ${PACKAGES} packages, ${LAYERS} dependency layers, ~${DEPS_PER_PKG} deps/package, 2 tasks (build + test).
- **Tasks:** \`build\` = \`${BUILD_CMD}\`; \`test\` = \`${TEST_CMD}\` — identical across all runners.
- **Measured:** whole-repo \`build\`+\`test\`, median of ${REPS}, wall-clock of the CLI invocation.
- **Concurrency:** ${CONCURRENCY} (pinned identically for every runner).
- **Host:** ${os.type()} ${os.release()} · ${os.cpus().length} cores · ${process.platform}/${process.arch}
- **Date:** ${new Date().toISOString().slice(0, 10)}

| Runner | Version | Fresh (cold) | Warm (no restore) | Warm (restore) |
| ------ | ------- | ------------ | ----------------- | -------------- |
`
  const body = rows
    .map(
      (r) =>
        `| ${r.runner} | ${r.version} | ${fmt(r.fresh)}${speed(r, 'fresh')} | ${fmt(r.warmNoRestore)}${speed(r, 'warmNoRestore')} | ${fmt(r.warmRestore)}${speed(r, 'warmRestore')} |`,
    )
    .join('\n')
  return `${head}${body}

**Cache states.** *Fresh* clears the runner's cache and runs cold (key
derivation + execution + save). *Warm, no restore* re-runs with the cache
warm and outputs intact (the steady-state dev loop). *Warm, restore*
deletes every \`dist/\` first, so the runner restores outputs from cache.

Reproduce: \`bun bench/compare.ts ${PACKAGES} ${LAYERS} ${REPS}\`.
`
}

// ---- main ----

const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-compare-'))

console.error(`scaffolding ${PACKAGES} packages × ${LAYERS} layers in ${ws} …`)
await generate(ws)

console.error('installing turbo + nx into the workspace …')
const install = await sh(['bun', 'add', '-d', 'turbo', 'nx', '--no-save'], ws).catch(() => null)
// `--no-save` keeps the generated package.json clean; if it's unsupported,
// fall back to a normal add.
if (!install || !install.ok) await sh(['bun', 'add', '-d', 'turbo', 'nx'], ws)

const runners = await buildRunners(ws)
await gitInit(ws)
console.error(`runners: ${runners.map((r) => `${r.name}@${r.version}`).join(', ')}`)

// Stop any daemon a previous runner left running so it can't idle-contend
// for CPU while the next runner is timed. (vx has no daemon; Turbo and Nx
// each keep one alive.)
async function quiesce(dir: string): Promise<void> {
  const bin = (t: string) => path.join(dir, 'node_modules', '.bin', t)
  await sh([bin('turbo'), 'daemon', 'stop'], dir).catch(() => undefined)
  await sh([bin('nx'), 'reset'], dir).catch(() => undefined)
}

// Runners are measured ONE AT A TIME (never concurrently) so they don't
// fight over CPU/disk and skew each other's timings.
const rows: Row[] = []
for (const r of runners) {
  await quiesce(ws)
  console.error(`measuring ${r.name} …`)
  try {
    rows.push(await measure(r, ws))
  } catch (err) {
    console.error(`  ${r.name} skipped: ${(err as Error).message.split('\n')[0]}`)
    rows.push({
      runner: r.name,
      version: r.version,
      fresh: NaN,
      warmNoRestore: NaN,
      warmRestore: NaN,
    })
  }
}

const md = markdown(rows)
await writeFile(path.join(vxRoot, 'bench', 'RESULTS.md'), md)
await writeFile(
  path.join(vxRoot, 'bench', 'results.json'),
  JSON.stringify(
    { packages: PACKAGES, layers: LAYERS, reps: REPS, date: new Date().toISOString(), rows },
    null,
    2,
  ) + '\n',
)

console.error('\n' + md)
console.error(`\nwrote bench/RESULTS.md + bench/results.json`)
await rm(ws, { recursive: true, force: true })
