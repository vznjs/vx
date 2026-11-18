// A loop that arms while the initial run waits on a server has neither the
// run's keys nor its unsaved task yet. An edit made before that arm, beside a
// server already up or under a running task, was dropped for good: the
// output stayed built from the old bytes until the next save.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { startWatch, until, type Watch } from './helpers/watch-loop.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const made: string[] = []
let watch: Watch | undefined
afterEach(async () => {
  watch?.proc.kill('SIGTERM')
  await watch?.proc.exited
  watch = undefined
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

interface Fixture {
  root: string
  app: string
  /** Ends `app#build` (`hold`), or `api#build`. */
  go: string
  /** Makes `api#dev` ready: until then the run waits on it alone, and the loop arms. */
  ready: string
}

/**
 * `app`: build (src -> dist), then a server up at once that writes a file of
 * its own. `api`: a build that holds until `go`, then a server ready at
 * `ready`. With `hold`, `app#build` reads its input, then holds until `go`.
 */
async function fixture(hold = false): Promise<Fixture> {
  const root = await makeWorkspace({ prefix: 'vx-watch-initial-edit-server-' })
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-initial-edit-server-out-'))
  made.push(root, outside)
  const go = path.join(outside, 'go')
  const ready = path.join(outside, 'ready')
  const wait = (f: string): string => `while [ ! -f ${f} ]; do sleep 0.02; done`
  const app = await addProject(
    root,
    'app',
    `export default { tasks: {
      build: {
        exec: { command: 'mkdir -p dist && cat src/a.txt > dist/out.txt${hold ? ` && ${wait(go)}` : ''}' },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      },
      dev: {
        exec: { command: 'echo up > up.txt; echo up; exec sleep 600', persistent: { readyWhen: 'up' } },
        dependsOn: ['build'],
      },
    } }`,
  )
  await mkdir(path.join(app, 'src'), { recursive: true })
  await writeFile(path.join(app, 'src', 'a.txt'), 'old\n')
  await addProject(
    root,
    'api',
    `export default { tasks: {
      build: { exec: { command: '${hold ? 'true' : wait(go)}' } },
      dev: {
        exec: { command: '${wait(ready)}; echo up; exec sleep 600', persistent: { readyWhen: 'up' } },
        dependsOn: ['build'],
      },
    } }`,
  )
  await writeFile(path.join(root, '.gitignore'), 'dist\n')
  return { root, app, go, ready }
}

const output = (app: string) => async (): Promise<string> =>
  readFile(path.join(app, 'dist', 'out.txt'), 'utf8').catch(() => '')

it('an edit beside a server already up, before the loop armed behind another server, starts a cycle', async () => {
  const { root, app, go, ready } = await fixture()
  watch = startWatch(root, ['--all'], {}, 'dev')
  const w = watch
  const out = output(app)
  await until(() => w.out().includes('app#dev'), 'app#dev to be up')
  await writeFile(path.join(app, 'src', 'a.txt'), 'new\n')
  await writeFile(go, '')
  await until(() => w.out().includes('watching'), 'the watching marker')
  await writeFile(ready, '')
  await until(async () => (await out()) === 'new\n', 'the output built from the edit')
}, 40_000)

it('an edit under a running task, before the loop armed behind a server, starts a cycle', async () => {
  const { root, app, go, ready } = await fixture(true)
  watch = startWatch(root, ['--all'], {}, 'dev')
  const w = watch
  const out = output(app)
  await until(async () => (await out()) === 'old\n', 'app#build to have read its input')
  await writeFile(path.join(app, 'src', 'a.txt'), 'new\n')
  await writeFile(go, '')
  await until(() => w.out().includes('watching'), 'the watching marker')
  await writeFile(ready, '')
  await until(async () => (await out()) === 'new\n', 'the output built from the edit')
}, 40_000)

// CONTROL: the server's own write, in its window, moves no key.
it('a loop armed behind a server, with no edit, starts no cycle', async () => {
  const { root, app, go, ready } = await fixture()
  watch = startWatch(root, ['--all'], {}, 'dev')
  const w = watch
  await until(() => w.out().includes('app#dev'), 'app#dev to be up')
  await writeFile(go, '')
  await until(() => w.out().includes('watching'), 'the watching marker')
  await writeFile(ready, '')
  await until(() => w.out().includes('api#dev'), 'api#dev to be up')
  expect(await readFile(path.join(app, 'up.txt'), 'utf8')).toBe('up\n')
  await Bun.sleep(1_000)
  expect(w.cycles()).toBe(0)
}, 40_000)
