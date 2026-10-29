// Turbo 2.11.6 selects tasks by tags: `turbo run build --filter=tag:ci`
// runs every requested task of a package whose own turbo.json says
// `"tags": ["ci"]` (vercel/turborepo#14342, #14345). turbo() read the key
// as a label with no behaviour, so the same filter under vx matched no
// project and the CI step failed. A package's tags are its vx project
// tags; a task's `tags` have no vx home (vx tags are a project's).
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { planned, vx } from '../../vx/tests/helpers/parity.js'
import { migrateTurbo } from '../src/migrate-turbo.js'
import type { PackageMeta } from '../src/packages.js'
import { useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({
  tags: ['root-only'],
  tasks: { build: { dependsOn: ['^build'], tags: ['slow'] } },
})

it("`--filter tag:` selects by a package's own turbo.json tags", async () => {
  await writeFile(
    path.join(ws.root, 'packages', 'app', 'turbo.json'),
    JSON.stringify({ extends: ['//'], tags: ['ci', 'ci', ' '] }),
  )
  const args = (tag: string) => ['build', '--filter', `tag:${tag}`, '--exclude-dependencies']
  expect(await planned(ws.root, args('ci'))).toEqual(['app#build'])
  // A task's tags and the root's label no package of these.
  for (const tag of ['slow', 'root-only']) {
    const r = await vx(ws.root, ['run', ...args(tag), '--dry=json'])
    expect([tag, r.code, r.err]).toEqual([tag, 1, expect.stringContaining(`tag:${tag}`)])
  }
}, 30_000)

it('`bunx @vzn/vx-migrate` writes them as the project tags', async () => {
  await writeFile(
    path.join(ws.root, 'packages', 'app', 'turbo.json'),
    JSON.stringify({ extends: ['//'], tags: ['ci'] }),
  )
  const metas = ['lib', 'app'].map((name) => ({
    name,
    dir: path.join(ws.root, 'packages', name),
    packageJson: { name, scripts: { build: 'echo' } } as never,
    configPath: null,
  })) satisfies PackageMeta[]
  const plan = await migrateTurbo(ws.root, metas)
  expect(plan.projects.map((p) => [p.name, p.tags])).toEqual([
    ['lib', undefined],
    ['app', ['ci']],
  ])
}, 30_000)
