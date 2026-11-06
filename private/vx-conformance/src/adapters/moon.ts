// moon (moonrepo): `.moon/workspace.yml` maps each project to its
// directory, and each project's `moon.yml` declares its tasks: `script` (a
// shell line), `deps` as targets (`^:build`, `~:lint`, `lib:build`),
// `inputs`, `outputs` and `options`. No toolchain is configured: every task
// runs on the system toolchain, so moon downloads nothing. Project edges are
// `dependsOn` in moon.yml, moon's explicit form. The report is the run
// report moon writes after each run, `.moon/cache/runReport.json`.
import { mkdir, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { Adapter } from '../adapter.ts'
import { projectDir, type Selector, type TaskReport } from '../spec.ts'

// The binary @moonrepo/cli's own bin (a Node shim) spawns: run directly, so
// signals reach moon and no Node process stands between it and the harness.
const MOON = path.join(
  realpathSync(path.join(import.meta.dir, '..', '..', 'node_modules', '@moonrepo', 'cli')),
  '..',
  process.platform === 'darwin' ? `core-macos-${process.arch}` : `core-linux-${process.arch}-gnu`,
  'moon',
)

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
  lacks: [
    // `--query` matches project fields; `--upstream`/`--downstream` walk
    // the task graph from the requested tasks, never the project graph,
    // and never leave the matched projects out.
    'select-walk',
    // A target names a task exactly, or by tag; no pattern over task names.
    'task-pattern',
    // A `wait` dependency waits for the persistent task to start, never for a line it prints.
    'ready',
    // Nothing keeps a command from files, network or home it never declared.
    'sandbox',
    // No watch mode: `moon run` runs once.
    'watch',
    // No run is planned without running (`moon action-graph` draws the graph, runs nothing).
    'dry-run',
  ],
  env: { NO_COLOR: '1', DO_NOT_TRACK: '1' },
  async configure(dir, ws, command) {
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
      MOON,
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
    MOON,
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
