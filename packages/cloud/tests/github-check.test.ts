// The GitHub Checks emitter: target resolution (Actions-only, token = opt-in,
// PR head SHA from the event payload) and the never-fail check-run POST.

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RunSummaryRecord, TaskTelemetry } from '@vzn/vx'
import {
  githubCheckCandidate,
  postGithubCheck,
  resolveGithubCheckTarget,
} from '../src/github-check.js'

function summary(
  tasks: Partial<TaskTelemetry>[],
  over: Partial<RunSummaryRecord> = {},
): RunSummaryRecord {
  const full = tasks.map(
    (t): TaskTelemetry => ({
      taskId: t.taskId ?? 'p#build',
      project: (t.taskId ?? 'p#build').split('#')[0]!,
      task: (t.taskId ?? 'p#build').split('#')[1]!,
      status: t.status ?? 'success',
      cacheSource: t.cacheSource ?? 'miss',
      exitCode: t.exitCode ?? 0,
      durationMs: t.durationMs ?? 1000,
    }),
  )
  return {
    v: 2,
    run: {
      runId: 'r',
      vxVersion: '0',
      workspaceId: 'ws',
      workspaceName: 'w',
      command: 'vx run ci',
      requestedTasks: ['ci'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 4,
      flow: null,
      commitSha: null,
      branch: null,
      dirty: null,
      ci: true,
      ciProvider: 'github',
      host: null,
      os: 'linux',
      arch: 'x64',
      tags: {},
    },
    startedAt: 0,
    endedAt: 1000,
    totalDurationMs: 1000,
    taskCount: full.length,
    failedCount: full.filter((t) => t.status === 'failed').length,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: full.every((t) => t.status !== 'failed'),
    tasks: full,
    ...over,
  }
}

const GHA_ENV = {
  GITHUB_ACTIONS: 'true',
  GITHUB_TOKEN: 'tok',
  GITHUB_REPOSITORY: 'acme/mono',
  GITHUB_SHA: 'merge-sha',
}

describe('githubCheckCandidate', () => {
  it('requires Actions + token + repo + sha, all present', () => {
    expect(githubCheckCandidate(GHA_ENV)).toBe(true)
    expect(githubCheckCandidate({ ...GHA_ENV, GITHUB_ACTIONS: undefined })).toBe(false)
    expect(githubCheckCandidate({ ...GHA_ENV, GITHUB_TOKEN: '' })).toBe(false)
    expect(githubCheckCandidate({ ...GHA_ENV, GITHUB_REPOSITORY: undefined })).toBe(false)
    expect(githubCheckCandidate({ ...GHA_ENV, GITHUB_SHA: '' })).toBe(false)
  })

  it('VX_GITHUB_CHECK=0/false disables', () => {
    expect(githubCheckCandidate({ ...GHA_ENV, VX_GITHUB_CHECK: '0' })).toBe(false)
    expect(githubCheckCandidate({ ...GHA_ENV, VX_GITHUB_CHECK: 'false' })).toBe(false)
  })
})

describe('resolveGithubCheckTarget', () => {
  it('prefers the PR head SHA from the event payload over GITHUB_SHA', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-ghc-'))
    try {
      const eventPath = path.join(dir, 'event.json')
      writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { sha: 'head-sha' } } }))
      const t = await resolveGithubCheckTarget({ ...GHA_ENV, GITHUB_EVENT_PATH: eventPath })
      expect(t?.headSha).toBe('head-sha')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to GITHUB_SHA on push events and malformed payloads', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-ghc-'))
    try {
      const pushEvent = path.join(dir, 'push.json')
      writeFileSync(pushEvent, JSON.stringify({ ref: 'refs/heads/main' }))
      expect(
        (await resolveGithubCheckTarget({ ...GHA_ENV, GITHUB_EVENT_PATH: pushEvent }))?.headSha,
      ).toBe('merge-sha')
      const broken = path.join(dir, 'broken.json')
      writeFileSync(broken, 'not json')
      expect(
        (await resolveGithubCheckTarget({ ...GHA_ENV, GITHUB_EVENT_PATH: broken }))?.headSha,
      ).toBe('merge-sha')
      expect((await resolveGithubCheckTarget(GHA_ENV))?.headSha).toBe('merge-sha')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the check from the command, VX_GITHUB_CHECK_NAME winning', async () => {
    expect((await resolveGithubCheckTarget(GHA_ENV, 'vx run ci'))?.name).toBe('vx run ci')
    expect((await resolveGithubCheckTarget(GHA_ENV))?.name).toBe('vx run')
    expect(
      (await resolveGithubCheckTarget({ ...GHA_ENV, VX_GITHUB_CHECK_NAME: 'ci gate' }, 'vx run ci'))
        ?.name,
    ).toBe('ci gate')
  })

  it('defaults the API url and strips a trailing slash from an override', async () => {
    expect((await resolveGithubCheckTarget(GHA_ENV))?.apiUrl).toBe('https://api.github.com')
    expect(
      (await resolveGithubCheckTarget({ ...GHA_ENV, GITHUB_API_URL: 'https://ghe.local/api/v3/' }))
        ?.apiUrl,
    ).toBe('https://ghe.local/api/v3')
  })

  it('resolves nothing outside Actions', async () => {
    expect(await resolveGithubCheckTarget({ GITHUB_TOKEN: 'tok' })).toBeUndefined()
  })
})

