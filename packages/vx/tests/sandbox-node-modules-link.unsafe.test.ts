// The `node_modules` grant core makes, where it leads somewhere no key
// answers for. A project's `node_modules` that is itself a link (`ln -s ..
// node_modules`, or to a sibling) was bound by its target: the task read a
// sibling's file, and `.git`, through it, and an edit there was an
// up-to-date stale hit. A `read: ['.']` punched around `dist/` bound the
// link by its target the same way. A linked package the key does answer
// for was bound whole too, its nested project included, whose files that
// key never folds (globs stop at a nested project). Linux-only for the
// strace line.
import { realpathSync } from 'node:fs'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { type RunSummary } from '../src/orchestrator/index.js'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject } from './helpers/workspace.js'
import {
  TIMEOUT,
  type Fixture,
  collectingLogger,
  expectOk,
  makeWorkspace,
} from './helpers/sandbox-fixture.js'

const available = await sandboxAvailable('sandbox node_modules link tests')

const appConfig = (cat: string, read: string, dependsOn: string[] = []): string => `
  export default {
    tasks: {
      test: {
        exec: {
          command: 'mkdir -p dist && cat < ${cat} > dist/out.txt',
          sandbox: { allow: { read: ['${read}'], write: ['dist/'] } },
        },
        dependsOn: ${JSON.stringify(dependsOn)},
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      },
    },
  }
`

const keyedSource = `
  export default {
    tasks: {
      source: {
        exec: { command: 'true' },
        inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true,
      },
    },
  }
`

describe.skipIf(!available || process.platform !== 'linux')(
  'the node_modules grant reaches nothing the key does not answer for',
  () => {
    let fixture: Fixture

    beforeEach(async () => {
      fixture = await makeWorkspace({ '@x/app': ['@x/b'], '@x/b': [] })
    })
    afterEach(async () => {
      await rm(fixture.root, { recursive: true, force: true })
    })

    const runTest = () =>
      run({ cwd: fixture.root, tasks: ['@x/app#test'], log: collectingLogger(fixture) })
    const testOutcome = (r: RunSummary) => r.outcomes.find((o) => o.node.id === '@x/app#test')

    /** `@x/b` holding `secret.txt` (and `src/`); returns its dir. */
    const sibling = () =>
      addProject(fixture.root, '@x/b', {
        files: { 'secret.txt': 'secret 1\n', 'src/index.js': 'export const b = 1\n' },
        config: keyedSource,
      })

    /** An edit to `file` must not replay the old read as a hit. */
    const neverStale = async (file: string, app: string): Promise<RunSummary> => {
      const first = await runTest()
      await writeFile(file, 'secret 2\n')
      const second = await runTest()
      const out = await readFile(path.join(app, 'dist', 'out.txt'), 'utf8').catch(() => '')
      expect([testOutcome(second)?.status, out]).not.toEqual(['cache-hit', 'secret 1\n'])
      return first
    }

    for (const read of ['src/**', '.']) {
      it(
        `a project's node_modules linked to the workspace root grants none of it (read ${read})`,
        async () => {
          const b = await sibling()
          const app = await addProject(fixture.root, '@x/app', {
            files: { 'src/index.js': '' },
            config: appConfig('node_modules/packages/x-b/secret.txt', read),
          })
          await symlink('../..', path.join(app, 'node_modules'))
          const first = await neverStale(path.join(b, 'secret.txt'), app)
          expect(testOutcome(first)?.status).toBe('failed')
        },
        TIMEOUT,
      )

      it(
        `a project's node_modules linked to an unkeyed sibling is withheld, the read reported (read ${read})`,
        async () => {
          const b = await sibling()
          const app = await addProject(fixture.root, '@x/app', {
            files: { 'src/index.js': '' },
            config: appConfig('node_modules/secret.txt', read),
          })
          await symlink('../x-b', path.join(app, 'node_modules'))
          const first = await neverStale(path.join(b, 'secret.txt'), app)
          expect(testOutcome(first)?.status).toBe('failed')
          expect(testOutcome(first)?.sandboxViolations).toBeGreaterThan(0)
        },
        TIMEOUT,
      )
    }

    it(
      'CONTROL: a node_modules linked to a keyed sibling reads it, and an edit there re-runs',
      async () => {
        const b = await sibling()
        await writeFile(path.join(b, 'src', 'index.js'), 'secret 1\n')
        const app = await addProject(fixture.root, '@x/app', {
          files: { 'src/index.js': '' },
          config: appConfig('node_modules/src/index.js', '.', ['^source']),
        })
        await symlink('../x-b', path.join(app, 'node_modules'))
        expectOk(await runTest(), fixture)
        await writeFile(path.join(b, 'src', 'index.js'), 'secret 2\n')
        const r = await runTest()
        expectOk(r, fixture)
        expect(testOutcome(r)?.status).toBe('success')
        expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe('secret 2\n')
      },
      TIMEOUT,
    )

    it(
      "a keyed linked package's nested project is walled, the read reported",
      async () => {
        const b = await sibling()
        const nested = path.join(b, 'c')
        await mkdir(nested, { recursive: true })
        await writeFile(path.join(nested, 'package.json'), '{"name":"@x/c","version":"0.0.0"}')
        await writeFile(path.join(nested, 'vx.config.mjs'), 'export default { tasks: {} }\n')
        await writeFile(path.join(nested, 'secret.txt'), 'secret 1\n')
        const app = await addProject(fixture.root, '@x/app', {
          files: { 'src/index.js': '' },
          config: appConfig('node_modules/@x/b/c/secret.txt', 'src/**', ['^source']),
        })
        await mkdir(path.join(app, 'node_modules', '@x'), { recursive: true })
        await symlink('../../../x-b', path.join(app, 'node_modules', '@x', 'b'))
        const first = await neverStale(path.join(nested, 'secret.txt'), app)
        expect(testOutcome(first)?.status).toBe('failed')
        expect(testOutcome(first)?.sandboxViolationLines?.[0]).toBe(
          `openat(node_modules/@x/b/c/secret.txt) = -1 ENOENT  [${realpathSync(nested)}/secret.txt]`,
        )
      },
      TIMEOUT,
    )

    it(
      'CONTROL: the keyed linked package itself stays readable',
      async () => {
        await sibling()
        const app = await addProject(fixture.root, '@x/app', {
          files: { 'src/index.js': '' },
          config: appConfig('node_modules/@x/b/secret.txt', 'src/**', ['^source']),
        })
        await mkdir(path.join(app, 'node_modules', '@x'), { recursive: true })
        await symlink('../../../x-b', path.join(app, 'node_modules', '@x', 'b'))
        const r = await runTest()
        expectOk(r, fixture)
        expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe('secret 1\n')
      },
      TIMEOUT,
    )
  },
)
