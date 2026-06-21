import { describe, expect, it } from 'bun:test'
import { handleMcpRequest, listMcpTools, parseMcpArgs } from '../src/cli/index.js'

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

describe('handleMcpRequest', () => {
  it('dispatches getCacheStats', async () => {
    const result = await handleMcpRequest('getCacheStats', {})
    expect(typeof result).toBe('object')
  })

  it('dispatches getRunHistory with a custom limit', async () => {
    const result = await handleMcpRequest('getRunHistory', { limit: 25 })
    expect(result.requestedLimit).toBe(25)
  })

  it('explainCacheKey requires a string taskId', async () => {
    await expect(handleMcpRequest('explainCacheKey', {})).rejects.toThrow(/taskId/)
    const ok = await handleMcpRequest('explainCacheKey', { taskId: 'pkg#build' })
    expect(ok.taskId).toBe('pkg#build')
  })

  it('whyDidThisRerun requires runId and taskId', async () => {
    await expect(handleMcpRequest('whyDidThisRerun', { runId: 'r1' })).rejects.toThrow(/runId/)
    const ok = await handleMcpRequest('whyDidThisRerun', { runId: 'r1', taskId: 'pkg#test' })
    expect(ok.runId).toBe('r1')
    expect(ok.taskId).toBe('pkg#test')
  })

  it('rejects unknown tool names', async () => {
    await expect(handleMcpRequest('notATool', {})).rejects.toThrow(/unknown tool/)
  })
})
