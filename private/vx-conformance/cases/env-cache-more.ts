// What keys a task and what a replay leaves, ported from the hashing,
// env, args and output-shape tests: git's view of a file (line endings,
// ignore rules, the index), names a shell or a glob would read, env values
// and args, and outputs whose shape (file, directory, link) changes.
import {
  defineCase,
  type Case,
  type Expect,
  type Feature,
  type Kind,
  type Step,
  type TaskSpec,
  type WorkspaceSpec,
} from '../src/spec.ts'
import { CONCAT, one, out } from './shapes.ts'

const A = 'packages/a'

/** A cached build over `inputs` whose output is constant: a rerun shows only in the marks. */
const stamp = (inputs: string[], extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command: 'mkdir -p dist && echo built > dist/out.txt',
  inputs,
  outputs: ['dist/**'],
  ...extra,
})

/** `build` in project `a` ran its command (`true`), was replayed (`false`), or either (`null`). */
const build = (ran: boolean | null, extra: Expect = {}): Step => ({
  run: 'build',
  expect: {
    exit: 0,
    ...(ran === null ? {} : ran ? { ran: ['a#build'] } : { notRan: ['a#build'] }),
    ...extra,
  },
})

/** Project-relative paths under project `a`, as a step writes them. */
const inA = (files: Record<string, string | null>): Step => ({
  write: Object.fromEntries(Object.entries(files).map(([f, c]) => [`${A}/${f}`, c])),
})

/** The harness's ignore list, plus `extra` lines: a case that writes the root .gitignore keeps it. */
const ignore = (...extra: string[]) =>
  [
    'node_modules',
    '.home',
    '.ran',
    '.left',
    '.turbo',
    '.nx',
    '.vx/cache',
    'dist',
    ...extra,
    '',
  ].join('\n')

/** One project `a` with `task` as its build and `files`; `root` files beside it. */
function proj(task: TaskSpec, files: Record<string, string>, root?: Record<string, string>) {
  return {
    projects: { a: { tasks: { build: task }, files } },
    ...(root ? { files: root } : {}),
  } satisfies WorkspaceSpec
}

function keyCase(c: {
  id: string
  kind: Kind
  title: string
  why?: string
  from: string[]
  needs?: Feature[]
  workspace: WorkspaceSpec
  steps: Step[]
}): Case {
  return defineCase({
    category: c.id.slice(0, c.id.indexOf('/')) as Case['category'],
    ...c,
  })
}

// ---------------------------------------------------------------- line endings

const crlf = (attr: string, slug: string) =>
  keyCase({
    id: `inputs/crlf-${slug}`,
    kind: 'correctness',
    title: `With \`${attr}\` in .gitattributes, a same-size edit to a CRLF file runs the task again`,
    why: 'Git may store the file with LF; the task reads the CRLF bytes on disk, so those bytes are the input.',
    from: ['hash-scenarios'],
    workspace: proj(
      stamp(['a.txt']),
      { 'a.txt': 'one\r\ntwo\r\n' },
      { '.gitattributes': `${attr}\n` },
    ),
    steps: [
      build(true),
      { sh: `touch -d '2030-01-01 00:00:00' ${A}/a.txt` },
      inA({ 'a.txt': 'onE\r\ntwo\r\n' }),
      build(true),
    ],
  })

const textAuto = (slug: string, what: string, body: string) =>
  keyCase({
    id: `inputs/text-auto-crlf-rewrite-${slug}`,
    kind: 'correctness',
    title: `Under \`* text=auto\`, rewriting a file holding ${what} from LF to CRLF runs the task again`,
    why: 'Whether git calls the file text or binary, the task reads different bytes.',
    from: ['hash-scenarios', 'parity-turbo-hashing'],
    workspace: proj(
      stamp(['data.bin']),
      { 'data.bin': body },
      { '.gitattributes': '* text=auto\n' },
    ),
    steps: [
      // Back-dated and refreshed: git records the file's stat as clean, with no racy smudge.
      {
        sh: `touch -d '2001-01-01 00:00:00' ${A}/data.bin && (git update-index --really-refresh >/dev/null || true)`,
      },
      build(true),
      inA({ 'data.bin': body.replaceAll('\n', '\r\n') }),
      build(true),
    ],
  })

// ---------------------------------------------------------------- output shapes

const BUILD_SH = `set -e
rm -rf dist
mkdir -p dist
case "$(cat shape.txt)" in
  dir) mkdir dist/out && echo inner > dist/out/inner.txt ;;
  file) echo flat > dist/out ;;
  link) ln -s ../target.txt dist/out ;;
esac
`
/** The same build without its own `rm -rf dist`: the runner's clean before a run is all that clears the other shape. */
const MISS_SH = `set -e
mkdir -p dist
case "$(cat shape.txt)" in
  dir) mkdir dist/out && echo inner > dist/out/inner.txt ;;
  file) echo flat > dist/out ;;
esac
`
type Shape = 'dir' | 'file' | 'link'
const shaped = (outputs: string[], script = BUILD_SH, shape: Shape = 'dir') =>
  proj(
    { command: 'sh build.sh', inputs: ['shape.txt', 'build.sh'], outputs },
    { 'shape.txt': shape, 'build.sh': script, 'target.txt': 'target\n' },
  )
