#!/usr/bin/env bun
// The synchronizer. One process, no database, no UI.
//
//   VX_SYNC_PORT=8787 VX_SYNC_TOKEN=… bun vx-sync.ts

import { SyncServer } from '../src/sync.js'

const port = Number(Bun.env['VX_SYNC_PORT'] ?? 8787)
const token = Bun.env['VX_SYNC_TOKEN']
const server = new SyncServer({ port, ...(token === undefined ? {} : { authToken: token }) })
const listening = server.listen()
// Workers that stopped answering must not hold their assignments open: vx is
// waiting on a result that will never arrive otherwise.
setInterval(() => server.reap(), 15_000)
process.stderr.write(`[vx-sync] listening on :${listening.port}\n`)
