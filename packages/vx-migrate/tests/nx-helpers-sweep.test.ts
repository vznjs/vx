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
  expandNxInputs(entries, named, { rel: 'packages/a', name: 'a' }, into, todos)
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
    return { ...mapNxOutputs(outputs, options, projectRel, 'a', todos), todos }
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

// Item 912: Nx interpolates `{workspaceRoot}`, `{projectRoot}` and
// `{projectName}` anywhere in a path. Only a leading token was read, so
// `@nx/jest`'s `{workspaceRoot}/coverage/{projectRoot}` output became the
// literal glob `coverage/{projectRoot}/**` and a hit restored nothing.
describe('a token anywhere in a path interpolates as Nx does', () => {
  it('outputs: after the root, in the name, and one that lands in the project', () => {
    const todos: string[] = []
    const got = mapNxOutputs(
      [
        '{workspaceRoot}/coverage/{projectRoot}',
        '{workspaceRoot}/dist/{projectName}',
        '{workspaceRoot}/packages/a/build',
        'dist/{options.a}/{options.b}',
        '{workspaceRoot}/../escape',
      ],
      { a: 'x', b: 'y' },
      'packages/a',
      'a',
      todos,
    )
    expect(got).toEqual({
      outFiles: ['build/**'],
      wsOutFiles: ['coverage/packages/a/**', 'dist/a/**', 'dist/x/y/**'],
    })
    expect(todos).toEqual(['output "{workspaceRoot}/../escape" uses a token vx does not support'])
  })

  it('outputs of the root project', () => {
    const got = mapNxOutputs(['{workspaceRoot}/coverage/{projectRoot}x'], {}, '.', 'r', [])
    expect(got).toEqual({ outFiles: ['coverage/x/**'], wsOutFiles: [] })
  })

  it('inputs: in and out of the project, negated too', () => {
    const got = inputs([
      '{workspaceRoot}/coverage/{projectRoot}/**',
      '{projectRoot}/src/{projectName}.ts',
      '!{workspaceRoot}/cfg/{projectName}.json',
    ])
    expect([got.files, got.wsFiles, got.todos]).toEqual([
      ['src/a.ts'],
      ['coverage/packages/a/**', '!cfg/a.json'],
      [],
    ])
  })
})

// Item 914: vx has no character classes or extglobs, so `*.[jt]s`
// matched nothing and Nx's default `production` negation excluded
// nothing; and item 912 read a brace set as an unknown token.
describe('Nx glob grammar in inputs', () => {
  it('a brace set is a glob, not a token', () => {
    const got = inputs(['{projectRoot}/**/*.{ts,tsx}', '{workspaceRoot}/{a,b}.json'])
    expect([got.files, got.wsFiles, got.todos]).toEqual([['**/*.{ts,tsx}'], ['{a,b}.json'], []])
  })

  it('a class is a brace set, with the literal kept where only more inputs can follow', () => {
    const got = inputs(['{projectRoot}/src/**/*.[jt]s', '!{projectRoot}/**/*.[jt]sx'])
    expect([got.files, got.todos]).toEqual([['src/**/*.{[jt],j,t}s', '!**/*.{j,t}sx'], []])
  })

  it('Nx’s default production negation excludes the spec files', () => {
    const got = inputs(['!{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)'])
    expect([got.files, got.todos]).toEqual([['!**/{*.,}{spec,test}.{j,t}s{x,}'], []])
  })

  it('what has no safe form is a todo', () => {
    const got = inputs([
      '{projectRoot}/+(a|b).ts',
      '!{projectRoot}/!(a).ts',
      '{projectRoot}/[a-z].ts',
      '{projectRoot}/[!a].ts',
    ])
    expect([got.files, got.todos]).toEqual([
      [],
      [
        'input "{projectRoot}/+(a|b).ts": glob syntax vx cannot take — map manually',
        'input "!{projectRoot}/!(a).ts": glob syntax vx cannot take — map manually',
        'input "{projectRoot}/[a-z].ts": glob syntax vx cannot take — map manually',
        'input "{projectRoot}/[!a].ts": glob syntax vx cannot take — map manually',
      ],
    ])
  })
})
