import { createJiti } from 'jiti'
import type { ProjectConfig } from './config.js'

// jiti handles every supported extension (.ts/.mts/.cts/.js/.mjs/.cjs) with
// `moduleCache: false`, so edits show up across repeated calls within a
// single process. We previously used native `import()` with an `?mtime=…`
// query for plain JS, but Bun ignores query strings on file: URLs and
// returns the cached module — so jiti is the portable choice.
// `interopDefault: false` matters: with it on, jiti synthesizes a fake
// `.default` (the namespace itself) for sources that have no real default
// export. We need to distinguish "user exported a default" from "no default
// was exported" to give a clear error.
const jiti = createJiti(import.meta.url, {
  interopDefault: false,
  moduleCache: false,
})

export async function loadProjectConfig(configPath: string): Promise<ProjectConfig> {
  const ns = (await jiti.import(configPath)) as { default?: unknown }
  const mod = ns?.default
  if (!mod || typeof mod !== 'object') {
    throw new Error(`Project config at ${configPath} did not export a default object`)
  }
  return mod as ProjectConfig
}
