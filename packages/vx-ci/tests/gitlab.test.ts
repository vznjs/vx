// `gitlab()` names the run's branch through `setBranch`, as `github()`
// does on Actions (owner, 2026-10-18): the default branch and a merge
// train keep the default keys, a branch or its merge request gets
// `<project path>:<branch>`, and a merge request its diff base.
import { expect, it } from 'bun:test'
import type { BranchFacts } from '@vzn/vx'
import { gitlab } from '../src/index.js'

const GITLAB_KEYS = [
  'GITLAB_CI',
  'CI_PROJECT_PATH',
  'CI_DEFAULT_BRANCH',
  'CI_COMMIT_REF_NAME',
  'CI_COMMIT_TAG',
  'CI_MERGE_REQUEST_EVENT_TYPE',
  'CI_MERGE_REQUEST_SOURCE_BRANCH_NAME',
  'CI_MERGE_REQUEST_SOURCE_PROJECT_PATH',
  'CI_MERGE_REQUEST_DIFF_BASE_SHA',
]

async function branchOf(
  env: Record<string, string>,
  options: Parameters<typeof gitlab>[0] = {},
): Promise<BranchFacts | 'declined'> {
  const saved = GITLAB_KEYS.map((k) => [k, process.env[k]] as const)
  for (const k of GITLAB_KEYS) delete process.env[k]
  Object.assign(process.env, env)
  const facts: BranchFacts = {}
  try {
    const plugin = gitlab(options)
    if (plugin === undefined) return 'declined'
    await plugin.config!(
      {},
      { workspaceRoot: '/ws', warn: () => {}, setBranch: (f) => Object.assign(facts, f) },
    )
    return facts
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const job = (ref: string, extra: Record<string, string> = {}): Record<string, string> => ({
  GITLAB_CI: 'true',
  CI_PROJECT_PATH: 'Acme/Web/App',
  CI_DEFAULT_BRANCH: 'main',
  CI_COMMIT_REF_NAME: ref,
  ...extra,
})

it('the default branch keeps the default keys; another branch or tag gets its own scope', async () => {
  expect(await branchOf(job('main'))).toEqual({})
  expect(await branchOf(job('feat-x'))).toEqual({ scope: 'acme/web/app:feat-x' })
  expect(await branchOf(job('main', { CI_COMMIT_TAG: 'main' }))).toEqual({
    scope: 'acme/web/app:main',
  })
})

it("a merge request names its source branch, a fork's in the fork, and its diff base", async () => {
  const mr = {
    CI_MERGE_REQUEST_EVENT_TYPE: 'merged_result',
    CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feat-x',
    CI_MERGE_REQUEST_DIFF_BASE_SHA: 'b4se',
  }
  expect(await branchOf(job('refs/merge-requests/7/merge', mr))).toEqual({
    scope: 'acme/web/app:feat-x',
    base: 'b4se',
  })
  expect(
    await branchOf(
      job('refs/merge-requests/7/merge', {
        ...mr,
        CI_MERGE_REQUEST_SOURCE_PROJECT_PATH: 'eve/app',
      }),
    ),
  ).toEqual({ scope: 'eve/app:feat-x', base: 'b4se' })
})

it('a merge train is trusted: no scope, compared with its diff base', async () => {
  expect(
    await branchOf(
      job('refs/merge-requests/7/train', {
        CI_MERGE_REQUEST_EVENT_TYPE: 'merge_train',
        CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feat-x',
        CI_MERGE_REQUEST_DIFF_BASE_SHA: 'b4se',
      }),
    ),
  ).toEqual({ trusted: true, base: 'b4se' })
})

it('off GitLab CI it declines; with cacheScope: false it names nothing; an unknown option is refused', async () => {
  expect(await branchOf({ CI_PROJECT_PATH: 'a/b', CI_COMMIT_REF_NAME: 'feat' })).toBe('declined')
  expect(await branchOf(job('feat-x'), { cacheScope: false })).toEqual({})
  expect(
    branchOf(job('feat-x'), { cachescope: true } as Parameters<typeof gitlab>[0]),
  ).rejects.toThrow('gitlab()')
})
