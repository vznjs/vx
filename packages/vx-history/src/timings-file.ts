// The timings file `file` names: what vx-history learned, as one JSON
// file a CI cache carries between runners. `{ version, tasks: { id: ms } }`,
// keys sorted so an unchanged history writes the same bytes.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const VERSION = 1

/**
 * The file's durations; none when it is absent or unread (with a warning),
 * and undefined, with a warning, when it is a file but not a timings file:
 * not one to write over.
 */
export function readTimings(
  file: string,
  warn: (m: string) => void,
): Record<string, number> | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    warn(`[vx] vx-history: timings file ${file} not read: ${(err as Error).message}`)
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // quiet: not JSON is not a timings file, which the warning below says
    parsed = undefined
  }
  const tasks = (parsed as { version?: unknown; tasks?: unknown } | undefined)?.tasks
  if (
    (parsed as { version?: unknown } | undefined)?.version !== VERSION ||
    tasks === null ||
    typeof tasks !== 'object' ||
    Array.isArray(tasks)
  ) {
    warn(
      `[vx] vx-history: timings file ${file} ignored: not { "version": ${VERSION}, "tasks": { id: ms } }`,
    )
    return undefined
  }
  const out: Record<string, number> = {}
  for (const [id, ms] of Object.entries(tasks)) {
    // Bounded so no chain of them sums past a number: core refuses a
    // weight that is not finite, and the run failed on a hint.
    if (typeof ms === 'number' && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER) out[id] = ms
  }
  return out
}

/**
 * The carried durations with this machine's p50s (`durationsFor`) over
 * them, written whole: a task this run did not see keeps its carried time.
 * Through a temp and a rename, so a reader never sees half a file. Its
 * directory is made: a CI cache that missed restores none.
 */
export function writeTimings(
  file: string,
  carried: Readonly<Record<string, number>>,
  p50s: ReadonlyMap<string, number>,
): void {
  const merged: Record<string, number> = { ...carried }
  for (const [id, ms] of p50s) merged[id] = Math.round(ms)
  const tasks: Record<string, number> = {}
  for (const id of Object.keys(merged).sort()) tasks[id] = merged[id]!
  const tmp = `${file}.${process.pid}.tmp`
  mkdirSync(path.dirname(file), { recursive: true })
  try {
    writeFileSync(tmp, `${JSON.stringify({ version: VERSION, tasks }, null, 2)}\n`)
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * Whether git ignores `file`, asked now and answered when git exits: true
 * for a file outside the root, no repository, or a git that cannot run,
 * which say nothing of it. Started before the history read, the check runs
 * beside it: asked after the write, it held the run's end 7-10 ms.
 */
export function askIgnored(file: string, root: string): Promise<boolean> {
  const rel = path.relative(root, file)
  // `..x.json` is a name inside the root, not a step out of it.
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    return Promise.resolve(true)
  try {
    const p = Bun.spawn({
      cmd: ['git', 'check-ignore', '-q', '--', rel],
      cwd: root,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    // 0: ignored; 128: no repository or git refused.
    return p.exited.then((code) => code !== 1)
  } catch {
    return Promise.resolve(true)
  }
}

/**
 * Says so when git does not ignore the file it rewrote: a task whose
 * inputs cover it (a root project's `**`) keyed each run's new timings,
 * and missed the run after every write.
 */
export async function warnUnignored(
  file: string,
  root: string,
  warn: (m: string) => void,
  ignored: Promise<boolean> = askIgnored(file, root),
): Promise<void> {
  if (await ignored) return
  warn(
    `[vx] vx-history: timings file ${path.relative(root, file)} is not git-ignored, so a task whose inputs cover it re-keys on every rewrite — add it to .gitignore`,
  )
}
