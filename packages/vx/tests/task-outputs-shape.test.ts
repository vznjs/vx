// A task's `outputs` and its `inputs.stability` sit beside `cache`, which is
// only the switch: `cache: true`. Each key lives with what it describes.
import { describe, expect, it } from 'bun:test'
import type { WorkspaceConfig } from '../src/config.js'
import { validateProjectConfig, validateWorkspace } from '../src/workspace/config-schema.js'

const WS = '/ws/.vx/workspace.ts'
const CFG = '/ws/pkg/vx.config.ts'

function refusal(validate: () => void): string | null {
  try {
    validate()
    return null
  } catch (err) {
    expect((err as Error).name).toBe('UserError')
    return (err as Error).message
  }
}
const task = (t: unknown) =>
  refusal(() => validateProjectConfig({ tasks: { t } } as never, CFG))
const workspace = (w: unknown) => refusal(() => validateWorkspace(w as WorkspaceConfig, WS))

const BUILD = { exec: { command: 'x' }, inputs: { files: ['src/**'] } }

describe('cache is the switch; outputs and stability sit beside it', () => {
  it('loads outputs, inputs.stability and cache: true', () => {
    expect(
      task({
        exec: { command: 'x' },
        inputs: { files: ['src/**'], stability: { strategy: 'mutable', severity: 'error' } },
        outputs: { files: ['dist/**'], clean: false, bin: 'dist/bin' },
        cache: true,
      }),
    ).toBeNull()
  })

  it('cache is true or absent', () => {
    const must = `${CFG}: tasks.t.cache must be true, or absent for a task that never caches`
    for (const c of [false, {}, { outputs: { files: ['dist/**'] } }, 'yes', null]) {
      expect(task({ ...BUILD, outputs: { files: ['dist/**'] }, cache: c })).toBe(must)
    }
  })

  it('cache: true needs outputs', () => {
    expect(task({ ...BUILD, cache: true })).toBe(
      `${CFG}: tasks.t: \`cache\` needs \`outputs\` — what the task produces, \`outputs: { files: [...] }\` (\`[]\` for none)`,
    )
  })

  it('outputs and inputs.stability need cache: true', () => {
    expect(task({ ...BUILD, outputs: { files: ['dist/**'] } })).toBe(
      `${CFG}: tasks.t.outputs needs \`cache: true\` — vx saves and restores outputs only for a cached task`,
    )
    expect(
      task({ exec: { command: 'x' }, inputs: { files: [], stability: { strategy: 'mutable' } } }),
    ).toBe(
      `${CFG}: tasks.t.inputs.stability needs \`cache: true\` — it decides only whether a run's result is saved`,
    )
  })

  it('the workspace default sits at inputs.stability and outputs.clean', () => {
    expect(
      workspace({ inputs: { stability: { strategy: 'mutable' } }, outputs: { clean: false } }),
    ).toBeNull()
    expect(workspace({ cache: { inputStability: { strategy: 'mutable' } } })).toContain(
      'cache has unknown field "inputStability"',
    )
    expect(workspace({ cache: { outputs: { clean: false } } })).toContain(
      'cache has unknown field "outputs"',
    )
  })
})
