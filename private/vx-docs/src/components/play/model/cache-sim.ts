// CacheSim's model: the story workspace's cache, run by run. Pure, no DOM.
// Every rule below is vx's, with the file it comes from:
//
// - The key is built from parts: each input file, the task's evaluated config,
//   each `inputs.env` name (`unset` when absent) and the keys of the tasks it
//   depends on (packages/vx/src/cache/key-fold.ts). An upstream task's KEY is
//   folded, never its outputs (CLAUDE.md, principle 5).
// - `src/**` skips a file git ignores; a file no glob matches is not in the
//   key (packages/vx/docs/caching.md, "What the key holds").
// - A stored key is a hit. Outputs already as stored → `up-to-date`; else
//   vx restores them → `restored-local`. A task with no outputs is always
//   up to date on a local hit (orchestrator/hit-restore.ts, `currentHit`;
//   report/events.ts, `outcomeWord`). A miss runs and its frame ends `success`.
// - A hit replays the stored log (hit-restore.ts, `hitOutcome`) and its frame
//   header is `<word> • <first 8 of key>` (report/framed-output.ts).
// - The reason line is `vx why`'s verdict against the task's previous run:
//   `cache key changed: <kind> <name>, …` (first three, then a count) or
//   `cache key unchanged — …` (cli/why.ts, history/metrics.ts).
// - Entries stay in the cache, so undoing an edit brings back a stored key.

export type TaskName = 'build' | 'test' | 'lint'

export type ChangeId =
  | 'uiSrc'
  | 'webSrc'
  | 'readme'
  | 'ignored'
  | 'command'
  | 'envDeclared'
  | 'envUndeclared'

export interface Change {
  id: ChangeId
  /** The chip's text. */
  label: string
  /** What the change touches, as `vx why` names it. */
  target: string
}

export const CHANGES: readonly Change[] = [
  { id: 'uiSrc', label: 'Edit ui/src/index.ts', target: 'packages/ui/src/index.ts' },
  { id: 'webSrc', label: 'Edit web/src/index.ts', target: 'packages/web/src/index.ts' },
  { id: 'readme', label: 'Edit ui/README.md', target: 'packages/ui/README.md' },
  { id: 'ignored', label: 'Edit ui/src/debug.log', target: 'packages/ui/src/debug.log' },
  { id: 'command', label: "ui build: 'vite build --minify false'", target: 'exec.command' },
  { id: 'envDeclared', label: 'MODE=production', target: 'MODE' },
  { id: 'envUndeclared', label: 'DEBUG=1', target: 'DEBUG' },
]

interface FileSpec {
  path: string
  project: string
  /** Matched by `.gitignore` (`*.log`). */
  ignored?: true
  change?: ChangeId
}

const FILES: readonly FileSpec[] = [
  { path: 'packages/ui/src/index.ts', project: 'ui', change: 'uiSrc' },
  { path: 'packages/ui/src/debug.log', project: 'ui', ignored: true, change: 'ignored' },
  { path: 'packages/ui/README.md', project: 'ui', change: 'readme' },
  { path: 'packages/web/src/index.ts', project: 'web', change: 'webSrc' },
  { path: 'packages/web/vite.config.ts', project: 'web' },
  { path: 'packages/admin/src/index.ts', project: 'admin' },
  { path: 'packages/api/src/index.ts', project: 'api' },
]

export interface TaskSpec {
  id: string
  project: string
  task: TaskName
  command: string
  dependsOn: readonly string[]
  files: readonly string[]
  env: readonly string[]
  outputs: readonly string[]
  /** What the task prints; a hit replays it. */
  log: string
  ms: number
}

// Every project declares the same three tasks, as running-tasks.mdx shows
// web's config; web's build alone also keys on MODE (inputs.env).
const PROJECTS = [
  { name: 'ui', deps: [] as string[], ms: 640, tests: 12 },
  { name: 'web', deps: ['ui'], ms: 820, tests: 7 },
  { name: 'admin', deps: ['ui'], ms: 710, tests: 5 },
  { name: 'api', deps: [] as string[], ms: 410, tests: 9 },
]

