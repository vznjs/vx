// Selection, mined from the rivals’ filter tests (Turborepo’s scope filter
// and task-filter specs, Nx’s find-matching-projects) and vx’s own: what a
// walk takes at the graph’s edges, what an exclude leaves to the tasks that
// still need it, selectors by tag and directory, skipping dependencies under
// a selection, where the run starts, and planned runs that must still refuse.
import {
  defineCase,
  type Case,
  type Feature,
  type ProjectSpec,
  type Selector,
  type TaskSpec,
  type WorkspaceSpec,
} from '../src/spec.ts'
import { chainProject, out } from './shapes.ts'

const FROM = ['filter', 'filter-properties']

/** A project whose `check` reads nothing but its own source. */
function p(deps: string[] = [], extra: Partial<ProjectSpec> = {}): ProjectSpec {
  return {
    deps,
    tasks: { check: { command: 'true', inputs: ['src/**'] } },
    files: { 'src/a.txt': 'x\n' },
    ...extra,
  }
}

/** A project whose `check` runs after its dependencies’ `check`. */
function q(deps: string[] = [], extra: Partial<ProjectSpec> = {}): ProjectSpec {
  return {
    deps,
    tasks: { check: { command: 'true', inputs: ['src/**'], dependsOn: ['^check'] } },
    files: { 'src/a.txt': 'x\n' },
    ...extra,
  }
}

/** app → ui → utils, and lib alone. */
const chain = (): WorkspaceSpec => ({
  projects: { app: p(['ui']), ui: p(['utils']), utils: p(), lib: p() },
})

/** The same shape where each `check` waits for its dependencies’ `check`. */
const linked = (): WorkspaceSpec => ({
  projects: { app: q(['ui']), ui: q(['utils']), utils: q(), lib: q() },
})

/** The same shape where each build copies its dependency’s output first. */
const built = (): WorkspaceSpec => ({
  projects: {
    app: chainProject('app', ['ui']),
    ui: chainProject('ui', ['utils']),
    utils: chainProject('utils'),
    lib: chainProject('lib'),
  },
})

const CHAIN = ['app', 'ui', 'utils', 'lib']

/** site and admin tagged web (site on lib), api tagged api on lib, lib untagged. */
const tagged = (make = p): WorkspaceSpec => ({
  projects: {
    site: make(['lib'], { tags: ['web'] }),
    admin: make([], { tags: ['web', 'internal'] }),
    api: make(['lib'], { tags: ['api'] }),
    lib: make(),
  },
})

const TAGGED = ['site', 'admin', 'api', 'lib']

/** Projects in nested and sibling directories. */
const dirs = (): WorkspaceSpec => ({
  projects: {
    ui: p([], { dir: 'packages/ui' }),
    core: p(['ui'], { dir: 'packages/core' }),
    inner: p([], { dir: 'packages/core/inner' }),
    web: p(['core'], { dir: 'apps/web' }),
    docs: p([], { dir: 'apps/docs' }),
  },
})

const DIRS = ['ui', 'core', 'inner', 'web', 'docs']

const checks = (names: string[]) => names.map((n) => `${n}#check`)
const minus = (all: string[], some: string[]) => all.filter((n) => !some.includes(n))

function needsFor(select: Selector[], more: Feature[] = []): Feature[] {
  const needs = new Set<Feature>(['filter', ...more])
  for (const s of select) {
    if (s.with) needs.add('select-walk')
    if (s.dir) needs.add('select-dir')
    if (s.tag) needs.add('select-tag')
  }
  return [...needs]
}

/** One `check` run over a selection: exactly `ran` run, the rest of `all` do not. */
function selects(c: {
  slug: string
  title: string
  why: string
  from?: string[]
  workspace: WorkspaceSpec
  all: string[]
  select: Selector[]
  ran: string[]
  cwd?: string
  kind?: Case['kind']
}): Case {
  return defineCase({
    id: `graph/${c.slug}`,
    category: 'graph',
    kind: c.kind ?? 'correctness',
    title: c.title,
    why: c.why,
    from: c.from ?? FROM,
    needs: needsFor(c.select),
    workspace: c.workspace,
    steps: [
      {
        run: 'check',
        select: c.select,
        ...(c.cwd ? { cwd: c.cwd } : {}),
        expect: { exit: 0, ran: checks(c.ran), notRan: checks(minus(c.all, c.ran)) },
      },
    ],
  })
}

/** A selection that leaves nothing to run: nothing runs, and the run either ends clean or refuses. */
function empties(c: {
  slug: string
  title: string
  why: string
  from?: string[]
  workspace: WorkspaceSpec
  all: string[]
  select: Selector[]
}): Case {
  return defineCase({
    id: `graph/${c.slug}`,
    category: 'graph',
    kind: 'correctness',
    title: c.title,
    why: c.why,
    from: c.from ?? FROM,
    needs: needsFor(c.select),
    workspace: c.workspace,
    steps: [
      {
        run: 'check',
        select: c.select,
        expect: { exit: 0, orRefused: true, notRan: checks(c.all) },
      },
    ],
  })
}

/** A selector that matches no project: the run fails and runs nothing. */
function refuses(c: {
  slug: string
  title: string
  why: string
  from?: string[]
  workspace: WorkspaceSpec
  all: string[]
  select: Selector[]
}): Case {
  return defineCase({
    id: `graph/${c.slug}`,
    category: 'graph',
    kind: 'correctness',
    title: c.title,
    why: c.why,
    from: c.from ?? ['filter', 'select'],
    needs: needsFor(c.select),
    workspace: c.workspace,
    steps: [{ run: 'check', select: c.select, expect: { exit: 'fail', notRan: checks(c.all) } }],
  })
}

const T = (command: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  ...extra,
})

