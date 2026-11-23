// The release list of the site's "Upgrading vx" page, from git log: one entry per breaking
// commit (`type!:` or a `BREAKING CHANGE:` footer), newest first, under the
// release (`v*` tag) that shipped it, with the footer as what changed and
// what to do. A commit's subject loses its
// squash-merge `(#N)`, so a branch's own commit and the one main gets read
// the same. The page around the list is hand-written; the script rewrites only
// what lies between BEGIN and END. tests/site-upgrading.unsafe.test.ts holds
// the page to the log.
//
//   bun packages/vx/scripts/upgrading.ts           # rewrite the release list
//   bun packages/vx/scripts/upgrading.ts --check   # exit 1 if it would change
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isBreaking, type Commit } from './release-notes.ts'
import { SAY, TITLE } from './upgrading-say.ts'

/** A commit and the `v*` tag on it, if a release was cut there. */
export interface TaggedCommit extends Commit {
  readonly tag?: string
}

export const PAGE = path.resolve(
  import.meta.dir,
  '../../../private/vx-docs/src/content/docs/docs/upgrading.mdx',
)

const HEADER = /^(\w+)(?:\(([^)]*)\))?!?: (.+?)(?: \(#\d+\))?$/

/**
 * The exact step for a change whose footer names what changed but not what
 * to do, or that merged with no footer at all, keyed by the commit's subject
 * without its `(#N)`. A footer is history and cannot be edited; the step
 * follows it, and `title` replaces a heading that names another part of the
 * same PR.
 */
export const STEPS: Readonly<Record<string, { title?: string; steps: string }>> = {
  'feat(lock): a run refuses a config edited since vx lock': {
    title: 'A run refuses a config edited since vx lock',
    steps:
      'After editing a `vx.config.ts`, run `vx lock` before `vx run`, `vx show`, `vx why` or `vx pipeline`: the run now refuses with `VX_E_LOCK`, naming the file, instead of running the config the lock holds.',
  },
  'refactor(cli)!: drop the lock merge driver, name it .vx/projects.lock': {
    steps: [
      'Delete the old lock, the old attributes file and the merge driver, then lock again:',
      '',
      '```sh',
      'git rm .vx/projects.lock.jsonl .vx/.gitattributes',
      'git config --remove-section merge.vx-lock',
      'vx lock',
      'git add .vx',
      '```',
      '',
      '`vx lock` writes `.vx/.gitattributes` only when none exists, so the old one goes first. After a merge conflict in a lock, run `vx lock` and commit.',
    ].join('\n'),
  },
  'feat(cli): add vx pipeline, named runs in .vx/workspace.ts': {
    title: 'Forwarded args reach one task, CI prints failed tasks only',
    steps: [
      'Args after `--` go to one task in one project. A run with `--affected`, several tasks, or a filter that picks the task in two projects is refused.',
      '',
      'Run each task on its own: `vx run test --filter ui -- --watch`.',
      '',
      'On CI a run prints only failed tasks. To see every task, pass `--output-logs full` or set `VX_RUN_OUTPUT_LOGS=full`.',
    ].join('\n'),
  },
  'feat(orchestrator)!: replace --continue with --fail-fast': {
    steps: [
      'Replace each use:',
      '',
      "- `--continue=never` or `run.continue: 'never'`: use `--fail-fast` or `run.failFast: true`. Tasks still running are now killed.",
      "- `--continue`, `--continue=always`: remove it. A failed task's dependents never run now.",
      '- `--continue=deps-ok`: remove it. That is the default.',
    ].join('\n'),
  },
  'feat(orchestrator)!: fail a task whose declared output matched nothing': {
    title: 'Fail a task whose declared output path matched nothing',
    steps:
      'An output named by path (`dist/index.js`, `dist`) is required, and a task must write at least one output; a wildcard (`dist/**`) may match nothing beside one that matched. Run your tasks once after upgrading. A task that fails with `outputs matched no files (<glob>)` needs that glob fixed to match what the command writes, or removed from `outputs.files`.',
  },
  'fix(cli): a --filter that matches nothing refuses beside a match': {
    title: 'A --filter that matches nothing refuses the run',
    steps:
      'A `--filter` that matches no project, an exclusion too, now refuses the run even when another filter matched. Fix or remove it in your CI scripts and pipelines.',
  },
  'fix(cache)!: a --force run replaces the entry its key held': {
    steps:
      'A `--force` run now replaces the local entry under its key. A custom cache layer drops `kept()` and `stampWritten()`: vx no longer calls them.',
  },
  'fix(graph): refuse every output pair that takes a common path': {
    title: 'Refuse two tasks whose outputs can share a path',
    steps:
      '`vx lock` now refuses two tasks whose output globs can match one path, such as `*.js` beside `*b*`. Narrow one glob so the two tasks write no common path.',
  },
  'fix(sandbox): withhold browser profiles, mask more secret names': {
    title: 'Sandboxed tasks no longer read credential stores',
    steps: [
      'A sandboxed task no longer reads browser profiles, `~/.config/sops/age`, `~/.config/rclone`, `~/.my.cnf`, `~/.password-store` or `~/.sentryclirc`.',
      '',
      'A task that needs one names it in `exec.sandbox.allow.read`.',
      '',
      'Variables whose names hold `PASSPHRASE` or end in `_PASS` are now masked in output.',
    ].join('\n'),
  },
  "feat(report)!: name a failed task's directory and the piped columns": {
    title: 'Run history starts empty once',
    steps:
      'Nothing to do. `vx last` and `vx why` show only runs made after the upgrade. A piped run prints the Tasks header once.',
  },
}

/** A breaking commit's title line and its footer, as the page shows them. */
function entry({ subject, body }: Commit): { title: string; footer: string } {
  const m = HEADER.exec(subject)
  // The heading is the change in plain words: the scope is code's word for
  // where it lives, which a reader upgrading does not need.
  const title = sentence((m === null ? subject : m[3]!).replace(/ \([A-Z][A-Z0-9]*-\d+\)$/, ''))
  const lines = body.split('\n')
  const start = lines.findIndex((l) => /^BREAKING[ -]CHANGE: /.test(l))
  if (start === -1) return { title, footer: '' }
  // A footer ends at a blank line or at the git trailers (`Co-Authored-By:`)
  // a squash message can put in its paragraph (#4876's did).
  const end = lines.findIndex(
    (l, i) => i > start && (l.trim() === '' || /^[A-Za-z]+(?:-[A-Za-z]+)+: /.test(l)),
  )
  const footer = lines
    .slice(start, end === -1 ? undefined : end)
    .join(' ')
    .replace(/^BREAKING[ -]CHANGE: /, '')
    .replace(/\s+/g, ' ')
    .trim()
  return { title, footer: sentence(footer) }
}

/** A heading or a footer starts with a capital, unless it starts with code (`--continue`, `.vx/`). */
const sentence = (text: string): string => text.replace(/^[a-z]/, (c) => c.toUpperCase())

// Old commits say `npx`; the site teaches `bunx` only (2026-10-22).
const bunx = (text: string): string => text.replace(/\bnpx /g, 'bunx ')

// The page is MDX: braces and `<` in a footer's prose would be parsed as code.
const mdx = (text: string): string =>
  text
    .split(/(```[\s\S]*?```|``.*?``|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(/[{}]/g, (c) => `\\${c}`).replace(/</g, '&lt;'),
    )
    .join('')

export const BEGIN =
  '{/* Generated from git log by packages/vx/scripts/upgrading.ts: do not hand-edit until END. */}'
export const END = '{/* END of the generated releases. */}'

/** The release list: one `<div data-release>` per release, newest first, the picker's input. */
export function page(commits: readonly TaggedCommit[]): string {
  // A squash commit's body can carry an earlier commit's footer again
  // (#2527 repeated #2521's); the commit that made the change keeps it.
  const seen = new Set<string>()
  const releases: { name: string; entries: string[] }[] = []
  let entries: string[] = []
  let last = ''
  for (const commit of commits) {
    const subject = commit.subject.replace(/ \(#\d+\)$/, '')
    const step = STEPS[subject]
    if (isBreaking(commit) || step !== undefined) {
      const { title, footer } = entry(commit)
      if (footer === '' || !seen.has(footer)) {
        seen.add(footer)
        const said = footer === '' ? '' : (SAY[subject] ?? footer)
        const text = [said, step?.steps ?? ''].filter((t) => t !== '').join('\n\n')
        entries.push(
          `#### ${mdx(bunx(step?.title ?? TITLE[subject] ?? title))}\n\n${mdx(bunx(text)) || 'Nothing to change beyond the steps above.'}\n`,
        )
      }
    }
    if (commit.tag !== undefined) {
      if (entries.length > 0) releases.push({ name: commit.tag, entries })
      entries = []
      last = commit.tag
    }
  }
  if (entries.length > 0)
    releases.push({ name: last === '' ? 'Unreleased' : `After ${last}`, entries })
  const body = releases
    .toReversed()
    .map(
      ({ name, entries }) =>
        `<div data-release="${name}">\n\n### ${name}\n\n${entries.toReversed().join('\n')}\n</div>\n`,
    )
  return `${BEGIN}\n\n${body.join('\n')}\n${END}`
}

/** The page with its release list replaced by `list`. */
export function spliced(text: string, list: string): string {
  const start = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (start === -1 || end < start) throw new Error(`${PAGE} lacks the BEGIN and END markers`)
  return text.slice(0, start) + list + text.slice(end + END.length)
}

/**
 * Every commit up to HEAD, oldest first, each with its `v*` tag. A shallow
 * clone holds a few commits only: the page written from it dropped every
 * older release (1,060 lines on the 2026-11-23 day branch), so it refuses.
 */
export function taggedCommits(cwd: string): TaggedCommit[] {
  const shallow = Bun.spawnSync(['git', 'rev-parse', '--is-shallow-repository'], { cwd })
  if (shallow.stdout.toString().trim() === 'true')
    throw new Error('a shallow clone lacks the history: run `git fetch --unshallow` first')
  const r = Bun.spawnSync(
    [
      'git',
      'log',
      '--reverse',
      '--decorate-refs=refs/tags/v*',
      '--format=%s%x00%b%x00%D%x1e',
      'HEAD',
    ],
    { cwd },
  )
  if (r.exitCode !== 0) throw new Error(`git log failed: ${r.stderr.toString().trim()}`)
  return r.stdout
    .toString()
    .split('\x1e')
    .map((rec) => rec.replace(/^\n/, ''))
    .filter((rec) => rec !== '')
    .map((rec) => {
      const [subject = '', body = '', refs = ''] = rec.split('\0')
      const tag = /tag: (v[^,\s]+)/.exec(refs)?.[1]
      return tag === undefined ? { subject, body } : { subject, body, tag }
    })
}

if (import.meta.main) {
  const have = readFileSync(PAGE, 'utf8')
  const want = spliced(have, page(taggedCommits(path.resolve(import.meta.dir, '../../..'))))
  if (process.argv.includes('--check')) {
    if (have !== want) {
      process.stderr.write('docs/upgrading.mdx does not match git log; run the script\n')
      process.exit(1)
    }
  } else writeFileSync(PAGE, want)
}
