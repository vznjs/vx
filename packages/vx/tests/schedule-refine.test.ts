// A `schedule` plugin's answer is awaited before the first task, so it comes
// from what is at hand; weights that need a fetch reach the run through
// `ctx.refine` without holding it, and re-rank what has not started
// (owner, 2026-10-16). Each plugin's call is its own step, `<plugin>:schedule`.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import {
  addProject,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
  type Fixture,
} from './helpers/orchestrator-fixture.js'
import { run } from './helpers/orchestrator.js'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'

let fixture: Fixture
beforeEach(async () => {
  fixture = await makeWorkspace('vx-schedule-refine-')
})
afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true })
})

async function started(plugin: string): Promise<{ order: string[]; steps: string[] }> {
  await addProject(fixture.root, 'p', {
    config: `export default { name: 'p', tasks: {
      a: { exec: { command: 'sleep 0.3' } },
      b: { exec: { command: 'true' } },
      c: { exec: { command: 'true' } },
      d: { exec: { command: 'true' } },
      all: { dependsOn: ['a', 'b', 'c', 'd'] },
    } }\n`,
  })
  await Bun.write(
    path.join(fixture.root, '.vx/workspace.mjs'),
    `${PLUGIN_IMPORT}export default { plugins: [${pluginSource('org/late', plugin)}] }\n`,
  )
  const order: string[] = []
  const steps: string[] = []
  const log = silentLogger(fixture)
  const result = await run({
    cwd: fixture.root,
    tasks: ['all'],
    concurrency: 1,
    log: {
      ...log,
      taskStart(node) {
        if (node.config.exec !== undefined) order.push(node.taskName)
        log.taskStart?.(node)
      },
      stepStart: (id) => steps.push(id),
      stepEnd() {},
    },
  })
  expect(result.ok).toBe(true)
  return { order, steps }
}

it(
  'weights refined while a task runs re-rank the tasks not yet started',
  async () => {
    // The first answer puts a first; the refined one, given as a starts,
    // lifts d over b and c.
    const { order, steps } = await started(`(() => {
      let refine
      return {
        schedule(nodes, ctx) { refine = ctx.refine; return new Map([['p#a', 9]]) },
        setup(ctx) { ctx.on('onTaskStart', (node) => { if (node.id === 'p#a') refine(new Map([['p#d', 5]])) }) },
      }
    })()`)
    expect(order).toEqual(['a', 'd', 'b', 'c'])
    expect(steps).toContain('org/late:schedule')
    expect(steps).not.toContain('vx:schedule')
  },
  TIMEOUT,
)

it(
  'CONTROL: with no refine the first answer holds',
  async () => {
    const { order } = await started(`{ schedule() { return new Map([['p#a', 9]]) } }`)
    expect(order).toEqual(['a', 'b', 'c', 'd'])
  },
  TIMEOUT,
)

it(
  'a malformed refine is ignored with a word, never a failed run',
  async () => {
    const { order } = await started(`(() => {
      let refine
      return {
        schedule(nodes, ctx) { refine = ctx.refine; return new Map([['p#a', 9]]) },
        setup(ctx) { ctx.on('onTaskStart', (node) => { if (node.id === 'p#a') refine(new Map([['p#d', NaN]])) }) },
      }
    })()`)
    expect(order).toEqual(['a', 'b', 'c', 'd'])
    expect(fixture.log.join('\n')).toContain(
      'weight for p#d is not a finite number; refine ignored',
    )
  },
  TIMEOUT,
)

it(
  'another plugin hears each refine, and the one that refined does not',
  async () => {
    // `org/late` refines as a starts; `org/reader` may read history again then.
    await addProject(fixture.root, 'p', {
      config: `export default { name: 'p', tasks: {
        a: { exec: { command: 'sleep 0.3' } },
        b: { exec: { command: 'true' } },
        all: { dependsOn: ['a', 'b'] },
      } }\n`,
    })
    const heard = path.join(fixture.root, 'heard.txt')
    await Bun.write(
      path.join(fixture.root, '.vx/workspace.mjs'),
      `${PLUGIN_IMPORT}import { appendFileSync } from 'node:fs'
const hear = (who) => appendFileSync(${JSON.stringify(heard)}, who + '\\n')
export default { plugins: [${pluginSource(
        'org/late',
        `(() => {
      let refine
      return {
        schedule(nodes, ctx) { refine = ctx.refine; ctx.onRefine(() => hear('late')); return new Map([['p#a', 9]]) },
        setup(ctx) { ctx.on('onTaskStart', (node) => { if (node.id === 'p#a') refine(new Map([['p#b', 5]])) }) },
      }
    })()`,
      )}, ${pluginSource('org/reader', `{ schedule(nodes, ctx) { ctx.onRefine(() => hear('reader')) } }`)}] }\n`,
    )
    const result = await run({
      cwd: fixture.root,
      tasks: ['all'],
      concurrency: 1,
      log: silentLogger(fixture),
    })
    expect(result.ok).toBe(true)
    expect(await Bun.file(heard).text()).toBe('reader\n')
  },
  TIMEOUT,
)

// A plugin that sizes the run by fetched timings (vx-dte's agents) waited
// on nothing and asked before they landed: main asked 12 agents for 13
// misses, 5 ran nothing (2026-10-23). A promised refine is waited for.
it(
  'refining() settles once a promised refine has landed and its listeners heard it',
  async () => {
    await addProject(fixture.root, 'p', {
      config: `export default { name: 'p', tasks: { a: { exec: { command: 'true' } } } }\n`,
    })
    const heard = path.join(fixture.root, 'heard.txt')
    await Bun.write(
      path.join(fixture.root, '.vx/workspace.mjs'),
      `${PLUGIN_IMPORT}import { appendFileSync } from 'node:fs'
const hear = (what) => appendFileSync(${JSON.stringify(heard)}, what + '\\n')
export default { plugins: [${pluginSource(
        'org/late',
        `{ schedule(nodes, ctx) { ctx.refine(Bun.sleep(200).then(() => new Map([['p#a', 5]]))) } }`,
      )}, ${pluginSource(
        'org/sizer',
        `{ schedule(nodes, ctx) { ctx.onRefine(() => hear('refined')); ctx.refining().then(() => hear('settled')) } }`,
      )}] }\n`,
    )
    const result = await run({
      cwd: fixture.root,
      tasks: ['a'],
      log: silentLogger(fixture),
    })
    expect(result.ok).toBe(true)
    for (let i = 0; i < 40 && !(await Bun.file(heard).exists()); i++) await Bun.sleep(25)
    await Bun.sleep(300)
    expect(await Bun.file(heard).text()).toBe('refined\nsettled\n')
  },
  TIMEOUT,
)
