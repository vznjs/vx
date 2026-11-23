// The glob tester's model: which files of the story workspace a task's
// `inputs.files` or `outputs.files` take, as vx decides it. Pure: no DOM. The
// view helpers at the bottom return HTML strings, so the build-time render and
// the live one are the same code.
//
// Rules and where they come from (packages/vx):
// - A glob is project-relative and matched as a task glob: `*`, `?`, `**`,
//   `{a,b}` (expanded first), `[ab]` classes (util/paths.ts, regExpSource,
//   compileTaskGlob). A negated class never takes `/` (rewriteGlob).
// - A literal names a file or a whole tree: `src` is `src` + `src/**`
//   (util/paths.ts, asTrees). Spelling is normalized: `./`, `//`, trailing `/`
//   (normalizeGlob).
// - `!` takes paths back (cache/inputs.ts, filesPlan; util/paths.ts,
//   splitNegations).
// - `..` segments, absolute paths and a glob naming the project dir itself are
//   refused by the config check (workspace/config-schema.ts).
// - Inputs filter what git lists, so a broad glob never reaches a gitignored
//   file. A literal does, and so does a glob whose fixed prefix git lists
//   nothing under (`dist/**`) (cache/inputs.ts, reachOf / unanswered;
//   docs/caching.md). A wildcard that matches an ignored file directly leaves
//   it out and vx names it (util/git-ignored.ts, ignoredInputLine).
// - A task's own outputs are never its inputs (cache/inputs.ts, ownOutput).
// - vx's own files are never inputs (cache/inputs.ts, ALWAYS_IGNORE).
// - Outputs match what is on disk; `node_modules` only when a glob names it,
//   and never `.git`, `.vx`, `vx.lock.json` (util/paths.ts, outputExcluded).
// - Missing outputs: see outputRequired.

export type Mode = 'inputs' | 'outputs'

export const PROJECTS: Record<string, string> = {
  '@demo/ui': 'packages/ui',
  '@demo/web': 'packages/web',
  '@demo/admin': 'packages/admin',
  '@demo/api': 'packages/api',
}

/** Every file of the story workspace, root-relative. */
export const WORKSPACE_FILES: readonly string[] = [
  '.gitignore',
  '.vx/workspace.ts',
  'bun.lock',
  'package.json',
  'packages/admin/dist/index.html',
  'packages/admin/package.json',
  'packages/admin/src/index.ts',
  'packages/admin/vite.config.ts',
  'packages/admin/vx.config.ts',
  'packages/api/dist/index.js',
  'packages/api/package.json',
  'packages/api/src/index.ts',
  'packages/api/vite.config.ts',
  'packages/api/vx.config.ts',
  'packages/ui/dist/index.js',
  'packages/ui/dist/style.css',
  'packages/ui/package.json',
  'packages/ui/src/Button.test.tsx',
  'packages/ui/src/Button.tsx',
  'packages/ui/src/index.ts',
  'packages/ui/vite.config.ts',
  'packages/ui/vx.config.ts',
  'packages/web/.env',
  'packages/web/README.md',
  'packages/web/dist/assets/index-7C0y1bbr.js',
  'packages/web/dist/index.html',
  'packages/web/index.html',
  'packages/web/node_modules/vite/package.json',
  'packages/web/package.json',
  'packages/web/src/App.test.tsx',
  'packages/web/src/App.tsx',
  'packages/web/src/index.ts',
  'packages/web/src/styles.css',
  'packages/web/vite.config.ts',
  'packages/web/vx.config.ts',
]

/** The root `.gitignore`: `dist`, `node_modules`, `.env`. */
const GITIGNORE = ['dist', 'node_modules', '.env']

export function isIgnored(rootRel: string): boolean {
  return rootRel.split('/').some((seg) => GITIGNORE.includes(seg))
}

/** Ignored because a directory above it is, not by its own name. */
function underIgnoredDir(rootRel: string): boolean {
  return rootRel
    .split('/')
    .slice(0, -1)
    .some((seg) => GITIGNORE.includes(seg))
}

