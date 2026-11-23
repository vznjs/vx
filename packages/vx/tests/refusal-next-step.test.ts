// A refusal says what to do next, not only what is wrong: each of these
// once stopped at the fault ("layer 'local' specified twice", "filter
// "..." names no project", "plugin missing `name` field").
import { describe, expect, it } from 'bun:test'
import { parseCachePolicy } from '../src/cache/index.js'
import { installPlugins, type Plugin } from '../src/orchestrator/index.js'
import { createEventBus } from '../src/report/index.js'
import { type UserError } from '../src/util/index.js'
import { parseFilter } from '../src/workspace/filter.js'

const ROOT = '/ws'

function caught(fn: () => unknown): UserError {
  try {
    fn()
  } catch (err) {
    return err as UserError
  }
  throw new Error('expected a refusal')
}

describe('a refusal names the next step', () => {
  it('a filter with no project between its operators says what a filter names', () => {
    for (const raw of ['...', '!', '{}', 'web{}']) {
      expect(caught(() => parseFilter(raw, ROOT)).message).toBe(
        `filter "${raw}" names no project. Name a project, a ./path or a tag:<name>, as in --filter web...`,
      )
    }
    expect(caught(() => parseFilter('tag:', ROOT)).message).toBe(
      'filter "tag:" names no tag. Write tag:<name>, as in --filter tag:frontend',
    )
  })

  it('a cache policy refusal shows the spelling it wants', () => {
    expect(caught(() => parseCachePolicy('local')).message).toBe(
      "invalid segment 'local': expected '<layer>:<flags>', as in 'local:rw,remote:r'",
    )
    expect(caught(() => parseCachePolicy('local:r,local:w')).message).toBe(
      "layer 'local' specified twice: name each layer once, as in 'local:rw,remote:r'",
    )
    expect(caught(() => parseCachePolicy('remote:rr')).message).toBe(
      "flag 'r' repeated for 'remote': give each flag once, as in 'remote:rw'",
    )
  })

  it('a plugin with no name or a setup that is not a function says how to build one', async () => {
    const install = (plugin: unknown) =>
      installPlugins({
        plugins: [plugin as Plugin],
        bus: createEventBus(),
        workspaceRoot: ROOT,
        cacheDir: `${ROOT}/.vx/cache`,
      })
    await expect(install({ name: '', setup() {} })).rejects.toThrow(
      'a plugin has no name: build it with definePlugin(import.meta, hooks), which names it after its package',
    )
    await expect(install({ name: 'x', setup: 42 })).rejects.toThrow(
      "plugin 'x' setup is not a function (got number): make it a function, or drop it",
    )
  })
})
