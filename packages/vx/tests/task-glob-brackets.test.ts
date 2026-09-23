// A bracket is a LITERAL character in a task glob (item 667). Route
// directories are named `[id]` across Next.js, SvelteKit and Astro, and
// `Bun.Glob` reads `app/[id]/**` as the class `[id]`: it matched `app/i/…`
// and `app/d/…` and never the route. So the route's file never entered the
// key — an edit replayed the old output as a green hit — and an output
// declared under it cleaned an unrelated `app/i/page.js` before every run
// while the artifact saved nothing. `\[id\]`, the spelling Turbo users
// escape with, names the same path.

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import { workspaceGlobsMatch } from '../src/workspace/index.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
const exists = async (p: string): Promise<boolean> =>
  (await stat(p).catch(() => undefined)) !== undefined

let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function project(
  task: { command: string; inputs: string[]; outputs: string[]; workspaceInputs?: string[] },
  files: Record<string, string>,
): Promise<{ dir: string; statuses: () => Promise<string[]> }> {
  root = await makeWorkspace({ prefix: 'vx-brackets-' })
  const inputs = {
    files: task.inputs,
    ...(task.workspaceInputs ? { workspaceFiles: task.workspaceInputs } : {}),
  }
  const dir = await addProject(root, 'p', {
    config: `
      export default {
        tasks: {
          build: {
            exec: { command: ${JSON.stringify(task.command)} },
            cache: {
              inputs: ${JSON.stringify(inputs)},
              outputs: { files: ${JSON.stringify(task.outputs)} },
            },
          },
        },
      }
    `,
    files,
  })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  const ws = root
  const statuses = async (): Promise<string[]> =>
    (await run({ cwd: ws, tasks: ['build'], log: quiet })).outcomes.map((o) => o.status)
  return { dir, statuses }
}

// Both spellings, every row: the bare route directory and Turbo's escape.
const spellings: Array<[string, (p: string) => string]> = [
  ['bare', (p) => p],
  ['escaped', (p) => p.replace(/[[\]]/g, '\\$&')],
]

for (const [spelling, glob] of spellings) {
  describe(`a route directory in a task glob, ${spelling} (${glob('app/[id]')})`, () => {
    it('an input under it keys the task: an edit reruns, never replays', async () => {
      const { dir, statuses } = await project(
        {
          command: 'cat "app/[id]/page.js" > out.txt',
          inputs: [glob('app/[id]/**')],
          outputs: ['out.txt'],
        },
        { 'app/[id]/page.js': 'v1' },
      )
      expect(await statuses()).toEqual(['success'])
      await writeFile(path.join(dir, 'app/[id]/page.js'), 'v2')
      expect(await statuses()).toEqual(['success'])
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('v2')
    }, 30_000)

    it('an output under it is saved and restored, and a sibling the class matched survives', async () => {
      const { dir, statuses } = await project(
        {
          command: 'mkdir -p "app/[id]" && cat src/in.txt > "app/[id]/page.js"',
          inputs: ['src/**'],
          outputs: [glob('app/[id]/page.js')],
        },
        { 'src/in.txt': 'v1', 'app/i/page.js': 'SIBLING' },
      )
      expect(await statuses()).toEqual(['success'])
      expect(await readFile(path.join(dir, 'app/i/page.js'), 'utf8')).toBe('SIBLING')
      await rm(path.join(dir, 'app/[id]/page.js'))
      expect(await statuses()).toEqual(['cache-hit'])
      expect(await readFile(path.join(dir, 'app/[id]/page.js'), 'utf8')).toBe('v1')
      expect(await readFile(path.join(dir, 'app/i/page.js'), 'utf8')).toBe('SIBLING')
    }, 30_000)

    it('with a real wildcard beside it, folds the route and not the class sibling', async () => {
      const { dir, statuses } = await project(
        {
          command: 'cat app/*/x.js > out.txt',
          inputs: [glob('app/[id]/*.js')],
          outputs: ['out.txt'],
        },
        { 'app/[id]/x.js': 'route', 'app/i/x.js': 'sibling' },
      )
      expect(await statuses()).toEqual(['success'])
      await writeFile(path.join(dir, 'app/i/x.js'), 'sibling2')
      expect(await statuses()).toEqual(['cache-hit'])
      await writeFile(path.join(dir, 'app/[id]/x.js'), 'route2')
      expect(await statuses()).toEqual(['success'])
    }, 30_000)

    it('a workspaceFiles input under it keys the task', async () => {
      const { dir, statuses } = await project(
        {
          command: 'echo ok > out.txt',
          inputs: ['src/**'],
          outputs: ['out.txt'],
          workspaceInputs: [glob('packages/p/app/[id]/**')],
        },
        { 'src/in.txt': 'v1', 'app/[id]/page.js': 'v1' },
      )
      expect(await statuses()).toEqual(['success'])
      await writeFile(path.join(dir, 'app/[id]/page.js'), 'v2')
      expect(await statuses()).toEqual(['success'])
    }, 30_000)

    it('--affected reads a workspaceFiles route the way the key does', () => {
      expect([
        workspaceGlobsMatch([glob('app/[id]/**')], 'app/[id]/page.js'),
        workspaceGlobsMatch([glob('app/[id]/**')], 'app/i/page.js'),
        workspaceGlobsMatch([glob('app/[id]')], 'app/[id]/page.js'),
        workspaceGlobsMatch(['app/**', glob('!app/[id]/**')], 'app/[id]/page.js'),
        workspaceGlobsMatch(['app/**', glob('!app/[id]/**')], 'app/i/page.js'),
      ]).toEqual([true, false, true, false, true])
    })

    // The upstream's tree walk on a hit sets aside what a dependant adds to
    // it (item 588) by matching the dependant's globs: read as a class, the
    // route glob set aside a STRAY `app/i/page.js` instead, the upstream
    // judged its tree current, and the stray outlived strict ownership.
    it("an upstream's hit sets aside the route a dependant adds, and nothing else", async () => {
      root = await makeWorkspace({ prefix: 'vx-brackets-' })
      const dir = await addProject(root, 'p', {
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'mkdir -p app && cat src/in.txt > app/x.js' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['app/**'] } },
              },
              route: {
                dependsOn: ['build'],
                exec: { command: 'mkdir -p "app/[id]" && echo r > "app/[id]/page.js"' },
                cache: {
                  inputs: { files: ['src/**'] },
                  outputs: { files: [${JSON.stringify(glob('app/[id]/page.js'))}] },
                },
              },
            },
          }
        `,
        files: { 'src/in.txt': 'v1' },
      })
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'init')
      const ws = root
      const statuses = async (): Promise<string[]> =>
        (await run({ cwd: ws, tasks: ['route'], log: quiet })).outcomes
          .map((o) => `${o.node.id} ${o.status}`)
          .sort()
      expect(await statuses()).toEqual(['p#build success', 'p#route success'])
      await rm(path.join(dir, 'app/[id]/page.js'))
      await mkdir(path.join(dir, 'app/i'))
      await writeFile(path.join(dir, 'app/i/page.js'), 'STRAY')
      expect(await statuses()).toEqual(['p#build cache-hit', 'p#route cache-hit'])
      expect(await exists(path.join(dir, 'app/i/page.js'))).toBe(false)
      expect(await readFile(path.join(dir, 'app/x.js'), 'utf8')).toBe('v1')
      expect(await readFile(path.join(dir, 'app/[id]/page.js'), 'utf8')).toBe('r\n')
    }, 30_000)
  })
}