export const DEFAULT_PATTERNS: Record<Mode, string[]> = {
  inputs: ['src/**', 'vite.config.ts'],
  outputs: ['dist/**'],
}

/** The build task's outputs in every story project. */
const OWN_OUTPUTS = ['dist/**']

export function projectFiles(project: string): string[] {
  const dir = PROJECTS[project]!
  return WORKSPACE_FILES.filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1))
}

/** What the build writes: everything under `dist/`. */
export function buildWrites(project: string): string[] {
  return projectFiles(project).filter((f) => f.startsWith('dist/'))
}

// ---------------------------------------------------------------- globs

const WILDCARDS = /[*?{}[\]\\]/

export function isLiteralPattern(glob: string): boolean {
  return !WILDCARDS.test(glob)
}

export function normalizeGlob(glob: string): string {
  const neg = glob.startsWith('!')
  let g = neg ? glob.slice(1) : glob
  g = g.replace(/\/{2,}/g, '/').replace(/(^|\/)(\.\/)+/g, '$1')
  if (g.endsWith('/.')) g = g.slice(0, -1)
  if (g === '.') g = ''
  if (WILDCARDS.test(g) && g.endsWith('/')) g = `${g.replace(/\/+$/, '')}/**`
  return neg ? `!${g}` : g
}

/** `{a,b}` expanded, nested groups included; an unclosed brace is text. */
export function braceAlternatives(pattern: string): string[] {
  let open = -1
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') i++
    else if (pattern[i] === '{') {
      open = i
      break
    }
  }
  if (open === -1) return [pattern]
  let depth = 0
  const commas: number[] = []
  let close = -1
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') i++
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      close = i
      break
    } else if (c === ',' && depth === 1) commas.push(i)
  }
  if (close === -1) return [pattern]
  const head = pattern.slice(0, open)
  const tail = pattern.slice(close + 1)
  const cuts = [open, ...commas, close]
  const out: string[] = []
  for (let k = 0; k < cuts.length - 1; k++) {
    for (const alt of braceAlternatives(pattern.slice(cuts[k]! + 1, cuts[k + 1])))
      out.push(...braceAlternatives(head + alt + tail))
  }
  return out
}

/** A literal names itself and its subtree (util/paths.ts, asTrees). */
export function asTrees(patterns: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of patterns) {
    for (const alt of braceAlternatives(raw)) {
      const p = normalizeGlob(alt)
      const lit = literalPath(p)
      if (lit === null) {
        out.push(p)
        continue
      }
      const bare = p.replace(/\/+$/, '')
      if (bare.length > 0) out.push(bare, `${bare}/**`)
    }
  }
  return [...new Set(out)]
}

function literalPath(glob: string): string | null {
  if (isLiteralPattern(glob)) return glob
  return isLiteralPattern(glob.replace(/\\./g, '_')) ? glob.replace(/\\(.)/g, '$1') : null
}

/** The leading wildcard-free directory of a glob; `.` when there is none. */
export function staticPrefix(glob: string): string {
  const g = normalizeGlob(glob)
  const at = g.search(WILDCARDS)
  if (at === -1) return g.replace(/\/+$/, '')
  const slash = g.slice(0, at).lastIndexOf('/')
  return slash === -1 ? '.' : g.slice(0, slash) || '/'
}

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|/]/g

function segmentSource(seg: string): string {
  let out = ''
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!
    if (c === '\\' && i + 1 < seg.length) out += seg[++i]!.replace(REGEXP_SYNTAX, '\\$&')
    else if (c === '*') {
      while (seg[i + 1] === '*') i++
      out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if (c === '[') {
      let body = i + 1
      const negated = seg[body] === '!' || seg[body] === '^'
      if (negated) body++
      let end = seg[body] === ']' ? body + 1 : body
      while (end < seg.length && seg[end] !== ']') end += seg[end] === '\\' ? 2 : 1
      if (end >= seg.length) {
        out += '\\['
        continue
      }
      const members = seg
        .slice(body, end)
        .replace(/\\(.)/g, '$1')
        .replace(/[\\\]^]/g, '\\$&')
      out += negated ? `[^/${members}]` : `[${members}]`
      i = end
    } else out += c.replace(REGEXP_SYNTAX, '\\$&')
  }
  return out
}

