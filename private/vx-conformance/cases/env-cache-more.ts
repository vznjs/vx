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
  why: string
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

const crlf = (attr: string, slug: string, why: string) =>
  keyCase({
    id: `inputs/crlf-${slug}`,
    kind: 'correctness',
    title: `With \`${attr}\` in .gitattributes, a same-size edit to a CRLF file runs the task again`,
    why,
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

const textAuto = (slug: string, what: string, why: string, body: string) =>
  keyCase({
    id: `inputs/text-auto-crlf-rewrite-${slug}`,
    kind: 'correctness',
    title: `Under \`* text=auto\`, rewriting a file holding ${what} from LF to CRLF runs the task again`,
    why,
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

const linkedDistLiteral = (slug: string, outputs: string[], why: string) =>
  keyCase({
    id: `outputs/linked-dir-literal-${slug}`,
    kind: 'correctness',
    title: `An output list ${JSON.stringify(outputs)} naming a directory link brings back the file behind the link once it is deleted`,
    why,
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
  /** Why an ignored edit replays, and why an edit the rule lets through reruns. */
  why: { ignored: string; keyed: string }
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
      why: c.why.ignored,
      from: c.from,
      workspace: c.workspace,
      steps: [...(c.setup ?? []), build(true), ...c.ignored],
    }),
    keyCase({
      id: `inputs/${c.slug}-keyed`,
      kind: 'correctness',
      title: `${c.what}: an edit it leaves an input runs the task again`,
      why: c.why.keyed,
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
    why: 'A task stopped part way never finished its outputs, so there is no result to keep. An entry saved for the stopped run would replay a partial tree as a success: a half-written bundle, a missing file, under a green run. The stop must also fail the run, so CI that cancels a job does not report it as passed. The next run must do the work again.',
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
  crlf(
    '* text=auto',
    'text-auto',
    'Under `* text=auto` git may store a CRLF file with LF, but the task reads the CRLF bytes on disk, so those bytes are the input. An edit that keeps the size, with a future mtime, can look clean to git. A runner that trusts git’s stored blob replays the old build, though the file the task reads has changed.',
  ),
  crlf(
    '* text',
    'text',
    'Under `* text` git treats every file as text and stores it with LF, while the CRLF bytes stay on disk. The task reads the disk, so those bytes are the input. A runner that hashes git’s normalised form, or trusts a stat that did not move, misses a same-size edit and replays output built from the old file.',
  ),
  crlf(
    '*.txt text eol=crlf',
    'eol-crlf',
    'With `eol=crlf`, git writes CRLF on checkout but stores LF, so what is on disk and what git holds differ by design. The task reads the disk, so those bytes are the input. A same-size edit that git’s stat does not catch must still run the task again, or the runner replays output built from the old text.',
  ),
  keyCase({
    id: 'inputs/project-gitattributes-crlf',
    kind: 'correctness',
    title:
      'Under a project’s own `*.md text` rule, a same-size edit to a CRLF file runs the task again',
    why: 'A project can set its own line-ending rules in its own `.gitattributes`, and they apply to its files as the root’s do. Under `*.md text` git may store a CRLF file with LF, yet the task reads the CRLF bytes on disk. A runner that trusts git’s stored form, or reads only the root’s rules, can miss a same-size edit and replay the old build.',
    from: ['hash-scenarios'],
    workspace: proj(stamp(['a.md']), { '.gitattributes': '*.md text\n', 'a.md': 'one\r\ntwo\r\n' }),
    steps: [build(true), inA({ 'a.md': 'onE\r\ntwo\r\n' }), build(true)],
  }),
  textAuto(
    'lone-cr',
    'a lone CR',
    'Whether git calls a file text or binary, a rewrite from LF to CRLF changes the bytes the task reads. A lone CR makes git’s guess about the file uncertain, and in text mode it may store both versions as the same blob. A runner that trusts that blob replays output built from the LF file, so the CRLF version never reaches the build.',
    'a\nb\rc\n',
  ),
  textAuto(
    'late-nul',
    'a NUL past its first 8000 bytes',
    'Git looks only at a file’s first 8000 bytes to decide if it is binary, so a NUL past them leaves it text. Rewritten from LF to CRLF, the file on disk changes while git may store the same normalised blob. A runner that trusts that blob replays the old build, though every line the task reads is different.',
    `${'a\n'.repeat(4500)}\0\n`,
  ),
  textAuto(
    'control-byte',
    'a control byte',
    'A control byte does not make git call a file binary, so under `* text=auto` it is normalised like text. Rewritten from LF to CRLF, the bytes on disk change while git may store the same blob. A runner that trusts git’s stored form replays output built from the LF file, and the task’s real input never counts.',
    'a\u0001\nb\n',
  ),
  textAuto(
    'plain',
    'plain text',
    'Under `* text=auto`, git stores plain text with LF whatever is on disk. A rewrite from LF to CRLF then leaves git’s blob the same while every line the task reads changes. A runner that keys on that blob replays the old output, and a tool that cares about line endings, such as a shell script or a snapshot test, sees the wrong file.',
    'a\nb\n',
  ),
  keyCase({
    id: 'inputs/text-auto-binary-crlf-to-lf',
    kind: 'correctness',
    title: 'Under `* text=auto`, dropping the CR from a binary file’s CRLF runs the task again',
    why: 'Under `* text=auto` git decides by content whether a file is text, and a file holding NUL bytes is binary. Dropping a CR from it changes the bytes the task reads, even though a text-mode view of it might not. A runner that normalises line endings before hashing would see no change and replay output built from the old file.',
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
    why: 'A committed file with a non-ASCII name is an input like any other. Git quotes such a path in its output unless asked not to, and a quoted path names no file on disk. A runner that reads git’s list as-is drops the file from the key, so editing it replays the old build. Names are bytes and must be read as git meant them.',
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
    why: 'In a glob, a `:` is an ordinary character of a file name, not syntax. A runner that reads `src/*:bar.txt` as something else, such as a prefix or a path list, matches no file, and the task is keyed on nothing. Edits to `foo:bar.txt` then replay the old output. Both `foo:bar.txt` and `foo::bar.txt` match and must count.',
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
    why: 'A `,` means something in a glob only inside braces; elsewhere it is part of the name. A runner that splits `src/a,b.ts` into two patterns keys on `src/a` and `b.ts`, neither of which exists, so the file named `a,b.ts` is no input. Editing it then replays the old output, and the build ships stale code.',
    from: ['hash-scenarios'],
    workspace: proj(stamp(['src/a,b.ts']), NAMES),
    steps: [build(true), inA({ 'src/a,b.ts': 'ab2\n' }), build(true)],
  }),
  keyCase({
    id: 'inputs/scope-plus-group-names',
    kind: 'correctness',
    title: 'Inputs through `@scope`, `a+b` and `(marketing)` directories key the files under them',
    why: 'Paths with `@scope`, `a+b` and `(marketing)` are common: package scopes, and route groups in web frameworks. A glob engine that reads `+`, `@` or `( )` as pattern syntax matches nothing under them. The task is then keyed without its pages or modules, and an edit there replays the old build. These characters must match themselves.',
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
    why: 'File names may hold `$`, quotes, spaces or tabs, and route files such as `$id.tsx` are common. If the runner passes names through a shell, or splits a list on white space, such a file is mangled or lost. Its edits then replay the old output. Names must be handled as bytes from the file system to the key, committed or not.',
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
    why: 'A newline is a legal byte in a file or directory name. A runner that reads git’s or the file system’s list one line at a time splits such a name in two, and neither half names a file. The file then drops out of the key, and an edit to it replays the old output. Git’s NUL-separated output keeps each name whole.',
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
    why: 'An unclosed `[` opens no character class, so `src/[invalid` is the name of a file. A runner may key that file, or refuse the glob as malformed; both tell the truth. What it must not do is match nothing and run with the input silently left out, since an edit to the file would then replay the old build.',
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
    why: 'Git reads ignore rules only from files named `.gitignore`, plus `.git/info/exclude` and the user’s global file. A file named `foo.gitignore` or `.ignore` is just a file. A runner that treats them as rules drops inputs git would track, and edits to those files replay the old output. The ignore set must match git’s.',
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
    why: {
      ignored:
        'Ignore rules decide what is local state, and the rules in force are the ones on disk now, committed or not. While `gen.txt` is ignored, editing it changes nothing the key holds, so the task replays. A runner that reads ignore rules from the last commit keys a file the developer has just ignored, and reruns after every regeneration.',
      keyed:
        'Once an uncommitted .gitignore edit stops ignoring `gen.txt`, the file is an input like any other, and its edits must run the task again. A runner that reads only committed rules still ignores it. It then replays output built from an old `gen.txt` until someone commits the .gitignore change.',
    },
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
    why: {
      ignored:
        'A .gitignore of `*` with `!keep.txt` is a common way to keep one file in a cache or build folder and ignore the rest. Everything else there is local state, so an edit to `junk.txt` changes no input and the task replays. A runner that keys the whole folder reruns each time a tool writes its cache.',
      keyed:
        'A `*` .gitignore with `!keep.txt` ignores everything in its folder except `keep.txt`, which stays an input. Its edits must run the task again. A runner that sees the `*` and drops the whole directory loses the one file that was meant to count, and replays output built from the old `keep.txt`.',
    },
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
    why: {
      ignored:
        'A project’s own .gitignore can re-include a file the root ignores, since git applies the deeper rule last. Other `.log` files stay ignored as the root says, so an edit to `other.log` replays the task. A runner that applies the negation too widely keys every log file and reruns after each log write.',
      keyed:
        'Git applies the deeper .gitignore last, so a project’s `!important.log` re-includes a file the root’s `*.log` ignores. That file is an input, and an edit to it must run the task again. A runner that reads only the root’s rules drops it from the key and replays output built from the old file.',
    },
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
    why: {
      ignored:
        'A root .gitignore with `*.log` and `!keep.log` ignores every log but one. A new `debug.log` is local noise, so writing it changes no input and the task replays. A runner that does not honour `*.log` keys every debug log, and a cached task reruns each time a tool writes one.',
      keyed:
        'In a root .gitignore with `*.log` and `!keep.log`, the later negation wins for `keep.log`. That file is meant to count, so writing it must run the task again. A runner that applies `*.log` and skips the negation leaves `keep.log` out of the key and replays output built without it.',
    },
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
    why: {
      ignored:
        'A root rule can name a path deep inside a project, such as `packages/a/src/deep/*.tmp`. Git applies it there, so `x.tmp` is local state even under an input of `**`. A runner that applies root rules only at the top of each project, or not inside it, keys the temp file and reruns the task each time it changes.',
      keyed:
        'A root rule like `packages/a/src/deep/*.tmp` ignores only what it names. A new `y.txt` in the same directory is an input of the `**` glob, so it must run the task again. A runner that treats the whole directory as ignored, because one rule points into it, replays output that misses the new file.',
    },
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
    why: {
      ignored:
        'A new, untracked directory can bring its own .gitignore, and git applies it at once. A file it ignores, such as `secret.txt`, is local state and no input, so the task replays. A runner that reads ignore files only in tracked directories keys the secret, reruns on each change to it, and may store it.',
      keyed:
        'A new directory’s .gitignore ignores only what it names. `open.txt` beside it is a new input of `src/**`, so the task must run again. A runner that treats an untracked directory holding a .gitignore as wholly ignored replays output that misses the new file, and nothing warns.',
    },
    from: ['parity-turbo-hashing'],
    workspace: proj(stamp(['src/**']), { 'src/a.txt': 'a\n' }),
    setup: [inA({ 'src/fresh/.gitignore': 'secret.txt\n' })],
    ignored: [inA({ 'src/fresh/secret.txt': 's\n' }), build(false)],
    keyed: [inA({ 'src/fresh/open.txt': 'o\n' }), build(true)],
  }),
  ...ignoreCases({
    slug: 'nested-gitignore-scope',
    what: 'A nested .gitignore, which ignores only below it',
    why: {
      ignored:
        'A .gitignore applies to its own directory and below, so `src/a/.gitignore` ignores `src/a/x.txt`. That file is local state, and so is an empty directory, since git tracks no directories. Neither changes an input, so the task replays. A runner that keys empty directories, or misses the nested rule, reruns for nothing.',
      keyed:
        'A nested .gitignore ignores only below its own directory. `src/b/x.txt` has the same name as the file `src/a/.gitignore` ignores, but lies outside its scope, so it is an input. A runner that applies the rule by name across the project drops it from the key and replays output that misses the file.',
    },
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
    why: 'A FIFO is not a file with content: opening it to read waits for a writer that never comes. A runner that hashes everything under a glob hangs there, and a CI job runs until its timeout. Tools and test servers create FIFOs in project trees, so a runner must skip them, or treat them by type, and finish the run.',
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
    why: 'Staging and committing change git’s view of a file, not its bytes. The run before staging already stored a result for those bytes. A runner that keys a dirty file differently from a clean one misses after `git add` and again after the commit, so every edit is built three times before it is pushed.',
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
    why: 'Right after a commit, git cannot always tell a same-size edit from its stat, since both can fall in the same second (racy git). A runner that trusts git’s index there keys the new bytes as the committed blob, and replays the old build. The bytes on disk must be read whenever the stat cannot prove them unchanged.',
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
    why: 'Deleting a file, then staging and committing the deletion, leaves the same files on disk at each step. The run after the deletion stored a result for that tree. A runner that keys on git’s state, not the files, misses at each git step and rebuilds the same tree, which costs CI time on every pull request that deletes a file.',
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
    why: '`git add -N` records a path in the index with the empty blob, before its content is staged. That blob says nothing about the bytes on disk. A runner that trusts the index for the file keys every version of it as empty, so edits replay the old build. Such a file must be hashed from disk, like an untracked one.',
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
    why: 'A new repository with no commit is a normal place to start a project, and its tasks still have inputs. A runner that needs a HEAD should not refuse to cache there, and the first commit changes no file a task reads. If the commit made every key change, the first push would rebuild the whole workspace for nothing.',
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
    why: 'Which projects a run selects is not an input of a task: the same task on the same tree is one entry. A developer who builds everything, then only `lib`, should get a replay. A runner that folds the selection into the key misses whenever the filter differs, so local runs and CI jobs with other filters never share results.',
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
    why: 'A run limited to changed projects asks for the same tasks on the same files as a full run. The full run already stored them, so the affected run should replay. A runner that keys on how a task was selected misses here, and CI rebuilds work that a full run on the same commit has already done.',
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
    why: 'A task may depend on a file at the workspace root, such as a shared config, and declare it explicitly. That file is then part of its key even when no project file is. A runner that ignores root inputs when the project lists none replays the old output after the root file changes, and the new config never reaches the build.',
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
    why: 'A variable’s value means something only with its name. A key that folds values without their names cannot tell `A=1` from `B=1`, or `A=1 B=2` from `A=2 B=1`. The runner then replays a build made for one environment in the other, such as a staging URL in a production build. Each name and value must be keyed as a pair.',
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
    why: 'A declared variable must reach the task exactly as the shell set it. Values with `=`, newlines, tabs or non-ASCII text are common: keys, certificates, multi-line settings. A runner that splits on `=` or a newline, or re-encodes the value, hands the task a different value from the one that is keyed, and the build is wrong under a matching key.',
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
    why: 'PATH differs on almost every machine and changes with each tool installed. If an undeclared PATH were keyed, no two machines would share an entry, and a remote cache would never hit. The trade-off is that a tool found through PATH is not in the key; a task that depends on a tool’s version can declare that explicitly.',
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
    why: 'TMPDIR, TMP and TEMP tell a task where it may write temporary files, and the host sets them for a reason, such as a larger or private disk. A runner that drops or rewrites them sends the task’s temp files where the host never pointed it, filling a small disk or sharing files between jobs. A task’s own exports must also reach its children.',
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
    why: 'Forwarded args change what a task does, so they are part of its key. A run with new args must run the task again, or it replays output made for other args, such as tests for another filter. Going back to the first args must leave their own output, whether run again or replayed, never the output of the args in between.',
    from: ['task-hash-derive'],
    workspace: one(ARGS),
    steps: [argsRun(['x'], true, '<x>'), argsRun(['y'], true, '<y>'), argsRun(['x'], null, '<x>')],
  }),
  keyCase({
    id: 'cache/empty-args-are-no-args',
    kind: 'efficiency',
    title: 'A bare `--` with no args replays what a run without it stored',
    why: 'A bare `--` with nothing after it passes no args, exactly as a run without it. The command the task runs is the same, so the stored result is the same. A runner that keys the separator itself misses whenever a script or alias adds `--` by habit, and rebuilds work it has already done.',
    from: ['task-hash-derive'],
    workspace: one(ARGS),
    steps: [argsRun(undefined, true, '<>'), argsRun([], false, '<>')],
  }),
  keyCase({
    id: 'cache/args-leave-dependency-replayed',
    kind: 'efficiency',
    title: 'New forwarded args for a task replay its dependency, which never sees them',
    why: 'Args go to the task that was asked for; a dependency never sees them. A dependency keyed on them would miss on every new argument, though its command and output are the same. Running a test task with a new filter would then rebuild every library it depends on, for no change in what they produce.',
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
    why: 'A long-running task, such as a dev server, is started the same way as any other, so the same rule holds. The task’s PATH decides what its command resolves, not which shell parses it. If a dependency’s bin named `sh` became the shell, a package could take over the server, and the tests run against it would test something else.',
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
    why: 'A replay must leave the output exactly as the build that stored it, whatever was there before. When `dist/out` is a directory in one build, a file in the next and a link in a third, each replay lands on another shape’s tree. Merged into it, the result is neither build’s output, and the next step reads a mix of both.',
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
    why: 'A replay can find a stray directory where its output file goes, or a stale file where its directory goes. Writing around it, or failing on it, leaves a tree that is not the stored one. A runner must replace what is in the way, since the declared output path is the task’s to own, and the run must not fail over leftovers.',
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
    why: 'A link is an output in its own right: what it points to, not a copy of the target. A link to a directory, or one whose target does not exist, must come back as that link. A runner that follows links when storing copies a whole directory or fails on the dangling one, and the restored tree differs from what the build made.',
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
    why: 'Builds often make their output directory a link into another folder of the project. When the files behind it are deleted, a replay must restore them where the link leads. A runner that stores only the link, or writes through it to the wrong place, leaves `dist/out.js` missing while the run reports success.',
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
    why: 'Each build’s output is exactly the files it wrote, also when the output directory is a link. A replay of `one` must remove `two.js` that another build left behind it, and the other way round. A runner that only adds files through the link leaves both, and a bundler or deploy step then ships files from a build that is not current.',
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
  linkedDistLiteral(
    'bare',
    ['dist'],
    'An output named `dist` means what the build wrote there, also when `dist` is a link to another folder. A runner that stores only the link, and not the files behind it, has nothing to restore once `real-out/out.js` is deleted. The replay then reports success while the file the next step reads is missing.',
  ),
  linkedDistLiteral(
    'slash-and-target',
    ['dist/', 'real-out/**'],
    'Naming both the link `dist/` and its target `real-out/**` declares the same files twice, which must not confuse a restore. The replay must bring back `real-out/out.js` once, and keep `dist` pointing at it. A runner that writes the files through the link and then replaces the link, or the other way round, can leave the output missing.',
  ),
  keyCase({
    id: 'outputs/root-output-link-restored',
    kind: 'correctness',
    title: 'A root output that links to another file of the same output comes back as the link',
    why: 'A task can declare an output at the workspace root, and a link inside it that points to another file of the same output. Such a `latest` link is a common pattern for generated assets. On replay it must come back as the link, not as a copy or a missing file, or tools that follow it read the wrong version.',
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
    why: 'Declared outputs belong to the task, so the runner clears them before a run, as a replay would. If the old `dist/out` directory stays, a build that now writes `dist/out` as a file fails, or writes beside stale files. The result then depends on what earlier builds left, and a clean CI checkout would build something else.',
    from: ['output-shape'],
    workspace: shaped(['dist/**'], MISS_SH),
    steps: [build(true, { files: SHAPE.dir }), ...toShape('file', true)],
  }),
  keyCase({
    id: 'outputs/literal-output-shape-change',
    kind: 'correctness',
    title:
      'An output named outright, `dist/out`, turns from a directory to a file and back, run and replayed',
    why: 'An output named outright, such as `dist/out`, is the same path whether it is a file or a directory. Run or replayed, the runner must leave it in the shape this build made. A runner that matches the name only as a file, or only as a directory, stores or restores nothing in the other shape, and the next step finds no output.',
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
