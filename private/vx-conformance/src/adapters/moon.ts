// moon (moonrepo): `.moon/workspace.yml` maps each project to its
// directory, and each project's `moon.yml` declares its tasks: `script` (a
// shell line), `deps` as targets (`^:build`, `~:lint`, `lib:build`),
// `inputs`, `outputs` and `options`. No toolchain is configured: every task
// runs on the system toolchain, so moon downloads nothing. Project edges are
// `dependsOn` in moon.yml, moon's explicit form. The report is the run
// report moon writes after each run, `.moon/cache/runReport.json`.
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { optionalAsOutputs, type Adapter } from '../adapter.ts'
import { harnessNotes } from '../report.ts'
import { modulesOf, pkgDir } from '../tools.ts'
import { projectDir, type Selector, type TaskReport } from '../spec.ts'

// The binary @moonrepo/cli's own bin (a Node shim) spawns: run directly, so
// signals reach moon and no Node process stands between it and the harness.
function moonBin(): string {
  return path.join(
    pkgDir('@moonrepo/cli'),
    '..',
    process.platform === 'darwin' ? `core-macos-${process.arch}` : `core-linux-${process.arch}-gnu`,
    'moon',
  )
}

// A moon JavaScript workspace enables these: package.json edges, the
// lockfile in the hash, and node_modules/.bin on a task's PATH. They are
// WASM plugins moon downloads on first use, which the sandbox cannot.
const TOOLCHAINS = { javascript: { packageManager: 'bun' }, bun: {} }
/** The toolchains each case declares: {@link TOOLCHAINS} loaded from the fetched files, once fetched. */
let local: Record<string, Record<string, string>> | undefined

/**
 * Run moon once, outside the sandbox, so it downloads its own toolchain
 * plugins; every case then loads them from those files. Without them moon
 * runs as a workspace with no toolchain, and the results' notes say why.
 */
export async function fetchMoonPlugins(): Promise<void> {
  const root = path.join(modulesOf('@moonrepo/cli'), '.moon-plugins')
  const home = path.join(root, 'home')
  const ws = path.join(root, 'ws')
  await rm(root, { recursive: true, force: true })
  await mkdir(path.join(ws, '.moon'), { recursive: true })
  await mkdir(home, { recursive: true })
  await writeFile(path.join(ws, 'package.json'), '{ "name": "fetch", "private": true }\n')
  await writeFile(
    path.join(ws, '.moon', 'workspace.yml'),
    JSON.stringify({ projects: { fetch: '.' }, telemetry: false }),
  )
  await writeFile(path.join(ws, '.moon', 'toolchains.yml'), JSON.stringify(TOOLCHAINS))
  // moon compiles each WASM plugin on every run, about 1.5 s, into a cache
  // under the home, and every case starts from an empty home. One shared
  // compile cache, warmed here outside the sandbox, takes that off every run;
  // a case reads it and need not write it.
  const config = path.join(root, 'wasm-cache.toml')
  // Made here: a case sees this directory read-only, and wasmtime refuses a cache it cannot create.
  await mkdir(path.join(root, 'wasm-cache'), { recursive: true })
  await writeFile(config, `[cache]\ndirectory = ${JSON.stringify(path.join(root, 'wasm-cache'))}\n`)
  moon.env.EXTISM_CACHE_CONFIG = config
  const env = { ...process.env, ...moon.env, HOME: home }
  Bun.spawnSync(['git', 'init', '-q'], { cwd: ws, env })
  const proc = Bun.spawnSync([moonBin(), 'setup'], { cwd: ws, env, stdout: 'pipe', stderr: 'pipe' })
  const dir = path.join(home, '.moon', 'plugins', 'toolchains')
  const have = existsSync(dir) ? readdirSync(dir) : []
  const files = Object.keys(TOOLCHAINS).map((t) =>
    have.find((f) => f.startsWith(t) && f.endsWith('.wasm')),
  )
  if (proc.exitCode !== 0 || files.includes(undefined)) {
    return note(
      `moon fetched no toolchain plugins (exit ${proc.exitCode}, found ${have.join(' ') || 'none'}), so it runs without them:\n${proc.stdout.toString()}${proc.stderr.toString()}`,
    )
  }
  // Loaded from a file, not the registry: a case has no network, and moon asked
  // the registry again from a home holding a copy of the download.
  const toolchains = Object.fromEntries(
    Object.entries(TOOLCHAINS).map(([t, c], i) => [
      t,
      { ...c, plugin: `file://${path.join(dir, files[i]!)}` },
    ]),
  )
  // One task run as a case runs it, from an empty home with no network: moon
  // failing every case on the plugins is the harness's failure, not moon's.
  const smoke = await smokeRun(ws, toolchains, path.join(root, 'smoke-home'))
  if (smoke !== undefined)
    return note(
      `moon with its toolchain plugins failed a task offline, so it runs without them:\n${smoke}`,
    )
  local = toolchains
}

