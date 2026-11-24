// "Is this CI?" has one answer in a run: core's `ciProvider`, which plugins
// read as `ctx.ci`. vxHistory once decided by its token alone and uploaded
// from a laptop that vxCache, asking core, kept read-only (0d8b1ddf9). A
// source that reads the generic `CI` variable itself can disagree again
// (`CI=no`, `CI=False`, Jenkins with no `CI`). A provider's own variable
// (`GITHUB_ACTIONS`) is read for that provider's own features. Unsafe: it
// reads every package.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const repo = path.resolve(import.meta.dir, '..', '..', '..')
const READS_CI = /\b(?:env|Bun\.env|process\.env)(?:\[\s*['"`]CI['"`]\s*\]|\.CI\b)/

it('no package source reads the CI variable but core’s ciProvider', () => {
  const files = [
    ...new Bun.Glob('packages/*/src/**/*.{ts,mts,cts,js,mjs,cjs}').scanSync({ cwd: repo }),
  ]
  expect(files.length).toBeGreaterThan(100)
  const readers = files
    .filter((f) => f !== 'packages/vx/src/util/env-flag.ts')
    .filter((f) => READS_CI.test(readFileSync(path.join(repo, f), 'utf8')))
    .sort()
  expect(readers).toEqual([])
})

it('the law sees each spelling of a read', () => {
  for (const s of ["env['CI']", 'Bun.env.CI', 'process.env["CI"]', 'env[`CI`]'])
    expect(READS_CI.test(s)).toBe(true)
  for (const s of ["env['CI_JOB_TOKEN']", 'env.CIRCLECI', "env['GITLAB_CI']"])
    expect(READS_CI.test(s)).toBe(false)
})
