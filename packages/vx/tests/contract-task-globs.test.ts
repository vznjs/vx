// Task-glob semantics are a 1.0 contract surface (docs/design/versioning-1.0.md):
// which paths a `cache.inputs.files` or `cache.outputs.files` pattern
// selects. The answer is core's resolver over `Bun.Glob`, so it can move
// without a line of vx changing: a Bun upgrade that reads `[`, a brace or a
// dotfile differently re-keys or un-keys files, and a file dropped from a
// key is a stale hit. This file resolves a fixed set of patterns against a
// fixed project tree through the real resolvers and compares every
// selection with `tests/contract/task-globs.json`, so a change in what a
// pattern selects, from vx or from the runtime, is a reviewed diff.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-task-globs.test.ts

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveInputs, resolveOutputs } from '../src/cache/inputs.js'

// A git init plus ~40 resolutions; the default hook budget is tight under
// a loaded shard (inputs-resolution.test.ts does the same).
setDefaultTimeout(30_000)

const RECORD = path.join(import.meta.dir, 'contract', 'task-globs.json')

/** The project tree, relative to the project dir. Each shape a pattern can disagree about. */
const TREE = [
  '.env',
  '.github/ci.yml',
  '.gitignore',
  'README.md',
  'a.ts',
  'ab.ts',
  'dist/out.js',
  'dist/nested/chunk.js',
  'ignored.txt',
  'lib/b.js',
  'node_modules/m/index.js',
  'package.json',
  'src/(group)/page.ts',
  'src/[id].ts',
  'src/a.js',
  'src/a.test.ts',
  'src/deep/.hidden.ts',
  'src/deep/x/y.ts',
  'src/file with space.ts',
  'src/index.ts',
  'src/{b}.ts',
]

/** Each entry is one `files` list, resolved as a whole. */
const INPUTS: readonly (readonly string[])[] = [
  ['**'],
  ['**/*'],
  ['*'],
  ['*.ts'],
  ['?.ts'],
  ['.*'],
  ['**/.*'],
  ['.github/**'],
  ['README.md'],
  ['ignored.txt'],
  ['node_modules/**'],
  ['src'],
  ['src/'],
  ['src/*'],
  ['src/**'],
  ['./src/*.ts'],
  ['src/**/*.ts'],
  ['**/*.ts'],
  ['**/*.test.ts'],
  ['*.{ts,md}'],
  ['src/*.{ts,js}'],
  ['src/{a,index}.ts'],
  ['{src,lib}/**/*.js'],
  ['src/[id].ts'],
  ['src/{b}.ts'],
  ['src/(group)/page.ts'],
  ['src/(group)/*'],
  ['src/file with space.ts'],
  ['src/deep/**/y.ts'],
  ['src/**', '!src/**/*.test.ts'],
  ['**', '!src/**'],
  ['src/*.ts', '!src/[id].ts'],
]

/** Output lists, resolved by the resolver `cleanOutputs` and a save share. */
const OUTPUTS: readonly (readonly string[])[] = [
  ['dist/**'],
  ['dist'],
  ['dist/'],
  ['dist/*'],
  ['**/*.js'],
  ['lib/*.js'],
  ['src/[id].ts'],
  ['.github/**'],
]

let root: string
let projectDir: string

beforeAll(async () => {
  // Canonical: macOS's temp dir is a symlink, and a resolver that
  // realpaths one side would read a relative path off it.
  root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-globs-')))
  projectDir = path.join(root, 'pkg')
  for (const rel of TREE) {
    const file = path.join(projectDir, rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, rel === '.gitignore' ? 'ignored.txt\n' : rel)
  }
  // Inputs enumerate through git (untracked files included, ignored ones
  // not), so the fixture is a work tree. Signing off: a global gpgsign
  // would hang the fixture.
  for (const args of [
    ['init', '-q'],
    ['config', 'commit.gpgsign', 'false'],
  ]) {
    const p = Bun.spawnSync({ cmd: ['git', ...args], cwd: root, stdout: 'pipe', stderr: 'pipe' })
    if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  }
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const rel = (files: readonly string[]): string[] =>
  files.map((f) => path.relative(projectDir, f).split(path.sep).join('/')).sort()

/** What a list selects, or the refusal it meets (a refusal is semantics too). */
async function outcome(resolve: () => Promise<readonly string[]>): Promise<string[] | string> {
  try {
    return rel(await resolve())
  } catch (err) {
    expect((err as Error).name).toBe('UserError')
    return `refused: ${(err as Error).message.replaceAll(root, '$ROOT')}`
  }
}

type Selections = Record<'inputs' | 'outputs', Record<string, string[] | string>>

async function selections(): Promise<Selections> {
  const out: Selections = { inputs: {}, outputs: {} }
  for (const files of INPUTS) {
    out.inputs[JSON.stringify(files)] = await outcome(async () => {
      const got = await resolveInputs({
        projectDir,
        workspaceRoot: root,
        envSource: {},
        inputs: { files: [...files] },
        ownOutputs: [],
        nestedProjectDirs: [],
      })
      return got.files
    })
  }
  for (const files of OUTPUTS) {
    out.outputs[JSON.stringify(files)] = await outcome(() =>
      resolveOutputs({ projectDir, outputs: [...files], nestedProjectDirs: [] }),
    )
  }
  return out
}

describe('task-glob semantics (versioning-1.0.md)', () => {
  it('every pattern selects what tests/contract/task-globs.json records', async () => {
    const live = await selections()
    if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
      writeFileSync(RECORD, JSON.stringify(live, null, 2) + '\n')
    }
    // On a failure, the diff below IS a change in what a key covers: if it
    // came from a Bun upgrade, it is a stale-hit risk before it is a record
    // to regenerate.
    expect(live).toEqual(JSON.parse(readFileSync(RECORD, 'utf8')))
  })
})