function globSource(pattern: string): string {
  const segments = pattern.split('/')
  let out = ''
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    if (seg === '**') {
      if (segments[i - 1] === '**') continue
      // Zero or more whole directories; at the end, one or more names, so
      // `src/**` does not match `src` itself.
      if (segments.length === 1) out += '[^]*'
      else if (i === segments.length - 1) out += '/[^]+'
      else out += i === 0 ? '(?:[^]*/)?' : '/(?:[^]*/)?'
      continue
    }
    if (i > 0 && segments[i - 1] !== '**') out += '/'
    out += segmentSource(seg)
  }
  return out
}

const compiled = new Map<string, (rel: string) => boolean>()

/** A task glob as a predicate over project-relative paths. */
export function compileGlob(pattern: string): (rel: string) => boolean {
  let fn = compiled.get(pattern)
  if (fn === undefined) {
    const res = braceAlternatives(pattern).map((alt) => new RegExp(`^${globSource(alt)}$`, 'u'))
    fn = (rel) => res.some((re) => re.test(rel))
    compiled.set(pattern, fn)
  }
  return fn
}

/** Whether any of the patterns, each read as a tree when literal, takes `rel`. */
function anyTree(patterns: readonly string[]): (rel: string) => boolean {
  const fns = asTrees(patterns).map(compileGlob)
  return (rel) => fns.some((f) => f(rel))
}

// ---------------------------------------------------------------- refusals

