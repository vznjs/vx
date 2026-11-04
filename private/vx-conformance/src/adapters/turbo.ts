// Turborepo: a package.json script per task, turbo.json entries per
// `project#task` (a case may give two projects' tasks different inputs).
import { readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Adapter } from '../adapter.ts'
import { projectDir } from '../spec.ts'

export const turbo: Adapter = {
  name: 'turbo',
  pkg: 'turbo',
  bins: ['turbo'],
  lacks: [],
  env: { TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', NO_COLOR: '1' },
  async configure(dir, ws, command) {
    const tasks: Record<string, unknown> = {}
    for (const [name, p] of Object.entries(ws.projects)) {
      const pdir = path.join(dir, projectDir(name, p))
      const manifest = JSON.parse(await Bun.file(path.join(pdir, 'package.json')).text())
      manifest.scripts = Object.fromEntries(
        Object.keys(p.tasks ?? {}).map((t) => [t, command(name, t)]),
      )
      await writeFile(path.join(pdir, 'package.json'), JSON.stringify(manifest, null, 2))
      for (const [t, spec] of Object.entries(p.tasks ?? {}))
        tasks[`${name}#${t}`] = {
          dependsOn: spec.dependsOn ?? [],
          ...(spec.inputs ? { inputs: spec.inputs } : {}),
          ...(spec.env ? { env: spec.env } : {}),
          ...(spec.outputs ? { outputs: spec.outputs } : {}),
          ...(spec.cache === false ? { cache: false } : {}),
        }
    }
    // A bare task name in a run or a `^` dependency needs a root entry too.
    for (const p of Object.values(ws.projects))
      for (const t of Object.keys(p.tasks ?? {})) tasks[t] ??= { dependsOn: [], outputs: [] }
    await writeFile(path.join(dir, 'turbo.json'), JSON.stringify({ tasks }, null, 2))
    return []
  },
  run: (task, projects) => [
    'node_modules/.bin/turbo',
    'run',
    task,
    '--ui=stream',
    '--summarize',
    ...(projects ?? []).map((p) => `--filter=${p}`),
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
