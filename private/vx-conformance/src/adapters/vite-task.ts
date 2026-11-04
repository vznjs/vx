// Vite Task (`vp run`, from vite-plus): a vite.config.ts per project with
// `run.tasks`. Omitted inputs or outputs are left to its automatic tracking,
// its default.
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pnpmFilter, type Adapter } from '../adapter.ts'
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
  // is never a long-running process the run stops; there is no watch mode.
  lacks: [
    'affected',
    'task-pattern',
    'timeout',
    'retries',
    'persistent',
    'ready',
    'runtime-inputs',
    'multi-task',
    'watch',
  ],
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
  async configure(dir, ws, command) {
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
