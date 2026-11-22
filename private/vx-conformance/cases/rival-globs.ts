// Input glob semantics, one row of Turborepo's glob tests per case
// (vercel/turborepo crates/turborepo-globwalk/src/lib.rs: the
// `#[test_case]` table of `globwalk` match counts and dot-segment
// cleaning). Each case declares one input pattern over a small tree: an
// edit to a file the pattern matches must run the task again, and an edit
// to a file it does not match must replay it. A pattern a tool reads
// differently either replays a stale build or reruns for nothing.
import { defineCase, type Case } from '../src/spec.ts'

const A = 'packages/a'

/**
 * Input `pattern` (project-relative); the task reads `hit`, which the
 * pattern matches. `miss` sits beside it, unmatched: editing it replays.
 */
function glob(
  slug: string,
  title: string,
  why: string,
  pattern: string,
  hit: string,
  miss: string | null,
  /** A tool may refuse the pattern outright, before any task runs. */
  refusable = false,
): Case {
  const r = refusable ? { orRefused: true } : {}
  const files: Record<string, string> = { [hit]: 'one\n' }
  if (miss !== null) files[miss] = 'other\n'
  return defineCase({
    id: `inputs/glob-${slug}`,
    category: 'inputs',
    kind: 'correctness',
    title,
    why,
    from: ['inputs-resolution', 'brace-inputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: `mkdir -p dist && cat '${hit.replaceAll("'", `'\\''`)}' > dist/out.txt`,
              inputs: [pattern],
              outputs: ['dist/**'],
            },
          },
          files,
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'one\n' }, ...r } },
      ...(miss === null
        ? []
        : [
            { write: { [`${A}/${miss}`]: 'changed\n' } },
            { run: 'build' as const, expect: { exit: 0 as const, notRan: ['a#build'], ...r } },
          ]),
      { write: { [`${A}/${hit}`]: 'two\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'two\n' }, ...r },
      },
    ],
  })
}

const WHY_MATCH =
  'A user writes the pattern expecting the glob rules every shell and bundler share. A tool that reads it more narrowly never keys the file the task reads, and replays a build of its old content; one that reads it more widely reruns on files the task never touches.'

