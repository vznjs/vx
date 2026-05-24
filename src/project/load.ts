import { join } from 'node:path'

export async function loadProject(dir: string): Promise<unknown> {
  const mod = await import(join(dir, 'vx.config'))
  return mod.default
}
