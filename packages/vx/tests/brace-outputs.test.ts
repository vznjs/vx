// An output glob whose brace alternatives hold a `/` (A-10). `Bun.Glob`'s
// scan finds nothing for `{dist,lib/esm}/**`, so the save packed an empty
// artifact and a hit cleaned the outputs and restored nothing, green.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  root = await makeWorkspace({ prefix: 'vx-brace-out-' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a brace over two directories saves and restores both, and nothing beside them', async () => {
  const app = await addProject(root, 'app', {
    config: `
      export default {
        tasks: {
          build: {
            exec: { command: 'mkdir -p dist lib/esm lib/cjs && echo a > dist/a.js && echo b > lib/esm/b.js && echo c > lib/cjs/c.js' },
            inputs: { files: ['src/**'] }, outputs: { files: ['{dist,lib/esm}/**'] }, cache: true,
          },
        },
      }
    `,
    files: { 'src/x.ts': 'x', '.gitignore': 'dist/\nlib/\n' },
  })
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'fixture')
  const build = () => run({ cwd: root, tasks: ['app#build'], log, handleSignals: false })
  const first = await build()
  expect(first.outcomes[0]!.status).toBe('success')
  await rm(path.join(app, 'dist'), { recursive: true })
  await rm(path.join(app, 'lib'), { recursive: true })
  const hit = await build()
  expect(hit.outcomes[0]!.status).toBe('cache-hit')
  expect([
    readFileSync(path.join(app, 'dist/a.js'), 'utf8'),
    readFileSync(path.join(app, 'lib/esm/b.js'), 'utf8'),
    existsSync(path.join(app, 'lib/cjs/c.js')),
  ]).toEqual(['a\n', 'b\n', false])
})

// A brace of directory literals saved an empty artifact (the hit restored
// nothing), and `{./dist,lib}/**` saved `dist/sub/a.js` that the restore
// then refused as no declared output, so every run missed.
it('a brace of directory literals or ./ spellings saves and restores each tree', async () => {
  for (const [name, glob] of [
    ['lit', '{dist,lib}'],
    ['dot', '{./dist,lib}/**'],
  ] as const) {
    const app = await addProject(root, name, {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist/sub lib && echo a > dist/sub/a.js && echo b > lib/b.js' },
              inputs: { files: ['src/**'] }, outputs: { files: [${JSON.stringify(glob)}] }, cache: true,
            },
          },
        }
      `,
      files: { 'src/x.ts': 'x', '.gitignore': 'dist/\nlib/\n' },
    })
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', name)
    const build = () => run({ cwd: root, tasks: [`${name}#build`], log, handleSignals: false })
    expect((await build()).outcomes[0]!.status).toBe('success')
    await rm(path.join(app, 'dist'), { recursive: true })
    await rm(path.join(app, 'lib'), { recursive: true })
    const hit = await build()
    expect([glob, hit.outcomes[0]!.status]).toEqual([glob, 'cache-hit'])
    expect([
      readFileSync(path.join(app, 'dist/sub/a.js'), 'utf8'),
      readFileSync(path.join(app, 'lib/b.js'), 'utf8'),
    ]).toEqual(['a\n', 'b\n'])
  }
})

// An escape turned brace expansion off: `{dist,app/\[id\]}` saved an
// empty artifact, and the hit restored nothing.
it('a brace holding an escaped char saves and restores each tree', async () => {
  const app = await addProject(root, 'app', {
    config: `
      export default {
        tasks: {
          build: {
            exec: { command: 'mkdir -p dist "app/[id]" && echo a > dist/a.js && echo b > "app/[id]/b.js"' },
            inputs: { files: ['src/**'] }, outputs: { files: ['{dist,app/\\\\[id\\\\]}'] }, cache: true,
          },
        },
      }
    `,
    files: { 'src/x.ts': 'x', '.gitignore': 'dist/\napp/\n' },
  })
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'fixture')
  const build = () => run({ cwd: root, tasks: ['app#build'], log, handleSignals: false })
  expect((await build()).outcomes[0]!.status).toBe('success')
  await rm(path.join(app, 'dist'), { recursive: true })
  await rm(path.join(app, 'app'), { recursive: true })
  expect((await build()).outcomes[0]!.status).toBe('cache-hit')
  expect([
    readFileSync(path.join(app, 'dist/a.js'), 'utf8'),
    readFileSync(path.join(app, 'app/[id]/b.js'), 'utf8'),
  ]).toEqual(['a\n', 'b\n'])
})

