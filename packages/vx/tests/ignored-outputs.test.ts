// An output git ignores is no input overlap (2026-10-15): a key reads
// only what git lists, so a gitignored output never enters it. Solid's
// shape, a `**/*` reader beside a `**/dist/**` producer with dist ignored,
// passes `vx lock` and keys up front, the key the same before and
// after the build. Git alone says what it ignores, wherever the rule lives;
// a tracked output, or a place under the glob git does not ignore, is still
// an overlap.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { Logger } from '../src/report/index.js'
import { deriveStableKeys } from '../src/orchestrator/stable-keys.js'
import { prepareRun, run } from './helpers/orchestrator.js'
import { checkIgnore, checkIgnoreSync } from '../src/util/index.js'
import { addProject, gitIn, gitInit, makeWorkspace } from './helpers/workspace.js'

const silent = new Proxy({}, { get: () => () => undefined }) as Logger

const config = `export default { tasks: {
  build: {
    exec: { command: 'mkdir -p dist && cp src/a.txt dist/a.txt' },
    inputs: { files: ['src/**'] }, outputs: { files: ['**/dist/**'] }, cache: true,
  },
  test: {
    dependsOn: ['build'],
    exec: { command: 'cat dist/a.txt' },
    inputs: { files: ['**/*'] }, outputs: { files: [] }, cache: true,
  },
} }`

/** The workspace with `app`, `ignore` written as `{ rel: lines }` from the root. */
async function fixture(ignore: Record<string, string>): Promise<{ root: string; app: string }> {
  const root = await makeWorkspace({ prefix: 'vx-ignored-out-' })
  const app = await addProject(root, 'app', { files: { 'src/a.txt': 'A1' }, config })
  for (const [rel, lines] of Object.entries(ignore)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), lines)
  }
  return { root, app }
}

/** app#test's up-front key, or null when the gate keeps it waiting. */
async function upfrontKey(root: string): Promise<string | null> {
  const prepared = await prepareRun({ cwd: root, tasks: ['test'], log: silent }, silent)
  try {
    const stable = await deriveStableKeys({
      nodes: prepared.nodes,
      cache: prepared.cache,
      workspaceRoot: prepared.workspaceRoot,
      claimedFiles: prepared.fingerprintWatch.names,
      nestedDirsByProject: prepared.nestedDirsByProject,
      gitFilesCache: prepared.gitFilesCache,
      hashCache: prepared.hashCache,
    })
    return stable.find((k) => k.node.id === 'app#test')?.hash ?? null
  } finally {
    prepared.cache.close()
  }
}

async function keyedTheSameAcrossTheBuild(root: string): Promise<void> {
  const before = await upfrontKey(root)
  expect(before).not.toBeNull()
  const built = await run({ cwd: root, tasks: ['build'], log: silent })
  expect(built.ok).toBe(true)
  expect(await upfrontKey(root)).toBe(before)
}

const refusal =
  /app#test reads "\*\*\/\*" in inputs\.files, which matches app#build's output "\*\*\/dist\/\*\*"/

