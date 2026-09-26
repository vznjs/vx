// Item 812's sweep of nx-inputs, nx-outputs and nx-deps: pure functions,
// held here by their exact outputs. Each row fails with one line undone.
import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { emptyNxInputs, expandNxInputs } from '../src/nx/nx-inputs.js'
import { mapNxOutputs } from '../src/nx/nx-outputs.js'
import { mapNxDeps } from '../src/nx/nx-deps.js'

function inputs(entries: unknown[], named: Record<string, unknown[]> = {}) {
  const into = emptyNxInputs()
  const todos: string[] = []
  expandNxInputs(entries, named, into, todos)
  return { ...into, todos }
}

describe('expandNxInputs', () => {
  it('a negated {workspaceRoot} glob stays negated', () => {
    expect(inputs(['!{workspaceRoot}/secret.json']).wsFiles).toEqual(['!secret.json'])
  })

  it('an unsupported token is reported, not read as a named input', () => {
    expect(inputs(['{options.src}/**']).todos).toEqual([
      'input "{options.src}/**" uses a token vx does not support',
    ])
  })

  it('a named input that names itself terminates', () => {
    const got = inputs(['prod'], { prod: ['prod', '{projectRoot}/src/**'] })
    expect([got.files, got.todos]).toEqual([['src/**'], []])
  })

  it('fileset, input and each fold-through object form', () => {
    const got = inputs(
      [
        { fileset: '{projectRoot}/lib/**' },
        { input: 'prod' },
        { input: 'prod', dependencies: true },
        { input: 'prod', projects: ['x', 'y'] },
        { input: 'prod', projects: 'z' },
        '^prod',
        '!^prod',
        { externalDependencies: ['react'] },
        { dependentTasksOutputFiles: '**/*.d.ts' },
      ],
      { prod: ['{projectRoot}/src/**'] },
    )
    expect(got.files).toEqual(['lib/**', 'src/**'])
    expect(got.upstream).toEqual([
      { name: 'prod', of: 'deps' },
      { name: 'prod', of: ['x', 'y'] },
      { name: 'prod', of: ['z'] },
      { name: 'prod', of: 'deps' },
    ])
    expect(got.todos).toEqual([
      'input "!^prod": a negated dependency input — map manually',
      'input {externalDependencies: ["react"]}: vx hashes the project\'s package.json into every key — usually safe to drop',
      "input {dependentTasksOutputFiles: …}: vx already folds each dependency's cache key (its inputs, never its outputs) through dependsOn — a change upstream is a key change here",
    ])
  })
})

describe('mapNxOutputs', () => {
  const out = (
    outputs: string[],
    projectRel = 'packages/a',
    options: Record<string, unknown> = {},
  ) => {
    const todos: string[] = []
    return { ...mapNxOutputs(outputs, options, projectRel, todos), todos }
  }

  it('a glob is kept as written; a bare directory, root-relative or not, captures its tree', () => {
    expect(out(['{projectRoot}/dist/*/types', '{workspaceRoot}/coverage'])).toEqual({
      outFiles: ['dist/*/types'],
      wsOutFiles: ['coverage/**'],
      todos: [],
    })
  })

  it('the root project’s plain path is its own output; another’s is normalized at the root', () => {
    expect(out(['dist'], '.').outFiles).toEqual(['dist/**'])
    expect(out(['./build/../out'], 'packages/a').wsOutFiles).toEqual(['out/**'])
  })

  it('a non-string option and an unknown token are reported', () => {
    expect(out(['{options.outDir}', '{foo}/x'], 'packages/a', { outDir: 42 }).todos).toEqual([
      'output "{options.outDir}": option "outDir" is not a literal string — resolve manually',
      'output "{foo}/x" uses a token vx does not support',
    ])
  })
})

describe('mapNxDeps', () => {
  const ui: ProjectMeta = {
    name: '@acme/ui',
    dir: '/w/ui',
    packageJson: { name: '@acme/ui' } as never,
    configPath: null,
  }
  const byNode = new Map([['ui', ui]])
  const deps = (entries: unknown[]) => {
    const todos: string[] = []
    return { deps: mapNxDeps(entries, byNode, () => null, todos), todos }
  }

  it('a colon at the start is no project separator; an empty target after one is dropped', () => {
    expect(deps([':x', 'ui:'])).toEqual({
      deps: [':x'],
      todos: [
        'dependsOn "ui:" names "ui", which is not a workspace package in this graph — edge dropped',
      ],
    })
  })

  it('object forms: self, a named project by its package name, and the ones vx cannot take', () => {
    expect(
      deps([
        { target: 'build', projects: 'self' },
        { target: 'build', projects: ['ui'] },
        { target: 'build', projects: 7 },
        { projects: 'self' },
      ]),
    ).toEqual({
      deps: ['build', '@acme/ui#build'],
      todos: [
        'dependsOn {"target":"build","projects":7} not representable in vx',
        'dependsOn {"projects":"self"} has no target — dropped',
      ],
    })
  })
})
