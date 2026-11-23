// The config explorer reaches every field the validator accepts and says
// only what the config reference says about it.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { SPLIT_REFERENCES, splitReference } from '../scripts/import-docs.ts'
import {
  anchorsFromForward,
  buildFields,
  defaultField,
  fieldPaths,
  referenceEntries,
  renderFile,
  renderPanel,
  resolveField,
  rows,
  search,
  typeOf,
  type Config,
  type SchemaRecord,
} from '../src/components/play/model/config-explorer.ts'

const CORE = path.join(import.meta.dir, '..', '..', '..', 'packages', 'vx')
const DOC = readFileSync(path.join(CORE, 'docs', 'schema.md'), 'utf8')
const RECORD = JSON.parse(
  readFileSync(path.join(CORE, 'tests', 'contract', 'config-schema.json'), 'utf8'),
) as Record<Config, SchemaRecord>
const SPLIT = SPLIT_REFERENCES.find((r) => r.src === 'schema.md')!
const { anchors, forward } = splitReference(DOC, SPLIT.specs, SPLIT.list)
const fieldsOf = (config: Config, doc = DOC) =>
  buildFields(config, RECORD[config], doc, anchors, '/vx/')

describe('every field', () => {
  it.each(['project', 'workspace'] as const)('of the %s config has a key in the file', (c) => {
    const fields = fieldsOf(c)
    const html = renderFile(fields, c, fields[0]!.path)
    const keys = new Set([...html.matchAll(/class="cx-key" data-path="([^"]+)"/g)].map((m) => m[1]))
    const levels = Object.entries(RECORD[c].levels).flatMap(([level, names]) =>
      names.map((n) => (level ? `${level}.${n}` : n)),
    )
    expect(levels.length).toBeGreaterThan(50)
    expect(levels.filter((p) => !keys.has(p))).toEqual([])
    expect(fieldPaths(RECORD[c]).filter((p) => !keys.has(p))).toEqual([])
  })

  it.each(['project', 'workspace'] as const)('of the %s config shows a type', (c) => {
    expect(
      fieldsOf(c)
        .filter((f) => f.type === null)
        .map((f) => f.path),
    ).toEqual([])
  })

  it('reads where each heading moved from the generated page, as the split put it', () => {
    const moved = [...anchors].filter(([, a]) => a.page !== '')
    expect(moved.length).toBeGreaterThan(20)
    expect([...anchorsFromForward(forward)]).toEqual(moved)
  })

  it('links a heading id the site serves', () => {
    for (const c of ['project', 'workspace'] as const)
      for (const f of fieldsOf(c))
        expect(f.href).toMatch(/^\/vx\/schema\/(?:[a-z-]+\/)?(?:#[\w-]+)?$/)
    const ids = new Set(anchors.keys())
    for (const e of referenceEntries(DOC)) expect(ids.has(e.id)).toBe(true)
  })
})

describe('the words come from the reference', () => {
  it('takes a task field from its heading', () => {
    const t = fieldsOf('project').find((f) => f.path === 'tasks.*.exec.timeout')!
    expect(t.what).toStartWith('How long one attempt may run before vx stops it')
    expect(t.href).toBe('/vx/schema/exec/#timeout-optional')
  })

  it('takes a workspace setting from its table row, with variable, flag and default', () => {
    const f = fieldsOf('workspace').find((x) => x.path === 'run.failFast')!
    expect(f.what).toStartWith('Stop the run at the first failure')
    expect([f.env, f.flag, f.def, f.type]).toEqual([
      '`VX_RUN_FAIL_FAST`',
      '`vx run --fail-fast`',
      '`false`',
      'true or false',
    ])
    expect(f.href).toBe('/vx/schema/workspace/#settings')
  })

  it('never borrows a lookalike entry: `tasks` is not `inputs.tasks`, a workspace `cache` not a task’s', () => {
    expect(fieldsOf('project').find((f) => f.path === 'tasks')!.what).toBeNull()
    expect(fieldsOf('workspace').find((f) => f.path === 'cache')!.what).toBeNull()
    expect(fieldsOf('project').find((f) => f.path === 'tasks.*.cache')!.what).toStartWith(
      '`cache: true` lets vx skip a task',
    )
  })

  it('fills a field in when the reference gains its entry', () => {
    const before = `
## \`TaskConfig\`

### \`exec\` (optional)

What the task runs.
`
    const after = `${before}
#### \`timeout\` (optional, default none)

Stops the command after this long. More words here.
`
    const all = (doc: string) => buildFields('project', RECORD.project, doc, anchors, '/vx/')
    const timeout = (doc: string) => all(doc).find((f) => f.path === 'tasks.*.exec.timeout')!
    const empty = timeout(before)
    expect(empty.what).toBeNull()
    expect(empty.type).toStartWith('a duration')
    // No split page knows this made-up heading, so the link stays on schema/.
    expect(empty.href).toBe('/vx/schema/#exec-optional')
    const row = rows(all(before)).find((r) => r.path === empty.path)!
    expect(renderPanel(row)).toContain('Explained in the config reference')
    const filled = timeout(after)
    expect([filled.what, filled.need, filled.def]).toEqual([
      'Stops the command after this long. More words here.',
      'optional',
      'none',
    ])
  })

  it('reads a type from the validator’s refusal', () => {
    expect(
      typeOf({
        ok: ['1'],
        "$CONFIG: `run.timeout` must be a duration like '500ms' (got null)": ['null'],
      }),
    ).toBe("a duration like '500ms'")
  })
})

describe('finding a field', () => {
  const project = fieldsOf('project')
  const workspace = fieldsOf('workspace')

  it('resolves a task-relative, a full or a sample-named path', () => {
    expect(resolveField(project, 'exec.timeout')).toBe('tasks.*.exec.timeout')
    expect(resolveField(project, 'tasks.build.outputs.files')).toBe('tasks.*.outputs.files')
    expect(resolveField(project, 'name')).toBe('name')
    expect(resolveField(workspace, 'pipelines.pr.failFast')).toBe('pipelines.*.failFast')
    expect(resolveField(workspace, 'run.nope')).toBeUndefined()
  })

  it('refuses a prop that names no field, at build time', () => {
    expect(() => defaultField(project, 'task', 'exec.timeuot')).toThrow('no such project field')
    expect(defaultField(workspace, 'workspace')).toBe('run.failFast')
  })

  it('finds by key, by path, by variable and by flag', () => {
    const r = rows(workspace)
    expect(search(r, 'failFast')[0]).toBe('run.failFast')
    expect(search(r, 'VX_CACHE_DIR')).toEqual(['cache.dir'])
    expect(search(r, '--cache-download')).toContain('cache.download')
    expect(search(rows(project), 'timeout')).toEqual(['tasks.*.exec.timeout'])
  })
})

describe('the panel', () => {
  it('shows a nested example and escapes what it shows', () => {
    const r = rows(fieldsOf('project'))
    const timeout = r.find((x) => x.path === 'tasks.*.exec.timeout')!
    expect(timeout.example).toBe("exec: { timeout: '10m' }")
    const html = renderPanel({ ...timeout, what: 'a <b> `x`' })
    expect(html).toContain('a &#60;b&#62; <code>x</code>')
  })

  it('lists a group’s fields to open next', () => {
    const r = rows(fieldsOf('workspace'))
    const run = r.find((x) => x.path === 'run')!
    expect(run.kids.map(([, k]) => k)).toContain('failFast')
    expect(renderPanel(run)).toContain('data-path="run.failFast"')
  })
})
