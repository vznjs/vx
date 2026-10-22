// The Deploy to Cloudflare button copies this directory alone into a new
// repository and installs it with npm, which refuses a `workspace:` spec.

import { expect, it } from 'bun:test'
import pkg from '../package.json' with { type: 'json' }

it('installs alone with npm and deploys with cf', () => {
  const deps = { ...pkg.devDependencies, ...(pkg as { dependencies?: object }).dependencies }
  expect({
    workspace: Object.entries(deps).filter(([, spec]) => String(spec).startsWith('workspace:')),
    deploy: pkg.scripts.deploy,
  }).toEqual({ workspace: [], deploy: 'cf deploy' })
})
