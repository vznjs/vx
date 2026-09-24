// What a Learn page's checkpoint asks and how it marks an answer (roadmap
// W11, item 705; design/labs-checkpoints-2026-09.md § W11). A checkpoint is
// one question about the playground's toy workspace, in one of two forms:
// an edit ("you edit X: which tasks rerun?") or a run ("`vx run T`: which
// tasks run?"). Its answer is never written by hand: `answerCheckpoint`
// runs vx's planner over the question's files, at build time for the
// no-JavaScript answer (`Checkpoint.astro`) and in the reader's browser on
// Check (`checkpoint.ts`). tests/learn-checkpoints.test.ts holds every
// checkpoint's computed answer to a set written out by hand.

import { ENV, FILES, TASKS } from '../../../playground/workspace.js'
import {
  describeChange,
  diffRuns,
  runPlayground,
  type Planner,
  type RunOutcome,
} from './playground-view.js'

/** What the reader changes between the edit form's two runs. */
export type CheckpointChange =
  | {
      file: string
      /** The file's contents after the edit. */
      text: string
      /** What the edit does, when the file's name does not say it. */
      how?: string
    }
  | { env: string; value: string }

interface Common {
  /** Context the question needs first, with `code` in backticks. It names
   *  no task of the answer: the answer is the planner's. */
  intro?: string
  /** A sentence the answer ends with, shown after Check and without
   *  JavaScript: what the answer means, not what it is. */
  note?: string
}

export type Checkpoint =
  | (Common & {
      form: 'edit'
      /** The workspace both runs start from: the toy workspace with these
       *  files added or replaced. */
      setup?: Record<string, string>
      change: CheckpointChange
    })
  | (Common & { form: 'run'; tasks: string[] })

/** `text` with `from` replaced by `to`, where `from` occurs exactly once: a
 *  variant that silently changed nothing would ask one question and answer
 *  another. */
function replaceOnce(text: string, from: string, to: string): string {
  const at = text.indexOf(from)
  if (at === -1 || text.indexOf(from, at + 1) !== -1) {
    throw new Error(`checkpoint variant: '${from}' is not in the text exactly once`)
  }
  return text.slice(0, at) + to + text.slice(at + from.length)
}

const UI_CONFIG = 'packages/ui/vx.config.mjs'
const UI_TSCONFIG = 'packages/ui/tsconfig.json'
const TSCONFIG = '{ "compilerOptions": { "strict": true } }\n'
// `ui#build`'s inputs, the first `files` in its config; `ui#test`'s differ.
const UI_BUILD_INPUTS = "inputs: { files: ['src/**'] },"
const UI_DECLARES_TSCONFIG = replaceOnce(
  FILES[UI_CONFIG]!,
  UI_BUILD_INPUTS,
  "inputs: { files: ['src/**', 'tsconfig.json'] },",
)
const edited = (file: string): string => `${FILES[file]}// edited\n`

/** Each page's checkpoints, by id. The page places one by its id. */
const DEFINED = {
  'what-is-edit': {
    form: 'edit',
    change: {
      file: 'packages/utils/src/index.ts',
      text: edited('packages/utils/src/index.ts'),
    },
  },
  'what-is-run': {
    form: 'run',
    tasks: ['app#build'],
  },
  caching: {
    form: 'edit',
    intro:
      "`ui#build` runs `vite build`, which reads `packages/ui/tsconfig.json`, and its inputs declare the file: `files: ['src/**', 'tsconfig.json']`.",
    setup: { [UI_TSCONFIG]: TSCONFIG, [UI_CONFIG]: UI_DECLARES_TSCONFIG },
    change: { file: UI_CONFIG, text: FILES[UI_CONFIG]!, how: 'to stop declaring it' },
    note: 'The list of inputs is part of the task’s config, so the config change moves its key, and every key that folds it moves with it. Edit `packages/ui/tsconfig.json` after that, and nothing moves: the Correctness checkpoint asks what that run replays.',
  },
  correctness: {
    form: 'edit',
    intro:
      "`ui#build` runs `vite build`, which reads `packages/ui/tsconfig.json`, but its inputs declare only `files: ['src/**']`.",
    setup: { [UI_TSCONFIG]: TSCONFIG },
    change: { file: UI_TSCONFIG, text: TSCONFIG.replace('true', 'false') },
    note: 'No key reads the file, so no key moves, and every task hits. A task that read the file, itself or through the output of a task it waits for, replays an output built from the old file: the run is green and the output is stale. With `exec.sandbox` on, the undeclared read fails the run instead.',
  },
  'playground-edit': {
    form: 'edit',
    intro: 'Start from Reset.',
    change: {
      file: 'packages/utils/test/index.test.ts',
      text: edited('packages/utils/test/index.test.ts'),
    },
  },
  'playground-env': {
    form: 'edit',
    intro: 'Start from Reset.',
    change: { env: 'API_URL', value: 'https://staging.example.com' },
  },
} satisfies Record<string, Checkpoint>

