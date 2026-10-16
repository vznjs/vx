// nx() maps `@nx/enforce-module-boundaries` `depConstraints` into core's
// lock-time `run.rules.dependencies`, reading the ESLint config, never
// running it.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { WorkspaceConfig } from '@vzn/vx'
import { nx } from '../src/nx/index.js'
import { nxDependencyRules } from '../src/nx/nx-boundaries.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-boundaries-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// What `create-nx-workspace` writes (Nx 20+), with the scope and type
// constraints nx-examples declares in place of its `*` default.
const FLAT = `import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  { ignores: ['**/dist'] },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\\\.base)?\\\\.config\\\\.[cm]?js$'],
          depConstraints: [
            // apps sit on top
            { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['type:feature', 'type:ui', 'type:util'] },
            { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ["scope:shared"], },
            { sourceTag: 'scope:cart', notDependOnLibsWithTags: ['scope:products'] },
            { sourceTag: '*', onlyDependOnLibsWithTags: ['*'] },
            { allSourceTags: ['a', 'b'], onlyDependOnLibsWithTags: ['c'] },
            { sourceTag: '/^x/', onlyDependOnLibsWithTags: ['c'] },
            { sourceTag: 'type:ui', bannedExternalImports: ['lodash'] },
          ],
        },
      ],
    },
  },
];
`

const MAPPED = [
  { from: 'tag:type:app', allow: ['tag:type:feature', 'tag:type:ui', 'tag:type:util'] },
  { from: 'tag:scope:shared', allow: ['tag:scope:shared'] },
  { from: 'tag:scope:cart', deny: ['tag:scope:products'] },
  { from: '*', allow: ['*'] },
]

describe('nxDependencyRules', () => {
  it('reads a flat config’s literal constraints, leaving out what vx cannot say', async () => {
    await writeFile(path.join(root, 'eslint.config.mjs'), FLAT)
    expect(await nxDependencyRules(root)).toEqual(MAPPED)
  })

  it('reads a legacy .eslintrc.json, its overrides included', async () => {
    await writeFile(
      path.join(root, '.eslintrc.json'),
      `{
        // comments are allowed
        "overrides": [{
          "files": ["*.ts"],
          "rules": { "@nrwl/nx/enforce-module-boundaries": ["error", {
            "depConstraints": [{ "sourceTag": "type:app", "notDependOnLibsWithTags": ["type:app"] }]
          }] }
        }]
      }`,
    )
    expect(await nxDependencyRules(root)).toEqual([
      { from: 'tag:type:app', deny: ['tag:type:app'] },
    ])
  })

  it('maps nothing from constraints that are not a literal, or with no rule', async () => {
    await writeFile(
      path.join(root, 'eslint.config.mjs'),
      `const c = []; export default [{ rules: { '@nx/enforce-module-boundaries': ['error', { depConstraints: [...c] }] } }]`,
    )
    expect(await nxDependencyRules(root)).toBeUndefined()
    await writeFile(path.join(root, 'eslint.config.mjs'), `export default []`)
    expect(await nxDependencyRules(root)).toBeUndefined()
  })
})

describe('nx() config stage', () => {
  const stage = async (workspace: WorkspaceConfig) => {
    const plugin = nx() as unknown as {
      config(w: WorkspaceConfig, ctx: { workspaceRoot: string }): Promise<void>
    }
    await plugin.config(workspace, { workspaceRoot: root })
    return workspace.run?.rules
  }

  it('fills run.rules.dependencies when the workspace sets none, and keeps its own', async () => {
    await writeFile(path.join(root, 'eslint.config.mjs'), FLAT)
    expect(await stage({ run: { rules: { exclusiveOutputs: false } } })).toEqual({
      exclusiveOutputs: false,
      dependencies: MAPPED,
    })
    const own = [{ from: 'a', deny: ['b'] }]
    expect(await stage({ run: { rules: { dependencies: own } } })).toEqual({ dependencies: own })
  })
})