// `Bun.Glob`'s scan reads `\]`, `\}` and `\\` in a segment with no wildcard
// as the backslash and the character, so `dist/\]b` saved nothing: a hit
// cleaned the output and restored none of it, green, and silent while
// another escaped glob (`dist/\[a\]`) matched.
it('an escaped bracket, brace or backslash output saves and restores, alone or beside others', async () => {
  const cmd =
    `mkdir -p dist "dist/]d" "l]/]c" && printf A > "dist/[a]" && printf B > "dist/]b" && ` +
    `printf C > "dist/}x" && printf D > 'dist/a\\b' && printf E > "dist/]d/e" && printf F > "l]/]c/f"`
  const want: Record<string, string> = {
    'dist/[a]': 'A',
    'dist/]b': 'B',
    'dist/}x': 'C',
    'dist/a\\b': 'D',
    'dist/]d/e': 'E',
    'l]/]c/f': 'F',
  }
  const cases: [string, string[], string[]][] = [
    ['b', ['dist/\\]b'], ['dist/]b']],
    ['c', ['dist/\\}x'], ['dist/}x']],
    ['d', ['dist/a\\\\b'], ['dist/a\\b']],
    [
      'all',
      ['dist/\\[a\\]', 'dist/\\]b', 'dist/\\}x', 'dist/a\\\\b', 'dist/\\]d', 'l*/\\]c/**'],
      Object.keys(want),
    ],
  ]
  for (const [name, outputs, restored] of cases) {
    const app = await addProject(root, name, {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: ${JSON.stringify(cmd)} },
              inputs: { files: ['src/**'] }, outputs: { files: ${JSON.stringify(outputs)} }, cache: true,
            },
          },
        }
      `,
      files: { 'src/x.ts': 'x', '.gitignore': 'dist/\nl]/\n' },
    })
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', name)
    const build = () => run({ cwd: root, tasks: [`${name}#build`], log, handleSignals: false })
    expect((await build()).outcomes[0]!.status).toBe('success')
    await rm(path.join(app, 'dist'), { recursive: true })
    await rm(path.join(app, 'l]'), { recursive: true })
    expect([name, (await build()).outcomes[0]!.status]).toEqual([name, 'cache-hit'])
    const got = Object.fromEntries(
      Object.keys(want)
        .filter((f) => existsSync(path.join(app, f)))
        .map((f) => [f, readFileSync(path.join(app, f), 'utf8')]),
    )
    expect([name, got]).toEqual([name, Object.fromEntries(restored.map((f) => [f, want[f]!]))])
  }
})

// `Bun.Glob`'s scan reads a `!` that starts a name as a negation: the save
// of `out/*/!a` packed every other file in `out/x` (the next restore
// refused the artifact) and its clean deleted `out/y/notes.md`, and
// `out/!*` saved nothing, so a hit restored nothing.
it('an output whose name starts with ! saves that file alone and cleans nothing else', async () => {
  const cases: [string, string, string[], string[]][] = [
    [
      'inner',
      'mkdir -p out/x && printf A > "out/x/!a" && printf K > out/x/hand.txt',
      ['out/*/!a'],
      ['out/x/!a'],
    ],
    ['star', 'mkdir -p out && printf A > "out/!a"', ['out/!*'], ['out/!a']],
  ]
  for (const [name, cmd, outputs, restored] of cases) {
    const app = await addProject(root, name, {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: ${JSON.stringify(cmd)} },
              inputs: { files: ['src/**'] }, outputs: { files: ${JSON.stringify(outputs)} }, cache: true,
            },
          },
        }
      `,
      files: { 'src/x.ts': 'x', 'out/y/notes.md': 'mine', '.gitignore': 'out/x/\nout/!a\n' },
    })
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', name)
    const build = () => run({ cwd: root, tasks: [`${name}#build`], log, handleSignals: false })
    expect([name, (await build()).outcomes[0]!.status]).toEqual([name, 'success'])
    for (const f of restored) await rm(path.join(app, f))
    expect([name, (await build()).outcomes[0]!.status]).toEqual([name, 'cache-hit'])
    expect([
      name,
      restored.map((f) => readFileSync(path.join(app, f), 'utf8')),
      readFileSync(path.join(app, 'out/y/notes.md'), 'utf8'),
    ]).toEqual([name, restored.map(() => 'A'), 'mine'])
  }
})

// `Bun.Glob`'s match lets a negated class take a `/`, and the clean of an
// output list holding a `**` glob walks once by that match: `gen[!.]*`
// beside `**/*.map` deleted the project's `gen/notes.txt`.
it('a negated class output never reaches below a directory', async () => {
  const app = await addProject(root, 'cls', {
    config: `
      export default {
        tasks: {
          build: {
            exec: { command: 'printf A > genA.js' },
            inputs: { files: ['src/**'] }, outputs: { files: ['**/*.map', 'gen[!.]*'] }, cache: true,
          },
        },
      }
    `,
    files: { 'src/x.ts': 'x', '.gitignore': 'genA.js\n' },
  })
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'cls')
  mkdirSync(path.join(app, 'gen'))
  writeFileSync(path.join(app, 'gen/notes.txt'), 'precious')
  const build = () => run({ cwd: root, tasks: ['cls#build'], log, handleSignals: false })
  expect((await build()).outcomes[0]!.status).toBe('success')
  await rm(path.join(app, 'genA.js'))
  expect((await build()).outcomes[0]!.status).toBe('cache-hit')
  expect([
    readFileSync(path.join(app, 'genA.js'), 'utf8'),
    readFileSync(path.join(app, 'gen/notes.txt'), 'utf8'),
  ]).toEqual(['A', 'precious'])
})
