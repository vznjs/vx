// The relay on Cloudflare Workers (src/worker.ts): the README's Deploy to
// Cloudflare button, or `npx cf deploy --secrets-file .env` from this
// directory. Each run is one Durable Object, held in memory.

import { bindings, defineConfig, exports } from 'cf/config'
import * as entrypoint from './src/worker.ts' with { type: 'cf-worker' }

export default defineConfig({
  worker: {
    name: 'vx-dte-relay',
    entrypoint,
    compatibilityDate: '2026-10-01',
    // cf turns workers.dev off unless named; it is the relay's URL until a domain is added.
    workersDev: true,
    env: {
      // Add `https://gitlab.com` (or a self-managed GitLab) to carry GitLab's runs.
      ISSUERS: bindings.text('https://token.actions.githubusercontent.com'),
      // `owner/repo`, comma separated: a secret so it is set at deploy, never committed.
      REPOSITORIES: bindings.secret(),
      RELAY: bindings.durableObject({ worker: 'vx-dte-relay', exportName: 'RelayRun' }),
    },
    exports: { RelayRun: exports.durableObject({ storage: 'sqlite' }) },
  },
})
