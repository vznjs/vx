// The labs' starting states and the edits their steps ask for (learn/labs,
// item 704; design/labs-checkpoints-2026-09.md § W10). Each state is the
// playground's workspace (workspace.ts) plus one change, and
// `<vx-playground data-lab="<id>">` opens on it. The steps are here so the
// site's rows and core's parity rows (packages/vx/tests/playground-parity.unsafe.test.ts)
// apply the edits the page tells the reader to make; what each step moves is
// written out by hand in those rows, never computed from this file.

import { CONFIG_TEXTS, ENV, FILES, TASKS } from './workspace.js'

/** What a playground opens with, and what its Reset restores. */
export interface PlaygroundState {
  files: Record<string, string>
  env: Record<string, string>
  tasks: string[]
}

/** One edit a step asks for: replace a text once, or append to the file. */
export type LabEdit =
  | { file: string; replace: string; with: string }
  | { file: string; append: string }

/** `files` with `path` added after the last file of its package, so the
 *  file list keeps each package's files together. */
function withFile(
  files: Record<string, string>,
  path: string,
  text: string,
): Record<string, string> {
  const dir = path.slice(0, path.lastIndexOf('/') + 1)
  const entries = Object.entries(files)
  const at = entries.findLastIndex(([f]) => f.startsWith(dir)) + 1
  return Object.fromEntries([...entries.slice(0, at), [path, text], ...entries.slice(at)])
}

const UI_CONFIG = 'packages/ui/vx.config.mjs'
const API_CONFIG = 'packages/api/vx.config.mjs'
const API_BUILD = 'bun build src/server.ts --outdir dist'
// A plain copy, the shape of the correctness page's stale-hit demo: the
// sandbox the lab turns on meets exactly the read that demo shows it deny.
const API_LAB_BUILD = 'mkdir -p dist && cp src/server.ts config.json dist/'

export const LAB_IDS = ['unlisted-file', 'undeclared-read', 'shared-output'] as const
export type LabId = (typeof LAB_IDS)[number]

export const LABS: Record<LabId, PlaygroundState> = {
  // Lab 1: a file in `ui` that no config names.
  'unlisted-file': {
    files: withFile(
      FILES,
      'packages/ui/notes.md',
      '# ui\n\nThe button shouts its label. Keep it that way.\n',
    ),
    env: ENV,
    tasks: TASKS,
  },
  // Lab 2: `api#build` copies `config.json` into its output, and its inputs
  // do not name it.
  'undeclared-read': {
    files: withFile(
      {
        ...FILES,
        [API_CONFIG]: CONFIG_TEXTS['api']!.replace(
          `command: '${API_BUILD}'`,
          `command: '${API_LAB_BUILD}'`,
        ),
      },
      'packages/api/config.json',
      '{ "greeting": "hello" }\n',
    ),
    env: ENV,
    tasks: TASKS,
  },
  // Lab 3: `ui#bundle` writes `dist/**`, as `ui#build` does, and nothing
  // orders the two.
  'shared-output': {
    files: {
      ...FILES,
      [UI_CONFIG]: CONFIG_TEXTS['ui']!.replace(
        '\n  },\n})\n',
        `
    bundle: {
      exec: { command: 'vite build --mode bundle' },
      cache: {
        inputs: { files: ['src/**'] },
        outputs: { files: ['dist/**'] },
      },
    },
  },
})
`,
      ),
    },
    env: ENV,
    tasks: [...TASKS, 'bundle'],
  },
}

const API_SANDBOX_OFF = `exec: { command: '${API_LAB_BUILD}' },`
const API_SANDBOX_ON = `exec: {
        command: '${API_LAB_BUILD}',
        sandbox: { allow: { read: ['src/**'], write: ['dist/'] } },
      },`

/** Each lab's steps after its first Run, in order: the edits the reader
 *  makes before each next Run (none: run again as it is). */
export const LAB_STEPS: Record<LabId, LabEdit[][]> = {
  'unlisted-file': [
    [{ file: 'packages/ui/notes.md', append: 'And keep it short.\n' }],
    [
      {
        file: UI_CONFIG,
        replace: "inputs: { files: ['src/**'] }",
        with: "inputs: { files: ['src/**', 'notes.md'] }",
      },
    ],
    [{ file: 'packages/ui/notes.md', append: 'Really short.\n' }],
  ],
  'undeclared-read': [
    [{ file: 'packages/api/config.json', replace: '"hello"', with: '"hi"' }],
    [{ file: API_CONFIG, replace: API_SANDBOX_OFF, with: API_SANDBOX_ON }],
    [
      {
        file: API_CONFIG,
        replace: "files: ['src/**'], env",
        with: "files: ['src/**', 'config.json'], env",
      },
      {
        file: API_CONFIG,
        replace: "read: ['src/**']",
        with: "read: ['src/**', 'config.json']",
      },
    ],
    [{ file: 'packages/api/config.json', replace: '"hi"', with: '"hey"' }],
  ],
  'shared-output': [
    [
      {
        file: UI_CONFIG,
        replace: 'bundle: {\n      exec:',
        with: "bundle: {\n      dependsOn: ['build'],\n      exec:",
      },
    ],
    [],
    [{ file: 'packages/ui/src/button.tsx', append: '// edited\n' }],
  ],
}

/** `files` after `edits`. An edit whose text is not in its file is a lab
 *  that no longer matches its workspace, so it throws. */
export function applyEdits(
  files: Record<string, string>,
  edits: readonly LabEdit[],
): Record<string, string> {
  const next = { ...files }
  for (const e of edits) {
    const text = next[e.file]
    if (text === undefined) throw new Error(`lab edit: no file ${e.file}`)
    if ('append' in e) next[e.file] = text + e.append
    else {
      if (text.split(e.replace).length !== 2) {
        throw new Error(`lab edit: ${e.file} does not hold ${JSON.stringify(e.replace)} once`)
      }
      next[e.file] = text.replace(e.replace, e.with)
    }
  }
  return next
}

/** The state a playground opens with: its lab's, or the workspace's. */
export function startState(lab: string | undefined): PlaygroundState {
  if (lab === undefined) return { files: FILES, env: ENV, tasks: TASKS }
  if (!(LAB_IDS as readonly string[]).includes(lab)) throw new Error(`no playground lab '${lab}'`)
  return LABS[lab as LabId]
}