describe('an output git ignores is no overlap', () => {
  for (const [where, ignore] of [
    ['the workspace root’s .gitignore', { '.gitignore': 'dist/\n' }],
    ['a .gitignore between the root and the project', { 'packages/.gitignore': 'dist\n' }],
    ['the project’s own .gitignore', { 'packages/app/.gitignore': 'dist/\n' }],
    ['.git/info/exclude', { '.git/info/exclude': 'dist/\n' }],
  ] as const) {
    it(`passes the rule and keys up front, unchanged by the build: ${where}`, async () => {
      const { root } = await fixture(ignore)
      try {
        await keyedTheSameAcrossTheBuild(root)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 30_000)
  }

  it('CONTROL: with nothing ignored the rule refuses the reader', async () => {
    const { root } = await fixture({})
    try {
      await expect(upfrontKey(root)).rejects.toThrow(refusal)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('CONTROL: a rule only one nested directory holds leaves the rest of **/dist/** read', async () => {
    // `sub/.gitignore` ignores sub/dist; a `dist` anywhere else is listed.
    const { root } = await fixture({ 'packages/app/sub/.gitignore': 'dist/\n' })
    try {
      await expect(upfrontKey(root)).rejects.toThrow(refusal)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('CONTROL: a tracked file under an ignored output is still an overlap', async () => {
    const { root, app } = await fixture({ '.gitignore': 'dist/\n' })
    try {
      await mkdir(path.join(app, 'dist'), { recursive: true })
      await writeFile(path.join(app, 'dist/kept.txt'), 'k')
      gitIn(root)('add', '-f', 'packages/app/dist/kept.txt')
      await expect(upfrontKey(root)).rejects.toThrow(refusal)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('CONTROL: a tracked file deeper under the glob is still an overlap', async () => {
    const { root, app } = await fixture({ '.gitignore': 'dist/\n' })
    try {
      await mkdir(path.join(app, 'deep/er/dist'), { recursive: true })
      await writeFile(path.join(app, 'deep/er/dist/kept.txt'), 'k')
      gitIn(root)('add', '-f', 'packages/app/deep/er/dist/kept.txt')
      await expect(upfrontKey(root)).rejects.toThrow(refusal)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('CONTROL: a directory a ! line takes back from the rule is still an overlap', async () => {
    const { root, app } = await fixture({ '.gitignore': 'dist/\n!packages/app/deep/dist/\n' })
    try {
      await mkdir(path.join(app, 'deep/dist'), { recursive: true })
      await writeFile(path.join(app, 'deep/dist/x.txt'), 'x')
      await expect(upfrontKey(root)).rejects.toThrow(refusal)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

// A root output glob with no literal directory (`*.tgz`, `**/*.tsbuildinfo`)
// had no path to ask git of, so `vx lock` refused a `**` reader beside it
// even with the glob itself in .gitignore. Git now names the rule that
// ignores a probe; only the glob's own name pattern speaks for every name.
describe('a root output glob with no literal directory', () => {
  const rootConfig = (out: string): string => `export default { tasks: {
  pack: {
    exec: { command: '${out.startsWith('**') ? 'mkdir -p d && touch a.tgz d/b.tgz' : 'touch a.tgz'}' },
    inputs: { files: ['src/**'] }, outputs: { files: [${JSON.stringify(out)}] }, cache: true,
  },
  test: {
    dependsOn: ['pack'],
    exec: { command: 'true' },
    inputs: { files: ['**'] }, outputs: { files: [] }, cache: true,
  },
} }`
  const rootKey = async (root: string): Promise<string | null> => {
    const prepared = await prepareRun({ cwd: root, tasks: ['test'], log: silent }, silent)
    try {
      const stable = await deriveStableKeys({
        nodes: prepared.nodes,
        cache: prepared.cache,
        workspaceRoot: prepared.workspaceRoot,
        claimedFiles: prepared.fingerprintWatch.names,
        nestedDirsByProject: prepared.nestedDirsByProject,
        gitFilesCache: prepared.gitFilesCache,
        hashCache: prepared.hashCache,
      })
      return stable.find((k) => k.node.id === 'fixture-root#test')?.hash ?? null
    } finally {
      prepared.cache.close()
    }
  }
  const at = async (
    out: string,
    ignore: string,
    files: Record<string, string> = {},
  ): Promise<string> => {
    const root = await makeWorkspace({ prefix: 'vx-ignored-rootglob-' })
    await writeFile(path.join(root, 'vx.config.mjs'), rootConfig(out))
    await writeFile(path.join(root, '.gitignore'), ignore)
    for (const [rel, text] of Object.entries({ 'src/a.txt': 'A', ...files })) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
      await writeFile(path.join(root, rel), text)
    }
    return root
  }
  const refused = (out: string): RegExp =>
    new RegExp(
      `fixture-root#test reads "\\*\\*" in inputs\\.files, which matches fixture-root#pack's output "${out.replaceAll('*', '\\*')}"`,
    )

  for (const [out, ignore] of [
    ['*.tgz', '*.tgz\n'],
    ['*.tgz', '/*.tgz\n'],
    ['**/*.tgz', '*.tgz\n'],
    ['**/*.tgz', '**/*.tgz\n'],
  ] as const) {
    it(`${out} with ${JSON.stringify(ignore.trim())} ignored keys up front, unchanged by the build`, async () => {
      const root = await at(out, ignore)
      try {
        const before = await rootKey(root)
        expect(before).not.toBeNull()
        expect((await run({ cwd: root, tasks: ['pack'], log: silent })).ok).toBe(true)
        expect(await rootKey(root)).toBe(before)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 30_000)
  }

  for (const [why, out, ignore, files] of [
    ['nothing ignored', '*.tgz', '', {}],
    ['a rule for some names only', '*.tgz', 'pkg-*.tgz\n__vx*\n', {}],
    ['a one-character rule', '*.tgz', '?.tgz\n__vx_probe__.tgz\n', {}],
    ['a root-only rule beside a deep glob', '**/*.tgz', '/*.tgz\n', {}],
    ['a file a ! line takes back', '*.tgz', '*.tgz\n!keep.tgz\n', { 'keep.tgz': 'k' }],
  ] as const) {
    it(`CONTROL: ${why} is still an overlap`, async () => {
      const root = await at(out, ignore, files)
      try {
        await expect(rootKey(root)).rejects.toThrow(refused(out))
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 30_000)
  }
})

// `check-ignore` reads each path as a pathspec: `:top/dist/` was asked as
// `top/dist/`, so a rule for `top/` answered for a project dir `:top`.
describe('a path that reads as pathspec magic', () => {
  it('is asked of git as the path it is, sync and async', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-ignored-magic-'))
    try {
      gitInit(root)
      await writeFile(path.join(root, '.gitignore'), '/top/\n/:x/dist/\n')
      const asked = [':top/dist/', ':x/dist/', 'top/dist/']
      const want = new Set([':x/dist/', 'top/dist/'])
      expect(checkIgnoreSync(root, asked)).toEqual(want)
      expect(await checkIgnore(root, asked)).toEqual(want)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
