// vx's own names are reserved only where vx writes them: the workspace
// root's `.git` and `.vx`, and the `vx.lock.json` beside a config. Reserved
// at any depth, a project's own `src/sub/vx.lock.json`, `src/.vx/tmp/*` or
// `src/.vx/cache/*` keyed nothing (an edit was a hit), and a hit dropped a
// build's `dist/sub/vx.lock.json`, `dist/.vx/**` and `dist/.git/**` while
// reporting a restore. Turbo keys and restores every one.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { makeWorkspace } from './helpers/workspace.js'
import { PARITY_TIMEOUT as TIMEOUT, summarized } from './helpers/parity.js'

const NESTED = ['sub/vx.lock.json', '.vx/tmp/y.txt', '.vx/cache/z.txt']

it(
  "an edit to a project's own file named like vx's re-runs the task",
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-reserved-in-' })
    try {
      await writeFile(
        path.join(root, 'vx.config.mjs'),
        `export default {
          tasks: {
            build: {
              exec: { command: 'rm -rf dist && mkdir -p dist && cp -a src/. dist/' },
              inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
            },
          },
        }\n`,
      )
      for (const f of NESTED) {
        await mkdir(path.dirname(path.join(root, 'src', f)), { recursive: true })
        await writeFile(path.join(root, 'src', f), 'v1\n')
      }
      expect((await summarized(root, ['fixture-root#build'])).code).toBe(0)
      for (const f of NESTED) {
        await writeFile(path.join(root, 'src', f), 'v2\n')
        const run = await summarized(root, ['fixture-root#build'])
        expect(run.tasks.get('fixture-root#build')?.['status']).toBe('success')
        expect(await readFile(path.join(root, 'dist', f), 'utf8')).toBe('v2\n')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)

it(
  "a hit restores a build's own outputs named like vx's",
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-reserved-out-' })
    const written = ['sub/vx.lock.json', '.vx/x.txt', '.git/x.txt', 'ok.txt']
    try {
      await writeFile(
        path.join(root, 'vx.config.mjs'),
        `export default {
          tasks: {
            build: {
              exec: { command: ${JSON.stringify(
                `rm -rf dist && mkdir -p dist/sub dist/.vx dist/.git && ${written
                  .map((f) => `echo ${f} > dist/${f}`)
                  .join(' && ')}`,
              )} },
              inputs: { files: ['package.json'] }, cache: { outputs: { files: ['dist/**'] } },
            },
          },
        }\n`,
      )
      expect((await summarized(root, ['fixture-root#build'])).code).toBe(0)
      await rm(path.join(root, 'dist'), { recursive: true, force: true })
      const hit = await summarized(root, ['fixture-root#build'])
      expect(hit.tasks.get('fixture-root#build')?.['status']).toBe('cache-hit')
      for (const f of written)
        expect(await readFile(path.join(root, 'dist', f), 'utf8')).toBe(`${f}\n`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)
