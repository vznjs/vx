import path from 'node:path'

const WORKSPACE_FINGERPRINT_FILES = ['pnpm-lock.yaml', 'pnpm-workspace.yaml']

/**
 * One hash for the workspace as a whole, derived from `pnpm-lock.yaml`
 * and `pnpm-workspace.yaml`. Folded into every task's cache key so a
 * `pnpm update` (lockfile change) or a workspace-shape change
 * invalidates every cached entry. Coarse but correct.
 */
export async function computeWorkspaceFingerprint(workspaceRoot: string): Promise<string> {
  const h = new Bun.CryptoHasher('sha256')
  for (const f of WORKSPACE_FINGERPRINT_FILES) {
    const full = path.join(workspaceRoot, f)
    const file = Bun.file(full)
    if (!(await file.exists())) continue
    h.update(`${f}\0`)
    h.update(await file.bytes())
    h.update('\n')
  }
  return h.digest('hex')
}
