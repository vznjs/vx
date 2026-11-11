// Inputs and outputs at their edges: negation-only and inverted lists,
// nested projects, outputs that climb out of the project or through a
// link, links among the inputs, git settings that hide an edit, names that
// are not UTF-8, and inputs a run's own tasks move.
import {
  defineCase,
  type Case,
  type Expect,
  type Kind,
  type Step,
  type TaskSpec,
} from '../src/spec.ts'
import { chainProject, one, out } from './shapes.ts'

/** A cached build of project `a` that writes `read`'s bytes to dist/out.txt. */
function reads(inputs: string[], read: string, extra: Partial<TaskSpec> = {}): TaskSpec {
  return {
    command: `mkdir -p dist && cat ${read} > dist/out.txt`,
    inputs,
    outputs: ['dist/**'],
    ...extra,
  }
}

/** Project `a`'s paths, workspace-relative. */
function inA(files: Record<string, string | null>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(files).map(([f, c]) => [`packages/a/${f}`, c]))
}

/** Each step of `seq`: write, then a run that must leave `out` holding `want` (or refuse). */
function sequence(
  seq: Array<[Record<string, string | null>, string]>,
  file: string,
  more: Partial<Expect> = {},
): Step[] {
  return seq.flatMap(([change, want]): Step[] => [
    ...(Object.keys(change).length > 0 ? [{ write: change }] : []),
    { run: 'build', expect: { exit: 0, files: { [file]: want }, ...more } },
  ])
}

/**
 * One project `a`, built once, then each change in turn: `true` must run the
 * build again (and leave `want` in dist/out.txt when given), `false` must not.
 */
function edits(c: {
  id: string
  kind: Kind
  title: string
  why: string
  from: string[]
  task: TaskSpec
  files: Record<string, string>
  rootFiles?: Record<string, string>
  setup?: Step[]
  changes: Array<[Record<string, string | null>, boolean, string?]>
}): Case {
  return defineCase({
    id: c.id,
    category: c.id.startsWith('outputs/') ? 'outputs' : 'inputs',
    kind: c.kind,
    title: c.title,
    why: c.why,
    from: c.from,
    workspace: {
      projects: { a: { tasks: { build: c.task }, files: c.files } },
      ...(c.rootFiles ? { files: c.rootFiles } : {}),
    },
    steps: [
      ...(c.setup ?? []),
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      ...c.changes.flatMap(([change, reruns, want]): Step[] => [
        { write: change },
        {
          run: 'build',
          expect: {
            exit: 0,
            ...(reruns ? { ran: ['a#build'] } : { notRan: ['a#build'] }),
            ...(want === undefined ? {} : { files: { [out('a')]: want } }),
          },
        },
      ]),
    ],
  })
}

/** `printf` spelling of a name holding the byte 0xFF, for a `sh` step. */
const BAD = `$(printf 'x\\377y')`

/** Project `a` reads every file in `src` into dist/all; `src/a` holds `v1`. */
const catAll: Case['workspace'] = one(
  { command: 'mkdir -p dist && cat src/* > dist/all', inputs: ['src/**'], outputs: ['dist/**'] },
  { 'src/a': 'v1' },
)

/** Project `a` copies `src/x.txt` (a link step makes it) to out.txt, keyed on `src/**`. */
function linkedRead(read: string, extra: Partial<TaskSpec> = {}): TaskSpec {
  return { command: `cat ${read} > out.txt`, inputs: ['src/**'], outputs: ['out.txt'], ...extra }
}

const OUT_TXT = 'packages/a/out.txt'

/** Build, edit `change`, build: the output must show the edit, never replay the bytes before. */
function linkCase(c: {
  id: string
  title: string
  why: string
  from: string[]
  task: TaskSpec
  files?: Record<string, string>
  rootFiles: Record<string, string>
  links: Record<string, string>
  /** Links made after the commit: untracked. */
  laterLinks?: Record<string, string>
  first: string
  changes: Array<[Record<string, string | null>, string, boolean?]>
}): Case {
  return defineCase({
    id: c.id,
    category: 'inputs',
    kind: 'correctness',
    title: c.title,
    why: c.why,
    from: c.from,
    workspace: {
      projects: {
        a: { tasks: { build: c.task }, files: { '.gitignore': 'out.txt\n', ...c.files } },
      },
      files: c.rootFiles,
    },
    steps: [
      { link: c.links },
      { commit: 'links' },
      ...(c.laterLinks ? [{ link: c.laterLinks }] : []),
      { run: 'build', expect: { exit: 0, files: { [OUT_TXT]: c.first } } },
      ...c.changes.flatMap(([change, want, commit]): Step[] => [
        { write: change },
        ...(commit ? [{ commit: 'edit' }] : []),
        { run: 'build', expect: { exit: 0, files: { [OUT_TXT]: want } } },
      ]),
    ],
  })
}

/** A git setting, then `a/src/a.txt` CRLF on disk and LF in git's index; LF on disk must rebuild. */
function crlf(
  id: string,
  title: string,
  why: string,
  setup: string,
  from: string[],
  scoped = false,
): Case {
  const run = (want: string): Step => ({
    run: 'build',
    ...(scoped ? { projects: ['a'] } : {}),
    expect: { exit: 0, files: { [out('a')]: want } },
  })
  return defineCase({
    id,
    category: 'inputs',
    kind: 'correctness',
    title,
    why,
    from,
    workspace: one(
      {
        command: 'mkdir -p dist && wc -c < src/a.txt | tr -d " " > dist/out.txt',
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
      { 'src/a.txt': 'one\r\ntwo\r\n' },
    ),
    steps: [
      { sh: setup },
      run('10\n'),
      { write: { 'packages/a/src/a.txt': 'one\ntwo\n' } },
      run('8\n'),
    ],
  })
}

/** A git setting under which git cannot see a same-size edit that keeps the mtime. */
function weakStat(key: string, value: string, why: string): Case {
  const stamp = 'touch -d @1600000000 packages/a/src/a.txt'
  return defineCase({
    id: `inputs/same-stat-rewrite-${key.replace('core.', '').toLowerCase()}-${value}`,
    category: 'inputs',
    kind: 'correctness',
    title: `With git's \`${key}=${value}\`, a same-size edit that keeps its mtime runs the task again`,
    why,
    from: ['stale-hit-git'],
    workspace: one(reads(['src/**'], 'src/a.txt'), { 'src/a.txt': 'AAAA' }),
    steps: [
      {
        sh: `git config ${key} ${value} && ${stamp} && git add -A && git commit -q --allow-empty -m t`,
      },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'AAAA' } } },
      { sh: `printf BBBB > packages/a/src/a.txt && ${stamp}` },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'BBBB' } } },
    ],
  })
}

/** Project `a` with a project of its own nested at `packages/a/<dir>`. */
function nestedSibling(id: string, inputs: string[], title: string, why: string): Case {
  return edits({
    id,
    kind: 'correctness',
    title,
    why,
    from: ['nested-input'],
    task: reads(inputs, 'genx/e.txt'),
    files: { 'src/a.txt': 'a\n', 'genx/e.txt': 'e1\n' },
    changes: [[inA({ 'genx/e.txt': 'e2\n' }), true, 'e2\n']],
  })
}

const precious = { 'victim/precious.txt': 'precious' }

