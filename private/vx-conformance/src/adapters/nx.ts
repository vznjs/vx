// Nx: a project.json per project, each task an `nx:run-commands` target.
// Nx folds a dependency's change into a task only through a `^` input:
// each `^task` in dependsOn adds the dependency's own inputs for that task.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { optionalAsOutputs, type Adapter } from '../adapter.ts'
import { projectDir, type Selector } from '../spec.ts'

/** A project-relative glob as Nx spells it; a `!` stays in front. */
function rooted(glob: string): string {
  // An absolute or empty pattern reaches Nx as the user wrote it.
  if (glob === '' || glob.replace(/^!/, '').startsWith('/')) return glob
  return glob.startsWith('!') ? `!{projectRoot}/${glob.slice(1)}` : `{projectRoot}/${glob}`
}

/** A workspace-root-relative glob as Nx spells it. */
function fromRoot(glob: string): string {
  if (glob === '' || glob.replace(/^!/, '').startsWith('/')) return glob
  return glob.startsWith('!') ? `!{workspaceRoot}/${glob.slice(1)}` : `{workspaceRoot}/${glob}`
}

/**
 * `lib#build` is Nx's `{ projects: ['lib'], target: 'build' }`; `^build` and
 * `build` read alike. Beside a continuous task with a `readyWhen`, each is
 * the object form with `waitFor: 'ready'`, Nx's way to wait for the line.
 */
function dependsOn(d: string, ready: boolean): string | Record<string, unknown> {
  const at = d.indexOf('#')
  if (!ready) return at === -1 ? d : { projects: [d.slice(0, at)], target: d.slice(at + 1) }
  if (at !== -1) return { projects: [d.slice(0, at)], target: d.slice(at + 1), waitFor: 'ready' }
  if (d.startsWith('^')) return { dependencies: true, target: d.slice(1), waitFor: 'ready' }
  return { target: d, waitFor: 'ready' }
}

