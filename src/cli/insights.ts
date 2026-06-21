// `vx insights` — boot the local insights SPA pointed at a local `vx serve`.
//
// The SPA (apps/insights) is a Solid client that reads cache.db via the
// HTTP /v1/* surface vx serve exposes. This command runs two things in
// foreground: (1) vx serve, the same backend used everywhere, (2) the
// Vite dev server for the SPA with VITE_DEFAULT_ORIGIN pointed at the
// server's origin. Ctrl-C stops both.

import path from 'node:path'
import { existsSync } from 'node:fs'
import { findWorkspaceRoot } from '../workspace/index.js'
import { UserError } from '../util/index.js'
import { startServe } from './serve.js'

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

async function startSpa(
  insightsDir: string,
  port: number,
  defaultOrigin: string,
): Promise<{ stop: () => Promise<void> }> {
  const child = Bun.spawn({
    cmd: ['bun', 'run', 'dev', '--', '--port', String(port)],
    cwd: insightsDir,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, VITE_DEFAULT_ORIGIN: defaultOrigin },
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
    const insightsDir = resolveInsightsDir()
    try {
      ensureScaffoldPresent(insightsDir)
    } catch (err) {
      const msg = err instanceof UserError || err instanceof Error ? err.message : String(err)
      process.stderr.write(`vx insights: ${msg}\n`)
      return 1
    }

    // Boot vx serve — the same backend that powers everything else. The
    // SPA talks to it via /v1/* HTTP routes.
    const server = await startServe({ root })
    const spa = await startSpa(insightsDir, parsed.port, server.origin)

    process.stdout.write(
      `vx insights: SPA on http://127.0.0.1:${parsed.port}\n` +
        `vx insights: API   on ${server.origin}\n` +
        '(press Ctrl-C to stop)\n\n',
    )
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve())
      process.once('SIGTERM', () => resolve())
    })
    await spa.stop()
    await server.stop()
    process.stdout.write('\nvx insights: stopped\n')
    return 0
  }
  process.stderr.write(`vx insights: unknown subcommand: ${sub}\n`)
  return 1
}
