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

function selects(c: {
  slug: string
  title: string
  why: string
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
  }
  return defineCase({
    id: `graph/select-${c.slug}`,
    category: 'graph',
    kind: c.kind ?? 'correctness',
    title: c.title,
    why: c.why,
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
    why: 'Selecting a project by name is the most basic way to say what a run should do. Running other projects as well spends time on work nobody asked for and can fail the run on code the user did not touch. Running fewer drops the one task the user wanted checked.',
    workspace: chain(),
    select: [{ name: 'ui' }],
    ran: ['ui'],
    notRan: ['app', 'utils', 'lib'],
  }),

  selects({
    slug: 'name-glob',
    title: 'A `*` in a name selects every project it matches',
    why: 'A `*` in a project name is a pattern, so `u*` means every project whose name starts with u. Treating it as a literal name selects nothing, and matching too loosely pulls in projects the pattern excludes. Either way the user runs a different set than the one they wrote.',
    workspace: chain(),
    select: [{ name: 'u*' }],
    ran: ['ui', 'utils'],
    notRan: ['app', 'lib'],
  }),

  selects({
    slug: 'name-whole',
    title: 'A name matches whole: `foo` never selects `foo-e2e`',
    why: 'A name without a wildcard must match a project name in full. Matching it as a prefix makes `foo` also run `foo-e2e`, which may be slow or need services the user did not start. The user would have no plain way left to select just `foo`. Wildcards are there for when the user wants more.',
    workspace: { projects: { foo: p(), 'foo-e2e': p() } },
    select: [{ name: 'foo' }],
    ran: ['foo'],
    notRan: ['foo-e2e'],
  }),

  selects({
    slug: 'name-dot-literal',
    title: 'A `.` in a name is a dot: `socket.io` never selects `socketxio`',
    why: 'Package names often contain dots, and a dot in a selector means a dot. Reading it as a pattern that matches any character selects `socketxio` too, a different package. A selector that matches more than its text runs work the user never named.',
    workspace: { projects: { 'socket.io': p([], 'packages/sio'), socketxio: p() } },
    select: [{ name: 'socket.io' }],
    ran: ['socket.io'],
    notRan: ['socketxio'],
  }),

  selects({
    slug: 'union',
    title: 'Two selectors run the union of what each selects',
    why: 'Several selectors each add projects to the run, so the result is everything any of them selects. Keeping only the last one, or only the projects all of them match, silently drops work the user asked for. CI then reports green for checks that never ran.',
    workspace: chain(),
    select: [{ name: 'ui' }, { name: 'lib' }],
    ran: ['ui', 'lib'],
    notRan: ['app', 'utils'],
  }),

  selects({
    slug: 'with-dependencies',
    title: 'Selecting a project with its dependencies takes every transitive one',
    why: 'Selecting a project with its dependencies means the whole chain below it, not only the direct ones. Stopping at ui leaves utils out, though app builds on it through ui. Unrelated projects like lib must stay out, or the selection means nothing.',
    workspace: chain(),
    select: [{ name: 'app', with: 'dependencies' }],
    ran: ['app', 'ui', 'utils'],
    notRan: ['lib'],
  }),

  selects({
    slug: 'with-dependents',
    title: 'Selecting a project with its dependents takes every transitive one',
    why: 'Selecting a project with its dependents means everything that could break when it changes, at any depth. app uses utils only through ui, but a change to utils still reaches it. Leaving app out lets a breaking change pass the check that was meant to catch it.',
    workspace: chain(),
    select: [{ name: 'utils', with: 'dependents' }],
    ran: ['utils', 'ui', 'app'],
    notRan: ['lib'],
  }),

  selects({
    slug: 'only-dependents',
    title: 'Selecting only a project’s dependents leaves the project out',
    why: 'Asking for only the dependents is a way to check what a change could break without rerunning the project itself. Including utils runs work the user excluded on purpose. Dropping the transitive app misses a project the change can still break.',
    workspace: chain(),
    select: [{ name: 'utils', with: 'dependents', self: false }],
    ran: ['ui', 'app'],
    notRan: ['utils', 'lib'],
  }),

  selects({
    slug: 'only-dependencies',
    title: 'Selecting only a project’s dependencies leaves the project out',
    why: 'Asking for only the dependencies prepares everything a project builds on, without the project itself. This is common before working on app locally. Including app runs what the user left out, and stopping at ui leaves utils, which ui needs, unprepared.',
    workspace: chain(),
    select: [{ name: 'app', with: 'dependencies', self: false }],
    ran: ['ui', 'utils'],
    notRan: ['app', 'lib'],
  }),

  selects({
    slug: 'dependents-and-their-dependencies',
    title: 'Dependents with their dependencies takes what each dependent builds on',
    why: 'To test the dependents of ui, each dependent needs everything it builds on, not only ui. app needs kit as much as ui, so leaving kit out runs app against a missing or stale dependency. lib is unrelated and must stay out, or the selection grows to the whole workspace.',
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
    why: 'An exclude on its own means everything except that project. Treating it as an empty selection runs nothing and lets CI pass having checked nothing. Treating it as a no-op runs the project the user asked to skip, which may be slow or broken for known reasons.',
    workspace: chain(),
    select: [{ name: 'lib', exclude: true }],
    ran: ['app', 'ui', 'utils'],
    notRan: ['lib'],
  }),

  selects({
    slug: 'all-minus-one',
    title: '`*` and an exclude select every project but that one',
    why: '`*` with an exclude is the explicit form of every project but one. The exclude must win over the wildcard, or the project the user named is run anyway. Common uses are skipping a slow or known broken package while still checking the rest.',
    workspace: chain(),
    select: [{ name: '*' }, { name: 'lib', exclude: true }],
    ran: ['app', 'ui', 'utils'],
    notRan: ['lib'],
  }),

  selects({
    slug: 'exclude-before-include',
    title: 'An exclude given before an include still removes what the include adds',
    why: 'An exclude names a project the user does not want run, wherever it appears on the command line. Applying selectors in order, so a later include adds utils back, makes the result depend on argument order. Scripts and CI configs build these lists in any order and expect the same set.',
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
    why: 'Excluding a project with its dependencies removes the project and everything below it. Removing only ui leaves utils in the run, though the user excluded the whole subtree. The rest of the workspace, app and lib here, must still run. This is how a user leaves out a whole stack, such as a library and its private helpers.',
    workspace: chain(),
    select: [{ name: 'ui', with: 'dependencies', exclude: true }, { name: '*' }],
    ran: ['app', 'lib'],
    notRan: ['ui', 'utils'],
  }),

  selects({
    slug: 'star-takes-scoped',
    title: '`*` selects scoped and unscoped projects alike',
    why: '`*` means every project, and a scoped name like `@acme/core` is a project like any other. A wildcard that stops at the `/` drops every scoped package from the run. In workspaces where most packages are scoped, that is most of the checks, gone without a warning.',
    workspace: scoped(),
    select: [{ name: '*' }],
    ran: ['@acme/core', '@acme/utils', 'app'],
    notRan: [],
  }),

  selects({
    slug: 'scope-glob',
    title: '`@acme/*` selects exactly that scope',
    why: '`@acme/*` is the usual way to select one npm scope. It must take every package in that scope and nothing outside it. Missing scoped names runs nothing, and matching unscoped ones runs projects the user did not ask for. Scopes often group a team’s or a product’s packages, so this selection is used a lot in CI.',
    workspace: scoped(),
    select: [{ name: '@acme/*' }],
    ran: ['@acme/core', '@acme/utils'],
    notRan: ['app'],
  }),

  selects({
    slug: 'glob-across-scope',
    title: 'A glob matches across the scope’s `/`: `*core*` selects `@acme/core`',
    why: 'Users think of a scoped package by its name, and `*core*` should find `@acme/core`. A wildcard that cannot cross the scope’s `/` silently skips it. The selection then runs fewer projects than the pattern plainly matches, with no sign anything was missed.',
    workspace: scoped(),
    select: [{ name: '*core*' }],
    ran: ['@acme/core'],
    notRan: ['@acme/utils', 'app'],
  }),

  selects({
    slug: 'exclude-scoped-glob',
    title: 'Excluding `*utils` takes out the scoped `@acme/utils`',
    why: 'An exclude pattern must match the same names an include would. If `*utils` cannot match `@acme/utils`, the package the user meant to skip runs anyway. Include and exclude have to read patterns the same way, or one of them lies. Scoped names are common enough that this mismatch would surface in most workspaces.',
    workspace: scoped(),
    select: [{ name: '*utils', exclude: true }],
    ran: ['@acme/core', 'app'],
    notRan: ['@acme/utils'],
  }),

  selects({
    slug: 'name-without-scope',
    title: 'A bare `core` selects `@acme/core` when only that package carries the name',
    why: 'When only one package is named `core` under any scope, a bare `core` can only mean that package. This is how the common package manager filter grammar reads it, which users already know. Selecting nothing instead runs nothing the user asked for, and may pass CI having checked nothing.',
    workspace: scoped(),
    select: [{ name: 'core' }],
    ran: ['@acme/core'],
    notRan: ['@acme/utils', 'app'],
  }),

  selects({
    slug: 'dir-glob',
    title: 'A directory glob selects the projects directly under it',
    why: 'A directory glob such as `packages/*` selects the projects directly under that path. It must not reach projects nested deeper, which a `**` is for, and must not reach other folders. Users rely on this to run one area of the repo, such as every app or every library.',
    workspace: dirs(),
    select: [{ dir: 'packages/*' }],
    ran: ['ui', 'core'],
    notRan: ['inner', 'web', 'admin', 'docs'],
  }),

  selects({
    slug: 'dir-globstar',
    title: 'A `**` directory glob reaches a project nested in another',
    why: '`**` in a directory glob means any depth, so it takes a project nested inside another. Stopping at one level drops the nested project without warning. Other top level folders such as `apps` must still stay out. Nested projects are common in repos that keep examples or fixtures inside a package.',
    workspace: dirs(),
    select: [{ dir: 'packages/**' }],
    ran: ['ui', 'core', 'inner'],
    notRan: ['web', 'admin', 'docs'],
  }),

  selects({
    slug: 'dir-is-project',
    title: 'A directory that is a project selects that project, not one nested in it',
    why: 'Naming a project by its path means that project. The project nested below it has a path of its own and is not part of it. Pulling it in runs work the user did not ask for, and makes a single project impossible to select by directory. Directory selectors exist so a user can point at exactly one folder.',
    workspace: dirs(),
    select: [{ dir: 'packages/core' }],
    ran: ['core'],
    notRan: ['inner', 'ui'],
  }),

  selects({
    slug: 'dir-no-prefix-spill',
    title: 'A directory does not select a sibling that shares its prefix',
    why: 'A directory names a path, and `packages/app` is not a prefix of `packages/app-extra`. Matching by string prefix runs a sibling the user did not name. A selection that runs more than asked reports nothing wrong; it only costs time and can hide a failure behind someone else’s.',
    kind: 'efficiency',
    workspace: { projects: { app: p(), appx: p([], 'packages/app-extra') } },
    select: [{ dir: 'packages/app' }],
    ran: ['app'],
    notRan: ['appx'],
  }),

  selects({
    slug: 'dir-minus-dir',
    title: 'A directory glob minus one directory selects every other project there',
    why: 'A directory exclude must remove a project selected by a directory glob, just as name excludes do. Skipping docs while checking the other apps is a common need. If the exclude is ignored, the project the user wanted left out runs and may fail the run for them.',
    workspace: dirs(),
    select: [{ dir: 'apps/*' }, { dir: 'apps/docs', exclude: true }],
    ran: ['web', 'admin'],
    notRan: ['docs', 'ui', 'core'],
  }),

  selects({
    slug: 'name-and-dir',
    title: 'A name and a directory select the union',
    why: 'Selectors by name and by directory may be mixed, and each adds its projects to the run. Keeping only one kind silently drops what the other selected. Projects neither selector names must stay out. Users mix the two when one project is easier to name and another easier to point at by path.',
    workspace: dirs(),
    select: [{ name: 'docs' }, { dir: 'packages/ui' }],
    ran: ['docs', 'ui'],
    notRan: ['core', 'web', 'admin'],
  }),

  selects({
    slug: 'cyclic-packages-name',
    title: 'Selecting by name in a package graph with a cycle runs that project alone',
    why: 'A cycle among packages does not change what selecting one project by name means. Only that project runs, since its task depends on nothing. Failing the run or pulling in the whole cycle punishes a workspace for a shape that does not affect this task.',
    from: ['filter', 'package-graph'],
    workspace: { projects: { a: p(['b']), b: p(['c']), c: p(['a']), d: p() } },
    select: [{ name: 'b' }],
    ran: ['b'],
    notRan: ['a', 'c', 'd'],
  }),

  selects({
    slug: 'cyclic-packages-walk',
    title: 'Walking a package cycle takes each project in it once',
    why: 'A walk over dependencies in a package cycle reaches each project in the cycle. It must take each one once and stop, not loop or fail. Unrelated projects stay out, so the run is the cycle and nothing more. Cycles do occur in real workspaces, often through test or tooling packages, and must not crash a selection.',
    from: ['filter', 'package-graph'],
    workspace: { projects: { a: p(['b']), b: p(['c']), c: p(['a']), d: p() } },
    select: [{ name: 'b', with: 'dependencies' }],
    ran: ['a', 'b', 'c'],
    notRan: ['d'],
  }),

  selects({
    slug: 'dependents-through-task-edge',
    title: 'A project whose task names another project’s task counts as its dependent',
    why: 'A task that names another project’s task depends on that project, even if no package manifest says so. e2e needs app’s check, so it is a dependent of app. Leaving it out of the dependents of app skips the project that tests app, and a breaking change passes.',
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
    why: 'A selector that matches nothing is almost always a typo or a renamed package. If the run exits 0, CI passes having checked nothing, and no one notices until something broken ships. Failing the run names the selector that went wrong, while it is cheap to fix.',
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
]