export const nx: Adapter = {
  name: 'nx',
  pkg: 'nx',
  bins: ['nx'],
  // `-p` takes names and globs; it walks neither direction of the graph.
  // No per-task time limit, no retries. A failure skips what depends on
  // it, every cache read writes too, no run is planned without running,
  // and nothing keeps a command from what it never declared. Every host
  // variable reaches a task, keying none it does not name.
  lacks: {
    'idle-timeout': 'Nx has no limit on how long a task may print nothing.',
    'output-checksum': 'Nx has no way to pin an output’s bytes to a checksum.',
    'determinism-check': 'No Nx run rebuilds a cached task to compare its bytes.',
    'dependency-bin': 'No Nx task puts a directory of programs on its dependants’ PATH.',
    'select-walk':
      'Nx selects projects by name, pattern or tag; no selector adds their dependencies or dependents.',
    timeout: 'Nx has no per-task time limit.',
    retries: 'Nx does not retry a failed task.',
    continue: 'Nx never runs a task whose dependency failed.',
    'read-only-cache': 'Nx has no run that reads the cache and writes nothing to it.',
    'dry-run': 'Nx has no run that plans and runs nothing.',
    sandbox: 'Nx keeps no task from files, network or home it never declared.',
  },
  env: {
    NX_DAEMON: 'false',
    NX_NO_CLOUD: 'true',
    NX_SKIP_NX_CACHE: 'false',
    NX_TUI: 'false',
    NX_INTERACTIVE: 'false',
    NO_COLOR: '1',
    DO_NOT_TRACK: '1',
  },
  async configure(dir, given, command) {
    const ws = optionalAsOutputs(given)
    // Each task's inputs are a named input, `<task>-inputs`, so a dependent
    // reaches the files its dependency's task keys on through `^<task>-inputs`,
    // as Nx's `^production` idiom does. A project without the task falls back
    // to all its files.
    const ready = Object.values(ws.projects).some((p) =>
      Object.values(p.tasks ?? {}).some((t) => typeof t.persistent === 'object'),
    )
    const taskNames = new Set(Object.values(ws.projects).flatMap((p) => Object.keys(p.tasks ?? {})))
    await writeFile(
      path.join(dir, 'nx.json'),
      JSON.stringify(
        {
          namedInputs: {
            default: ['{projectRoot}/**/*'],
            ...Object.fromEntries([...taskNames].map((t) => [`${t}-inputs`, ['default']])),
          },
          useDaemonProcess: false,
          analytics: false,
        },
        null,
        2,
      ),
    )
    for (const [name, p] of Object.entries(ws.projects)) {
      const rel = projectDir(name, p)
      const tasks = Object.entries(p.tasks ?? {})
      const namedInputs = Object.fromEntries(
        tasks
          .filter(([, spec]) => spec.inputs || spec.rootInputs || spec.runtime)
          .map(([t, spec]) => [
            `${t}-inputs`,
            [
              ...(spec.inputs ? spec.inputs.map(rooted) : ['default']),
              ...(spec.rootInputs ?? []).map(fromRoot),
              // In the named input, so a dependant's `^<task>-inputs` reaches it too.
              ...(spec.runtime ?? []).map((r) => ({ runtime: r })),
            ],
          ]),
      )
      const targets = Object.fromEntries(
        tasks.map(([t, spec]) => [
          t,
          {
            executor: 'nx:run-commands',
            options: { command: command(name, t), cwd: '{projectRoot}' },
            dependsOn: (spec.dependsOn ?? []).map((d) => dependsOn(d, ready)),
            inputs: [
              spec.inputs || spec.rootInputs || spec.runtime ? `${t}-inputs` : 'default',
              // A `^` pattern names no one task, so no one named input: the dependencies' files.
              ...(spec.dependencyInputs === false ? [] : (spec.dependsOn ?? []))
                .filter((d) => d.startsWith('^'))
                .map((d) => (d.includes('*') ? '^default' : `${d}-inputs`)),
              ...(spec.env ?? []).map((e) => ({ env: e })),
            ],
            ...(spec.outputs || spec.rootOutputs
              ? {
                  outputs: [
                    ...(spec.outputs ?? []).map(rooted),
                    ...(spec.rootOutputs ?? []).map(fromRoot),
                  ],
                }
              : {}),
            cache: spec.cache !== false && !spec.persistent,
            ...(spec.persistent ? { continuous: true } : {}),
            ...(typeof spec.persistent === 'object'
              ? {
                  readyWhen:
                    'port' in spec.persistent
                      ? { port: spec.persistent.port }
                      : { logMatches: spec.persistent.ready },
                }
              : {}),
            // Nx's one way to keep a task from overlapping: it runs alone.
            ...(spec.mutex !== undefined ? { parallelism: false } : {}),
          },
        ]),
      )
      await writeFile(
        path.join(dir, rel, 'project.json'),
        JSON.stringify(
          { name, root: rel, ...(p.tags ? { tags: p.tags } : {}), namedInputs, targets },
          null,
          2,
        ),
      )
    }
    return []
  },
  run: (task, projects, opts = {}) => {
    const sel = opts.select
    const pick = (s: Selector) => (s.tag ? `tag:${s.tag}` : (s.name ?? s.dir!))
    const inc = sel ? sel.filter((s) => !s.exclude).map(pick) : projects
    const exc = (sel ?? []).filter((s) => s.exclude).map(pick)
    return [
      'node_modules/.bin/nx',
      'run-many',
      '-t',
      [task, ...(opts.also ?? [])].join(','),
      ...(inc && inc.length > 0 ? ['-p', inc.join(',')] : []),
      ...(exc.length > 0 ? ['--exclude', exc.join(',')] : []),
      ...(opts.only ? ['--excludeTaskDependencies'] : []),
      '--outputStyle=stream',
      ...(opts.concurrency !== undefined ? [`--parallel=${opts.concurrency}`] : []),
      ...(opts.failFast ? ['--nxBail'] : []),
      ...(opts.force ? ['--skipNxCache'] : []),
      ...(opts.args ? ['--', ...opts.args] : []),
    ]
  },
  affected: (task, base) => [
    'node_modules/.bin/nx',
    'affected',
    '-t',
    task,
    `--base=${base}`,
    '--outputStyle=stream',
  ],
  // `nx watch` hears changes through the daemon, which every other run
  // leaves off; it reruns the docs' `run-many` line on each change.
  watch: (task, projects) => [
    'env',
    'NX_DAEMON=true',
    'node_modules/.bin/nx',
    'watch',
    ...(projects ? ['-p', projects.join(','), '-d'] : ['--all']),
    '--initialRun',
    '--',
    [
      'node_modules/.bin/nx run-many -t',
      task,
      ...(projects ? ['-p', projects.join(',')] : []),
      '--outputStyle=stream',
    ].join(' '),
  ],
  // Each run rewrites run.json in its cache directory: the shared one under
  // the home, or the workspace's own `.nx/cache` when Nx does not share it.
  report: async (root) => {
    const found = await Promise.all(
      ['.nx/cache/run.json', '.home/.nx/*/cache/run.json'].map((g) =>
        Array.fromAsync(new Bun.Glob(g).scan({ cwd: root, dot: true })),
      ),
    )
    const file = found.flat()[0]
    const run = await Bun.file(path.join(root, file!)).json()
    return Object.fromEntries(
      run.tasks.map((t: NxTask) => [
        `${t.projectName}#${t.target}`,
        {
          cache: t.cacheStatus.includes('hit') ? 'hit' : 'miss',
          durationMs: Date.parse(t.endTime) - Date.parse(t.startTime),
        },
      ]),
    )
  },
}

interface NxTask {
  projectName: string
  target: string
  cacheStatus: string
  startTime: string
  endTime: string
}
