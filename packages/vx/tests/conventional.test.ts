// scripts/conventional.ts: which headers pass the Conventional Commits rule.
import { expect, it } from 'bun:test'
import { conventionalError, squashBreakingError } from '../scripts/conventional.js'

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
