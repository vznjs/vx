// searchDocs is `vx docs <query> --format json` through MCP: the CLI's own
// answer, and a query that would read as a flag is refused first.
import path from 'node:path'
import { expect, it } from 'bun:test'
import { handleToolCall } from '../src/tools.js'

const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')
const ctx = {
  cacheDir: path.join(import.meta.dir, '.vx', 'cache'),
  workspaceRoot: import.meta.dir,
  vx: [process.execPath, CORE_BIN],
}

it('answers what the CLI prints', async () => {
  const cli = JSON.parse(
    Bun.spawnSync({
      cmd: [process.execPath, CORE_BIN, 'docs', 'frozen lock', '--limit=2', '--format', 'json'],
      cwd: import.meta.dir,
    }).stdout.toString(),
  ) as { hits: unknown[] }
  expect(cli.hits).toHaveLength(2)
  expect(await handleToolCall('searchDocs', { query: 'frozen lock', limit: 2 }, ctx)).toEqual({
    exitCode: 0,
    docs: cli,
  })
})

it('refuses a query that reads as a flag, and a bad limit', async () => {
  await expect(handleToolCall('searchDocs', { query: '--limit' }, ctx)).rejects.toThrow(
    'searchDocs: query must be words to look for',
  )
  await expect(handleToolCall('searchDocs', { query: 'cache', limit: 0 }, ctx)).rejects.toThrow(
    'searchDocs: limit must be a whole number above 0',
  )
})
