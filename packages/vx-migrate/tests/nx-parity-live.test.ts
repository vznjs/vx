// vx's ports of Nx's own pure rules, held to the installed Nx itself
// (`VX_NX_MODULES`, as `nx-exec-live` reads it): a release that changes a
// rule turns this red instead of the mapping drifting in silence. Skips
// without the install; `VX_REQUIRE_NX=1` (CI) makes that a failure.
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { dotenvCandidates } from '../src/nx/nx-dotenv.js'

const MODULES = process.env['VX_NX_MODULES']
if (process.env['VX_REQUIRE_NX'] === '1' && !MODULES) {
  throw new Error('VX_REQUIRE_NX=1 but VX_NX_MODULES is unset — the Nx parity suite cannot run')
}

const nx = (spec: string): Record<string, (...args: never[]) => unknown> =>
  createRequire(path.join(MODULES!, 'node_modules', 'nx', 'package.json'))(spec)

describe.skipIf(!MODULES)('vx’s ports of Nx’s rules against the installed Nx', () => {
  it('a task’s `.env` file names, in load order (getEnvPathsForTask)', () => {
    const getEnvPathsForTask = nx('nx/src/tasks-runner/task-env-paths')['getEnvPathsForTask'] as (
      root: string,
      target: string,
      configuration?: string,
      nonAtomized?: string,
    ) => string[]
    const cases: Array<[string, string, string | undefined, string | undefined]> = [
      ['libs/a', 'build', undefined, undefined],
      ['libs/a', 'build', 'production', undefined],
      ['libs/a', 'e2e-ci', 'ci', 'e2e'],
      ['libs/a', 'e2e-ci', undefined, 'e2e'],
      ['.', 'build', undefined, undefined],
    ]
    for (const c of cases) expect(dotenvCandidates(...c)).toEqual(getEnvPathsForTask(...c))
  })
})