export function parsePatterns(text: string): string[] {
  return text
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/,$/, '')
        .replace(/^(['"`])(.*)\1$/, '$2')
        .trim(),
    )
    .filter((l) => l.length > 0)
}

/** Why the config check refuses an entry, as vx words it, or undefined. */
export function refusal(entry: string, mode: Mode): string | undefined {
  const g = entry.startsWith('!') ? entry.slice(1) : entry
  const field = `${mode}.files`
  if (g.startsWith('/')) return `${field}: absolute paths are not allowed`
  if (g.split(/[/{},]/).some((seg) => seg === '..'))
    return mode === 'inputs'
      ? `${field}: '..' path segments are not allowed — inputs must be project-relative (use inputs.workspaceFiles for workspace-root-relative inputs)`
      : `${field}: '..' path segments are not allowed — a glob that escapes the project would delete files outside it`
  if (!entry.startsWith('!') && normalizeGlob(g) === '')
    return `${field}: "${entry}" names the project directory itself and selects nothing — use "**" for everything under it`
  return undefined
}

// ---------------------------------------------------------------- inputs

/** vx's own files, never task inputs (cache/inputs.ts, ALWAYS_IGNORE). */
const ALWAYS_IGNORE = [
  '.git/**',
  '.vx/cache/**',
  '.vx/projects.lock',
  'vx.lock.json',
  '.vx/.gitattributes',
  '.vx/.gitignore',
  '.vx/dependencies.lock',
  '.vx/tmp/**',
]

export interface InputPattern {
  pattern: string
  kind: 'take' | 'leave-out' | 'refused'
  /** Files this entry adds (take) or removes (leave-out) from the final set. */
  files: string[]
  refusal?: string
  /** Gitignored files it reached because it names them outright. */
  ignoredReached: string[]
  /** Gitignored files it matches but leaves out; vx names each. */
  ignoredLeftOut: string[]
  /** Files it matches that are the task's own outputs. */
  ownOutputs: string[]
}

export interface InputResult {
  files: string[]
  patterns: InputPattern[]
  refused: boolean
}

export function resolveInputs(
  project: string,
  entries: readonly string[],
  ownOutputs: readonly string[] = OWN_OUTPUTS,
): InputResult {
  const dir = PROJECTS[project]!
  const all = projectFiles(project)
  const ignored = (rel: string) => isIgnored(`${dir}/${rel}`)
  const listed = all.filter((f) => !ignored(f))
  const gitListsUnder = (p: string) => listed.some((f) => f === p || f.startsWith(`${p}/`))
  const vxOwn = compileAnyPlain(ALWAYS_IGNORE)
  const isOwnOutput = outputMatcher(ownOutputs)

  const negatives = entries.filter((e) => e.startsWith('!') && refusal(e, 'inputs') === undefined)
  const takenBack = anyTree(negatives.map((e) => e.slice(1)))

  const rows: InputPattern[] = []
  const chosen = new Set<string>()
  const reachedAll = new Set<string>()
  for (const entry of entries) {
    const why = refusal(entry, 'inputs')
    const row: InputPattern = {
      pattern: entry,
      kind: why !== undefined ? 'refused' : entry.startsWith('!') ? 'leave-out' : 'take',
      files: [],
      ignoredReached: [],
      ignoredLeftOut: [],
      ownOutputs: [],
      ...(why !== undefined ? { refusal: why } : {}),
    }
    rows.push(row)
    if (row.kind !== 'take') continue
    const reached = new Set<string>()
    for (const tree of asTrees([entry])) {
      const match = compileGlob(tree)
      const named = isLiteralPattern(tree) ? tree : staticPrefix(tree)
      // An entry whose fixed head git lists nothing under is walked on disk.
      const walkDisk = named !== '.' && named !== '' && !gitListsUnder(named)
      for (const f of all) {
        if (!match(f)) continue
        if (!ignored(f)) reached.add(f)
        else if (walkDisk) {
          reached.add(f)
          if (!row.ignoredReached.includes(f)) row.ignoredReached.push(f)
        } else if (!underIgnoredDir(`${dir}/${f}`) && !row.ignoredLeftOut.includes(f))
          row.ignoredLeftOut.push(f)
      }
    }
    for (const f of reached) {
      reachedAll.add(f)
      if (vxOwn(f) || takenBack(f)) continue
      if (isOwnOutput(f)) {
        row.ownOutputs.push(f)
        continue
      }
      if (!chosen.has(f)) row.files.push(f)
      chosen.add(f)
    }
    row.ignoredReached = row.ignoredReached.filter((f) => !isOwnOutput(f) && !takenBack(f))
  }
  // What each `!` entry took: files a positive entry reached that it removes.
  for (const r of rows) {
    if (r.kind !== 'leave-out') continue
    const m = anyTree([r.pattern.slice(1)])
    r.files = [...reachedAll].filter((f) => m(f) && !isOwnOutput(f) && !vxOwn(f)).sort()
  }
  const refused = rows.some((r) => r.kind === 'refused')
  return { files: refused ? [] : [...chosen].sort(), patterns: rows, refused }
}

function compileAnyPlain(patterns: readonly string[]): (rel: string) => boolean {
  const fns = patterns.map(compileGlob)
  return (rel) => fns.some((f) => f(rel))
}

/** A path is an output when a positive glob takes it and no `!` takes it back. */
export function outputMatcher(globs: readonly string[]): (rel: string) => boolean {
  const pos = anyTree(globs.filter((g) => !g.startsWith('!')))
  const neg = anyTree(globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1)))
  return (rel) => pos(rel) && !neg(rel)
}

// ---------------------------------------------------------------- outputs

/**
 * Whether an output entry must match something on its own once the command
 * exits 0: a literal path (`dist/index.js`, `dist`) is; a wildcard (`dist/**`)
 * may match nothing, but only beside an entry that matched
 * (orchestrator/attempt-outputs.ts, outputMatches / missingOutputs).
 */
export function outputRequired(pattern: string): boolean {
  return literalPath(normalizeGlob(pattern)) !== null
}

