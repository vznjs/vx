// The Conventional Commits rule this repo holds its PR titles and commit
// subjects to (CLAUDE.md § Workflow): `type(scope)!: summary`, scope and `!`
// optional, the type one of TYPES, the whole line under MAX_LENGTH. Release notes and the version bump read
// these subjects (release-notes.ts), so one that does not parse is a change
// the notes miss. tests/conventional-commits.unsafe.test.ts applies it in CI.

import { isBreaking, type Commit } from './release-notes.ts'

const TYPES = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'test',
  'docs',
  'ci',
  'build',
  'chore',
  'revert',
] as const

/** A header this long or longer wraps in `git log --oneline` and GitHub's lists. */
const MAX_LENGTH = 72

const SHAPE = /^(\w+)(?:\([\w./@-]+(?:,[\w./@-]+)*\))?!?: \S/

/** Why `line` is not a Conventional Commits header, or null when it is one. */
export function conventionalError(line: string): string | null {
  const m = SHAPE.exec(line)
  if (m === null) return 'not `type(scope): summary`'
  if (!(TYPES as readonly string[]).includes(m[1]!)) {
    return `unknown type '${m[1]}' (one of ${TYPES.join(', ')})`
  }
  if (line.length >= MAX_LENGTH) return `${line.length} chars (under ${MAX_LENGTH})`
  return null
}

/**
 * Why a PR's squash would land a different number of breaking commits on
 * main than its branch holds, or null. Main gets one commit, subject the
 * title, body each branch commit's message; the PR's CI reads the branch.
 * The upgrading page and the version read breaking commits, so a PR whose
 * title alone said `!` passed and main failed (#4150, 2026-10-23).
 */
export function squashBreakingError(title: string, commits: readonly Commit[]): string | null {
  const branch = commits.filter(isBreaking).length
  const body = commits.map((c) => `* ${c.subject}\n\n${c.body}`).join('\n\n')
  const main = isBreaking({ subject: title, body }) ? 1 : 0
  if (branch === main) return null
  if (branch === 0)
    return 'the title is breaking and no commit is: mark one commit `!` (or a `BREAKING CHANGE:` footer)'
  return `${branch} commits are breaking and the squash makes ${main}: ${main === 0 ? 'mark the title `!`' : 'keep one breaking commit'}`
}

/**
 * The PR heads `base..head` lands as `chore: land #N` merges (each merge's
 * second parent): such a branch merges into main by a merge commit, each
 * PR's commits as themselves (2026-10-28: 255 PRs, one CI run).
 */
export function landedHeads(base: string, head: string, cwd: string): string[] {
  const r = Bun.spawnSync(['git', 'log', '--merges', '--format=%P %s', `${base}..${head}`], { cwd })
  if (r.exitCode !== 0) throw new Error(`git log ${base}..${head}: ${r.stderr.toString().trim()}`)
  return r.stdout
    .toString()
    .split('\n')
    .flatMap((l) => {
      const m = /^\S+ (\S+) chore: land #\d+$/.exec(l)
      return m === null ? [] : [m[1]!]
    })
}

/** Whether `base..head` lands PRs by merge, so no squash counts its breaking commits. */
export function landsByMerge(base: string, head: string, cwd: string): boolean {
  return landedHeads(base, head, cwd).length > 0
}
