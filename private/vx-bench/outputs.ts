import { rm } from 'node:fs/promises'
import path from 'node:path'

/** Removes every package's `dist/`, so the next warm run must restore it. */
export async function deleteDist(dir: string): Promise<void> {
  const jobs: Promise<void>[] = []
  for await (const rel of new Bun.Glob('packages/*/dist').scan({ cwd: dir, onlyFiles: false })) {
    jobs.push(rm(path.join(dir, rel), { recursive: true, force: true }))
  }
  await Promise.all(jobs)
}

/**
 * The packages whose build output is absent. A warm-restore rep that leaves
 * one missing was timed doing less than the row claims, so it is a failure.
 */
export async function missingDist(dir: string, file = 'index.js'): Promise<string[]> {
  const missing: string[] = []
  for await (const rel of new Bun.Glob('packages/*/package.json').scan({ cwd: dir })) {
    const pkg = path.dirname(rel)
    if (!(await Bun.file(path.join(dir, pkg, 'dist', file)).exists())) missing.push(pkg)
  }
  return missing.sort()
}