export type CheckpointId = keyof typeof DEFINED
export const CHECKPOINTS: Record<CheckpointId, Checkpoint> = DEFINED

const code = (s: string): string => `\`${s}\``

/** The question, with `code` in backticks: the intro, then a sentence made
 *  from the change or the task specs, so it cannot name one file while the
 *  answer is computed for another. */
export function questionOf(c: Checkpoint): string {
  const intro = c.intro === undefined ? '' : `${c.intro} `
  if (c.form === 'run') {
    return `${intro}You run ${code(`vx run ${c.tasks.join(' ')}`)} on an empty cache. Which tasks run?`
  }
  const what =
    'file' in c.change
      ? `edit ${code(c.change.file)}${c.change.how === undefined ? '' : ` ${c.change.how}`}`
      : `change ${code(c.change.env)} to another value`
  return `${intro}You run ${code(`vx run ${TASKS.join(' ')}`)} once. Then you ${what} and run it again. Which tasks rerun?`
}

/** One task of the workspace, and whether the question's answer holds it. */
export interface AnswerRow {
  id: string
  yes: boolean
  /** Why, in the words the playground's "key moved" column uses. */
  reason: string
}

export interface CheckpointAnswer {
  form: Checkpoint['form']
  /** Every task of the workspace, in the playground's order. */
  rows: AnswerRow[]
}

const KEY_SAME = 'key unchanged'

/** The edit form's answer from its two runs: a task reruns when its key
 *  moved (or is new), for the reasons core's key diff names. */
export function answerFromRuns(
  before: RunOutcome & { ok: true },
  after: RunOutcome & { ok: true },
  diff: Planner['diffKeyComponents'],
): CheckpointAnswer {
  return {
    form: 'edit',
    rows: diffRuns(before.tasks, after.tasks, diff).map((r) => {
      if (r.change === 'same') return { id: r.id, yes: false, reason: KEY_SAME }
      if (r.change === 'new')
        return { id: r.id, yes: true, reason: 'the first run did not have it' }
      const why = r.why.map(describeChange).join(', ')
      return { id: r.id, yes: true, reason: why === '' ? 'its key moved' : why }
    }),
  }
}

/** The run form's answer: every task of the workspace (`all`, in order),
 *  and which of them `vx run <requested>` plans, each named for the task
 *  that asked for it. */
export function answerFromPlan(
  all: readonly string[],
  planned: readonly { id: string; deps: readonly string[] }[],
  requested: readonly string[],
): CheckpointAnswer {
  // A spec names a task by its id, or every project's task by its name.
  const asked = (id: string): boolean =>
    requested.some((s) => s === id || s === id.slice(id.indexOf('#') + 1))
  const waiter = (id: string): string | undefined => planned.find((t) => t.deps.includes(id))?.id
  const plannedIds = new Set(planned.map((t) => t.id))
  return {
    form: 'run',
    rows: all.map((id) => {
      if (!plannedIds.has(id)) {
        return { id, yes: false, reason: 'not needed by what you asked for' }
      }
      const w = waiter(id)
      if (asked(id) || w === undefined) return { id, yes: true, reason: 'you asked for it' }
      return { id, yes: true, reason: `${w} waits for it` }
    }),
  }
}

function ok(o: RunOutcome, what: string): RunOutcome & { ok: true } {
  if (!o.ok) throw new Error(`checkpoint: the ${what} failed: ${o.errors.join('; ')}`)
  return o
}

// The planner holds one workspace at a time (its file system and env are
// module state), so two answers computed at once would read each other's
// files: a page with two checkpoints renders them concurrently.
let queue: Promise<unknown> = Promise.resolve()

/** The checkpoint's answer, from vx's planner over the question's files. */
export function answerCheckpoint(planner: Planner, c: Checkpoint): Promise<CheckpointAnswer> {
  const next = queue.then(() => compute(planner, c))
  queue = next.catch(() => {})
  return next
}