export default [
  // --- Walks at the edges of the graph -------------------------------------

  // turborepo-scope filter.rs: "select package with dependents"
  selects({
    slug: 'select-dependents-of-top-is-itself',
    title: 'The dependents of a project nothing depends on are just that project',
    why: 'app is at the top of the graph: no project depends on it. Asking for app with its dependents can only mean app. A walk that wanders down instead, into ui and utils, mixes up the two directions and runs work nobody asked for.',
    workspace: chain(),
    all: CHAIN,
    select: [{ name: 'app', with: 'dependents' }],
    ran: ['app'],
    kind: 'efficiency',
  }),

  // turborepo-scope filter.rs: "select package with dependencies"
  selects({
    slug: 'select-dependencies-of-leaf-is-itself',
    title: 'The dependencies of a project that depends on nothing are just that project',
    why: 'utils is at the bottom of the graph and depends on no workspace project. Asking for utils with its dependencies can only mean utils. Pulling in ui and app, which depend on utils, walks the wrong way and runs projects the user never named.',
    workspace: chain(),
    all: CHAIN,
    select: [{ name: 'utils', with: 'dependencies' }],
    ran: ['utils'],
    kind: 'efficiency',
  }),

  // filter.test.ts: '...^pkg includes only the dependents, not the package itself'
  empties({
    slug: 'select-only-dependents-of-top-runs-nothing',
    title: 'Only the dependents of a project nothing depends on runs no task',
    why: 'Leaving app out and keeping only its dependents leaves nothing, since nothing depends on app. The run must not fall back to app itself, or to the whole workspace, to have something to do. Ending clean with nothing run, or refusing an empty selection, both tell the truth.',
    workspace: chain(),
    all: CHAIN,
    select: [{ name: 'app', with: 'dependents', self: false }],
  }),

  // filter.test.ts: 'pkg^... includes only the deps, not the package itself'
  empties({
    slug: 'select-only-dependencies-of-leaf-runs-nothing',
    title: 'Only the dependencies of a project that depends on nothing runs no task',
    why: 'utils depends on no workspace project, so its dependencies without itself are an empty set. A tool that reads an empty walk as "no selector given" runs every project, which is the opposite of what was asked. Nothing may run; ending clean or refusing are both honest.',
    workspace: chain(),
    all: CHAIN,
    select: [{ name: 'utils', with: 'dependencies', self: false }],
  }),

  // filter.test.ts: '...pkg... also takes the dependencies of every dependent'
  selects({
    slug: 'select-dependents-and-dependencies-of-top',
    title: 'A top project with its dependents and their dependencies takes everything below it',
    why: 'The only dependent of app is app itself, and its dependencies are ui and utils. So the walk is app with all it builds on, and lib, unrelated, stays out. A tool that stops after the dependents half runs app alone, without the libraries it needs.',
    workspace: chain(),
    all: CHAIN,
    select: [{ name: 'app', with: 'dependents-and-dependencies' }],
    ran: ['app', 'ui', 'utils'],
  }),

  // turborepo-scope filter.rs: "select package with dependencies and dependents, including dependent dependencies"
  selects({
    slug: 'select-dependents-and-dependencies-takes-self-back',
    title:
      'Leaving a project out of its dependents-and-dependencies walk still takes it as a dependency',
    why: 'Leaving ui out means it is not taken for matching the selector. But app, its dependent, builds on ui, and the walk takes what each dependent builds on. ui comes back as a dependency of app, as utils does. Dropping it runs app without a library it needs.',
    workspace: chain(),
    all: CHAIN,
    select: [{ name: 'ui', with: 'dependents-and-dependencies', self: false }],
    ran: ['app', 'ui', 'utils'],
  }),

  // turborepo-scope filter.rs: "filter using two selectors: one selects dependencies another selects dependents"
  selects({
    slug: 'select-two-walks-overlap',
    title: 'A project’s dependencies and its dependents in two selectors run as one set',
    why: 'One selector takes ui and what it builds on, the other ui and what builds on it. The union is the whole chain through ui, with ui once. lib touches neither walk and stays out. A tool that keeps only one selector, or the overlap, drops half the chain.',
    workspace: chain(),
    all: CHAIN,
    select: [
      { name: 'ui', with: 'dependencies' },
      { name: 'ui', with: 'dependents' },
    ],
    ran: ['app', 'ui', 'utils'],
  }),

  // filter.test.ts: 'an exclude removes what any include adds, whatever the order'
  selects({
    slug: 'select-exclude-middle-of-walk',
    title: 'Excluding the middle of a dependency walk keeps what lies beyond it',
    why: 'app’s dependencies are ui and, through it, utils. Excluding ui takes ui out of the result, not out of the graph: utils is still something app builds on. A walk that stops at the excluded project loses utils, which the user never excluded.',
    workspace: chain(),
    all: CHAIN,
    select: [
      { name: 'app', with: 'dependencies' },
      { name: 'ui', exclude: true },
    ],
    ran: ['app', 'utils'],
  }),

  // turborepo-scope target_selector: `!...pkg`
  selects({
    slug: 'select-exclude-dependents',
    title: 'Excluding a project with its dependents leaves the rest of the workspace',
    why: 'An exclude with dependents takes out utils and everything that builds on it, at any depth. Only lib is left. Removing just utils, or just its direct dependents, runs app though the user excluded the whole stack above utils.',
    workspace: chain(),
    all: CHAIN,
    select: [{ name: 'utils', with: 'dependents', exclude: true }],
    ran: ['lib'],
  }),

  selects({
    slug: 'select-exclude-only-dependents',
    title: 'Excluding only a project’s dependents keeps the project itself',
    why: 'Leaving ui out of the exclude means the exclude takes only what builds on ui, which is app. ui, utils and lib all stay. Taking ui out as well ignores the very part of the selector that spared it.',
    workspace: chain(),
    all: CHAIN,
    select: [{ name: 'ui', with: 'dependents', self: false, exclude: true }],
    ran: ['ui', 'utils', 'lib'],
  }),

  // task-selection.test.ts: 'a project without the requested task contributes none of its dependencies'
  selects({
    slug: 'select-dependents-of-taskless-project',
    title: 'The dependents of a project without the task run it, though the project cannot',
    why: 'utils has no check, but ui and app, which build on it, do. Selecting utils with its dependents asks for their checks. Refusing because the named project lacks the task, or running nothing, drops the dependents the user asked for.',
    workspace: {
      projects: {
        app: p(['ui']),
        ui: p(['utils']),
        utils: { files: { 'src/a.txt': 'x\n' } },
        lib: p(),
      },
    },
    all: ['app', 'ui', 'lib'],
    select: [{ name: 'utils', with: 'dependents' }],
    ran: ['app', 'ui'],
  }),

  // turborepo task_filter_package_scope_test.rs: --filter=tag:ci --filter=!tag:ci
  empties({
    slug: 'select-include-and-exclude-same-project',
    title: 'Selecting a project and excluding it runs nothing',
    why: 'The exclude names exactly what the include took, so nothing is left. The exclude has to win, as it does whatever the order: running ui ignores it. Running every other project instead reads the exclude as if it stood alone. Nothing runs; ending clean or refusing are both fine.',
    from: ['filter', 'select'],
    workspace: chain(),
    all: CHAIN,
    select: [{ name: 'ui' }, { name: 'ui', exclude: true }],
  }),

  // --- Excluded projects whose tasks are still needed ----------------------

  // turborepo task_filter_package_scope_test.rs: tag_exclusion_keeps_required_dependencies_and_qualified_tasks
  defineCase({
    id: 'graph/select-excluded-dependency-still-builds',
    category: 'graph',
    kind: 'correctness',
    title: 'An excluded project still builds when a selected project’s build needs it',
    why: 'Excluding utils says not to ask for its build; it does not unsay ui’s `^build`. ui cannot build without utils’ output, so utils builds first. Skipping it builds ui on a missing or stale file, and app after it, while the run reports success.',
    from: ['filter', 'task-selection'],
    needs: ['filter'],
    workspace: built(),
    steps: [
      {
        run: 'build',
        select: [{ name: 'utils', exclude: true }],
        expect: {
          exit: 0,
          ran: ['utils#build', 'ui#build', 'app#build', 'lib#build'],
          order: [
            ['utils#build', 'ui#build'],
            ['ui#build', 'app#build'],
          ],
          files: { [out('app')]: 'utils\nui\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/select-only-dependents-still-builds-the-project',
    category: 'graph',
    kind: 'correctness',
    title: 'Selecting only a library’s dependents still builds the library first',
    why: 'Leaving utils out of the selection keeps it from being asked for, but ui’s `^build` still needs it. The library builds first and its dependents read its output. Not building it leaves ui to fail on a missing file, or worse, read an old one.',
    from: ['filter', 'task-selection'],
    needs: ['filter', 'select-walk'],
    workspace: built(),
    steps: [
      {
        run: 'build',
        select: [{ name: 'utils', with: 'dependents', self: false }],
        expect: {
          exit: 0,
          ran: ['utils#build', 'ui#build', 'app#build'],
          notRan: ['lib#build'],
          order: [['utils#build', 'ui#build']],
          files: { [out('app')]: 'utils\nui\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/select-excluded-explicit-edge-still-runs',
    category: 'graph',
    kind: 'correctness',
    title: 'An excluded project’s task still runs when a selected task names it',
    why: 'app’s build names `gen#gen`, so that task is part of app’s build whatever the selection says. Excluding gen keeps gen from being asked for its own tasks, not from serving app. Skipping it builds app without the file gen writes.',
    from: ['task-edge-selection', 'task-selection'],
    needs: ['filter'],
    workspace: {
      projects: {
        gen: {
          tasks: { gen: T('mkdir -p dist && echo gen > dist/g.txt', { outputs: ['dist/**'] }) },
          files: { 'src/a.txt': 'g\n' },
        },
        app: {
          tasks: {
            build: T('mkdir -p dist && cat ../gen/dist/g.txt src/a.txt > dist/out.txt', {
              dependsOn: ['gen#gen'],
              outputs: ['dist/**'],
            }),
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        select: [{ name: 'gen', exclude: true }],
        expect: {
          exit: 0,
          ran: ['gen#gen', 'app#build'],
          order: [['gen#gen', 'app#build']],
          files: { [out('app')]: 'gen\napp\n' },
        },
      },
    ],
  }),

  // --- Tags -----------------------------------------------------------------

  // find-matching-projects.spec.ts: 'should support mixed projectNames and tags'
  selects({
    slug: 'select-tag-and-name-union',
    title: 'A tag and a name select the tagged projects and the named one',
    why: 'Selectors of different kinds still add up. The web tag takes site and admin, the name takes lib, and api is in neither. Keeping only one kind of selector drops projects the user plainly asked for.',
    from: ['project-tags', 'filter'],
    workspace: tagged(),
    all: TAGGED,
    select: [{ tag: 'web' }, { name: 'lib' }],
    ran: ['site', 'admin', 'lib'],
  }),

  // turborepo task_filter_package_scope_test.rs: --filter=tag:missing
  refuses({
    slug: 'select-tag-no-match-refused',
    title: 'A tag no project carries fails the run',
    why: 'A tag that matches nothing is a typo or a tag that was renamed, the same as a name that matches nothing. Exiting 0 lets CI go green having checked no project. Failing points at the selector while the mistake is cheap to fix.',
    from: ['select', 'project-tags'],
    workspace: tagged(),
    all: TAGGED,
    select: [{ tag: 'mobile' }],
  }),

  // turborepo task_filter_package_scope_test.rs: --filter=...tag:ci
  selects({
    slug: 'select-tag-with-dependents',
    title: 'A tag with its dependents takes the tagged projects and what builds on them',
    why: 'Tagging a library and asking for its dependents is how a user checks everything a change to it can break. lib carries the tag here, and site and api build on it. admin does not, and stays out.',
    from: ['project-tags', 'filter'],
    workspace: {
      projects: {
        site: p(['lib']),
        admin: p(),
        api: p(['lib']),
        lib: p([], { tags: ['core'] }),
      },
    },
    all: TAGGED,
    select: [{ tag: 'core', with: 'dependents' }],
    ran: ['lib', 'site', 'api'],
  }),

  // turborepo task_filter_package_scope_test.rs: --filter=tag:ci^...
  selects({
    slug: 'select-tag-only-dependencies',
    title: 'Only the dependencies of tagged projects leaves the tagged ones out',
    why: 'Leaving the tagged projects out keeps just what they build on. site and api both build on lib, so lib runs and nothing tagged does. This is how a user prepares the libraries under a group of apps without running the apps.',
    from: ['project-tags', 'filter'],
    workspace: {
      projects: {
        site: p(['lib'], { tags: ['app'] }),
        admin: p(),
        api: p(['lib'], { tags: ['app'] }),
        lib: p(),
      },
    },
    all: TAGGED,
    select: [{ tag: 'app', with: 'dependencies', self: false }],
    ran: ['lib'],
  }),

  selects({
    slug: 'select-two-tags-of-one-project',
    title: 'A project carrying both of two selected tags runs once, with the rest of each tag',
    why: 'admin carries web and internal, and both are selected. It is one project and its check runs once. Each tag also brings its other projects: site through web. A tool that matches only the first tag of each project drops admin from the second selector, harmlessly here, but not with the first selector gone.',
    from: ['project-tags'],
    workspace: tagged(),
    all: TAGGED,
    select: [{ tag: 'internal' }, { tag: 'web' }],
    ran: ['site', 'admin'],
  }),

  selects({
    slug: 'select-tag-star-only-tagged',
    title: '`*` as a tag selects every project with a tag and none without',
    why: 'A `*` tag matches any tag a project carries, so a project with no tags has nothing to match. lib is untagged and stays out. Treating `tag:*` as every project throws away the one thing the user wrote, that the project must be tagged.',
    from: ['project-tags', 'filter'],
    workspace: tagged(),
    all: TAGGED,
    select: [{ tag: '*' }],
    ran: ['site', 'admin', 'api'],
  }),

  // turborepo task_filter_package_scope_test.rs: root_package_tags_do_not_leak_into_workspace_packages
  selects({
    slug: 'select-root-tag-stays-on-root',
    title: 'A tag on the workspace-root project selects the root and none of its members',
    why: 'The members sit inside the root’s directory, but a tag belongs to the project that declares it. Selecting the root’s tag takes the root and nothing else. Letting the tag spread to every member runs the whole workspace when one project was asked for.',
    from: ['project-tags', 'filter'],
    workspace: {
      projects: {
        root: {
          dir: '.',
          tags: ['tooling'],
          tasks: { check: { command: 'true', inputs: ['tools/**'] } },
        },
        a: p(),
        b: p(),
      },
      files: { 'tools/t.txt': 't\n' },
    },
    all: ['root', 'a', 'b'],
    select: [{ tag: 'tooling' }],
    ran: ['root'],
  }),

  // --- Directories ----------------------------------------------------------

  // filter.test.ts: 'a path form with a glob selects by root-relative dir'
  selects({
    slug: 'select-dir-with-dependencies',
    title: 'A directory with its dependencies takes the projects there and what they build on',
    why: 'A walk works the same from a project picked by path as from one picked by name. web lives in apps/web and builds on core, which builds on ui. All three run; docs, in the same folder as web but unrelated, does not.',
    workspace: dirs(),
    all: DIRS,
    select: [{ dir: 'apps/web', with: 'dependencies' }],
    ran: ['web', 'core', 'ui'],
  }),

  selects({
    slug: 'select-dir-with-dependents',
    title: 'A directory with its dependents takes the projects there and what builds on them',
    why: 'ui is picked by its path, and core and web build on it. A walk from a directory selector has to reach them as one from a name would. The project nested in core’s folder does not build on ui and stays out.',
    workspace: dirs(),
    all: DIRS,
    select: [{ dir: 'packages/ui', with: 'dependents' }],
    ran: ['ui', 'core', 'web'],
  }),

  // select.test.ts: 'a name or dir no project has is a typo with a git range too'
  refuses({
    slug: 'select-dir-no-match-refused',
    title: 'A directory that holds no project fails the run',
    why: 'A path that matches no project is a typo or a folder that moved. Exiting 0 lets CI pass having checked nothing, exactly as with a name that matches nothing. The run should fail and say so.',
    workspace: dirs(),
    all: DIRS,
    select: [{ dir: 'apps/mobile' }],
  }),

  selects({
    slug: 'select-dir-exclude-alone',
    title: 'A directory glob excluded alone selects every project outside it',
    why: 'An exclude on its own takes from every project, by path as by name. Leaving out apps/* keeps the packages, the nested one too. Reading a lone directory exclude as an empty selection runs nothing and passes.',
    workspace: dirs(),
    all: DIRS,
    select: [{ dir: 'apps/*', exclude: true }],
    ran: ['ui', 'core', 'inner'],
  }),

  // turborepo-scope filter.rs: "select by parentDir with no glob"
  selects({
    slug: 'select-dir-exclude-outer-keeps-nested',
    title: 'Excluding a project by its directory keeps a project nested inside it',
    why: 'A directory names the project there, not every project below it, so excluding packages/core takes out core alone. inner has its own directory and is its own project. Treating the exclude as a whole subtree drops a project the user never named.',
    workspace: dirs(),
    all: DIRS,
    select: [{ dir: 'packages/core', exclude: true }],
    ran: ['ui', 'inner', 'web', 'docs'],
  }),

  // find-matching-projects.spec.ts: 'should support glob patterns for project roots' (`**/nested`)
  selects({
    slug: 'select-dir-leading-globstar',
    title: 'A directory glob starting with `**` finds the folder at any depth',
    why: '`**/inner` names every project in a folder called inner, however deep. Here that is the one nested inside core. Anchoring the pattern at the root finds nothing, and matching inner’s parent as well runs core, which the pattern does not name.',
    workspace: dirs(),
    all: DIRS,
    select: [{ dir: '**/inner' }],
    ran: ['inner'],
  }),

  // turborepo-scope filter.rs: "select root package by directory"
  selects({
    slug: 'select-dir-root-is-root-project',
    title: 'The workspace root as a directory selects the root project and none of its members',
    why: 'The root directory is the root project’s own folder. As with any project directory, it names that project and not the ones nested in it. Taking every member runs the whole workspace when the user pointed at one project.',
    from: ['filter'],
    workspace: {
      projects: {
        root: { dir: '.', tasks: { check: { command: 'true', inputs: ['tools/**'] } } },
        a: p(),
        b: p(),
      },
      files: { 'tools/t.txt': 't\n' },
    },
    all: ['root', 'a', 'b'],
    select: [{ dir: '.' }],
    ran: ['root'],
  }),

  // filter.test.ts: 'a one-level path glob takes no root project'
  selects({
    slug: 'select-dir-top-level-glob',
    title: 'A `*` directory glob takes the projects one level below the root only',
    why: '`*` as a directory is one level down from the root: tools here. The root itself is not one level down, and packages/a is two. A pattern that also takes the root or reaches deeper runs projects its single star does not cover.',
    from: ['filter'],
    workspace: {
      projects: {
        root: { dir: '.', tasks: { check: { command: 'true', inputs: ['misc/**'] } } },
        tools: p([], { dir: 'tools' }),
        a: p(),
      },
      files: { 'misc/t.txt': 't\n' },
    },
    all: ['root', 'tools', 'a'],
    select: [{ dir: '*' }],
    ran: ['tools'],
  }),

  // --- Names ----------------------------------------------------------------

  refuses({
    slug: 'select-name-glob-no-match-refused',
    title: 'A name pattern that matches no project fails the run',
    why: 'A pattern that matches nothing is as much a typo as a name that matches nothing. `zz*` takes no project here, and exiting 0 lets CI pass having run no check. The run should fail before anything starts.',
    workspace: chain(),
    all: CHAIN,
    select: [{ name: 'zz*' }],
  }),

  // select.test.ts: 'a typo beside a walk that came back empty names the typo'
  refuses({
    slug: 'select-walk-no-match-refused',
    title: 'A walk from a name that matches no project fails the run',
    why: 'The walk starts from nothing, so it reaches nothing. That is a typo in the name, not a project with no dependencies, and the run should fail rather than end green with no task run.',
    workspace: chain(),
    all: CHAIN,
    select: [{ name: 'uii', with: 'dependencies' }],
  }),

  // find-matching-projects.spec.ts: 'should match on name segments' ("Only full segments are matched")
  refuses({
    slug: 'select-part-of-scoped-name-refused',
    title: 'Part of a scoped name, `cor` for `@acme/core`, selects nothing and fails',
    why: 'A bare name may stand for a scoped package when it is the whole name after the scope. `cor` is not: it is only a prefix of core. Selecting `@acme/core` from it turns every short typo into a match. Nothing matches, so the run fails.',
    workspace: {
      projects: {
        '@acme/core': p([], { dir: 'packages/core' }),
        app: p(),
      },
    },
    all: ['@acme/core', 'app'],
    select: [{ name: 'cor' }],
  }),

  // find-matching-projects.spec.ts: 'should handle case where scope and names are the same'
  selects({
    slug: 'select-bare-name-same-as-scope',
    title: 'A bare `test` selects `@test/test` and not `@test/test-e2e`',
    why: '`test` is the whole name after the scope of `@test/test`, so it selects that package. `@test/test-e2e` only starts with it. Matching on the scope, which both share, or by prefix runs the end-to-end suite the user did not name.',
    workspace: {
      projects: {
        '@test/test': p([], { dir: 'packages/test' }),
        '@test/test-e2e': p([], { dir: 'packages/test-e2e' }),
      },
    },
    all: ['@test/test', '@test/test-e2e'],
    select: [{ name: 'test' }],
    ran: ['@test/test'],
  }),

  // turborepo-scope filter.rs: "select by parentDir and exclude one package by pattern"
  selects({
    slug: 'select-scope-glob-minus-one',
    title: '`@acme/*` minus one scoped package selects the rest of the scope',
    why: 'The scope glob takes every `@acme` package and the exclude takes one back. What is left is the rest of that scope and nothing outside it. app is not in the scope and must not come in when the exclude is read.',
    workspace: {
      projects: {
        '@acme/core': p([], { dir: 'packages/core' }),
        '@acme/utils': p([], { dir: 'packages/utils' }),
        '@acme/slow-e2e': p([], { dir: 'packages/slow-e2e' }),
        app: p(),
      },
    },
    all: ['@acme/core', '@acme/utils', '@acme/slow-e2e', 'app'],
    select: [{ name: '@acme/*' }, { name: '@acme/slow-e2e', exclude: true }],
    ran: ['@acme/core', '@acme/utils'],
  }),

  selects({
    slug: 'select-nested-project-by-name',
    title: 'Selecting a project nested in another by name runs it and not the outer one',
    why: 'inner lives in core’s folder but is a project of its own. Its name selects it alone. Running core as well treats the folder as the selection, and the name the user typed stops meaning one project.',
    workspace: dirs(),
    all: DIRS,
    select: [{ name: 'inner' }],
    ran: ['inner'],
  }),

  // --- Where the run starts -------------------------------------------------

  // turborepo pkg_inference_test.rs; member-cwd.test.ts
  selects({
    slug: 'select-name-from-another-project',
    title: 'Run from inside one project, a name selects the project it names',
    why: 'Starting a run inside app is common: a developer’s terminal stays there. A selector naming lib still means lib. Adding app because the run started there, or narrowing the selector to app’s folder, makes the same command select different projects by where it is typed.',
    from: ['member-cwd', 'filter'],
    workspace: chain(),
    all: CHAIN,
    select: [{ name: 'lib' }],
    cwd: 'packages/app',
    ran: ['lib'],
  }),

  selects({
    slug: 'select-exclude-alone-from-a-project',
    title: 'Run from inside a project, an exclude alone still takes from every project',
    why: 'An exclude on its own means every project but that one, from wherever the run starts. Started inside app, a tool that begins from app alone and takes lib out runs app only. The same line in CI, run from the root, runs three projects.',
    from: ['member-cwd', 'filter'],
    workspace: chain(),
    all: CHAIN,
    select: [{ name: 'lib', exclude: true }],
    cwd: 'packages/app',
    ran: ['app', 'ui', 'utils'],
  }),

  selects({
    slug: 'select-walk-from-another-project',
    title: 'Run from inside one project, a walk from another starts where it names',
    why: 'The walk starts from ui, which the selector names, not from the project the terminal sits in. Run from lib’s folder, it still takes ui and utils. Starting from lib, or adding it, gives a different set than the same command at the root.',
    from: ['member-cwd', 'filter'],
    workspace: chain(),
    all: CHAIN,
    select: [{ name: 'ui', with: 'dependencies' }],
    cwd: 'packages/lib',
    ran: ['ui', 'utils'],
  }),

  // turborepo-scope filter.rs: test_filter_from_directory_selects_child_packages
  selects({
    slug: 'select-glob-from-a-folder-of-projects',
    title: 'Run from the folder that holds the projects, a name pattern selects as from the root',
    why: 'packages holds every project but is not one. A name pattern names projects, not paths, so `u*` takes ui and utils wherever the run starts. Narrowing to what the folder holds is harmless here, but adding every project in it runs app and lib, which the pattern does not match.',
    from: ['member-cwd', 'filter'],
    workspace: chain(),
    all: CHAIN,
    select: [{ name: 'u*' }],
    cwd: 'packages',
    ran: ['ui', 'utils'],
  }),

  selects({
    slug: 'select-name-from-a-folder-outside-projects',
    title: 'Run from a folder that is no project, a name selects the project it names',
    why: 'Scripts often run from a tools folder at the root. That folder is in no project, so nothing about it can narrow or widen the selection. The name selects ui, as from the root.',
    from: ['member-cwd', 'filter'],
    workspace: { ...chain(), files: { 'tools/run.sh': 'true\n' } },
    all: CHAIN,
    select: [{ name: 'ui' }],
    cwd: 'tools',
    ran: ['ui'],
  }),

  // --- Skipping dependencies under a selection ------------------------------

  // turborepo task_filter_package_scope_test.rs: only_filter_matches_general_path_for_exclude_selectors
  defineCase({
    id: 'graph/only-with-exclude',
    category: 'graph',
    kind: 'correctness',
    title: 'Skipping dependencies with a project excluded runs every other project’s task',
    why: 'Every project but ui is selected, and dependencies are skipped. app’s check needs ui’s, but skipping dependencies means it does not wait for or run it. ui was excluded, so nothing brings it back. The others run.',
    from: ['exclude-dependencies-properties', 'filter'],
    needs: ['filter'],
    workspace: linked(),
    steps: [
      {
        run: 'check',
        select: [{ name: 'ui', exclude: true }],
        only: true,
        expect: { exit: 0, ran: checks(['app', 'utils', 'lib']), notRan: ['ui#check'] },
      },
    ],
  }),

  // turborepo task_filter_package_scope_test.rs: --filter=tag:ci --only
  defineCase({
    id: 'graph/only-with-tag',
    category: 'graph',
    kind: 'correctness',
    title: 'Skipping dependencies with a tag selected runs the tagged projects alone',
    why: 'site builds on lib, but dependencies are skipped, so only the web projects run. lib is untagged and not asked for. Running it ignores the skip; running nothing ignores the tag.',
    from: ['exclude-dependencies-properties', 'project-tags'],
    needs: ['filter', 'select-tag'],
    workspace: tagged(q),
    steps: [
      {
        run: 'check',
        select: [{ tag: 'web' }],
        only: true,
        expect: { exit: 0, ran: checks(['site', 'admin']), notRan: checks(['api', 'lib']) },
      },
    ],
  }),

  // turborepo task_filter_package_scope_test.rs: only_filter_matches_general_path_for_glob_selectors
  defineCase({
    id: 'graph/only-walk-keeps-order',
    category: 'graph',
    kind: 'correctness',
    title: 'Skipping dependencies over a walk runs every walked project, in order',
    why: 'The walk asks for app, ui and utils by name, so none of them is a skipped dependency: each is requested. Skipping dependencies drops only what nobody asked for. The order between requested tasks stays, so utils finishes before ui and ui before app.',
    from: ['exclude-dependencies-properties', 'filter'],
    needs: ['filter', 'select-walk'],
    workspace: linked(),
    steps: [
      {
        run: 'check',
        select: [{ name: 'app', with: 'dependencies' }],
        only: true,
        expect: {
          exit: 0,
          ran: checks(['app', 'ui', 'utils']),
          notRan: ['lib#check'],
          order: [
            ['utils#check', 'ui#check'],
            ['ui#check', 'app#check'],
          ],
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/only-skips-same-project-dependency',
    category: 'graph',
    kind: 'correctness',
    title: 'Skipping dependencies skips the project’s own task that the selected one needs',
    why: 'test depends on build in the same project. Skipping dependencies covers that edge as much as one to another project: build is not asked for and does not run. A tool that skips only other projects’ tasks runs build anyway.',
    from: ['exclude-dependencies-properties'],
    needs: ['filter'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: T('mkdir -p dist && cp src/a.txt dist/b.txt', { outputs: ['dist/**'] }),
            test: T('true', { dependsOn: ['build'] }),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        run: 'test',
        projects: ['a'],
        only: true,
        expect: {
          exit: 0,
          ran: ['a#test'],
          notRan: ['a#build'],
          files: { 'packages/a/dist/b.txt': null },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/only-skips-named-task-of-other-project',
    category: 'graph',
    kind: 'correctness',
    title: 'Skipping dependencies skips a task the selected one names in another project',
    why: 'app’s check names `gen#gen`, an edge no package manifest holds. It is still a dependency, and skipping dependencies skips it. Running gen anyway breaks the promise the user relied on to keep the run short.',
    from: ['exclude-dependencies-properties', 'task-edge-selection'],
    needs: ['filter'],
    workspace: {
      projects: {
        gen: { tasks: { gen: T('true') }, files: { 'src/a.txt': 'g\n' } },
        app: {
          tasks: { check: T('true', { dependsOn: ['gen#gen'] }) },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        run: 'check',
        projects: ['app'],
        only: true,
        expect: { exit: 0, ran: ['app#check'], notRan: ['gen#gen'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/only-skips-pattern-dependencies',
    category: 'graph',
    kind: 'correctness',
    title: 'Skipping dependencies skips every task a `lint.*` pattern names',
    why: 'A pattern in dependsOn is a list of edges written short. Skipping dependencies skips each of them, as it would skip them written out. Running the matched lints anyway treats the pattern as part of the task instead of what it depends on.',
    from: ['exclude-dependencies-properties'],
    needs: ['filter', 'task-pattern'],
    workspace: {
      projects: {
        a: {
          tasks: {
            'lint.x': T('true'),
            'lint.y': T('true'),
            check: T('true', { dependsOn: ['lint.*'] }),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        run: 'check',
        projects: ['a'],
        only: true,
        expect: { exit: 0, ran: ['a#check'], notRan: ['a#lint.x', 'a#lint.y'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/only-two-requested-tasks-keep-their-edge',
    category: 'graph',
    kind: 'correctness',
    title:
      'Skipping dependencies with both a task and its prerequisite asked for runs both, in order',
    why: 'build is asked for by name beside test, so it is no skipped dependency. Both run, and test still waits for build, since the edge between two requested tasks stays. Running them side by side lets test read a half-written build.',
    from: ['exclude-dependencies-properties'],
    needs: ['filter', 'multi-task'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: T('mkdir -p dist && sleep 0.3 && cp src/a.txt dist/b.txt', {
              outputs: ['dist/**'],
            }),
            test: T('cat dist/b.txt', { dependsOn: ['build'] }),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        run: 'test',
        also: ['build'],
        projects: ['a'],
        only: true,
        expect: { exit: 0, ran: ['a#build', 'a#test'], order: [['a#build', 'a#test']] },
      },
    ],
  }),

  // --- Several tasks in one run ---------------------------------------------

  defineCase({
    id: 'graph/also-over-a-selection',
    category: 'graph',
    kind: 'correctness',
    title: 'Two tasks asked for over a selection run in the selected project only',
    why: 'Each task the run asks for covers the same selection. ui is selected, so its check and lint run, and lib’s do not. Applying the selection to the first task alone runs lint everywhere.',
    from: ['task-selection', 'filter'],
    needs: ['filter', 'multi-task'],
    workspace: {
      projects: {
        ui: { tasks: { check: T('true'), lint: T('true') }, files: { 'src/a.txt': 'u\n' } },
        lib: { tasks: { check: T('true'), lint: T('true') }, files: { 'src/a.txt': 'l\n' } },
      },
    },
    steps: [
      {
        run: 'check',
        also: ['lint'],
        select: [{ name: 'ui' }],
        expect: { exit: 0, ran: ['ui#check', 'ui#lint'], notRan: ['lib#check', 'lib#lint'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/also-exclude-takes-out-both-tasks',
    category: 'graph',
    kind: 'correctness',
    title: 'An excluded project runs neither of two tasks a run asks for',
    why: 'Excluding lib takes the project out of the run, for every task named. Its check and lint both stay off. A tool that applies the exclude to one task name runs the other in the project the user left out.',
    from: ['task-selection', 'filter'],
    needs: ['filter', 'multi-task'],
    workspace: {
      projects: {
        ui: { tasks: { check: T('true'), lint: T('true') }, files: { 'src/a.txt': 'u\n' } },
        lib: { tasks: { check: T('true'), lint: T('true') }, files: { 'src/a.txt': 'l\n' } },
      },
    },
    steps: [
      {
        run: 'check',
        also: ['lint'],
        select: [{ name: 'lib', exclude: true }],
        expect: { exit: 0, ran: ['ui#check', 'ui#lint'], notRan: ['lib#check', 'lib#lint'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/also-cross-project-edge-between-requested-tasks',
    category: 'graph',
    kind: 'correctness',
    title: 'Asked for lint and build at once, a project’s lint waits for its dependency’s build',
    why: 'app’s lint needs lib’s build, and both names are in the run. That makes lib’s build both requested and a dependency: it runs once, before app’s lint. Starting the lint early reads lib’s output before it exists.',
    from: ['task-selection', 'graph-order'],
    needs: ['multi-task'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: T('mkdir -p dist && sleep 0.3 && cp src/a.txt dist/out.txt', {
              outputs: ['dist/**'],
            }),
            lint: T('true'),
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: T('true'),
            lint: T('cat ../lib/dist/out.txt', { dependsOn: ['^build'] }),
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      {
        run: 'lint',
        also: ['build'],
        expect: {
          exit: 0,
          ran: ['lib#build', 'lib#lint', 'app#build', 'app#lint'],
          order: [['lib#build', 'app#lint']],
        },
      },
    ],
  }),

  // --- Concurrency ----------------------------------------------------------

  defineCase({
    id: 'graph/concurrency-one-keeps-dependency-order',
    category: 'graph',
    kind: 'correctness',
    title: 'At a concurrency of 1, a diamond still builds each dependency before what needs it',
    why: 'One slot only says how many tasks run at once, not which go first. The base builds first, then the two sides in any order, then the top. A tool that fills its one slot by name or by declaration order can start the top before a side it reads.',
    from: ['run-concurrency', 'scheduler'],
    workspace: {
      projects: {
        base: chainProject('base'),
        left: chainProject('left', ['base']),
        right: chainProject('right', ['base']),
        aaa: chainProject('aaa', ['left', 'right']),
      },
    },
    steps: [
      {
        run: 'build',
        concurrency: 1,
        expect: {
          exit: 0,
          order: [
            ['base#build', 'left#build'],
            ['base#build', 'right#build'],
            ['left#build', 'aaa#build'],
            ['right#build', 'aaa#build'],
          ],
          files: { [out('aaa')]: 'base\nleft\nbase\nright\naaa\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/concurrency-one-failure-runs-the-rest',
    category: 'graph',
    kind: 'correctness',
    title: 'At a concurrency of 1, a failed task skips only what depends on it',
    why: 'With one slot, the tasks after a failure are still waiting when it fails. Those that do not depend on it must still run, as they would with more slots. A tool that drains its queue at the first failure leaves unrelated work undone at concurrency 1 only.',
    from: ['run-concurrency', 'scheduler'],
    workspace: {
      projects: {
        bad: { tasks: { build: T('exit 1') }, files: { 'src/a.txt': 'b\n' } },
        top: {
          deps: ['bad'],
          tasks: { build: T('true', { dependsOn: ['^build'] }) },
          files: { 'src/a.txt': 't\n' },
        },
        x: { tasks: { build: T('true') }, files: { 'src/a.txt': 'x\n' } },
        y: { tasks: { build: T('true') }, files: { 'src/a.txt': 'y\n' } },
      },
    },
    steps: [
      {
        run: 'build',
        concurrency: 1,
        expect: { exit: 'fail', ran: ['x#build', 'y#build'], notRan: ['top#build'] },
      },
    ],
  }),

  // --- Planned runs ---------------------------------------------------------

  // turborepo filter_run_test.rs: test_filter_nonexistent_package_errors
  defineCase({
    id: 'graph/dry-run-selector-no-match-refused',
    category: 'graph',
    kind: 'correctness',
    title: 'Planning a run with a selector that matches no project fails',
    why: 'A plan is how a user checks a command before trusting it in CI. A selector that matches nothing fails the real run, so the plan must fail too. A plan that succeeds there tells the user the command is fine when it is not.',
    from: ['dry-no-writes', 'select'],
    needs: ['filter', 'dry-run'],
    workspace: built(),
    steps: [{ run: 'build', select: [{ name: 'nope' }], dry: true, expect: { exit: 'fail' } }],
  }),

  // turborepo missing_tasks_test.rs: test_single_missing_task
  defineCase({
    id: 'graph/dry-run-unknown-task-refused',
    category: 'graph',
    kind: 'correctness',
    title: 'Planning a run of a task no project declares fails',
    why: 'A task name nobody declares fails the real run. Planning it has to find the same thing, since the plan is where the user expects to see a typo. A green plan for a task that does not exist is a plan of nothing.',
    from: ['dry-no-writes', 'task-selection'],
    needs: ['dry-run'],
    workspace: built(),
    steps: [{ run: 'biuld', dry: true, expect: { exit: 'fail' } }],
  }),

  defineCase({
    id: 'graph/dry-run-task-cycle-refused',
    category: 'graph',
    kind: 'correctness',
    title: 'Planning a run whose tasks depend on each other fails',
    why: 'Two tasks that each wait for the other can never run, and the real run fails before either starts. A plan has to see the cycle too: it is a property of the graph, not of running it. A plan that passes hides a config the real run will refuse.',
    from: ['dry-no-writes', 'task-graph'],
    needs: ['dry-run'],
    workspace: {
      projects: {
        a: {
          tasks: { build: T('true', { dependsOn: ['b#build'] }) },
          files: { 'src/a.txt': 'a\n' },
        },
        b: {
          tasks: { build: T('true', { dependsOn: ['a#build'] }) },
          files: { 'src/a.txt': 'b\n' },
        },
      },
    },
    steps: [{ run: 'build', dry: true, expect: { exit: 'fail' } }],
  }),

  defineCase({
    id: 'graph/dry-run-forced-runs-nothing',
    category: 'graph',
    kind: 'correctness',
    title: 'Planning a forced run runs no task and writes no output',
    why: 'Forcing says to ignore the cache when tasks run; planning says not to run them. Together they plan a run that would rebuild everything, and run nothing. A tool that lets the force win runs every task during what the user meant as a look.',
    from: ['dry-no-writes'],
    needs: ['dry-run', 'force'],
    workspace: built(),
    steps: [
      {
        run: 'build',
        force: true,
        dry: true,
        expect: {
          exit: 0,
          notRan: ['utils#build', 'ui#build', 'app#build', 'lib#build'],
          files: { [out('utils')]: null, [out('app')]: null },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/dry-run-of-a-walk-runs-nothing',
    category: 'graph',
    kind: 'correctness',
    title: 'Planning a run over a dependency walk runs none of the walked tasks',
    why: 'A walk can select many projects, which is exactly when a user plans first. Every task the walk takes stays unrun and no output appears. A plan that runs the dependencies to work out the rest is no plan.',
    from: ['dry-no-writes', 'filter'],
    needs: ['filter', 'select-walk', 'dry-run'],
    workspace: built(),
    steps: [
      {
        run: 'build',
        select: [{ name: 'app', with: 'dependencies' }],
        dry: true,
        expect: {
          exit: 0,
          notRan: ['utils#build', 'ui#build', 'app#build'],
          files: { [out('utils')]: null, [out('ui')]: null },
        },
      },
    ],
  }),

  // --- More from the same sources -------------------------------------------

  // turborepo-scope filter.rs: "select by parentDir with no glob"
  selects({
    slug: 'select-dir-whatever-the-name',
    title: 'A directory selects the project in it, whatever that project is called',
    why: 'packages/kit holds a project named toolkit, and the path picks it by where it lives. Another project is named kit but lives elsewhere. Matching the folder’s base name against project names picks the wrong one.',
    workspace: {
      projects: {
        toolkit: p([], { dir: 'packages/kit' }),
        kit: p([], { dir: 'packages/other' }),
      },
    },
    all: ['toolkit', 'kit'],
    select: [{ dir: 'packages/kit' }],
    ran: ['toolkit'],
  }),

  refuses({
    slug: 'select-name-is-not-a-folder-name',
    title: 'A name never matches a project by the name of its folder',
    why: '`other` is the folder of the project named kit, but no project is named other. A name selector reads names; matching folder names too makes the meaning of a selector change whenever a folder is renamed. Nothing matches, so the run fails.',
    workspace: {
      projects: {
        toolkit: p([], { dir: 'packages/kit' }),
        kit: p([], { dir: 'packages/other' }),
      },
    },
    all: ['toolkit', 'kit'],
    select: [{ name: 'other' }],
  }),

  selects({
    slug: 'select-outer-project-from-nested-one',
    title: 'Run from inside a nested project, the outer project’s name selects only the outer one',
    why: 'The terminal sits in inner, which lives inside core’s folder. The selector names core, and core is what runs. Adding inner because the run started there, or reading core as its folder and taking inner with it, selects a project nobody named.',
    from: ['member-cwd', 'filter'],
    workspace: dirs(),
    all: DIRS,
    select: [{ name: 'core' }],
    cwd: 'packages/core/inner',
    ran: ['core'],
  }),

  defineCase({
    id: 'graph/select-dependents-through-diamond-ordered',
    category: 'graph',
    kind: 'correctness',
    title: 'A library’s dependents through a diamond run after it, the top after both sides',
    why: 'Both sides of the diamond build on base, and the top builds on both sides. Selecting base with its dependents takes all four, and each still waits for what it depends on. solo is unrelated and stays out.',
    from: ['filter', 'graph-order'],
    needs: ['filter', 'select-walk'],
    workspace: {
      projects: {
        base: q(),
        left: q(['base']),
        right: q(['base']),
        top: q(['left', 'right']),
        solo: q(),
      },
    },
    steps: [
      {
        run: 'check',
        select: [{ name: 'base', with: 'dependents' }],
        expect: {
          exit: 0,
          ran: checks(['base', 'left', 'right', 'top']),
          notRan: ['solo#check'],
          order: [
            ['base#check', 'left#check'],
            ['base#check', 'right#check'],
            ['left#check', 'top#check'],
            ['right#check', 'top#check'],
          ],
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/select-unselected-dependency-failure',
    category: 'graph',
    kind: 'correctness',
    title:
      'A dependency outside the selection that fails skips its dependant, and the rest of the selection runs',
    why: 'lib is not selected but app’s build needs it, so it runs, and fails. app cannot build without it and is skipped. docs is selected and needs nothing from lib, so it runs; the run still fails, since a task did.',
    from: ['filter', 'task-selection'],
    needs: ['filter'],
    workspace: {
      projects: {
        lib: { tasks: { build: T('exit 1') }, files: { 'src/a.txt': 'l\n' } },
        app: {
          deps: ['lib'],
          tasks: { build: T('true', { dependsOn: ['^build'] }) },
          files: { 'src/a.txt': 'a\n' },
        },
        docs: { tasks: { build: T('true') }, files: { 'src/a.txt': 'd\n' } },
      },
    },
    steps: [
      {
        run: 'build',
        select: [{ name: 'app' }, { name: 'docs' }],
        expect: { exit: 'fail', ran: ['docs#build'], notRan: ['app#build'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/only-dependents-without-the-library',
    category: 'graph',
    kind: 'correctness',
    title: 'Skipping dependencies over only a library’s dependents runs no library task',
    why: 'The library is left out of the selection and dependencies are skipped, so nothing brings it back. ui and app run against what is already on disk. Running utils anyway ignores both things the user said.',
    from: ['exclude-dependencies-properties', 'filter'],
    needs: ['filter', 'select-walk'],
    workspace: linked(),
    steps: [
      {
        run: 'check',
        select: [{ name: 'utils', with: 'dependents', self: false }],
        only: true,
        expect: { exit: 0, ran: checks(['ui', 'app']), notRan: checks(['utils', 'lib']) },
      },
    ],
  }),

  defineCase({
    id: 'graph/dry-run-args-for-many-projects-refused',
    category: 'graph',
    kind: 'correctness',
    title: 'Planning a run that forwards args to one task in many projects is refused',
    why: 'Args after `--` may reach one task only, and the real run refuses them for two projects. The plan must refuse them as well, or the user learns of the problem only in CI. Planning runs nothing either way: no file appears.',
    from: ['dry-no-writes', 'forward-args-one-task'],
    needs: ['dry-run'],
    workspace: {
      projects: {
        one: { tasks: { t: { command: `printf '<%s>' "$@" > got.txt`, takesArgs: true } } },
        two: { tasks: { t: { command: `printf '<%s>' "$@" > got.txt`, takesArgs: true } } },
      },
    },
    steps: [
      {
        run: 't',
        args: ['--port', '3000'],
        dry: true,
        expect: {
          exit: 'fail',
          files: { 'packages/one/got.txt': null, 'packages/two/got.txt': null },
        },
      },
    ],
  }),
] satisfies Case[]

// vx warns and runs ui: a selector that matches nothing beside one that matches
// is a warning by design (docs/cli.md), where Turborepo refuses any unknown name.
export const pending: Case[] = [
  // select.test.ts: 'the refusal names only the filters that matched nothing'
  refuses({
    slug: 'select-typo-beside-a-match-refused',
    title: 'A selector that matches nothing fails the run, though another selector matches',
    why: 'ui matches and `nope` does not. The second selector is still a typo, and running ui alone hides that the user meant two projects. Failing before anything starts names the selector to fix; a green run checks half of what was asked.',
    workspace: chain(),
    all: CHAIN,
    select: [{ name: 'ui' }, { name: 'nope' }],
  }),
]
