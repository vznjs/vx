// Test fixture helpers. Not part of the public API — the leading
// underscore in the folder name marks it as internal-only. Used by
// collocated *.test.ts files and the tests/e2e/ suite to build
// temporary on-disk workspaces.

import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

/**
 * Build a temporary workspace from a flat map of relative-path → contents.
 *
 * ```ts
 * const root = await makeWorkspaceAsync({
 *   'package.json': '{"name":"root","workspaces":["packages/*"]}',
 *   'packages/a/package.json': '{"name":"a"}',
 * })
 * ```
 *
 * Returns the absolute root path. Cleanup is intentionally skipped —
 * Bun's `tmpdir()` is on a tmpfs/cleaned per-boot on every platform we
 * support; not wiring teardown keeps tests trivially debuggable.
 */
export async function makeWorkspaceAsync(
  layout: Readonly<Record<string, string>>,
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'vx-test-'))
  await Promise.all(
    Object.entries(layout).map(async ([relPath, contents]) => {
      const full = join(root, relPath)
      mkdirSync(dirname(full), { recursive: true })
      await Bun.write(full, contents)
    }),
  )
  return root
}
