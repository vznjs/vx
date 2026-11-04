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
  why: string
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
    why: c.why,
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
function addedWhileRunning(
  id: string,
  rel: string,
  title: string,
  why: string,
  inputs = ['src/**'],
): Case {
  return defineCase({
    id: `inputs/${id}`,
    category: 'inputs',
    kind: 'correctness',
    title,
    why,
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
function editedBeforeStart(tracked: boolean, why: string): Case {
  return defineCase({
    id: `inputs/${tracked ? 'tracked' : 'untracked'}-input-edited-by-dependency`,
    category: 'inputs',
    kind: 'correctness',
    needs: ['uncached-task'],
    title: `${tracked ? 'A committed' : 'An untracked'} input a dependency edits before the task starts is not replayed once put back`,
    why,
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
function editedBehindLink(kind: 'directory' | 'file', why: string): Case {
  const [link, target, inputs, read] =
    kind === 'directory'
      ? ['lib', '../../shared', ['lib/**'], 'lib/a.txt']
      : ['src/l.txt', '../../../shared/a.txt', ['src/**'], 'src/l.txt']
  return defineCase({
    id: `inputs/edited-behind-${kind}-link-while-running`,
    category: 'inputs',
    kind: 'correctness',
    title: `A file behind a linked input ${kind}, edited while the task runs, is not replayed once put back`,
    why,
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
  why: string,
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
    why,
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
    why: 'A negated input removes its files from the task’s whole input set, not only from the glob listed next to it. If the exclusion applied to one positive glob only, a spec file matched by another glob would still key the build. Every edit to a spec file would then rebuild output that never reads it.',
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
    why: 'An input glob lists the files a task reads, so `src/*` covers every file in `src`, dotfiles included. Shell-style globbing hides dotfiles unless asked, and a `.env` the task reads would then change no key. Editing it would replay output built from the old values under a green run.',
    from: ['inputs'],
    task: reads(['src/*'], 'src/.env'),
    files: { 'src/.env': 'one\n', 'src/index.ts': 'i\n' },
    changes: [[{ 'src/.env': 'two\n' }, true, 'two\n']],
  }),

  edits({
    id: 'inputs/empty-inputs-replays',
    kind: 'efficiency',
    title: 'A cached task declaring empty inputs replays after a project file changes',
    why: 'Empty inputs is an explicit statement that the task reads no file, so it is keyed on its command and config alone. It differs from listing no inputs at all, which says nothing and is not cached. Rerunning it on every project edit would ignore what the user declared and waste the run the cache was meant to save.',
    from: ['inputs'],
    task: { command: 'mkdir -p dist && echo ok > dist/out.txt', inputs: [], outputs: ['dist/**'] },
    files: { 'src/a.txt': 'a\n' },
    changes: [[{ 'src/a.txt': 'edited\n' }, false, 'ok\n']],
  }),

  edits({
    id: 'inputs/colon-name-by-wildcard',
    kind: 'correctness',
    title: 'An input `src/*:*.txt` keys a file whose name holds a colon',
    why: 'A colon is a plain character in a POSIX file name, so a wildcard must match it like any other. A tool that reads it as a drive or scheme separator drops the file from the key. Edits to that file then replay the old output, and the build ships content that no longer matches the source.',
    from: ['inputs'],
    task: reads(['src/*:*.txt'], '"src/a:b.txt"'),
    files: { 'src/a:b.txt': 'one\n', 'src/c.txt': 'c\n' },
    changes: [[{ 'src/a:b.txt': 'two\n' }, true, 'two\n']],
  }),

  edits({
    id: 'inputs/colon-name-literal',
    kind: 'correctness',
    title: 'An input naming `src/a:b.txt` outright keys it, untracked or committed',
    why: 'An input that names a file outright asks for exactly that file, whatever characters its name holds and whether git tracks it yet. A colon must not be parsed as a separator. Skipping the file lets edits to it replay a stale result, both before and after it is committed.',
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
    why: 'A negated input names a file the user said does not affect the task, and that holds for a name with a colon too. If the negation fails to parse, the file stays in the key. Every edit to it then reruns work that cannot change the output, on every machine and in CI.',
    from: ['inputs'],
    task: reads(['src/**', '!src/a:b.txt'], 'src/c.txt'),
    files: { 'src/a:b.txt': 'one\n', 'src/c.txt': 'c\n' },
    changes: [[{ 'src/a:b.txt': 'two\n' }, false]],
  }),

  edits({
    id: 'inputs/backslash-name',
    kind: 'correctness',
    title: 'An input named with a backslash and a double quote is keyed',
    why: 'A file name can hold a backslash or a double quote, and it must be keyed by its real bytes. Listed without `-z`, git C-quotes such a name, and a tool that reads the quoted form looks up a path that does not exist. The file drops out of the key, so edits to it replay a stale result.',
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
    why: 'A file name is the exact bytes on disk, including a leading U+FEFF byte-order mark. A decoder that strips the mark loses the name, so the file drops out of the key. Every edit to it then replays the old output, whether the file is untracked or committed.',
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
    why: 'A new file under an input glob is part of what the task reads, even in a directory git has never seen. Missing it replays output built without that file. An ignored `node_modules` install inside the same directory is local state, not source, so it must not key the task and rerun it after every install.',
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
    why: '`.git/info/exclude` is an ignore rule like `.gitignore`, only kept out of the committed tree. Ignored files are local state: scratch files, editor temp files, local logs. Keying a task on them reruns it whenever such a file changes, and the same commit gets different keys on different machines.',
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
    why: 'A symbolic link is an input in its own right: its target string is what it holds, with or without a file behind it. A command can read that string, as `readlink` does here. A tool that skips dangling links keeps the same key after the target changes and replays output naming the old target.',
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
    why: 'A directory link that points back into its own tree is legal, and it turns up in vendored and generated layouts. A walker that follows links without tracking where it has been loops forever or fails on an endless path. A hung CI job or a crash over a harmless link blocks every build in the repository.',
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
    why: 'A named pipe holds no bytes to hash or store, and opening one to read blocks until something writes. A tool that reads every matched path as a file hangs the run on the first pipe. Pipes under input or output globs must be passed over, so the build still runs, replays, and reruns on a real edit.',
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
    why: 'When a committed file becomes a directory of the same name, the task now reads the files inside it. A tool that trusts git’s record of the old file, or skips the path as a type mismatch, keeps the old key. Edits inside the new directory then replay output built from a file that is gone.',
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
    why: 'A nested project’s files belong to it alone, so an edit there must not rerun the project around it. Here `foo-bar` sorts between `foo` and `foo/`, and a sorted scan that stops at it never sees `foo/inner` as nested. An edit in `inner` then reruns `foo` too, work nothing asked for.',
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
    why: 'Each project owns its own directory, and a project nested inside another is cut out of the outer one’s inputs. That must hold at any depth, not only one level down. If a leaf’s edit leaked into both projects above it, one change would rebuild three projects, and the waste grows with each level.',
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
    why: 'An index entry with no stat data says nothing about the file on disk. `git read-tree` leaves the index that way, and a tool that reads it as a sign of a clean file keys the committed blob, not the edited bytes. A same-size edit then replays the old output under a green run.',
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
    why: 'An edit made before `git read-tree` is still an edit: the bytes on disk differ from the last build. Reading the tree drops the index’s stat data, so a tool comparing stats against the index cannot tell. It must look at the file itself, or the next run replays output built from the old bytes.',
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
    why: 'Naming an ignored file such as `.env.local` in the inputs asks for it, even though broad globs skip ignored files. Its creation, each edit and its removal all change what the task reads. Skipping any of them replays a result built from other values, such as a bundle pointed at the wrong API.',
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
    why: 'A glob whose fixed prefix is an ignored directory asks for that directory by name. Generated sources often live in an ignored `gen/`, and the build reads them. Skipping its files replays output built from the old generated code after every regeneration.',
    from: ['ignored-inputs'],
    task: reads(['src/**', 'gen/**'], 'gen/deep/a.json'),
    files: { 'src/a.txt': 'a\n', 'gen/deep/a.json': '1\n', '.gitignore': 'gen/\n' },
    changes: [[{ 'gen/deep/a.json': '2\n' }, true, '2\n']],
  }),

  edits({
    id: 'inputs/gitignored-directory-narrow-glob',
    kind: 'correctness',
    title: 'An input `gen/*.js` keys a matching file in the gitignored directory `gen`',
    why: 'An input `gen/*.js` names files in the ignored directory `gen`, so the matching files are inputs. The ignore rule decides what git tracks, not what the task reads. Leaving the match out replays a stale result after the generator rewrites it. The glob still limits the key to the files it matches.',
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
    why: 'Naming an ignored directory with a narrow glob asks only for what that glob matches. A JSON file beside the `.js` match is outside it and stays local state. Keying the whole ignored directory would rerun the task on every unrelated generated file. The narrow glob is how the user says which generated files matter.',
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
    why: 'A generator such as `prisma generate` writes its client under `node_modules`, and a build that compiles against it reads it. Naming that path asks for it even though `node_modules` is ignored. Skipping it replays output checked against the old client, and the mismatch shows up only at runtime.',
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
    why: 'An entry naming an ignored directory asks for the whole directory; nothing under it is dropped by name. A `node_modules` inside `gen` is part of what was asked for. Skipping it by its usual meaning replays a stale result after that code changes. Explicit config beats the usual skip rules.',
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
    why: 'A brace of whole paths names each one outright, as its expansions written out would. Each named file is an input even though git ignores it. Treating the brace as a broad glob that skips ignored files replays output built from the old file. The brace is only shorthand for listing the paths one by one.',
    from: ['ignored-inputs'],
    task: reads(['{gen/a.txt,gen/b.txt}'], 'gen/a.txt'),
    files: { 'gen/a.txt': '1\n', 'gen/b.txt': 'b\n', '.gitignore': 'gen/\n' },
    changes: [[{ 'gen/a.txt': '2\n' }, true, '2\n']],
  }),

  edits({
    id: 'inputs/brace-of-gitignored-directories',
    kind: 'correctness',
    title: 'A brace input `{gen,out}/**` keys the files of both gitignored directories',
    why: '`{gen,out}/**` means `gen/**` and `out/**`, and each alternative names an ignored directory outright. Both trees are what the task reads. A tool that treats the brace differently from the two separate globs keys only one of them, and edits to the other replay stale output.',
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
    why: 'git lists the `.gitkeep`, so `gen` looks tracked, but the files beside it are ignored and still what the task reads. A tool that takes git’s listing of a tracked directory as complete misses them. Each regeneration of `gen/client.ts` then replays output built from the old client.',
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
    why: 'One force-added file makes git list part of the ignored `out`, but the untracked files beside it are still under the glob. A tool that trusts git’s listing for the directory sees only the committed file. Edits to the rest then replay a stale result. The glob, not git’s listing, decides what is an input.',
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
    why: 'A task that rewrites its own input, like a formatter, made its result from the bytes before the rewrite but leaves the bytes after on disk. Stored under the old bytes’ key, a later checkout of the unformatted file replays a no-op and leaves it unformatted. The task must run again so the file really is formatted.',
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
    why: 'A key describes the bytes the task read, and here the command read an edit that was undone before it finished. The bytes on disk match the key again, but the output came from the edit. Filed under that key, it replays the edited result over a source that no longer holds it.',
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
    why: 'Another task swapped the file while the reader ran, so the reader saw the swapped bytes. The key, taken before or after, describes the original bytes. Stored under it, the bad result replays on every later run with the good file, until someone clears the cache by hand.',
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

  editedBeforeStart(
    true,
    'The key must describe the bytes the command read, not the bytes before an earlier task ran. Here a dependency edits a committed input just before the task starts. A key taken before the dependency ran files the edited output under the old bytes, and putting those bytes back replays the edit.',
  ),
  editedBeforeStart(
    false,
    'An untracked input is read the same way as a committed one, so the same rule holds. A dependency edits it just before the task starts, and the output is built from the edit. Filed under the key of the bytes before, it replays the edited result once the original bytes come back.',
  ),
  editedBehindLink(
    'directory',
    'A linked directory’s target string did not change, but a file behind it did while the command ran. The output was built from the new bytes. Stored under the key of the old ones, it replays the edited result once they are put back, and the link gives no sign anything moved.',
  ),
  editedBehindLink(
    'file',
    'A linked input file holds a target string, and the bytes behind it are what the command reads. Here those bytes changed while the task ran. Stored under the key of the bytes before, the output replays the edited content after the original is restored.',
  ),

  addedWhileRunning(
    'added-while-running',
    'src/new.txt',
    'A file the command adds under an input glob is not replayed once it is gone',
    'A key must describe what the task read. Here the command created `src/new.txt` after the key was taken and read it into the output. Stored under that key, the next run replays content from a file that no longer exists. A clean build of the same sources would not produce it.',
  ),
  addedWhileRunning(
    'added-in-new-directory-while-running',
    'src/sub/new.txt',
    'A file added in a directory created while the task runs is not replayed once it is gone',
    'The command created a new directory with a file in it after the key was taken, then read that file. The key describes the tree without the directory. Replayed under it, the output carries content from a file that is gone, and a clean build would not reproduce it.',
  ),
  addedWhileRunning(
    'named-input-added-while-running',
    'extra.txt',
    'A named input absent when the task started, then created by it, is not replayed once gone',
    'A named input that is missing when the key is taken is keyed as absent. The command then created it and read it into the output. Stored under the key for its absence, the output replays content from that file the next time it is missing, which a clean build would not produce.',
    ['src/**', 'extra.txt'],
  ),

  defineCase({
    id: 'inputs/directory-link-added-while-running',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A directory link added under an input glob while the task runs is not replayed once gone',
    why: 'The command created a link whose name matches no `*.txt`, but the files behind it do, and the command read them. The key was taken without them. Stored under it, the output replays content from files that are no longer reachable once the link is gone.',
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
    why: 'A task that writes a log or another ignored file, or a file outside its inputs, has not changed its own inputs. Those writes are side effects and local state, not source. Treating them as input changes would keep the task from ever replaying, so it would rerun on every build.',
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

  underHook(
    'hook-index-project-in-nested-repo',
    'GIT_INDEX_FILE',
    'project',
    'Git hooks run with `GIT_INDEX_FILE` set to the outer repository’s index. A tool that passes it on reads the wrong index when it lists a project inside a nested repository. The force-added file then drops out of the key, and a build started from a hook, such as pre-commit, replays a stale result.',
  ),
  underHook(
    'hook-git-dir-project-in-nested-repo',
    'GIT_DIR',
    'project',
    'Git hooks can run with `GIT_DIR` pointing at the outer repository. Passed through to the nested repository’s listing, it makes git describe the wrong repository. A file the nested repository tracks despite its ignore rule then goes unkeyed, and a pre-commit build replays stale output.',
  ),
  underHook(
    'hook-index-nested-repo-in-project',
    'GIT_INDEX_FILE',
    'vendored',
    'A project can vendor a repository of its own under an input glob. Under a hook’s `GIT_INDEX_FILE`, a tool that lists it with the outer index loses the files that repository force-added. Edits to them replay a stale result only when run from a hook, which makes the bug hard to see.',
  ),
  underHook(
    'hook-git-dir-nested-repo-in-project',
    'GIT_DIR',
    'vendored',
    'The variables a hook sets describe the outer repository, not one vendored inside a project. With `GIT_DIR` passed on, listing the vendored repository reads the outer one instead. A file it force-added despite its ignore rule falls out of the key, and edits to it replay old output.',
  ),

  // ── globs that are no plain path ────────────────────────────────────────

  defineCase({
    id: 'inputs/one-alternative-brace-never-stale',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input `src/{b}.txt` never replays a stale result for either file it could name',
    why: 'A brace with one alternative reads as `src/b.txt` to one glob library and as the literal name `src/{b}.txt` to another. Whichever file a tool keys, the other can change unseen and replay a stale result. Refusing the spelling, or keying both files, is right; replaying old bytes is not.',
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
    why: 'Declared environment variables are a set: their order in the config says nothing about what the task reads. Reordering the list is a cosmetic edit with the same values. Treating it as a change misses the cache for every task the edit touched, on every machine.',
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
    why: 'Project boundaries are hard: a nested project’s build output belongs to that project. An outer output glob like `**/*.js` must not capture it into the outer task’s cache entry or clear it before a run. Otherwise building the outer project deletes or overwrites files the inner project made, local edits included.',
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
    why: 'Output globs that list a file twice, or overlap, still describe one set of files. Storing a file twice in one cache entry has broken restores before, leaving files missing or corrupt. Each file must be stored once and come back intact, however the globs overlap.',
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
    why: 'In an output glob, `app/\\[id\\]` is the literal directory `[id]`, as file-system routes are often named. Read as a character class, it sets aside `app/i` instead. A replay then keeps the stray file and deletes the real route a later task added, and the app ships without that page.',
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
