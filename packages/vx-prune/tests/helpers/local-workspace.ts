import path from 'node:path'

/**
 * Source for a `vx.workspace.mjs` declaring this test's own plugins.
 * Running here and caching here are core's fallbacks, so a fixture that
 * wants neither needs no workspace file at all.
 *
 * Local to this package on purpose: a test may not read another project's
 * files, and the sandbox enforces it.
 */
export function localWorkspaceSource(extra: readonly string[] = [], prelude = ''): string {
  return `${prelude}
export default { plugins: [${extra.join(', ')}] }
`
}

export async function writeLocalWorkspace(root: string): Promise<void> {
  await Bun.write(path.join(root, 'vx.workspace.mjs'), localWorkspaceSource())
}