interface CheckRunBody {
  name: string
  head_sha: string
  status: string
  conclusion: string
  output: { title: string; summary: string }
}

/** A stub GitHub API capturing the check-run POST. */
function stubApi(status = 201): {
  server: ReturnType<typeof Bun.serve>
  requests: { path: string; auth: string | null; body: CheckRunBody }[]
} {
  const requests: { path: string; auth: string | null; body: CheckRunBody }[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      requests.push({
        path: new URL(req.url).pathname,
        auth: req.headers.get('authorization'),
        body: (await req.json()) as CheckRunBody,
      })
      return new Response(status === 201 ? '{"id":1}' : '{"message":"nope"}', { status })
    },
  })
  return { server, requests }
}

const targetFor = (server: ReturnType<typeof Bun.serve>) => ({
  apiUrl: `http://localhost:${server.port}`,
  repo: 'acme/mono',
  headSha: 'head-sha',
  token: 'tok',
  name: 'vx run ci',
})

describe('postGithubCheck', () => {
  it('creates a completed check run with the summary table as output', async () => {
    const { server, requests } = stubApi()
    try {
      const warns: string[] = []
      await postGithubCheck(
        targetFor(server),
        summary([{ taskId: 'a#build' }, { taskId: 'b#test', status: 'failed', exitCode: 2 }]),
        (m) => warns.push(m),
      )
      expect(warns).toEqual([])
      expect(requests).toHaveLength(1)
      const r = requests[0]!
      expect(r.path).toBe('/repos/acme/mono/check-runs')
      expect(r.auth).toBe('Bearer tok')
      expect(r.body.name).toBe('vx run ci')
      expect(r.body.head_sha).toBe('head-sha')
      expect(r.body.status).toBe('completed')
      expect(r.body.conclusion).toBe('failure') // one task failed
      expect(r.body.output.title).toContain('failed — 1 of 2 tasks')
      expect(r.body.output.summary).toContain('`b#test`')
      expect(r.body.output.summary).toContain('❌ failed (exit 2)')
    } finally {
      await server.stop()
    }
  })

  it('maps a clean run to conclusion success', async () => {
    const { server, requests } = stubApi()
    try {
      await postGithubCheck(targetFor(server), summary([{ taskId: 'a#build' }]), () => {})
      expect(requests[0]!.body.conclusion).toBe('success')
      expect(requests[0]!.body.output.title).toContain('passed')
    } finally {
      await server.stop()
    }
  })

  it('warns with the permissions hint on 403 and never throws', async () => {
    const { server } = stubApi(403)
    try {
      const warns: string[] = []
      await postGithubCheck(targetFor(server), summary([{}]), (m) => warns.push(m))
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('403')
      expect(warns[0]).toContain('checks: write')
    } finally {
      await server.stop()
    }
  })

  it('swallows a network error (unreachable API) with a warning', async () => {
    const warns: string[] = []
    await postGithubCheck(
      { ...targetFor({ port: 1 } as ReturnType<typeof Bun.serve>), apiUrl: 'http://127.0.0.1:1' },
      summary([{}]),
      (m) => warns.push(m),
    )
    expect(warns).toHaveLength(1)
  })
})
