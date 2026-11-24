// What a workspace may say and what a tool must do with it: manifests,
// task values, dependsOn entries, task names, glob and variable spellings.
// A value no reading can make right is refused before anything runs; a
// value with one sensible reading is honoured, or refused, but never
// silently dropped. Drawn from Turborepo's crates/turborepo/tests
// (invalid_package_json_test.rs, absolute_path_error_test.rs,
// unnamed_packages_test.rs, path_with_spaces_test.rs) and
// crates/turborepo-repository (package_json.rs, discovery), Nx's
// project-graph and target validation, moon's crates/config tests, and
// vx's own config-schema, discovery and timeout tests.
import {
  defineCase,
  type Case,
  type Expect,
  type Feature,
  type Step,
  type TaskSpec,
  type WorkspaceSpec,
} from '../src/spec.ts'

const A = 'packages/a'
const OUT = `${A}/dist/out.txt`
const BUILD: TaskSpec = {
  command: 'mkdir -p dist && cat src/*.txt > dist/out.txt',
  inputs: ['src/**'],
  outputs: ['dist/**'],
}
const SCHEMA = ['config-schema-refusals', 'config-refusals-pinned']
const DISCOVERY = ['discovery-refusals', 'package-json-bom']

interface Head {
  slug: string
  title: string
  why: string
  from?: string[]
  needs?: Feature[]
}

function make(
  h: Head,
  workspace: WorkspaceSpec,
  steps: Step[],
  kind: Case['kind'] = 'correctness',
) {
  return defineCase({
    id: `config/${h.slug}`,
    category: 'config',
    kind,
    title: h.title,
    why: h.why,
    from: h.from ?? SCHEMA,
    ...(h.needs ? { needs: h.needs } : {}),
    workspace,
    steps,
  })
}

const REFUSED = {
  run: 'build',
  expect: { exit: 'fail', notRan: ['a#build'], files: { [OUT]: null }, orRefused: true },
} as const satisfies Step

/** Project `a`'s build with `extra` (and more tasks beside it): the run fails, nothing built. */
function refuseTask(h: Head, extra: Partial<TaskSpec>, more: Record<string, TaskSpec> = {}): Case {
  return make(
    h,
    {
      projects: {
        a: { tasks: { build: { ...BUILD, ...extra }, ...more }, files: { 'src/a.txt': 'a\n' } },
      },
    },
    [REFUSED],
  )
}

/**
 * Project `a`'s build over `inputs`, its command reading `reads`: after
 * `edit` changes a file, the build runs again with the new bytes, or the
 * tool refused the inputs from the start. A replay of the old result fails.
 */
function keyedOrRefused(
  h: Head,
  inputs: string[],
  edit: string,
  opts: { reads?: string; sibling?: true } = {},
): Case {
  const reads = opts.reads ?? edit.replace(`${A}/`, '')
  return make(
    h,
    {
      projects: {
        a: {
          tasks: {
            build: {
              command: `mkdir -p dist && cat ${reads} > dist/out.txt`,
              inputs,
              outputs: ['dist/**'],
            },
          },
          files: { [opts.sibling ? 'src/a.txt' : reads]: 'one\n' },
        },
        ...(opts.sibling ? { b: { files: { 'src/a.txt': 'one\n' } } } : {}),
      },
    },
    [
      { run: 'build', expect: { exit: 0, orRefused: true } },
      { write: { [edit]: 'two\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'two\n' }, orRefused: true },
      },
    ],
  )
}

/** Projects `a` and `b`, then `b`'s package.json replaced by `manifest`: the run fails, building nothing. */
function badManifest(h: Head, manifest: string): Case {
  return make(
    { ...h, from: h.from ?? DISCOVERY },
    {
      projects: {
        a: { tasks: { build: BUILD }, files: { 'src/a.txt': 'a\n' } },
        b: { tasks: { build: BUILD }, files: { 'src/a.txt': 'b\n' } },
      },
    },
    [
      { write: { 'packages/b/package.json': manifest } },
      { run: 'build', expect: { exit: 'fail', notRan: ['a#build', 'b#build'], orRefused: true } },
    ],
  )
}

/** `lib` ← `app`, `app`'s package.json written as `manifest` (it names lib): both build, lib first. */
function goodManifest(h: Head, manifest: string, from = DISCOVERY): Case {
  return make(
    { ...h, from: h.from ?? from },
    {
      projects: {
        lib: { tasks: { build: BUILD }, files: { 'src/a.txt': 'lib\n' } },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              ...BUILD,
              command: 'mkdir -p dist && cat ../lib/dist/out.txt src/*.txt > dist/out.txt',
              dependsOn: ['^build'],
            },
          },
          files: { 'src/a.txt': 'app\n', 'package.json': manifest },
        },
      },
    },
    [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          order: [['lib#build', 'app#build']],
          files: { 'packages/app/dist/out.txt': 'lib\napp\n' },
        },
      },
    ],
  )
}

/** Projects `a` and `b`, `b`'s package.json written as `manifest`: both builds run, or the run is refused. */
function nameless(h: Head, manifest: string): Case {
  return make(
    { ...h, from: h.from ?? DISCOVERY },
    {
      projects: {
        a: { tasks: { build: BUILD }, files: { 'src/a.txt': 'a\n' } },
        b: { tasks: { build: BUILD }, files: { 'src/a.txt': 'b\n', 'package.json': manifest } },
      },
    },
    [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#build', 'b#build'],
          files: { 'packages/b/dist/out.txt': 'b\n' },
          orRefused: true,
        },
      },
    ],
  )
}

const appManifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      name: 'app',
      version: '0.0.0',
      private: true,
      dependencies: { lib: 'workspace:*' },
      ...extra,
    },
    null,
    2,
  )

/** The root manifest the harness writes, with these workspaces globs. */
const rootManifest = (workspaces: unknown) =>
  JSON.stringify(
    { name: 'conformance', private: true, packageManager: `bun@${Bun.version}`, workspaces },
    null,
    2,
  )

/** `gen` then `build` in project `a`, build's dependsOn holding `dep`. */
function dependsOnWs(dep: string[]): WorkspaceSpec {
  return {
    projects: {
      a: {
        tasks: {
          gen: {
            command: 'mkdir -p gen && echo gen > gen/g.txt',
            inputs: ['src/**'],
            outputs: ['gen/**'],
          },
          build: {
            command: 'mkdir -p dist && cat gen/g.txt src/*.txt > dist/out.txt',
            dependsOn: dep,
            inputs: ['src/**'],
            outputs: ['dist/**'],
          },
        },
        files: { 'src/a.txt': 'a\n' },
      },
    },
  }
}

