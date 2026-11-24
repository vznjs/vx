// What a stray `git add` leaves behind is caught here, not by a reader of
// the squash: `private/vx-docs/out3.png`, a screenshot beside the site,
// reached main in #5624. Media lives where the site serves it from, the
// workspace has one lockfile (bun.lock, beside its own fixtures' strings),
// and no scratch file (a log, a patch reject, an archive) is tracked.
// Unsafe: it reads the index.
import path from 'node:path'
import { expect, it } from 'bun:test'

const repo = path.resolve(import.meta.dir, '..', '..', '..')

const MEDIA = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|pdf)$/i
const MEDIA_HOMES = ['private/vx-docs/public/', 'private/vx-docs/src/assets/']
const LOCKFILE =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/
const SCRATCH = /\.(?:log|orig|rej|bak|swp|tgz|tar|zip|gz)$|(?:^|\/)\.DS_Store$/

it('no tracked file is a stray: media in the site, one lockfile, no scratch', () => {
  const ls = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: repo })
  expect(ls.exitCode).toBe(0)
  const strays = ls.stdout
    .toString()
    .split('\0')
    .filter(Boolean)
    .filter(
      (f) =>
        (MEDIA.test(f) && !MEDIA_HOMES.some((home) => f.startsWith(home))) ||
        (LOCKFILE.test(f) && f !== 'bun.lock') ||
        SCRATCH.test(f),
    )
  expect(strays).toEqual([])
})
