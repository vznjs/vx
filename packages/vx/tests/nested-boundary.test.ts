// A nested project's files stay out of its parent's inputs and outputs, and
// nothing else does (A-11). The boundary was one `<nested>/**` glob per
// nested project, which read `*` in a directory's NAME as a wildcard: a
// project at `pkg*` took its sibling `pkg-b`'s files out of the parent's key.
// It is an ancestor lookup now, which also costs O(depth) per file instead
// of one glob match per nested project.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { resolveInputs, resolveOutputs } from '../src/cache/index.js'

// Windows forbids `*` in a name: the subject cannot exist there.
const WIN32 = process.platform === 'win32'

let root: string

beforeEach(() => {
  if (WIN32) return
  root = mkdtempSync(path.join(os.tmpdir(), 'vx-nested-boundary-'))
  for (const f of [
    'pkg*/a.ts',
    'pkg*/a.out',
    'pkg-b/b.ts',
    'pkg-b/b.out',
    'a/bc/c.ts',
    'a/b/deep/d.ts',
    'src/e.ts',
  ]) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
    writeFileSync(path.join(root, f), f)
  }
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
})

afterEach(() => {
  if (!WIN32) rmSync(root, { recursive: true, force: true })
})

const nestedProjectDirs = () => [path.join(root, 'pkg*'), path.join(root, 'a/b')]
const rel = (files: readonly string[]) => files.map((f) => path.relative(root, f)).sort()

it.skipIf(WIN32)(
  'inputs: a nested project is out, a sibling its name would match as a glob is in',
  async () => {
    const resolved = await resolveInputs({
      projectDir: root,
      workspaceRoot: root,
      inputs: { files: ['**/*.ts'] },
      ownOutputs: [],
      nestedProjectDirs: nestedProjectDirs(),
      envSource: {},
    })
    expect(rel(resolved.files)).toEqual(['a/bc/c.ts', 'pkg-b/b.ts', 'src/e.ts'])
  },
)

it.skipIf(WIN32)('outputs: the same line', async () => {
  const outputs = await resolveOutputs({
    projectDir: root,
    outputs: ['**/*.out'],
    nestedProjectDirs: nestedProjectDirs(),
  })
  expect(rel(outputs)).toEqual(['pkg-b/b.out'])
})
