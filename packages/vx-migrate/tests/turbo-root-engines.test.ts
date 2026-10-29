// Turbo folds the root package.json's `engines` into every task's global
// hash; turbo() keyed no part of the root manifest, so raising
// `engines.node` replayed a hit where `turbo run` re-ran
// (bugs/turbo-root-engines-unkeyed.sh, vercel/turborepo#13539).
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { planRun as livePlan } from '@vzn/vx'
import { lock, planRun } from '../../vx/tests/helpers/orchestrator.js'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({ tasks: { build: { outputs: ['dist/**'] } } })
const TIMEOUT = 30_000

const rootManifest = (extra: object) =>
  writeFile(
    path.join(ws.root, 'package.json'),
    JSON.stringify({ name: 'ws', private: true, ...extra }, null, 2),
  )
const key = async () => {
  const plan = await planRun({ cwd: ws.root, tasks: ['build'], log: silent() })
  return plan.tasks.find((t) => t.node.id === 'lib#build')!.hash
}

describe('turbo(): the root package.json engines', () => {
  it(
    'an engines edit re-keys every task; another root edit, or a reformat, does not',
    async () => {
      await rootManifest({ engines: { node: '>=18' } })
      const first = await key()
      await rootManifest({ engines: { node: '>=22' } })
      const raised = await key()
      await rootManifest({ engines: { node: '>=22' }, description: 'x' })
      const other = await key()
      await writeFile(
        path.join(ws.root, 'package.json'),
        '{"name":"ws","private":true,"engines":{ "node" : ">=22" },"description":"x"}',
      )
      expect({
        raised: raised !== first,
        other: other === raised,
        reformat: (await key()) === raised,
      }).toEqual({ raised: true, other: true, reformat: true })
    },
    TIMEOUT,
  )

  // The README's rule: what turbo() runs is what a migration would write,
  // minus the file. The configs are written after a lock, so the first plan
  // still maps turbo.json live over the same files; the second locks them.
  it(
    'the written config keys a task as turbo() does, engines and all',
    async () => {
      await rootManifest({ engines: { node: '>=18', pnpm: '9' } })
      await mkdir(path.join(ws.root, 'node_modules', '@vzn'), { recursive: true })
      await symlink(
        path.resolve(import.meta.dir, '..', '..', 'vx'),
        path.join(ws.root, 'node_modules', '@vzn', 'vx'),
        'dir',
      )
      await lock(ws.root)
      const migrated = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.resolve(import.meta.dir, '..', 'src', 'bin.ts'),
          '--no-install',
        ],
        cwd: ws.root,
      })
      expect(migrated.exitCode).toBe(0)
      const keyOf = async (plan: Awaited<ReturnType<typeof livePlan>>) =>
        plan.tasks.find((t) => t.node.id === 'lib#build')!.hash
      const live = await keyOf(await livePlan({ cwd: ws.root, tasks: ['build'], log: silent() }))
      const written = await key()
      await rootManifest({ engines: { node: '>=22', pnpm: '9' } })
      expect({
        same: written === live,
        preset: (await Bun.file(path.join(ws.root, 'vx-preset.ts')).text()).includes(
          'export const rootEngines = ',
        ),
        moved: (await key()) !== written,
      }).toEqual({ same: true, preset: true, moved: true })
    },
    TIMEOUT,
  )
})
