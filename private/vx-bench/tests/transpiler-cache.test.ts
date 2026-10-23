// Bun's transpiler cache writes under HOME, which a sandbox does not grant:
// check.perf's run of perf-guard.ts was refused that write (2026-10-22).
import { expect, it } from 'bun:test'
import config from '../vx.config.ts'

type Task = {
  exec?: { command: string; sandbox?: unknown; env?: { define?: Record<string, string> } }
}

it('every sandboxed bun task turns off Bun’s transpiler cache', () => {
  const missing = Object.entries(config.tasks as Record<string, Task>)
    .filter(([, t]) => t.exec?.sandbox !== undefined && t.exec.command.startsWith('bun '))
    .filter(([, t]) => t.exec?.env?.define?.['BUN_RUNTIME_TRANSPILER_CACHE_PATH'] !== '0')
    .map(([name]) => name)
  expect(missing).toEqual([])
})
