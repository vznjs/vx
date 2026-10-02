// A Lerna-classic root lists its packages in lerna.json, not `workspaces`,
// and vx saw the root alone: init names the globs to add.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { migrateScripts } from '../src/workspace/migrate-scripts.js'

const meta = (name: string, dir: string, scripts: Record<string, string>) => ({
  name,
  dir,
  packageJson: { name, scripts } as never,
  configPath: null,
})

it('names lerna.json packages a lone root does not reach', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-init-lerna-'))
  const notes = (metas: ReturnType<typeof meta>[]) =>
    migrateScripts(metas).notes.filter((n) => n.startsWith('lerna.json'))
  try {
    const root = meta('r', dir, { build: 'lerna run build' })
    await writeFile(path.join(dir, 'lerna.json'), '{ "packages": ["modules/*", "tools/*"] }')
    expect(notes([root])).toEqual([
      'lerna.json lists the packages ("modules/*", "tools/*"), but package.json declares no `workspaces`, so vx sees the root alone: add `"workspaces": ["modules/*", "tools/*"]` to package.json and run `vx init` again',
    ])
    // Lerna's default when lerna.json names none.
    await writeFile(path.join(dir, 'lerna.json'), '{ "version": "1.0.0" }')
    expect(notes([root])[0]).toContain('("packages/*")')
    // CONTROLS: members already reached, and no lerna.json.
    expect(notes([root, meta('a', path.join(dir, 'modules', 'a'), { build: 'tsc' })])).toEqual([])
    await rm(path.join(dir, 'lerna.json'))
    expect(notes([root])).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
