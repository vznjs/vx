// What a task's inputs are when the tree is odd (colons, a leading BOM, a
// pipe, a link cycle, a file turned directory), what a gitignored path named
// outright keys, and inputs that move while the command runs: rewritten,
// added, edited behind a link, swapped by a sibling and put back.
import { defineCase, type Case, type Kind, type Step, type TaskSpec } from '../src/spec.ts'
import { CONCAT, out } from './shapes.ts'

const cached: TaskSpec = { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }

/** A cached build over `inputs` that copies `read` (sh words) into dist/out.txt. */
function reads(inputs: string[], read: string): TaskSpec {
  return { command: `mkdir -p dist && cat ${read} > dist/out.txt`, inputs, outputs: ['dist/**'] }
}

/** Project-relative paths under project `a`, as a step writes them. */
function inA(files: Record<string, string | null>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(files).map(([f, c]) => [`packages/a/${f}`, c]))
}

/** Project `a`, built once, then each change: `true` must run the build again (leaving `want`), `false` must not. */
function edits(c: {
  id: string
  kind: Kind
  title: string
  why?: string
  from: string[]
  task: TaskSpec
  files: Record<string, string>
  before?: Step[]
  changes: Array<[Record<string, string | null>, boolean, string?]>
}): Case {
  return defineCase({
    id: c.id,
    category: 'inputs',
    kind: c.kind,
    title: c.title,
    ...(c.why ? { why: c.why } : {}),
    from: c.from,
    workspace: { projects: { a: { tasks: { build: c.task }, files: c.files } } },
    steps: [
      ...(c.before ?? []),
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      ...c.changes.flatMap(([change, reruns, want]): Step[] => [
        { write: inA(change) },
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

/** A wait of at most ~3 s for `file`: a tool that runs one task at a time still finishes. */
const waitFor = (file: string): string =>
  `i=0; while [ ! -f ${file} ] && [ $i -lt 300 ]; do sleep 0.01; i=$((i+1)); done`

/** `then`, run once per case: the first run that reaches it leaves `.home/<mark>`. */
const once = (mark: string, then: string): string =>
  `if [ ! -e ../../.home/${mark} ]; then touch ../../.home/${mark}; ${then}; fi`

const ADDED_READ = 'mkdir -p dist; cat src/* src/*/* extra.txt > dist/out.txt 2>/dev/null; true'

/** The command adds `rel` (project-relative) once, before it reads its inputs; the next run, without it, must not replay it. */
function addedWhileRunning(id: string, rel: string, title: string, inputs = ['src/**']): Case {
  return defineCase({
    id: `inputs/${id}`,
    category: 'inputs',
    kind: 'correctness',
    title,
    why: 'The key was taken before the file existed and the output read it: stored under that key, the next run replays a file that is gone.',
    from: ['inputs-moved'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: `${once('added', `mkdir -p "$(dirname ${rel})" && printf 'NEW\\n' > ${rel}`)}; ${ADDED_READ}`,
              inputs,
              outputs: ['dist/**'],
            },
          },
          files: { 'src/in.txt': 'hi\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'hi\nNEW\n' } } },
      { write: inA({ [rel]: null }) },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'hi\n' } } },
    ],
  })
}

/** `lib#gate` (uncached) edits app's src/a.txt once armed; app#build, after it, must not file the edit under the key of the bytes before. */
function editedBeforeStart(tracked: boolean): Case {
  return defineCase({
    id: `inputs/${tracked ? 'tracked' : 'untracked'}-input-edited-by-dependency`,
    category: 'inputs',
    kind: 'correctness',
    needs: ['uncached-task'],
    title: `${tracked ? 'A committed' : 'An untracked'} input a dependency edits before the task starts is not replayed once put back`,
    why: 'A key taken before the dependency ran describes the bytes before its edit; the output was built from the edit.',
    from: ['inputs-moved'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            gate: {
              command: `if [ -e ../../.home/arm ]; then ${once('gated', "printf 'EDITED\\n' > ../app/src/a.txt")}; fi`,
              inputs: [],
              cache: false,
            },
          },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
              dependsOn: ['^gate'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: tracked ? { 'src/a.txt': 'seed\n' } : { 'src/b.txt': 'b\n' },
        },
      },
    },
    steps: [
      ...(tracked ? [] : [{ write: { 'packages/app/src/a.txt': 'seed\n' } }]),
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'seed\n' } } },
      { write: { 'packages/app/src/a.txt': 'X\n', '.home/arm': '' } },
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'EDITED\n' } } },
      { write: { 'packages/app/src/a.txt': 'X\n' } },
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'X\n' } } },
    ],
  })
}

