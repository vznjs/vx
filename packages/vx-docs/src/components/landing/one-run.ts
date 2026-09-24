// The landing's one picture (design/site-short-2026-09.md § The one
// diagram): the toy monorepo's build after you edit `app`, with the six
// ideas vx is made of numbered on it. The six lines under it are CALLOUTS,
// each at the anchor the old Guide chapter that taught it redirects to.
// tests/landing.test.ts holds both to the design, and diagram-kit.test.ts
// holds the picture and its phone layout to the kit's laws.
import type { Picture } from '../guide/diagram/diagram.js'

export interface Callout {
  /** The line's id on the landing, which the old chapter URLs land on. */
  id: string
  /** The number the drawing puts beside the part it names. */
  mark: string
  term: string
  /** At most eight words; backticks mark code. */
  line: string
}

export const CALLOUTS: readonly Callout[] = [
  { id: 'tasks', mark: '①', term: 'Tasks.', line: '`app` builds after what it uses.' },
  { id: 'parallel', mark: '②', term: 'Parallel.', line: '`ui` and `api` build at once.' },
  { id: 'cache', mark: '③', term: 'Cache.', line: 'Unchanged work comes back from the cache.' },
  {
    id: 'changed',
    mark: '④',
    term: 'Only what changed.',
    line: 'You edited `app`; only `app` runs.',
  },
  {
    id: 'sandbox',
    mark: '⑤',
    term: 'Sandbox.',
    line: 'A read you did not declare fails the task.',
  },
  {
    id: 'plugins',
    mark: '⑥',
    term: 'Plugins.',
    line: 'Swap the cache, runner or telemetry. No fork.',
  },
]

const STAGES = ['graph', 'key', 'schedule', 'run', 'cache', 'telemetry']
const CACHED = { sub: 'from cache', tone: 'ok' } as const

export const oneRun: Picture = {
  name: 'one-run',
  label:
    'One run of vx run build after you edit app. utils#build is used by ui#build and api#build, which are both used by app#build. ui#build and api#build run at once. utils, ui and api come back from the cache; only app#build runs. app#build runs in a sandbox, and its read of ../secrets.env, which it did not declare, is denied. Along the foot, the run’s stages: graph, key, schedule, run, cache and telemetry; a remote cache plugs into the cache stage and OpenTelemetry into the telemetry stage, and yours plugs in the same way.',
  caption: 'One run of vx run build, after you edit app.',
  width: 720,
  height: 500,
  frames: [
    { x: 196, y: 14, w: 198, h: 206, label: 'at once' },
    { x: 420, y: 76, w: 190, h: 120, label: 'sandbox', tone: 'link' },
    { x: 10, y: 312, w: 700, h: 82, label: 'a run’s stages' },
  ],
  boxes: [
    { id: 'utils', x: 20, y: 100, w: 150, label: 'utils#build', ...CACHED },
    { id: 'ui', x: 220, y: 46, w: 150, label: 'ui#build', ...CACHED },
    { id: 'api', x: 220, y: 146, w: 150, label: 'api#build', ...CACHED },
    {
      id: 'app',
      x: 440,
      y: 116,
      w: 150,
      label: 'app#build',
      sub: 'you edited app',
      tone: 'accent',
    },
    { id: 'secrets', x: 445, y: 236, w: 140, label: '../secrets.env', tone: 'muted' },
    ...STAGES.map((s, i) => ({ id: s, x: 18 + i * 116, y: 342, w: 104, h: 40, label: s })),
    { id: 'remote', x: 360, y: 430, w: 150, label: 'remote cache' },
    { id: 'otel', x: 560, y: 430, w: 150, label: 'OpenTelemetry' },
  ],
  arrows: [
    { from: 'utils', to: 'ui' },
    { from: 'utils', to: 'api' },
    { from: 'ui', to: 'app' },
    { from: 'api', to: 'app' },
    { from: 'app', to: 'secrets', label: '✕ denied', tone: 'danger' },
    { from: 'remote', to: 'cache', dashed: true },
    { from: 'otel', to: 'telemetry', dashed: true },
  ],
  notes: [
    { x: 95, y: 88, text: '①', tone: 'accent' },
    { x: 382, y: 34, text: '②', tone: 'accent', anchor: 'end' },
    { x: 95, y: 180, text: '③', tone: 'accent' },
    { x: 622, y: 132, text: '④', tone: 'accent', anchor: 'start' },
    { x: 622, y: 154, text: '✎ runs', tone: 'accent', anchor: 'start' },
    { x: 600, y: 96, text: '⑤', tone: 'accent', anchor: 'end' },
    { x: 700, y: 332, text: '⑥', tone: 'accent', anchor: 'end' },
    { x: 344, y: 461, text: 'yours plugs in the same way', anchor: 'end' },
  ],
  narrow: {
    width: 360,
    height: 760,
    frames: [
      { x: 8, y: 124, w: 344, h: 104, label: 'at once' },
      { x: 40, y: 262, w: 280, h: 108, label: 'sandbox', tone: 'link' },
      { x: 8, y: 494, w: 344, h: 128, label: 'a run’s stages' },
    ],
    boxes: [
      { id: 'utils', x: 105, y: 34, w: 150, label: 'utils#build', ...CACHED },
      { id: 'ui', x: 18, y: 156, w: 150, label: 'ui#build', ...CACHED },
      { id: 'api', x: 192, y: 156, w: 150, label: 'api#build', ...CACHED },
      {
        id: 'app',
        x: 105,
        y: 296,
        w: 150,
        label: 'app#build',
        sub: 'you edited app',
        tone: 'accent',
      },
      { id: 'secrets', x: 110, y: 410, w: 140, label: '../secrets.env', tone: 'muted' },
      ...STAGES.map((s, i) => ({
        id: s,
        x: 18 + (i % 3) * 110,
        y: 526 + Math.floor(i / 3) * 48,
        w: 104,
        h: 40,
        label: s,
      })),
      { id: 'remote', x: 30, y: 656, w: 140, label: 'remote cache' },
      { id: 'otel', x: 190, y: 656, w: 140, label: 'OpenTelemetry' },
    ],
    arrows: [
      { from: 'utils', to: 'ui' },
      { from: 'utils', to: 'api' },
      { from: 'ui', to: 'app' },
      { from: 'api', to: 'app' },
      { from: 'app', to: 'secrets', label: '✕ denied', tone: 'danger' },
      { from: 'remote', to: 'cache', dashed: true },
      { from: 'otel', to: 'telemetry', dashed: true },
    ],
    notes: [
      { x: 90, y: 69, text: '①', tone: 'accent', anchor: 'end' },
      { x: 340, y: 144, text: '②', tone: 'accent', anchor: 'end' },
      { x: 270, y: 69, text: '③', tone: 'accent', anchor: 'start' },
      { x: 262, y: 318, text: '④', tone: 'accent', anchor: 'start' },
      { x: 262, y: 340, text: '✎ runs', tone: 'accent', anchor: 'start' },
      { x: 308, y: 282, text: '⑤', tone: 'accent', anchor: 'end' },
      { x: 340, y: 514, text: '⑥', tone: 'accent', anchor: 'end' },
      { x: 180, y: 742, text: 'yours plugs in the same way' },
    ],
  },
}
