// A task whose shell exits while a process it started still holds its
// stdout is not saved: that process may still write outputs, and a hit
// would replay a tree the run never leaves (`tsc & vite build`; Growth's
// background-writer-after-save.sh, 2026-10-16). Turbo waits for the pipe;
// vx keeps its bound, so the leftover never hangs a run, and saves nothing.

import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { silentLogger, TIMEOUT } from './helpers/orchestrator-fixture.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
})

async function until(file: string): Promise<void> {
  for (let i = 0; i < 100 && !existsSync(file); i++) await Bun.sleep(50)
}

it(
  'a task that leaves a writer holding its stdout is not saved',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-left-running-' })
    made.push(root)
    const app = await addProject(root, 'app', {
      files: { 'src/a.txt': 'a', '.gitignore': 'dist/\n' },
      config: `export default { tasks: { build: {
        exec: { command: 'mkdir -p dist; echo early > dist/early.txt; (sleep 1; echo late > dist/late.txt) &' },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
      } } }`,
    })
    const fx = { root, log: [] as string[], err: [] as string[] }
    const opts = { cwd: root, tasks: ['build'], log: silentLogger(fx) }
    const first = await run(opts)
    expect(first.outcomes.map((o) => o.status)).toEqual(['success'])
    await until(path.join(app, 'dist', 'late.txt'))
    expect((await readdir(path.join(app, 'dist'))).sort()).toEqual(['early.txt', 'late.txt'])
    expect(fx.log.join('\n')).toContain(
      'app#build: a process it left running may still write its outputs',
    )
    await rm(path.join(app, 'dist'), { recursive: true })
    const second = await run(opts)
    expect(second.outcomes.map((o) => o.status)).toEqual(['success'])
    await until(path.join(app, 'dist', 'late.txt'))
  },
  TIMEOUT,
)
