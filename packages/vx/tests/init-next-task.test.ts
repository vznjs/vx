// The report's `next:` task, with no `build`, skips a task that changes
// the repo or serves: react-navigation was told `vx run clean --all`.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { applyMigration, type GeneratedTask } from '../src/workspace/migration.js'

const exec = (command: string, persistent = false) => ({
  exec: persistent ? { command, persistent: {} } : { command },
})

async function next(tasks: GeneratedTask[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-next-task-'))
  const write = process.stdout.write.bind(process.stdout)
  let out = ''
  process.stdout.write = ((chunk: string) => ((out += chunk), true)) as typeof process.stdout.write
  try {
    await applyMigration({
      root,
      metas: [],
      plan: {
        headerNotes: [],
        projects: [{ name: 'a', dir: path.join(root, 'a'), importLines: [], tasks }],
        extraFiles: [],
        notes: [],
      },
      source: 'package.json scripts',
      verb: 'vx init',
      dry: true,
      force: false,
    })
  } finally {
    process.stdout.write = write
    await rm(root, { recursive: true, force: true })
  }
  return (
    out
      .trimEnd()
      .split('\n')
      .at(-1)!
      .match(/ run (\S+) --all$/)?.[1] ?? ''
  )
}

const t = (name: string, task: Record<string, unknown> | null = exec('x')): GeneratedTask => ({
  name,
  todos: [],
  task,
})

it('skips a clean, a release or a server for the first task worth a try', async () => {
  const got: string[] = []
  // One at a time: each capture swaps process.stdout.write.
  for (const tasks of [
    [t('clean'), t('start', exec('expo start', true)), t('android')],
    [t('clean:all'), t('release'), t('format'), t('lint')],
    [t('dev', exec('vite', true)), t('typecheck')],
    [t('clean'), t('lint'), t('build')],
    // Nothing else to offer: the first task, as before.
    [t('clean'), t('dev', exec('vite', true))],
    [t('skipped', null), t('clean')],
  ])
    got.push(await next(tasks))
  expect(got).toEqual(['android', 'lint', 'typecheck', 'build', 'clean', 'clean'])
})
