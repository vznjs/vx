import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * Walk upward from `start` looking for a workspace marker. Returns the
 * first directory that has either `pnpm-workspace.yaml`, a `package.json`
 * declaring `workspaces`, or (lowest priority) any `package.json`.
 *
 * Returns `null` when no marker is found before the filesystem root.
 */
export async function findWorkspaceRoot(start: string): Promise<string | null> {
  let current = isAbsolute(start) ? start : resolve(start)
  let firstPkgJsonDir: string | null = null

  while (true) {
    const pnpm = join(current, 'pnpm-workspace.yaml')
    if (await Bun.file(pnpm).exists()) return current

    const pkgPath = join(current, 'package.json')
    if (await Bun.file(pkgPath).exists()) {
      try {
        const pkg = (await Bun.file(pkgPath).json()) as { workspaces?: unknown }
        if (pkg.workspaces) return current
      } catch {
        // fall through
      }
      if (firstPkgJsonDir === null) firstPkgJsonDir = current
    }

    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return firstPkgJsonDir
}
