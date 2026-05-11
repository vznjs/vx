import { stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import type { ProjectConfig } from './config.js'

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
})

export async function loadProjectConfig(configPath: string): Promise<ProjectConfig> {
  const ext = path.extname(configPath)
  const stats = await stat(configPath)

  let mod: unknown
  if (ext === '.mjs' || ext === '.js' || ext === '.cjs') {
    // Native import for plain JS. Cache-bust via mtime query so subsequent
    // calls in the same Node process see edits.
    const url = pathToFileURL(configPath)
    url.searchParams.set('mtime', String(stats.mtimeMs))
    const m = (await import(url.href)) as { default?: unknown }
    mod = m.default
  } else {
    // Let jiti handle .ts / .mts / .cts.
    mod = await jiti.import(configPath, { default: true })
  }

  if (!mod || typeof mod !== 'object') {
    throw new Error(`Project config at ${configPath} did not export a default object`)
  }
  return mod as ProjectConfig
}