function note(text: string): void {
  harnessNotes.push(text)
  console.warn(`conformance: ${text}`)
}

/** moon's output when a trivial task fails under `toolchains` without network, else undefined. */
async function smokeRun(ws: string, toolchains: object, home: string): Promise<string | undefined> {
  await mkdir(home, { recursive: true })
  await writeFile(path.join(ws, '.moon', 'toolchains.yml'), JSON.stringify(toolchains))
  await writeFile(
    path.join(ws, 'moon.yml'),
    JSON.stringify({
      toolchains: { default: Object.keys(toolchains) },
      tasks: { t: { command: 'echo ok' } },
    }),
  )
  const bwrap = Bun.which('bwrap')
  const run = [moonBin(), 'run', 'fetch:t']
  const proc = Bun.spawnSync(
    bwrap === null ? run : [bwrap, '--dev-bind', '/', '/', '--unshare-net', '--', ...run],
    {
      cwd: ws,
      env: { ...process.env, ...moon.env, HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  return proc.exitCode === 0
    ? undefined
    : `exit ${proc.exitCode}\n${proc.stdout.toString()}${proc.stderr.toString()}`
}

/** A project-relative glob as moon spells a workspace-relative one: a leading `/`, after any `!`. */
function fromRoot(glob: string): string {
  return glob.startsWith('!') ? `!/${glob.slice(1)}` : `/${glob}`
}

/** A dependsOn entry as a moon target. */
function target(d: string): string {
  if (d.startsWith('^')) return `^:${d.slice(1)}`
  const at = d.indexOf('#')
  return at === -1 ? `~:${d}` : `${d.slice(0, at)}:${d.slice(at + 1)}`
}

/** One selector as an MQL condition over project fields. */
function condition(s: Selector): string {
  const glob = (v: string) => /[*?[{]/.test(v)
  const [field, value] = s.tag
    ? ['tag', s.tag]
    : s.dir
      ? ['projectSource', s.dir.replace(/^\.\//, '').replace(/\/$/, '')]
      : ['project', s.name!]
  const op = s.exclude ? (glob(value) ? '!~' : '!=') : glob(value) ? '~' : '='
  return `${field}${op}${value}`
}

function query(select: Selector[]): string {
  const inc = select.filter((s) => !s.exclude).map(condition)
  const exc = select.filter((s) => s.exclude).map(condition)
  if (inc.length === 0) return exc.join(' && ')
  if (exc.length === 0) return inc.join(' || ')
  // MQL starts with a comparison, never a group: the excludes go first.
  return `${exc.join(' && ')} && (${inc.join(' || ')})`
}

export const moon: Adapter = {
  name: 'moon',
  pkg: '@moonrepo/cli',
  bins: [],
  lacks: {
    'idle-timeout': 'moon has no limit on how long a task may print nothing.',
    'output-checksum': 'moon has no way to pin an output’s bytes to a checksum.',
    'determinism-check': 'No moon run rebuilds a cached task to compare its bytes.',
    'ready-port':
      'A `wait` dependency waits for the persistent task to start, never for a port it opens.',
    'dependency-bin': 'No moon task puts a directory of programs on its dependants’ PATH.',
    'select-walk':
      '`--upstream`/`--downstream` walk the task graph from the requested tasks, never the project graph, and never leave the matched projects out.',
    'task-pattern': 'A target names a task exactly, or by tag: no pattern over task names.',
    ready:
      'A `wait` dependency waits for the persistent task to start, never for a line it prints.',
    sandbox: 'moon keeps no task from files, network or home it never declared.',
    watch: '`moon run` runs once: moon has no watch mode.',
    'dry-run': '`moon action-graph` draws the graph; no run plans and runs nothing.',
  },
  env: { NO_COLOR: '1', DO_NOT_TRACK: '1' },
  async configure(dir, given, command) {
    const ws = optionalAsOutputs(given)
    const persistent = new Set(
      Object.entries(ws.projects).flatMap(([n, p]) =>
        Object.entries(p.tasks ?? {})
          .filter(([, t]) => t.persistent)
          .map(([t]) => `${n}:${t}`),
      ),
    )
    const waited = new Set(
      Object.entries(ws.projects).flatMap(([n, p]) =>
        Object.values(p.tasks ?? {}).flatMap((t) =>
          (t.dependsOn ?? []).flatMap((d) => {
            if (d.startsWith('^')) return (p.deps ?? []).map((dep) => `${dep}:${d.slice(1)}`)
            const at = d.indexOf('#')
            return [at === -1 ? `${n}:${d}` : `${d.slice(0, at)}:${d.slice(at + 1)}`]
          }),
        ),
      ),
    )
    await mkdir(path.join(dir, '.moon'), { recursive: true })
    if (local !== undefined)
      await writeFile(path.join(dir, '.moon', 'toolchains.yml'), JSON.stringify(local))
    await writeFile(
      path.join(dir, '.moon', 'workspace.yml'),
      JSON.stringify(
        {
          projects: Object.fromEntries(
            Object.entries(ws.projects).map(([n, p]) => [n, projectDir(n, p)]),
          ),
          vcs: { client: 'git', defaultBranch: 'main' },
          telemetry: false,
        },
        null,
        2,
      ),
    )
    for (const [name, p] of Object.entries(ws.projects)) {
      const rel = projectDir(name, p)
      const up = path.posix.relative(rel, '.') || '.'
      // The project edges moon's JavaScript toolchain infers from package.json, written out:
      // that toolchain is a plugin moon downloads, and the sandbox has no network.
      const manifest = await Bun.file(path.join(dir, rel, 'package.json'))
        .json()
        .catch(() => ({}))
      const edges = [
        ...new Set(
          ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(
            (f) => Object.keys(manifest[f] ?? {}),
          ),
        ),
      ].filter((d) => d !== name && ws.projects[d] !== undefined)
      const tasks = Object.fromEntries(
        Object.entries(p.tasks ?? {}).map(([t, spec]) => {
          // Omitted inputs are moon's default, every project file, kept when variables or root files join them.
          const extra = [
            ...(spec.rootInputs ?? []).map(fromRoot),
            ...(spec.env ?? []).map((e) => `$${e}`),
          ]
          const inputs = spec.inputs
            ? [...spec.inputs, ...extra]
            : extra.length > 0
              ? ['**/*', ...extra]
              : undefined
          const outputs = [...(spec.outputs ?? []), ...(spec.rootOutputs ?? []).map(fromRoot)]
          const deps = (spec.dependsOn ?? []).map((d) => {
            const t = target(d)
            const resolved = t.startsWith('~:') ? `${name}:${t.slice(2)}` : t
            // A persistent task never completes: a dependant waits for it to start, moon's `wait`.
            if (persistent.has(resolved)) return { target: t, type: 'wait' }
            // The case's dependency keys the task unless it says otherwise; moon's default keys only a dependency with outputs.
            return {
              target: t,
              cacheStrategy: spec.dependencyInputs === false ? 'ignored' : 'hash',
            }
          })
          const options = {
            ...(spec.cache === false ? { cache: false } : {}),
            ...(spec.timeout !== undefined ? { timeout: spec.timeout } : {}),
            ...(spec.retries !== undefined ? { retryCount: spec.retries } : {}),
            ...(spec.mutex !== undefined ? { mutex: spec.mutex } : {}),
            // moon refuses a dependant on a server that does not run in CI; its docs enable it.
            // The command is its own shell (moon's fully qualified form), so moon wraps it in no other.
            ...(spec.takesArgs ? { shell: false } : {}),
            ...(waited.has(`${name}:${t}`) ? { runInCI: true } : {}),
          }
          return [
            t,
            {
              // A `script` takes no forwarded args; a task that reads them is a `command`, which does:
              // a shell handing them on, as an array moon takes as is.
              ...(spec.takesArgs
                ? { command: ['sh', '-c', `${command(name, t)} "$@"`, 'sh'] }
                : { script: command(name, t) }),
              ...(deps.length > 0 ? { deps } : {}),
              ...(inputs ? { inputs } : {}),
              ...(outputs.length > 0 ? { outputs } : {}),
              ...(spec.runtime
                ? {
                    // A fingerprint check's output joins the hash; it runs in the project, so it moves to the root first.
                    checks: spec.runtime.map((r) => ({
                      check: 'fingerprint',
                      script: `cd ${up} && ${r}`,
                    })),
                  }
                : {}),
              ...(spec.persistent ? { preset: 'server' } : {}),
              ...(Object.keys(options).length > 0 ? { options } : {}),
            },
          ]
        }),
      )
      await writeFile(
        path.join(dir, rel, 'moon.yml'),
        JSON.stringify(
          {
            ...(edges.length > 0 ? { dependsOn: edges } : {}),
            ...(p.tags ? { tags: p.tags } : {}),
            // A shell line runs a package's bin from node_modules/.bin only under these.
            ...(local !== undefined ? { toolchains: { default: Object.keys(local) } } : {}),
            tasks,
          },
          null,
          2,
        ),
      )
    }
    return []
  },
  run: (task, projects, opts = {}) => {
    const tasks = [task, ...(opts.also ?? [])]
    const targets =
      projects && !opts.select
        ? projects.flatMap((p) => tasks.map((t) => `${p}:${t}`))
        : tasks.map((t) => `:${t}`)
    return [
      moonBin(),
      // `moon run` is `moon exec` bailing on the first failure; going on is exec's `--on-failure continue`.
      ...(opts.continue ? ['exec', '--on-failure', 'continue', '--upstream', 'deep'] : ['run']),
      ...targets,
      ...(opts.select ? ['--query', query(opts.select)] : []),
      ...(opts.only ? ['--upstream', 'none'] : []),
      ...(opts.concurrency !== undefined ? ['--concurrency', String(opts.concurrency)] : []),
      ...(opts.force ? ['--force'] : []),
      ...(opts.readOnlyCache ? ['--cache', 'read'] : []),
      ...(opts.args ? ['--', ...opts.args] : []),
    ]
  },
  // `--downstream deep --include-relations`: the dependents a change reaches, through task and project edges.
  affected: (task, base) => [
    moonBin(),
    'run',
    `:${task}`,
    '--affected',
    '--base',
    base,
    '--downstream',
    'deep',
    '--include-relations',
  ],
  report: async (root) => {
    const report = await Bun.file(path.join(root, '.moon', 'cache', 'runReport.json')).json()
    const tasks: Record<string, TaskReport> = {}
    for (const a of report.actions as MoonAction[]) {
      if (a.node.action !== 'run-task') continue
      const t = a.node.params!.target!
      const at = t.lastIndexOf(':')
      tasks[`${t.slice(0, at)}#${t.slice(at + 1)}`] = {
        cache: a.status.startsWith('cached') ? 'hit' : 'miss',
        durationMs: a.duration.secs * 1000 + a.duration.nanos / 1e6,
      }
    }
    return tasks
  },
}

interface MoonAction {
  status: string
  duration: { secs: number; nanos: number }
  node: { action: string; params?: { target?: string } }
}
