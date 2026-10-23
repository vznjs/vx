// The static render evaluates the playground's workspace at build time, and
// the build's runtime is not guaranteed to be Bun: CI's astro prerender ran
// under Node, which has no global `Worker`, and `/learn/playground/` failed
// with "Worker is not defined" (item 700's first CI run). The build path is
// `evaluateConfigInProcess`, which must need no Worker and answer exactly
// what the page's Worker path answers for the same text.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { evaluateConfig, evaluateConfigInProcess } from '../src/playground/config-eval.js'
import { CONFIG_TEXTS } from '../src/playground/workspace.js'

const SAMPLES: Record<string, string> = {
  ...CONFIG_TEXTS,
  'imports node:fs': "import fs from 'node:fs'\nexport default {}\n",
  'a function-valued description': `export default {
  tasks: { build: { exec: { command: 'true' }, description: () => 'built' } },
}
`,
  'a number default export': 'export default 3\n',
  'a syntax error': 'export default {\n',
}

describe('build-time evaluation needs no Worker (item 700)', () => {
  const viaWorker = new Map<string, Awaited<ReturnType<typeof evaluateConfig>>>()
  const saved = globalThis.Worker

  beforeAll(async () => {
    for (const [name, text] of Object.entries(SAMPLES)) {
      viaWorker.set(name, await evaluateConfig(text, 10_000))
    }
    // As on a Node build: the global is simply absent.
    Reflect.deleteProperty(globalThis, 'Worker')
  })
  afterAll(() => {
    globalThis.Worker = saved
  })

  it('the Worker is gone for the rows below', () => {
    expect(typeof (globalThis as { Worker?: unknown }).Worker).toBe('undefined')
  })

  for (const name of Object.keys(CONFIG_TEXTS)) {
    it(`${name}'s config evaluates in-process to what the Worker path gives`, async () => {
      const inProcess = await evaluateConfigInProcess(SAMPLES[name]!)
      expect(inProcess.ok).toBe(true)
      expect(inProcess).toStrictEqual(viaWorker.get(name)!)
    })
  }

  for (const name of [
    'imports node:fs',
    'a function-valued description',
    'a number default export',
  ]) {
    it(`${name}: the same refusal on both paths`, async () => {
      const inProcess = await evaluateConfigInProcess(SAMPLES[name]!)
      expect(inProcess.ok).toBe(false)
      expect(inProcess).toStrictEqual(viaWorker.get(name)!)
    })
  }

  it('a syntax error is refused on both paths', async () => {
    // The message is the engine's own and differs between a Worker's import
    // and this one's, so only the verdict is compared.
    const inProcess = await evaluateConfigInProcess(SAMPLES['a syntax error']!)
    expect(inProcess.ok).toBe(false)
    expect(viaWorker.get('a syntax error')?.ok).toBe(false)
  })
})

describe('the static render evaluates through the build-time path', () => {
  it('Playground.astro calls evaluateConfigInProcess and never evaluateConfig', () => {
    const source = readFileSync(
      path.join(import.meta.dir, '../src/components/demos/Playground.astro'),
      'utf8',
    )
    // The import clause itself, so an alias (`evaluateConfig as …`) cannot pass.
    const clauses = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*config-eval\.js'/g)]
    expect(clauses.map((m) => m[1]!.trim())).toEqual(['evaluateConfigInProcess'])
    const calls = [...source.matchAll(/\b(evaluateConfig\w*)\(/g)].map((m) => m[1])
    expect(calls).toEqual(['evaluateConfigInProcess'])
  })
})
