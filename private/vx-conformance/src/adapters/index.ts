import type { Adapter } from '../adapter.ts'
import { nx } from './nx.ts'
import { turbo } from './turbo.ts'
import { viteTask } from './vite-task.ts'
import { vx } from './vx.ts'

export const ADAPTERS: Adapter[] = [vx, turbo, nx, viteTask]
