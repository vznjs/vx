import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Cache } from '../src/cache/index.js'
import { handleMcpRequest, listMcpTools, parseMcpArgs, setMcpContext } from '../src/cli/index.js'

describe('parseMcpArgs', () => {
  it('defaults to stdio with no flags', () => {
    expect(parseMcpArgs([])).toEqual({ transport: 'stdio' })
  })

  it('accepts the explicit --stdio flag', () => {
    expect(parseMcpArgs(['--stdio'])).toEqual({ transport: 'stdio' })
  })

  it('rejects --http with a clear UserError', () => {
    expect(() => parseMcpArgs(['--http'])).toThrow(/not yet implemented/)
  })

  it('rejects unknown flags', () => {
    expect(() => parseMcpArgs(['--unknown'])).toThrow(/unknown flag/)
  })
})

describe('listMcpTools', () => {
  it('exposes the inspector RPCs as MCP tools', () => {
    const tools = listMcpTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['explainCacheKey', 'getCacheStats', 'getRunHistory', 'whyDidThisRerun'])
  })

  it('every tool declares an inputSchema and description', () => {
    for (const t of listMcpTools()) {
      expect(typeof t.description).toBe('string')
      expect(t.description.length).toBeGreaterThan(10)
      expect(typeof t.inputSchema).toBe('object')
    }
  })
})

describe('handleMcpRequest — against a real workspace + cache.db', () => {
  // The MCP context lets handlers see a known workspace root so we
  // don't depend on the test runner's cwd.
  function setupWorkspace(): { root: string; cleanup: () => void } {
    const root = mkdtempSync(path.join(tmpdir(), 'vx-mcp-real-'))
    Bun.write(path.join(root, 'package.json'), JSON.stringify({ name: 'r', workspaces: ['pkg'] }))
    // .vx/cache is what resolveCacheDir produces by default
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
  }

  function seedCacheWithRun(root: string): void {
    const cache = new Cache(path.join(root, '.vx', 'cache'))
    cache.recordRun({
      hash: 'h1',
      project: 'pkg',
      task: 'build',
      status: 'success',
      exitCode: 0,
      durationMs: 100,
      forwardArgs: [],
      startedAt: Date.now() - 1000,
      endedAt: Date.now() - 900,
      runId: 'r-1',
      cpuMs: 50,
      peakRssBytes: 1024,
      wallclockStartNs: 0n,
      wallclockEndNs: 100n * 1_000_000n,
      cacheHit: false,
    })
    cache.recordRun({
      hash: 'h2',
      project: 'pkg',
      task: 'build',
      status: 'cache-hit', // Cache.stats() counts hits by status, not cacheHit
      exitCode: 0,
      durationMs: 80,
      forwardArgs: [],
      startedAt: Date.now() - 500,
      endedAt: Date.now() - 420,
      runId: 'r-2',
      cpuMs: 50,
      peakRssBytes: 1024,
      wallclockStartNs: 0n,
      wallclockEndNs: 80n * 1_000_000n,
      cacheHit: true,
    })
    cache.close()
  }

  it('getCacheStats returns real entry/run/hit counts', async () => {
    const { root, cleanup } = setupWorkspace()
    seedCacheWithRun(root)
    setMcpContext({ workspaceRoot: root })
    try {
      const result = (await handleMcpRequest('getCacheStats', {})) as {
        entryCount: number
        totalBytes: number
        runCountLast24h: number
        hitCountLast24h: number
        hitRate24h: number
      }
      expect(result.runCountLast24h).toBe(2)
      expect(result.hitCountLast24h).toBe(1)
      expect(result.hitRate24h).toBeCloseTo(0.5)
    } finally {
      setMcpContext({})
      cleanup()
    }
  })

  it('getRunHistory returns recent runs + per-task aggregates', async () => {
    const { root, cleanup } = setupWorkspace()
    seedCacheWithRun(root)
    setMcpContext({ workspaceRoot: root })
    try {
      const result = (await handleMcpRequest('getRunHistory', { limit: 10 })) as {
        runs: Array<{ project: string; task: string }>
        history: unknown[]
      }
      expect(result.runs.length).toBeGreaterThan(0)
      expect(result.runs[0]!.project).toBe('pkg')
      expect(result.runs[0]!.task).toBe('build')
      expect(result.history.length).toBeGreaterThan(0)
    } finally {
      setMcpContext({})
      cleanup()
    }
  })

  it('explainCacheKey rejects malformed taskId', async () => {
    await expect(handleMcpRequest('explainCacheKey', {})).rejects.toThrow(/taskId/)
    await expect(handleMcpRequest('explainCacheKey', { taskId: 'no-hash' })).rejects.toThrow(
      /project#task/,
    )
  })

  it('explainCacheKey returns persisted entry metadata when present', async () => {
    const { root, cleanup } = setupWorkspace()
    seedCacheWithRun(root)
    setMcpContext({ workspaceRoot: root })
    try {
      const ok = (await handleMcpRequest('explainCacheKey', { taskId: 'pkg#build' })) as {
        taskId: string
        project: string
        task: string
        latestEntry: unknown
      }
      expect(ok.taskId).toBe('pkg#build')
      expect(ok.project).toBe('pkg')
      expect(ok.task).toBe('build')
    } finally {
      setMcpContext({})
      cleanup()
    }
  })

  it('whyDidThisRerun compares two adjacent runs', async () => {
    const { root, cleanup } = setupWorkspace()
    seedCacheWithRun(root)
    setMcpContext({ workspaceRoot: root })
    try {
      const result = (await handleMcpRequest('whyDidThisRerun', {
        runId: 'r-2',
        taskId: 'pkg#build',
      })) as {
        found?: boolean
        thisRun?: { hash: string }
        previousRun?: { hash: string } | null
        hashChanged?: boolean | null
      }
      expect(result.thisRun?.hash).toBe('h2')
      expect(result.previousRun?.hash).toBe('h1')
      expect(result.hashChanged).toBe(true)
    } finally {
      setMcpContext({})
      cleanup()
    }
  })

  it('whyDidThisRerun rejects bad args', async () => {
    await expect(handleMcpRequest('whyDidThisRerun', { runId: 'r1' })).rejects.toThrow(/runId/)
  })

  it('rejects unknown tool names', async () => {
    await expect(handleMcpRequest('notATool', {})).rejects.toThrow(/unknown tool/)
  })
})
