// The site's "Upgrading to 1.0" page lists every breaking commit's
// `BREAKING CHANGE:` footer git log holds, and no other. The footers are
// compared, not the titles: a squash merge titles the commit after its PR,
// and the footer is the part that tells a user what to do. Regenerate with
// `bun packages/vx/scripts/upgrading.ts`.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { commitsBetween } from '../scripts/release-notes.ts'
import { page, PAGE } from '../scripts/upgrading.ts'

const ROOT = path.resolve(import.meta.dir, '../../..')

/** Each entry's text under its heading. */
function footers(md: string): string[] {
  return [...md.matchAll(/^## .+\n\n(.+)\n/gm)].map((m) => m[1]!).toSorted()
}

const shallow =
  Bun.spawnSync(['git', 'rev-parse', '--is-shallow-repository'], { cwd: ROOT })
    .stdout.toString()
    .trim() === 'true'

it('guides/upgrading.md carries every breaking footer in git log', () => {
  // A shallow checkout (actions/checkout's default depth 1, the macOS job)
  // holds none of the history: where CI sets VX_REQUIRE_TAGS, the job that
  // fetches it all, that is a failure, never a pass (as api-break's row).
  if (shallow) {
    expect(process.env['VX_REQUIRE_TAGS'] === '1' ? 'a shallow checkout: fetch-depth 0' : '').toBe(
      '',
    )
    return
  }
  const want = footers(page(commitsBetween('', 'HEAD', ROOT)))
  expect(want.length).toBeGreaterThanOrEqual(11)
  expect(footers(readFileSync(PAGE, 'utf8'))).toEqual(want)
})
