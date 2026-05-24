import { join } from 'node:path'
import { findWorkspaceDir } from 'pkg-types'
import { z } from 'zod'

const WorkspaceSchema = z.strictObject({})

export type Workspace = z.infer<typeof WorkspaceSchema>

export async function loadWorkspace(root: string): Promise<Workspace> {
  const mod = await import(join(root, 'vx.workspace'))
  return validateWorkspace(mod.default)
}

export function validateWorkspace(input: unknown): Workspace {
  return WorkspaceSchema.parse(input)
}

export function defineWorkspace<T extends Workspace>(workspace: T): T {
  return workspace
}

export async function findWorkspaceRoot(start: string): Promise<string> {
  return findWorkspaceDir(start)
}
