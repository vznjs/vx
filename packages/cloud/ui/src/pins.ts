// Reactive layer over the persisted pinned-projects set (api.ts). One
// module-scope signal so every surface (projects table stars, project-detail
// star, Runs strip, notification bell) updates together on a toggle. Readers
// that must react to an org/workspace switch key their memos on
// getConnectionKey() — the persistence itself is already per-connection.

import { createSignal } from 'solid-js'
import { getPinnedProjects, setPinnedProjects } from './api.ts'

const [bump, setBump] = createSignal(0)

/** The current connection's pinned projects (reactive). */
export function pinnedProjects(): string[] {
  void bump()
  return getPinnedProjects()
}

export function isPinned(project: string): boolean {
  return pinnedProjects().includes(project)
}

export function togglePin(project: string): void {
  const cur = getPinnedProjects()
  setPinnedProjects(cur.includes(project) ? cur.filter((p) => p !== project) : [...cur, project])
  setBump((n) => n + 1)
}
