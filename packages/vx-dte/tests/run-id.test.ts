// Whether a run is distributed, and under which id: VX_DTE_RUN, or on
// GitHub Actions the run's own when a keyless adapter and a relay are set,
// so ci.yml names nothing (2026-10-23: "super simple" CI).

import { afterEach, expect, it } from 'bun:test'
import { dte, type DteAdapter } from '../src/plugin.js'

const saved = { ...process.env }
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  Object.assign(process.env, saved)
})

/** The events `setup` subscribes: none when the run is not distributed. */
function subscribed(options: Parameters<typeof dte>[0]): string[] {
  const on: string[] = []
  const setup = dte({ workers: { s: { cpu: 1, memory: '1GB' } }, ...options })
    .setup as unknown as (ctx: { on(event: string): void }) => void
  setup({ on: (event) => on.push(event) })
  return on
}

const keyless: DteAdapter = { keyless: true, spawn: () => {} }

it('distributes a GitHub Actions run with a keyless adapter and a relay, naming no run', () => {
  delete process.env['VX_DTE_RUN']
  process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = 'https://token.example'
  process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'req-token'
  process.env['GITHUB_REPOSITORY_ID'] = '1'
  expect(subscribed({ relay: 'https://r', adapter: keyless })).toEqual(['onTaskComplete'])
  // A laptop, or a job with no relay, stays local.
  expect(subscribed({ adapter: keyless })).toEqual([])
  delete process.env['ACTIONS_ID_TOKEN_REQUEST_URL']
  expect(subscribed({ relay: 'https://r', adapter: keyless })).toEqual([])
})
