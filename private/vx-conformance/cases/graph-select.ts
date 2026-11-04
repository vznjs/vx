// Which projects a run selects: by name, glob, directory, and the walks
// over the package graph. Every task here depends on nothing, so what ran
// is exactly what was selected.
import {
  defineCase,
  type Case,
  type Feature,
  type ProjectSpec,
  type Selector,
  type WorkspaceSpec,
} from '../src/spec.ts'

/** A project whose `check` reads nothing but its own source. */
function p(deps: string[] = [], dir?: string): ProjectSpec {
  return {
    deps,
    tasks: { check: { command: 'true', inputs: ['src/**'] } },
    files: { 'src/a.txt': 'x\n' },
    ...(dir ? { dir } : {}),
  }
}

/** app → ui → utils, and lib alone. */
function chain(): WorkspaceSpec {
  return { projects: { app: p(['ui']), ui: p(['utils']), utils: p(), lib: p() } }
}

const FROM = ['filter', 'filter-properties']

/** site and admin tagged web, api tagged scope:api and depending on lib; lib untagged. */
const tagged = (): WorkspaceSpec => ({
  projects: {
    site: { ...p(), tags: ['web', 'scope:site'] },
    admin: { ...p(), tags: ['web'] },
    api: { ...p(['lib']), tags: ['scope:api'] },
    lib: p(),
  },
})

function selects(c: {
  slug: string
  title: string
  why?: string
  from?: string[]
  workspace: WorkspaceSpec
  select: Selector[]
  ran: string[]
  notRan: string[]
  kind?: Case['kind']
}): Case {
  const needs = new Set<Feature>(['filter'])
  for (const s of c.select) {
    if (s.with) needs.add('select-walk')
    if (s.dir) needs.add('select-dir')
    if (s.tag) needs.add('select-tag')
  }
  return defineCase({
    id: `graph/select-${c.slug}`,
    category: 'graph',
    kind: c.kind ?? 'correctness',
    title: c.title,
    ...(c.why ? { why: c.why } : {}),
    from: c.from ?? FROM,
    needs: [...needs],
    workspace: c.workspace,
    steps: [
      {
        run: 'check',
        select: c.select,
        expect: {
          exit: 0,
          ran: c.ran.map((x) => `${x}#check`),
          notRan: c.notRan.map((x) => `${x}#check`),
        },
      },
    ],
  })
}

const scoped = (): WorkspaceSpec => ({
  projects: {
    '@acme/core': p([], 'packages/core'),
    '@acme/utils': p([], 'packages/utils'),
    app: p(),
  },
})

const dirs = (): WorkspaceSpec => ({
  projects: {
    ui: p([], 'packages/ui'),
    core: p([], 'packages/core'),
    inner: p([], 'packages/core/inner'),
    web: p([], 'apps/web'),
    admin: p([], 'apps/admin'),
    docs: p([], 'apps/docs'),
  },
})