/** What `dist/out` holds in each shape. */
const SHAPE: Record<Shape, Record<string, string | null>> = {
  dir: { [`${A}/dist/out/inner.txt`]: 'inner\n' },
  file: { [`${A}/dist/out`]: 'flat\n' },
  link: { [`${A}/dist/out`]: 'target\n' },
}
/** Build `shape`, running (`true`) or either running or replaying (`null`), and check the tree it leaves. */
const toShape = (shape: Shape, ran: true | null): Step[] => [
  inA({ 'shape.txt': shape }),
  build(ran, { files: SHAPE[shape] }),
  ...(shape === 'link' ? [{ check: { links: { [`${A}/dist/out`]: '../target.txt' } } }] : []),
  ...(shape === 'dir' ? [{ check: { dirs: [`${A}/dist/out`] } }] : []),
]

/** `dist` a link to `real-out`, both in the project; the build writes through it. */
const LINKED_DIST = 'mkdir -p real-out && ln -sfn real-out dist && cat src/in.txt > dist/out.js'

const linkedDistLiteral = (slug: string, outputs: string[]) =>
  keyCase({
    id: `outputs/linked-dir-literal-${slug}`,
    kind: 'correctness',
    title: `An output list ${JSON.stringify(outputs)} naming a directory link brings back the file behind the link once it is deleted`,
    from: ['output-shape'],
    workspace: proj(
      { command: LINKED_DIST, inputs: ['src/**'], outputs },
      { 'src/in.txt': 'v1\n' },
    ),
    steps: [
      build(true),
      inA({ 'real-out/out.js': null }),
      build(null, { files: { [`${A}/dist/out.js`]: 'v1\n' } }),
    ],
  })

// ---------------------------------------------------------------- env and args

/** Writes each forwarded arg as `<arg>`: a cached task that reads its args. */
const ARGS: TaskSpec = {
  command: `mkdir -p dist && printf '<%s>' "$@" > dist/out.txt`,
  takesArgs: true,
  inputs: ['src/**'],
  outputs: ['dist/**'],
}
const argsRun = (args: string[] | undefined, ran: boolean | null, want?: string): Step => ({
  run: 'build',
  projects: ['a'],
  ...(args ? { args } : {}),
  expect: {
    exit: 0,
    ...(ran === null ? {} : ran ? { ran: ['a#build'] } : { notRan: ['a#build'] }),
    ...(want === undefined ? {} : { files: { [out('a')]: want } }),
  },
})

const TRICKY = 'a=b==\nline two\r\n\tü漢😀 $HOME \\n\n'

/** A project whose package ships bins named `sh` and `own-tool`; `a` depends on it. */
function shellShadow(tasks: Record<string, TaskSpec>): WorkspaceSpec {
  return {
    projects: {
      fakesh: {
        files: {
          'package.json': JSON.stringify({
            name: 'fakesh',
            version: '0.0.0',
            private: true,
            bin: { sh: 'sh.sh', 'own-tool': 'tool.sh' },
          }),
          'sh.sh': '#!/bin/sh\necho hijacked\n',
          'tool.sh': '#!/bin/sh\necho tool ran\n',
        },
      },
      a: { deps: ['fakesh'], tasks, files: { 'src/a.txt': 'a\n' } },
    },
  }
}

/** Wait (bounded) for a file, then go on. */
const until = (file: string) =>
  `i=0; until [ -e ${file} ] || [ $i -ge 400 ]; do sleep 0.05; i=$((i+1)); done; [ -e ${file} ]`

// ---------------------------------------------------------------- names

const NAMES = {
  'src/foo:bar.txt': 'f\n',
  'src/foo::bar.txt': 'ff\n',
  'src/a,b.ts': 'ab\n',
  'src/ab.ts': 'plain\n',
  'src/@scope/pkg/x.js': 'x\n',
  'src/a+b/y.txt': 'y\n',
  'app/(marketing)/page.js': 'p\n',
  'other.js': 'o\n',
}

const SHELL_NAMES = ['src/$id.tsx', 'src/sp ace "q" é.ts', 'src/t\tab.ts']

/** One ignore rule, asked both ways: an edit it ignores replays, and an edit it lets through reruns. */
function ignoreCases(c: {
  slug: string
  what: string
  from: string[]
  workspace: WorkspaceSpec
  setup?: Step[]
  ignored: Step[]
  keyed: Step[]
}): Case[] {
  return [
    keyCase({
      id: `inputs/${c.slug}-ignored`,
      kind: 'efficiency',
      title: `${c.what}: an edit it ignores replays the task`,
      from: c.from,
      workspace: c.workspace,
      steps: [...(c.setup ?? []), build(true), ...c.ignored],
    }),
    keyCase({
      id: `inputs/${c.slug}-keyed`,
      kind: 'correctness',
      title: `${c.what}: an edit it leaves an input runs the task again`,
      from: c.from,
      workspace: c.workspace,
      steps: [...(c.setup ?? []), build(true), ...c.keyed],
    }),
  ]
}

