import { createJiti } from 'jiti'
import type { ProjectConfig } from '@nxt/config'

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
})

export async function loadProjectConfig(configPath: string): Promise<ProjectConfig> {
  const mod = (await jiti.import(configPath, { default: true })) as ProjectConfig | undefined
  if (!mod || typeof mod !== 'object') {
    throw new Error(`Project config at ${configPath} did not export a default object`)
  }
  return mod
}
