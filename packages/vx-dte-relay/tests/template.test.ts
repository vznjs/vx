// The Deploy to Cloudflare button copies this directory alone into a new
// repository, installs it with npm, which refuses a `workspace:` spec, and
// reads wrangler.jsonc, the only config it parses.

import { expect, it } from 'bun:test'
import path from 'node:path'
import pkg from '../package.json' with { type: 'json' }

it('installs alone with npm and deploys with wrangler by wrangler.jsonc', async () => {
  const deps = { ...pkg.devDependencies, ...(pkg as { dependencies?: object }).dependencies }
  const config = Bun.JSONC.parse(
    await Bun.file(path.join(import.meta.dir, '..', 'wrangler.jsonc')).text(),
  ) as {
    main: string
    vars?: object
    durable_objects: unknown
    migrations: unknown
  }
  expect({
    workspace: Object.entries(deps).filter(([, spec]) => String(spec).startsWith('workspace:')),
    deploy: pkg.scripts.deploy,
    main: await Bun.file(path.join(import.meta.dir, '..', config.main)).exists(),
    // A deploy replaces every var with this file's and keeps secrets, so
    // ALLOW is a secret the button asks for, and no deployer's ALLOW is here.
    vars: config.vars,
    secrets: await Bun.file(path.join(import.meta.dir, '..', '.dev.vars.example')).text(),
    objects: config.durable_objects,
    migrations: config.migrations,
  }).toEqual({
    workspace: [],
    deploy: 'wrangler deploy',
    main: true,
    vars: undefined,
    secrets: 'ALLOW=https://token.actions.githubusercontent.com:owner/repo:ci.yml\n',
    objects: { bindings: [{ name: 'RELAY', class_name: 'RelayRun' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['RelayRun'] }],
  })
})
