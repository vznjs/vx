// Each plugin claims its manager's install settings — files no lockfile
// records that lay `node_modules` out anew (pnpm's `node-linker`, bun's
// `linker`, a registry in `.npmrc`, Yarn 4's catalogs) — and folds each
// whole into every task, named by the file in `vx why`. A change to one
// selects every project under `--affected`.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { TaskNode, VxPlugin } from '@vzn/vx'
import { bun, npm, pnpm, yarn } from '../src/index.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-settings-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const CASES = [
  {
    make: pnpm,
    files: ['pnpm-lock.yaml'],
    settings: ['pnpm-workspace.yaml', '.npmrc', 'package.json'],
  },
  { make: bun, files: ['bun.lock'], settings: ['bunfig.toml', '.npmrc'] },
  { make: npm, files: ['npm-shrinkwrap.json', 'package-lock.json'], settings: ['.npmrc'] },
  { make: yarn, files: ['yarn.lock'], settings: ['.yarnrc.yml', '.yarnrc', 'package.json'] },
] as const

/** One run's key for a task at the root: a fresh context, as core hands each run. */
async function key(plugin: VxPlugin): Promise<Readonly<Record<string, string>> | undefined> {
  const ctx = { workspaceRoot: root, cacheDir: path.join(root, '.vx', 'cache'), warn() {} }
  return plugin.key!({ projectDir: root } as TaskNode, ctx)
}

describe('install settings', () => {
  for (const c of CASES) {
    it(`${c.make.name}() claims ${c.settings.join(' and ')} and folds each into every task`, async () => {
      const plugin = c.make()
      expect(plugin.fingerprint?.files).toEqual([...c.files, ...c.settings])
      // No lockfile and no settings: nothing to fold.
      expect(await key(plugin)).toBeUndefined()
      const seen = new Set<string>()
      for (const file of c.settings) {
        await writeFile(path.join(root, file), `# ${file} v1\n`)
        const one = await key(plugin)
        expect(Object.keys(one ?? {})).toContain(file)
        seen.add(JSON.stringify(one))
        await writeFile(path.join(root, file), `# ${file} v2\n`)
        seen.add(JSON.stringify(await key(plugin)))
      }
      // Each write moved the key.
      expect(seen.size).toBe(c.settings.length * 2)
    })

    it(`${c.make.name}(): a settings change selects every project under --affected`, async () => {
      const change = {
        file: c.settings[0],
        before: new TextEncoder().encode('a'),
        after: new TextEncoder().encode('b'),
      }
      const ctx = { workspaceRoot: root, cacheDir: root, warn() {}, projects: [] }
      expect(await c.make().fingerprint!.affected(change, ctx)).toBeUndefined()
    })
  }
})
