// `github()` sets the workspace's `cacheScope` from the Actions ref: the
// default branch stays trusted, a PR and any other ref get their own scope.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import type { WorkspaceConfig } from '@vzn/vx'
import { github } from '../src/index.js'

let dir: string
let eventPath: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-gh-scope-'))
  eventPath = path.join(dir, 'event.json')
  await writeFile(eventPath, JSON.stringify({ repository: { default_branch: 'main' } }))
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const ACTIONS_KEYS = [
  'GITHUB_ACTIONS',
  'GITHUB_REF',
  'GITHUB_REF_NAME',
  'GITHUB_EVENT_PATH',
  'GITHUB_EVENT_NAME',
]

async function scopeOf(
  env: Record<string, string>,
  workspace: WorkspaceConfig = {},
  options: Parameters<typeof github>[0] = {},
): Promise<string | undefined> {
  const saved = ACTIONS_KEYS.map((k) => [k, process.env[k]] as const)
  for (const k of ACTIONS_KEYS) delete process.env[k]
  Object.assign(process.env, env)
  try {
    await github(options).config!(workspace, { workspaceRoot: dir, warn: () => {} })
    return workspace.cacheScope
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const actions = (ref: string, name: string): Record<string, string> => ({
  GITHUB_ACTIONS: 'true',
  GITHUB_REF: ref,
  GITHUB_REF_NAME: name,
  GITHUB_EVENT_PATH: eventPath,
})

it('a push to the default branch stays trusted', async () => {
  expect(await scopeOf(actions('refs/heads/main', 'main'))).toBeUndefined()
})

it('a pull request writes to its own scope', async () => {
  expect(await scopeOf(actions('refs/pull/42/merge', '42/merge'))).toBe('pr-42')
})

it('another branch or tag writes to its own scope', async () => {
  expect(await scopeOf(actions('refs/heads/feat/x', 'feat/x'))).toBe('ref-feat/x')
  expect(await scopeOf(actions('refs/tags/v1.0', 'v1.0'))).toBe('ref-v1.0')
  expect(await scopeOf(actions('refs/heads/a+b', 'a+b'))).toBe('ref-a_b')
})

// These events run with the default branch's ref on a PR's behalf; a
// workflow that checks out the PR's head there wrote the trusted keys.
it("an event that runs in main's context for a pull request is the PR's", async () => {
  const on = async (name: string, payload: unknown): Promise<string | undefined> => {
    const file = path.join(dir, `${name}-${Math.random()}.json`)
    await writeFile(
      file,
      JSON.stringify({ repository: { default_branch: 'main' }, ...(payload as object) }),
    )
    return scopeOf({
      ...actions('refs/heads/main', 'main'),
      GITHUB_EVENT_PATH: file,
      GITHUB_EVENT_NAME: name,
    })
  }
  expect([
    await on('pull_request_target', { pull_request: { number: 7 } }),
    await on('pull_request_target', {}),
    await on('issue_comment', { issue: { number: 9, pull_request: { url: 'x' } } }),
    await on('workflow_run', {
      workflow_run: { event: 'pull_request', pull_requests: [{ number: 5 }] },
    }),
    await on('workflow_run', { workflow_run: { event: 'pull_request', pull_requests: [] } }),
    // CONTROLS: the same events with no PR behind them stay trusted.
    await on('issue_comment', { issue: { number: 9 } }),
    await on('workflow_run', { workflow_run: { event: 'push', pull_requests: [] } }),
    await on('push', {}),
  ]).toEqual(['pr-7', 'pr-target', 'pr-9', 'pr-5', 'pr-target', undefined, undefined, undefined])
})

it('an unknown default branch is not trusted', async () => {
  expect(
    await scopeOf({
      ...actions('refs/heads/main', 'main'),
      GITHUB_EVENT_PATH: path.join(dir, 'none'),
    }),
  ).toBe('ref-main')
})

it('outside Actions, a declared scope, or cacheScope: false changes nothing', async () => {
  expect(await scopeOf({ GITHUB_REF: 'refs/pull/1/merge' })).toBeUndefined()
  expect(await scopeOf(actions('refs/pull/1/merge', '1/merge'), { cacheScope: 'trusted' })).toBe(
    'trusted',
  )
  expect(
    await scopeOf(actions('refs/pull/1/merge', '1/merge'), {}, { cacheScope: false }),
  ).toBeUndefined()
})