export interface OutputPattern {
  pattern: string
  kind: 'found' | 'optional' | 'missing' | 'leave-out' | 'refused'
  files: string[]
  refusal?: string
}

export interface OutputResult {
  patterns: OutputPattern[]
  /** What the cache saves; empty when the task fails. */
  saved: string[]
  failed: boolean
  missing: string[]
}

/** What no output glob reaches (util/paths.ts, OUTPUT_NEVER, outputExcluded). */
function outputExcluded(globs: readonly string[]): (rel: string) => boolean {
  const never = compileAnyPlain(['.git/**', '.vx/**', 'vx.lock.json'])
  const namesNodeModules = globs.some(
    (g) => !g.startsWith('!') && normalizeGlob(g).split('/').includes('node_modules'),
  )
  const installed = compileGlob('**/node_modules/**')
  return (rel) => never(rel) || (!namesNodeModules && installed(rel))
}

export function resolveOutputs(
  project: string,
  entries: readonly string[],
  written: ReadonlySet<string>,
): OutputResult {
  const built = new Set(buildWrites(project))
  const onDisk = projectFiles(project).filter((f) => !built.has(f) || written.has(f))
  const exists = (p: string) => onDisk.some((f) => f === p || f.startsWith(`${p}/`))
  const negatives = entries.filter((e) => e.startsWith('!') && refusal(e, 'outputs') === undefined)
  const takenBack = anyTree(negatives.map((e) => e.slice(1)))
  const valid = entries.filter((e) => refusal(e, 'outputs') === undefined)
  const excluded = outputExcluded(valid)
  const isOutput = outputMatcher(valid)

  const patterns: OutputPattern[] = entries.map((entry) => {
    const why = refusal(entry, 'outputs')
    if (why !== undefined) return { pattern: entry, kind: 'refused', files: [], refusal: why }
    if (entry.startsWith('!')) {
      const m = anyTree([entry.slice(1)])
      return { pattern: entry, kind: 'leave-out', files: onDisk.filter(m) }
    }
    const m = anyTree([entry])
    const files = onDisk.filter((f) => m(f) && !takenBack(f) && !excluded(f))
    // A literal is satisfied by the directory it names (attempt-outputs.ts).
    const lit = literalPath(normalizeGlob(entry))
    const found = files.length > 0 || (lit !== null && !takenBack(lit) && exists(lit))
    const kind = found ? 'found' : outputRequired(entry) ? 'missing' : 'optional'
    return { pattern: entry, kind, files }
  })
  // A task that declares outputs must write one: when no positive entry
  // matched, every one is missing, literals first (missingOutputs).
  const positive = patterns.filter((p) => p.kind !== 'leave-out' && p.kind !== 'refused')
  if (positive.length > 0 && positive.every((p) => p.kind !== 'found'))
    for (const p of positive) p.kind = 'missing'
  const missing = [
    ...positive.filter((p) => p.kind === 'missing' && outputRequired(p.pattern)),
    ...positive.filter((p) => p.kind === 'missing' && !outputRequired(p.pattern)),
  ].map((p) => p.pattern)
  const failed = missing.length > 0 || patterns.some((p) => p.kind === 'refused')
  const saved = failed ? [] : onDisk.filter((f) => isOutput(f) && !excluded(f))
  return { patterns, saved, failed, missing }
}

/** The warning vx prints when outputs are missing (orchestrator/attempt.ts). */
function missingOutputsLine(task: string, missing: readonly string[]): string {
  const it = missing.length === 1 ? 'it' : 'them'
  return (
    `[vx] ${task}: outputs matched no files (${missing.join(', ')}) — the command exited 0 ` +
    `but never wrote ${it}, so the task fails and nothing is cached: write ${it}, or fix the pattern`
  )
}

/** The task row's label (report/events.ts, missingOutputsReason). */
export function missingOutputsLabel(missing: readonly string[]): string {
  return `failed (exited 0, no file matched ${missing.join(', ')})`
}