const GEN_THEN_BUILD: Expect = {
  exit: 0,
  ran: ['a#gen', 'a#build'],
  order: [['a#gen', 'a#build']],
  files: { [OUT]: 'gen\na\n' },
}

const COUNT = 'count.txt'

export default [
  // ---- manifests -------------------------------------------------------

  // invalid_package_json_test.rs: an editor that crashed mid-save leaves an empty file.
  badManifest(
    {
      slug: 'empty-manifest-refused',
      title: 'A workspace package whose package.json is an empty file fails the run',
      why: 'An empty manifest is what a crashed editor or an interrupted checkout leaves behind. It holds no name and no dependencies, so the project’s place in the graph is unknown. Reading it as an empty object would build its dependants without their edges; the run fails and names the file.',
    },
    '',
  ),

  // unnamed_packages_test.rs test_unnamed_packages_are_filtered: Turborepo drops it silently.
  nameless(
    {
      slug: 'manifest-without-name-runs-or-refuses',
      title: 'A workspace package with no name field runs its task, or the run fails',
      why: 'The workspace globs list the package and it declares a task, so the user expects it to run. A tool that needs a name may refuse the package, which names the problem. Filtering it out without a word, as Turborepo does, passes a run that never ran the task.',
    },
    '{ "version": "0.0.0", "private": true }\n',
  ),

  // invalid_package_json_test.rs test_empty_name_field
  nameless(
    {
      slug: 'manifest-empty-name-runs-or-refuses',
      title: 'A workspace package whose name is an empty string runs its task, or the run fails',
      why: 'An empty name is a name no reference can use, and Turborepo refuses it with “package.json must have a name field”. A tool that names projects some other way may still run the task. What it must not do is drop the package and pass.',
    },
    '{ "name": "", "version": "0.0.0", "private": true }\n',
  ),

  // discovery.rs: "Failed to add workspace ... already exists"; Nx: multiple projects with one name.
  make(
    {
      slug: 'duplicate-package-name-refused',
      title: 'Two workspace packages with one name fail the run',
      why: 'A name must point at one directory: `^build`, `a#build` and a selector all resolve through it. With two packages called `a`, a tool that keeps the first or the last builds one and silently drops the other, and which one wins can change with directory order. Turborepo and Nx both refuse it; the run fails naming both directories.',
      from: ['discovery-refusals', 'contract-discovery'],
    },
    {
      projects: {
        a: { tasks: { build: BUILD }, files: { 'src/a.txt': 'a\n' } },
        b: { tasks: { build: BUILD }, files: { 'src/a.txt': 'b\n' } },
      },
      files: { 'packages/c/package.json': '{ "name": "a", "version": "0.0.0" }\n' },
    },
    [
      { write: { 'package.json': rootManifest(['packages/a', 'packages/b', 'packages/c']) } },
      { run: 'build', expect: { exit: 'fail', notRan: ['a#build', 'b#build'], orRefused: true } },
    ],
  ),

  // turborepo-repository package_json.rs strips a BOM before parsing.
  goodManifest(
    {
      slug: 'manifest-with-bom-accepted',
      title: 'A package.json that starts with a byte-order mark is read, edges and all',
      why: 'Editors on Windows save JSON with a byte-order mark, and npm, pnpm and Bun all read past it. A tool whose parser chokes on it refuses a valid workspace; one that skips the file loses the dependency and builds the app before its library. Both build, the library first.',
    },
    `﻿${appManifest()}`,
  ),

  goodManifest(
    {
      slug: 'huge-manifest-accepted',
      title: 'A package.json of two megabytes is read like any other',
      why: 'Manifests grow: long descriptions, big `files` lists, embedded tool config. Nothing about size makes one invalid, and npm and Bun install it. A tool with a small read buffer or a size cap refuses or truncates a valid workspace. Both build, the library first.',
    },
    appManifest({ description: 'x'.repeat(2_000_000) }),
  ),

  goodManifest(
    {
      slug: 'manifest-without-version-accepted',
      title: 'A workspace package with no version field builds',
      why: 'A private package that is never published has no use for a version, and package managers install it without one. A task runner reads names and dependencies, not versions. Refusing it, or dropping the package, breaks a workspace every package manager accepts.',
    },
    JSON.stringify({ name: 'app', private: true, dependencies: { lib: 'workspace:*' } }),
  ),

  goodManifest(
    {
      slug: 'manifest-loose-version-accepted',
      title: 'A workspace package whose version is not semver builds',
      why: 'Private packages carry versions like `dev` or `0.x`: the package manager links workspace packages by name, never by version. A task runner that validates semver refuses a workspace that installs fine. Both build, the library first.',
    },
    appManifest({ version: 'dev' }),
  ),

  goodManifest(
    {
      slug: 'manifest-nested-workspaces-field-accepted',
      title:
        'A workspace package that declares its own workspaces field still builds as one package',
      why: 'A package moved in from another repository often keeps its `workspaces` field. Only the root’s list says which directories are projects; a nested one names nothing here. A tool that refuses it, or treats the package as a second root, breaks a workspace the package manager installs.',
      from: ['lock-nested-workspace-name', 'discovery-refusals'],
    },
    appManifest({ workspaces: ['sub/*'] }),
  ),

  goodManifest(
    {
      slug: 'manifest-crlf-and-tabs-accepted',
      title: 'A package.json with CRLF line ends and tab indents is read, edges and all',
      why: 'A manifest checked out on Windows has CRLF line ends, and many formatters indent with tabs. Both are JSON whitespace. A line-based or hand-rolled reader that trips on them drops the dependency and builds the app first; both build, the library first.',
    },
    JSON.stringify(
      { name: 'app', version: '0.0.0', private: true, dependencies: { lib: 'workspace:*' } },
      null,
      '\t',
    ).replaceAll('\n', '\r\n'),
  ),

  goodManifest(
    {
      slug: 'manifest-with-comments-read-or-refused',
      title: 'A package.json holding comments is read with its edges, or the run fails',
      why: 'Bun reads package.json as JSON with comments; npm and strict parsers refuse it. A task runner may take either side. What it must not do is skip the file and build the app before the library it names.',
    },
    `// app\n${appManifest()}`,
  ),

  make(
    {
      slug: 'root-manifest-with-bom-accepted',
      title: 'A root package.json that starts with a byte-order mark still lists every project',
      why: 'The root manifest is the one most often saved by a Windows editor, and package managers read past the mark. A tool that fails to parse it finds no workspaces and either refuses a valid repository or passes having built nothing. Both projects build.',
      from: DISCOVERY,
    },
    {
      projects: {
        a: { tasks: { build: BUILD }, files: { 'src/a.txt': 'a\n' } },
        b: { tasks: { build: BUILD }, files: { 'src/a.txt': 'b\n' } },
      },
    },
    [
      { write: { 'package.json': `\uFEFF${rootManifest(['packages/a', 'packages/b'])}` } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#build', 'b#build'],
          files: { [OUT]: 'a\n', 'packages/b/dist/out.txt': 'b\n' },
        },
      },
    ],
  ),

  make(
    {
      slug: 'project-directory-with-hash',
      title: 'A project whose directory holds `#` builds and replays',
      why: 'Only a project’s name goes into `project#task`; its directory is a path, and `#` is a legal character in one. A tool that builds references from paths, or cuts a path at `#` as a URL fragment, loses the project or its cache entry. It builds, then replays.',
      from: ['workspace-path-chars', 'discovery-refusals'],
    },
    {
      projects: {
        a: { dir: 'packages/a#dir', tasks: { build: BUILD }, files: { 'src/a.txt': 'a\n' } },
      },
    },
    [
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { 'packages/a#dir/dist/out.txt': 'a\n' } },
      },
      { write: { 'packages/a#dir/dist': null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { 'packages/a#dir/dist/out.txt': 'a\n' } },
      },
    ],
  ),

  // package_json.rs: `workspaces: { packages: [...] }`, Yarn's object form.
  make(
    {
      slug: 'workspaces-object-form-accepted',
      title: 'A root package.json listing its workspaces as `{ packages: [...] }` builds them all',
      why: 'Yarn and Bun accept the workspaces list inside an object, next to keys like `nohoist` or `catalog`. Turborepo and Nx read it. A tool that only takes the array form finds no projects and passes having built nothing, or refuses a workspace that installs fine.',
      from: DISCOVERY,
    },
    {
      projects: {
        a: { tasks: { build: BUILD }, files: { 'src/a.txt': 'a\n' } },
        b: { tasks: { build: BUILD }, files: { 'src/a.txt': 'b\n' } },
      },
    },
    [
      { write: { 'package.json': rootManifest({ packages: ['packages/*'] }) } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#build', 'b#build'],
          files: { [OUT]: 'a\n', 'packages/b/dist/out.txt': 'b\n' },
        },
      },
    ],
  ),

  make(
    {
      slug: 'workspaces-glob-matching-nothing-accepted',
      title: 'A workspaces glob that matches no directory is no error',
      why: 'A template lists `apps/*` before the first app exists, and a refactor can empty a folder. A glob matching nothing names no project; the others are still there. A tool that refuses it blocks every run over a placeholder; the projects that exist build.',
      from: DISCOVERY,
    },
    {
      projects: {
        a: { tasks: { build: BUILD }, files: { 'src/a.txt': 'a\n' } },
      },
    },
    [
      { write: { 'package.json': rootManifest(['packages/*', 'apps/*']) } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'a\n' } } },
    ],
  ),

  make(
    {
      slug: 'names-differing-in-case-are-two-projects',
      title: 'Projects named `a` and `A` are two projects: selecting `a` runs only its task',
      why: 'npm names are case-sensitive in a workspace, and two directories can hold `a` and `A`. A tool that folds case merges them, refusing the workspace as a duplicate or running both when one is asked for. Selecting `a` runs `a` alone.',
      from: ['discovery-refusals', 'workspace-path-chars'],
      needs: ['filter'],
    },
    {
      projects: {
        a: { tasks: { build: BUILD }, files: { 'src/a.txt': 'a\n' } },
        A: { dir: 'packages/upper', tasks: { build: BUILD }, files: { 'src/a.txt': 'A\n' } },
      },
    },
    [
      {
        run: 'build',
        projects: ['a'],
        expect: {
          exit: 0,
          ran: ['a#build'],
          notRan: ['A#build'],
          files: { [OUT]: 'a\n', 'packages/upper/dist/out.txt': null },
        },
      },
    ],
  ),

  // ---- time limits and retries ------------------------------------------

  // moon crates/config: a task timeout is a positive number of seconds.
  make(
    {
      slug: 'timeout-zero-refused',
      title: 'A time limit of zero seconds fails the run before the task starts',
      why: 'Zero has two opposite readings: kill the task at once, or no limit at all. Some tools take one, some the other, and a config moved between them flips meaning silently. Refusing it makes the user write what they mean: a real limit, or none.',
      from: ['timeout-bounds', 'task-timeout'],
      needs: ['timeout'],
    },
    {
      projects: {
        a: {
          tasks: {
            // A tool that accepts zero kills the build so soon its mark may never land,
            // and would pass by luck; the prerequisite it runs first always shows it.
            prep: { command: 'true', inputs: ['src/**'] },
            build: { ...BUILD, timeout: 0, dependsOn: ['prep'] },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [{ ...REFUSED, expect: { ...REFUSED.expect, notRan: ['a#prep', 'a#build'] } }],
  ),

  refuseTask(
    {
      slug: 'timeout-negative-refused',
      title: 'A negative time limit fails the run before the task starts',
      why: 'No task can run for minus five seconds. A timer given a negative delay fires at once, so the task is killed before it does anything and the failure reads like a slow task. Refusing it points at the setting.',
      from: ['timeout-bounds', 'task-timeout'],
      needs: ['timeout'],
    },
    { timeout: -5 },
  ),

  refuseTask(
    {
      slug: 'timeout-nan-refused',
      title: 'A time limit that is not a number fails the run before the task starts',
      why: '`Number(process.env.LIMIT)` is NaN when the variable is unset, and a config computes its limit that way. A timer given NaN fires at once in JavaScript, and a comparison with NaN is never true, so the limit is either instant or never. Refusing it names the setting that went wrong.',
      from: ['timeout-bounds', 'task-timeout'],
      needs: ['timeout'],
    },
    { timeout: Number.NaN },
  ),

  make(
    {
      slug: 'timeout-fraction-kills',
      title: 'A half-second time limit kills a task that runs for five',
      why: 'A limit in seconds may have a fraction. A tool that truncates 0.5 to 0 may read that as no limit at all, and the overrunning task finishes and passes. The task is killed within a few seconds and the run fails without its output.',
      from: ['timeout-bounds', 'task-timeout'],
      needs: ['timeout'],
    },
    {
      projects: {
        a: {
          tasks: {
            build: {
              ...BUILD,
              command: 'sleep 5 && mkdir -p dist && echo late > dist/out.txt',
              timeout: 0.5,
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [{ run: 'build', expect: { exit: 'fail', files: { [OUT]: null }, within: 20 } }],
  ),

  make(
    {
      slug: 'timeout-fraction-under-one-spares',
      title: 'A time limit under one second spares a task that finishes inside it',
      why: 'A limit of 0.9 s rounded down to 0 can become an instant kill, failing a task that needed a tenth of the time it had. A fraction is a limit like any other. The quick task succeeds.',
      from: ['timeout-bounds', 'task-timeout'],
      needs: ['timeout'],
    },
    {
      projects: {
        a: { tasks: { build: { ...BUILD, timeout: 0.9 } }, files: { 'src/a.txt': 'a\n' } },
      },
    },
    [{ run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'a\n' } } }],
  ),

  make(
    {
      slug: 'timeout-at-timer-bound-honoured',
      title: 'A time limit of 24 days is a long limit, not an instant kill',
      why: 'JavaScript timers hold at most 2^31−1 ms, about 24.8 days; one more millisecond overflows and fires at once. A limit right at that bound is still a valid limit. The task runs and succeeds.',
      from: ['timeout-bounds'],
      needs: ['timeout'],
    },
    {
      projects: {
        a: {
          tasks: { build: { ...BUILD, timeout: 2_147_483.647 } },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [{ run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'a\n' } } }],
  ),

  make(
    {
      slug: 'timeout-past-timer-bound-not-instant',
      title: 'A time limit just past 24.8 days is honoured or refused, never an instant kill',
      why: 'One millisecond past 2^31−1 ms overflows a JavaScript timer, which then fires at once. A tool may hold the limit some other way, or refuse it, but killing a quick task the moment it starts is the opposite of what was asked. The task succeeds, or the run is refused before it starts.',
      from: ['timeout-bounds'],
      needs: ['timeout'],
    },
    {
      projects: {
        a: { tasks: { build: { ...BUILD, timeout: 2_147_484 } }, files: { 'src/a.txt': 'a\n' } },
      },
    },
    [
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'a\n' }, orRefused: true },
      },
    ],
  ),

  refuseTask(
    {
      slug: 'retries-negative-refused',
      title: 'A negative retry count fails the run before the task starts',
      why: 'A task cannot be retried minus one times. A loop that counts down from −1 may never reach zero and retry a failing task without end, or skip the first attempt. Refusing it points at the setting.',
      from: ['retries', 'flaky-retry'],
      needs: ['retries'],
    },
    { retries: -1 },
  ),

  refuseTask(
    {
      slug: 'retries-fraction-refused',
      title: 'A retry count of 1.5 fails the run before the task starts',
      why: 'Attempts are whole. Rounding 1.5 up or down picks a count the user did not write, and a `while (n > 0)` loop runs it twice where `n-- > 0` would not. Refusing it makes the count exact.',
      from: ['retries', 'flaky-retry'],
      needs: ['retries'],
    },
    { retries: 1.5 },
  ),

  refuseTask(
    {
      slug: 'retries-past-any-count-refused',
      title: 'A retry count past 2^53 fails the run before the task starts',
      why: 'Past 2^53 a number no longer counts by ones: subtracting one leaves it unchanged, so a failing task retries forever. No user means a quintillion attempts. Refusing it keeps a typo from hanging CI.',
      from: ['retries', 'config-schema-refusals'],
      needs: ['retries'],
    },
    { retries: 2 ** 60 },
  ),

  make(
    {
      slug: 'retries-zero-runs-once',
      title: 'A retry count of zero runs a failing task once',
      why: 'Zero retries means the first attempt is the only one. A tool that reads 0 as “use the default” retries anyway and hides a failure behind a pass on the second try. The task runs once and the run fails.',
      from: ['retries', 'flaky-retry'],
      needs: ['retries'],
    },
    {
      projects: {
        a: {
          tasks: { build: { ...BUILD, command: `echo x >> ../../${COUNT} && exit 1`, retries: 0 } },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [{ run: 'build', expect: { exit: 'fail', files: { [COUNT]: 'x\n' } } }],
  ),

  // ---- dependsOn entries -------------------------------------------------

  make(
    {
      slug: 'depends-on-empty-string-refused',
      title: 'An empty string in dependsOn fails the run',
      why: 'An empty entry names no task. It is what `process.env.DEP ?? ""` leaves, or a deleted name. A tool that skips it runs the task without whatever the entry was meant to name; the run fails before anything starts.',
      from: ['task-graph-properties', 'config-schema-refusals'],
    },
    dependsOnWs(['']),
    [REFUSED],
  ),

  make(
    {
      slug: 'depends-on-surrounding-space-runs-or-refuses',
      title: 'A dependsOn entry with a space before the name runs that task first or fails the run',
      why: '` gen` is `gen` with a stray space. Reading it as the task `gen` is right, and refusing it as no such task is right; what is wrong is running the build with no edge, so it reads a file `gen` never wrote. Either gen runs first, or nothing runs.',
      from: ['task-graph-properties', 'config-schema-refusals'],
    },
    dependsOnWs([' gen']),
    [{ run: 'build', expect: { ...GEN_THEN_BUILD, orRefused: true } }],
  ),

  make(
    {
      slug: 'depends-on-repeated-entry-runs-once',
      title: 'A task listed twice in dependsOn runs once, before its dependant',
      why: 'A list built by spreading two shared presets often names a task twice. It is one edge, and the task runs once. A tool that schedules each entry runs it twice, racing two writers into one output, or refuses a harmless list.',
      from: ['task-graph-properties'],
    },
    dependsOnWs(['gen', 'gen']),
    [{ run: 'build', expect: GEN_THEN_BUILD }],
  ),

  make(
    {
      slug: 'depends-on-two-spellings-runs-once',
      title: '`gen` and `a#gen` in one dependsOn run the task once',
      why: 'Inside project `a`, `gen` and `a#gen` name the same task. A tool that dedups entries by their text, not by what they resolve to, runs it twice. It runs once, before the build.',
      from: ['task-graph-properties'],
    },
    dependsOnWs(['gen', 'a#gen']),
    [{ run: 'build', expect: GEN_THEN_BUILD }],
  ),

  make(
    {
      slug: 'depends-on-own-project-by-full-name',
      title: '`a#gen` in project a’s own dependsOn runs its gen first',
      why: 'A project may name its own task the long way, as a generated config does. It is the same edge as `gen`. A tool that reads `project#task` only as a cross-project edge may refuse it or skip it; gen runs first.',
      from: ['task-graph-properties'],
    },
    dependsOnWs(['a#gen']),
    [{ run: 'build', expect: GEN_THEN_BUILD }],
  ),

  make(
    {
      slug: 'depends-on-caret-and-explicit-runs-once',
      title: '`^build` and `lib#build` in one dependsOn build the library once',
      why: 'When `app` depends on `lib`, `^build` and `lib#build` both reach lib’s build. It is one task, run once, before the app. A tool that adds an edge per entry builds lib twice, the second time racing the app that reads it.',
      from: ['task-graph-properties'],
    },
    {
      projects: {
        lib: { tasks: { build: BUILD }, files: { 'src/a.txt': 'lib\n' } },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              ...BUILD,
              command: 'mkdir -p dist && cat ../lib/dist/out.txt src/*.txt > dist/out.txt',
              dependsOn: ['^build', 'lib#build'],
            },
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          order: [['lib#build', 'app#build']],
          files: { 'packages/app/dist/out.txt': 'lib\napp\n' },
        },
      },
    ],
  ),

  refuseTask(
    {
      slug: 'depends-on-self-by-full-name-refused',
      title: 'A task naming itself as `a#build` in its own dependsOn fails the run',
      why: 'A task cannot finish before it starts. Spelled with its project, the self-edge goes through the cross-project lookup, which a tool may not check for cycles. Waiting on itself hangs, and skipping the edge hides a typo; the run fails before anything starts.',
      from: ['task-graph-properties'],
    },
    { dependsOn: ['a#build'] },
  ),

  make(
    {
      slug: 'depends-on-bare-caret-refused',
      title: 'A bare `^` in dependsOn fails the run',
      why: '`^` asks for a task in every dependency but names none. A tool that reads it as an empty name matches nothing and runs the task with no edge at all. The entry is half written; the run fails.',
      from: ['task-graph-properties', 'config-schema-refusals'],
    },
    dependsOnWs(['^']),
    [REFUSED],
  ),

  make(
    {
      slug: 'depends-on-empty-task-of-project-refused',
      title: '`a#` in dependsOn, a project with no task after it, fails the run',
      why: 'A `#` with nothing after it names a project but no task. Reading it as no edge runs the build without what it waits on; guessing a task invents one. The run fails before anything starts.',
      from: ['task-graph-properties', 'config-schema-refusals'],
    },
    dependsOnWs(['a#']),
    [REFUSED],
  ),

  make(
    {
      slug: 'depends-on-empty-project-refused',
      title: '`#gen` in dependsOn, a task with no project before it, fails the run',
      why: 'A `#` with nothing before it names a task of no project. A tool that reads the empty name as “this project” or “every project” guesses; one that matches nothing drops the edge. The run fails before anything starts.',
      from: ['task-graph-properties', 'config-schema-refusals'],
    },
    dependsOnWs(['#gen']),
    [REFUSED],
  ),

  make(
    {
      slug: 'depends-on-two-hashes-refused',
      title: '`a#gen#x` in dependsOn fails the run',
      why: 'One `#` separates a project from its task; a second has no meaning. Splitting at the first finds a task `gen#x` nobody declared, splitting at the last a project `a#gen` that does not exist. Either way no task matches, and the run fails instead of dropping the edge.',
      from: ['task-graph-properties', 'config-schema-refusals'],
    },
    dependsOnWs(['a#gen#x']),
    [REFUSED],
  ),

  make(
    {
      slug: 'depends-on-caret-with-project-refused',
      title: '`^a#gen` in dependsOn fails the run',
      why: '`^` means “in each dependency” and `a#` means “in project a”: together they contradict each other. A tool that keeps one half silently picks a meaning. The run fails before anything starts.',
      from: ['task-graph-properties', 'config-schema-refusals'],
    },
    dependsOnWs(['^a#gen']),
    [REFUSED],
  ),

  make(
    {
      slug: 'depends-on-bang-name-refused',
      title: '`!gen` in dependsOn fails the run',
      why: 'dependsOn has no exclusions, so `!gen` names no task. A tool that strips the `!` runs gen first, the opposite of what the bang suggests; one that matches nothing drops the edge. The run fails and the user writes what they mean.',
      from: ['task-graph-properties', 'config-schema-refusals'],
    },
    dependsOnWs(['!gen']),
    [REFUSED],
  ),

  // ---- task and project names -------------------------------------------

  refuseTask(
    {
      slug: 'task-name-with-hash-refused',
      title: 'A task named `x#y` fails the run',
      why: 'Every runner reads `#` in a reference as the line between project and task. A task called `x#y` would be read as task `y` of project `x` wherever it is named, so dependsOn and the command line can never reach it. Refusing it at load names the task to rename.',
      from: ['config-schema-refusals', 'cli-task-names'],
    },
    {},
    { 'x#y': { command: 'true' } },
  ),

  refuseTask(
    {
      slug: 'task-name-empty-refused',
      title: 'A task with an empty name fails the run',
      why: 'An empty name cannot be typed on a command line or written in dependsOn, and `a#` reads as a project with its task missing. The task can never run on purpose. Refusing it at load names the mistake.',
      from: ['config-schema-refusals', 'cli-task-names'],
    },
    {},
    { '': { command: 'true' } },
  ),

  refuseTask(
    {
      slug: 'task-name-starting-with-caret-refused',
      title: 'A task named `^gen` fails the run',
      why: 'In dependsOn a leading `^` means “this task in each dependency”. A task literally called `^gen` can never be named there: every reference to it means something else. Refusing it at load names the task to rename.',
      from: ['config-schema-refusals', 'cli-task-names'],
    },
    {},
    { '^gen': { command: 'true' } },
  ),

  make(
    {
      slug: 'project-name-with-hash-refused',
      title: 'A project named `a#b` fails the run',
      why: '`a#b#build` cannot be read back: is it task `b#build` of `a`, or `build` of `a#b`? Every reference to the project is ambiguous, so dependsOn and selectors cannot name it reliably. Refusing it at discovery names the package to rename.',
      from: ['discovery-refusals', 'config-schema-refusals'],
    },
    {
      projects: {
        a: { tasks: { build: BUILD }, files: { 'src/a.txt': 'a\n' } },
        'a#b': { dir: 'packages/ab', tasks: { build: BUILD }, files: { 'src/a.txt': 'b\n' } },
      },
    },
    [{ run: 'build', expect: { exit: 'fail', notRan: ['a#build', 'a#b#build'], orRefused: true } }],
  ),

  make(
    {
      slug: 'task-names-differing-in-case-are-two-tasks',
      title: 'Tasks named `build` and `Build` are two tasks: asking for one runs only it',
      why: 'Names are case-sensitive in package.json scripts and in every task runner’s config. A tool that folds case runs both, or refuses them as duplicates. Asking for `Build` runs `Build` alone.',
      from: ['cli-task-names', 'config-schema-refusals'],
    },
    {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'echo lower > lower.txt',
              outputs: ['lower.txt'],
              inputs: ['src/**'],
            },
            Build: {
              command: 'echo upper > upper.txt',
              outputs: ['upper.txt'],
              inputs: ['src/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [
      {
        run: 'Build',
        expect: {
          exit: 0,
          ran: ['a#Build'],
          notRan: ['a#build'],
          files: { [`${A}/upper.txt`]: 'upper\n', [`${A}/lower.txt`]: null },
        },
      },
    ],
  ),

  make(
    {
      slug: 'non-ascii-task-name',
      title: 'A task named `构建` runs, and a dependsOn naming it runs it first',
      why: 'Task names are Unicode text in JSON and in package.json scripts. A tool that splits names on bytes, or limits them to ASCII, refuses the task or loses the edge. The named task runs, then its dependant.',
      from: ['cli-task-names', 'config-schema-refusals'],
    },
    {
      projects: {
        a: {
          tasks: {
            构建: {
              command: 'mkdir -p gen && echo gen > gen/g.txt',
              inputs: ['src/**'],
              outputs: ['gen/**'],
            },
            build: {
              command: 'mkdir -p dist && cat gen/g.txt src/*.txt > dist/out.txt',
              dependsOn: ['构建'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#构建', 'a#build'],
          order: [['a#构建', 'a#build']],
          files: { [OUT]: 'gen\na\n' },
        },
      },
    ],
  ),

  make(
    {
      slug: 'caret-and-bang-inside-a-task-name',
      title: 'Tasks named `gen^2` and `a!b` are plain names: dependsOn naming them runs them first',
      why: 'Only a leading `^` or `!` means something in dependsOn. Inside a name they are characters, as in `gen^2`. A tool that splits on them anywhere reads `gen^2` as a dependency marker and loses the edge. Both run before the build.',
      from: ['config-schema-refusals', 'cli-task-names'],
    },
    {
      projects: {
        a: {
          tasks: {
            'gen^2': {
              command: 'mkdir -p gen && echo g > gen/g.txt',
              inputs: ['src/**'],
              outputs: ['gen/**'],
            },
            'a!b': {
              command: 'mkdir -p ab && echo b > ab/b.txt',
              inputs: ['src/**'],
              outputs: ['ab/**'],
            },
            build: {
              command: 'mkdir -p dist && cat gen/g.txt ab/b.txt > dist/out.txt',
              dependsOn: ['gen^2', 'a!b'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#gen^2', 'a#a!b', 'a#build'],
          order: [
            ['a#gen^2', 'a#build'],
            ['a#a!b', 'a#build'],
          ],
          files: { [OUT]: 'g\nb\n' },
        },
      },
    ],
  ),

  // ---- glob spellings -----------------------------------------------------

  // absolute_path_error_test.rs test_absolute_path_in_inputs
  refuseTask(
    {
      slug: 'input-absolute-path-refused',
      title: 'An absolute path in a task’s inputs fails the run',
      why: 'A cache key is shared between machines and checkouts, and `/home/me/x` exists on one of them. Keying on it ties the result to one layout and reaches outside the project, where no edge orders the writer. Turborepo refuses absolute inputs; the run fails before anything starts.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    { inputs: ['src/**', '/etc/hostname'] },
  ),

  // absolute_path_error_test.rs test_absolute_path_in_outputs
  refuseTask(
    {
      slug: 'output-absolute-path-refused',
      title: 'An absolute path in a task’s outputs fails the run',
      why: 'Restoring an output writes it, so an absolute output lets a cache hit write anywhere on the machine that restores it, and cleaning it deletes there. No checkout-relative meaning survives a move. Turborepo refuses absolute outputs; the run fails before anything starts.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    { outputs: ['dist/**', '/tmp/vx-conformance-out/**'] },
  ),

  // absolute_path_error_test.rs test_absolute_path_in_global_deps
  refuseTask(
    {
      slug: 'root-input-absolute-path-refused',
      title: 'An absolute path in a task’s workspace-level inputs fails the run',
      why: 'Workspace-level inputs are relative to the repository root so that two checkouts key alike. An absolute path names one machine’s file, and the same config keys differently, or not at all, elsewhere. Turborepo refuses it in globalDependencies; the run fails before anything starts.',
      from: ['config-schema-refusals', 'run-keys-workspace-files'],
    },
    { rootInputs: ['/etc/hostname'] },
  ),

  refuseTask(
    {
      slug: 'root-input-dot-refused',
      title: 'A workspace-level input of `.` fails the run',
      why: '`.` names the root directory, not the files in it. A tool that hashes the directory entry keys nothing that changes; one that reads it as everything keys every output too and never replays. Either guess is wrong, so the run fails and the user writes `**` if that is what they mean.',
      from: ['config-schema-refusals', 'run-keys-workspace-files'],
    },
    { rootInputs: ['.'] },
  ),

  keyedOrRefused(
    {
      slug: 'input-climbing-into-sibling-keyed-or-refused',
      title: 'An input `../b/src/**` keys an edit there, or is refused',
      why: 'A glob climbing out of the project reads another project’s files with no edge to order them. Some tools refuse it, holding that project boundaries are hard; some follow it. Both are defensible. Leaving it in the config and keying nothing through it replays a stale result after the sibling changes.',
      from: ['nested-boundary', 'lockfile-boundary', 'config-schema-refusals'],
    },
    ['src/**', '../b/src/**'],
    'packages/b/src/a.txt',
    { reads: '../b/src/a.txt', sibling: true },
  ),

  keyedOrRefused(
    {
      slug: 'input-surrounding-space-keyed-or-refused',
      title: 'An input ` src/**` with a stray space keys an edit under src, or is refused',
      why: 'A leading space in a glob is almost always a slip. Read literally it matches a directory named ` src` that does not exist, and the task keys on nothing: every edit replays the old result. Trimming it or refusing it is right; keying nothing is not.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    [' src/**'],
    `${A}/src/a.txt`,
  ),

  keyedOrRefused(
    {
      slug: 'input-glued-globstar-keyed-or-refused',
      title: 'An input `src/**.txt` keys an edit two folders deep, or is refused',
      why: 'Users write `**.txt` meaning any depth. Many glob engines read `**` glued to text as `*`, keying only files directly in src, so a deep edit replays a stale build (vercel/turborepo#5431). Keying the deep file, or refusing the spelling, is right.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    ['src/**.txt'],
    `${A}/src/x/y/a.txt`,
  ),

  keyedOrRefused(
    {
      slug: 'input-backwards-range-keyed-or-refused',
      title: 'An input `src/[z-a].txt` keys an edit to `src/m.txt`, or is refused',
      why: 'A range written backwards is a typo for the forward one. Most engines make it match nothing, so the task keys no file and every edit replays the old result. Reading it as `a-z` or refusing it is right; keying nothing is not.',
      from: ['config-schema-refusals', 'inputs-glob-fuzz'],
    },
    ['src/[z-a].txt'],
    `${A}/src/m.txt`,
  ),

  keyedOrRefused(
    {
      slug: 'input-brace-explosion-keyed-or-refused',
      title: 'An input whose braces expand to 2048 patterns keys a match, or is refused',
      why: 'Eleven `{a,b}` groups in a row expand to 2048 alternatives. A tool may expand them or refuse a pattern that large, but one that gives up silently keys nothing and replays a stale build. The edited match runs the task again, or the run is refused.',
      from: ['config-schema-refusals', 'inputs-glob-fuzz'],
    },
    [`src/${'{a,b}'.repeat(11)}.txt`],
    `${A}/src/abababababa.txt`,
  ),

  keyedOrRefused(
    {
      slug: 'input-negated-then-named-keyed-or-refused',
      title:
        'A file named outright after a `!` that takes its folder back keys its edits, or is refused',
      why: 'With `src/**`, `!src/gen/**` and `src/gen/keep.txt`, the user named the file on purpose. A tool where `!` subtracts wherever it sits drops it silently, and an edit to it replays a stale build. Keying it, as gitignore order does, or refusing the contradiction, is right.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    ['src/**', '!src/gen/**', 'src/gen/keep.txt'],
    `${A}/src/gen/keep.txt`,
  ),

  keyedOrRefused(
    {
      slug: 'input-climb-and-return-keyed-or-refused',
      title: 'An input `src/../src/a.txt` keys the file it names, or is refused',
      why: 'The path climbs out of src and back in, so it names `src/a.txt`. A tool matching it as text against walked paths finds nothing and keys no file. Normalising it, or refusing the `..`, is right; replaying after an edit is not.',
      from: ['config-schema-refusals', 'dot-slash-globs'],
    },
    ['src/../src/a.txt'],
    `${A}/src/a.txt`,
  ),

  keyedOrRefused(
    {
      slug: 'input-bare-directory-keyed-or-refused',
      title: 'An input naming a directory, `src`, keys an edit inside it, or is refused',
      why: 'Writing a folder’s name means its contents to most users. A tool that matches only the directory entry keys a timestamp or nothing, and an edit inside replays the old build. Reading it as the whole folder, or refusing it, is right.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    ['src'],
    `${A}/src/a.txt`,
  ),

  keyedOrRefused(
    {
      slug: 'input-trailing-slash-keyed-or-refused',
      title: 'An input `src/` with a trailing slash keys an edit inside it, or is refused',
      why: 'A trailing slash says “this is a directory”, as gitignore reads it. A tool that matches files against `src/` literally finds none and keys nothing. Reading it as the folder’s contents, or refusing it, is right; a stale replay is not.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    ['src/'],
    `${A}/src/a.txt`,
  ),

  make(
    {
      slug: 'input-dot-slash-accepted',
      title: 'An input spelled `./src/**` keys an edit under src',
      why: '`./src/**` and `src/**` name the same files; configs copied from a shell or a bundler carry the `./`. A tool that matches the text against paths without it keys nothing and replays every edit. The edit runs the task again.',
      from: ['dot-slash-globs'],
    },
    {
      projects: {
        a: {
          tasks: { build: { ...BUILD, inputs: ['./src/**'] } },
          files: { 'src/a.txt': 'one\n' },
        },
      },
    },
    [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/a.txt`]: 'two\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'two\n' } } },
    ],
  ),

  make(
    {
      slug: 'input-listed-twice-keys-and-replays',
      title: 'An input glob listed twice keys an edit, and replays when nothing changed',
      why: 'Inputs merged from two presets often repeat a glob. It is the same set of files. A tool that errors on the duplicate refuses a harmless list, and one that merges pattern results badly can key a file twice or not at all. An edit reruns; the next run replays.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    {
      projects: {
        a: {
          tasks: { build: { ...BUILD, inputs: ['src/**', 'src/**'] } },
          files: { 'src/a.txt': 'one\n' },
        },
      },
    },
    [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/a.txt`]: 'two\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'two\n' } } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [OUT]: 'two\n' } } },
    ],
  ),

  refuseTask(
    {
      slug: 'input-empty-string-refused',
      title: 'An empty string in a task’s inputs fails the run',
      why: 'An empty pattern is a list entry whose value went missing, such as `process.env.GLOB ?? ""`. It matches nothing, or the project itself, depending on the engine, so what keys the task depends on the tool. The run fails before anything starts.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    { inputs: ['src/**', ''] },
  ),

  make(
    {
      slug: 'output-empty-string-never-wipes-sources',
      title: 'An empty string in a task’s outputs fails the run and leaves the sources alone',
      why: 'An empty output pattern can resolve to the project directory itself. A tool that then cleans or restores “the outputs” deletes the sources. Refusing it is right, and so is failing the task for an output that matched nothing; the sources stay either way.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    {
      projects: {
        a: { tasks: { build: { ...BUILD, outputs: [''] } }, files: { 'src/a.txt': 'a\n' } },
      },
    },
    [
      {
        run: 'build',
        expect: { exit: 'fail', files: { [`${A}/src/a.txt`]: 'a\n' }, orRefused: true },
      },
      {
        run: 'build',
        expect: { exit: 'fail', files: { [`${A}/src/a.txt`]: 'a\n' }, orRefused: true },
      },
    ],
  ),

  ...(
    [
      [
        'output-bare-directory-restored-or-refused',
        'dist',
        'An output naming a directory, `dist`, is restored whole, or refused',
        'Writing a folder’s name means its contents. A tool that stores only the directory entry restores an empty folder on a hit and reports success. Restoring the file inside, or refusing the spelling, is right.',
      ],
      [
        'output-trailing-slash-restored-or-refused',
        'dist/',
        'An output `dist/` with a trailing slash is restored whole, or refused',
        'A trailing slash says “this directory”. A tool that matches written files against `dist/` literally stores none of them, and a hit restores nothing while reporting success. Restoring the file inside, or refusing the spelling, is right.',
      ],
    ] as const
  ).map(([slug, glob, title, why]) =>
    make(
      { slug, title, why, from: ['config-schema-refusals', 'contract-task-globs'] },
      {
        projects: {
          a: { tasks: { build: { ...BUILD, outputs: [glob] } }, files: { 'src/a.txt': 'a\n' } },
        },
      },
      [
        { run: 'build', expect: { exit: 0, orRefused: true } },
        { write: { [`${A}/dist`]: null } },
        {
          run: 'build',
          expect: { exit: 0, notRan: ['a#build'], files: { [OUT]: 'a\n' }, orRefused: true },
        },
      ],
    ),
  ),

  make(
    {
      slug: 'output-negated-then-named-restored-or-refused',
      title: 'An output file named outright beside a `!` over its folder is restored, or refused',
      why: 'With `dist/out.txt` and `!dist/**`, the user named the file and excluded its folder. A tool where `!` subtracts wherever it sits never stores the file, then reports a hit and leaves it missing. Storing it or refusing the contradiction is right.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    {
      projects: {
        a: {
          tasks: { build: { ...BUILD, outputs: ['dist/out.txt', '!dist/**'] } },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [
      { run: 'build', expect: { exit: 0, orRefused: true } },
      { write: { [`${A}/dist`]: null } },
      { run: 'build', expect: { exit: 0, files: { [OUT]: 'a\n' }, orRefused: true } },
    ],
  ),

  // ---- variable names -----------------------------------------------------

  refuseTask(
    {
      slug: 'env-name-with-equals-refused',
      title: 'A keyed variable named `A=B` fails the run',
      why: 'An environment entry is `name=value`, split at the first `=`, so no variable can be named `A=B`. Keying on it keys a value that is always unset, and the task never reruns when the user thinks it should. The run fails naming the entry.',
      needs: ['env-inputs'],
    },
    { env: ['A=B'] },
  ),

  refuseTask(
    {
      slug: 'env-name-empty-refused',
      title: 'An empty variable name in a task’s keyed variables fails the run',
      why: 'An empty name is a list entry whose value went missing. No variable has it, so it keys nothing, and the entry the user meant is gone without a word. The run fails before anything starts.',
      needs: ['env-inputs'],
    },
    { env: ['MODE', ''] },
  ),

  make(
    {
      slug: 'env-name-sh-drops-reaches-or-refused',
      title: 'A keyed variable named `A-B` reaches the task, or is refused',
      why: '`A-B` is a legal environment name, but dash, the `sh` of Debian and Ubuntu, drops names that are not shell identifiers before running the command. A tool can pass it some other way or refuse it; what it must not do is key on a value the task never sees. The task prints it, or the run is refused.',
      needs: ['env-inputs'],
    },
    {
      projects: {
        a: {
          tasks: {
            build: {
              ...BUILD,
              command: "mkdir -p dist && env | grep '^A-B=' > dist/out.txt",
              env: ['A-B'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [
      {
        run: 'build',
        env: { 'A-B': 'one' },
        expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'A-B=one\n' }, orRefused: true },
      },
    ],
  ),

  make(
    {
      slug: 'env-wildcard-keyed-or-refused',
      title:
        'A keyed variable `MODE_*` reruns the task when a matching variable changes, or is refused',
      why: 'Some tools read `*` in a variable name as a wildcard, others as a literal star no variable carries. A tool that takes the literal reading keys nothing and replays after `MODE_X` changes. Expanding it, or refusing the star, is right.',
      needs: ['env-inputs'],
    },
    {
      projects: {
        a: {
          tasks: {
            build: {
              ...BUILD,
              command: 'mkdir -p dist && printf "%s\\n" "$MODE_X" > dist/out.txt',
              env: ['MODE_*'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [
      { run: 'build', env: { MODE_X: 'one' }, expect: { exit: 0, orRefused: true } },
      {
        run: 'build',
        env: { MODE_X: 'two' },
        expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'two\n' }, orRefused: true },
      },
    ],
  ),

  make(
    {
      slug: 'env-name-surrounding-space-keyed-or-refused',
      title:
        'A keyed variable ` MODE` with a stray space reruns the task when MODE changes, or is refused',
      why: 'No variable is named with a leading space; ` MODE` is a slip for `MODE`. Read literally it keys a value that is always unset, and the task replays after MODE changes. Trimming it or refusing it is right.',
      needs: ['env-inputs'],
    },
    {
      projects: {
        a: {
          tasks: {
            build: {
              ...BUILD,
              command: 'mkdir -p dist && printf "%s\\n" "$MODE" > dist/out.txt',
              env: [' MODE'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [
      { run: 'build', env: { MODE: 'one' }, expect: { exit: 0, orRefused: true } },
      {
        run: 'build',
        env: { MODE: 'two' },
        expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'two\n' }, orRefused: true },
      },
    ],
  ),

  make(
    {
      slug: 'env-keyed-and-passed-through-keys',
      title:
        'A variable listed both as keyed and as passed through still reruns the task when it changes',
      why: 'A preset passing a variable through and a task keying it can meet in one list. Passing through only says the value reaches the command; keying is the stronger promise. A tool that lets the weaker list win replays a build made with the old value.',
      needs: ['env-inputs', 'pass-through-env'],
    },
    {
      projects: {
        a: {
          tasks: {
            build: {
              ...BUILD,
              command: 'mkdir -p dist && printf "%s\\n" "$MODE" > dist/out.txt',
              env: ['MODE'],
              passThrough: ['MODE'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [
      { run: 'build', env: { MODE: 'one' }, expect: { exit: 0, orRefused: true } },
      {
        run: 'build',
        env: { MODE: 'two' },
        expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'two\n' }, orRefused: true },
      },
    ],
  ),

  // ---- commands -----------------------------------------------------------

  refuseTask(
    {
      slug: 'command-with-nul-refused',
      title: 'A command holding a NUL byte fails the run',
      why: 'No command line can carry a NUL: the operating system ends the string there. A tool that passes it on runs a shorter command than the config says, or fails with a confusing “not found”. Refusing it names the config entry.',
    },
    { command: 'mkdir -p dist && echo ran > dist/out.txt\u0000 && echo more' },
  ),

  refuseTask(
    {
      slug: 'command-with-lone-surrogate-refused',
      title: 'A command holding a lone UTF-16 surrogate fails the run',
      why: 'A lone surrogate has no UTF-8 form, so whatever reaches the shell is not what the config says: usually U+FFFD in its place. Two configs with different surrogates then run one command under two keys. Refusing it names the entry.',
    },
    { command: 'mkdir -p dist && echo \ud800 > dist/out.txt' },
  ),
  badManifest(
    {
      slug: 'manifest-dependencies-array-refused',
      title: 'A workspace package whose dependencies field is an array fails the run',
      why: '`dependencies` maps names to versions; an array has no names, only indexes. A tool that reads it as empty builds the package before what it imports, and one that reads the indexes as names depends on packages `0` and `1`. The run fails before it builds out of order.',
    },
    '{ "name": "b", "version": "0.0.0", "dependencies": ["a"] }\n',
  ),
] satisfies Case[]

export const pending: Case[] = []