/** The file behind a linked input changes once while the command runs; put back, the next run must not replay it. */
function editedBehindLink(kind: 'directory' | 'file'): Case {
  const [link, target, inputs, read] =
    kind === 'directory'
      ? ['lib', '../../shared', ['lib/**'], 'lib/a.txt']
      : ['src/l.txt', '../../../shared/a.txt', ['src/**'], 'src/l.txt']
  return defineCase({
    id: `inputs/edited-behind-${kind}-link-while-running`,
    category: 'inputs',
    kind: 'correctness',
    title: `A file behind a linked input ${kind}, edited while the task runs, is not replayed once put back`,
    why: 'The link’s target string did not change; the bytes behind it did, and the output was built from them.',
    from: ['inputs-moved'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: `${once('mid', "printf 'MID\\n' > ../../shared/a.txt")}; mkdir -p dist && cat ${read} > dist/out.txt`,
              inputs,
              outputs: ['dist/**'],
            },
          },
          files: { 'src/x.txt': 'x\n' },
        },
      },
      files: { 'shared/a.txt': 'A1\n' },
    },
    steps: [
      { link: { [`packages/a/${link}`]: target } },
      { commit: 'link' },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'MID\n' } } },
      { write: { 'shared/a.txt': 'A1\n' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'A1\n' } } },
    ],
  })
}

/** Turns the committed `<dir>` into a repository of its own, a gitlink in the workspace's index. */
const nestRepo = (dir: string): string =>
  [
    `git rm -rq --cached ${dir}`,
    `git -C ${dir} init -q`,
    `git -C ${dir} add -A`,
    `git -C ${dir} commit -qm nested`,
    `git add ${dir}`,
    `git commit -qm nest`,
  ].join(' && ')

/** In the nested repository `repo`, ignore `*.gen` and force-add `file` (repo-relative) all the same. */
const forceAddIgnored = (repo: string, file: string): string =>
  `cd ${repo} && printf '*.gen\\n' > .gitignore && git add .gitignore && git add -f ${file} && git commit -qm gen && cd - >/dev/null && git add ${repo} && git commit -qm bump`

/** A run started the way a git hook starts it, with `name` naming the workspace repository's. */
function underHook(
  id: string,
  name: 'GIT_INDEX_FILE' | 'GIT_DIR',
  layout: 'project' | 'vendored',
): Case {
  const value = name === 'GIT_DIR' ? '$ROOT/.git' : '$ROOT/.git/index'
  const env = { [name]: value }
  const project =
    layout === 'project'
      ? {
          dir: 'vendor/nested/b',
          tasks: { build: reads(['src/**'], 'src/keep.gen') },
          files: { 'src/keep.gen': 'one\n' },
        }
      : {
          tasks: { build: reads(['vendor/**'], 'vendor/lib/keep.gen') },
          files: { 'vendor/lib/x.txt': 'x\n', 'vendor/lib/keep.gen': 'one\n' },
        }
  const repo = layout === 'project' ? 'vendor/nested' : 'packages/a/vendor/lib'
  const file = layout === 'project' ? 'b/src/keep.gen' : 'keep.gen'
  const name_ = layout === 'project' ? 'b' : 'a'
  const dir = layout === 'project' ? 'vendor/nested/b' : 'packages/a'
  return defineCase({
    id: `inputs/${id}`,
    category: 'inputs',
    kind: 'correctness',
    title: `Under a git hook’s ${name}, a file a nested repository force-added despite its ignore rule is still an input`,
    why: 'A hook sets git’s location variables for the outer repository; the nested repository’s files are listed by its own index.',
    from: ['nested-repo-inputs'],
    workspace: { projects: { [name_]: project } },
    steps: [
      { sh: nestRepo(repo) },
      { sh: forceAddIgnored(repo, file) },
      { run: 'build', env, expect: { exit: 0, ran: [`${name_}#build`] } },
      {
        write: {
          [`${dir}/${layout === 'project' ? 'src/keep.gen' : 'vendor/lib/keep.gen'}`]: 'two\n',
        },
      },
      {
        run: 'build',
        env,
        expect: { exit: 0, ran: [`${name_}#build`], files: { [`${dir}/dist/out.txt`]: 'two\n' } },
      },
    ],
  })
}

/** `x` behind a byte-order mark (U+FEFF). */
const BOM = `${String.fromCharCode(0xfeff)}x`

/** A cached task keyed on its whole project that writes nothing: an edit it keys reruns it. */
const whole: TaskSpec = { command: 'true', inputs: ['**'], outputs: [] }