const spec = (p: (typeof PROJECTS)[number], task: TaskName): TaskSpec => {
  const base = { id: `@demo/${p.name}#${task}`, project: p.name, task }
  if (task === 'lint')
    return {
      ...base,
      command: 'oxlint src',
      dependsOn: [],
      files: ['src/**'],
      env: [],
      outputs: [],
      log: 'Found 0 warnings and 0 errors.',
      ms: 90,
    }
  // `^build`: the build of each project this one uses.
  const dependsOn = p.deps.map((d) => `@demo/${d}#build`)
  return task === 'build'
    ? {
        ...base,
        command: 'vite build',
        dependsOn,
        files: ['src/**', 'vite.config.ts'],
        env: p.name === 'web' ? ['MODE'] : [],
        outputs: ['dist/**'],
        log: `✓ built in ${Math.round(p.ms * 0.65)}ms`,
        ms: p.ms,
      }
    : {
        ...base,
        command: 'vitest run',
        dependsOn,
        files: ['src/**'],
        env: [],
        outputs: [],
        log: `Tests  ${p.tests} passed (${p.tests})`,
        ms: p.ms + 500,
      }
}

/** In the order a run prints them: a dependency's frame first. */
export const TASKS: readonly TaskSpec[] = (['build', 'test', 'lint'] as const).flatMap((t) =>
  PROJECTS.map((p) => spec(p, t)),
)

export interface Part {
  kind: 'file' | 'config' | 'env' | 'upstream'
  name: string
  value: string
}

export type Outcome = 'miss' | 'up-to-date' | 'restored'

export interface TaskResult {
  spec: TaskSpec
  key: string
  /** The command as the evaluated config says it. */
  command: string
  /** The key of this task's previous run, when there was one. */
  previousKey: string | undefined
  outcome: Outcome
  /** `vx why`'s verdict line. */
  verdict: string
  /** The same in plain words. */
  note: string
  ms: number
}

export interface RunResult {
  n: number
  task: TaskName
  results: TaskResult[]
  /** Changes since the last run that moved no key, with why. */
  quiet: Array<{ change: Change; why: string }>
}

export interface State {
  /** Changes in effect now. */
  changed: Set<ChangeId>
  /** Changes made since the last run, to say which moved nothing. */
  touched: Set<ChangeId>
  /** Stored keys: entries are never dropped here. */
  stored: Set<string>
  /** Whose outputs are on disk, per task: the key that wrote them. */
  disk: Map<string, string | null>
  /** Each task's previous run: its key and parts, for `vx why`. */
  last: Map<string, { key: string; parts: Part[] }>
  runs: number
}

export const emptyState = (): State => ({
  changed: new Set(),
  touched: new Set(),
  stored: new Set(),
  disk: new Map(),
  last: new Map(),
  runs: 0,
})

/** Toggles a change: pressing it again undoes the edit. */
export function toggle(s: State, id: ChangeId): void {
  if (s.changed.has(id)) s.changed.delete(id)
  else s.changed.add(id)
  s.touched.add(id)
}

/** Deletes `packages/web/dist`: nothing else moves. */
export function deleteWebDist(s: State): void {
  s.disk.set('@demo/web#build', null)
}

/** The ui build's command, as the evaluated config holds it. */
const commandOf = (s: State, t: TaskSpec): string =>
  t.id === '@demo/ui#build' && s.changed.has('command') ? 'vite build --minify false' : t.command

const ENV: Record<string, { from: string; to: string; change: ChangeId }> = {
  MODE: { from: 'staging', to: 'production', change: 'envDeclared' },
  DEBUG: { from: 'unset', to: '1', change: 'envUndeclared' },
}

/** `src/**` style globs and exact names, relative to the project. */
function matches(glob: string, rel: string): boolean {
  if (glob.endsWith('/**')) return rel.startsWith(glob.slice(0, -2))
  return rel === glob
}

function partsOf(s: State, t: TaskSpec, keys: ReadonlyMap<string, string>): Part[] {
  const parts: Part[] = []
  for (const f of FILES) {
    if (f.project !== t.project) continue
    const rel = f.path.slice(`packages/${f.project}/`.length)
    // A broad glob skips what git ignores (docs/caching.md).
    if (f.ignored === true || !t.files.some((g) => matches(g, rel))) continue
    const edited = f.change !== undefined && s.changed.has(f.change)
    parts.push({ kind: 'file', name: f.path, value: `${f.path}@${edited ? 2 : 1}` })
  }
  parts.push({
    kind: 'config',
    name: 'config',
    value: JSON.stringify([commandOf(s, t), t.dependsOn, t.files, t.env, t.outputs]),
  })
  for (const name of t.env) {
    const e = ENV[name]!
    parts.push({ kind: 'env', name, value: s.changed.has(e.change) ? e.to : e.from })
  }
  for (const d of t.dependsOn) parts.push({ kind: 'upstream', name: d, value: keys.get(d)! })
  return parts
}

