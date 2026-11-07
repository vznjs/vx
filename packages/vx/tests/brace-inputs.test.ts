// An input glob whose brace alternative ends in `**`. `Bun.Glob`'s match
// reads that `**` as one segment: `{src/**,lib/**}` matched `src/a.ts` and
// never `src/deep/a.ts`, so an edit to a nested source was a stale hit.

import { writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { type Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const log: Logger = {
  status: () => {},
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
}
let root: string

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-brace-in-' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a brace alternative ending in ** folds files below its first directory', async () => {
  const app = await addProject(root, 'app', {
    config: `
      export default {
        tasks: {
          build: {
            exec: { command: 'true' },
            inputs: { files: ['{src/**,lib/**}'] }, outputs: { files: [] }, cache: true,
          },
        },
      }
    `,
    files: { 'src/top.ts': 'a', 'src/deep/x.ts': 'a', 'lib/y.ts': 'a', 'other/z.ts': 'a' },
  })
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'fixture')
  const build = async () =>
    (await run({ cwd: root, tasks: ['app#build'], log, handleSignals: false })).outcomes[0]!.status
  expect(await build()).toBe('success')
  writeFileSync(path.join(app, 'src/deep/x.ts'), 'b')
  expect(await build()).toBe('success')
  // CONTROL: a file no alternative names stays out of the key.
  writeFileSync(path.join(app, 'other/z.ts'), 'b')
  expect(await build()).toBe('cache-hit')
})

// A brace of directory literals, or of `./` spellings, keyed nothing for
// them: `{src,lib}` and `{./src,lib}/**` replayed the old output after an
// edit under `src`, and `{.,src}/*.ts` after one to a root `a.ts`.
it('a brace of directories or ./ spellings keys what each alternative names', async () => {
  const cases = [
    ['lit', '{src,lib}', 'src/deep/a.ts'],
    ['dot', '{./src,lib}/**', 'src/deep/a.ts'],
    ['top', '{.,src}/*.ts', 'a.ts'],
  ] as const
  for (const [name, glob, file] of cases) {
    const app = await addProject(root, name, {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'true' },
              inputs: { files: [${JSON.stringify(glob)}] }, outputs: { files: [] }, cache: true,
            },
          },
        }
      `,
      files: { [file]: 'a', 'other/z.ts': 'a' },
    })
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', name)
    const build = async () =>
      (await run({ cwd: root, tasks: [`${name}#build`], log, handleSignals: false })).outcomes[0]!
        .status
    expect(await build()).toBe('success')
    writeFileSync(path.join(app, file), 'b')
    expect([glob, await build()]).toEqual([glob, 'success'])
    // CONTROL: a file no alternative names stays out of the key.
    writeFileSync(path.join(app, 'other/z.ts'), 'b')
    expect([glob, await build()]).toEqual([glob, 'cache-hit'])
  }
})

// vercel/turborepo#13763 pinned that a `,` inside a class is no
// alternative. Split there, `src/{a[,]b,x}.ts` became `src/a[.ts` and
// `src/]b.ts`: an edit to `src/a,b.ts` replayed the old output, and the
// same glob after `!` never took the file back.
it('a `,` `{` or `}` inside a class in a brace alternative is a member, not a cut', async () => {
  const cases = [
    ['inc', "['src/{a[,]b,x}.ts']", 'src/a,b.ts', 'src/b.ts'],
    ['open', "['src/{a[{]b,x}.ts']", 'src/a{b.ts', 'src/b.ts'],
    ['exc', "['src/**', '!src/{a[,]b,x}.ts']", 'src/c.ts', 'src/a,b.ts'],
  ] as const
  for (const [name, files, keyed, unkeyed] of cases) {
    const app = await addProject(root, name, {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'true' },
              inputs: { files: ${files} }, outputs: { files: [] }, cache: true,
            },
          },
        }
      `,
      files: { [keyed]: 'a', [unkeyed]: 'a' },
    })
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', name)
    const build = async () =>
      (await run({ cwd: root, tasks: [`${name}#build`], log, handleSignals: false })).outcomes[0]!
        .status
    expect(await build()).toBe('success')
    writeFileSync(path.join(app, keyed), 'b')
    expect([files, await build()]).toEqual([files, 'success'])
    writeFileSync(path.join(app, unkeyed), 'b')
    expect([files, await build()]).toEqual([files, 'cache-hit'])
  }
})

// An escape anywhere in a glob turned brace expansion off, so
// `{src,app/\[id\]}` stayed one glob naming neither tree: an edit to
// `src/a.ts` replayed the old output.
it('a brace holding an escaped char keys what each alternative names', async () => {
  const app = await addProject(root, 'app', {
    config: `
      export default {
        tasks: {
          build: {
            exec: { command: 'true' },
            inputs: { files: ['{src,app/\\\\[id\\\\]}'] }, outputs: { files: [] }, cache: true,
          },
        },
      }
    `,
    files: { 'src/a.ts': 'a', 'app/[id]/page.ts': 'a', 'other/z.ts': 'a' },
  })
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'fixture')
  const build = async () =>
    (await run({ cwd: root, tasks: ['app#build'], log, handleSignals: false })).outcomes[0]!.status
  expect(await build()).toBe('success')
  writeFileSync(path.join(app, 'src/a.ts'), 'b')
  expect(await build()).toBe('success')
  writeFileSync(path.join(app, 'app/[id]/page.ts'), 'b')
  expect(await build()).toBe('success')
  // CONTROL: a file no alternative names stays out of the key.
  writeFileSync(path.join(app, 'other/z.ts'), 'b')
  expect(await build()).toBe('cache-hit')
})
