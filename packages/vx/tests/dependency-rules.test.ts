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
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { TIMEOUT } from './helpers/orchestrator-fixture.js'
import { edgesSource } from './helpers/plugin.js'

const meta = (name: string, deps: string[] = []): ProjectMeta => ({
  name,
  dir: `/ws/${name}`,
  configPath: null,
  deps,
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
      validateWorkspace({ run: { rules: { dependencies } } } as never, '.vx/workspace.ts')
      return null
    } catch (err) {
      return (err as Error).message
    }
  }
  it('takes rules and refuses a malformed one', () => {
    expect(refusal([{ from: 'tag:app', allow: ['tag:lib'], deny: ['x'] }])).toBeNull()
    expect(refusal({ from: 'a' })).toContain('must be an array of { from, allow?, deny? }')
    expect(refusal([{ from: 'a' }])).toBe(
      '.vx/workspace.ts: `run.rules.dependencies`[0] names neither `allow` nor `deny`',
    )
    expect(refusal([{ from: '', deny: ['b'] }])).toBe(
      ".vx/workspace.ts: `run.rules.dependencies`[0].from must be a selector like 'tag:app'",
    )
    expect(refusal([{ from: 'a', deny: 'b' }])).toBe(
      ".vx/workspace.ts: `run.rules.dependencies`[0].deny must be an array of selectors like 'tag:lib'",
    )
    expect(refusal([{ from: 'a', deny: ['b'], only: [] }])).toContain('unknown field')
  })

  // Each loaded, matched no project, and so a deny passed every edge.
  it.each([
    ['./apps/*', 'reads as a directory'],
    ['{apps/web}', 'reads as a directory'],
    ['!tag:shared', "starts with '!'"],
    ['web...', "'...'"],
    ['...web', "'...'"],
    ['web[main]', 'git range'],
    [' tag:app', 'surrounding whitespace'],
    ['tag: app', 'surrounding whitespace'],
    ['...', "'...'"],
  ])('refuses the selector %p, which no project can match', (sel, why) => {
    for (const rule of [
      { from: 'tag:lib', deny: [sel] },
      { from: 'tag:lib', allow: ['tag:lib', sel] },
      { from: sel, deny: ['tag:lib'] },
    ]) {
      const msg = refusal([rule])
      expect(msg).toStartWith('.vx/workspace.ts: `run.rules.dependencies`[0].')
      expect(msg).toContain(JSON.stringify(sel))
      expect(msg).toContain(why)
      expect(msg).toContain("a selector is 'tag:<tag>' or a project name")
    }
  })

  it('names the field, the selector and the forms it takes', () => {
    expect(refusal([{ from: 'tag:lib', deny: ['tag:lib', './apps/*'] }])).toBe(
      '.vx/workspace.ts: `run.rules.dependencies`[0].deny[1] "./apps/*" reads as a directory to a filter; ' +
        "a selector is 'tag:<tag>' or a project name, either may hold '*' (like 'tag:app' or '@acme/*')",
    )
  })

  it('takes a name or tag glob, the root project and a scoped name', () => {
    expect(
      refusal([{ from: '//', allow: ['@acme/*', 'tag:scope:*', 'apps/web', '*'], deny: ['x'] }]),
    ).toBeNull()
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
      await Bun.write(
        path.join(root, '.vx/workspace.mjs'),
        localWorkspaceSource(
          [edgesSource({ lib: ['app'] })],
          '',
          `{ dependencies: [{ from: 'tag:lib', deny: ['tag:app'] }] }`,
        ),
      )
      for (const [name, tag] of [
        ['app', 'app'],
        ['lib', 'lib'],
      ] as const) {
        const dir = path.join(root, 'packages', name)
        await mkdir(dir, { recursive: true })
        await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
        await writeFile(
          path.join(dir, 'vx.config.mjs'),
          `export default { tags: ['${tag}'], tasks: { t: { exec: { command: 'true' } } } }\n`,
        )
      }
      Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
      const r = Bun.spawnSync({
        cmd: [process.execPath, path.resolve(import.meta.dir, '..', 'src', 'bin.ts'), 'lock'],
        cwd: root,
        env: { ...process.env, CI: '', VX_LOCK_REVIEW_FILES: 'false' },
        stderr: 'pipe',
      })
      expect({
        code: r.exitCode,
        err: r.stderr.toString().split('\n'),
        written: existsSync(path.join(root, '.vx/projects.lock.json')),
      }).toEqual({
        code: 1,
        err: [
          '✗ vx lock  lock not written',
          '',
          '  1 dependency breaks run.rules.dependencies',
          "  lib depends on app, which run.rules.dependencies[0] (from 'tag:lib') denies",
          '',
          "  fix  drop the dependency, or change the project's tags or the rule",
          '',
        ],
        written: false,
      })
    },
    TIMEOUT,
  )
})