/** A 16-hex key from the parts (FNV-1a, two lanes): stands in for xxh3. */
export function keyOf(id: string, parts: readonly Part[]): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  const text = `${id}\0${parts.map((p) => `${p.kind}\0${p.name}\0${p.value}`).join('\0')}`
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 13)
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0')
  return hex(a) + hex(b)
}

const partName = (p: Part): string => (p.name === p.kind ? p.kind : `${p.kind} ${p.name}`)

/** The parts whose value moved, as `vx why` names them. */
export function moved(before: readonly Part[], after: readonly Part[]): string[] {
  const old = new Map(before.map((p) => [partName(p), p.value]))
  return after.filter((p) => old.get(partName(p)) !== p.value).map(partName)
}

const firstThree = (items: readonly string[]): string =>
  `${items.slice(0, 3).join(', ')}${items.length > 3 ? ` and ${items.length - 3} more` : ''}`

const outputsOf = (t: TaskSpec): string => t.outputs.map((o) => o.replace(/\*\*$/, '')).join(', ')

/** Runs `vx run <task> --all` against the state, and moves the state on. */
export function run(s: State, task: TaskName): RunResult {
  const keys = new Map<string, string>()
  const results: TaskResult[] = []
  // `vx run <task> --all` runs every task it needs first: test's `^build`.
  const wanted = new Set(TASKS.filter((x) => x.task === task).map((x) => x.id))
  for (const t of [...TASKS].reverse())
    if (wanted.has(t.id)) for (const d of t.dependsOn) wanted.add(d)
  for (const t of TASKS.filter((x) => wanted.has(x.id))) {
    const parts = partsOf(s, t, keys)
    const key = keyOf(t.id, parts)
    keys.set(t.id, key)
    const prev = s.last.get(t.id)
    const hit = s.stored.has(key)
    const onDisk = s.disk.get(t.id) ?? null
    const outcome: Outcome = !hit
      ? 'miss'
      : t.outputs.length === 0 || onDisk === key
        ? 'up-to-date'
        : 'restored'
    const changed = prev === undefined ? [] : moved(prev.parts, parts)
    const verdict =
      prev === undefined
        ? 'previous: none, first recorded run of this task'
        : prev.key !== key
          ? `cache key changed: ${firstThree(changed)}`
          : outcome === 'miss'
            ? 'cache key unchanged — no entry for this key was in the cache'
            : 'cache key unchanged — this run was served from cache, nothing re-ran'
    const out = outputsOf(t)
    const note =
      outcome === 'miss'
        ? prev === undefined || prev.key === key
          ? 'Nothing stored for this key yet, so the task runs and vx stores its result.'
          : 'A new key, so the task runs and vx stores its result.'
        : outcome === 'restored'
          ? prev !== undefined && prev.key !== key
            ? `An earlier run stored this key. vx puts its ${out} back, no rerun.`
            : `Same key, but ${out} was missing. vx puts it back from the cache, no rerun.`
          : prev !== undefined && prev.key !== key
            ? 'An earlier run stored this key. Nothing to write, no rerun.'
            : t.outputs.length === 0
              ? 'Same key, and the task writes no files. Nothing runs.'
              : `Same key, and ${out} is already in place. Nothing runs, nothing is copied.`
    if (outcome === 'miss') s.stored.add(key)
    if (t.outputs.length > 0) s.disk.set(t.id, key)
    s.last.set(t.id, { key, parts })
    const ms = outcome === 'miss' ? t.ms : outcome === 'restored' ? 14 + t.ms / 100 : 5
    results.push({
      spec: t,
      key,
      command: commandOf(s, t),
      previousKey: prev?.key,
      outcome,
      verdict,
      note,
      ms,
    })
  }
  const quiet = CHANGES.filter((c) => s.touched.has(c.id) && QUIET[c.id] !== undefined).map(
    (change) => ({ change, why: QUIET[change.id]! }),
  )
  s.touched.clear()
  s.runs++
  return { n: s.runs, task, results, quiet }
}

