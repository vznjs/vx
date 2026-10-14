// `run.rules.dependencies`: which projects a project may depend on, checked
// by `vx lock` over each project's direct workspace dependencies.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import type { DependencyRule } from '../src/config.js'
import {
  buildPackageGraph,
  checkDependencyRules,
  type ProjectMeta,
} from '../src/workspace/index.js'
import { validateWorkspace } from '../src/workspace/config-schema.js'
import { TIMEOUT } from './helpers/orchestrator-fixture.js'

const meta = (name: string, deps: string[] = []): ProjectMeta => ({
  name,
  dir: `/ws/${name}`,
  configPath: null,
  packageJson: {
    name,
    dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])),
  },
})

// app → lib, app → ui, lib → util, tool → app; util carries no tag.
const metas = [
  meta('app', ['lib', 'ui']),
  meta('lib', ['util']),
  meta('ui'),
  meta('util'),
  meta('tool', ['app']),
]
const tags = new Map<string, readonly string[]>([
  ['app', ['type:app']],
  ['lib', ['type:lib', 'scope:shared']],
  ['ui', ['type:ui']],
  ['tool', ['type:tool']],
])
const graph = buildPackageGraph(metas)
const names = metas.map((m) => m.name)

/** The broken edges' first lines, or [] when the rules hold. */
function broken(rules: DependencyRule[]): string[] {
  try {
    checkDependencyRules(rules, names, tags, graph)
    return []
  } catch (err) {
    const e = err as { code: string; message: string }
    expect(e.code).toBe('VX_E_DEPENDENCY_RULE')
    const lines = e.message.split('\n')
    expect(lines[0]).toMatch(/^\d+ dependenc(y breaks|ies break) run\.rules\.dependencies:$/)
    return lines.slice(1, -1).map((l) => l.replace(/^  /, ''))
  }
}

describe('checkDependencyRules', () => {
  it('an allowed edge passes and an edge outside allow is named', () => {
    expect(broken([{ from: 'tag:type:app', allow: ['tag:type:*'] }])).toEqual([])
    expect(broken([{ from: 'tag:type:app', allow: ['tag:type:lib'] }])).toEqual([
      "app depends on ui, which run.rules.dependencies[0] (from 'tag:type:app') does not allow",
    ])
  })

  it('deny beats allow, across rules too', () => {
    expect(
      broken([
        { from: 'tag:type:app', allow: ['tag:type:*'], deny: ['tag:type:ui'] },
        { from: 'app', deny: ['lib'] },
      ]),
    ).toEqual([
      "app depends on ui, which run.rules.dependencies[0] (from 'tag:type:app') denies",
      "app depends on lib, which run.rules.dependencies[1] (from 'app') denies",
    ])
  })

  it('a project no rule selects is free; an untagged dependency matches no tag', () => {
    expect(broken([{ from: 'tag:type:ui', deny: ['*'] }])).toEqual([])
    expect(broken([{ from: 'tag:scope:shared', allow: ['tag:*'] }])).toEqual([
      "lib depends on util, which run.rules.dependencies[0] (from 'tag:scope:shared') does not allow",
    ])
  })

  it('a name glob selects by project name', () => {
    expect(broken([{ from: '*', deny: ['app'] }])).toEqual([
      "tool depends on app, which run.rules.dependencies[0] (from '*') denies",
    ])
  })
})

describe('the schema', () => {
  const refusal = (dependencies: unknown) => {
    try {
      validateWorkspace({ run: { rules: { dependencies } } } as never, 'vx.workspace.ts')
      return null
    } catch (err) {
      return (err as Error).message
    }
  }
  it('takes rules and refuses a malformed one', () => {
    expect(refusal([{ from: 'tag:app', allow: ['tag:lib'], deny: ['x'] }])).toBeNull()
    expect(refusal({ from: 'a' })).toContain('must be an array of { from, allow?, deny? }')
    expect(refusal([{ from: 'a' }])).toBe(
      'vx.workspace.ts: `run.rules.dependencies`[0] names neither `allow` nor `deny`',
    )
    expect(refusal([{ from: '', deny: ['b'] }])).toBe(
      "vx.workspace.ts: `run.rules.dependencies`[0].from must be a selector like 'tag:app'",
    )
    expect(refusal([{ from: 'a', deny: 'b' }])).toBe(
      "vx.workspace.ts: `run.rules.dependencies`[0].deny must be an array of selectors like 'tag:lib'",
    )
    expect(refusal([{ from: 'a', deny: ['b'], only: [] }])).toContain('unknown field')
  })
})

describe('vx lock', () => {
  const roots: string[] = []
  afterAll(async () => {
    for (const r of roots) await rm(r, { recursive: true, force: true })
  })

  it(
    'refuses a dependency a rule denies and writes no lock',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'vx-dep-rules-'))
      roots.push(root)
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
      )
      await writeFile(
        path.join(root, 'vx.workspace.mjs'),
        `export default { run: { rules: { dependencies: [{ from: 'tag:lib', deny: ['tag:app'] }] } } }\n`,
      )
      for (const [name, tag, deps] of [
        ['app', 'app', {}],
        ['lib', 'lib', { app: 'workspace:*' }],
      ] as const) {
        const dir = path.join(root, 'packages', name)
        await mkdir(dir, { recursive: true })
        await writeFile(
          path.join(dir, 'package.json'),
          JSON.stringify({ name, dependencies: deps }),
        )
        await writeFile(
          path.join(dir, 'vx.config.mjs'),
          `export default { tags: ['${tag}'], tasks: { t: { exec: { command: 'true' } } } }\n`,
        )
      }
      Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
      const r = Bun.spawnSync({
        cmd: [process.execPath, path.resolve(import.meta.dir, '..', 'src', 'bin.ts'), 'lock'],
        cwd: root,
        env: { ...process.env, CI: '', VX_RUN_FROZEN: '' },
        stderr: 'pipe',
      })
      expect({
        code: r.exitCode,
        err: r.stderr.toString().split('\n').slice(0, 2),
        written: existsSync(path.join(root, 'vx-lock.json')),
      }).toEqual({
        code: 1,
        err: [
          'vx lock: vx-lock.json not written: 1 dependency breaks run.rules.dependencies:',
          "  lib depends on app, which run.rules.dependencies[0] (from 'tag:lib') denies",
        ],
        written: false,
      })
    },
    TIMEOUT,
  )
})