export default [
  // "wildcard followed by doublestar"
  glob(
    'star-dir-then-globstar',
    'An input `g/a*/**` keys files under every directory starting with `a`, and no other',
    `A star in a directory name picks directories, then \`**\` takes everything below them. ${WHY_MATCH}`,
    'g/a*/**',
    'g/ab/deep/x.txt',
    'g/b/x.txt',
  ),
  // "leading doublestar expansion"
  glob(
    'globstar-then-suffix',
    'An input `g/**/*f` keys a file ending in `f` at any depth, and not one ending otherwise',
    `\`**/*f\` is any directory depth, then a name ending in \`f\`. ${WHY_MATCH}`,
    'g/**/*f',
    'g/x/y/zf',
    'g/x/y/zg',
  ),
  // "single star suffix match"
  glob(
    'star-suffix',
    'An input `g/*c` keys `abc` and not `abd`',
    `A leading star matches any start of a name, and the rest must match exactly. ${WHY_MATCH}`,
    'g/*c',
    'g/abc',
    'g/abd',
  ),
  // "single star prefix with suffix match"
  glob(
    'star-dir-fixed-file',
    'An input `g/a*/b` keys `ax/b`, and not `ax/c`',
    `A star in the directory part leaves the file name exact: only files named \`b\` in matching directories. ${WHY_MATCH}`,
    'g/a*/b',
    'g/ax/b',
    'g/ax/c',
  ),
  glob(
    'star-dir-not-two-levels',
    'An input `g/a*/b` does not key `ax/y/b`, two levels down',
    `A single star stays inside one path segment, so \`a*/b\` never reaches a \`b\` one directory deeper. ${WHY_MATCH}`,
    'g/a*/b',
    'g/ab/b',
    'g/ax/y/b',
  ),
  // "multiple single stars match"
  glob(
    'many-stars',
    'An input `g/a*b*c*d*e*` keys a name with those letters in order, and not one missing the last',
    `Several stars each match any run of characters between fixed letters. A matcher that backtracks badly, or caps the stars, gets these wrong. ${WHY_MATCH}`,
    'g/a*b*c*d*e*',
    'g/a1b2c3d4e5',
    'g/a1b2c3d4',
  ),
  // "single star and question mark match"
  glob(
    'star-and-question-mark',
    'An input `g/a*b?c*x` keys `aXbYcZx`, and not `abcx`, where `?` has nothing to match',
    `\`?\` matches exactly one character, so \`b?c\` needs something between \`b\` and \`c\`. ${WHY_MATCH}`,
    'g/a*b?c*x',
    'g/aXbYcZx',
    'g/abcx',
  ),
  // "character class range match"
  glob(
    'class-range',
    'An input `g/ab[b-d]` keys `abc`, and not `abe`',
    `A range in brackets matches one character from it. ${WHY_MATCH}`,
    'g/ab[b-d]',
    'g/abc',
    'g/abe',
  ),
  // "negated character class unicode match 2"
  glob(
    'negated-class',
    'An input `g/a[!a]b` keys `axb`, and not `aab`',
    `\`[!a]\` matches one character that is not \`a\`. A tool reading \`!\` as a literal, or the whole input as an exclusion, keys the wrong file. ${WHY_MATCH}`,
    'g/a[!a]b',
    'g/axb',
    'g/aab',
  ),
  glob(
    'caret-negated-class',
    'An input `g/a[^a]b` keys `axb`, and not `aab`',
    `\`[^a]\` is the other common spelling of a negated class, used by gitignore and most glob libraries. ${WHY_MATCH}`,
    'g/a[^a]b',
    'g/axb',
    'g/aab',
  ),
  // "insufficient question marks mismatch"
  glob(
    'question-marks-count',
    'An input `g/a???b` keys a name with three characters between `a` and `b`, not two',
    `Each \`?\` is exactly one character; three of them never match two. ${WHY_MATCH}`,
    'g/a???b',
    'g/axxxb',
    'g/axxb',
  ),
  // "question mark not matching slash"
  glob(
    'question-mark-not-slash',
    'An input `g/a?b` keys `axb`, and not the file `b` in a directory `a`',
    `\`?\` never matches the \`/\` between directories. ${WHY_MATCH}`,
    'g/a?b',
    'g/axb',
    'g/a/b',
  ),
  // "single star not matching slash 2"
  glob(
    'star-not-slash',
    'An input `g/a*b` keys `axyb`, and not `ax/yb` across a directory',
    `A single star stops at \`/\`; only \`**\` crosses directories. ${WHY_MATCH}`,
    'g/a*b',
    'g/axyb',
    'g/ax/yb',
  ),
  // "star pattern match"
  glob(
    'star-stays-at-its-level',
    'An input `g/*x` keys `g/fox`, and not `g/d/fox` below it',
    `A pattern without \`**\` matches at its own level only. ${WHY_MATCH}`,
    'g/*x',
    'g/fox',
    'g/d/fox',
  ),
  // "a followed by double star and single subdirectory match"
  glob(
    'globstar-matches-zero-dirs',
    'An input `g/a/**/b` keys `g/a/b`, with no directory between',
    `\`**\` matches zero or more directories, so \`a/**/b\` includes \`a/b\` itself. ${WHY_MATCH}`,
    'g/a/**/b',
    'g/a/b',
    'g/a/c',
  ),
  glob(
    'globstar-matches-many-dirs',
    'An input `g/a/**/b` keys `g/a/x/y/z/b`, three directories down',
    `\`**\` spans any number of directories. ${WHY_MATCH}`,
    'g/a/**/b',
    'g/a/x/y/z/b',
    'g/a/x/y/z/c',
  ),
  // "double star and single subdirectory match"
  glob(
    'leading-globstar-top-level',
    'An input `g/**/c` keys `g/c` at the top of the tree',
    `A leading \`**/\` also matches no directory at all. ${WHY_MATCH}`,
    'g/**/c',
    'g/c',
    'g/d',
  ),
  // "pattern with curly braces and wildcard match"
  glob(
    'brace-with-star-alternative',
    'An input `g/ab{c,d,*}` keys `abzz` through its star alternative',
    `Each brace alternative is a pattern of its own, a star included. ${WHY_MATCH}`,
    'g/ab{c,d,*}',
    'g/abzz',
    'g/ac',
  ),
  // "a/{b/c,c/b}"
  glob(
    'brace-alternatives-with-slashes',
    'An input `g/a/{b/c,c/b}` keys `a/c/b`, and not `a/b/b`',
    `Alternatives can hold whole paths. A tool that splits the pattern at \`/\` before expanding braces breaks them apart. ${WHY_MATCH}`,
    'g/a/{b/c,c/b}',
    'g/a/c/b',
    'g/a/b/b',
  ),
  // "{a/{b,c},abc}"
  glob(
    'nested-braces',
    'An input `g/{a/{b,c},abc}` keys `a/c` and `abc`, and not `a/d`',
    `Braces nest: the inner set expands inside the outer alternative. A tool that expands one level leaves \`{b,c}\` as text. ${WHY_MATCH}`,
    'g/{a/{b,c},abc}',
    'g/a/c',
    'g/a/d',
  ),
  glob(
    'nested-braces-outer-alternative',
    'An input `g/{a/{b,c},abc}` keys the plain alternative `abc`',
    `The outer set’s other alternative is a name of its own, matched whole. ${WHY_MATCH}`,
    'g/{a/{b,c},abc}',
    'g/abc',
    'g/abd',
  ),
  // "star with unicode"
  glob(
    'star-after-unicode',
    'An input `g/**/【*` keys a name starting with `【`, and not a plain one',
    `A pattern can hold any character, and a star after a multi-byte one must still match by characters, not bytes. ${WHY_MATCH}`,
    'g/**/【*',
    'g/x/【y',
    'g/x/y',
  ),
  // "escaped bracket match"
  glob(
    'escaped-bracket-in-class',
    'An input `g/[\\]a]` keys the file named `]`',
    `Inside a class, \`\\]\` is a closing bracket character rather than the end of the class. ${WHY_MATCH}`,
    'g/[\\]a]',
    'g/]',
    'g/b',
  ),
  // "test path with dotdot segments"
  glob(
    'dotdot-segment-cleaned',
    'An input `g/x/../a.txt` keys `g/a.txt`',
    `A \`..\` inside the pattern steps back up a directory, as in any path. A tool that keeps it as a name never keys the file; refusing the pattern before any task runs is fine. ${WHY_MATCH}`,
    'g/x/../a.txt',
    'g/a.txt',
    'g/b.txt',
    true,
  ),
  // "dotdot prefix not a segment"
  glob(
    'name-starting-with-two-dots',
    'An input `g/..notes` keys a file named `..notes`, which is a name and not a parent',
    `Only a segment that is exactly \`..\` means the parent. \`..notes\` is an ordinary hidden file. ${WHY_MATCH}`,
    'g/..notes',
    'g/..notes',
    'g/notes',
  ),
  // "trailing dotdot in name not a segment"
  glob(
    'directory-ending-in-two-dots',
    'An input `g/b../c` keys `c` in a directory named `b..`',
    `A directory named \`b..\` is a name; cleaning it as if it were \`..\` points the pattern somewhere else. ${WHY_MATCH}`,
    'g/b../c',
    'g/b../c',
    'g/c',
  ),
]