/** Changes that never reach a key, and why. */
const QUIET: Partial<Record<ChangeId, string>> = {
  readme: 'No key moved: packages/ui/README.md is in no inputs.files glob.',
  ignored: 'No key moved: git ignores *.log, so src/** skips packages/ui/src/debug.log.',
  envUndeclared: 'No key moved: no task lists DEBUG in inputs.env.',
}

/** The sentence under the controls. */
export function summary(r: RunResult): string {
  const ran = r.results.filter((x) => x.outcome === 'miss').length
  const restored = r.results.filter((x) => x.outcome === 'restored').length
  const fresh = r.results.length - ran - restored
  const parts = [
    ran > 0 ? `${ran} ran` : '',
    restored > 0 ? `${restored} restored from the cache` : '',
    fresh > 0 ? `${fresh} up to date` : '',
  ].filter((p) => p !== '')
  const tasks = `${r.results.length} task${r.results.length === 1 ? '' : 's'}`
  const said = `Run ${r.n}: ${tasks}, ${parts.join(', ')}.`
  return r.quiet.length === 0 ? said : `${said} ${r.quiet.map((q) => q.why).join(' ')}`
}

// ---- HTML, shared by the static render and the element ----

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

const span = (cls: string, text: string): string => `<span class="${cls}">${esc(text)}</span>`

const elapsed = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`

/** The frame word vx prints on the last line (report/events.ts, `outcomeWord`). */
export const word = (o: Outcome): string =>
  o === 'miss' ? 'success' : o === 'restored' ? 'restored-local' : 'up-to-date'

const TONE: Record<Outcome, string> = { miss: 'is-warn', restored: 'is-ok', 'up-to-date': 'is-ok' }
const SAYS: Record<Outcome, string> = {
  miss: 'cache miss · ran',
  restored: 'cache hit · restored',
  'up-to-date': 'up to date',
}

/** The run as vx's terminal frames. */
export function terminalHtml(r: RunResult): string {
  const id = (t: TaskSpec) =>
    `${span('t-id', t.id.split('#')[0]!)}${span('is-muted', '#')}${span('t-id', t.task)}`
  const lines = [`${span('is-muted', '$')} vx run ${r.task} --all`, '']
  for (const x of r.results) {
    const head =
      x.outcome === 'miss'
        ? span('is-muted', `$ ${x.command}`)
        : `${span('is-ok', word(x.outcome))} ${span('is-muted', `• ${x.key.slice(0, 8)}`)}`
    lines.push(
      `${span('is-muted', '┌─')} ${id(x.spec)} ${span('is-muted', '>')} ${head}`,
      x.spec.task === 'build' ? span('is-ok', x.spec.log) : x.spec.log,
      `${span('is-muted', '└─')} ${id(x.spec)} ${span('is-muted', `── (${elapsed(x.ms)}) ${word(x.outcome)}`)}`,
      '',
    )
  }
  const n = (o: Outcome) => r.results.filter((x) => x.outcome === o).length
  const cache = [
    n('miss') > 0 ? span('is-warn', `${n('miss')} miss`) : '',
    n('up-to-date') > 0 ? span('is-ok', `${n('up-to-date')} up-to-date`) : '',
    n('restored') > 0 ? span('is-ok', `${n('restored')} local`) : '',
  ].filter((c) => c !== '')
  lines.push(
    `  ${span('is-muted', 'tasks')}   ${span('is-ok', `${r.results.length} success`)} ${span('is-muted', `${r.results.length} total`)}`,
    `  ${span('is-muted', 'cache')}   ${cache.join(' ')}`,
  )
  return lines.join('\n')
}

/** One row per task: its key, what happened, and why. */
export function resultsHtml(r: RunResult): string {
  return r.results
    .map((x) => {
      const movedKey = x.previousKey !== undefined && x.previousKey !== x.key
      const chip = `<code class="key ${movedKey ? 'is-warn moved' : 'is-muted'}" title="cache key">${esc(x.key.slice(0, 8))}</code>`
      const was = movedKey
        ? ` <span class="was is-muted">was <s>${esc(x.previousKey!.slice(0, 8))}</s></span>`
        : ''
      return (
        `<li><div class="head"><strong class="t-name">${esc(x.spec.id)}</strong>` +
        `<span class="keys">${chip}${was}</span>` +
        `<span class="badge ${TONE[x.outcome]}">${esc(SAYS[x.outcome])}</span></div>` +
        `<p class="verdict">${esc(x.verdict)}</p><p class="note">${esc(x.note)}</p></li>`
      )
    })
    .join('')
}
