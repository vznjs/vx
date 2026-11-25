// A Next.js route input, `src/app/[locale]/**`, was passed through as the
// class matching `src/app/l/**`. Core refuses that glob when the bracketed
// path exists, so `vx lock` refused the whole workspace. Turbo reads an
// existing bracketed path literally (vercel/turborepo#14850), and so does
// the mapping now.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'
import { useTurboWorkspace } from './helpers/turbo-workspace.js'

const inputsOf = async (inputs: string[], globalDependencies: string[] = []) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vx-turbo-brackets-'))
  try {
    const app = path.join(dir, 'packages', 'app')
    await mkdir(path.join(app, 'src', 'app', '[locale]', 'skip'), { recursive: true })
    await mkdir(path.join(dir, 'shared', '[x]'), { recursive: true })
    await writeFile(path.join(app, 'src', 'app', '[locale]', 'page.tsx'), 'p\n')
    await writeFile(path.join(dir, 'shared', '[x]', 'a.json'), '{}\n')
    await writeFile(
      path.join(dir, 'turbo.json'),
      JSON.stringify({ globalDependencies, tasks: { t: { inputs } } }),
    )
    const meta: PackageMeta = {
      name: 'app',
      dir: app,
      packageJson: { name: 'app', scripts: { t: 'echo t' } } as never,
      configPath: null,
    }
    const m = await mapTurboWorkspace(dir, [meta], { splice: (_k, v) => v, persistentTodo: 'P' })
    return (m.projects[0]!.tasks[0]!.task as { inputs: Record<string, unknown> }).inputs
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('turbo-map: a bracketed input path that exists', () => {
  it('is escaped where it names the path, and a class naming none stays', async () => {
    const inputs = await inputsOf(
      [
        'src/app/[locale]/**',
        '!src/app/[locale]/skip/**',
        'src/*.[jt]s',
        '$TURBO_ROOT$/shared/[x]/**',
      ],
      ['shared/[x]/a.json'],
    )
    expect({ files: inputs['files'], ws: inputs['workspaceFiles'] }).toEqual({
      files: [
        'src/app/\\[locale\\]/**',
        '!src/app/\\[locale\\]/skip/**',
        'src/*.[jt]s',
        'package.json',
      ],
      ws: ['shared/\\[x\\]/a.json', 'shared/\\[x\\]/**'],
    })
  })
})

describe('turbo(): vx lock over a bracketed route input', () => {
  const ws = useTurboWorkspace({ tasks: { build: { inputs: ['src/[id]/**'], outputs: [] } } })
  it('locks, and an edit under the route re-keys the task', async () => {
    const root = ws.root
    const route = path.join(root, 'packages', 'lib', 'src', '[id]')
    await mkdir(route, { recursive: true })
    await writeFile(path.join(route, 'page.tsx'), 'a\n')
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
    const vx = (...args: string[]) =>
      Bun.spawnSync({
        cmd: [process.execPath, path.resolve(import.meta.dir, '../../vx/src/bin.ts'), ...args],
        cwd: root,
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
      })
    const key = () => {
      const p = vx('run', 'build', '--filter', 'lib', '--dry', '--format', 'json')
      return (JSON.parse(p.stdout.toString()) as { tasks: { hash: string }[] }).tasks[0]!.hash
    }
    const lock = vx('lock')
    expect({ code: lock.exitCode, err: lock.stderr.toString() }).toEqual({ code: 0, err: '' })
    const first = key()
    await writeFile(path.join(route, 'page.tsx'), 'b\n')
    expect(key()).not.toBe(first)
  }, 30_000)
})
