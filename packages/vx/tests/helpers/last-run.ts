// The newest run's task rows, as `vx last --format json` reads them back
// from the run history: what a test asserts a run did.

import path from 'node:path'

const BIN = path.resolve(import.meta.dir, 'vx-locked.ts')

export interface LastTask {
  id: string
  project: string
  task: string
  status: string
  hash: string
  [field: string]: unknown
}

export function lastRun(
  root: string,
  env: Record<string, string | undefined> = process.env,
): LastTask[] {
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'last', '--format', 'json'],
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(`vx last exited ${r.exitCode}: ${r.stderr.toString()}`)
  const doc = JSON.parse(r.stdout.toString()) as {
    tasks: Array<Record<string, unknown> & { project: string; task: string }>
  }
  return doc.tasks.map((t) => ({ ...t, id: `${t.project}#${t.task}` }) as LastTask)
}

/** Each task's status in the newest run, by id. */
export function lastStatus(
  root: string,
  env?: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(lastRun(root, env).map((t) => [t.id, t.status]))
}
