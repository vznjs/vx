// `vx insights serve` — boot the local SPA + static cache.db server.
// The SPA (apps/insights) is a Solid + DuckDB-WASM client that reads
// the workspace's cache.db directly. This command runs two things in
// foreground: (1) Vite dev for the SPA, (2) a tiny static HTTP server
// that exposes cache.db so the browser can fetch it. Ctrl-C stops both.

import path from 'node:path'
import { existsSync } from 'node:fs'
import { findWorkspaceRoot, loadWorkspaceConfig, resolveCacheDir } from '../workspace/index.js'
import { UserError } from '../util/index.js'

interface InsightsArgs {
  port: number
  error?: string
}

export function parseInsightsArgs(args: readonly string[]): InsightsArgs {
  const out: InsightsArgs = { port: 5290 }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--port' || a === '-p') {
      const v = args[++i]
      const n = Number(v)
      if (v === undefined || !Number.isInteger(n) || n < 1 || n > 65535) {
        return { ...out, error: `invalid --port: ${v}` }
      }
      out.port = n
    } else if (a?.startsWith('--port=')) {
      const v = a.slice('--port='.length)
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return { ...out, error: `invalid --port: ${v}` }
      }
      out.port = n
    } else {
      return { ...out, error: `unknown flag: ${a}` }
    }
  }
  return out
}

/**
 * Resolve apps/insights/ relative to the running binary. Mirrors the
 * apps/docs pattern: the SPA's source lives in the vx repo, even when the
 * compiled binary is installed elsewhere. `VX_INSIGHTS_DIR` lets a user
 * point at a custom checkout.
 */
function resolveInsightsDir(): string {
  const env = process.env.VX_INSIGHTS_DIR
  if (env !== undefined && env.length > 0) return env
  // import.meta.dir is src/cli when running from source, irrelevant when
  // compiled. We resolve via the repo root: vx is shipped from this repo,
  // so apps/insights/ sits alongside the running source tree.
  return path.resolve(import.meta.dir, '..', '..', 'apps', 'insights')
}

function ensureScaffoldPresent(insightsDir: string): void {
  if (!existsSync(path.join(insightsDir, 'package.json'))) {
    throw new UserError(
      `vx insights: SPA source not found at ${insightsDir}. ` +
        'Set VX_INSIGHTS_DIR to point at a vx checkout, or rebuild the binary from a tree containing apps/insights/.',
    )
  }
}

interface RunningServers {
  staticPort: number
  cacheDbPath: string
  stop: () => Promise<void>
}

/**
 * Tiny static server: exposes cache.db read-only at /cache.db. The SPA
 * fetches it once and hands the bytes to DuckDB-WASM for in-browser
 * querying. We deliberately do NOT proxy queries — analytics stays
 * client-side per the design.
 */
function startStaticServer(cacheDbPath: string): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/cache.db') {
        const file = Bun.file(cacheDbPath)
        return new Response(file, {
          headers: {
            'content-type': 'application/vnd.sqlite3',
            'access-control-allow-origin': '*',
            'cache-control': 'no-store',
          },
        })
      }
      if (url.pathname === '/health') return new Response('ok')
      return new Response('not found', { status: 404 })
    },
  })
  return { port: server.port, stop: () => server.stop() }
}

async function startSpa(
  insightsDir: string,
  port: number,
  cacheDbUrl: string,
): Promise<{ stop: () => Promise<void> }> {
  const child = Bun.spawn({
    cmd: ['bun', 'run', 'dev', '--', '--port', String(port)],
    cwd: insightsDir,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, VITE_CACHE_DB_URL: cacheDbUrl },
  })
  return {
    stop: async () => {
      try {
        child.kill()
        await child.exited
      } catch {
        // already gone
      }
    },
  }
}

async function startServers(workspaceRoot: string, port: number): Promise<RunningServers> {
  const config = await loadWorkspaceConfig(workspaceRoot)
  const cacheDir = resolveCacheDir(workspaceRoot, config)
  const cacheDbPath = path.join(cacheDir, 'cache.db')

  if (!existsSync(cacheDbPath)) {
    throw new UserError(
      `vx insights: no cache.db found at ${cacheDbPath}. ` +
        'Run `vx run <task>` at least once to populate it.',
    )
  }

  const insightsDir = resolveInsightsDir()
  ensureScaffoldPresent(insightsDir)

  const stat = startStaticServer(cacheDbPath)
  const cacheDbUrl = `http://127.0.0.1:${stat.port}/cache.db`
  const spa = await startSpa(insightsDir, port, cacheDbUrl)

  return {
    staticPort: stat.port,
    cacheDbPath,
    stop: async () => {
      stat.stop()
      await spa.stop()
    },
  }
}

export async function insightsCmd(args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args
  if (sub === undefined || sub === 'serve') {
    const subArgs = sub === 'serve' ? rest : args
    const parsed = parseInsightsArgs(subArgs)
    if (parsed.error !== undefined) {
      process.stderr.write(`vx insights: ${parsed.error}\n`)
      return 1
    }
    const root = await findWorkspaceRoot(process.cwd())
    let servers: RunningServers
    try {
      servers = await startServers(root, parsed.port)
    } catch (err) {
      const msg = err instanceof UserError || err instanceof Error ? err.message : String(err)
      process.stderr.write(`vx insights: ${msg}\n`)
      return 1
    }
    process.stdout.write(
      `vx insights: SPA on http://127.0.0.1:${parsed.port}\n` +
        `vx insights: serving cache.db from ${servers.cacheDbPath} (port ${servers.staticPort})\n` +
        '(press Ctrl-C to stop)\n\n',
    )
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve())
      process.once('SIGTERM', () => resolve())
    })
    await servers.stop()
    process.stdout.write('\nvx insights: stopped\n')
    return 0
  }
  process.stderr.write(`vx insights: unknown subcommand: ${sub}\n`)
  return 1
}
