// A glob is a filter over what git lists, so `.env*` never folds a
// gitignored `.env.local` (caching.md): an edit there replayed stale
// outputs under a green hit, and nothing said so. The miss names such a
// file when the glob's last segment matches it directly, never a deep
// `**` match into an ignored directory.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

let root: string

function logger(lines: string[]) {
  return {
    runStart: () => undefined,
    taskStart: () => undefined,
    taskStdout: () => undefined,
    taskStderr: () => undefined,
    taskComplete: () => undefined,
    runStatus: () => undefined,
    runEnd: () => undefined,
    status: (line: string) => {
      lines.push(line)
    },
  }
}

async function runTask(task: string): Promise<string[]> {
  const lines: string[] = []
  const summary = await run({
    cwd: root,
    tasks: [task],
    projects: ['app'],
    log: logger(lines),
    handleSignals: false,
  })
  expect(summary.ok).toBe(true)
  return lines.filter((l) => l.includes('git-ignored'))
}

describe('a glob input that matches a git-ignored file', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-ignored-glob-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    await writeFile(path.join(root, '.gitignore'), '.env.local\n*.log\n')
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
    const app = path.join(root, 'packages', 'app')
    await mkdir(path.join(app, 'src'), { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(path.join(app, 'src', 'index.js'), 'export {}\n')
    await writeFile(path.join(app, 'src', 'debug.log'), 'noise\n')
    await writeFile(path.join(app, '.env'), 'A=1\n')
    await writeFile(path.join(app, '.env.local'), 'B=1\n')
    const task = (out: string, inputs: string[]) =>
      `{ exec: { command: 'mkdir -p ${out} && cat .env* > ${out}/out.js' },
        inputs: { files: ${JSON.stringify(inputs)} }, outputs: { files: ['${out}/**'] }, cache: true }`
    await writeFile(
      path.join(app, 'vx.config.mjs'),
      `export default { tasks: {
        env: ${task('env-out', ['src/**', '.env*'])},
        named: ${task('named-out', ['src/**', '.env*', '.env.local'])},
        excluded: ${task('excluded-out', ['src/**', '.env*', '!.env.local'])},
        deep: ${task('deep-out', ['src/**'])},
        own: ${task('own-out', ['src/**', '*.json', 'vx.lock.json*'])},
      } }\n`,
    )
    await Bun.spawn(['git', 'init', '-q'], { cwd: root }).exited
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('is named on the miss with the literal that folds it, and not on the hit', async () => {
    expect(await runTask('env')).toEqual([
      "[vx] app#env: inputs leave out git-ignored .env.local (matched by .env*) — a glob reads only what git lists; name it as a literal input ('.env.local') to key on it",
    ])
    expect(await runTask('env')).toEqual([])
  })

  it('says nothing once the file is named outright, excluded, or reached only by a deep glob', async () => {
    expect(await runTask('named')).toEqual([])
    expect(await runTask('excluded')).toEqual([])
    expect(await runTask('deep')).toEqual([])
  })

  // vx leaves its own review copy out of every key, ignored by git or not:
  // `*.json` named a committed vx.lock.json "git-ignored" on every miss.
  it('says nothing of the review copy vx itself leaves out', async () => {
    const app = path.join(root, 'packages', 'app')
    await writeFile(path.join(app, 'vx.lock.json'), '{}\n')
    await writeFile(path.join(app, 'vx.lock.json.tmp-12'), '{}\n')
    expect(await runTask('own')).toEqual([])
  })
})
