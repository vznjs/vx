// The config explorer's data: every field the validator accepts, each with
// what the config reference says about it. No DOM here.
//
// Two sources, read at build time by ConfigExplorer.astro, so the widget
// never says more than they do:
// - packages/vx/tests/contract/config-schema.json: the fields (`levels`,
//   `fields`) and, from the validator's own refusal, each field's type.
// - packages/vx/docs/schema.md: the explanation. A field's entry is a
//   heading that names it or a table row that names it, the rule of
//   packages/vx/tests/config-fields-explained.test.ts, matched here on the
//   exact path within the config's own sections (that test's suffix match
//   also counts `inputs.tasks` as `tasks`, which would put the wrong text
//   on a field).
// A field without an entry shows its type and a link, never made-up text.

export type Config = 'project' | 'workspace'
export type Area = 'project' | 'task' | 'workspace'

export interface SchemaRecord {
  levels: Record<string, string[]>
  fields: Record<string, Record<string, string[]>>
}

export interface Entry {
  /** The field path the entry names, `tasks.*.` left off (`exec.timeout`). */
  path: string
  /** The `##` section it sits in. */
  section: string
  /** The heading's id in schema.md as one page, or the heading above the row. */
  id: string
  what: string | null
  need: string | null
  def: string | null
  type: string | null
  env: string | null
  flag: string | null
}

export interface Field {
  path: string
  key: string
  parent: string
  kids: string[]
  /** The value the sample file shows, as TypeScript. */
  value: string
  /** Set in the story's file; the rest show commented out. */
  set: boolean
  type: string | null
  def: string | null
  need: string | null
  what: string | null
  env: string | null
  flag: string | null
  /** Its own entry in the reference, or the nearest one above it. */
  href: string
}

/** Where a schema.md heading id lives on the site: a split page ('' is schema/ itself) and its id there. */
export type Anchors = ReadonlyMap<string, { page: string; id?: string }>

/** A heading's id as the site writes it (github-slugger); a copy of headingSlug in scripts/import-docs.ts. */
function slug(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/\\(.)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-')
}

const PROJECT_SECTIONS = ['Project config', '`TaskConfig`', 'Group tasks']
const WORKSPACE_SECTION = 'Workspace config'

const configOf = (section: string): Config | null =>
  section.startsWith(WORKSPACE_SECTION)
    ? 'workspace'
    : PROJECT_SECTIONS.some((s) => section.startsWith(s))
      ? 'project'
      : null

const join = (base: string, name: string): string =>
  !base || name === base || name.startsWith(`${base}.`) ? name : `${base}.${name}`

