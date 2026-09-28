// The API-break law: a change since the last release that removes or
// changes a declaration in tests/contract/package-api.txt fails here unless
// a commit since that tag says so (`type!:` or a `BREAKING CHANGE:`
// footer), which is also what puts it at the top of the release notes
// (scripts/release-notes.ts). Every green main commit is released, so the
// last tag is main's last green commit and the law judges this change.
//
// `.unsafe`: it asks git for the tag, its record and the commits since, and
// a sandboxed shard has no git.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { apiBreaks } from '../scripts/api-break.js'
import { commitsBetween, isBreaking } from '../scripts/release-notes.js'

const ROOT = path.resolve(import.meta.dir, '..')
const RECORD = 'tests/contract/package-api.txt'

function git(...args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(['git', ...args], { cwd: ROOT })
  return { ok: r.exitCode === 0, out: r.stdout.toString() }
}

const tags = git('tag', '--list', 'v*', '--merged', 'HEAD', '--sort=-v:refname').out.split('\n')
const lastTag = tags[0] ?? ''

it('a break of the package API since the last release is marked breaking', () => {
  // A checkout with no tags (actions/checkout's default depth 1) cannot
  // answer: where CI sets VX_REQUIRE_TAGS that is a failure, never a pass.
  if (lastTag === '') {
    expect(
      process.env['VX_REQUIRE_TAGS'] === '1'
        ? 'no v* tag reachable from HEAD: check out with fetch-depth 0'
        : '',
    ).toBe('')
    return
  }
  const before = git('show', `${lastTag}:./${RECORD}`)
  if (!before.ok) return // the record did not exist at that release
  const breaks = apiBreaks(before.out, readFileSync(path.join(ROOT, RECORD), 'utf8'))
  if (breaks.length === 0) return
  const marked = commitsBetween(lastTag, 'HEAD', ROOT).filter(isBreaking)
  expect(
    marked.length > 0
      ? []
      : [
          `package API breaks since ${lastTag}, and no commit since says so:`,
          ...breaks,
          'Mark the commit `type(scope)!: …` or add a `BREAKING CHANGE: …` footer; the release notes list it.',
        ],
  ).toEqual([])
})