/** The miss warning when no input matched (orchestrator/miss-inputs.ts). */
function noInputsLine(task: string, entries: readonly string[]): string {
  return `[vx] ${task}: inputs matched no files (${entries.join(', ')}) — the key will not change when this project's source does`
}

/** The note for an ignored file a wildcard left out (util/git-ignored.ts). */
export function ignoredInputLine(task: string, rel: string, glob: string): string {
  return (
    `${task}: inputs leave out git-ignored ${rel} (matched by ${glob}) — ` +
    `a glob reads only what git lists; name it as a literal input ('${rel}') to key on it`
  )
}

// ---------------------------------------------------------------- view

export function esc(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

export interface ViewState {
  mode: Mode
  project: string
  entries: string[]
  /** Outputs mode: the build files the reader says the build wrote. */
  written: ReadonlySet<string>
  /** The build-time render: checkboxes do nothing without JavaScript. */
  still?: boolean
}

export interface View {
  patterns: string
  tree: string
  terminal: string
  say: string
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

function taskHtml(task: string): string {
  const [p, t] = task.split('#')
  return `<b class="is-accent">${esc(p!)}</b><span class="is-muted">#</span><b class="is-accent">${esc(t!)}</b>`
}

export function render(state: ViewState): View {
  return state.mode === 'inputs' ? renderInputs(state) : renderOutputs(state)
}

function renderInputs({ project, entries }: ViewState): View {
  const task = `${project}#build`
  const r = resolveInputs(project, entries)
  const rows = r.patterns.map((p) => {
    const code = `<code>${esc(p.pattern)}</code>`
    const notes: string[] = []
    let head: string
    if (p.kind === 'refused') {
      head = `<span class="is-danger">✗</span> ${code} <span class="is-danger">refused</span>`
      notes.push(esc(p.refusal!))
      if (p.pattern.includes('..'))
        notes.push(
          'A project never reads another one through globs. Depend on its <code>build</code> instead.',
        )
    } else if (p.kind === 'leave-out') {
      head = `<span class="is-muted">−</span> ${code} leaves out ${plural(p.files.length, 'file')}`
    } else if (p.files.length === 0 && p.ownOutputs.length === 0) {
      head = `<span class="is-warn">○</span> ${code} <span class="is-warn">matches nothing</span>`
    } else {
      head = `<span class="is-ok">✓</span> ${code} takes ${plural(p.files.length, 'file')}`
    }
    for (const f of p.ignoredReached)
      notes.push(`Takes gitignored <code>${esc(f)}</code>: the entry names it outright.`)
    for (const f of p.ignoredLeftOut)
      notes.push(
        `Skips gitignored <code>${esc(f)}</code>. A wildcard sees only what git lists. Write <code>${esc(f)}</code> on its own line to include it.`,
      )
    if (p.ownOutputs.length > 0)
      notes.push(
        `Skips ${plural(p.ownOutputs.length, 'file')} in <code>dist/</code>: this task writes them, so they are never its inputs.`,
      )
    return patternRow(head, notes, p.kind === 'refused' ? 'is-refused' : '')
  })
  const hit = new Set(r.files)
  const ownOut = new Set(r.patterns.flatMap((p) => p.ownOutputs))
  const left = new Set(r.patterns.flatMap((p) => (p.kind === 'leave-out' ? p.files : [])))
  const tree = treeHtml(project, (rel) => {
    if (hit.has(rel)) return { cls: 'is-hit', tag: '' }
    if (left.has(rel)) return { cls: 'is-left', tag: 'left out' }
    if (ownOut.has(rel)) return { cls: '', tag: 'output' }
    return { cls: '', tag: '' }
  })
  const lines: string[] = []
  const positive = entries.filter((e) => !e.startsWith('!'))
  let say: string
  if (r.refused) {
    say = 'vx refuses this config, so nothing runs. Fix the red line.'
  } else if (r.files.length === 0) {
    say = 'No file feeds the cache key. An edit would never re-run the task.'
    if (positive.length > 0) lines.push(warnLine(noInputsLine(task, positive)))
  } else {
    say = `${plural(r.files.length, 'file')} feed${r.files.length === 1 ? 's' : ''} the cache key of ${task}. Change one, and the task runs again.`
    for (const p of r.patterns)
      for (const f of p.ignoredLeftOut) lines.push(warnLine(ignoredInputLine(task, f, p.pattern)))
  }
  return {
    patterns: rows.join(''),
    tree,
    terminal: lines.join('\n'),
    say,
  }
}

function renderOutputs({ project, entries, written, still = false }: ViewState): View {
  const task = `${project}#build`
  const r = resolveOutputs(project, entries, written)
  const rows = r.patterns.map((p) => {
    const code = `<code>${esc(p.pattern)}</code>`
    const literal = outputRequired(p.pattern)
    const kindWord = literal ? 'literal, required' : 'wildcard'
    switch (p.kind) {
      case 'refused':
        return patternRow(
          `<span class="is-danger">✗</span> ${code} <span class="is-danger">refused</span>`,
          [esc(p.refusal!)],
          'is-refused',
        )
      case 'leave-out':
        return patternRow(
          `<span class="is-muted">−</span> ${code} keeps ${plural(p.files.length, 'file')} out of the cache`,
          [],
        )
      case 'found':
        return patternRow(
          `<span class="is-ok">✓</span> ${code} found <span class="is-muted">· ${kindWord}</span>`,
          [],
        )
      case 'optional':
        return patternRow(
          `<span class="is-muted">○</span> ${code} matched nothing <span class="is-muted">· ${kindWord}, fine</span>`,
          ['Another output matched, so this one may stay empty.'],
        )
      case 'missing':
        return patternRow(
          `<span class="is-danger">✗</span> ${code} <span class="is-danger">missing</span> <span class="is-muted">· ${kindWord}</span>`,
          [
            literal
              ? 'A literal path must exist. The build never wrote it, so the task fails.'
              : 'No output matched at all. A task with outputs must write at least one.',
          ],
          'is-refused',
        )
    }
  })
  const saved = new Set(r.saved)
  const built = new Set(buildWrites(project))
  const tree = treeHtml(
    project,
    (rel) => {
      if (saved.has(rel)) return { cls: 'is-hit', tag: '' }
      if (built.has(rel) && !written.has(rel)) return { cls: 'is-gone', tag: 'not written' }
      return { cls: '', tag: '' }
    },
    built,
    written,
    still,
  )
  const head = `<span class="is-muted">┌─</span> ${taskHtml(task)} <span class="is-muted">&gt;</span> $ vite build`
  const lines = [head]
  let say: string
  if (r.patterns.some((p) => p.kind === 'refused')) {
    lines.length = 0
    say = 'vx refuses this config, so nothing runs. Fix the red line.'
  } else if (r.failed) {
    lines.push(warnLine(missingOutputsLine(task, r.missing)))
    lines.push(
      `<span class="is-muted">└─</span> ${taskHtml(task)} <span class="is-muted">──</span> <span class="is-danger">${esc(missingOutputsLabel(r.missing))}</span>`,
    )
    say = r.missing.every(outputRequired)
      ? `The task fails. ${r.missing.join(', ')} ${r.missing.length === 1 ? 'is a literal path' : 'are literal paths'}, so vx requires ${r.missing.length === 1 ? 'it' : 'them'}. Nothing is cached.`
      : 'The task fails: it wrote none of its outputs. Nothing is cached.'
  } else {
    lines.push(
      `<span class="is-muted">└─</span> ${taskHtml(task)} <span class="is-muted">── success</span>`,
    )
    say =
      r.saved.length === 0
        ? 'The task passes and saves nothing. A wildcard may match nothing.'
        : `The task passes. vx saves ${plural(r.saved.length, 'file')}; a cache hit puts them back.`
  }
  return { patterns: rows.join(''), tree, terminal: lines.join('\n'), say }
}

function warnLine(text: string): string {
  const m = /^(\[vx\])?(.*)$/s.exec(text)!
  return m[1] !== undefined
    ? `<b class="is-warn">[vx]</b><span class="is-muted">${esc(m[2]!)}</span>`
    : `<span class="is-muted">${esc(text)}</span>`
}

function patternRow(head: string, notes: readonly string[], cls = ''): string {
  const sub = notes.map((n) => `<span class="gt-note">${n}</span>`).join('')
  return `<li class="${cls}">${head}${sub}</li>`
}

interface Mark {
  cls: string
  tag: string
}

interface Dir {
  dirs: Map<string, Dir>
  files: string[]
}

/** The workspace as an indented list: the project open, the others closed. */
function treeHtml(
  project: string,
  mark: (rel: string) => Mark,
  checkable: ReadonlySet<string> = new Set(),
  checked: ReadonlySet<string> = new Set(),
  still = false,
): string {
  const dir = PROJECTS[project]!
  const root: Dir = { dirs: new Map(), files: [] }
  for (const f of WORKSPACE_FILES) {
    const parts = f.split('/')
    let at = root
    for (const seg of parts.slice(0, -1)) {
      let next = at.dirs.get(seg)
      if (next === undefined) at.dirs.set(seg, (next = { dirs: new Map(), files: [] }))
      at = next
    }
    at.files.push(parts[parts.length - 1]!)
  }
  const out: string[] = []
  const walk = (d: Dir, prefix: string, depth: number) => {
    for (const [name, sub] of [...d.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const full = `${prefix}${name}`
      const other = Object.entries(PROJECTS).find(([, p]) => p === full)
      const inside = full === dir || full.startsWith(`${dir}/`)
      const above = dir.startsWith(`${full}/`)
      const tags: string[] = []
      let cls = 'gt-dir'
      if (other !== undefined && other[0] === project) {
        cls += ' is-project'
        tags.push(`<span class="gt-tag is-accent">${esc(project)}</span>`)
      } else if (other !== undefined) {
        cls += ' is-out'
        tags.push(`<span class="gt-tag">${esc(other[0])} · out of reach</span>`)
      } else if (!inside && !above) cls += ' is-out'
      if (inside && GITIGNORE.includes(name)) tags.push('<span class="gt-tag">gitignored</span>')
      out.push(row(depth, `${esc(name)}/`, cls, tags.join('')))
      if (inside || above) walk(sub, `${full}/`, depth + 1)
    }
    const inProject = prefix.startsWith(`${dir}/`)
    for (const name of d.files) {
      const full = `${prefix}${name}`
      if (!inProject) {
        out.push(row(depth, esc(name), 'is-out', ''))
        continue
      }
      const rel = full.slice(dir.length + 1)
      const m = mark(rel)
      const tags: string[] = []
      if (m.tag !== '') tags.push(`<span class="gt-tag">${esc(m.tag)}</span>`)
      if (isIgnored(full) && !underIgnoredDir(full))
        tags.push('<span class="gt-tag">gitignored</span>')
      const label = checkable.has(rel)
        ? `<label class="gt-check"><input type="checkbox" data-file="${esc(rel)}"${checked.has(rel) ? ' checked' : ''}${still ? ' disabled' : ''} /> ${esc(name)}</label>`
        : esc(name)
      out.push(row(depth, label, `gt-file ${m.cls}`, tags.join(''), m.cls === 'is-hit'))
    }
  }
  walk(root, '', 0)
  return out.join('')
}

function row(depth: number, name: string, cls: string, tags: string, hit = false): string {
  const mark = hit
    ? '<span class="gt-mark is-ok" aria-label="matched">✓</span>'
    : '<span class="gt-mark" aria-hidden="true"></span>'
  return `<li class="${cls}" style="--d:${depth}">${mark}<span class="gt-name">${name}</span>${tags}</li>`
}
