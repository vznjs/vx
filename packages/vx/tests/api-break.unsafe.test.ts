// The break law: a change since the last release that breaks any contract
// record — tests/contract/ (the vendored upstream schemas aside), the
// `--format json` schemas in schemas/ and vx-mcp's tools record, each read as `contractBreaks` reads it — fails
// here unless
// a commit since that tag says so (`type!:` or a `BREAKING CHANGE:`
// footer), which is also what puts it at the top of the release notes
// (scripts/release-notes.ts). Every green main commit is released, so the
// last tag is main's last green commit and the law judges this change.
//
// `.unsafe`: it asks git for the tag, its record and the commits since, and
// a sandboxed shard has no git.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { contractBreaks } from '../scripts/api-break.js'
import { commitsBetween, isBreaking } from '../scripts/release-notes.js'

const ROOT = path.resolve(import.meta.dir, '..')

function git(...args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(['git', ...args], { cwd: ROOT })
  return { ok: r.exitCode === 0, out: r.stdout.toString() }
}

const tags = git('tag', '--list', 'v*', '--merged', 'HEAD', '--sort=-v:refname').out.split('\n')
const lastTag = tags[0] ?? ''

/** The contract records vx holds (not the vendored upstream schemas beside them). */
const CONTRACT_DIR = 'tests/contract/'
const RECORD_DIRS = [CONTRACT_DIR, 'schemas/']
const EXTRA_RECORDS = ['../vx-mcp/tests/contract/tools.json']
const isRecord = (f: string): boolean => f !== '' && !f.startsWith(`${CONTRACT_DIR}turbo-nx/`)

/**
 * What changed in the contract records from `from` to `to` (the working
 * tree when omitted), one line per break, each naming its record
 * (`contractBreaks`). A record `from` had and `to` lacks broke whole.
 */
function recordBreaks(from: string, to?: string): string[] {
  const listed = (ref: string): string[] =>
    // `ls-tree <ref>:./<dir>` lists nothing; a path argument is relative to cwd.
    git('ls-tree', '-r', '--name-only', ref, ...RECORD_DIRS)
      .out.split('\n')
      .filter(isRecord)
  const walk = (dir: string): string[] =>
    readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${dir}${e.name}/`) : [`${dir}${e.name}`],
    )
  const inTo = to === undefined ? RECORD_DIRS.flatMap(walk).filter(isRecord) : listed(to)
  const records = [...new Set([...listed(from), ...inTo, ...EXTRA_RECORDS])].sort()
  return records.flatMap((record) => {
    const before = git('show', `${from}:./${record}`)
    if (!before.ok) return [] // the record did not exist then
    let after = ''
    if (to !== undefined) {
      const r = git('show', `${to}:./${record}`)
      after = r.ok ? r.out : ''
    } else if (existsSync(path.join(ROOT, record))) {
      after = readFileSync(path.join(ROOT, record), 'utf8')
    }
    return contractBreaks(record, before.out, after).map((b) => `${record}: ${b}`)
  })
}

it('a break of a contract record since the last release is marked breaking', () => {
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
  const breaks = recordBreaks(lastTag)
  if (breaks.length === 0) return
  const marked = commitsBetween(lastTag, 'HEAD', ROOT).filter(isBreaking)
  expect(
    marked.length > 0
      ? []
      : [
          `the contract breaks since ${lastTag}, and no commit since says so:`,
          ...breaks,
          'Mark the commit `type(scope)!: …` or add a `BREAKING CHANGE: …` footer; the release notes list it.',
        ],
  ).toEqual([])
})

// A PR's reviewers see the break in its title. CI's PR runs pass the title,
// base and head (conventional-commits.unsafe.test.ts); elsewhere there is
// no PR to judge.
it('a PR that breaks a contract record says so in its title', () => {
  const title = process.env['VX_PR_TITLE'] ?? ''
  const base = process.env['VX_PR_BASE'] ?? ''
  const head = process.env['VX_PR_HEAD'] ?? ''
  if (title === '' || base === '' || head === '') return
  const breaks = recordBreaks(git('merge-base', base, head).out.trim(), head)
  expect(
    breaks.length === 0 || isBreaking({ subject: title, body: '' })
      ? []
      : [
          `this PR breaks the contract and its title does not say so: ${title}`,
          ...breaks,
          'Mark the title `type(scope)!: …`.',
        ],
  ).toEqual([])
})
