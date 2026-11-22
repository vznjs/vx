// vx: a vx.config.mjs per project, the lockfile plugin for edges (as a
// user's `bun()` reads them), then `vx lock`, which every run reads: after
// an install too, since a run keys from the lockfile digests it records.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pnpmFilter, type Adapter } from '../adapter.ts'
import { ISOLATED_RAN } from '../harness.ts'
import { projectDir } from '../spec.ts'

const LOCKFILE = path.join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'vx-lockfile',
  'src',
  'index.ts',
)
const VX = 'node_modules/.bin/vx'

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const vx: Adapter = {
  name: 'vx',
  pkg: '@vzn/vx',
  bins: ['vx'],
  lacks: {
    'dependency-bin':
      'vx runs the tools the machine has and installs none, so no task puts programs on its dependants’ PATH.',
    continue:
      'Nothing runs on a failed dependency: a failure skips its dependents, and `--fail-fast` stops the run.',
  },
  env: { NO_COLOR: '1' },
  installed: [[VX, 'lock']],
  // A run follows the lock and never re-reads a manifest: `vx lock` is the
  // step after editing one, and where a broken one is refused.
  edited: [[VX, 'lock']],
  async configure(dir, ws, command) {
    await mkdir(path.join(dir, '.vx'), { recursive: true })
    await writeFile(
      path.join(dir, '.vx', 'workspace.mjs'),
      `import { bun } from ${JSON.stringify(LOCKFILE)}\nexport default { plugins: [bun()]${ws.sharedOutputs ? ', run: { rules: { exclusiveOutputs: false } }' : ''} }\n`,
    )
    for (const [name, p] of Object.entries(ws.projects)) {
      const tasks = Object.fromEntries(
        Object.entries(p.tasks ?? {}).map(([t, spec]) => {
          // vx has no default inputs: root inputs or a probe alone key no project file.
          const files = spec.inputs ?? (spec.rootInputs || spec.runtime ? [] : undefined)
          return [
            t,
            {
              exec: {
                command: command(name, t),
                ...(spec.env || spec.passThrough
                  ? { env: { passThrough: [...(spec.env ?? []), ...(spec.passThrough ?? [])] } }
                  : {}),
                ...(spec.sandbox
                  ? {
                      sandbox: {
                        ...(spec.sandbox.hermetic ? { hermetic: true } : {}),
                        allow: {
                          read: [...(spec.inputs ?? []), ...(spec.sandbox.read ?? [])],
                          // The harness marks an isolated task's start and end there.
                          write: [
                            ...(spec.outputs ?? []),
                            ...(spec.sandbox.write ?? []),
                            `${path.dirname(path.join(dir, ISOLATED_RAN))}/`,
                          ],
                          ...(spec.sandbox.network ? { network: true } : {}),
                        },
                      },
                    }
                  : {}),
                ...(spec.timeout !== undefined ? { timeout: `${spec.timeout * 1000}ms` } : {}),
                ...(spec.retries !== undefined ? { retries: spec.retries } : {}),
                ...(spec.persistent
                  ? {
                      persistent:
                        spec.persistent === true
                          ? {}
                          : { readyWhen: escapeRegExp(spec.persistent.ready) },
                    }
                  : {}),
              },
              ...(spec.dependsOn ? { dependsOn: spec.dependsOn } : {}),
              ...(files
                ? {
                    inputs: {
                      files,
                      ...(spec.rootInputs ? { workspaceFiles: spec.rootInputs } : {}),
                      ...(spec.runtime ? { workspaceRuntime: spec.runtime } : {}),
                      ...(spec.env ? { env: spec.env } : {}),
                      ...(spec.dependencyInputs === false ? { tasks: [] } : {}),
                    },
                  }
                : {}),
              ...(files && (spec.outputs || spec.rootOutputs) && spec.cache !== false
                ? {
                    outputs: {
                      files: spec.outputs ?? [],
                      ...(spec.rootOutputs ? { workspaceFiles: spec.rootOutputs } : {}),
                    },
                    cache: true,
                  }
                : {}),
            },
          ]
        }),
      )
      // A package with no task needs no config: the lockfile plugin finds it
      // by its manifest, wherever it lies (a folder git ignores too).
      const file = path.join(dir, projectDir(name, p), 'vx.config.mjs')
      if (Object.keys(tasks).length === 0 && !p.tags) {
        await rm(file, { force: true })
        continue
      }
      await writeFile(
        file,
        `export default ${JSON.stringify({ name, ...(p.tags ? { tags: p.tags } : {}), tasks }, null, 2)}\n`,
      )
    }
    return [[VX, 'lock']]
  },
  run: (task, projects, opts = {}) => [
    VX,
    'run',
    task,
    ...(opts.also ?? []),
    ...(opts.select
      ? opts.select.flatMap((s) => ['--filter', pnpmFilter(s)])
      : projects
        ? projects.flatMap((p) => ['--filter', p])
        : ['--all']),
    ...(opts.only ? ['--exclude-dependencies'] : []),
    ...(opts.concurrency !== undefined ? [`--concurrency=${opts.concurrency}`] : []),
    ...(opts.force ? ['--force'] : []),
    ...(opts.readOnlyCache ? ['--cache-policy=local:r'] : []),
    ...(opts.dry ? ['--dry'] : []),
    ...(opts.args ? ['--', ...opts.args] : []),
  ],
  affected: (task, base) => [VX, 'run', task, `--affected=${base}`],
  watch: (task, projects) => [
    VX,
    'watch',
    task,
    ...(projects ? projects.flatMap((p) => ['--filter', p]) : ['--all']),
  ],
  report: async (_root, read) => {
    const last = JSON.parse(await read([VX, 'last', '--format', 'json']))
    return Object.fromEntries(
      last.tasks.map((t: VxTask) => [
        `${t.project}#${t.task}`,
        {
          cache: t.cacheHit ? 'hit' : 'miss',
          durationMs: t.durationMs,
          ...(t.cpuMs !== null ? { cpuMs: t.cpuMs } : {}),
          ...(t.peakRssBytes !== null ? { peakMemoryBytes: t.peakRssBytes } : {}),
          ...(t.outputBytes != null ? { outputBytes: t.outputBytes } : {}),
        },
      ]),
    )
  },
}

interface VxTask {
  project: string
  task: string
  cacheHit: boolean
  durationMs: number
  cpuMs: number | null
  peakRssBytes: number | null
  outputBytes?: number | null
}