function plain(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\*\*[^*]+\.\*\*\s*/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The first one or two sentences of a paragraph: what a field does. */
function lead(paragraph: string): string {
  // A paragraph that ends in ':' introduces a list or a block the panel does not show.
  const all = plain(paragraph)
    .replace(/ \((?:below|above)\)/g, '')
    .split(/(?<=[.!?])\s+(?=[A-Z`'(])/)
  const sentences =
    all.length > 1 && all.at(-1)!.endsWith(':')
      ? all.slice(0, -1)
      : all.map((x) => x.replace(/:$/, '.'))
  const two = sentences.slice(0, 2).join(' ')
  return two.length > 260 ? sentences[0]! : two
}

const cell = (s: string | undefined): string | null => {
  const t = (s ?? '').trim()
  return t === '' || t === '—' ? null : t
}

/**
 * Every field entry of the reference, in order. A heading's path joins its
 * named ancestors'; a type name (`TaskConfig`, `InputsConfig`) adds no
 * segment, so `##### inputs.files` under `#### InputsConfig` under
 * `### inputs` is `inputs.files`.
 */
export function referenceEntries(doc: string): Entry[] {
  const lines = doc.replace(/\r\n/g, '\n').split('\n')
  const out: Entry[] = []
  let stack: Array<{ depth: number; path: string; id: string }> = []
  let section = ''
  let fenced = false
  const seen = new Map<string, number>()
  let header: string[] = []
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (h) {
      const depth = h[1]!.length
      const text = h[2]!
      let id = ''
      if (depth >= 2) {
        const base = slug(text)
        const n = seen.get(base) ?? 0
        seen.set(base, n + 1)
        id = n === 0 ? base : `${base}-${n}`
      }
      if (depth === 2) section = text
      stack = stack.filter((s) => s.depth < depth)
      const base = stack.at(-1)?.path ?? ''
      const name = /`([\w.*]+)`/.exec(text)?.[1]
      const path = name === undefined || /^[A-Z]/.test(name) ? base : join(base, name)
      stack.push({ depth, path, id })
      if (name === undefined || /^[A-Z]/.test(name) || configOf(section) === null) continue
      const paren = /\(([^)]*)\)\s*$/.exec(text)?.[1] ?? null
      const def = paren === null ? null : (/default\s*=?\s*(.+)$/.exec(paren)?.[1] ?? null)
      const need = paren === null ? null : paren.replace(/,?\s*default.*$/, '').trim() || null
      out.push({
        path,
        section,
        id,
        what: firstParagraph(lines, at + 1),
        need,
        def,
        type: null,
        env: null,
        flag: null,
      })
      continue
    }
    if (!line.startsWith('|')) {
      header = []
      continue
    }
    const cells = line.split('|').slice(1, -1)
    if (header.length === 0) {
      header = cells.map((c) => c.trim())
      continue
    }
    if (/^[\s|:-]+$/.test(line) || configOf(section) === null) continue
    const name = /^\s*`([\w.*]+)`\s*$/.exec(cells[0] ?? '')?.[1]
    if (name === undefined) continue
    const col = (title: string) => cell(cells[header.indexOf(title)])
    const what = cell(cells.at(-1))
    out.push({
      path: join(stack.at(-1)?.path ?? '', name),
      section,
      id: stack.at(-1)?.id ?? '',
      what: what === null ? null : lead(what),
      need: null,
      def: col('Default'),
      type: col('Value'),
      env: col('Variable'),
      flag: col('Flag'),
    })
  }
  return out
}

/** Every `##`–`######` heading outside a fence: its text, its id on schema.md as one page, its section. */
function headings(doc: string): Array<{ text: string; id: string; section: string }> {
  const out: Array<{ text: string; id: string; section: string }> = []
  const seen = new Map<string, number>()
  let fenced = false
  let section = ''
  for (const line of doc.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const h = fenced ? null : /^(#{2,6})\s+(.+?)\s*$/.exec(line)
    if (h === null) continue
    const base = slug(h[2]!)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    if (h[1]!.length === 2) section = h[2]!
    out.push({ text: h[2]!, id: n === 0 ? base : `${base}-${n}`, section })
  }
  return out
}

function firstParagraph(lines: readonly string[], from: number): string | null {
  let fenced = false
  const para: string[] = []
  for (let at = from; at < lines.length; at++) {
    const line = lines[at]!
    if (/^#{1,6}\s/.test(line) && !fenced) break
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      if (para.length > 0) break
      continue
    }
    if (fenced) continue
    if (line.trim() === '' || /^\s*(\||<!--|>|[-*] )/.test(line)) {
      if (para.length > 0) break
      continue
    }
    para.push(line)
  }
  return para.length === 0 ? null : lead(para.join(' '))
}

/** What the validator says a field must be, from its refusal: `a duration like '500ms', …`. */
export function typeOf(cases: Record<string, string[]> | undefined): string | null {
  for (const message of Object.keys(cases ?? {})) {
    const m = / must be (.+)$/.exec(message)
    if (m === null) continue
    return m[1]!
      .replace(/ \(got .*\)$/, '')
      .replace(/ — .*$/, '')
      .replace(/ \(or omitted\)$/, '')
      .replace(/ \(fields: .*\)$/, '')
      .trim()
  }
  return null
}

/** The story's files: what each field holds, and whether the story sets it. */
const PROJECT_VALUES: Record<string, string> = {
  name: "'@demo/web'",
  tags: "['scope:web']",
  'tasks.*.description': "'Bundle the app with Vite'",
  'tasks.*.dependsOn': "['^build']",
  'tasks.*.exec.command': "'vite build'",
  'tasks.*.exec.remote': 'false',
  'tasks.*.exec.timeout': "'10m'",
  'tasks.*.exec.env.passThrough': "['CI']",
  'tasks.*.exec.env.define.*': "'production'",
  'tasks.*.exec.env.secret': "['NPM_TOKEN']",
  'tasks.*.exec.persistent.readyWhen': "'ready in'",
  'tasks.*.exec.sandbox.allow.read': "['../ui/dist/**']",
  'tasks.*.exec.sandbox.allow.write': "['dist/**']",
  'tasks.*.exec.sandbox.allow.network': "['registry.npmjs.org']",
  'tasks.*.exec.sandbox.allow.systemInfo': "['vfs.disk-space']",
  'tasks.*.exec.sandbox.allow.unixSockets': "['/var/run/docker.sock']",
  'tasks.*.exec.sandbox.allow.localBinding': '[5173]',
  'tasks.*.exec.sandbox.allow.machLookup': "['com.apple.SystemConfiguration.DNSConfiguration']",
  'tasks.*.exec.sandbox.allow.pty': 'true',
  'tasks.*.exec.sandbox.allow.gitConfig': 'true',
  'tasks.*.exec.sandbox.deny.network': "['example.com']",
  'tasks.*.exec.sandbox.ignore.read': "['~/.npmrc']",
  'tasks.*.exec.sandbox.ignore.write': "['.cache/**']",
  'tasks.*.exec.sandbox.ignore.network': "['example.com']",
  'tasks.*.exec.sandbox.ignore.systemInfo': "['vfs.disk-space']",
  'tasks.*.exec.sandbox.weakerWhenNested': 'true',
  'tasks.*.exec.sandbox.weakerNetworkIsolation': 'true',
  'tasks.*.exec.sandbox.hermetic': 'true',
  'tasks.*.exec.interactive': 'true',
  'tasks.*.exec.platforms': "['linux-x64', 'darwin-arm64']",
  'tasks.*.exec.worker': "'ubuntu'",
  'tasks.*.exec.retries': '1',
  'tasks.*.inputs.files': "['src/**', 'vite.config.ts']",
  'tasks.*.inputs.workspaceFiles': "['.oxlintrc.json']",
  'tasks.*.inputs.env': "['MODE']",
  'tasks.*.inputs.tasks': "['^build']",
  'tasks.*.inputs.runtime': "['bun --version']",
  'tasks.*.inputs.workspaceRuntime': "['bun --version']",
  'tasks.*.inputs.stability.strategy': "'mutable'",
  'tasks.*.inputs.stability.severity': "'error'",
  'tasks.*.outputs.files': "['dist/**']",
  'tasks.*.outputs.workspaceFiles': "['coverage/web/**']",
  'tasks.*.outputs.clean': 'false',
  'tasks.*.cache': 'true',
}
const PROJECT_SET = new Set([
  'name',
  'tasks',
  'tasks.*',
  'tasks.*.dependsOn',
  'tasks.*.exec',
  'tasks.*.exec.command',
  'tasks.*.inputs',
  'tasks.*.inputs.files',
  'tasks.*.outputs',
  'tasks.*.outputs.files',
  'tasks.*.cache',
])

const WORKSPACE_VALUES: Record<string, string> = {
  baseBranch: "'main'",
  'run.concurrency': "'50%'",
  'run.schedule': "'critical-path'",
  'run.timeout': "'10m'",
  'run.retries': '1',
  'run.failFast': 'true',
  'run.killGrace': "'10s'",
  'run.pluginTimeout': "'3s'",
  'run.logs.captureHead': "'8MiB'",
  'run.logs.captureTail': "'8MiB'",
  'run.logs.failedHead': "'8KiB'",
  'run.logs.failedTail': "'56KiB'",
  'run.secrets.minLength': '8',
  'run.rules.exclusiveOutputs': 'false',
  'run.rules.dependencies': "[{ from: 'tag:lib', deny: ['tag:app'] }]",
  'cache.dir': "'build/.vx-cache'",
  'cache.policy': "'local:rw,remote:r'",
  'cache.download': "'toplevel'",
  'cache.upload.failures': "'always'",
  'cache.store.embeddings': "'32KiB'",
  'cache.store.decompress': 'false',
  'cache.artifactCeiling': "'1GiB'",
  'cache.concurrency.download': '64',
  'cache.concurrency.upload': '64',
  'cache.concurrency.restore': '16',
  'inputs.stability.strategy': "'mutable'",
  'inputs.stability.severity': "'error'",
  'outputs.clean': 'false',
  'lock.reviewFiles': 'false',
  'watch.poll': 'true',
  'watch.debounce': "'300ms'",
  'watch.pollInterval': "'500ms'",
  'history.retention': "'60d'",
  'pipelines.*.tasks': "['lint', 'test', 'build']",
  'pipelines.*.filter': "['@demo/*']",
  'pipelines.*.affected': 'true',
  'pipelines.*.excludeDependencies': 'true',
  'pipelines.*.env.*': "'1'",
  'pipelines.*.concurrency': '4',
  'pipelines.*.schedule': "'critical-path'",
  'pipelines.*.failFast': 'true',
  'pipelines.*.retries': '1',
  'pipelines.*.timeout': "'20m'",
  'pipelines.*.branch': "'main'",
  'pipelines.*.cachePolicy': "'remote:r'",
  'pipelines.*.noCache': 'true',
  'pipelines.*.force': 'true',
  'pipelines.*.cacheDir': "'.vx/cache'",
  'pipelines.*.cacheDownload': "'none'",
  'pipelines.*.cacheConcurrencyDownload': '32',
  'pipelines.*.cacheConcurrencyUpload': '32',
  'pipelines.*.cacheConcurrencyRestore': '8',
  'pipelines.*.outputLogs': "'errors-only'",
  'pipelines.*.verbosity': '1',
  'pipelines.*.profile': "'profile.json'",
  'pipelines.*.dry': 'true',
  'pipelines.*.format': "'json'",
  plugins: '[]',
}
const WORKSPACE_SET = new Set([
  'baseBranch',
  'run',
  'run.failFast',
  'pipelines',
  'pipelines.*',
  'pipelines.*.tasks',
  'pipelines.*.affected',
  'plugins',
])

/** The names the sample file gives a `*` key. */
const NAMES: Record<string, string> = {
  'tasks.*': 'build',
  'pipelines.*': 'pr',
  'tasks.*.exec.env.define.*': 'NODE_ENV',
  'pipelines.*.env.*': 'CI',
}

/** A value from the validator's accepted cases, for a field the story has no value for. */
function acceptedValue(cases: Record<string, string[]> | undefined): string | null {
  const ok = (cases?.['ok'] ?? []).filter((v) => !v.startsWith('<'))
  const v = ok.at(-1)
  return v === undefined ? null : v.replace(/"([^"'\\]*)"/g, "'$1'")
}

/** Every field path of one config, in the validator's declaration order. */
export function fieldPaths(record: SchemaRecord): string[] {
  const paths = Object.keys(record.fields)
  for (const [level, names] of Object.entries(record.levels))
    for (const name of names) {
      const p = level ? `${level}.${name}` : name
      if (!paths.includes(p)) paths.push(p)
    }
  return paths
}

const parentOf = (p: string): string => (p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '')

/** A config path as the reference names it: a task's fields without `tasks.*.`. */
const refPath = (config: Config, p: string): string =>
  config === 'project' ? p.replace(/^tasks\.\*\./, '') : p

/**
 * The anchors out of the generated `schema.md`'s forwarding script, which
 * maps each moved id to `page/#id` (scripts/import-docs.ts, splitReference).
 * The build cannot import that script: it reads `import.meta.dir`, which
 * only Bun defines, and astro loads a component through vite's runner.
 */
export function anchorsFromForward(page: string): Anchors {
  const m = /const m=(\{.*?\});const t=/.exec(page)
  if (m === null) throw new Error('ConfigExplorer: the generated schema.md has no forwarding map')
  const map = JSON.parse(m[1]!) as Record<string, string>
  return new Map(
    Object.entries(map).map(([from, to]) => {
      const [where, id] = to.split('#') as [string, string | undefined]
      const at = where.replace(/\/$/, '')
      return [from, id === undefined ? { page: at } : { page: at, id }]
    }),
  )
}

/** The site URL of a schema.md heading id. */
function hrefOf(id: string, anchors: Anchors, base: string): string {
  const root = `${base.replace(/\/?$/, '/')}schema/`
  const a = anchors.get(id)
  if (a === undefined) return `${root}#${id}`
  return `${root}${a.page === '' ? '' : `${a.page}/`}${a.id === undefined ? '' : `#${a.id}`}`
}

/** Every field of one config, each joined to its entry in the reference. */
export function buildFields(
  config: Config,
  record: SchemaRecord,
  doc: string,
  anchors: Anchors,
  base: string,
): Field[] {
  const all = referenceEntries(doc).filter((e) => configOf(e.section) === config)
  const entry = new Map<string, Entry>()
  for (const e of all) if (!entry.has(e.path)) entry.set(e.path, e)
  // A field with no entry links its nearest ancestor's, else the config's section.
  const sectionId = slug(
    config === 'workspace' ? 'Workspace config (`.vx/workspace.ts`)' : 'Project config',
  )
  // …or a heading that names its top key in words (`### Pipelines`).
  const titled = new Map(
    headings(doc)
      .filter((h) => configOf(h.section) === config)
      .map((h) => [h.text.toLowerCase(), h.id]),
  )
  const values = config === 'project' ? PROJECT_VALUES : WORKSPACE_VALUES
  const set = config === 'project' ? PROJECT_SET : WORKSPACE_SET
  const paths = fieldPaths(record)
  const kids = new Map<string, string[]>()
  for (const p of paths) {
    const parent = parentOf(p)
    if (parent !== '') kids.set(parent, [...(kids.get(parent) ?? []), p])
  }
  return paths.map((path) => {
    const own = entry.get(refPath(config, path))
    let near = own
    for (let p = parentOf(path); near === undefined && p !== ''; p = parentOf(p))
      near = entry.get(refPath(config, p))
    const children = kids.get(path) ?? []
    const value =
      children.length > 0
        ? '{'
        : (values[path] ?? acceptedValue(record.fields[path]) ?? 'undefined')
    return {
      path,
      key: NAMES[path] ?? path.slice(path.lastIndexOf('.') + 1),
      parent: parentOf(path),
      kids: children,
      value,
      set: set.has(path),
      type: own?.type ?? typeOf(record.fields[path]),
      def: own?.def ?? null,
      need: own?.need ?? null,
      what: own?.what ?? null,
      env: own?.env ?? null,
      flag: own?.flag ?? null,
      href: hrefOf(near?.id ?? titled.get(path.split('.')[0]!) ?? sectionId, anchors, base),
    }
  })
}

export const configOfArea = (area: Area): Config => (area === 'workspace' ? 'workspace' : 'project')

/** How the panel names a field: a task's fields from the task down (`exec.timeout`). */
function displayPath(fields: readonly Field[], path: string): string {
  const byPath = new Map(fields.map((f) => [f.path, f]))
  const parts: string[] = []
  for (let p = path; p !== ''; p = byPath.get(p)?.parent ?? '') {
    if (p === 'tasks.*' && path !== p) break
    parts.unshift(byPath.get(p)?.key ?? p)
  }
  return parts.join('.')
}

/**
 * The field a prop or a search names: a full path (`tasks.*.exec.timeout`),
 * a task-relative one (`exec.timeout`), or one with the sample's names
 * (`pipelines.pr.failFast`).
 */
export function resolveField(fields: readonly Field[], query: string): string | undefined {
  const q = query.trim().replace(/^\.+|\.+$/g, '')
  if (q === '') return undefined
  const byPath = new Map(fields.map((f) => [f.path, f]))
  const top = fields.filter((f) => f.parent === '').map((f) => f.path)
  const last = (p: string) => p.slice(p.lastIndexOf('.') + 1)
  for (const full of [q, `tasks.*.${q}`]) {
    let at = ''
    for (const part of full.split('.')) {
      const kids = at === '' ? top : (byPath.get(at)?.kids ?? [])
      const next = kids.find((k) => last(k) === part) ?? kids.find((k) => last(k) === '*')
      if (next === undefined) {
        at = ''
        break
      }
      at = next
    }
    if (at !== '') return at
  }
  return undefined
}

/** The fields a search finds, best first: a key, a path, a variable or a flag that holds the words. */
export function search(rows: readonly Row[], query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase().replace(/^-+/, '')
  if (q === '') return []
  const scored: Array<[number, number, string]> = []
  rows.forEach((r, i) => {
    const key = r.key.toLowerCase()
    const shown = r.shown.toLowerCase()
    const extra = `${r.env ?? ''} ${r.flag ?? ''}`.toLowerCase()
    const score =
      key === q || shown === q
        ? 0
        : key.startsWith(q)
          ? 1
          : shown.includes(q)
            ? 2
            : extra.includes(q)
              ? 3
              : -1
    if (score >= 0) scored.push([score, i, r.path])
  })
  return scored
    .sort((x, y) => x[0] - y[0] || x[1] - y[1])
    .slice(0, limit)
    .map(([, , p]) => p)
}

/** A one-field example, nested from the top of the file, or of the task. */
function exampleOf(fields: readonly Field[], path: string): string {
  const byPath = new Map(fields.map((f) => [f.path, f]))
  const f = byPath.get(path)!
  let body: string
  if (f.kids.length > 0) {
    const kid = f.kids.map((k) => byPath.get(k)!).find((k) => k.set) ?? byPath.get(f.kids[0]!)!
    body = `${f.key}: { ${kid.key}: ${kid.kids.length > 0 ? '{ … }' : kid.value} }`
  } else body = `${f.key}: ${f.value}`
  for (
    let p = f.parent;
    p !== '' && !(p === 'tasks.*' && path.startsWith('tasks.*.'));
    p = byPath.get(p)!.parent
  )
    body = `${byPath.get(p)!.key}: { ${body} }`
  return body
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Escaped text with the reference's `code` and _emphasis_ kept. */
function inline(md: string): string {
  return esc(md)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>')
}

/**
 * The sample file as HTML: one line per field, every key a button, a
 * field the story leaves unset commented out, a group's fields and close
 * in a block a fold button hides.
 */
export function renderFile(fields: readonly Field[], config: Config, selected: string): string {
  const byPath = new Map(fields.map((f) => [f.path, f]))
  // A wrapped line hangs 2ch under its key; the gutter holds a fold button.
  const line = (depth: number, body: string, cls = '') =>
    `<div class="cx-line${cls}" style="padding-inline-start:${depth * 2 + 4.5}ch">${body}</div>`
  const key = (f: Field) =>
    `<button type="button" class="cx-key" data-path="${esc(f.path)}" aria-pressed="${f.path === selected}">${esc(f.key)}</button>`
  const walk = (f: Field, depth: number): string => {
    const off = f.set ? '' : '<span class="cx-c">// </span>'
    const cls = `${f.set ? '' : ' is-off'}${f.path === selected ? ' is-on' : ''}`
    if (f.kids.length === 0)
      return line(depth, `${off}${key(f)}: <span class="cx-v">${esc(f.value)}</span>,`, cls)
    const fold = `<button type="button" class="cx-fold" aria-expanded="true" aria-label="Fold ${esc(f.key)}" hidden></button>`
    return (
      line(
        depth,
        `${fold}${off}${key(f)}: {<span class="cx-more" hidden> … },</span>`,
        `${cls} is-open`,
      ) +
      `<div class="cx-group" data-group="${esc(f.path)}">` +
      f.kids.map((k) => walk(byPath.get(k)!, depth + 1)).join('') +
      line(depth, `${off}},`, f.set ? '' : ' is-off') +
      '</div>'
    )
  }
  const define = config === 'project' ? 'defineProject' : 'defineWorkspace'
  return [
    line(
      0,
      `<span class="cx-k">import</span> { ${define} } <span class="cx-k">from</span> <span class="cx-v">'@vzn/vx/config'</span>`,
    ),
    line(0, ''),
    line(0, `<span class="cx-k">export default</span> ${define}({`),
    ...fields.filter((f) => f.parent === '').map((f) => walk(f, 1)),
    line(0, '})'),
  ].join('')
}

/** The panel for one field: what it does, its type, default, an example, its link. */
export function renderPanel(row: Row): string {
  const facts: Array<[string, string]> = []
  if (row.type !== null) facts.push(['Type', inline(row.type)])
  if (row.def !== null) facts.push(['Default', inline(row.def)])
  if (row.env !== null) facts.push(['Variable', inline(row.env)])
  if (row.flag !== null) facts.push(['Flag', inline(row.flag)])
  const kid = ([path, key]: [string, string]) =>
    `<button type="button" class="cx-kid" data-path="${esc(path)}">${esc(key)}</button>`
  return [
    `<p class="cx-name"><code>${esc(row.shown)}</code>${row.need === null ? '' : ` <span class="is-muted">${esc(row.need)}</span>`}</p>`,
    row.what === null ? '' : `<p class="cx-what">${inline(row.what)}</p>`,
    facts.length === 0
      ? ''
      : `<dl class="cx-facts">${facts.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join('')}</dl>`,
    `<pre class="cx-ex"><code>${esc(row.example)}</code></pre>`,
    row.kids.length === 0 ? '' : `<p class="cx-inside">Inside: ${row.kids.map(kid).join(' ')}</p>`,
    `<p class="cx-ref"><a ${attr('href', row.href)}>${row.what === null ? 'Explained in the config reference' : 'Full entry in the config reference'} →</a></p>`,
  ].join('')
}

/** The field a fresh widget opens on. */
export function defaultField(fields: readonly Field[], area: Area, field?: string): string {
  const wanted =
    field ?? (area === 'workspace' ? 'run.failFast' : area === 'task' ? 'inputs.files' : 'name')
  const found = resolveField(fields, wanted)
  if (found === undefined)
    throw new Error(`<ConfigExplorer field="${wanted}">: no such ${configOfArea(area)} field`)
  return found
}

/** What the element reads per field: everything its panel and search need. */
export interface Row {
  path: string
  key: string
  shown: string
  kids: Array<[path: string, key: string]>
  type: string | null
  def: string | null
  need: string | null
  what: string | null
  env: string | null
  flag: string | null
  href: string
  example: string
}

export function rows(fields: readonly Field[]): Row[] {
  const byPath = new Map(fields.map((f) => [f.path, f]))
  return fields.map((f) => ({
    path: f.path,
    key: f.key,
    shown: displayPath(fields, f.path),
    kids: f.kids.map((k) => [k, byPath.get(k)!.key]),
    type: f.type,
    def: f.def,
    need: f.need,
    what: f.what,
    env: f.env,
    flag: f.flag,
    href: f.href,
    example: exampleOf(fields, f.path),
  }))
}

// The site's link check reads every literal `href="…"` in shipped HTML and
// JS; built through a name, the browser's copy of this template is not one.
function attr(name: string, value: string): string {
  return `${name}="${esc(value)}"`
}