export default [
  // cache-hygiene
  keyCase({
    id: 'failure/sigterm-mid-task-saves-nothing',
    kind: 'correctness',
    title:
      'A task stopped by SIGTERM mid-run fails the run and is run again next time, never replayed',
    why: 'Its outputs were never finished; an entry saved for the stopped run would replay a partial tree as a success.',
    from: ['cache-hygiene'],
    workspace: proj(
      {
        command: 'touch started && { [ -f go ] || sleep 30; } && echo done > out.txt',
        inputs: ['src/**'],
        outputs: ['out.txt'],
      },
      { 'src/a.txt': 'a\n' },
    ),
    steps: [
      {
        run: 'build',
        stop: { signal: 'SIGTERM', when: `${A}/started` },
        expect: { exit: 'fail', files: { [`${A}/out.txt`]: null }, within: 20 },
      },
      inA({ go: '' }),
      build(true, { files: { [`${A}/out.txt`]: 'done\n' } }),
    ],
  }),

  // line endings and git attributes
  crlf('* text=auto', 'text-auto'),
  crlf('* text', 'text'),
  crlf('*.txt text eol=crlf', 'eol-crlf'),
  keyCase({
    id: 'inputs/project-gitattributes-crlf',
    kind: 'correctness',
    title:
      'Under a project’s own `*.md text` rule, a same-size edit to a CRLF file runs the task again',
    from: ['hash-scenarios'],
    workspace: proj(stamp(['a.md']), { '.gitattributes': '*.md text\n', 'a.md': 'one\r\ntwo\r\n' }),
    steps: [build(true), inA({ 'a.md': 'onE\r\ntwo\r\n' }), build(true)],
  }),
  textAuto('lone-cr', 'a lone CR', 'a\nb\rc\n'),
  textAuto('late-nul', 'a NUL past its first 8000 bytes', `${'a\n'.repeat(4500)}\0\n`),
  textAuto('control-byte', 'a control byte', 'a\u0001\nb\n'),
  textAuto('plain', 'plain text', 'a\nb\n'),
  keyCase({
    id: 'inputs/text-auto-binary-crlf-to-lf',
    kind: 'correctness',
    title: 'Under `* text=auto`, dropping the CR from a binary file’s CRLF runs the task again',
    from: ['parity-turbo-hashing'],
    workspace: proj(
      stamp(['src/**']),
      { 'src/blob.bin': '\u0000\u0001\r\n\u0002' },
      { '.gitattributes': '* text=auto\n' },
    ),
    steps: [build(true), inA({ 'src/blob.bin': '\u0000\u0001\n\u0002' }), build(true)],
  }),

  // names
  keyCase({
    id: 'inputs/non-ascii-tracked-name',
    kind: 'correctness',
    title: 'An edit to a committed input with a non-ASCII name runs the task again',
    why: 'Git quotes such a path unless asked not to; a quoted path names no file, so the edit goes unseen.',
    from: ['hash-scenarios'],
    workspace: proj(stamp(['src/**']), { 'src/테스트.ts': 'one\n' }),
    steps: [
      {
        sh: `touch -d '2001-01-01 00:00:00' '${A}/src/테스트.ts' && (git update-index --really-refresh >/dev/null || true)`,
      },
      build(true),
      inA({ 'src/테스트.ts': 'two\n' }),
      build(true),
    ],
  }),
  keyCase({
    id: 'inputs/colon-in-glob-is-a-name',
    kind: 'correctness',
    title:
      'An input `src/*:bar.txt` keys `foo:bar.txt` and `foo::bar.txt`: a `:` is part of a name',
    from: ['hash-scenarios'],
    workspace: proj(stamp(['src/*:bar.txt']), NAMES),
    steps: [
      build(true),
      inA({ 'src/foo::bar.txt': 'ff2\n' }),
      build(true),
      inA({ 'src/foo:bar.txt': 'f2\n' }),
      build(true),
    ],
  }),
  keyCase({
    id: 'inputs/comma-in-literal-is-a-name',
    kind: 'correctness',
    title: 'An input `src/a,b.ts` keys the file named so: a `,` outside braces is part of a name',
    from: ['hash-scenarios'],
    workspace: proj(stamp(['src/a,b.ts']), NAMES),
    steps: [build(true), inA({ 'src/a,b.ts': 'ab2\n' }), build(true)],
  }),
  keyCase({
    id: 'inputs/scope-plus-group-names',
    kind: 'correctness',
    title: 'Inputs through `@scope`, `a+b` and `(marketing)` directories key the files under them',
    from: ['hash-scenarios'],
    workspace: proj(stamp(['src/@scope/pkg/*.js', 'src/a+b/**', 'app/(marketing)/**']), NAMES),
    steps: [
      build(true),
      inA({ 'src/@scope/pkg/x.js': 'x2\n' }),
      build(true),
      inA({ 'src/a+b/y.txt': 'y2\n' }),
      build(true),
      inA({ 'app/(marketing)/page.js': 'p2\n' }),
      build(true),
    ],
  }),
  keyCase({
    id: 'inputs/shell-special-names',
    kind: 'correctness',
    title:
      'Inputs named with a `$`, quotes, a space or a tab, committed or not, each rerun the task when edited',
    from: ['hash-scenarios'],
    workspace: proj(stamp(['src/**']), Object.fromEntries(SHELL_NAMES.map((n) => [n, 'v1']))),
    steps: [
      inA({ 'src/untracked $u.ts': 'v1' }),
      build(true),
      ...[...SHELL_NAMES, 'src/untracked $u.ts'].flatMap((n) => [inA({ [n]: 'v2' }), build(true)]),
    ],
  }),
  keyCase({
    id: 'inputs/newline-in-names',
    kind: 'correctness',
    title: 'A file or directory whose name holds a newline is an input, untracked or committed',
    from: ['parity-turbo-hashing'],
    workspace: proj(stamp(['src/**']), { 'src/a.txt': 'a\n' }),
    steps: [
      build(true),
      inA({ 'src/a\nb.txt': '1\n', 'src/new\nline/f.txt': '1\n' }),
      build(true),
      inA({ 'src/new\nline/f.txt': '2\n' }),
      build(true),
      { commit: 'newline names' },
      build(null),
      inA({ 'src/a\nb.txt': 'edited\n' }),
      build(true),
      inA({ 'src/new\nline/f.txt': 'edited\n' }),
      build(true),
    ],
  }),
  keyCase({
    id: 'inputs/unclosed-bracket-literal',
    kind: 'correctness',
    title: 'An input `src/[invalid` keys the file named so, or is refused, never left unkeyed',
    why: 'An unclosed `[` opens no class: read as the name it keys that file; a runner may also refuse the glob outright.',
    from: ['hash-scenarios'],
    workspace: proj(stamp(['src/[invalid']), { 'src/[invalid': 'v1\n', 'src/i': 'v1\n' }),
    steps: [
      build(true, { orRefused: true }),
      inA({ 'src/[invalid': 'v2\n' }),
      build(true, { orRefused: true }),
    ],
  }),
  keyCase({
    id: 'inputs/only-gitignore-holds-rules',
    kind: 'correctness',
    title: 'Only a file named .gitignore holds ignore rules: `foo.gitignore` and `.ignore` do not',
    from: ['hash-scenarios'],
    workspace: proj(
      stamp(['src/**']),
      { 'src/a.txt': 'a\n', 'src/foo.gitignore': '*\n', 'src/.ignore': 'b.txt\n' },
      { '.ignore': '*\n' },
    ),
    steps: [inA({ 'src/b.txt': 'b\n' }), build(true), inA({ 'src/b.txt': 'b2\n' }), build(true)],
  }),

  // ignore rules
  ...ignoreCases({
    slug: 'gitignore-edit',
    what: 'An uncommitted .gitignore edit that stops ignoring a file, then ignores it again',
    from: ['hash-scenarios'],
    workspace: proj(
      stamp(['src/**']),
      { 'src/a.txt': 'a\n' },
      { '.gitignore': ignore('packages/a/src/gen.txt') },
    ),
    ignored: [
      inA({ 'src/gen.txt': 'g\n' }),
      build(false),
      { write: { '.gitignore': ignore() } },
      build(null),
      { write: { '.gitignore': ignore('packages/a/src/gen.txt') } },
      build(null),
      inA({ 'src/gen.txt': 'g3\n' }),
      build(false),
    ],
    keyed: [
      inA({ 'src/gen.txt': 'g\n' }),
      { write: { '.gitignore': ignore() } },
      build(true),
      inA({ 'src/gen.txt': 'g2\n' }),
      build(true),
    ],
  }),
  ...ignoreCases({
    slug: 'self-ignoring-whitelist',
    what: 'A `*` .gitignore that whitelists one file',
    from: ['hash-scenarios'],
    workspace: proj(stamp(['src/**']), {
      'src/a.txt': 'a\n',
      'src/cache/.gitignore': '*\n!keep.txt\n!.gitignore\n',
    }),
    setup: [inA({ 'src/cache/keep.txt': 'k\n', 'src/cache/junk.txt': 'j\n' })],
    ignored: [inA({ 'src/cache/junk.txt': 'j2\n' }), build(false)],
    keyed: [inA({ 'src/cache/keep.txt': 'k2\n' }), build(true)],
  }),
  ...ignoreCases({
    slug: 'project-negation-over-root-rule',
    what: 'A project’s `!important.log` under the root’s `*.log`',
    from: ['hash-scenarios'],
    workspace: proj(
      stamp(['src/**']),
      { '.gitignore': '!important.log\n', 'src/a.txt': 'a\n' },
      { '.gitignore': ignore('*.log') },
    ),
    setup: [inA({ 'src/important.log': 'v1\n', 'src/other.log': 'v1\n' })],
    ignored: [inA({ 'src/other.log': 'v2\n' }), build(false)],
    keyed: [inA({ 'src/important.log': 'v2\n' }), build(true)],
  }),
  ...ignoreCases({
    slug: 'root-negation',
    what: 'A root .gitignore with `*.log` and `!keep.log`',
    from: ['parity-turbo-hashing'],
    workspace: proj(
      stamp(['src/**']),
      { 'src/a.txt': 'a\n' },
      { '.gitignore': ignore('*.log', '!keep.log') },
    ),
    ignored: [inA({ 'src/debug.log': 'noise\n' }), build(false)],
    keyed: [inA({ 'src/keep.log': 'kept\n' }), build(true)],
  }),
  ...ignoreCases({
    slug: 'root-rule-deep-in-project',
    what: 'A root rule two directories into a project, under an input `**`',
    from: ['hash-scenarios'],
    workspace: proj(
      stamp(['**']),
      { 'src/a.txt': 'a\n' },
      { '.gitignore': ignore('packages/a/src/deep/*.tmp') },
    ),
    setup: [inA({ 'src/deep/x.tmp': '1\n' })],
    ignored: [inA({ 'src/deep/x.tmp': '2\n' }), build(false)],
    keyed: [inA({ 'src/deep/y.txt': '1\n' }), build(true)],
  }),
  ...ignoreCases({
    slug: 'new-dir-own-gitignore',
    what: 'A new directory’s own .gitignore',
    from: ['parity-turbo-hashing'],
    workspace: proj(stamp(['src/**']), { 'src/a.txt': 'a\n' }),
    setup: [inA({ 'src/fresh/.gitignore': 'secret.txt\n' })],
    ignored: [inA({ 'src/fresh/secret.txt': 's\n' }), build(false)],
    keyed: [inA({ 'src/fresh/open.txt': 'o\n' }), build(true)],
  }),
  ...ignoreCases({
    slug: 'nested-gitignore-scope',
    what: 'A nested .gitignore, which ignores only below it',
    from: ['parity-turbo-hashing'],
    workspace: proj(stamp(['src/**']), { 'src/a.txt': 'a\n', 'src/a/.gitignore': 'x.txt\n' }),
    ignored: [
      inA({ 'src/a/x.txt': 'x\n' }),
      { sh: `mkdir -p ${A}/src/empty/deeper` },
      build(false),
    ],
    keyed: [inA({ 'src/b/x.txt': 'x\n' }), build(true)],
  }),
  keyCase({
    id: 'inputs/fifo-under-glob',
    kind: 'correctness',
    title: 'A FIFO under an input glob does not hang the run',
    why: 'Opening a FIFO to hash it blocks until a writer comes, which never happens.',
    from: ['hash-scenarios'],
    workspace: proj(stamp(['src/**']), { 'src/a.txt': 'a\n' }),
    steps: [
      build(true),
      { sh: `mkfifo ${A}/src/fifo` },
      { run: 'build', expect: { exit: 0, within: 60 } },
    ],
  }),

  // the index
  keyCase({
    id: 'cache/staging-keeps-entry',
    kind: 'efficiency',
    title: 'Staging and then committing an edit keeps the entry the unstaged run saved',
    from: ['parity-turbo-hashing'],
    workspace: one({ command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }),
    steps: [
      inA({ 'src/a.txt': 'a3\n' }),
      build(true),
      { sh: 'git add -A' },
      build(false),
      { commit: 'a3' },
      build(false, { files: { [out('a')]: 'a3\n' } }),
    ],
  }),
  keyCase({
    id: 'cache/same-size-edit-after-commit',
    kind: 'correctness',
    title: 'A same-size edit right after a commit runs the task again',
    why: 'Git cannot tell the edit from its stat in the second of the commit (racy git): the bytes must be read.',
    from: ['parity-turbo-hashing'],
    workspace: one({ command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }),
    steps: [
      inA({ 'src/a.txt': 'xy\n' }),
      { commit: 'xy' },
      build(true),
      inA({ 'src/a.txt': 'yx\n' }),
      build(true, { files: { [out('a')]: 'yx\n' } }),
    ],
  }),
  keyCase({
    id: 'cache/staged-deletion-keeps-entry',
    kind: 'efficiency',
    title: 'Staging and committing a deleted input replays what the run after the deletion stored',
    from: ['parity-turbo-hashing'],
    workspace: one(
      {
        command: 'mkdir -p dist && ls src > dist/out.txt',
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
      { 'src/a.txt': 'a\n', 'src/gone.txt': 'g\n' },
    ),
    steps: [
      build(true),
      inA({ 'src/gone.txt': null }),
      build(null, { files: { [out('a')]: 'a.txt\n' } }),
      { sh: `git rm -q --cached ${A}/src/gone.txt` },
      build(false),
      { commit: 'rm' },
      build(false),
    ],
  }),
  keyCase({
    id: 'inputs/intent-to-add',
    kind: 'correctness',
    title: 'A file added with `git add -N` keys its bytes: an edit to it runs the task again',
    why: 'Git’s index holds the empty blob for it, which must never stand in for the bytes on disk.',
    from: ['parity-turbo-hashing'],
    workspace: one({ command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }),
    steps: [
      build(true),
      inA({ 'src/ita.txt': 'one\n' }),
      { sh: `git add -N ${A}/src/ita.txt` },
      build(true, { files: { [out('a')]: 'a\none\n' } }),
      inA({ 'src/ita.txt': 'two\n' }),
      build(true, { files: { [out('a')]: 'a\ntwo\n' } }),
      { sh: `git rm -q --cached ${A}/src/ita.txt` },
      inA({ 'src/ita.txt': null }),
      build(null, { files: { [out('a')]: 'a\n' } }),
    ],
  }),
  keyCase({
    id: 'cache/no-commit-yet-then-first-commit',
    kind: 'efficiency',
    title:
      'In a repository with no commit yet the run caches, and the first commit keeps that entry',
    from: ['parity-turbo-hashing-env'],
    workspace: one({ command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }),
    steps: [
      { sh: 'rm -rf .git && git init -q -b main' },
      build(true),
      { commit: 'first' },
      build(false),
    ],
  }),

  // selection
  keyCase({
    id: 'cache/selection-shares-entry',
    kind: 'efficiency',
    title:
      'A task stored by a run of every project replays when the run names its project, or excludes another',
    why: 'Which projects a run selects is not an input of a task: the same task on the same tree is one entry.',
    from: ['hash-scenarios', 'parity-turbo-hashing'],
    needs: ['filter'],
    workspace: {
      projects: {
        lib: { tasks: { build: stamp(['src/**']) }, files: { 'src/a': 'lib\n' } },
        other: { tasks: { build: stamp(['src/**']) }, files: { 'src/a': 'other\n' } },
      },
    },
    steps: [
      { write: { 'packages/lib/src/new.txt': 'n\n' } },
      { run: 'build', expect: { exit: 0, ran: ['lib#build', 'other#build'] } },
      { run: 'build', projects: ['lib'], expect: { exit: 0, notRan: ['lib#build'] } },
      {
        run: 'build',
        select: [{ name: 'other', exclude: true }],
        expect: { exit: 0, notRan: ['lib#build', 'other#build'] },
      },
    ],
  }),
  keyCase({
    id: 'cache/affected-shares-entry',
    kind: 'efficiency',
    title: 'A task an affected run selects replays what a run of every project stored',
    from: ['hash-scenarios'],
    needs: ['affected'],
    workspace: {
      projects: {
        lib: { tasks: { build: stamp(['src/**']) }, files: { 'src/a': 'lib\n' } },
        other: { tasks: { build: stamp(['src/**']) }, files: { 'src/a': 'other\n' } },
      },
    },
    steps: [
      { write: { 'packages/lib/src/new.txt': 'n\n' } },
      { run: 'build', expect: { exit: 0, ran: ['lib#build', 'other#build'] } },
      {
        affected: 'build',
        base: 'HEAD',
        expect: { exit: 0, notRan: ['lib#build', 'other#build'] },
      },
    ],
  }),
  keyCase({
    id: 'inputs/root-input-alone-keys',
    kind: 'correctness',
    title: 'A task keyed on a root file and no project file runs again when the root file changes',
    from: ['hash-scenarios'],
    workspace: proj(
      { ...stamp([]), rootInputs: ['g.txt'] },
      { 'src/a.txt': 'a\n' },
      { 'g.txt': '1\n' },
    ),
    steps: [build(true), { write: { 'g.txt': '2\n' } }, build(true)],
  }),

  // env and args
  keyCase({
    id: 'env/value-moved-between-names',
    kind: 'correctness',
    title:
      'Moving a value from one declared variable to another, or swapping two, runs the task again',
    why: 'A key that folds values without their names keys `A=1` as `B=1`, and replays one environment’s build for the other.',
    from: ['task-hash-derive'],
    needs: ['env-inputs'],
    workspace: one({
      command: 'mkdir -p dist && echo "${A-unset} ${B-unset}" > dist/out.txt',
      inputs: ['src/**'],
      env: ['A', 'B'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', env: { A: '1' }, expect: { exit: 0, files: { [out('a')]: '1 unset\n' } } },
      {
        run: 'build',
        env: { B: '1' },
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'unset 1\n' } },
      },
      { run: 'build', env: { A: '1', B: '2' }, expect: { exit: 0, ran: ['a#build'] } },
      {
        run: 'build',
        env: { A: '2', B: '1' },
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: '2 1\n' } },
      },
    ],
  }),
  keyCase({
    id: 'env/value-reaches-task-byte-exact',
    kind: 'correctness',
    title:
      'A declared value holding `=`, newlines, a tab and non-ASCII reaches the task byte for byte',
    from: ['env-properties'],
    needs: ['env-inputs'],
    workspace: one({
      command: `mkdir -p dist && printf '%s|' "$MODE" > dist/out.txt`,
      inputs: ['src/**'],
      env: ['MODE'],
      outputs: ['dist/**'],
    }),
    steps: [
      {
        run: 'build',
        env: { MODE: `=${TRICKY}` },
        expect: { exit: 0, files: { [out('a')]: `=${TRICKY}|` } },
      },
    ],
  }),
  keyCase({
    id: 'env/path-change-replays',
    kind: 'efficiency',
    title: 'A PATH with one more directory, not declared, replays the task',
    why: 'PATH differs on every machine; keyed, no two machines would share an entry.',
    from: ['parity-turbo-hashing-env'],
    workspace: one({ command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }),
    steps: [
      build(true),
      {
        run: 'build',
        env: { PATH: `/opt/conformance-nowhere:${process.env['PATH'] ?? '/usr/bin:/bin'}` },
        expect: { exit: 0, notRan: ['a#build'] },
      },
    ],
  }),
  keyCase({
    id: 'env/temp-dirs-reach-task',
    kind: 'correctness',
    title: 'TMPDIR, TMP and TEMP reach a task as set, and what a task exports reaches its children',
    why: 'A runner that drops or rewrites them sends the task’s temp files where the host never pointed it.',
    from: ['env'],
    needs: ['uncached-task'],
    workspace: one({
      command: `printf '%s|%s|%s' "$TMPDIR" "$TMP" "$TEMP" > seen.txt && export INNER=set-by-task && sh -c 'printf %s "$INNER"' > inner.txt`,
      cache: false,
    }),
    steps: [
      {
        run: 'build',
        env: { TMPDIR: '/tmp/.', TMP: '/tmp/conf-tmp', TEMP: '/tmp/conf-temp' },
        expect: {
          exit: 0,
          files: {
            [`${A}/seen.txt`]: '/tmp/.|/tmp/conf-tmp|/tmp/conf-temp',
            [`${A}/inner.txt`]: 'set-by-task',
          },
        },
      },
    ],
  }),
  keyCase({
    id: 'cache/args-change-reruns',
    kind: 'correctness',
    title:
      'Other forwarded args run a cached task again, and the first args again leave their output',
    from: ['task-hash-derive'],
    workspace: one(ARGS),
    steps: [argsRun(['x'], true, '<x>'), argsRun(['y'], true, '<y>'), argsRun(['x'], null, '<x>')],
  }),
  keyCase({
    id: 'cache/empty-args-are-no-args',
    kind: 'efficiency',
    title: 'A bare `--` with no args replays what a run without it stored',
    from: ['task-hash-derive'],
    workspace: one(ARGS),
    steps: [argsRun(undefined, true, '<>'), argsRun([], false, '<>')],
  }),
  keyCase({
    id: 'cache/args-leave-dependency-replayed',
    kind: 'efficiency',
    title: 'New forwarded args for a task replay its dependency, which never sees them',
    why: 'The args go to the task asked for; a dependency keyed on them would miss on every new argument.',
    from: ['task-hash-derive'],
    workspace: {
      projects: {
        lib: { tasks: { build: stamp(['src/**']) }, files: { 'src/a.txt': 'lib\n' } },
        app: {
          deps: ['lib'],
          tasks: { build: { ...ARGS, dependsOn: ['^build'] } },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        args: ['x'],
        expect: { exit: 0, ran: ['lib#build', 'app#build'] },
      },
      {
        run: 'build',
        projects: ['app'],
        args: ['y'],
        expect: {
          exit: 0,
          ran: ['app#build'],
          notRan: ['lib#build'],
          files: { [out('app')]: '<y>' },
        },
      },
    ],
  }),
  keyCase({
    id: 'env/server-shell-not-dependency-sh',
    kind: 'correctness',
    title: 'A dependency’s bin named `sh` does not become the shell of a long-running task either',
    why: 'The task’s PATH decides what its command resolves, not which shell parses it.',
    from: ['task-shell'],
    needs: ['persistent', 'uncached-task'],
    workspace: shellShadow({
      srv: {
        command: 'echo parsed > s.tmp; own-tool >> s.tmp; mv s.tmp seen.txt; sleep 60',
        persistent: true,
      },
      e2e: {
        command: `${until('seen.txt')} && cp seen.txt got.txt`,
        dependsOn: ['srv'],
        cache: false,
      },
    }),
    steps: [
      { chmod: { 'packages/fakesh/sh.sh': 0o755, 'packages/fakesh/tool.sh': 0o755 } },
      {
        run: 'e2e',
        projects: ['a'],
        expect: { exit: 0, files: { [`${A}/got.txt`]: 'parsed\ntool ran\n' }, within: 60 },
      },
    ],
  }),

  // output shapes
  keyCase({
    id: 'outputs/shape-change-restored-exactly',
    kind: 'correctness',
    title:
      'An output that is a directory, a file or a link in turn comes back in each build’s own shape',
    why: 'Each replay lands on another shape’s tree; merged into it, the output is neither build’s.',
    from: ['output-shape'],
    workspace: shaped(['dist/**']),
    steps: [
      build(true, { files: SHAPE.dir }),
      ...toShape('file', true),
      ...toShape('link', true),
      ...(['dir', 'link', 'file', 'dir', 'file', 'link', 'dir'] as const).flatMap((s) =>
        toShape(s, null),
      ),
    ],
  }),
  keyCase({
    id: 'outputs/stray-other-shape-replaced',
    kind: 'correctness',
    title:
      'A directory where a replayed output file goes, or a file where its directory goes, is replaced',
    from: ['output-shape'],
    workspace: shaped(['dist/**']),
    steps: [
      build(true),
      ...toShape('file', true),
      { write: { [`${A}/dist`]: null } },
      inA({ 'dist/out/stray.txt': 'stray' }),
      ...toShape('dir', null),
      { write: { [`${A}/dist`]: null } },
      inA({ 'dist/out': 'stale-file' }),
      ...toShape('file', null),
      { write: { [`${A}/dist`]: null } },
      inA({ 'dist/out': 'stale-file' }),
      ...toShape('dir', null),
    ],
  }),
  keyCase({
    id: 'outputs/dir-and-dangling-links-restored',
    kind: 'correctness',
    title: 'An output link to a directory, or a dangling one, comes back as the link',
    from: ['output-shape'],
    workspace: proj(
      { command: 'sh build.sh', inputs: ['build.sh'], outputs: ['dist/**'] },
      {
        'build.sh': 'rm -rf dist && mkdir dist && ln -s ../src-dir dist/out\n',
        'src-dir/keep.txt': 'k\n',
      },
    ),
    steps: [
      build(true),
      inA({ dist: null }),
      build(null),
      { check: { links: { [`${A}/dist/out`]: '../src-dir' } } },
      inA({ 'build.sh': 'rm -rf dist && mkdir dist && ln -s ../missing dist/out\n' }),
      build(true),
      inA({ dist: null }),
      build(null),
      { check: { links: { [`${A}/dist/out`]: '../missing' } } },
    ],
  }),
  keyCase({
    id: 'outputs/linked-output-dir-restored',
    kind: 'correctness',
    title:
      'Through an output directory that is a link inside the project, a deleted output comes back',
    from: ['output-shape'],
    workspace: proj(
      { command: LINKED_DIST, inputs: ['src/**'], outputs: ['dist/**'] },
      { 'src/in.txt': 'v1\n' },
    ),
    steps: [
      build(true),
      inA({ 'real-out/out.js': null }),
      build(null, { files: { [`${A}/dist/out.js`]: 'v1\n' } }),
    ],
  }),
  keyCase({
    id: 'outputs/linked-output-dir-own-files-only',
    kind: 'correctness',
    title: 'Through an output directory link, each build leaves only its own files',
    from: ['output-shape'],
    workspace: proj(
      {
        command:
          'mkdir -p real-out && ln -sfn real-out dist && cat src/s.txt > dist/$(cat src/s.txt).js',
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
      { 'src/s.txt': 'one' },
    ),
    steps: [
      build(true, { files: { [`${A}/real-out/one.js`]: 'one' } }),
      inA({ 'src/s.txt': 'two' }),
      build(true, { files: { [`${A}/real-out/two.js`]: 'two', [`${A}/real-out/one.js`]: null } }),
      inA({ 'src/s.txt': 'one' }),
      build(null, { files: { [`${A}/real-out/one.js`]: 'one', [`${A}/real-out/two.js`]: null } }),
      inA({ 'src/s.txt': 'two' }),
      build(null, { files: { [`${A}/real-out/two.js`]: 'two', [`${A}/real-out/one.js`]: null } }),
    ],
  }),
  linkedDistLiteral('bare', ['dist']),
  linkedDistLiteral('slash-and-target', ['dist/', 'real-out/**']),
  keyCase({
    id: 'outputs/root-output-link-restored',
    kind: 'correctness',
    title: 'A root output that links to another file of the same output comes back as the link',
    from: ['output-shape'],
    workspace: proj(
      {
        command:
          'mkdir -p ../../gen && echo v2 > ../../gen/v2.txt && ln -sfn v2.txt ../../gen/latest',
        inputs: ['src/**'],
        outputs: [],
        rootOutputs: ['gen/**'],
      },
      { 'src/a.txt': 'a\n' },
    ),
    steps: [
      build(true),
      { write: { gen: null } },
      build(null, { files: { 'gen/latest': 'v2\n' } }),
      { check: { links: { 'gen/latest': 'v2.txt' } } },
    ],
  }),
  keyCase({
    id: 'outputs/miss-shape-change-cleaned',
    kind: 'correctness',
    title:
      'A rebuild whose output turns from a directory into a file finds no stale directory in its way',
    why: 'Declared outputs are the task’s: the runner clears them before a run, as a replay would.',
    from: ['output-shape'],
    workspace: shaped(['dist/**'], MISS_SH),
    steps: [build(true, { files: SHAPE.dir }), ...toShape('file', true)],
  }),
  keyCase({
    id: 'outputs/literal-output-shape-change',
    kind: 'correctness',
    title:
      'An output named outright, `dist/out`, turns from a directory to a file and back, run and replayed',
    from: ['output-shape'],
    workspace: shaped(['dist/out'], MISS_SH),
    steps: [
      build(true, { files: SHAPE.dir }),
      ...toShape('file', true),
      ...toShape('dir', null),
      ...toShape('file', null),
    ],
  }),
]
