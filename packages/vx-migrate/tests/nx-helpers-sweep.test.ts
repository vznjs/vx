// Item 812's sweep of nx-inputs, nx-outputs and nx-deps: pure functions,
// held here by their exact outputs. Each row fails with one line undone.
import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { emptyNxInputs, expandNxInputs } from '../src/nx/nx-inputs.js'
import { mapNxOutputs } from '../src/nx/nx-outputs.js'
import { mapNxDeps, matchNxProjects } from '../src/nx/nx-deps.js'

function inputs(entries: unknown[], named: Record<string, unknown[]> = {}) {
  const into = emptyNxInputs()
  const todos: string[] = []
  expandNxInputs(entries, named, { rel: 'packages/a', name: 'a' }, into, todos)
  return { ...into, todos }
}

describe('expandNxInputs', () => {
  // Nx 23's `includeIgnored` hashes the path from disk, which a vx glob
  // never sees. A literal is a workspace-root probe; a glob or a
  // dependency's fileset is a todo; a negated literal filters nothing.
  it('an includeIgnored fileset: a literal is probed, a glob is a todo', () => {
    const got = inputs([
      { fileset: '{projectRoot}/gen/api.json', includeIgnored: true },
      { fileset: "{workspaceRoot}/it's.env", includeIgnored: true },
      { fileset: '!{projectRoot}/gen/old.json', includeIgnored: true },
      { fileset: '{projectRoot}/gen/**', includeIgnored: true },
      { fileset: '{projectRoot}/gen/x', includeIgnored: true, dependencies: true },
    ])
    const todo = (e: unknown) =>
      `input ${JSON.stringify(e)}: vx keys only the files git lists, so a gitignored match is ` +
      'not in the key — read it with a cache.inputs.workspaceRuntime probe'
    expect([got.files, got.wsFiles, got.runtimeCmds, got.todos]).toEqual([
      [],
      [],
      [
        `cat -- packages/a/gen/api.json 2>/dev/null; echo "$?"`,
        `cat -- 'it'\\''s.env' 2>/dev/null; echo "$?"`,
      ],
      [
        todo({ fileset: '{projectRoot}/gen/**', includeIgnored: true }),
        todo({ fileset: '{projectRoot}/gen/x', includeIgnored: true, dependencies: true }),
      ],
    ])
  })

  it('a negated {workspaceRoot} glob stays negated', () => {
    expect(inputs(['!{workspaceRoot}/secret.json']).wsFiles).toEqual(['!secret.json'])
  })

  it('an unsupported token is reported, not read as a named input', () => {
    expect(inputs(['{options.src}/**']).todos).toEqual([
      'input "{options.src}/**" uses a token vx does not support',
    ])
  })

  // Nx reads a project fileset of negations alone as every project file but
  // those; the control keeps a positive glob's list as written.
  it('a project fileset of negations alone starts from every project file', () => {
    const named = { noMarkdown: ['!{projectRoot}/**/*.md'] }
    expect([
      inputs(['noMarkdown', '^noMarkdown'], named).files,
      inputs(['{projectRoot}/src/**', 'noMarkdown'], named).files,
      inputs(['!{workspaceRoot}/secret.json']).files,
    ]).toEqual([['**/*', '!**/*.md'], ['src/**', '!**/*.md'], []])
  })

  it('a named input that names itself terminates', () => {
    const got = inputs(['prod'], { prod: ['prod', '{projectRoot}/src/**'] })
    expect([got.files, got.todos]).toEqual([['src/**'], []])
  })

  // @nx/vitest infers `{ json: "{workspaceRoot}/tsconfig.json", fields:
  // ["compilerOptions"] }`; dropped, a compilerOptions edit was a hit.
  it('a {json} input keys its whole file', () => {
    const got = inputs([
      { json: '{workspaceRoot}/tsconfig.json', fields: ['compilerOptions'] },
      { json: '{projectRoot}/package.json' },
      { json: 'tsconfig.base.json' },
    ])
    expect([got.files, got.wsFiles, got.todos]).toEqual([
      ['package.json'],
      ['tsconfig.json', 'tsconfig.base.json'],
      [],
    ])
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
      'input {externalDependencies: ["react"]}: vx keys every task on the lockfile (the whole file, or with a @vzn/vx-lockfile plugin the project\'s and the root\'s dependencies) — safe to drop unless only another project installs one',
      // `dependentTasksOutputFiles` is nothing to map: vx folds the upstream keys (G-49).
    ])
  })

  // Nx's `splitInputsIntoSelfAndDependencies` (nx 23.3) still reads the
  // pre-17 `projects: "dependencies"` as `^input` and `"self"` as the own input.
  it('the legacy projects: "dependencies" and "self" spellings', () => {
    const got = inputs(
      [
        { input: 'prod', projects: 'dependencies' },
        { input: 'lib', projects: 'self' },
      ],
      { prod: ['{projectRoot}/src/**'], lib: ['{projectRoot}/lib/**'] },
    )
    expect([got.files, got.upstream, got.todos]).toEqual([
      ['lib/**'],
      [{ name: 'prod', of: 'deps' }],
      [],
    ])
  })
})

