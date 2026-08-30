#!/usr/bin/env bun
// A worker. Long-lived: it keeps its checkout, its install and its local vx
// cache between runs, which is the whole reason it is not a container per run.
//
//   VX_AGENTS_ENDPOINT=http://sync:8787 \
//   VX_AGENT_WORKSPACE=/work VX_AGENT_IMAGE=vx-toolchain \
//   VX_AGENT_CORES=4 VX_AGENT_MEMORY=8192 bun vx-agent.ts

import { hostname } from 'node:os'
import { Worker } from '../src/worker.js'

const endpoint = Bun.env['VX_AGENTS_ENDPOINT']
if (endpoint === undefined || endpoint === '') {
  process.stderr.write('[vx-agent] VX_AGENTS_ENDPOINT is required\n')
  process.exit(2)
}

const num = (name: string): number | undefined => {
  const raw = Bun.env[name]
  return raw === undefined || raw === '' ? undefined : Number(raw)
}

const worker = new Worker({
  endpoint,
  ...(Bun.env['VX_SYNC_TOKEN'] === undefined ? {} : { authToken: Bun.env['VX_SYNC_TOKEN'] }),
  workspace: Bun.env['VX_AGENT_WORKSPACE'] ?? '/work',
  name: Bun.env['VX_AGENT_NAME'] ?? hostname(),
  capabilities: {
    ...(Bun.env['VX_AGENT_IMAGE'] === undefined ? {} : { image: Bun.env['VX_AGENT_IMAGE'] }),
    ...(num('VX_AGENT_CORES') === undefined ? {} : { cores: num('VX_AGENT_CORES')! }),
    ...(num('VX_AGENT_MEMORY') === undefined ? {} : { memory: num('VX_AGENT_MEMORY')! }),
    concurrency: num('VX_AGENT_CONCURRENCY') ?? 1,
  },
  install: Bun.env['VX_AGENT_INSTALL'] ?? 'bun install --frozen-lockfile',
  ...(num('VX_AGENT_MAX_ASSIGNMENTS') === undefined
    ? {}
    : { maxAssignments: num('VX_AGENT_MAX_ASSIGNMENTS')! }),
})

process.on('SIGTERM', () => worker.stop())
process.on('SIGINT', () => worker.stop())
await worker.start()
