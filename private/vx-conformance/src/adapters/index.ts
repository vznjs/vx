import type { Adapter } from '../adapter.ts'
import { moon } from './moon.ts'
import { nix } from './nix.ts'
import { nx } from './nx.ts'
import { turbo } from './turbo.ts'
import { viteTask } from './vite-task.ts'
import { vx } from './vx.ts'

export const ADAPTERS: Adapter[] = [vx, turbo, nx, viteTask, nix, moon]
