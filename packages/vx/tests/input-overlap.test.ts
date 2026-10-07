// `rules.upfrontKeys` (X-54): a task whose input globs can match another
// task's declared outputs is refused at graph build, unless the workspace
// turns the rule off. Such a key reads bytes a producer writes this run, so
// it cannot be derived until the producer ran; refused, every key is known
// before anything runs. Proven overlaps only, as for outputs.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildTaskGraph } from '../src/graph/index.js'
import type { PackageGraph, ProjectEntry } from '../src/workspace/index.js'
import type { ProjectConfig, TaskConfig, WorkspaceRules } from '../src/config.js'
import { planRun, run, type Logger } from '../src/orchestrator/index.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const silent = new Proxy({}, { get: () => () => undefined }) as Logger

function task(inputs: string[], outputs: string[], extra: Partial<TaskConfig> = {}): TaskConfig {
  return {
    exec: { command: 'x' },
    cache: { inputs: { files: inputs }, outputs: { files: outputs } },
    ...extra,
  }
}

function wsTask(inputs: string[], outputs: string[]): TaskConfig {
  return {
    exec: { command: 'x' },
    cache: {
      inputs: { files: [], workspaceFiles: inputs },
      outputs: { files: [], workspaceFiles: outputs },
    },
  }
}

/** The refusal a graph meets, or null; every task requested. */
function refusal(
  projects: Record<string, Record<string, TaskConfig>>,
  rules?: WorkspaceRules,
): string | null {
  const entries = new Map<string, ProjectEntry>()
  for (const [name, tasks] of Object.entries(projects)) {
    entries.set(name, {
      name,
      dir: `/w/${name}`,
      configPath: `/w/${name}/vx.config.ts`,
      config: { tasks } as ProjectConfig,
    } as ProjectEntry)
  }
  try {
    buildTaskGraph({
      projects: entries,
      packageGraph: { directDeps: () => [], transitiveDeps: () => [] } as unknown as PackageGraph,
      requested: [...entries.values()].flatMap((e) =>
        Object.keys(e.config.tasks ?? {}).map((t) => ({ project: e.name, task: t })),
      ),
      workspaceRoot: '/w',
      rules,
    })
    return null
  } catch (e) {
    return (e as Error).message
  }
}

const app = (tasks: Record<string, TaskConfig>) => ({ app: tasks })
const build = task(['src/**'], ['dist/**'])

