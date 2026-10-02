// The turbo.test.ts workspace for a row file of its own: a pnpm workspace
// with `lib` and `app` (app depends on lib), turbo() declared, git
// initialised. Rows that append to one shared file collide on every merge.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach } from 'bun:test'
import type { Logger } from '@vzn/vx'
import { localWorkspaceSource } from './local-workspace.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', '..', 'src', 'index.ts')

/** A logger that keeps the run:status lines (plugin warnings) in `lines`. */
export function silent(): Logger & { lines: string[] } {
  const lines: string[] = []
  const log = {
    lines,
    status: (line: string) => lines.push(line),
    runStart() {},
    taskStart() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
    runStatus() {},
    runEnd() {},
  }
  return log as unknown as Logger & { lines: string[] }
}

/** A fresh workspace per test; `root` is read inside the test. */
export function useTurboWorkspace(turbo: unknown): { readonly root: string } {
  const ws = { root: '' }
  const pkg = async (name: string, scripts: Record<string, string>, deps?: object) => {
    const dir = path.join(ws.root, 'packages', name)
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', scripts, ...(deps ? { dependencies: deps } : {}) }),
    )
    await writeFile(path.join(dir, 'src', 'index.js'), `// ${name}\n`)
  }
  beforeEach(async () => {
    ws.root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-ws-'))
    const root = ws.root
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, '.gitignore'), 'dist\n')
    await writeFile(path.join(root, 'turbo.json'), JSON.stringify(turbo))
    await pkg('lib', { build: 'mkdir -p dist && echo lib > dist/lib.js' })
    await pkg('app', { build: 'mkdir -p dist && echo app > dist/app.js' }, { lib: 'workspace:*' })
    await Bun.write(
      path.join(root, 'vx.workspace.mjs'),
      localWorkspaceSource(['turbo()'], `import { turbo } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
    )
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
  })
  afterEach(async () => {
    await rm(ws.root, { recursive: true, force: true })
  })
  return ws
}
