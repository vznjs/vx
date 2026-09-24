// The stale-hit demo on learn/correctness: one package, `web`, whose `build`
// reads a file it does not declare. The static render (the no-JS fallback)
// and the element that enhances it both read this model, and
// tests/learn-correctness.test.ts holds it to real vx runs and to core's own
// report formatter.

import { digest, shortKey } from './toy-monorepo.js'

export const STALE_PROJECT = 'web'
export const STALE_TASK = `${STALE_PROJECT}#build`
export const STALE_SOURCE = 'src/index.ts'
export const STALE_BANNER = 'banner.txt'
export const STALE_OUTPUT = 'dist/out.txt'
const STALE_COMMAND = `mkdir -p dist && cat ${STALE_SOURCE} ${STALE_BANNER} > ${STALE_OUTPUT}`

/** Each file's text before and after the reader edits it. */
export const SOURCE_VERSIONS = ['export default 1', 'export default 2'] as const
export const BANNER_VERSIONS = ['/*! v1 */', '/*! v2 */'] as const

export interface StaleState {
  sourceEdited: boolean
  bannerEdited: boolean
  sandbox: boolean
  /** `banner.txt` is in the task's inputs (and, when sandboxed, its read grant). */
  declared: boolean
}

export const STALE_START: StaleState = {
  sourceEdited: false,
  bannerEdited: false,
  sandbox: false,
  declared: false,
}

export type StaleChange = 'edit-source' | 'edit-banner' | 'sandbox' | 'declare'

const FIELD = {
  'edit-source': 'sourceEdited',
  'edit-banner': 'bannerEdited',
  sandbox: 'sandbox',
  declare: 'declared',
} as const

export function applyStaleChange(state: StaleState, change: StaleChange): StaleState {
  return { ...state, [FIELD[change]]: !state[FIELD[change]] }
}

export function fileValue(state: StaleState, file: string): string {
  if (file === STALE_SOURCE) return SOURCE_VERSIONS[state.sourceEdited ? 1 : 0]
  return BANNER_VERSIONS[state.bannerEdited ? 1 : 0]
}

/** The files the task's inputs name, and so its sandbox grants. */
function declaredFiles(state: StaleState): string[] {
  return state.declared ? ['src/**', STALE_BANNER] : ['src/**']
}

/** The task's config as vx reads it. The page prints it and the test writes
 *  it to `vx.config.mjs`, so the two cannot describe different tasks. */
export function staleConfig(state: StaleState): Record<string, unknown> {
  const files = declaredFiles(state)
  return {
    exec: {
      command: STALE_COMMAND,
      ...(state.sandbox ? { sandbox: { allow: { read: files, write: ['dist/'] } } } : {}),
    },
    cache: { inputs: { files }, outputs: { files: ['dist/**'] } },
  }
}

/** The same config as the reader would write it in `vx.config.ts`. */
export function configSource(state: StaleState): string {
  const list = (xs: readonly string[]): string => `[${xs.map((x) => `'${x}'`).join(', ')}]`
  const files = list(declaredFiles(state))
  return [
    'build: {',
    '  exec: {',
    `    command: '${STALE_COMMAND}',`,
    ...(state.sandbox ? [`    sandbox: { allow: { read: ${files}, write: ['dist/'] } },`] : []),
    '  },',
    `  cache: { inputs: { files: ${files} }, outputs: { files: ['dist/**'] } },`,
    '}',
  ].join('\n')
}

/** What `dist/out.txt` holds after a real run over `state`: `cat` of both files. */
function trueOutput(state: StaleState): string {
  return `${fileValue(state, STALE_SOURCE)}\n${fileValue(state, STALE_BANNER)}\n`
}

export interface StaleRun {
  state: StaleState
  /** The key the run before computed; undefined on the first run. */
  before: string | undefined
  key: string
  moved: boolean
  verdict: 'hit' | 'miss' | 'failed'
  /** What the cache replays on a hit, or the task writes on a miss.
   *  Undefined when the run failed, which stores nothing. */
  output: string | undefined
  /** What a run with no cache writes over the same files. */
  truth: string
  /** A hit whose output is not what a run would write now. */
  stale: boolean
  /** Files the task read that its sandbox did not grant. */
  denied: string[]
  cache: ReadonlyMap<string, string>
}

/**
 * One run over `state`, after `prev` (or on an empty cache). The key folds
 * the task, its config (the command, the inputs list and the sandbox block)
 * and the contents of the files the inputs name, which is what vx folds. The
 * command reads both files whatever the config says.
 */
export function staleRun(state: StaleState, prev?: StaleRun): StaleRun {
  const cache = new Map(prev?.cache)
  const inputs = state.declared ? [STALE_SOURCE, STALE_BANNER] : [STALE_SOURCE]
  const key = digest([
    STALE_TASK,
    JSON.stringify(staleConfig(state)),
    ...inputs.map((f) => fileValue(state, f)),
  ])
  const truth = trueOutput(state)
  const saved = cache.get(key)
  const denied = state.sandbox && !state.declared ? [STALE_BANNER] : []
  let verdict: StaleRun['verdict'] = 'hit'
  let output = saved
  if (saved === undefined) {
    verdict = denied.length > 0 ? 'failed' : 'miss'
    output = verdict === 'failed' ? undefined : truth
    if (output !== undefined) cache.set(key, output)
  }
  return {
    state,
    before: prev?.key,
    key,
    moved: prev !== undefined && prev.key !== key,
    verdict,
    output,
    truth,
    stale: verdict === 'hit' && output !== truth,
    denied,
    cache,
  }
}