export default [
  // ── odd trees ───────────────────────────────────────────────────────────

  edits({
    id: 'inputs/negation-across-two-globs',
    kind: 'efficiency',
    title: 'A `!` input takes its files back from every positive glob that matched them',
    why: 'The negation narrows the whole set, not only the glob listed beside it.',
    from: ['inputs'],
    task: reads(['src/**/*.ts', 'src/**/*.js', '!src/**/*.spec.ts'], 'src/a.ts src/b.js'),
    files: { 'src/a.ts': 'a\n', 'src/b.js': 'b\n', 'src/c.spec.ts': 'c\n' },
    changes: [
      [{ 'src/c.spec.ts': 'c2\n' }, false],
      [{ 'src/b.js': 'b2\n' }, true, 'a\nb2\n'],
    ],
  }),

  edits({
    id: 'inputs/single-star-dotfile',
    kind: 'correctness',
    title: 'An input `src/*` keys the dotfile `src/.env`',
    why: 'Shell-style globbing skips dotfiles unless asked; a `.env` the task reads would then change no key.',
    from: ['inputs'],
    task: reads(['src/*'], 'src/.env'),
    files: { 'src/.env': 'one\n', 'src/index.ts': 'i\n' },
    changes: [[{ 'src/.env': 'two\n' }, true, 'two\n']],
  }),

  edits({
    id: 'inputs/empty-inputs-replays',
    kind: 'efficiency',
    title: 'A cached task declaring empty inputs replays after a project file changes',
    why: 'Empty inputs is a declaration that the task reads no file: it is keyed on its command alone.',
    from: ['inputs'],
    task: { command: 'mkdir -p dist && echo ok > dist/out.txt', inputs: [], outputs: ['dist/**'] },
    files: { 'src/a.txt': 'a\n' },
    changes: [[{ 'src/a.txt': 'edited\n' }, false, 'ok\n']],
  }),

  edits({
    id: 'inputs/colon-name-by-wildcard',
    kind: 'correctness',
    title: 'An input `src/*:*.txt` keys a file whose name holds a colon',
    why: 'A colon is a plain character in a POSIX name (vercel/turborepo#6847).',
    from: ['inputs'],
    task: reads(['src/*:*.txt'], '"src/a:b.txt"'),
    files: { 'src/a:b.txt': 'one\n', 'src/c.txt': 'c\n' },
    changes: [[{ 'src/a:b.txt': 'two\n' }, true, 'two\n']],
  }),

  edits({
    id: 'inputs/colon-name-literal',
    kind: 'correctness',
    title: 'An input naming `src/a:b.txt` outright keys it, untracked or committed',
    from: ['inputs'],
    task: reads(['src/a:b.txt', 'src/x:y.txt'], '"src/a:b.txt" "src/x:y.txt"'),
    files: { 'src/a:b.txt': 'a\n' },
    before: [{ write: inA({ 'src/x:y.txt': 'x\n' }) }],
    changes: [
      [{ 'src/a:b.txt': 'a2\n' }, true, 'a2\nx\n'],
      [{ 'src/x:y.txt': 'x2\n' }, true, 'a2\nx2\n'],
    ],
  }),

  edits({
    id: 'inputs/colon-name-negated',
    kind: 'efficiency',
    title: 'A `!src/a:b.txt` input takes the file with the colon back',
    from: ['inputs'],
    task: reads(['src/**', '!src/a:b.txt'], 'src/c.txt'),
    files: { 'src/a:b.txt': 'one\n', 'src/c.txt': 'c\n' },
    changes: [[{ 'src/a:b.txt': 'two\n' }, false]],
  }),

  edits({
    id: 'inputs/backslash-name',
    kind: 'correctness',
    title: 'An input named with a backslash and a double quote is keyed',
    why: 'Listed without `-z`, git C-quotes such a name and the quoted path names no file.',
    from: ['inputs'],
    task: reads(['src/**'], `src/a.txt 'src/back\\slash.txt' 'src/quo"te.txt'`),
    files: { 'src/a.txt': 'a\n', 'src/back\\slash.txt': 'b\n', 'src/quo"te.txt': 'q\n' },
    changes: [
      [{ 'src/back\\slash.txt': 'b2\n' }, true, 'a\nb2\nq\n'],
      [{ 'src/quo"te.txt': 'q2\n' }, true, 'a\nb2\nq2\n'],
    ],
  }),

  defineCase({
    id: 'inputs/leading-bom-name',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input whose name opens with a byte-order mark is keyed, untracked and committed',
    why: 'A decoder that strips a leading U+FEFF loses the name: the file drops out of the key and every edit replays.',
    from: ['inputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: `mkdir -p dist && cat "$(printf '\\357\\273\\277x')" > dist/out.txt`,
              inputs: ['*'],
              outputs: ['dist/**'],
            },
          },
        },
      },
    },
    steps: [
      { write: inA({ [BOM]: 'one\n' }) },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'one\n' } } },
      { write: inA({ [BOM]: 'two\n' }) },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'two\n' } } },
      { commit: 'bom' },
      { write: inA({ [BOM]: 'three\n' }) },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'three\n' } } },
    ],
  }),

  edits({
    id: 'inputs/new-untracked-directory',
    kind: 'correctness',
    title: 'A file in a new untracked directory is an input; an ignored install inside it is not',
    from: ['inputs'],
    task: reads(['src/**'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n' },
    changes: [
      [{ 'src/gen/deep/made.txt': 'm\n' }, true],
      [{ 'src/gen/node_modules/dep/index.js': 'x\n' }, false],
    ],
  }),

  edits({
    id: 'inputs/git-info-exclude',
    kind: 'efficiency',
    title: 'A file the repository’s `.git/info/exclude` ignores changes nothing',
    why: 'An exclude is an ignore rule like `.gitignore`, kept out of the tree.',
    from: ['inputs'],
    task: reads(['src/**'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n' },
    before: [
      { sh: "printf 'packages/a/src/local.tmp\\n' >> .git/info/exclude" },
      { write: inA({ 'src/local.tmp': 'one\n' }) },
    ],
    changes: [[{ 'src/local.tmp': 'two\n' }, false]],
  }),

  defineCase({
    id: 'inputs/dangling-link-retarget',
    category: 'inputs',
    kind: 'correctness',
    title: 'Pointing a dangling input link at another missing target runs the task again',
    why: 'A link is an input in its own right: its target string is what it holds, with or without a file behind it.',
    from: ['inputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && readlink src/link.txt > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { link: { 'packages/a/src/link.txt': 'missing-one' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'missing-one\n' } } },
      { link: { 'packages/a/src/link.txt': 'missing-two' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'missing-two\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/link-cycle-no-hang',
    category: 'inputs',
    kind: 'correctness',
    title: 'A directory link back into its own input tree neither hangs nor fails the run',
    from: ['inputs'],
    workspace: one(),
    steps: [
      { link: { 'packages/a/src/loop': '.' } },
      { run: 'build', expect: { exit: 0, within: 120, files: { [out('a')]: 'a\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/named-pipe-no-hang',
    category: 'inputs',
    kind: 'correctness',
    title: 'Named pipes under the input and output globs neither hang the run nor stop a replay',
    why: 'A pipe holds no bytes to hash or store; opening one to read blocks until something writes.',
    from: ['inputs'],
    workspace: {
      projects: {
        a: { tasks: { build: reads(['**/*'], 'src/a.txt') }, files: { 'src/a.txt': 'a1\n' } },
      },
    },
    steps: [
      {
        sh: 'mkdir -p packages/a/dist && mkfifo packages/a/src/pipe packages/a/pipe packages/a/dist/pipe',
      },
      { run: 'build', expect: { exit: 0, within: 120, files: { [out('a')]: 'a1\n' } } },
      { write: { [out('a')]: null } },
      {
        run: 'build',
        expect: { exit: 0, within: 120, notRan: ['a#build'], files: { [out('a')]: 'a1\n' } },
      },
      { write: inA({ 'src/a.txt': 'a2\n' }) },
      {
        run: 'build',
        expect: { exit: 0, within: 120, ran: ['a#build'], files: { [out('a')]: 'a2\n' } },
      },
    ],
  }),

  edits({
    id: 'inputs/file-replaced-by-directory',
    kind: 'correctness',
    title: 'A committed input replaced by a directory keys what the directory holds',
    from: ['inputs'],
    task: reads(['src/**'], 'src/a.txt $(test -d src/x && echo src/x/in || echo src/x)'),
    files: { 'src/a.txt': 'a\n', 'src/x': 'x\n' },
    changes: [
      [{ 'src/x': null, 'src/x/in': 'i\n' }, true, 'a\ni\n'],
      [{ 'src/x/in': 'i2\n' }, true, 'a\ni2\n'],
    ],
  }),

  defineCase({
    id: 'inputs/nested-project-interloping-sibling',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'A project nested in `foo` keeps its files out of `foo`’s inputs beside a sibling `foo-bar`',
    why: '`foo-bar` sorts between `foo` and `foo/`: a sorted scan that stops at it never finds `foo/inner`.',
    from: ['nested-dirs'],
    workspace: {
      projects: {
        foo: {
          dir: 'packages/foo',
          tasks: { build: whole },
          files: { 'a.txt': 'f\n' },
        },
        'foo-bar': {
          dir: 'packages/foo-bar',
          tasks: { build: whole },
          files: { 'a.txt': 'fb\n' },
        },
        inner: {
          dir: 'packages/foo/inner',
          tasks: { build: whole },
          files: { 'a.txt': 'i\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/foo/inner/a.txt': 'i2\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['inner#build'], notRan: ['foo#build', 'foo-bar#build'] },
      },
      { write: { 'packages/foo-bar/a.txt': 'fb2\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['foo-bar#build'], notRan: ['foo#build', 'inner#build'] },
      },
    ],
  }),

  defineCase({
    id: 'inputs/doubly-nested-project',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A project nested two deep keeps its files out of both projects around it',
    from: ['nested-dirs'],
    workspace: {
      projects: {
        foo: {
          dir: 'packages/foo',
          tasks: { build: whole },
          files: { 'a.txt': 'f\n' },
        },
        mid: {
          dir: 'packages/foo/mid',
          tasks: { build: whole },
          files: { 'a.txt': 'm\n' },
        },
        leaf: {
          dir: 'packages/foo/mid/leaf',
          tasks: { build: whole },
          files: { 'a.txt': 'l\n' },
        },
        'foo-x': {
          dir: 'packages/foo-x',
          tasks: { build: whole },
          files: { 'a.txt': 'x\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/foo/mid/leaf/a.txt': 'l2\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['leaf#build'], notRan: ['foo#build', 'mid#build', 'foo-x#build'] },
      },
    ],
  }),

  edits({
    id: 'inputs/index-without-stats',
    kind: 'correctness',
    title: 'A same-size edit is seen after `git read-tree` leaves the index without file stats',
    why: 'An index entry with no stat says nothing about the file on disk (turborepo’s stale-index test).',
    from: ['git-racy-index'],
    task: cached,
    files: { 'src/a.txt': 'a\n' },
    before: [{ sh: 'git read-tree HEAD' }],
    changes: [[{ 'src/a.txt': 'b\n' }, true, 'b\n']],
  }),

  defineCase({
    id: 'inputs/edit-after-read-tree',
    category: 'inputs',
    kind: 'correctness',
    title: 'An edit made before `git read-tree` wiped the index stats still runs the task again',
    from: ['git-racy-index'],
    workspace: one(),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: inA({ 'src/a.txt': 'b\n' }) },
      { sh: 'git read-tree HEAD' },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'b\n' } } },
    ],
  }),

  // ── gitignored paths named outright ─────────────────────────────────────

  defineCase({
    id: 'inputs/gitignored-named-file-lifecycle',
    category: 'inputs',
    kind: 'correctness',
    title: 'A gitignored input named outright keys its creation, each edit, and its removal',
    why: 'Naming an ignored file (`.env.local`) asks for it; skipping it replays a result built from other values.',
    from: ['ignored-inputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'mkdir -p dist && cat src/a.txt > dist/out.txt && (cat .env.local 2>/dev/null || true) >> dist/out.txt',
              inputs: ['src/**', '.env.local'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n', '.gitignore': '.env.local\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } },
      { write: inA({ '.env.local': 'API=a\n' }) },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\nAPI=a\n' } } },
      { write: inA({ '.env.local': 'API=b\n' }) },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\nAPI=b\n' } } },
      { write: inA({ '.env.local': 'API=a\n' }) },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\nAPI=a\n' } } },
      { write: inA({ '.env.local': null }) },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } },
    ],
  }),

  edits({
    id: 'inputs/gitignored-directory-glob',
    kind: 'correctness',
    title: 'An input `gen/**` keys every file under the gitignored directory `gen`',
    why: 'A glob whose fixed prefix is an ignored directory asks for that directory.',
    from: ['ignored-inputs'],
    task: reads(['src/**', 'gen/**'], 'gen/deep/a.json'),
    files: { 'src/a.txt': 'a\n', 'gen/deep/a.json': '1\n', '.gitignore': 'gen/\n' },
    changes: [[{ 'gen/deep/a.json': '2\n' }, true, '2\n']],
  }),

  edits({
    id: 'inputs/gitignored-directory-narrow-glob',
    kind: 'correctness',
    title: 'An input `gen/*.js` keys a matching file in the gitignored directory `gen`',
    from: ['ignored-inputs'],
    task: reads(['src/**', 'gen/*.js'], 'gen/b.js'),
    files: {
      'src/a.txt': 'a\n',
      'gen/b.js': '1\n',
      'gen/deep/a.json': '1\n',
      '.gitignore': 'gen/\n',
    },
    changes: [[{ 'gen/b.js': '2\n' }, true, '2\n']],
  }),

  edits({
    id: 'inputs/gitignored-directory-narrow-glob-rest',
    kind: 'efficiency',
    title: 'An input `gen/*.js` over a gitignored `gen` does not key a JSON file beside the match',
    from: ['ignored-inputs'],
    task: reads(['src/**', 'gen/*.js'], 'gen/b.js'),
    files: {
      'src/a.txt': 'a\n',
      'gen/b.js': '1\n',
      'gen/deep/a.json': '1\n',
      '.gitignore': 'gen/\n',
    },
    changes: [[{ 'gen/deep/a.json': '2\n' }, false]],
  }),

  defineCase({
    id: 'inputs/named-path-under-node-modules',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input naming a generated client under `node_modules` keys it',
    why: 'A generator (`prisma generate`) writes there; a build over the client replays a stale output when its edit is skipped.',
    from: ['ignored-inputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: reads(
              ['src/**', 'node_modules/.prisma/client/**'],
              'node_modules/.prisma/client/index.d.ts',
            ),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { write: inA({ 'node_modules/.prisma/client/index.d.ts': 'type A = 1\n' }) },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: inA({ 'node_modules/.prisma/client/index.d.ts': 'type A = 2\n' }) },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'type A = 2\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/node-modules-under-named-ignored-directory',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input `gen/**` over a gitignored `gen` keys a `node_modules` inside it',
    why: 'The entry asks for the ignored directory whole; nothing under it is skipped by name.',
    from: ['ignored-inputs'],
    workspace: {
      projects: {
        a: {
          tasks: { build: reads(['src/**', 'gen/**'], 'gen/node_modules/x/i.js') },
          files: { 'src/a.txt': 'a\n', '.gitignore': 'gen/\n' },
        },
      },
    },
    steps: [
      { write: inA({ 'gen/node_modules/x/i.js': '1\n' }) },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: inA({ 'gen/node_modules/x/i.js': '2\n' }) },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: '2\n' } } },
    ],
  }),

  edits({
    id: 'inputs/brace-of-gitignored-files',
    kind: 'correctness',
    title: 'A brace input `{gen/a.txt,gen/b.txt}` keys each gitignored file it names',
    why: 'A brace of whole paths names each one outright, as its expansions would.',
    from: ['ignored-inputs'],
    task: reads(['{gen/a.txt,gen/b.txt}'], 'gen/a.txt'),
    files: { 'gen/a.txt': '1\n', 'gen/b.txt': 'b\n', '.gitignore': 'gen/\n' },
    changes: [[{ 'gen/a.txt': '2\n' }, true, '2\n']],
  }),

  edits({
    id: 'inputs/brace-of-gitignored-directories',
    kind: 'correctness',
    title: 'A brace input `{gen,out}/**` keys the files of both gitignored directories',
    from: ['ignored-inputs'],
    task: reads(['{gen,out}/**'], 'gen/a.txt out/x.txt'),
    files: { 'gen/a.txt': '1\n', 'out/x.txt': 'x\n', '.gitignore': 'gen/\nout/\n' },
    changes: [
      [{ 'gen/a.txt': '2\n' }, true, '2\nx\n'],
      [{ 'out/x.txt': 'y\n' }, true, '2\ny\n'],
    ],
  }),

  edits({
    id: 'inputs/ignored-directory-kept-by-gitkeep',
    kind: 'correctness',
    title: 'An input `gen/**` keys an ignored file beside the `.gitkeep` that keeps `gen` in git',
    why: 'git lists the `.gitkeep`, so `gen` reads as tracked; the ignored files beside it are still what the task reads.',
    from: ['ignored-inputs'],
    task: reads(['gen/**'], 'gen/client.ts'),
    files: { 'gen/.gitkeep': '', 'gen/client.ts': 'v1\n', '.gitignore': 'gen/*\n!gen/.gitkeep\n' },
    changes: [[{ 'gen/client.ts': 'v2\n' }, true, 'v2\n']],
  }),

  edits({
    id: 'inputs/ignored-directory-with-force-added-file',
    kind: 'correctness',
    title:
      'An input `out/**` over an ignored `out` keys an untracked file beside a force-added one',
    from: ['ignored-inputs'],
    task: reads(['out/**'], 'out/a.txt out/b.txt'),
    files: { 'out/a.txt': 'a\n', 'out/b.txt': 'b1\n', '.gitignore': 'out/\n' },
    before: [{ sh: 'git add -f packages/a/out/a.txt && git commit -qm force-add' }],
    changes: [[{ 'out/b.txt': 'b2\n' }, true, 'a\nb2\n']],
  }),

  // ── inputs that move while the command runs ─────────────────────────────

  defineCase({
    id: 'inputs/self-rewrite-not-replayed',
    category: 'inputs',
    kind: 'correctness',
    title: 'A task that rewrites its own input runs again once the old bytes are put back',
    why: 'The result was made from the bytes before the rewrite but describes the bytes after: replayed for the old bytes, it leaves them unformatted (vercel/turborepo#10111).',
    from: ['inputs-moved'],
    workspace: {
      projects: {
        a: {
          tasks: {
            format: {
              command: "sed -i.bak 's/unformatted/formatted/' a.txt && rm a.txt.bak",
              inputs: ['a.txt'],
              outputs: [],
            },
          },
          files: { 'a.txt': 'unformatted\n' },
        },
      },
    },
    steps: [
      { run: 'format', expect: { exit: 0, files: { 'packages/a/a.txt': 'formatted\n' } } },
      { sh: 'git checkout -- packages/a/a.txt' },
      { run: 'format', expect: { exit: 0, files: { 'packages/a/a.txt': 'formatted\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/edited-and-reverted-while-running',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input edited and put back while the task runs does not replay the edited result',
    why: 'The bytes match the key again, but the output was built from the edit: filed under the key, it replays over the source.',
    from: ['inputs-moved'],
    workspace: one({
      command: `${once('edited', "printf 'EDITED\\n' > src/a.txt")}; mkdir -p dist && cat src/a.txt > dist/out.txt; ${once('reverted', "printf 'a\\n' > src/a.txt")}`,
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'EDITED\n' } } },
      {
        run: 'build',
        expect: { exit: 0, files: { [out('a')]: 'a\n', 'packages/a/src/a.txt': 'a\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/sibling-swaps-input-mid-run',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input another task swaps out and puts back while a task reads it is not replayed',
    why: 'The reader saw the swapped bytes; the key, before or after, describes the original ones.',
    from: ['inputs-moved'],
    workspace: {
      projects: {
        a: {
          tasks: {
            read: {
              command: `touch ../../.home/started; ${waitFor('../../.home/swapped')}; cat a.txt > out.txt; touch ../../.home/read`,
              inputs: ['a.txt'],
              outputs: ['out.txt'],
            },
            meddle: {
              command: once(
                'meddled',
                `${waitFor('../../.home/started')}; cp a.txt ../../.home/keep; printf 'bad\\n' > a.txt; touch ../../.home/swapped; ${waitFor('../../.home/read')}; cat ../../.home/keep > a.txt`,
              ),
              inputs: [],
              cache: false,
            },
            all: { command: 'true', dependsOn: ['read', 'meddle'], inputs: [], outputs: [] },
          },
          files: { 'a.txt': 'good\n', '.gitignore': 'out.txt\n' },
        },
      },
    },
    steps: [
      { run: 'all', expect: { exit: 0, files: { 'packages/a/a.txt': 'good\n' } } },
      { run: 'read', expect: { exit: 0, files: { 'packages/a/out.txt': 'good\n' } } },
    ],
  }),

  editedBeforeStart(true),
  editedBeforeStart(false),
  editedBehindLink('directory'),
  editedBehindLink('file'),

  addedWhileRunning(
    'added-while-running',
    'src/new.txt',
    'A file the command adds under an input glob is not replayed once it is gone',
  ),
  addedWhileRunning(
    'added-in-new-directory-while-running',
    'src/sub/new.txt',
    'A file added in a directory created while the task runs is not replayed once it is gone',
  ),
  addedWhileRunning(
    'named-input-added-while-running',
    'extra.txt',
    'A named input absent when the task started, then created by it, is not replayed once gone',
    ['src/**', 'extra.txt'],
  ),

  defineCase({
    id: 'inputs/directory-link-added-while-running',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A directory link added under an input glob while the task runs is not replayed once gone',
    why: 'The link’s name matches no `*.txt`, but the files behind it do, and the command read them.',
    from: ['inputs-moved'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: `${once('linked', 'ln -s ../../../shared src/v')}; ${ADDED_READ}`,
              inputs: ['src/**/*.txt'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/in.txt': 'hi\n' },
        },
      },
      files: { 'shared/x.txt': 'NEW\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'hi\nNEW\n' } } },
      { write: { 'packages/a/src/v': null } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'hi\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/ignored-file-written-by-task-replays',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'A task writing an ignored file, or one outside its inputs, still replays on the next run',
    from: ['inputs-moved'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: `touch src/x.log other.txt; ${ADDED_READ}`,
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/in.txt': 'hi\n', '.gitignore': '*.log\nother.txt\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'hi\n' } } },
    ],
  }),

  // ── nested repositories under a git hook ────────────────────────────────

  underHook('hook-index-project-in-nested-repo', 'GIT_INDEX_FILE', 'project'),
  underHook('hook-git-dir-project-in-nested-repo', 'GIT_DIR', 'project'),
  underHook('hook-index-nested-repo-in-project', 'GIT_INDEX_FILE', 'vendored'),
  underHook('hook-git-dir-nested-repo-in-project', 'GIT_DIR', 'vendored'),

  // ── globs that are no plain path ────────────────────────────────────────

  defineCase({
    id: 'inputs/one-alternative-brace-never-stale',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input `src/{b}.txt` never replays a stale result for either file it could name',
    why: 'A brace of one alternative reads as `src/b.txt` to one glob library and as the literal name to another: whichever it keys, the other changes unseen. Refusing it is right.',
    from: ['one-alternative-brace'],
    workspace: {
      projects: {
        a: {
          tasks: { build: reads(['src/{b}.txt'], 'src/b.txt "src/{b}.txt"') },
          files: { 'src/b.txt': 'b\n', 'src/{b}.txt': 'braces\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { orRefused: true } },
      { write: inA({ 'src/b.txt': 'b2\n' }) },
      { run: 'build', expect: { orRefused: true, filesNot: { [out('a')]: 'b\nbraces\n' } } },
      { write: inA({ 'src/{b}.txt': 'braces2\n' }) },
      { run: 'build', expect: { orRefused: true, filesNot: { [out('a')]: 'b2\nbraces\n' } } },
    ],
  }),

  defineCase({
    id: 'env/declared-order-irrelevant',
    category: 'env',
    kind: 'efficiency',
    needs: ['env-inputs'],
    title: 'Listing the same declared variables in another order still replays',
    why: 'The variables are a set: their order in the config says nothing about the task.',
    from: ['inputs'],
    workspace: one({
      command: 'mkdir -p dist && echo "$A $B $C" > dist/out.txt',
      env: ['C', 'A', 'B'],
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', env: { A: '1', B: '2', C: '3' }, expect: { exit: 0 } },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            a: {
              ...ws.projects['a']!,
              tasks: { build: { ...ws.projects['a']!.tasks!['build']!, env: ['A', 'B', 'C'] } },
            },
          },
        }),
      },
      {
        run: 'build',
        env: { A: '1', B: '2', C: '3' },
        expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: '1 2 3\n' } },
      },
    ],
  }),

  // ── outputs ─────────────────────────────────────────────────────────────

  defineCase({
    id: 'outputs/wide-glob-spares-nested-project',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output `**/*.js` never deletes or captures a nested project’s built files',
    why: 'Project boundaries are hard: the nested project’s build output is its own.',
    from: ['inputs'],
    workspace: {
      projects: {
        outer: {
          dir: 'packages/outer',
          tasks: {
            build: {
              command: 'mkdir -p dist && cp src/a.txt dist/outer.js',
              inputs: ['src/**'],
              outputs: ['**/*.js'],
            },
          },
          files: { 'src/a.txt': 'outer\n' },
        },
        inner: {
          dir: 'packages/outer/inner',
          tasks: {
            build: {
              command: 'mkdir -p dist && cp src/a.txt dist/inner.js',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'inner\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/outer/src/a.txt': 'outer2\n' } },
      {
        run: 'build',
        projects: ['outer'],
        expect: {
          exit: 0,
          files: {
            'packages/outer/dist/outer.js': 'outer2\n',
            'packages/outer/inner/dist/inner.js': 'inner\n',
          },
        },
      },
      { write: { 'packages/outer/dist': null, 'packages/outer/inner/dist/inner.js': 'mine\n' } },
      {
        run: 'build',
        projects: ['outer'],
        expect: {
          exit: 0,
          files: {
            'packages/outer/dist/outer.js': 'outer2\n',
            'packages/outer/inner/dist/inner.js': 'mine\n',
          },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/repeated-output-glob',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output listed twice, and one inside another, restores each file once and intact',
    why: 'A file stored twice in one entry broke the restore (vercel/turborepo#14004).',
    from: ['inputs'],
    workspace: one({
      command: 'mkdir -p dist/sub && cp src/a.txt dist/a.txt && cp src/a.txt dist/sub/b.txt',
      inputs: ['src/**'],
      outputs: ['dist/**', 'dist/**', 'dist/sub/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: { 'packages/a/dist/a.txt': 'a\n', 'packages/a/dist/sub/b.txt': 'a\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/dependency-tree-keeps-route-added-by-dependant',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A replayed `app/**` leaves the route `app/[id]` a later task adds, and drops a stray beside it',
    why: 'Read as a class, `app/\\[id\\]` sets aside `app/i` instead: the stray survives and the route is judged stray.',
    from: ['task-glob-brackets'],
    workspace: {
      sharedOutputs: true,
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p app && cat src/in.txt > app/x.js',
              inputs: ['src/**'],
              outputs: ['app/**'],
            },
            route: {
              command: 'mkdir -p "app/[id]" && echo r > "app/[id]/page.js"',
              dependsOn: ['build'],
              inputs: ['src/**'],
              outputs: ['app/\\[id\\]/page.js'],
            },
          },
          files: { 'src/in.txt': 'v1\n' },
        },
      },
    },
    steps: [
      { run: 'route', expect: { exit: 0 } },
      { write: inA({ 'app/[id]/page.js': null, 'app/i/page.js': 'STRAY\n' }) },
      {
        run: 'route',
        expect: {
          exit: 0,
          files: {
            'packages/a/app/x.js': 'v1\n',
            'packages/a/app/[id]/page.js': 'r\n',
            'packages/a/app/i/page.js': null,
          },
        },
      },
    ],
  }),
]

/** One project `a` with the cached concat build over `src/a.txt`. */
function one(task: TaskSpec = cached): Case['workspace'] {
  return { projects: { a: { tasks: { build: task }, files: { 'src/a.txt': 'a\n' } } } }
}
