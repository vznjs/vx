// Detect the package manager in use for a workspace. Backed by
// `package-manager-detector` (antfu/co.), which inspects the lockfile,
// `packageManager` field, and devEngines per a configurable strategy.

import { detect } from 'package-manager-detector/detect'
import type { AgentName, Agent } from 'package-manager-detector'

export type { AgentName, Agent } from 'package-manager-detector'

export interface PackageManagerInfo {
  /** e.g. 'pnpm', 'npm', 'yarn', 'bun', 'deno'. */
  name: AgentName
  /** Agent specifier, e.g. 'yarn@berry', 'pnpm@6'. May equal `name`. */
  agent: Agent
  /** Version pinned via `packageManager` field, if any. */
  version: string | undefined
}

/**
 * Detect the workspace's package manager. Returns `null` when there's
 * no signal (no lockfile, no packageManager field). Callers should
 * fall back to a reasonable default — we lean on Bun since we require
 * it.
 */
export async function detectPackageManager(cwd: string): Promise<PackageManagerInfo | null> {
  const r = await detect({ cwd })
  if (!r) return null
  return { name: r.name, agent: r.agent, version: r.version }
}