export default [
  selects({
    slug: 'exact-name',
    title: 'Selecting a project by name runs its task and no other project’s',
    workspace: chain(),
    select: [{ name: 'ui' }],
    ran: ['ui'],
    notRan: ['app', 'utils', 'lib'],
  }),

  selects({
    slug: 'name-glob',
    title: 'A `*` in a name selects every project it matches',
    workspace: chain(),
    select: [{ name: 'u*' }],
    ran: ['ui', 'utils'],
    notRan: ['app', 'lib'],
  }),

  selects({
    slug: 'name-whole',
    title: 'A name matches whole: `foo` never selects `foo-e2e`',
    workspace: { projects: { foo: p(), 'foo-e2e': p() } },
    select: [{ name: 'foo' }],
    ran: ['foo'],
    notRan: ['foo-e2e'],
  }),

  selects({
    slug: 'name-dot-literal',
    title: 'A `.` in a name is a dot: `socket.io` never selects `socketxio`',
    workspace: { projects: { 'socket.io': p([], 'packages/sio'), socketxio: p() } },
    select: [{ name: 'socket.io' }],
    ran: ['socket.io'],
    notRan: ['socketxio'],
  }),

  selects({
    slug: 'union',
    title: 'Two selectors run the union of what each selects',
    workspace: chain(),
    select: [{ name: 'ui' }, { name: 'lib' }],
    ran: ['ui', 'lib'],
    notRan: ['app', 'utils'],
  }),

  selects({
    slug: 'with-dependencies',
    title: 'Selecting a project with its dependencies takes every transitive one',
    workspace: chain(),
    select: [{ name: 'app', with: 'dependencies' }],
    ran: ['app', 'ui', 'utils'],
    notRan: ['lib'],
  }),

  selects({
    slug: 'with-dependents',
    title: 'Selecting a project with its dependents takes every transitive one',
    workspace: chain(),
    select: [{ name: 'utils', with: 'dependents' }],
    ran: ['utils', 'ui', 'app'],
    notRan: ['lib'],
  }),

  selects({
    slug: 'only-dependents',
    title: 'Selecting only a project’s dependents leaves the project out',
    workspace: chain(),
    select: [{ name: 'utils', with: 'dependents', self: false }],
    ran: ['ui', 'app'],
    notRan: ['utils', 'lib'],
  }),

  selects({
    slug: 'only-dependencies',
    title: 'Selecting only a project’s dependencies leaves the project out',
    workspace: chain(),
    select: [{ name: 'app', with: 'dependencies', self: false }],
    ran: ['ui', 'utils'],
    notRan: ['app', 'lib'],
  }),

  selects({
    slug: 'dependents-and-their-dependencies',
    title: 'Dependents with their dependencies takes what each dependent builds on',
    why: 'app needs kit as much as ui; testing ui’s dependents without kit runs app against a missing dependency.',
    workspace: {
      projects: { app: p(['ui', 'kit']), ui: p(['utils']), utils: p(), kit: p(), lib: p() },
    },
    select: [{ name: 'ui', with: 'dependents-and-dependencies' }],
    ran: ['app', 'kit', 'ui', 'utils'],
    notRan: ['lib'],
  }),

  selects({
    slug: 'exclude-from-all',
    title: 'An exclude alone selects every project but the one it names',
    workspace: chain(),
    select: [{ name: 'lib', exclude: true }],
    ran: ['app', 'ui', 'utils'],
    notRan: ['lib'],
  }),

  selects({
    slug: 'all-minus-one',
    title: '`*` and an exclude select every project but that one',
    workspace: chain(),
    select: [{ name: '*' }, { name: 'lib', exclude: true }],
    ran: ['app', 'ui', 'utils'],
    notRan: ['lib'],
  }),

  selects({
    slug: 'exclude-before-include',
    title: 'An exclude given before an include still removes what the include adds',
    why: 'The exclude names a project the user does not want run; argument order is not a reason to run it.',
    workspace: chain(),
    select: [
      { name: 'utils', exclude: true },
      { name: 'app', with: 'dependencies' },
    ],
    ran: ['app', 'ui'],
    notRan: ['utils', 'lib'],
  }),

  selects({
    slug: 'exclude-walk',
    title: 'Excluding a project with its dependencies removes them all',
    workspace: chain(),
    select: [{ name: 'ui', with: 'dependencies', exclude: true }, { name: '*' }],
    ran: ['app', 'lib'],
    notRan: ['ui', 'utils'],
  }),

  selects({
    slug: 'star-takes-scoped',
    title: '`*` selects scoped and unscoped projects alike',
    workspace: scoped(),
    select: [{ name: '*' }],
    ran: ['@acme/core', '@acme/utils', 'app'],
    notRan: [],
  }),

  selects({
    slug: 'scope-glob',
    title: '`@acme/*` selects exactly that scope',
    workspace: scoped(),
    select: [{ name: '@acme/*' }],
    ran: ['@acme/core', '@acme/utils'],
    notRan: ['app'],
  }),

  selects({
    slug: 'glob-across-scope',
    title: 'A glob matches across the scope’s `/`: `*core*` selects `@acme/core`',
    workspace: scoped(),
    select: [{ name: '*core*' }],
    ran: ['@acme/core'],
    notRan: ['@acme/utils', 'app'],
  }),

  selects({
    slug: 'exclude-scoped-glob',
    title: 'Excluding `*utils` takes out the scoped `@acme/utils`',
    workspace: scoped(),
    select: [{ name: '*utils', exclude: true }],
    ran: ['@acme/core', 'app'],
    notRan: ['@acme/utils'],
  }),

  selects({
    slug: 'name-without-scope',
    title: 'A bare `core` selects `@acme/core` when only that package carries the name',
    why: 'pnpm, whose filter grammar the others borrow, reads it so; selecting nothing runs nothing the user asked for.',
    workspace: scoped(),
    select: [{ name: 'core' }],
    ran: ['@acme/core'],
    notRan: ['@acme/utils', 'app'],
  }),

  selects({
    slug: 'dir-glob',
    title: 'A directory glob selects the projects directly under it',
    workspace: dirs(),
    select: [{ dir: 'packages/*' }],
    ran: ['ui', 'core'],
    notRan: ['inner', 'web', 'admin', 'docs'],
  }),

  selects({
    slug: 'dir-globstar',
    title: 'A `**` directory glob reaches a project nested in another',
    workspace: dirs(),
    select: [{ dir: 'packages/**' }],
    ran: ['ui', 'core', 'inner'],
    notRan: ['web', 'admin', 'docs'],
  }),

  selects({
    slug: 'dir-is-project',
    title: 'A directory that is a project selects that project, not one nested in it',
    why: 'Naming a project by its path means that project; the one nested below has a path of its own.',
    workspace: dirs(),
    select: [{ dir: 'packages/core' }],
    ran: ['core'],
    notRan: ['inner', 'ui'],
  }),

  selects({
    slug: 'dir-no-prefix-spill',
    title: 'A directory does not select a sibling that shares its prefix',
    why: 'A selection that runs more than asked reports nothing wrong; it only costs time and can hide a failure.',
    kind: 'efficiency',
    workspace: { projects: { app: p(), appx: p([], 'packages/app-extra') } },
    select: [{ dir: 'packages/app' }],
    ran: ['app'],
    notRan: ['appx'],
  }),

  selects({
    slug: 'dir-minus-dir',
    title: 'A directory glob minus one directory selects every other project there',
    workspace: dirs(),
    select: [{ dir: 'apps/*' }, { dir: 'apps/docs', exclude: true }],
    ran: ['web', 'admin'],
    notRan: ['docs', 'ui', 'core'],
  }),

  selects({
    slug: 'name-and-dir',
    title: 'A name and a directory select the union',
    workspace: dirs(),
    select: [{ name: 'docs' }, { dir: 'packages/ui' }],
    ran: ['docs', 'ui'],
    notRan: ['core', 'web', 'admin'],
  }),

  selects({
    slug: 'cyclic-packages-name',
    title: 'Selecting by name in a package graph with a cycle runs that project alone',
    from: ['filter', 'package-graph'],
    workspace: { projects: { a: p(['b']), b: p(['c']), c: p(['a']), d: p() } },
    select: [{ name: 'b' }],
    ran: ['b'],
    notRan: ['a', 'c', 'd'],
  }),

  selects({
    slug: 'cyclic-packages-walk',
    title: 'Walking a package cycle takes each project in it once',
    from: ['filter', 'package-graph'],
    workspace: { projects: { a: p(['b']), b: p(['c']), c: p(['a']), d: p() } },
    select: [{ name: 'b', with: 'dependencies' }],
    ran: ['a', 'b', 'c'],
    notRan: ['d'],
  }),

  selects({
    slug: 'dependents-through-task-edge',
    title: 'A project whose task names another project’s task counts as its dependent',
    why: 'e2e declares it needs app#check; the dependents of app without e2e leave the one that tests app unrun.',
    workspace: {
      projects: {
        app: p(),
        e2e: {
          tasks: { check: { command: 'true', inputs: ['src/**'], dependsOn: ['app#check'] } },
          files: { 'src/a.txt': 'x\n' },
        },
        lib: p(),
      },
    },
    select: [{ name: 'app', with: 'dependents' }],
    ran: ['app', 'e2e'],
    notRan: ['lib'],
  }),

  defineCase({
    id: 'graph/select-no-match-refused',
    category: 'graph',
    kind: 'correctness',
    title: 'A selector that matches no project fails the run',
    why: 'A typo that exits 0 lets CI pass having checked nothing.',
    from: FROM,
    needs: ['filter'],
    workspace: chain(),
    steps: [
      {
        run: 'check',
        select: [{ name: 'nope' }],
        expect: { exit: 'fail', notRan: ['app#check', 'ui#check', 'utils#check', 'lib#check'] },
      },
    ],
  }),

  selects({
    slug: 'by-tag',
    title: 'A tag selects exactly the projects carrying it',
    workspace: tagged(),
    select: [{ tag: 'web' }],
    ran: ['site', 'admin'],
    notRan: ['api', 'lib'],
  }),

  selects({
    slug: 'by-tag-glob',
    title: 'A `*` in a tag selects the projects carrying any tag it matches',
    workspace: tagged(),
    select: [{ tag: 'scope:*' }],
    ran: ['site', 'api'],
    notRan: ['admin', 'lib'],
  }),

  selects({
    slug: 'exclude-tag',
    title: 'A tag excluded takes the projects carrying it out of the selection',
    workspace: tagged(),
    select: [{ name: '*' }, { tag: 'web', exclude: true }],
    ran: ['api', 'lib'],
    notRan: ['site', 'admin'],
  }),

  selects({
    slug: 'tag-with-dependencies',
    title: 'A tag and its dependencies select the tagged projects and what they depend on',
    workspace: tagged(),
    select: [{ tag: 'scope:api', with: 'dependencies' }],
    ran: ['api', 'lib'],
    notRan: ['site', 'admin'],
  }),
]