const cases: Case[] = [
  // ── negation ───────────────────────────────────────────────────────────
  defineCase({
    id: 'inputs/negation-only-never-stale',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input list holding only a `!` pattern never replays a stale result',
    why: 'An input list of only `!vendor/**` can be read as everything but vendor, or as nothing at all. Read as everything but vendor, the edit in src is an input and the task reruns. Read as nothing, the task stops tracking its own source and replays the old build after every edit. Refusing the list is fine; replaying is not.',
    from: ['inputs-resolution'],
    workspace: one(reads(['!vendor/**'], 'src/a.txt'), {
      'src/a.txt': 'a\n',
      'vendor/v.txt': 'v\n',
    }),
    steps: sequence(
      [
        [{}, 'a\n'],
        [{ 'packages/a/src/a.txt': 'a2\n' }, 'a2\n'],
      ],
      out('a'),
      { orRefused: true },
    ),
  }),

  defineCase({
    id: 'inputs/double-negation-never-stale',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input `!!vendor/**` never turns the rest of the inputs off',
    why: 'Two `!` cancel out, so `!!vendor/**` keeps vendor and leaves `**` intact. A tool that strips one `!` and hands `!vendor/**` to a glob library inverts the set: only vendor stays keyed. An edit in src then replays the old build. Refusing the pattern as unclear is fine; dropping the sources is not.',
    from: ['inputs-resolution'],
    workspace: one(reads(['**', '!!vendor/**'], 'src/a.txt'), {
      'src/a.txt': 'a\n',
      'vendor/v.txt': 'v\n',
    }),
    steps: sequence(
      [
        [{}, 'a\n'],
        [{ 'packages/a/src/a.txt': 'a2\n' }, 'a2\n'],
      ],
      out('a'),
      { orRefused: true },
    ),
  }),

  edits({
    id: 'inputs/node-modules-lookalike-directory',
    kind: 'correctness',
    title: 'A directory named like an ignored one, `my_node_modules`, is an input',
    why: 'Skipping directories such as `node_modules` must match the whole name, not part of it. A directory called `my_node_modules` is ordinary source the user owns and the task reads. A tool that matches by substring drops it from the key, and edits there replay the old output.',
    from: ['inputs-resolution'],
    task: reads(['**'], 'my_node_modules/x.txt'),
    files: { 'src/a.txt': 'a\n', 'my_node_modules/x.txt': 'x\n' },
    changes: [[inA({ 'my_node_modules/x.txt': 'x2\n' }), true, 'x2\n']],
  }),

  // ── nested projects ────────────────────────────────────────────────────
  defineCase({
    id: 'inputs/nested-project-deep-excluded',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'A project nested several directories down keeps its files out of the outer project’s inputs',
    why: 'A nested project owns its files at any depth, not only directly under the outer project. If the outer project’s `**` counts them, every edit inside the nested project reruns the outer task as well. The outer task must still rerun when its own files change, which the last step checks.',
    from: ['inputs-resolution'],
    workspace: {
      projects: {
        a: {
          tasks: { build: reads(['**'], 'x/y/p.txt') },
          files: { 'x/y/p.txt': 'p\n' },
        },
        inner: { dir: 'packages/a/x/y/inner', files: { 'n.txt': 'n\n' } },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'packages/a/x/y/inner/n.txt': 'n2\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { 'packages/a/x/y/p.txt': 'p2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'p2\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/ignored-directory-named-skips-nested-project',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'A gitignored directory named in the inputs keys its own files, not a project nested in it',
    why: 'Naming a gitignored directory in the inputs opts its files back in, but only the outer project’s own files. A project nested inside that directory still owns its files, and the outer task never reads them. Keying on them reruns the outer task on every edit in the nested project.',
    from: ['inputs-resolution'],
    workspace: {
      projects: {
        a: {
          tasks: { build: reads(['gen/**'], 'gen/own.txt') },
          files: { '.gitignore': 'gen/\n', 'gen/own.txt': 'o\n' },
        },
        sub: { dir: 'packages/a/gen/sub', files: { 'theirs.txt': 't\n' } },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'packages/a/gen/sub/theirs.txt': 't2\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'outputs/outer-output-skips-nested-project',
    category: 'outputs',
    kind: 'correctness',
    title:
      'An outer project’s `**/*.js` output never restores a nested project’s file over its newer build',
    why: 'An output glob such as `**/*.js` covers the project’s own files, not those of a project nested inside it. If the outer entry stores the nested project’s built file, replaying the outer task writes those old bytes over the nested project’s newer build. The tree then holds a stale file from a task that did not make it.',
    from: ['inputs-resolution', 'nested-boundary'],
    workspace: {
      projects: {
        outer: {
          deps: ['inner'],
          tasks: {
            build: {
              command: 'mkdir -p dist && cp src/a.txt dist/parent.js',
              dependsOn: ['^build'],
              inputs: ['src/**'],
              outputs: ['**/*.js'],
            },
          },
          files: { 'src/a.txt': 'p\n' },
        },
        inner: {
          dir: 'packages/outer/inner',
          tasks: {
            build: {
              command: 'mkdir -p dist && cp src/n.txt dist/nested.js',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/n.txt': 'v1\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/outer/inner/src/n.txt': 'v2\n' } },
      { run: 'build', projects: ['inner'], only: true, expect: { exit: 0 } },
      { write: { 'packages/outer/dist': null } },
      {
        run: 'build',
        projects: ['outer'],
        expect: {
          exit: 0,
          files: {
            'packages/outer/dist/parent.js': 'p\n',
            'packages/outer/inner/dist/nested.js': 'v2\n',
          },
        },
      },
    ],
  }),

  nestedSibling(
    'inputs/nested-project-sibling-accepted',
    ['genx/**', 'src/**'],
    'A glob over the sibling of a nested project, `genx` beside `gen`, keys it',
    'Directory names are compared whole, not as text prefixes: `genx` is not inside `gen`. The `genx` folder is the outer project’s own source, named in its inputs. A tool that tests paths by string prefix treats it as part of a nested project at `gen` and drops it from the key, so edits there replay the old output.',
  ),

  nestedSibling(
    'inputs/nested-project-negated-accepted',
    ['**', '!gen/**'],
    'A glob over the whole project with the nested project taken back keys the rest',
    'Taking a nested directory out with `!gen/**` must leave the rest of the project keyed, including `genx` beside it. The exclusion names one directory, not every name that starts the same way. A tool that matches the negation by prefix drops `genx` too, and its edits replay the old output.',
  ),

  defineCase({
    id: 'inputs/nested-project-glob-character-name',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A nested project named `pkg*` does not take its sibling `pkg-b` out of the outer inputs',
    why: 'A nested project’s directory is a path, not a glob, even when its name holds `*`. Read as a pattern, `pkg*` matches `pkg-b`, so the outer project loses `pkg-b` from its inputs and edits there replay the old output. Names with glob characters are legal and must be matched literally.',
    from: ['nested-boundary'],
    workspace: {
      projects: {
        a: {
          tasks: { build: reads(['**'], 'pkg-b/b.txt') },
          files: { 'pkg-b/b.txt': 'b1\n' },
        },
        star: { dir: 'packages/a/pkg*', files: { 'a.txt': 'a\n' } },
      },
    },
    steps: [
      { run: 'build', projects: ['a'], expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'packages/a/pkg-b/b.txt': 'b2\n' } },
      {
        run: 'build',
        projects: ['a'],
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'b2\n' } },
      },
    ],
  }),

  // ── outputs that leave the project ─────────────────────────────────────
  defineCase({
    id: 'outputs/parent-relative-output-deletes-nothing',
    category: 'outputs',
    kind: 'correctness',
    title:
      'An output glob climbing out of the project, `../../victim/**`, never deletes what is there',
    why: 'A task owns only the files in its project, and an output glob that climbs out with `..` must not give it more. Tools clear outputs before a run and before a restore. Following `..` there deletes another directory’s files, which may be source or another team’s work. Ignoring or refusing such a glob is safe; deleting is not.',
    from: ['inputs-resolution'],
    workspace: {
      ...one(reads(['src/**'], 'src/a.txt', { outputs: ['dist/**', '../../victim/**'] })),
      files: precious,
    },
    steps: [
      { run: 'build', expect: { files: precious } },
      { write: { 'packages/a/src/a.txt': 'a2\n' } },
      { run: 'build', expect: { files: precious } },
      { run: 'build', expect: { files: precious } },
    ],
  }),

  defineCase({
    id: 'outputs/sibling-prefix-output-deletes-nothing',
    category: 'outputs',
    kind: 'correctness',
    title:
      'An output glob into a sibling whose name extends the project’s, `../a-extra/**`, deletes nothing',
    why: 'A sibling whose name starts with the project’s, like `a-extra` beside `a`, is still another directory. A boundary check that compares paths as text prefixes thinks `packages/a-extra` lies inside `packages/a`. The clean before a run or a restore then deletes files the task does not own.',
    from: ['inputs-resolution'],
    workspace: {
      ...one(reads(['src/**'], 'src/a.txt', { outputs: ['dist/**', '../a-extra/**'] })),
      files: { 'packages/a-extra/precious.txt': 'precious' },
    },
    steps: [
      { run: 'build', expect: { files: { 'packages/a-extra/precious.txt': 'precious' } } },
      { write: { 'packages/a/src/a.txt': 'a2\n' } },
      { run: 'build', expect: { files: { 'packages/a-extra/precious.txt': 'precious' } } },
    ],
  }),

  defineCase({
    id: 'outputs/output-dir-linked-out-of-project',
    category: 'outputs',
    kind: 'correctness',
    title:
      'An output directory that is a link out of the project never has the link’s target emptied',
    why: 'Clearing an output directory must not follow a link out of the project. If `dist` points elsewhere, clearing `dist/**` through the link deletes another directory’s files, which may be the only copy of something. Refusing the run is acceptable; emptying the link’s target is not.',
    from: ['inputs-resolution'],
    workspace: {
      ...one({ command: 'true', inputs: ['src/**'], outputs: ['dist/**'] }),
      files: precious,
    },
    steps: [
      { link: { 'packages/a/dist': '../../victim' } },
      { run: 'build', expect: { files: precious } },
      { write: { 'packages/a/src/a.txt': 'a2\n' } },
      { run: 'build', expect: { files: precious } },
      { run: 'build', expect: { files: precious } },
      { check: { links: { 'packages/a/dist': '../../victim' } } },
    ],
  }),

  defineCase({
    id: 'outputs/linked-file-in-output-dir',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A link a task leaves in its output directory is cleared, and the file it points at survives',
    why: 'A link the task wrote is the output, not the file it points at. Clearing outputs must remove the link itself and leave its target alone. A tool that follows the link while cleaning deletes a file elsewhere in the repo that the task never wrote, and no later run brings it back.',
    from: ['inputs-resolution'],
    workspace: {
      ...one({
        command:
          'mkdir -p dist && cp src/a.txt dist/app.txt && ln -sf ../../../victim/precious.txt dist/linked.txt',
        inputs: ['src/**'],
        outputs: ['dist/**'],
      }),
      files: precious,
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: precious } },
      { write: { 'packages/a/src/a.txt': 'a2\n' } },
      {
        run: 'build',
        expect: { exit: 0, files: { ...precious, 'packages/a/dist/app.txt': 'a2\n' } },
      },
      { write: { 'packages/a/dist': null } },
      { run: 'build', expect: { exit: 0, files: precious } },
      { check: { links: { 'packages/a/dist/linked.txt': '../../../victim/precious.txt' } } },
    ],
  }),

  defineCase({
    id: 'outputs/backslash-directory-name',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output under a directory whose name holds a backslash is restored',
    why: 'A backslash is an ordinary character in a file name on Linux and macOS. A tool that reads it as a path separator or an escape stores or restores the file under the wrong path, or not at all. The replay then leaves a tree missing an output the task wrote, under a green run.',
    from: ['inputs-resolution'],
    workspace: one({
      command: "mkdir -p 'dist/a\\b' && cp src/a.txt 'dist/a\\b/app.txt'",
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { 'packages/a/dist/a\\b/app.txt': 'a\n' } },
      },
    ],
  }),

  defineCase({
    id: 'outputs/unmatched-file-in-output-dir-kept',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A file under an output directory that no output pattern matches survives a rebuild and a replay',
    why: '`dist/**/*.js` names the build’s files; other files under `dist` are not the task’s to delete. A user may keep notes, fixtures or another tool’s files there. Clearing the whole directory before a run or a replay deletes them, and nothing brings them back.',
    from: ['inputs-resolution'],
    workspace: one({
      command: 'mkdir -p dist/a && cp src/a.txt dist/a/x.js',
      inputs: ['src/**'],
      outputs: ['dist/**/*.js'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist/keep/notes.txt': 'mine' } },
      { write: { 'packages/a/src/a.txt': 'a2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#build'],
          files: { 'packages/a/dist/keep/notes.txt': 'mine', 'packages/a/dist/a/x.js': 'a2\n' },
        },
      },
      { write: { 'packages/a/dist/a/x.js': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { 'packages/a/dist/keep/notes.txt': 'mine', 'packages/a/dist/a/x.js': 'a2\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/literal-directory-trailing-slash-output',
    category: 'outputs',
    kind: 'efficiency',
    title:
      'An output naming a directory with a trailing slash, `dist/`, stores and restores its tree',
    why: 'Writing a directory as `dist/` is a common way to say the whole tree. A tool that reads it as a pattern matching nothing stores an empty entry. The next replay then restores nothing, so the task has to run again for work that was already done, or the tree is left without its build.',
    from: ['inputs-resolution'],
    workspace: one(
      reads(['src/**'], 'src/a.txt', {
        command: 'mkdir -p dist/deep && cp src/a.txt dist/deep/b.txt',
        outputs: ['dist/'],
      }),
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { 'packages/a/dist/deep/b.txt': 'a\n' } },
      },
    ],
  }),

  defineCase({
    id: 'outputs/root-output-directory-literal',
    category: 'outputs',
    kind: 'efficiency',
    title: 'A root output naming a directory, `generated`, stores and restores its tree',
    why: 'A root output that names a directory, like `generated`, means everything under it. If the tool stores only the directory, or nothing, a later run cannot restore the files. The task then runs again for work already done, or a replay reports success while `generated` stays empty.',
    from: ['inputs-resolution'],
    workspace: one({
      command: 'mkdir -p ../../generated && cp src/a.txt ../../generated/s.txt',
      inputs: ['src/**'],
      outputs: [],
      rootOutputs: ['generated'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { generated: null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { 'generated/s.txt': 'a\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/root-output-in-own-project-not-input',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'A root output inside the task’s own project is not its own input, though its inputs cover it',
    why: 'A file the task writes is its output, never its input, even when an input glob such as `**` covers it. If the key includes it, each run changes the key of the next, so the second run misses. The task then reruns on every run and the cache never helps it.',
    from: ['inputs-resolution'],
    workspace: one({
      command: 'cp src/a.txt out.json',
      inputs: ['**'],
      outputs: [],
      rootOutputs: ['packages/a/out.json'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { 'packages/a/out.json': 'a\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/own-output-named-as-input',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A task naming its own output file among its inputs still replays',
    why: 'A task’s own output is never its input, even when the user lists it among the inputs. Keying on it means each run changes the key of the next, so the task never replays. Refusing the overlap as a config error is fine; keying the task on what it writes is not.',
    from: ['inputs-resolution'],
    workspace: one(reads(['src/a.txt', 'dist/out.txt'], 'src/a.txt')),
    steps: [
      { run: 'build', expect: { exit: 0, orRefused: true, ran: ['a#build'] } },
      {
        run: 'build',
        expect: { exit: 0, orRefused: true, notRan: ['a#build'], files: { [out('a')]: 'a\n' } },
      },
    ],
  }),

  // ── literals ───────────────────────────────────────────────────────────
  edits({
    id: 'inputs/literal-directory-prefix-sibling',
    kind: 'efficiency',
    title: 'An input naming the directory `gen` does not key the file `gen-a.txt` beside it',
    why: 'An input naming the directory `gen` covers what is inside it, not files whose names start with `gen`. A tool that matches by text prefix also keys `gen-a.txt`, a file the task never reads. Edits to that file then rerun the task for nothing, on every run that follows one.',
    from: ['inputs-resolution'],
    task: reads(['gen'], 'gen/x.txt'),
    files: { 'gen/x.txt': 'x\n', 'gen-a.txt': 'a\n' },
    changes: [
      [inA({ 'gen-a.txt': 'a2\n' }), false],
      [inA({ 'gen/x.txt': 'x2\n' }), true, 'x2\n'],
    ],
  }),

  edits({
    id: 'inputs/ignored-literal-beside-prefix-sibling',
    kind: 'correctness',
    title: 'A gitignored file `gen` named in the inputs is keyed beside a tracked `gen-notes.txt`',
    why: 'Naming a gitignored file in the inputs is an explicit request to key on it, and explicit config beats the ignore file. Here the task reads the ignored `gen`, so an edit to it must rerun the task. A tool that drops ignored files, or confuses `gen` with `gen-notes.txt`, replays the old output.',
    from: ['inputs-resolution'],
    task: reads(['gen', 'gen-notes.txt'], 'gen gen-notes.txt'),
    files: { '.gitignore': 'gen\n', gen: 'g\n', 'gen-notes.txt': 'n\n' },
    changes: [[inA({ gen: 'g2\n' }), true, 'g2\nn\n']],
  }),

  // ── in-run writes ──────────────────────────────────────────────────────
  defineCase({
    id: 'inputs/runtime-after-uncached-upstream',
    category: 'inputs',
    kind: 'correctness',
    needs: ['runtime-inputs', 'uncached-task'],
    title: 'A key command reading a file an uncached dependency rewrites answers after it ran',
    why: 'A key command must be asked after the tasks the build depends on have run, because they may change what it reads. Asked up front, it answers for the bytes before the rewrite, and the build is filed under that answer. A later run that starts from those bytes then replays a build for another version.',
    from: ['in-run-writes'],
    workspace: {
      projects: {
        app: {
          tasks: {
            bump: { command: 'cp next.txt ver.txt', inputs: [], cache: false },
            build: {
              command: 'mkdir -p dist && cat ver.txt > dist/out.txt',
              dependsOn: ['bump'],
              inputs: ['src/**'],
              runtime: ['cat packages/app/ver.txt'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a', 'ver.txt': '1', 'next.txt': '2' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('app')]: '2' } } },
      { write: { 'packages/app/ver.txt': '1', 'packages/app/next.txt': '1' } },
      { run: 'build', expect: { exit: 0, files: { [out('app')]: '1' } } },
    ],
  }),

  defineCase({
    id: 'inputs/runtime-output-not-utf8',
    category: 'inputs',
    kind: 'correctness',
    needs: ['runtime-inputs'],
    title: 'A key command printing a different byte that is not UTF-8 runs the task again',
    why: 'A key command’s output is bytes, and every byte must count. Decoded as text, `\\351` and `\\350` both become the same replacement character, so the key does not change. The second value then replays the first value’s build. Refusing such output is fine; merging two values into one key is not.',
    from: ['runtime-inputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'od -An -tx1 ../../marker | tr -d " \\n" > out.txt',
              inputs: [],
              runtime: ['cat marker'],
              outputs: ['out.txt'],
            },
          },
          files: { '.gitignore': 'out.txt\n' },
        },
      },
    },
    steps: [
      { sh: "printf '\\351' > marker" },
      { run: 'build', expect: { exit: 0, orRefused: true, files: { 'packages/a/out.txt': 'e9' } } },
      { sh: "printf '\\350' > marker" },
      { run: 'build', expect: { exit: 0, orRefused: true, files: { 'packages/a/out.txt': 'e8' } } },
    ],
  }),

  // ── git that hides an edit ─────────────────────────────────────────────
  edits({
    id: 'inputs/git-status-config-quoted-name',
    kind: 'correctness',
    title:
      'Colour, short status and quoted paths in the repository’s git config still let an edit rerun',
    why: 'Repository git settings are the user’s to choose and must not change what a task runner sees. A tool that parses the text of `git status` loses changes once colour, short format or quoted paths are on, or once a name holds quotes or a tab. Every edit then looks like no change, and the cache replays old output.',
    from: ['stale-hit-git'],
    task: reads(['src/**'], 'src/*'),
    files: { 'src/zaż "ó"\tx.txt': 'v1\n' },
    setup: [
      {
        sh: 'git config color.ui always && git config color.status always && git config status.short true && git config status.branch true && git config core.quotePath true',
      },
    ],
    changes: [[inA({ 'src/zaż "ó"\tx.txt': 'v2\n' }), true, 'v2\n']],
  }),

  defineCase({
    id: 'inputs/committed-file-under-own-output-dir',
    category: 'inputs',
    kind: 'correctness',
    title: 'An edit to a committed file inside the task’s own output directory runs it again',
    why: 'A committed file the task reads is an input, even when it sits inside a directory declared as output. Left out of the key as an output, an edit to it changes nothing the tool sees. The run then replays the old build and writes the old generated file over the new data.',
    from: ['stale-hit-git'],
    workspace: one(
      {
        command:
          'cp data/sponsors.json data/s.tmp && mv data/s.tmp data/sponsors.json && cp data/sponsors.json data/gen.json',
        inputs: ['**'],
        outputs: ['data'],
      },
      { 'data/sponsors.json': '["a"]', '.gitignore': 'data/gen.json\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/data/sponsors.json': '["b"]' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: {
            'packages/a/data/gen.json': '["b"]',
            'packages/a/data/sponsors.json': '["b"]',
          },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/committed-output-outside-inputs',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A committed edit to a file under the outputs, outside the inputs, is not reverted by a replay',
    why: 'A replay writes back what the task produced, not the committed state of every file under its output glob. Here `out/LICENSE` is committed source the task never writes. If the entry holds a copy of it, a replay puts the old LICENSE back over the one just committed, and the user’s change is silently undone.',
    from: ['stale-hit-git'],
    workspace: one(
      {
        command: 'mkdir -p out && cat src/*.txt > out/out.txt',
        inputs: ['src/**'],
        outputs: ['out/**'],
      },
      { 'src/a.txt': 'a\n', 'out/LICENSE': 'license v1', '.gitignore': 'out/out.txt\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/out/LICENSE': 'license v2' } },
      { commit: 'license v2' },
      { run: 'build', expect: { exit: 0, files: { 'packages/a/out/LICENSE': 'license v2' } } },
    ],
  }),

  defineCase({
    id: 'outputs/committed-output-mode-change-kept',
    category: 'outputs',
    kind: 'correctness',
    title: 'A committed file under the outputs made executable is not made plain again by a replay',
    why: 'The user committed a mode change to a file that sits under the outputs. A replay writes back the cached copy with its old mode and quietly undoes that commit. The tree must keep what the user changed and committed, since the task itself never ran to produce a new one.',
    from: ['stale-hit-git'],
    workspace: one(
      {
        command: 'mkdir -p out && cat src/*.txt > out/out.txt',
        inputs: ['src/**'],
        outputs: ['out/**'],
      },
      { 'src/a.txt': 'a\n', 'out/tool.sh': 'echo tool\n', '.gitignore': 'out/out.txt\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { chmod: { 'packages/a/out/tool.sh': 0o755 } },
      { commit: 'tool is executable' },
      { run: 'build', expect: { exit: 0 } },
      { check: { executable: ['packages/a/out/tool.sh'] } },
    ],
  }),

  defineCase({
    id: 'outputs/force-added-ignored-output-kept',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A file force-added to git under ignored outputs, then edited and committed, is not reverted by a replay',
    why: 'Git tracks the file although its folder is ignored, because the user added it on purpose and then edited and committed it. A replay that writes the cached copy over it destroys committed work. The tree must keep what version control holds, not what an older run left behind.',
    from: ['stale-hit-git'],
    workspace: one(
      {
        command: 'mkdir -p out && cat src/*.txt > out/out.txt',
        inputs: ['src/**'],
        outputs: ['out/**'],
      },
      { 'src/a.txt': 'a\n', 'out/keep.txt': 'keep v1\n', '.gitignore': 'out/\n' },
    ),
    steps: [
      { sh: 'git add -f packages/a/out/keep.txt && git commit -q -m keep' },
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/out/keep.txt': 'keep v2\n' } },
      { sh: 'git add -f packages/a/out/keep.txt && git commit -q -m "keep v2"' },
      { run: 'build', expect: { exit: 0, files: { 'packages/a/out/keep.txt': 'keep v2\n' } } },
    ],
  }),

  defineCase({
    id: 'outputs/codegen-rewrites-committed-output',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A generator rewriting its committed output leaves the new bytes, and a later run brings them back',
    why: 'A generated file that is also committed must end up matching what the generator makes now. After the user resets it to the committed version, the next run must bring the new output back, by running or by replay. A tool that sees the committed bytes and calls it done leaves a stale route table in the tree.',
    from: ['stale-hit-git'],
    workspace: one(
      {
        command: 'ls routes > src/routeTree.gen.txt',
        inputs: ['routes/**', 'src/**'],
        outputs: ['src/routeTree.gen.txt'],
      },
      { 'routes/a.tsx': 'a', 'src/routeTree.gen.txt': 'a.tsx\n' },
    ),
    steps: [
      { write: { 'packages/a/routes/b.tsx': 'b' } },
      {
        run: 'build',
        expect: { exit: 0, files: { 'packages/a/src/routeTree.gen.txt': 'a.tsx\nb.tsx\n' } },
      },
      { sh: 'git checkout -- packages/a/src/routeTree.gen.txt' },
      {
        run: 'build',
        expect: { exit: 0, files: { 'packages/a/src/routeTree.gen.txt': 'a.tsx\nb.tsx\n' } },
      },
    ],
  }),

  defineCase({
    id: 'outputs/committed-root-output-survives',
    category: 'outputs',
    kind: 'correctness',
    title: 'A committed file under a root output glob survives a run that no longer writes it',
    why: 'A committed file under an output glob is source the repository holds, not something this task made. A task that stops writing it does not own it. Clearing every match before the run deletes it, and the user finds a tracked file missing after a build.',
    from: ['stale-hit-git'],
    workspace: {
      projects: {
        a: {
          tasks: {
            codegen: {
              command: 'sh emit.sh',
              inputs: ['emit.sh'],
              outputs: [],
              rootOutputs: ['gen/**'],
            },
          },
          files: {
            'emit.sh': 'mkdir -p ../../gen\nprintf a > ../../gen/a.js\nprintf b > ../../gen/b.ts\n',
          },
        },
      },
      files: { 'gen/a.js': 'a', 'gen/b.ts': 'b' },
    },
    steps: [
      { run: 'codegen', expect: { exit: 0, files: { 'gen/b.ts': 'b' } } },
      { write: { 'packages/a/emit.sh': 'mkdir -p ../../gen\nprintf a > ../../gen/a.js\n' } },
      { run: 'codegen', expect: { exit: 0, files: { 'gen/a.js': 'a', 'gen/b.ts': 'b' } } },
    ],
  }),

  defineCase({
    id: 'inputs/sparse-path-materialised',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A skip-worktree input absent from disk, as a sparse checkout leaves it, reruns the task once it appears',
    why: 'A sparse checkout leaves some tracked files off disk; that is not a change by anyone. When the file appears, the task reads new content and must rerun. A tool that trusts git’s skip-worktree flag never looks at the file and replays the build made without it.',
    from: ['stale-hit-git'],
    workspace: one(reads(['src/**'], 'src/*.txt'), { 'src/a.txt': 'A\n', 'src/sparse.txt': 'S\n' }),
    steps: [
      {
        sh: 'git update-index --skip-worktree packages/a/src/sparse.txt && rm packages/a/src/sparse.txt',
      },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'A\n' } } },
      { write: { 'packages/a/src/sparse.txt': 'S\n' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'A\nS\n' } } },
    ],
  }),

  crlf(
    'inputs/crlf-to-lf-under-text-attribute',
    'Under `* text=auto`, changing an input from CRLF to LF runs the task again',
    'Under `* text=auto`, git normalises line endings, so a CRLF file and its LF version are one blob to git. The task reads the bytes on disk, and those differ. A tool that keys on git’s blob id sees no change and replays the CRLF build, here a wrong byte count. Windows checkouts and editors switch endings all the time.',
    'printf "* text=auto\\n" > .gitattributes && git add -A && git commit -qm attrs && git rm -q --cached packages/a/src/a.txt && git add packages/a/src/a.txt && git commit -qm lf',
    ['stale-hit-git'],
  ),

  crlf(
    'inputs/crlf-to-lf-under-root-attribute-scoped',
    'A root `.gitattributes` text rule reaches a run of one project: CRLF to LF runs it again',
    'A root `.gitattributes` applies to every project, also when a run selects only one. git compares the file after that rule, so CRLF and LF read as one blob while the task reads different bytes. A tool that trusts git here, or reads attributes only from the selected project, replays the build made from the CRLF file.',
    'printf "* text=auto\\n" > .gitattributes && git add -A && git commit -qm attrs && git rm -q --cached packages/a/src/a.txt && git add packages/a/src/a.txt && git commit -qm lf',
    ['stale-hit-git'],
    true,
  ),

  crlf(
    'inputs/crlf-to-lf-under-global-attributes',
    'A text rule in the user’s global git attributes file: CRLF to LF runs the task again',
    'Text rules can also come from the user’s global git attributes file, outside the repo. Under such a rule git sees CRLF and LF as one blob, while the task reads different bytes. A tool that trusts git’s view replays the old build, and only on machines with that setting, which makes the stale result hard to reproduce.',
    'mkdir -p "$XDG_CONFIG_HOME/git" && printf "* text\\n" > "$XDG_CONFIG_HOME/git/attributes" && git rm -q --cached packages/a/src/a.txt && git add packages/a/src/a.txt && git commit -qm lf',
    ['stale-hit-git'],
  ),

  defineCase({
    id: 'inputs/same-size-line-ending-swap-under-text-attribute',
    category: 'inputs',
    kind: 'correctness',
    title:
      'Under `* text=auto eol=lf`, moving a CR to another line, same size, runs the task again',
    why: 'Under a text rule git compares a file after normalising its line endings. `a\\r\\nb\\n` rewritten as `a\\nb\\r\\n` has the same size and the same normalised blob, so git calls it clean and keeps the old stat in its index. The task reads different bytes. A tool that trusts git’s blob id, or its index stat, replays the first build.',
    from: ['stale-hit-git'],
    workspace: one(
      {
        command: 'mkdir -p dist && cp src/a.txt dist/out.txt',
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
      { 'src/a.txt': 'a\r\nb\n' },
    ),
    steps: [
      {
        sh: 'printf "* text=auto eol=lf\\n" > .gitattributes && git add -A && git commit -qm attrs && git rm -q --cached packages/a/src/a.txt && git add packages/a/src/a.txt && git commit -qm lf',
      },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\r\nb\n' } } },
      { write: { 'packages/a/src/a.txt': 'a\nb\r\n' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\nb\r\n' } } },
    ],
  }),

  crlf(
    'inputs/crlf-to-lf-under-autocrlf',
    'With `core.autocrlf` set, changing an input from CRLF to LF runs the task again',
    '`core.autocrlf` makes git convert line endings, so it reports no change when CRLF becomes LF. The task reads the file on disk, whose bytes did change. A tool that trusts git here replays the CRLF build, and whether a developer gets a stale result depends on their own git config.',
    'git config core.autocrlf true && git rm -q --cached packages/a/src/a.txt && git add packages/a/src/a.txt && git commit -qm lf',
    ['stale-hit-git'],
  ),

  weakStat(
    'core.trustctime',
    'false',
    'With `core.trustctime=false` git ignores the change time, so a same-size rewrite that keeps the mtime looks clean to git. The task reads new bytes all the same. A tool that trusts git’s clean answer replays the old output. The setting is common where backup or indexing tools touch the change time.',
  ),
  weakStat(
    'core.checkStat',
    'minimal',
    'With `core.checkStat=minimal` git compares only size and whole-second mtime. A same-size edit with the same mtime then looks clean to git while the bytes differ. A tool that trusts git’s answer replays the old output. Such edits come from tools that restore timestamps, such as archive extractors and sync tools.',
  ),

  defineCase({
    id: 'inputs/root-output-into-consumer-project',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A consumer reading what its dependency writes into it as a root output builds each version',
    why: 'A file one task writes into another project mid-run must be keyed as it is when the reader runs. Keyed before it lands, the consumer’s key reflects the previous version, and the run replays a build made from another version. Cycling through versions shows the mismatch. A tool may refuse an input over another task’s output instead.',
    from: ['stale-hit-git'],
    workspace: {
      projects: {
        gen: {
          tasks: {
            codegen: {
              command:
                'mkdir -p ../app/gen out && cat src/version.txt > ../app/gen/out.txt && cp src/version.txt out/marker.txt',
              inputs: ['src/**'],
              outputs: ['out/**'],
              rootOutputs: ['packages/app/gen/**'],
            },
          },
          files: { 'src/version.txt': 'v0', '.gitignore': 'out/\n' },
        },
        app: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat gen/out.txt > dist/out.txt',
              dependsOn: ['gen#codegen'],
              inputs: ['gen/**'],
              outputs: ['dist/**'],
            },
          },
        },
      },
    },
    steps: ['vA', 'vB', 'vC', 'vA', 'vB', 'vC', 'vA', 'vB', 'vC'].flatMap((v): Step[] => [
      { write: { 'packages/gen/src/version.txt': v } },
      { commit: v },
      {
        run: 'build',
        expect: {
          exit: 0,
          orRefused: true,
          files: { [out('app')]: v, 'packages/app/gen/out.txt': v },
        },
      },
    ]),
  }),

  defineCase({
    id: 'outputs/rename-input-back-restores-own-outputs',
    category: 'outputs',
    kind: 'correctness',
    title: 'Renaming an input and back leaves only the outputs that name produces',
    why: 'Renaming a file can change which output files a task writes, even with the same bytes. Each name’s entry holds its own outputs, and switching back must leave only that name’s files. A replay that adds to the old tree leaves `a.js` and `b.js` side by side, and a bundle or test picks up a file with no source.',
    from: ['stale-hit-git'],
    workspace: one({
      command:
        'mkdir -p dist && for f in src/*.txt; do cp "$f" "dist/$(basename "$f" .txt).js"; done',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'packages/a/dist/a.js': 'a\n' } } },
      ...[
        ['a', 'b'],
        ['b', 'a'],
        ['a', 'b'],
      ].flatMap(([from, to]): Step[] => [
        { write: { [`packages/a/src/${from}.txt`]: null, [`packages/a/src/${to}.txt`]: 'a\n' } },
        {
          run: 'build',
          expect: {
            exit: 0,
            files: { [`packages/a/dist/${to}.js`]: 'a\n', [`packages/a/dist/${from}.js`]: null },
          },
        },
      ]),
    ],
  }),

  // ── names that are not UTF-8 ───────────────────────────────────────────
  ...[true, false].map((tracked) =>
    defineCase({
      id: `inputs/non-utf8-name-${tracked ? 'tracked' : 'untracked'}`,
      category: 'inputs',
      kind: 'correctness',
      title: `An edit to ${tracked ? 'a committed' : 'an untracked'} input whose name is not UTF-8 never replays the old build`,
      why: `File names on Linux are bytes and need not be valid UTF-8. ${tracked ? 'Committed, such a name reaches a tool through git, which escapes it in its plain output' : 'Untracked, such a name is found only by walking the disk'}; a tool that cannot decode it may drop the file from the key, and its edit replays the old build. Refusing the name is acceptable; ignoring the file is not.`,
      from: ['stale-hit-git'],
      workspace: catAll,
      steps: [
        {
          sh: `printf bad1 > "packages/a/src/${BAD}"${tracked ? ' && git add -A && git commit -qm bad' : ''}`,
        },
        {
          run: 'build',
          expect: { exit: 0, orRefused: true, files: { 'packages/a/dist/all': 'v1bad1' } },
        },
        { sh: `printf bad2 > "packages/a/src/${BAD}"` },
        {
          run: 'build',
          expect: { exit: 0, orRefused: true, files: { 'packages/a/dist/all': 'v1bad2' } },
        },
      ],
    }),
  ),

  defineCase({
    id: 'inputs/non-utf8-root-input',
    category: 'inputs',
    kind: 'correctness',
    title: 'An edit to a root input whose name is not UTF-8 never replays the old build',
    why: 'Root inputs are matched like project inputs, and a name that is not UTF-8 must count there too. Shared files at the root are often read by many tasks. A tool that drops the odd name from the key replays old builds in every task that reads it. Refusing the name is acceptable; skipping it is not.',
    from: ['stale-hit-git'],
    workspace: {
      ...one({
        command: 'mkdir -p dist && cat ../../shared/* > dist/all',
        inputs: ['src/**'],
        rootInputs: ['shared/**'],
        outputs: ['dist/**'],
      }),
      files: { 'shared/ok': 'o' },
    },
    steps: [
      { sh: `printf bad1 > "shared/${BAD}" && git add -A && git commit -qm bad` },
      {
        run: 'build',
        expect: { exit: 0, orRefused: true, files: { 'packages/a/dist/all': 'obad1' } },
      },
      { sh: `printf bad2 > "shared/${BAD}"` },
      {
        run: 'build',
        expect: { exit: 0, orRefused: true, files: { 'packages/a/dist/all': 'obad2' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/non-utf8-name-other-project-runs',
    category: 'inputs',
    kind: 'correctness',
    title: 'A name that is not UTF-8 in one project does not stop another project’s task',
    why: 'A problem in one project’s files must not stop unrelated projects. A tool that fails the whole workspace on one odd file name blocks every build until someone renames it. Refusing the project that holds the name, or keying the name as bytes, both let project `b` build.',
    from: ['stale-hit-git'],
    workspace: {
      projects: Object.fromEntries(
        ['a', 'b'].map((p) => [
          p,
          {
            tasks: {
              build: { command: 'cat src/* > out.txt', inputs: ['src/**'], outputs: ['out.txt'] },
            },
            files: { 'src/i': '1', '.gitignore': 'out.txt\n' },
          },
        ]),
      ),
    },
    steps: [
      { sh: `printf bad > "packages/a/src/${BAD}" && git add -A && git commit -qm bad` },
      { run: 'build', expect: { ran: ['b#build'], files: { 'packages/b/out.txt': '1' } } },
    ],
  }),

  edits({
    id: 'inputs/replacement-character-name',
    kind: 'correctness',
    title: 'An input whose name holds U+FFFD as a character is an input like any other',
    why: 'U+FFFD is a valid character that a file name can hold, not a sign of a broken name. A tool that uses it to mark bytes it could not decode, and then drops such names, loses a real file from the key. Edits to it then replay the old output, under a green run.',
    from: ['stale-hit-git'],
    task: {
      command: 'mkdir -p dist && cat src/* > dist/out.txt',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    },
    files: { 'src/a': 'v1', 'src/x�y': 'f1' },
    changes: [[inA({ 'src/x�y': 'f2' }), true, 'v1f2']],
  }),

  defineCase({
    id: 'outputs/non-utf8-output-name',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output whose name is not UTF-8 is there after the next run, replayed or rebuilt',
    why: 'Outputs whose names are not UTF-8 must be stored and restored like any other. An entry saved without such a file restores a tree missing an output the task wrote. Anything that later reads that file fails, or ships without it, under a green run. Rebuilding instead of replaying is also correct.',
    from: ['stale-hit-git'],
    workspace: one({
      command: `mkdir -p dist && printf a > dist/ok && printf b > "dist/${BAD}"`,
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: {} },
      { write: { 'packages/a/dist': null } },
      { run: 'build', expect: { files: { 'packages/a/dist/ok': 'a' } } },
      { sh: `test -f "packages/a/dist/${BAD}"` },
    ],
  }),

  // ── dependencies ───────────────────────────────────────────────────────
  defineCase({
    id: 'inputs/hand-file-in-dependency-output',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'A file dropped by hand into a dependency’s output directory does not rerun its dependants',
    why: 'A dependant keys on what its dependency is built from, not on every file sitting in the dependency’s output directory. A stray file dropped there by hand does not change what the dependency produces. Rerunning the whole chain for it wastes time, and the dependency’s replay restores its own outputs anyway.',
    from: ['parity-nx-hashing'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        ui: chainProject('ui', ['lib']),
        app: chainProject('app', ['ui']),
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/ui/dist/index.d.ts': 'x\n' } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['app#build'], files: { [out('app')]: 'lib\nui\napp\n' } },
      },
    ],
  }),

  edits({
    id: 'inputs/root-input-new-file',
    kind: 'correctness',
    title: 'A new file under a root input glob runs the task again',
    why: 'A root input glob names a set of files, and adding a file to it is a change. A new file under shared `config/` often changes how every task that reads it builds. A tool that keys only the root files it saw before replays the old output without the new config.',
    from: ['parity-nx-hashing'],
    task: reads(['src/**'], '../../config/*', { rootInputs: ['config/**'] }),
    files: { 'src/a.txt': 'a\n' },
    rootFiles: { 'config/a.json': '1\n' },
    changes: [
      [{ 'config/a.json': '2\n' }, true, '2\n'],
      [{ 'config/b.json': '3\n' }, true, '2\n3\n'],
    ],
  }),

  defineCase({
    id: 'inputs/input-glob-over-sibling-task-output',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A task whose inputs cover another task’s output never replays a build of that output’s old bytes',
    why: 'When one task’s inputs cover another task’s output, the key must see that output as it is when the reader runs. Keyed before it lands, the reader’s key reflects the previous contents, and the run replays a build of old generated code. Switching the seed back and forth shows it. A tool may refuse the overlap instead.',
    from: ['parity-nx-hashing'],
    workspace: {
      projects: {
        a: {
          tasks: {
            gen: {
              command: 'mkdir -p src/gen && cat seed.txt > src/gen/x.txt',
              inputs: ['seed.txt'],
              outputs: ['src/gen/**'],
            },
            build: {
              command: 'mkdir -p dist && cat src/gen/x.txt > dist/out.txt',
              dependsOn: ['gen'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'seed.txt': 'one\n', 'src/a.txt': 'a\n', '.gitignore': 'src/gen/\n' },
        },
      },
    },
    steps: sequence(
      [
        [{}, 'one\n'],
        [{ 'packages/a/seed.txt': 'two\n' }, 'two\n'],
        [{ 'packages/a/seed.txt': 'one\n' }, 'one\n'],
      ],
      out('a'),
      { orRefused: true },
    ),
  }),

  defineCase({
    id: 'inputs/project-cycle-edit-reruns-only-it',
    category: 'inputs',
    kind: 'efficiency',
    title: 'In projects that depend on each other, editing one reruns only its task',
    why: 'Projects that depend on each other through their manifests still own separate files. A task that reads only its own sources, with no task dependency, need not rerun when the other project changes. Treating the cycle as one unit reruns both on every edit, or refuses a workspace the package manager accepts.',
    from: ['parity-nx-hashing'],
    workspace: {
      projects: Object.fromEntries(
        [
          ['lib', 'ui'],
          ['ui', 'lib'],
        ].map(([p, dep]) => [
          p!,
          {
            deps: [dep!],
            tasks: {
              lint: {
                command: 'cat src/a.txt > out.txt',
                inputs: ['src/**'],
                outputs: ['out.txt'],
              },
            },
            files: { 'src/a.txt': `${p}\n`, '.gitignore': 'out.txt\n' },
          },
        ]),
      ),
    },
    steps: [
      { run: 'lint', expect: { exit: 0 } },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { run: 'lint', expect: { exit: 0, ran: ['lib#lint'], notRan: ['ui#lint'] } },
    ],
  }),

  defineCase({
    id: 'inputs/upstream-deletes-input',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input a dependency deletes before its dependant starts lets the dependant run',
    why: 'A file a dependency deletes before the dependant runs is simply absent when the dependant reads its inputs. The right key treats it as gone. A tool that hashed the inputs up front fails on the missing file, or keys content that no longer exists and later replays a listing that still names it.',
    from: ['absent-input'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'rm -f ../b/src/gen.txt && echo a > out.txt',
              inputs: ['src/**'],
              outputs: ['out.txt'],
            },
          },
          files: { 'src/x': 'x', '.gitignore': 'out.txt\n' },
        },
        b: {
          deps: ['a'],
          tasks: {
            build: {
              command: 'ls src > out.txt',
              dependsOn: ['^build'],
              inputs: ['src/**'],
              outputs: ['out.txt'],
            },
          },
          files: { 'src/keep': 'k', 'src/gen.txt': 'g', '.gitignore': 'out.txt\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build', 'b#build'], files: { 'packages/b/out.txt': 'keep\n' } },
      },
    ],
  }),

  // ── links among the inputs ─────────────────────────────────────────────
  linkCase({
    id: 'inputs/linked-input-directories',
    title:
      'Edits behind an input directory that is a link, and behind a linked root input directory, rerun',
    why: 'A task reads through a linked directory to the files behind it, and shared code is often linked into a project this way. A tool that keys on the link itself, or skips links while walking, sees no change when the files behind it are edited. The run then replays the old build.',
    from: ['linked-inputs', 'parity-nx-hashing'],
    task: linkedRead('lib/x.txt ../../ws/x.txt', { inputs: ['lib/**'], rootInputs: ['ws/**'] }),
    rootFiles: { 'shared/x.txt': 'V1\n', 'other/x.txt': 'W1\n' },
    links: { 'packages/a/lib': '../../shared', ws: 'other' },
    first: 'V1\nW1\n',
    changes: [
      [{ 'shared/x.txt': 'V2\n' }, 'V2\nW1\n'],
      [{ 'other/x.txt': 'W2\n' }, 'V2\nW2\n'],
    ],
  }),

  linkCase({
    id: 'inputs/linked-directory-below-glob-prefix',
    title: 'Edits behind links below a glob’s fixed directory, one of them never committed, rerun',
    why: 'Links can sit anywhere below a glob’s fixed part, and some are made after the last commit. The task reads through all of them. A tool that walks only the fixed directory, or lists only what git tracks, misses edits behind these links and replays the old build.',
    from: ['linked-inputs'],
    task: linkedRead('src/v/x.txt lib/y.txt ../../ws/l/z.txt', {
      inputs: ['src/**/*.txt', '**/*.txt'],
      rootInputs: ['ws/**/*.txt'],
    }),
    rootFiles: { 'shared/x.txt': 'V1\n', 'more/y.txt': 'M1\n', 'other/z.txt': 'W1\n' },
    links: { 'packages/a/src/v': '../../../shared', 'ws/l': '../other' },
    laterLinks: { 'packages/a/lib': '../../more' },
    first: 'V1\nM1\nW1\n',
    changes: [
      [{ 'shared/x.txt': 'V2\n' }, 'V2\nM1\nW1\n'],
      [{ 'more/y.txt': 'M2\n' }, 'V2\nM2\nW1\n'],
      [{ 'other/z.txt': 'W2\n' }, 'V2\nM2\nW2\n'],
    ],
  }),

  linkCase({
    id: 'inputs/linked-brace-alternative',
    title: 'An edit behind a brace alternative’s directory that is a link reruns',
    why: 'A brace pattern like `{lib,src}/**` expands into several directories, and any of them can be a link. A tool that follows links for plain globs but not for brace alternatives misses edits behind a linked one. The run then replays old output for files the task reads.',
    from: ['linked-inputs'],
    task: linkedRead('lib/x.txt etc/x.txt', { inputs: ['{lib,src}/**', '{etc/**,src/**}'] }),
    rootFiles: { 'shared/x.txt': 'V1\n', 'other/x.txt': 'W1\n' },
    links: { 'packages/a/lib': '../../shared', 'packages/a/etc': '../../other' },
    first: 'V1\nW1\n',
    changes: [
      [{ 'shared/x.txt': 'V2\n' }, 'V2\nW1\n'],
      [{ 'other/x.txt': 'W2\n' }, 'V2\nW2\n'],
    ],
  }),

  linkCase({
    id: 'inputs/linked-directory-in-ignored-input',
    title: 'An edit behind a link inside a gitignored input directory reruns',
    why: 'Naming an ignored directory in the inputs opts it in, and links inside it still lead to files the task reads. Generated folders often hold links to shared code. A tool that walks the ignored folder but does not follow its links misses edits behind them and replays the old build.',
    from: ['linked-inputs'],
    task: linkedRead('gen/v/x.txt ../../gen/l/z.txt', {
      inputs: ['gen/**/*.txt'],
      rootInputs: ['gen/**/*.txt'],
    }),
    files: { '.gitignore': 'out.txt\ngen/\n' },
    rootFiles: { 'shared/x.txt': 'V1\n', 'other/z.txt': 'W1\n', 'gen/.gitignore': '*\n' },
    links: { 'packages/a/gen/v': '../../../shared', 'gen/l': '../other' },
    first: 'V1\nW1\n',
    changes: [
      [{ 'shared/x.txt': 'V2\n' }, 'V2\nW1\n'],
      [{ 'other/z.txt': 'W2\n' }, 'V2\nW2\n'],
    ],
  }),

  linkCase({
    id: 'inputs/file-link-out-of-project-committed',
    title: 'A committed edit to a tracked file an input link out of the project points at reruns',
    why: 'A link that points outside the project still names a file the task reads. Committing the edit behind it must not hide it: git sees the link itself unchanged, since only the target’s content moved. A tool that keys on git’s record of the link replays the build made from the old target.',
    from: ['linked-inputs'],
    task: linkedRead('src/x.txt'),
    rootFiles: { 'shared/x.txt': 'V1\n' },
    links: { 'packages/a/src/x.txt': '../../../shared/x.txt' },
    first: 'V1\n',
    changes: [[{ 'shared/x.txt': 'V2\n' }, 'V2\n', true]],
  }),

  linkCase({
    id: 'inputs/file-link-out-of-project',
    title: 'An edit behind an input link to a file outside the project reruns',
    why: 'A task reads the contents behind an input link, wherever that file lives. A tool that keys on the link’s own text sees the same target path after an edit. The run then replays output built from the old contents, though the file the task reads has changed.',
    from: ['parity-nx-hashing', 'linked-inputs'],
    task: linkedRead('src/x.txt'),
    rootFiles: { 'elsewhere/linked.txt': 'O1\n' },
    links: { 'packages/a/src/x.txt': '../../../elsewhere/linked.txt' },
    first: 'O1\n',
    changes: [[{ 'elsewhere/linked.txt': 'O2\n' }, 'O2\n']],
  }),

  linkCase({
    id: 'inputs/file-link-to-ignored-file',
    title: 'An edit to a gitignored file an input link points at reruns',
    why: 'A link listed as an input makes its target an input, even when the target is gitignored: explicit inputs beat ignore rules. A tool that keys only on tracked or unignored content misses the edit behind the link. The run then replays the build made from the old target.',
    from: ['linked-inputs'],
    task: linkedRead('src/x.txt'),
    files: { '.gitignore': 'out.txt\nsecret.txt\n', 'secret.txt': 'S1\n' },
    rootFiles: {},
    links: { 'packages/a/src/x.txt': '../secret.txt' },
    first: 'S1\n',
    changes: [[{ 'packages/a/secret.txt': 'S2\n' }, 'S2\n']],
  }),

  linkCase({
    id: 'inputs/linked-directory-new-file',
    title: 'An edit, and then a new file, behind a linked input directory rerun',
    why: 'Files behind a linked input directory count like files in a real one, including new ones. A tool that records the directory’s content once, or only what git tracks, misses a file added behind the link. The task’s glob reads it, so the replayed output is missing it.',
    from: ['linked-inputs', 'parity-nx-hashing'],
    task: linkedRead('src/sh/*.txt'),
    rootFiles: { 'shared/x.txt': 'V1\n' },
    links: { 'packages/a/src/sh': '../../../shared' },
    first: 'V1\n',
    changes: [
      [{ 'shared/x.txt': 'V2\n' }, 'V2\n', true],
      [{ 'shared/y.txt': 'Y\n' }, 'V2\nY\n'],
    ],
  }),

  linkCase({
    id: 'inputs/link-inside-linked-directory',
    title: 'An edit behind a link found inside a linked input directory reruns',
    why: 'Links can chain: a linked directory may itself hold links. The task follows every one of them when it reads. A tool that resolves only the first level keys a link it cannot see through, and edits behind the second link replay the old build. Shared folders linked from several places often look like this.',
    from: ['linked-inputs', 'parity-nx-hashing'],
    task: linkedRead('src/d/deep/x.txt src/d/z.txt'),
    rootFiles: { 'outside/d/deep/x.txt': 'O1\n', 'outside/z.txt': 'Z1\n' },
    links: { 'outside/d/z.txt': '../z.txt', 'packages/a/src/d': '../../../outside/d' },
    first: 'O1\nZ1\n',
    changes: [
      [{ 'outside/d/deep/x.txt': 'O2\n' }, 'O2\nZ1\n'],
      [{ 'outside/z.txt': 'Z2\n' }, 'O2\nZ2\n'],
    ],
  }),

  linkCase({
    id: 'inputs/dangling-link-target-appears',
    title: 'A dangling input link reruns its task once the file it names appears',
    why: 'A dangling link is an input whose target is missing, and that missing state belongs in the key. When the target appears, the task reads new content and must rerun. A tool that skips dangling links keys the same before and after, and keeps replaying output that says the file is absent.',
    from: ['linked-inputs'],
    task: linkedRead('src/x.txt', {
      command: 'cat src/x.txt > out.txt 2>/dev/null || echo none > out.txt',
    }),
    rootFiles: {},
    links: { 'packages/a/src/x.txt': '../nowhere.txt' },
    first: 'none\n',
    changes: [[{ 'packages/a/nowhere.txt': 'N\n' }, 'N\n']],
  }),

  defineCase({
    id: 'inputs/link-loop',
    category: 'inputs',
    kind: 'efficiency',
    title: 'Input links that point at each other are no error, and an unchanged tree replays',
    why: 'Links that point at each other are legal on disk and turn up in real repos by mistake. A tool that follows them without a limit hangs or crashes, and one that treats them as an error fails a build that runs fine. Keying them as unresolved links lets an unchanged tree replay like any other.',
    from: ['linked-inputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: linkedRead('src/a.txt', {
              command: 'cat src/a.txt > out.txt 2>/dev/null || echo none > out.txt',
            }),
          },
          files: { '.gitignore': 'out.txt\n' },
        },
      },
    },
    steps: [
      { link: { 'packages/a/src/a.txt': 'b.txt', 'packages/a/src/b.txt': 'a.txt' } },
      { commit: 'loop' },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT_TXT]: 'none\n' } } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  // ── outputs that matched nothing ───────────────────────────────────────
  defineCase({
    id: 'outputs/stray-under-empty-output-wiped',
    category: 'outputs',
    kind: 'correctness',
    title: 'A stray file under an output glob the task never wrote to is gone after a replay',
    why: 'A replay must leave the output tree as the task left it, and here the task wrote nothing. A tool that skips the clean when the entry is empty leaves a stray file in place. That file then ships, or gets tested, as if this build had made it, and the next clean build disagrees.',
    from: ['cache-declaration-warnings'],
    workspace: one({ command: 'true', inputs: ['src/**'], outputs: ['build/**'] }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/build/stray.js': 'x' } },
      { run: 'build', expect: { exit: 0, files: { 'packages/a/build/stray.js': null } } },
    ],
  }),

  defineCase({
    id: 'outputs/stray-under-empty-root-output-wiped',
    category: 'outputs',
    kind: 'correctness',
    title: 'A stray file under a root output glob the task never wrote to is gone after a replay',
    why: 'A root output glob is cleaned on replay like a project one, even when the task wrote nothing under it. Otherwise a stray file, left by hand or by an older build, stays in a directory the task owns. Later steps then read it as if this build produced it.',
    from: ['cache-declaration-warnings'],
    workspace: one({
      command: 'true',
      inputs: ['src/**'],
      outputs: [],
      rootOutputs: ['nowhere/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { write: { 'nowhere/stray.js': 'x' } },
      { run: 'build', expect: { exit: 0, files: { 'nowhere/stray.js': null } } },
    ],
  }),

  // ── names, permissions ─────────────────────────────────────────────────
  defineCase({
    id: 'affected/non-ascii-names-select',
    category: 'affected',
    kind: 'correctness',
    needs: ['affected'],
    title: 'Changed files named in CJK, Cyrillic or with an emoji select their projects',
    why: 'Changed files with CJK, Cyrillic or emoji names are ordinary changes. git escapes such names in its plain output; a tool that reads that output without undoing the escaping maps the path to no project. Those projects are then left out of an affected run, and CI skips the very code that changed.',
    from: ['affected-unicode'],
    workspace: {
      projects: Object.fromEntries(
        Object.entries({ cjk: '测试 文件.txt', cyr: 'файл.rs', emoji: null, quiet: 'q.txt' }).map(
          ([p, f]) => [
            p,
            {
              tasks: {
                build: { command: 'echo x > out.txt', inputs: ['**'], outputs: ['out.txt'] },
              },
              files: { '.gitignore': 'out.txt\n', ...(f ? { [f]: '1\n' } : { 'k.txt': 'k\n' }) },
            },
          ],
        ),
      ),
    },
    steps: [
      { write: { 'packages/cjk/测试 文件.txt': '2\n' } },
      { commit: 'edit' },
      { write: { 'packages/cyr/файл.rs': '2\n', 'packages/emoji/emoji_🚀.md': 'new\n' } },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: {
          exit: 0,
          ran: ['cjk#build', 'cyr#build', 'emoji#build'],
          notRan: ['quiet#build'],
        },
      },
    ],
  }),

  defineCase({
    id: 'affected/non-ascii-project-directory',
    category: 'affected',
    kind: 'correctness',
    needs: ['affected'],
    title: 'A committed change in a project whose directory is named `café` selects it',
    why: 'A project’s directory may have a non-ASCII name like `café`, and a change inside it must select it. If git’s escaped path is compared with the decoded directory name, the two never match. The changed project is then left out of an affected run, and CI goes green without testing it.',
    from: ['affected-unicode'],
    workspace: {
      projects: Object.fromEntries(
        [
          ['cafe', 'packages/café'],
          ['plain', 'packages/plain'],
        ].map(([p, dir]) => [
          p!,
          {
            dir: dir!,
            tasks: { build: { command: 'echo x > out.txt', inputs: ['**'], outputs: ['out.txt'] } },
            files: { '.gitignore': 'out.txt\n', 'x.txt': '1\n' },
          },
        ]),
      ),
    },
    steps: [
      { write: { 'packages/café/x.txt': '2\n' } },
      { commit: 'edit' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['cafe#build'], notRan: ['plain#build'] },
      },
    ],
  }),

  defineCase({
    id: 'inputs/unreadable-input-never-stale',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input made unreadable after an edit fails the task or rebuilds it, never replays',
    why: 'A file the tool cannot read cannot key the task, so the tool must not act as if nothing changed. Leaving it out of the key replays the build from before the edit. Failing the run or rebuilding are both honest outcomes the user can see; a replay hides the edit.',
    from: ['unreadable-input'],
    workspace: one(reads(['src/**'], 'src/*'), { 'src/a.txt': 'a', 'src/secret.txt': 's' }),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'as' } } },
      { write: { 'packages/a/src/secret.txt': 's2' } },
      { chmod: { 'packages/a/src/secret.txt': 0o000 } },
      { run: 'build', expect: { exit: 0, orRefused: true, files: { [out('a')]: 'as2' } } },
      { chmod: { 'packages/a/src/secret.txt': 0o644 } },
    ],
  }),
]

export default cases
