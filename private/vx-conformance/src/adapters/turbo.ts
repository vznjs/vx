// Turborepo: a package.json script per task, turbo.json entries per
// `project#task` (a case may give two projects' tasks different inputs).
import { readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pnpmFilter, type Adapter } from '../adapter.ts'
import { projectDir } from '../spec.ts'

/** A workspace-root-relative glob as Turbo spells it; a `!` stays in front. */
function fromRoot(glob: string): string {
  return glob.startsWith('!') ? `!$TURBO_ROOT$/${glob.slice(1)}` : `$TURBO_ROOT$/${glob}`
}

export const turbo: Adapter = {
  name: 'turbo',
  pkg: 'turbo',
  bins: ['turbo'],
  // dependsOn names tasks exactly; a `*` is no pattern. No per-task time
  // limit, no retries, no ready line: a persistent task's dependants (where
  // Turborepo allows any) start at once.
  // A task always keys on its dependencies' hashes, and nothing keeps a
  // command from the files, network or home it never declared.
  lacks: [
    'task-pattern',
    'timeout',
    'retries',
    'ready',
    'runtime-inputs',
    'dependency-inputs-off',
    'sandbox',
  ],
  env: { TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', NO_COLOR: '1' },
  async configure(dir, ws, command) {
    // Turbo names the root package `//`.
    const rootName = Object.entries(ws.projects).find(([n, p]) => projectDir(n, p) === '.')?.[0]
    const id = (name: string) => (name === rootName ? '//' : name)
    const dep = (d: string) => {
      const at = d.indexOf('#')
      return at > 0 ? `${id(d.slice(0, at))}${d.slice(at)}` : d
    }
    const tasks: Record<string, unknown> = {}
    for (const [name, p] of Object.entries(ws.projects)) {
      const pdir = path.join(dir, projectDir(name, p))
      const manifest = JSON.parse(await Bun.file(path.join(pdir, 'package.json')).text())
      manifest.scripts = Object.fromEntries(
        Object.keys(p.tasks ?? {}).map((t) => [t, command(name, t)]),
      )
      await writeFile(path.join(pdir, 'package.json'), JSON.stringify(manifest, null, 2))
      for (const [t, spec] of Object.entries(p.tasks ?? {})) {
        const inputs = spec.rootInputs
          ? [...(spec.inputs ?? ['$TURBO_DEFAULT$']), ...spec.rootInputs.map(fromRoot)]
          : spec.inputs
        const outputs = spec.rootOutputs
          ? [...(spec.outputs ?? []), ...spec.rootOutputs.map(fromRoot)]
          : spec.outputs
        tasks[`${id(name)}#${t}`] = {
          dependsOn: (spec.dependsOn ?? []).map(dep),
          ...(inputs ? { inputs } : {}),
          ...(spec.env ? { env: spec.env } : {}),
          ...(spec.passThrough ? { passThroughEnv: spec.passThrough } : {}),
          ...(outputs ? { outputs } : {}),
          ...(spec.cache === false || spec.persistent ? { cache: false } : {}),
          ...(spec.persistent ? { persistent: true } : {}),
        }
      }
    }
    // A bare task name in a run or a `^` dependency needs a root entry too.
    for (const p of Object.values(ws.projects))
      for (const t of Object.keys(p.tasks ?? {})) tasks[t] ??= { dependsOn: [], outputs: [] }
    await writeFile(path.join(dir, 'turbo.json'), JSON.stringify({ tasks }, null, 2))
    return []
  },
  run: (task, projects, opts = {}) => [
    'node_modules/.bin/turbo',
    'run',
    task,
    ...(opts.also ?? []),
    '--ui=stream',
    '--summarize',
    ...(opts.select ? opts.select.map(pnpmFilter) : (projects ?? [])).map((f) => `--filter=${f}`),
    ...(opts.only ? ['--only'] : []),
    ...(opts.concurrency !== undefined ? [`--concurrency=${opts.concurrency}`] : []),
    ...(opts.continue ? ['--continue=always'] : []),
    ...(opts.force ? ['--force'] : []),
    ...(opts.readOnlyCache ? ['--cache=local:r'] : []),
    ...(opts.dry ? ['--dry=json'] : []),
    ...(opts.args ? ['--', ...opts.args] : []),
  ],
  affected: (task, base) => [
    'env',
    `TURBO_SCM_BASE=${base}`,
    'node_modules/.bin/turbo',
    'run',
    task,
    '--ui=stream',
    '--summarize',
    '--affected',
  ],
  // `--summarize` writes .turbo/runs/<id>.json per run.
  report: async (root) => {
    const dir = path.join(root, '.turbo', 'runs')
    const runs = (await readdir(dir)).filter((f) => f.endsWith('.json'))
    const newest = await Promise.all(
      runs.map(async (f) => ({ f, t: (await stat(path.join(dir, f))).mtimeMs })),
    )
    newest.sort((a, b) => b.t - a.t)
    const summary = await Bun.file(path.join(dir, newest[0]!.f)).json()
    return Object.fromEntries(
      summary.tasks.map((t: TurboTask) => [
        t.taskId,
        {
          cache: t.cache.status === 'HIT' ? 'hit' : 'miss',
          durationMs: t.execution.endTime - t.execution.startTime,
        },
      ]),
    )
  },
}

interface TurboTask {
  taskId: string
  cache: { status: string }
  execution: { startTime: number; endTime: number }
}
