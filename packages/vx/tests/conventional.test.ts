// scripts/conventional.ts: which headers pass the Conventional Commits rule.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import {
  conventionalError,
  landedHeads,
  landsByMerge,
  squashBreakingError,
} from '../scripts/conventional.js'

it('accepts type, optional scope and !, and names why anything else fails', () => {
  const check = (lines: string[]): Array<[string, string | null]> =>
    lines.map((l) => [l, conventionalError(l)])
  expect(
    check([
      'feat(cli): scaffold a plugin (H-21)',
      'fix!: drop a flag',
      'docs(vx-docs): fix a link',
      'refactor(cache,exec): share a helper',
      'revert: feat(cli): scaffold a plugin',
      'Hold the docs install lines (#764)',
      'feature(cli): a thing',
      'fix(cli):no space',
      'fix: ',
      'Merge branch main',
      `fix: ${'x'.repeat(66)}`,
      `fix: ${'x'.repeat(67)}`,
    ]),
  ).toEqual([
    ['feat(cli): scaffold a plugin (H-21)', null],
    ['fix!: drop a flag', null],
    ['docs(vx-docs): fix a link', null],
    ['refactor(cache,exec): share a helper', null],
    ['revert: feat(cli): scaffold a plugin', null],
    ['Hold the docs install lines (#764)', 'not `type(scope): summary`'],
    [
      'feature(cli): a thing',
      "unknown type 'feature' (one of feat, fix, perf, refactor, test, docs, ci, build, chore, revert)",
    ],
    ['fix(cli):no space', 'not `type(scope): summary`'],
    ['fix: ', 'not `type(scope): summary`'],
    ['Merge branch main', 'not `type(scope): summary`'],
    [`fix: ${'x'.repeat(66)}`, null],
    [`fix: ${'x'.repeat(67)}`, '72 chars (under 72)'],
  ])
})

it("a squash lands as many breaking commits as the PR's branch holds", () => {
  const c = (subject: string, body = ''): { subject: string; body: string } => ({ subject, body })
  const plain = [c('feat(history): key timings'), c('fix(history): index docs')]
  expect([
    // #4150: only the title said `!`, so its PR's page check passed and main's failed.
    squashBreakingError('feat(history)!: key timings', plain),
    squashBreakingError('feat(history)!: key timings', [c('feat(history)!: key timings')]),
    squashBreakingError('feat(history): key timings', [c('feat(history)!: key timings')]),
    squashBreakingError('feat(history)!: key timings', [c('feat!: a'), c('fix!: b')]),
    squashBreakingError('feat(history): key timings', plain),
    squashBreakingError('feat(x): y', [c('feat(x): y', 'BREAKING CHANGE: z')]),
  ]).toEqual([
    'the title is breaking and no commit is: mark one commit `!` (or a `BREAKING CHANGE:` footer)',
    null,
    '1 commits are breaking and the squash makes 0: mark the title `!`',
    '2 commits are breaking and the squash makes 1: keep one breaking commit',
    null,
    null,
  ])
})

// A mega branch gathers other PRs as `chore: land #N` merges and lands by a
// merge commit, so each PR's commits reach main as themselves and GitHub
// marks the PR merged (2026-10-28: 255 PRs, one CI run). No squash, so the
// squash's breaking count does not apply to it.
it('tells a branch that lands PRs by merge from one main is merged into', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-conv-'))
  const git = (...args: string[]): string => {
    const r = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', ...args], { cwd: dir })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return r.stdout.toString().trim()
  }
  try {
    git('init', '-q', '-b', 'main')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'a')
    const base = git('rev-parse', 'HEAD')
    git('checkout', '-q', '-b', 'pr')
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'fix: b',
    )
    git('checkout', '-q', '-b', 'mega', base)
    const merge = (m: string): string => {
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-ff', '-m', m, 'pr')
      return git('rev-parse', 'HEAD')
    }
    const pr = git('rev-parse', 'pr')
    const landed = merge('chore: land #1')
    expect([landsByMerge(base, landed, dir), landedHeads(base, landed, dir)]).toEqual([true, [pr]])
    git('checkout', '-q', '-B', 'mega', base)
    expect(landsByMerge(base, merge("Merge branch 'main'"), dir)).toBe(false)
    expect(landsByMerge(base, base, dir)).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