async function compute(planner: Planner, c: Checkpoint): Promise<CheckpointAnswer> {
  if (c.form === 'run') {
    const all = ok(
      await runPlayground(planner, { files: FILES, env: ENV, tasks: TASKS, cached: new Set() }),
      'plan of every task',
    )
    const asked = ok(
      await runPlayground(planner, { files: FILES, env: ENV, tasks: c.tasks, cached: new Set() }),
      `plan of ${c.tasks.join(' ')}`,
    )
    return answerFromPlan(
      all.tasks.map((t) => t.id),
      asked.tasks,
      c.tasks,
    )
  }
  const files = { ...FILES, ...c.setup }
  const first = ok(
    await runPlayground(planner, { files, env: ENV, tasks: TASKS, cached: new Set() }),
    'first run',
  )
  const change = c.change
  const second = ok(
    await runPlayground(planner, {
      files: 'file' in change ? { ...files, [change.file]: change.text } : files,
      env: 'env' in change ? { ...ENV, [change.env]: change.value } : ENV,
      tasks: TASKS,
      cached: first.cached,
    }),
    'second run',
  )
  return answerFromRuns(first, second, planner.diffKeyComponents)
}

export type Verdict = 'right' | 'missed' | 'wrong'

export interface Mark extends AnswerRow {
  verdict: Verdict
}

/** Each task against what the reader ticked: a task in the answer they
 *  ticked, or one out of it they left, is right; one in it they left is
 *  missed; one out of it they ticked is wrong. */
export function markAnswer(answer: CheckpointAnswer, ticked: ReadonlySet<string>): Mark[] {
  return answer.rows.map((r) => {
    const verdict: Verdict = r.yes === ticked.has(r.id) ? 'right' : r.yes ? 'missed' : 'wrong'
    return { ...r, verdict }
  })
}

const VERBS = {
  edit: { one: 'reruns', many: 'rerun', notOne: 'does not rerun', notMany: 'do not rerun' },
  run: { one: 'runs', many: 'run', notOne: 'does not run', notMany: 'do not run' },
}
const WORD: Record<Verdict, string> = { right: 'Right', missed: 'Missed', wrong: 'Wrong' }

/** One mark in words, colour aside: "Missed: ui#test reruns (upstream
 *  ui#build moved)." */
export function markLine(form: Checkpoint['form'], m: Mark): string {
  const v = VERBS[form]
  return `${WORD[m.verdict]}: ${m.id} ${m.yes ? v.one : v.notOne} (${m.reason}).`
}

/** The marking in one sentence, for the live region. */
export function verdictSentence(marks: readonly Mark[]): string {
  const ids = (v: Verdict): string[] => marks.filter((m) => m.verdict === v).map((m) => m.id)
  const missed = ids('missed')
  const wrong = ids('wrong')
  if (missed.length === 0 && wrong.length === 0) return `All ${marks.length} right.`
  const right = marks.length - missed.length - wrong.length
  let s = `${right} of ${marks.length} right.`
  if (missed.length > 0) s += ` Missed: ${missed.join(', ')}.`
  if (wrong.length > 0) s += ` Wrong: ${wrong.join(', ')}.`
  return s
}

/** The no-JavaScript answer: a summary, one line per task in the answer
 *  with its reason, and the rest grouped by theirs. */
export function answerText(answer: CheckpointAnswer): {
  summary: string
  yes: string[]
  rest: string[]
} {
  const v = VERBS[answer.form]
  const yes = answer.rows.filter((r) => r.yes)
  const no = answer.rows.filter((r) => !r.yes)
  const summary =
    yes.length === 0
      ? `No task ${v.one}.`
      : `${yes.length} of the ${answer.rows.length} tasks ${yes.length === 1 ? v.one : v.many}.`
  const reasons = [...new Set(no.map((r) => r.reason))]
  return {
    summary,
    yes: yes.map((r) => `${r.id} ${v.one} (${r.reason}).`),
    rest: reasons.map((reason) => {
      const ids = no.filter((r) => r.reason === reason).map((r) => r.id)
      const verb = ids.length === 1 ? v.notOne : v.notMany
      return `${ids.join(', ')} ${verb} (${reason}).`
    }),
  }
}

/** A sentence's `code` spans, for markup: backticks split it. */
export function codeSpans(text: string): { code: boolean; text: string }[] {
  return text
    .split('`')
    .map((t, i) => ({ code: i % 2 === 1, text: t }))
    .filter((s) => s.text !== '')
}
