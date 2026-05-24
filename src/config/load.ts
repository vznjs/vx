import { join } from 'node:path'
import type { LoadConfigs, LoadedConfig, ProjectConfig } from './types.ts'

const CONFIG_FILES = ['vx.config.ts', 'vx.config.mts', 'vx.config.js', 'vx.config.mjs'] as const

export const loadConfigs: LoadConfigs = async (sources) => {
  const results = await Promise.all(
    sources.map(async (source): Promise<LoadedConfig | null> => {
      const path = await findConfigPath(source.dir)
      if (path === null) return null
      const mod = await import(path)
      return { source, config: mod.default as ProjectConfig }
    }),
  )
  return results.filter((r): r is LoadedConfig => r !== null)
}

async function findConfigPath(dir: string): Promise<string | null> {
  for (const name of CONFIG_FILES) {
    const candidate = join(dir, name)
    if (await Bun.file(candidate).exists()) return candidate
  }
  return null
}
