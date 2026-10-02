// The root note's examples of running the members are the repo's own
// manager's: an npm repo read "(`pnpm -r`, `--filter`, a runner)"
// (insomnia).
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

it("names the members the way the repo's manager runs them", async () => {
  const rows: Record<string, string | undefined> = {}
  for (const [label, file, body] of [
    ['npm', 'package-lock.json', '{}'],
    ['yarn 1', 'yarn.lock', '# yarn lockfile v1\n'],
    ['berry', 'yarn.lock', '\n__metadata:\n  version: 8\n'],
    ['bun', 'bun.lock', '{}'],
    ['pnpm', 'pnpm-lock.yaml', ''],
    // pnpm's workspace file names pnpm whatever else is there.
    ['pnpm workspace file', 'pnpm-workspace.yaml', 'packages: [packages/*]\n'],
    // CONTROL: no lockfile anywhere keeps the wording it had.
    ['none', null, ''],
  ] as [string, string | null, string][]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-root-note-'))
    try {
      if (file !== null) await writeFile(path.join(dir, file), body)
      const plan = migrateScripts([
        meta('root', dir, { lint: 'eslint .', all: 'lerna run build' }),
        meta('a', path.join(dir, 'packages', 'a'), { build: 'tsc' }),
      ])
      rows[label] = plan.notes
        .find((n) => n.startsWith('root (the workspace root)'))
        ?.match(/running the members \((.*), a runner\)/)?.[1]
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  expect(rows).toEqual({
    npm: '`--workspaces`, `-w`',
    'yarn 1': '`yarn workspaces run`, `yarn workspace`',
    berry: '`yarn workspaces foreach`, `yarn workspace`',
    bun: '`bun --filter`',
    pnpm: '`pnpm -r`, `--filter`',
    'pnpm workspace file': '`pnpm -r`, `--filter`',
    none: '`pnpm -r`, `--filter`',
  })
})