// analogjs's 32 `eslint:lint` tasks each carried the todo for `eslint`, a
// root devDependency every task's key already holds.
describe('externalDependencies the root declares', () => {
  const run = (names: string[], rootDeps: string[]) => {
    const todos: string[] = []
    expandNxInputs(
      [{ externalDependencies: names }],
      {},
      { rel: 'packages/a', name: 'a', rootDeps: new Set(rootDeps) },
      emptyNxInputs(),
      todos,
    )
    return todos
  }
  it('are nothing to map; one the root lacks is still a todo', () => {
    expect([
      run(['eslint', 'vitest'], ['eslint', 'vitest', 'nx']),
      run(['eslint', 'react'], ['eslint']),
    ]).toEqual([
      [],
      [
        'input {externalDependencies: ["eslint","react"]}: vx keys every task on the lockfile (the whole file, or with a @vzn/vx-lockfile plugin the project\'s and the root\'s dependencies) — safe to drop unless only another project installs one',
      ],
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

  it('a glob and a bare path, root-relative or not, are kept as written', () => {
    // A bare path is the file or the tree under it to core (`asTrees`);
    // `<path>/**` saved nothing under a file (Next 27).
    expect(
      out(['{projectRoot}/dist/*/types', '{workspaceRoot}/coverage', '{projectRoot}/bin/tool']),
    ).toEqual({
      outFiles: ['dist/*/types', 'bin/tool'],
      wsOutFiles: ['coverage'],
      todos: [],
    })
  })

  it('the root project’s plain path is its own output; another’s is normalized at the root', () => {
    expect(out(['dist'], '.').outFiles).toEqual(['dist'])
    expect(out(['./build/../out'], 'packages/a').wsOutFiles).toEqual(['out'])
  })

  // Mapped as a `!` workspace glob, core refused the project's whole
  // config and none of its tasks ran (item 1051).
  it('a negated output takes a path back beside its positives (A-44)', () => {
    expect(
      out(['{projectRoot}/dist', '!{projectRoot}/dist/cache', '!{workspaceRoot}/dist/a/tmp']),
    ).toEqual({ outFiles: ['dist', '!dist/cache'], wsOutFiles: [], todos: [] })
    expect(out(['dist/a', '!dist/a/tmp'])).toEqual({
      outFiles: [],
      wsOutFiles: ['dist/a', '!dist/a/tmp'],
      todos: [],
    })
  })

  it('an output whose option is unset is dropped, as Nx drops it', () => {
    for (const outputFile of [undefined, '', 0, false, null]) {
      expect(
        out(['{options.outputFile}', '{projectRoot}/dist'], 'packages/a', { outputFile }),
      ).toEqual({
        outFiles: ['dist'],
        wsOutFiles: [],
        todos: [],
      })
    }
  })

  it('a non-string option and an unknown token are reported', () => {
    expect(out(['{options.outDir}', '{foo}/x'], 'packages/a', { outDir: 42 }).todos).toEqual([
      'output "{options.outDir}": option "outDir" is not a literal string — resolve manually',
      'output "{foo}/x" uses a token vx does not support',
    ])
  })

  // nx-examples' @nx/angular:application build: `{options.outputPath.base}`
  // was read as one key, no output, and a hit restored nothing. A missing
  // leaf is no output, as Nx drops it.
  it('a dotted option path walks the options', () => {
    const got = out(['{options.outputPath.base}', '{options.outputPath.server}'], 'apps/products', {
      outputPath: { base: 'dist/apps/products', browser: '' },
    })
    expect([got.outFiles, got.wsOutFiles, got.todos]).toEqual([[], ['dist/apps/products'], []])
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
    return {
      deps: mapNxDeps(
        entries,
        byNode,
        (t) => t.startsWith('test:') || ['build', 'rsbuild:typecheck', ':x'].includes(t),
        () => null,
        (p, t) => p === 'ui' && t === 'build',
        todos,
      ),
      todos,
    }
  }

  // Nx 19.5+ expands a target glob over every target name in the workspace
  // and keeps each edge the project has. Read as `project:target`,
  // TanStack/router's `test:e2e--*` named project `test` and each of 140
  // aggregators lost the modes it fans out to (2026-09-28).
  it('a target glob expands over the workspace target names, in each form', () => {
    // `test:e2e--webkit` is another project's: this one's glob skips it.
    const names = [
      'build',
      'build-esm',
      'test:e2e--chromium',
      'test:e2e--firefox',
      'test:e2e--webkit',
      'lint',
    ]
    const todos: string[] = []
    const got = mapNxDeps(
      [
        'test:e2e--*',
        'ui:build*',
        '^lint',
        '^lin[t]',
        { target: 'build-{esm,cjs}', projects: ['ui'] },
      ],
      byNode,
      (t) => t === 'test:e2e--chromium' || t === 'test:e2e--firefox',
      () => null,
      (p, t) => p === 'ui' && (t === 'build' || t === 'build-esm'),
      todos,
      (ps) => [...ps],
      names,
    )
    expect({ got, todos }).toEqual({
      got: [
        'test:e2e--chromium',
        'test:e2e--firefox',
        '@acme/ui#build',
        '@acme/ui#build-esm',
        '^lint',
        '@acme/ui#build-esm',
      ],
      todos: [],
    })
  })

  // Nx reads `projects: "ui"` as `["ui"]`, and `params: "ignore"` is its
  // default: the string form dropped the edge as unrepresentable, and every
  // `params` drew a todo about forwarding (item 1053).
  it('a lone projects string is a one-entry list; only params forward is a todo', () => {
    expect(deps([{ target: 'build', projects: 'ui', params: 'ignore' }])).toEqual({
      deps: ['@acme/ui#build'],
      todos: [],
    })
    expect(deps([{ target: 'build', params: 'forward' }]).todos).toEqual([
      'dependsOn "build": params forwarding is not supported — forward args via `vx run … -- args` instead',
    ])
    // CONTROL: a name that is no package still says so.
    expect(deps([{ target: 'build', projects: ['nope'] }]).todos).toEqual([
      'dependsOn project "nope" is not a workspace package — edge dropped',
    ])
  })

  it('a colon at the start is no project separator; an empty target after one is dropped', () => {
    expect(deps([':x', 'ui:'])).toEqual({
      deps: [':x'],
      todos: [
        'dependsOn "ui:" names "ui", which is not a workspace package in this graph — edge dropped',
      ],
    })
  })

  // Item 915: Nx splits at the colon only when the head names a project;
  // `bare:build`, neither a package nor a target here, keeps its todo.
  it('a colon string whose head is no package is this project’s target when it has one', () => {
    expect(deps(['test:unit', 'test:unit:ci', 'ui:build', 'bare:build'])).toEqual({
      deps: ['test:unit', 'test:unit:ci', '@acme/ui#build'],
      todos: [
        'dependsOn "bare:build" names "bare", which is not a workspace package in this graph — edge dropped',
      ],
    })
  })

  // Nx's `splitTargetFromNodes` (nx 23.3): this project's own target ranks
  // first, then the named project's longest target. `ui:build:esm` read as
  // `build` in configuration `esm` reached ui's `build`; `ui:pack:esm`,
  // with no `pack` on ui, dropped the edge. CONTROL: `ui:build:ci` with no
  // `build:ci` target is still `build` in configuration `ci`.
  it('a colon target: own first, then the named project’s whole target name', () => {
    const todos: string[] = []
    const got = mapNxDeps(
      ['ui:build:esm', 'ui:pack:esm', 'ui:lint', 'ui:build:ci'],
      byNode,
      (t) => t === 'ui:lint',
      (_p, t, c) => (t === 'build' && c === 'ci' ? 'build:ci' : null),
      (p, t) => p === 'ui' && ['build', 'build:esm', 'pack:esm', 'lint'].includes(t),
      todos,
    )
    expect([got, todos]).toEqual([
      ['@acme/ui#build:esm', '@acme/ui#pack:esm', 'ui:lint', '@acme/ui#build:ci'],
      [],
    ])
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

  // nx-examples: `targetDefaults` give every `typecheck` a `codegen` one
  // project declares. Nx adds no edge where the target is missing and
  // says nothing; passed through, core refused the whole run. CONTROL:
  // the targets that exist keep their edges.
  it('an edge to a target its project lacks is dropped, silently, in every form', () => {
    expect(
      deps([
        'codegen',
        { target: 'codegen' },
        { target: 'codegen', projects: 'self' },
        'ui:codegen',
        { target: 'codegen', projects: ['ui'] },
        'build',
        'ui:build',
      ]),
    ).toEqual({ deps: ['build', '@acme/ui#build'], todos: [] })
  })

  // An inferred target's name holds a colon (`rsbuild:typecheck`); split
  // there, `^rsbuild:typecheck` named project `^rsbuild` and was dropped.
  it('`^name` passes through whatever the name holds', () => {
    expect(deps(['^rsbuild:typecheck', '^build'])).toEqual({
      deps: ['^rsbuild:typecheck', '^build'],
      todos: [],
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
      outFiles: ['build'],
      wsOutFiles: ['coverage/packages/a', 'dist/a', 'dist/x/y'],
    })
    expect(todos).toEqual(['output "{workspaceRoot}/../escape" uses a token vx does not support'])
  })

  it('outputs of the root project', () => {
    const got = mapNxOutputs(['{workspaceRoot}/coverage/{projectRoot}x'], {}, '.', 'r', [])
    expect(got).toEqual({ outFiles: ['coverage/x'], wsOutFiles: [] })
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
    expect([got.files, got.todos]).toEqual([['**/*', '!**/{*.,}{spec,test}.{j,t}s{x,}'], []])
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

describe('matchNxProjects', () => {
  const nodes = [
    { name: 'lib-a', tags: ['lib', 'scope:web'] },
    { name: 'lib-b', tags: ['lib'] },
    { name: 'app', tags: ['app'] },
  ]
  it('names, `*` patterns, tags and exclusions, as Nx reads a projects list', () => {
    expect(matchNxProjects(['app'], nodes)).toEqual(['app'])
    expect(matchNxProjects(['lib-*'], nodes)).toEqual(['lib-a', 'lib-b'])
    expect(matchNxProjects(['tag:scope:*'], nodes)).toEqual(['lib-a'])
    expect(matchNxProjects(['tag:lib', '!lib-b'], nodes)).toEqual(['lib-a'])
    // A list that opens with an exclusion starts from every node.
    expect(matchNxProjects(['!app'], nodes)).toEqual(['lib-a', 'lib-b'])
    // A regex character in a name is a literal.
    expect(matchNxProjects(['lib.a'], nodes)).toEqual([])
  })
})
