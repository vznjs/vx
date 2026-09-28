// scripts/conventional.ts: which headers pass the Conventional Commits rule.
import { expect, it } from 'bun:test'
import { conventionalError } from '../scripts/conventional.js'

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
  ])
})
