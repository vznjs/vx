// What an output glob may reach, proven on the clean that deletes it (A-13).
// `**/*.js` meant the build's files; the clean before each run deleted every
// installed `.js` under `node_modules` too, and a workspace output glob
// reached into `.git`. `node_modules` is reached only when a glob names it
// (an install task's `node_modules/**`), `.git` and `.vx` never.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { cleanOutputs, cleanWorkspaceOutputs } from '../src/cache/index.js'

let root: string
const FILES = [
  'dist/a.js',
  'lib/b.js',
  'node_modules/dep/index.js',
  'src/node_modules/x.js',
  '.git/hooks/h.js',
]

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vx-output-reach-'))
  for (const f of FILES) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
    writeFileSync(path.join(root, f), f)
  }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const left = () => FILES.filter((f) => existsSync(path.join(root, f)))

it('a project glob that does not name node_modules leaves it', async () => {
  await cleanOutputs({ projectDir: root, outputs: ['**/*.js'], nestedProjectDirs: [] })
  expect(left()).toEqual(['node_modules/dep/index.js', 'src/node_modules/x.js', '.git/hooks/h.js'])
})

it('an install task that names node_modules still cleans it (control)', async () => {
  await cleanOutputs({ projectDir: root, outputs: ['node_modules/**'], nestedProjectDirs: [] })
  expect(left()).toEqual(['dist/a.js', 'lib/b.js', 'src/node_modules/x.js', '.git/hooks/h.js'])
})

it('a workspace glob leaves node_modules and .git', async () => {
  await cleanWorkspaceOutputs({ workspaceRoot: root, outputs: ['**/*.js'] })
  expect(left()).toEqual(['node_modules/dep/index.js', 'src/node_modules/x.js', '.git/hooks/h.js'])
})
