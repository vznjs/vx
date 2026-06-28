// Where a running `vx-cloud serve` advertises itself, and helpers to read it.
//
// MACHINE-LEVEL (per-user), NOT per-workspace. The earlier design wrote this to
// `<workspaceRoot>/.vx/serve.json`, so a `vx run` only discovered the serve when
// it shared that exact workspace root — nothing guaranteed discovery from any
// other workspace. Now there is ONE per-user advertisement: a `vx run` in ANY
// workspace finds the local serve, and the deterministic serve port means there
// is only ever one local serve to find. A remote/Docker serve is NOT advertised
// here — that case uses an explicit VX_CLOUD_INGEST_URL / VX_SERVICE_URL, which
// always wins over auto-detect.
//
// Light by design (only node:fs/os/path) so `plugin.ts` — imported via the
// lean `@vzn/vx-cloud/plugin` subpath — can read it without pulling the service
// layer.

import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface ServeInfo {
  origin: string
  pid: number
}

/**
 * Path to the serve advertisement file. `VX_CLOUD_SERVE_INFO` pins an exact
 * path (escape hatch + used by tests). Otherwise it lives in the per-user
 * runtime dir — `$XDG_RUNTIME_DIR/vx-cloud/` when set (auto-cleared on logout,
 * so no stale files survive a session), else a per-uid temp subdir so a
 * multi-user machine never collides on one shared file.
 */
export function serveInfoPath(): string {
  const override = process.env['VX_CLOUD_SERVE_INFO']
  if (override !== undefined && override !== '') return override
  const xdg = process.env['XDG_RUNTIME_DIR']
  const base =
    xdg !== undefined && xdg !== ''
      ? path.join(xdg, 'vx-cloud')
      : path.join(os.tmpdir(), `vx-cloud-${userTag()}`)
  return path.join(base, 'serve.json')
}

function userTag(): string {
  try {
    return String(process.getuid?.() ?? 'user')
  } catch {
    return 'user'
  }
}

/** Read + validate the advertisement, or undefined if absent/unparseable. */
export function readServeInfo(): ServeInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(serveInfoPath(), 'utf8')) as {
      origin?: unknown
      pid?: unknown
    }
    if (typeof info.origin === 'string' && info.origin.length > 0 && typeof info.pid === 'number') {
      return { origin: info.origin, pid: info.pid }
    }
  } catch {
    // no file / unparseable → not advertised
  }
  return undefined
}

/**
 * Whether a local pid is alive — used to ignore a stale advertisement left by a
 * serve that died without cleaning up (a crash, SIGKILL). EPERM means the
 * process exists but we can't signal it → still alive.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
