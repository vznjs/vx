// Vite Task (`vp run`, from vite-plus): a vite.config.ts per project with
// `run.tasks`. Omitted inputs or outputs are left to its automatic tracking,
// its default.
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { optionalAsOutputs, pnpmFilter, type Adapter } from '../adapter.ts'
import { projectDir, type TaskReport } from '../spec.ts'

/** A workspace-root-relative glob as Vite Task spells it: a glob with a workspace base. */
function fromRoot(glob: string): { pattern: string; base: 'workspace' } {
  return { pattern: glob, base: 'workspace' }
}

export const viteTask: Adapter = {
  name: 'vite-task',
  pkg: 'vite-plus',
  bins: ['vp'],
  // `vp run` selects by package, never by a git change, and takes one task;
  // dependsOn names tasks exactly; a task has no time limit, no retries, and
  // is never a long-running process the run stops.
  lacks: {
    'folder-output':
      'Vite Task’s docs give a trailing slash in an output no meaning, so nothing declares an output a folder.',
    mutex: 'No Vite Task setting keeps two tasks from running at the same time.',
    'idle-timeout': 'Vite Task has no limit on how long a task may print nothing.',
    'output-checksum': 'Vite Task has no way to pin an output’s bytes to a checksum.',
    'determinism-check': 'No Vite Task run rebuilds a cached task to compare its bytes.',
    'ready-port': 'Vite Task has no long-running task it waits on.',
    'dependency-bin': 'No Vite Task task puts a directory of programs on its dependants’ PATH.',
    affected: 'Vite Task does not select tasks by what git says changed.',
    'task-pattern': 'Dependencies name tasks exactly: no pattern over task names.',
    timeout: 'Vite Task has no per-task time limit.',
    retries: 'Vite Task does not retry a failed task.',
    persistent: 'Vite Task has no long-running task it stops when the run ends.',
    ready: 'Vite Task does not hold a task until another prints a ready line.',
    'runtime-inputs': 'Vite Task inputs are files and variables, never a command’s output.',
    'multi-task': '`vp run` runs one task name per run.',
    continue: 'A failure stops the run: nothing goes on past it.',
    force:
      '`--cache` and `--no-cache` turn caching on or off; no run ignores entries and saves fresh ones.',
    'read-only-cache': 'No run reads the cache and writes nothing to it.',
    watch: '`vp run` has no watch mode.',
    'dry-run': 'Vite Task has no run that plans and runs nothing.',
    sandbox: 'Vite Task keeps no task from files, network or home it never declared.',
    'select-tag': 'A filter picks by name or directory; packages carry no tags.',
    'report-duration':
      '`vp run --last-details` names the time a hit saved, never how long a task took in this run.',
    'report-cpu': 'The run summary gives no task’s CPU time.',
    'report-memory': 'The run summary gives no task’s peak memory.',
    'report-output-bytes': 'The run summary gives no size of a task’s outputs.',
  },
  env: { NO_COLOR: '1', DO_NOT_TRACK: '1', VITE_PLUS_TELEMETRY_DISABLED: '1' },
  // Vite Task installs the workspace's `packageManager` from the registry
  // before a run: the sandbox has none, so its home holds the bun that runs
  // the harness, in Vite Task's layout (a lock file beside the bin).
  async seed(home) {
    const root = path.join(home, '.local', 'share', 'vite-plus', 'package_manager', 'bun')
    const bin = path.join(root, Bun.version, 'bun', 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(path.join(root, `${Bun.version}.lock`), '')
    await symlink(process.execPath, path.join(bin, 'bun'))
  },
  async configure(dir, given, command) {
    const ws = optionalAsOutputs(given)
    for (const [name, p] of Object.entries(ws.projects)) {
      const tasks = Object.fromEntries(
        Object.entries(p.tasks ?? {}).map(([t, spec]) => [
          t,
          {
            command: command(name, t),
            dependsOn: (spec.dependsOn ?? []).map((d) =>
              d.startsWith('^') ? { task: d.slice(1), from: 'dependencies' } : d,
            ),
            cache:
              spec.cache === false
                ? false
                : {
                    ...(spec.inputs || spec.rootInputs
                      ? {
                          input: [
                            ...(spec.inputs ?? [{ auto: true }]),
                            ...(spec.rootInputs ?? []).map(fromRoot),
                          ],
                        }
                      : {}),
                    ...(spec.env ? { env: spec.env } : {}),
                    ...(spec.passThrough ? { untrackedEnv: spec.passThrough } : {}),
                    ...(spec.outputs || spec.rootOutputs
                      ? {
                          output: [
                            ...(spec.outputs ?? []),
                            ...(spec.rootOutputs ?? []).map(fromRoot),
                          ],
                        }
                      : {}),
                  },
          },
        ]),
      )
      await writeFile(
        path.join(dir, projectDir(name, p), 'vite.config.ts'),
        `export default ${JSON.stringify({ run: { tasks } }, null, 2)}\n`,
      )
    }
    return []
  },
  run: (task, projects, opts = {}) => [
    'node_modules/.bin/vp',
    'run',
    ...(opts.select
      ? opts.select.flatMap((s) => ['--filter', pnpmFilter(s)])
      : projects
        ? projects.flatMap((p) => ['--filter', p])
        : ['-r']),
    ...(opts.only ? ['--ignore-depends-on'] : []),
    ...(opts.concurrency !== undefined ? ['--concurrency-limit', String(opts.concurrency)] : []),
    task,
    // Everything after the task specifier is the task's: `vp run` takes no `--`.
    ...(opts.args ?? []),
  ],
  affected: () => {
    throw new Error('vite-task has no affected selection')
  },
  // `--last-details` prints the last run's summary: per task, a hit and
  // the time it saved, or a miss.
  report: async (_root, read) => {
    const out = await read(['node_modules/.bin/vp', 'run', '--last-details'])
    const tasks: Record<string, TaskReport> = {}
    for (const m of out.matchAll(/\[\d+\] (\S+): [^\n]*\n\s*→ ([^\n]*)/g)) {
      const line = m[2]!
      tasks[m[1]!] = {
        cache: /cache hit/i.test(line) ? 'hit' : 'miss',
        ...(/(\d+(?:\.\d+)?)(ms|s) (?!saved)/.test(line)
          ? { durationMs: ms(line.match(/(\d+(?:\.\d+)?)(ms|s) (?!saved)/)!) }
          : {}),
      }
    }
    return tasks
  },
}

function ms(m: RegExpMatchArray): number {
  return Number(m[1]) * (m[2] === 's' ? 1000 : 1)
}