describe('rules.upfrontKeys refuses inputs that read another task’s outputs', () => {
  it('names the reader, the glob, the producer and both ways out', () => {
    expect(refusal(app({ build, test: task(['**'], ['coverage/**']) }))).toBe(
      'app#test reads "**" in cache.inputs.files, which matches app#build\'s output "dist/**" — ' +
        "a task's key must not read another task's outputs (the dependency's key already " +
        'cascades through dependsOn). Exclude it: add "!dist/**" to app#test\'s ' +
        'cache.inputs.files, or set rules: { upfrontKeys: false } in vx.workspace.ts to let ' +
        'it wait for its producer.',
    )
  })

  const refused: Array<[string, string[], string[]]> = [
    ['a literal input that is the output', ['dist/app.js'], ['dist/app.js']],
    ['a glob input over a literal output', ['dist/*.js'], ['dist/app.js']],
    ['a glob over a glob', ['**/*.js'], ['dist/**']],
    ['`**` over a subtree', ['**'], ['dist/**']],
    ['a literal directory output', ['**/*'], ['dist']],
    ['an input under the output', ['dist/types/**'], ['dist']],
  ]
  for (const [what, inputs, outputs] of refused) {
    it(`refuses ${what}: ${inputs.join()} against ${outputs.join()}`, () => {
      const graph = app({ build: task(['src/**'], outputs), test: task(inputs, ['out/**']) })
      expect(refusal(graph)).toMatch(/^app#test reads .* rules: \{ upfrontKeys: false \}/)
      expect(refusal(graph, { upfrontKeys: true })).toMatch(/^app#test reads /)
      // The way out it names: the rule off.
      expect(refusal(graph, { upfrontKeys: false })).toBeNull()
    })
  }

  it('refuses with or without an edge, whichever is declared first', () => {
    const test = task(['**'], [], { dependsOn: ['build'] })
    expect(refusal(app({ test, build }))).toMatch(/^app#test reads "\*\*"/)
    expect(refusal(app({ build, test: task(['**'], []) }))).toMatch(/^app#test reads "\*\*"/)
  })

  it('refuses a workspaceFiles input over a root-anchored output', () => {
    expect(
      refusal({ a: { gen: wsTask([], ['gen/**']) }, b: { use: wsTask(['gen/api.ts'], []) } }),
    ).toMatch(/^b#use reads "gen\/api\.ts" in cache\.inputs\.workspaceFiles, which matches a#gen's/)
  })

  it("refuses a workspaceFiles input over another project's files output, said in its terms", () => {
    expect(refusal({ a: { build }, b: { use: wsTask(['a/dist/index.js'], []) } })).toMatch(
      /^b#use reads "a\/dist\/index\.js" in cache\.inputs\.workspaceFiles, which matches a#build's output "dist\/\*\*" .* add "!a\/dist\/\*\*" to b#use's cache\.inputs\.workspaceFiles/,
    )
  })
})

describe('rules.upfrontKeys passes what reads no other task’s outputs', () => {
  it('an input set whose `!` entry takes the output back', () => {
    expect(refusal(app({ build, test: task(['**', '!dist/**'], []) }))).toBeNull()
    expect(
      refusal(app({ build: task(['src/**'], ['dist']), test: task(['**', '!dist'], []) })),
    ).toBeNull()
    expect(
      refusal(app({ build: task(['src/**'], ['dist/a.js']), test: task(['**', '!dist/**'], []) })),
    ).toBeNull()
  })

  it('CONTROL: a `!` entry that takes back only part of the output does not', () => {
    expect(refusal(app({ build, test: task(['**', '!dist/sub/**'], []) }))).toMatch(
      /^app#test reads "\*\*"/,
    )
  })

  it("a task's own outputs, already out of its key", () => {
    expect(refusal(app({ build: task(['**'], ['dist/**']) }))).toBeNull()
  })

  it('disjoint trees, and a task with no outputs to read', () => {
    expect(refusal(app({ build, test: task(['src/**', 'test/**'], ['coverage/**']) }))).toBeNull()
    expect(
      refusal(app({ build, ci: { dependsOn: ['build'] } as TaskConfig, lint: task(['**'], []) })),
    ).toMatch(/^app#lint reads/)
    expect(
      refusal(app({ ci: { dependsOn: ['lint'] } as TaskConfig, lint: task(['**'], []) })),
    ).toBeNull()
  })

  it("another project's files output: `files` inputs never leave the project", () => {
    expect(refusal({ a: { build }, b: { test: task(['**'], []) } })).toBeNull()
  })

  it('an uncached task and a keyed group read nothing the rule checks', () => {
    const group = {
      dependsOn: ['^build'],
      cache: { inputs: { files: ['**'] }, outputs: { files: [] } },
    } as unknown as TaskConfig
    expect(refusal(app({ build, dev: { exec: { command: 'dev' } }, bundle: group }))).toBeNull()
  })
})

describe('rules.upfrontKeys end to end', () => {
  const config = `export default { tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cp src/a.txt dist/a.txt' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'cat dist/a.txt > out.txt' },
      cache: { inputs: { files: ['**'] }, outputs: { files: ['out.txt'] } },
    },
  } }`

  it('a run refuses the reader before any task runs; off, it runs as before', async () => {
    const root = await makeWorkspace({ prefix: 'vx-upfront-' })
    try {
      const dir = await addProject(root, 'app', { files: { 'src/a.txt': 'A1' }, config })
      await expect(run({ cwd: root, tasks: ['test'], log: silent })).rejects.toThrow(
        /app#test reads "\*\*" in cache\.inputs\.files, which matches app#build's output/,
      )
      expect(await Bun.file(path.join(dir, 'out.txt')).exists()).toBe(false)
      await writeFile(
        path.join(root, 'vx.workspace.mjs'),
        'export default { rules: { upfrontKeys: false } }\n',
      )
      const r = await run({ cwd: root, tasks: ['test'], log: silent })
      expect(r.outcomes.map((o) => `${o.node.id} ${o.status}`).sort()).toEqual([
        'app#build success',
        'app#test success',
      ])
      expect(await Bun.file(path.join(dir, 'out.txt')).text()).toBe('A1')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("the default build a config's project gets reads `**` beside its tasks' outputs and loads", async () => {
    const root = await makeWorkspace({ prefix: 'vx-upfront-default-' })
    try {
      await addProject(root, 'lib', {
        config: `export default { tasks: { test: {
          exec: { command: 'true' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['coverage/**'] } },
        } } }`,
      })
      await addProject(root, 'app', {
        deps: { lib: '*' },
        config: `export default { tasks: { build: {
          dependsOn: ['^build'],
          exec: { command: 'true' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
        } } }`,
      })
      const plan = await planRun({ cwd: root, tasks: ['app#build', 'lib#test'], log: silent })
      expect(plan.tasks.map((t) => t.node.id).sort()).toEqual([
        'app#build',
        'lib#build',
        'lib#test',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('an invalid rule is refused at load', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-upfront-bad-'))
    try {
      await writeFile(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeFile(
        path.join(root, 'vx.workspace.mjs'),
        "export default { rules: { upfrontKeys: 'yes' } }\n",
      )
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent })).rejects.toThrow(
        /`rules`\.upfrontKeys must be true or false/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('rules.upfrontKeys stays near-linear', () => {
  it('4,000 readers and writers in ONE project', () => {
    // All pairs over 8,000 sides is 32 million glob comparisons; the path
    // index pairs only the sides that can meet, as for outputs (item 746).
    const TASKS = 4_000
    const tasks: Record<string, TaskConfig> = {}
    for (let t = 0; t < TASKS; t++) {
      tasks[`t${t}`] = task([`src/t${t}/**`, `cfg/t${t}.json`], [`dist/t${t}.js`, `out/t${t}/**`])
    }
    let best = Infinity
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now()
      expect(refusal({ app: tasks })).toBeNull()
      best = Math.min(best, performance.now() - t0)
    }
    expect(best).toBeLessThan(250)
  }, 120_000)
})