export interface StaleStep {
  id: string
  title: string
  /** Undefined for the first run. */
  change: StaleChange | undefined
}

/** The five steps the page walks through, in order. */
export const STALE_STEPS: StaleStep[] = [
  { id: 'first', title: 'First run', change: undefined },
  { id: 'source', title: `Edit ${STALE_SOURCE}`, change: 'edit-source' },
  { id: 'banner', title: `Edit ${STALE_BANNER}`, change: 'edit-banner' },
  { id: 'sandbox', title: 'Turn on exec.sandbox', change: 'sandbox' },
  { id: 'declare', title: `Declare ${STALE_BANNER}`, change: 'declare' },
]

/** Every step's run, the first on an empty cache. */
export function staleRuns(steps: readonly StaleStep[] = STALE_STEPS): StaleRun[] {
  const runs: StaleRun[] = []
  for (const s of steps) {
    const last = runs.at(-1)
    const state = s.change === undefined ? STALE_START : applyStaleChange(last!.state, s.change)
    runs.push(staleRun(state, last))
  }
  return runs
}

/** The toggles the demo offers after the five steps, in the order it shows them. */
export const STALE_TOGGLES: { change: StaleChange; label: string }[] = [
  { change: 'edit-source', label: `edit ${STALE_SOURCE}` },
  { change: 'edit-banner', label: `edit ${STALE_BANNER}` },
  { change: 'sandbox', label: 'exec.sandbox' },
  { change: 'declare', label: `declare ${STALE_BANNER}` },
]

/** Whether a toggle is on in `state`. */
export function toggleOn(state: StaleState, change: StaleChange): boolean {
  return state[FIELD[change]]
}

/** What a change does, in one sentence. `state` is the state it is made in. */
export function describeStaleChange(change: StaleChange, state: StaleState): string {
  const undo = toggleOn(state, change)
  if (change === 'sandbox') return `You turn ${undo ? 'off' : 'on'} exec.sandbox.`
  if (change === 'declare') {
    return undo ? `You stop declaring ${STALE_BANNER}.` : `You declare ${STALE_BANNER}.`
  }
  const file = change === 'edit-source' ? STALE_SOURCE : STALE_BANNER
  return undo ? `You undo your edit to ${file}.` : `You edit ${file}.`
}

/** The words the table and the live panel use for a run. */
export function verdictOf(r: StaleRun): string {
  if (r.verdict === 'failed') return 'fails: sandbox violation'
  if (r.verdict === 'miss') return 'miss: runs'
  return r.stale ? 'stale hit' : 'hit'
}

/** What `dist/out.txt` holds after the run, as the table and the panel say it. */
export function outputOf(r: StaleRun): string {
  return r.output ?? 'none: it failed'
}

export function keyCellOf(r: StaleRun): string {
  if (r.before === undefined) return `${shortKey(r.key)} (new)`
  return r.moved ? `${shortKey(r.before)} → ${shortKey(r.key)}` : `${shortKey(r.key)} (same)`
}

/** A run in a few sentences, for the static list and the live region. */
export function describeStaleRun(r: StaleRun): string {
  const key =
    r.before === undefined
      ? 'The cache is empty.'
      : !r.moved
        ? 'The key did not move.'
        : r.verdict === 'hit'
          ? 'The key moved, to one an earlier run stored.'
          : 'The key moved.'
  if (r.verdict === 'failed') {
    return `${key} The run misses, and the sandbox denies the read of ${r.denied.join(', ')}, so the task fails and nothing is stored.`
  }
  if (r.verdict === 'miss')
    return `${key} The run misses, runs the command and stores what it wrote.`
  if (r.stale) {
    return `${key} The run hits and replays an output built before the edit: a stale hit, on a green run.`
  }
  return `${key} The run hits and replays the stored output, which is correct.`
}

/** A workspace root for the report's path; illustrative, like the keys. */
export const REPORT_ROOT = '/repo'

/**
 * The frame vx prints for the failed task on Linux, for a project at
 * `projectDir`, with the duration it took. Built the way core builds it
 * (`formatTaskBlock` over the strace line `parseStraceViolations` writes);
 * tests/learn-correctness.test.ts runs both and compares, because the
 * site's suite cannot run a sandboxed task itself.
 */
export function sandboxReport(projectDir: string, durationMs: number): string {
  const rule = (title: string): string => `├─ ${title} ${'─'.repeat(60 - 4 - title.length)}`
  const label = 'failed (exit 1, 1 sandbox violation)'
  return [
    `┌─ ${STALE_TASK} > ${label}`,
    '',
    `$ ${STALE_COMMAND}`,
    '',
    rule('STDERR'),
    '',
    `cat: ${STALE_BANNER}: No such file or directory`,
    '',
    rule('SANDBOX VIOLATIONS (1)'),
    '',
    `openat(${STALE_BANNER}) = -1 ENOENT  [${projectDir}/${STALE_BANNER}]`,
    '',
    `└─ ${STALE_TASK} ── (${durationMs}ms) ${label}`,
    '',
  ].join('\n')
}
